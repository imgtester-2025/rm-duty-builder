/* ---------------------------------------------------------------
   COVERAGE ENGINE - the shared day-status computation used by the Duty
   Sheet grid, the Rota Sheet, and cover suggestions alike, so there is
   exactly one place that knows the override > holiday > absence >
   pattern priority, rather than several copies that could quietly
   drift apart. CORE: Duty Sheet (core) depends on this unconditionally.
   --------------------------------------------------------------- */
function groupIsInUse(groupId){
  return q("SELECT 1 FROM duty_group_slots WHERE duty_group_id=? AND (employee_id IS NOT NULL OR employee_id_2 IS NOT NULL) LIMIT 1", [groupId]).length > 0;
}

// Used by the skills/cover-suggestion logic - true if this employee has
// annual leave booked for the week containing this date, or a sickness/
// other absence block (open-ended or bounded) covering this date.
function isEmployeeAbsentOn(empId, dateISO){
  const weekMon = toISO(mondayOf(parseISO(dateISO)));
  if (q("SELECT 1 FROM annual_leave WHERE employee_id=? AND week_date=?", [empId, weekMon]).length > 0) return true;
  return q("SELECT 1 FROM other_absences WHERE employee_id=? AND start_date<=? AND (end_date IS NULL OR end_date>=?)", [empId, dateISO, dateISO]).length > 0;
}

// Finds the other-absence block (if any) covering a given date, from a
// per-employee list of blocks (start_date, end_date-or-null-for-ongoing).
// ISO date strings compare correctly with plain string comparison.
function findOtherAbsenceForDate(blocks, dateISO){
  if (!blocks) return null;
  return blocks.find(b => b.start_date <= dateISO && (!b.end_date || b.end_date >= dateISO)) || null;
}

/* ---------------------------------------------------------------
   SHARED DAY-STATUS COMPUTATION - used by the Duty Sheet grid, the
   Rota Sheet, and cover suggestions alike, so there is exactly one
   place that knows the override > holiday > absence > pattern
   priority, rather than three copies that could quietly drift apart.
   --------------------------------------------------------------- */
function computeDayContext(dateISO){
  const weekMon = toISO(mondayOf(parseISO(dateISO)));
  const holidayName = q("SELECT name FROM bank_holidays WHERE date=?", [dateISO])[0]?.name || null;
  const annualLeaveSet = new Set(q("SELECT employee_id FROM annual_leave WHERE week_date=?", [weekMon]).map(r => r.employee_id));
  const otherAbsenceMap = new Map();
  q("SELECT * FROM other_absences WHERE start_date<=? AND (end_date IS NULL OR end_date>=?)", [dateISO, dateISO])
    .forEach(r => otherAbsenceMap.set(r.employee_id, r));
  const overrideMap = new Map(q("SELECT * FROM cell_overrides WHERE date_iso=?", [dateISO]).map(r => [r.slot_id, r]));
  return { dateISO, weekMon, holidayName, annualLeaveSet, otherAbsenceMap, overrideMap };
}

// Pure computation of one person's status for one day - no DOM, so it can
// be reused anywhere. `person` describes whichever half of a slot is being
// asked about: { patternId, role, anchorDate, employeeId, slotId, isPerson2 }.
// slotId is used for override lookup and is omitted (no overrides possible)
// for a shared duty's second person.
function computePersonDayStatus(person, ctx){
  const pattern = getPattern(person.patternId);
  if (!pattern || !pattern.weeks[1][person.role]) return null;
  const override = (person.slotId && !person.isPerson2) ? ctx.overrideMap.get(person.slotId) : null;
  const cycleWk = cycleWeekFor(person.anchorDate, ctx.weekMon, pattern.cycle_length);
  const dayIndex = Math.round((parseISO(ctx.dateISO) - parseISO(ctx.weekMon)) / 86400000);
  const dayCode = DAYS[dayIndex];
  // The role passed week 1's check above, but every week should have it -
  // if some earlier inconsistency left this specific week missing it,
  // default to OFF for this one day rather than crashing every caller
  // (the Rota Sheet, the auto-cover engine, the Duty Sheet all route
  // through here for every single cell).
  if (!pattern.weeks[cycleWk][person.role]) pattern.weeks[cycleWk][person.role] = W(OF,OF,OF,OF,OF,OF);
  const [patternKind, patternLabel] = pattern.weeks[cycleWk][person.role][dayCode];
  const otherAbsence = person.employeeId ? ctx.otherAbsenceMap.get(person.employeeId) : null;
  const onLeave = person.employeeId ? ctx.annualLeaveSet.has(person.employeeId) : false;

  let kind, label;
  if (override) {
    kind = override.kind; label = override.label;
  } else if (ctx.holidayName) {
    kind = 'BH'; label = 'BH';
  } else if (patternKind !== 'OFF' && !person.employeeId) {
    kind = 'UNCOVERED'; label = 'GAP';
  } else if (patternKind !== 'OFF' && otherAbsence) {
    kind = otherAbsence.type; label = otherAbsence.type === 'SICK' ? 'SICK' : 'ABS';
  } else if (patternKind !== 'OFF' && onLeave) {
    kind = 'AL'; label = 'A/L';
  } else {
    // The pattern's own label (e.g. a Saturday-specific "A"/"B"/"C" code)
    // takes priority - only fall back to the kind name itself when the
    // pattern hasn't actually got a label for this cell.
    kind = patternKind; label = patternKind === 'OFF' ? 'OFF' : (patternLabel || patternKind);
  }
  return { kind, label, role: person.role, employeeId: person.employeeId, note: otherAbsence ? otherAbsence.note : '', isOverride: !!override };
}

// Resolves a slot (and, if shared, its second person) into computePersonDayStatus
// calls, returning one or two {..., dutyId, groupName, slotId} results.
function computeSlotStatusesForDate(slot, group, ctx){
  const results = [];
  const usesOwnRotation = !!slot.primary_pattern_id;
  const patternId = usesOwnRotation ? slot.primary_pattern_id : group.pattern_id;
  const role = usesOwnRotation ? slot.primary_role : slot.role;
  let anchorDate;
  if (usesOwnRotation) {
    anchorDate = slot.primary_anchor_date;
  } else {
    const groupPattern = getPattern(group.pattern_id);
    const blockIdx = blockIndexFor(slot.slot_order, groupPattern ? groupPattern.block_size : 1);
    anchorDate = getEffectiveAnchor(group.id, blockIdx, group.anchor_date);
  }
  const primaryStatus = computePersonDayStatus(
    { patternId, role, anchorDate, employeeId: slot.employee_id, slotId: slot.id, isPerson2: false }, ctx);
  if (primaryStatus) results.push({ ...primaryStatus, dutyId: slot.duty_id, slotId: slot.id, groupId: group.id, groupName: group.name, sharedEnabled: !!slot.shared_enabled });

  if (slot.shared_enabled && slot.shared_pattern_id) {
    const secondStatus = computePersonDayStatus(
      { patternId: slot.shared_pattern_id, role: slot.shared_role, anchorDate: slot.shared_anchor_date, employeeId: slot.employee_id_2, slotId: null, isPerson2: true }, ctx);
    if (secondStatus) results.push({ ...secondStatus, dutyId: slot.duty_id, slotId: slot.id, groupId: group.id, groupName: group.name, sharedEnabled: true });
  }
  return results;
}

// Every slot's status (from every group) for one date, in one pass -
// the shared building block for the Rota Sheet and for cover suggestions.
// Both of the following are expensive (each scans every group and slot,
// with several SQL queries per slot) and get called repeatedly for the
// SAME date within a single Rota Sheet render - the daily grid cells, the
// day-status button, and the "needs cover" list all separately ask for
// the same day's answer. Caching per date avoids redoing that work three
// times over; saveState() clears both caches on every write, so a stale
// answer can never survive past the next actual data change.
let _slotStatusCache = new Map();
let _autoCoverCache = new Map();

function getAllSlotStatusesForDate(dateISO){
  if (_slotStatusCache.has(dateISO)) return _slotStatusCache.get(dateISO);
  const ctx = computeDayContext(dateISO);
  const groups = q("SELECT * FROM duty_groups ORDER BY pinned DESC, sort_order, id").filter(g => groupIsInUse(g.id));
  const out = [];
  groups.forEach(g => {
    const slots = q("SELECT * FROM duty_group_slots WHERE duty_group_id=? ORDER BY slot_order", [g.id]);
    slots.forEach(slot => { computeSlotStatusesForDate(slot, g, ctx).forEach(r => out.push(r)); });
  });

  // A manual cover entry is a deliberate decision and always wins - so
  // whoever would normally hold that same duty via their own rotation
  // (not another override of their own) is no longer needed on it that
  // day. Free them up entirely - clear their duty for this day so they
  // read as spare capacity, letting the auto-cover engine reconsider
  // them for whatever's genuinely still short, rather than leaving two
  // people shown against the same duty.
  // Anyone whose kind is COVER with a label matching a real duty is
  // "doing" that duty today - whether that's a one-off manual entry, or
  // baked directly into their own pattern as part of a pre-planned
  // rotation (e.g. a DOC role whose pattern itself says "cover S7 Monday,
  // S6 Wednesday..."). Either way counts as genuine coverage: it frees up
  // anyone else whose own normal rotation would otherwise duplicate the
  // same duty, and the auto-cover engine (in computeAutoCoverAssignments)
  // uses this same map to recognise the duty as already resolved, rather
  // than flagging it as an unresolved gap nobody's covering.
  const coveredDutyIds = new Map(); // dutyId -> employeeId already covering it
  out.forEach(s => {
    if (s.kind !== 'COVER' || !s.employeeId) return;
    const duty = q("SELECT id FROM duties WHERE LOWER(code)=LOWER(?) OR LOWER(name)=LOWER(?)", [s.label, s.label])[0];
    if (duty) coveredDutyIds.set(duty.id, s.employeeId);
  });
  if (coveredDutyIds.size > 0) {
    out.forEach(s => {
      if (!s.isOverride && s.dutyId && coveredDutyIds.has(s.dutyId) && coveredDutyIds.get(s.dutyId) !== s.employeeId && ['WORK','SATWORK'].includes(s.kind)) {
        s.dutyId = null;
        s.supersededByManualCover = true;
      }
    });
  }

  _slotStatusCache.set(dateISO, out);
  return out;
}

// True if this employee is rostered to actually be working (their own or
// someone else's duty) on this date - used to prefer "ask a colleague
// who's already in" over "call someone in on their day off".
function isEmployeeWorkingOn(empId, dateISO, allStatuses){
  const statuses = allStatuses || getAllSlotStatusesForDate(dateISO);
  return statuses.some(s => s.employeeId === empId && ['WORK','SATWORK','COVER','SPARE'].includes(s.kind));
}
