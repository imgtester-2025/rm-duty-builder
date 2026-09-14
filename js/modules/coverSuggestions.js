/* ---------------------------------------------------------------
   COVER SUGGESTIONS - two distinct pieces of behaviour that share this
   file because they share so much of the same data:

   1. Automatic day-off cover assignment (computeAutoCoverAssignments,
      computeCoreDutyGapsForDate) - roles named exactly "DOC" or "WOC"
      don't do a duty of their own: their whole job is covering whoever
      else in their own duty group is on their scheduled day off that
      day. This is CORE: the Duty Sheet's per-day "all covered?" status
      header (core) depends on it unconditionally, so it always runs
      regardless of the optional module below.
   2. The "suggested cover: X, Y" hint shown on a Duty Sheet cell when
      someone's away (findSkilledAvailableCovers) - this IS the optional
      'coverSuggestions' module. It depends on 'skillsMatrix': while
      Skills Matrix is off, findSkilledAvailableCovers returns no
      suggestions at all (rather than reading stale/unmaintained scores),
      and turning Cover Suggestions on requires Skills Matrix on first
      (enforced in moduleRegistry.js's dependency check). Existing skill
      scores are never touched by either module being off - this is a
      UI-level gate, not a data one.

   When there's more than one gap in a group on the same day, the extra
   gap(s) are filled automatically too, in this order:
     1. Someone from the same group who isn't otherwise occupied
        (another DOC/WOC role in the same group, if one exists).
     2. Someone from the "Leave Cover" pool (any role named starting
        "Leave Cover") who is actually working that day, preferring
        one whose skills matrix includes the gap's duty.
     3. Whoever the ordinary suggestion logic would already offer.
   Shared duties are untouched by any of this - each person covers
   their own duty as normal unless they are themselves away, which
   the existing suggestion system already handles.
   --------------------------------------------------------------- */
const DAY_OFF_COVER_ROLE_NAMES = ['DOC', 'WOC'];

function computeAutoCoverAssignments(dateISO){
  if (_autoCoverCache.has(dateISO)) return _autoCoverCache.get(dateISO);
  const statuses = getAllSlotStatusesForDate(dateISO);
  const groups = q("SELECT * FROM duty_groups ORDER BY pinned DESC, sort_order, id").filter(g => groupIsInUse(g.id));
  const assignments = new Map(); // employeeId -> {dutyId, dutyLabel, coveredEmpName}
  const unresolvedGaps = []; // status objects for CORE day-off gaps nobody was free to cover
  const usedEmpIds = new Set();
  const coreDutyIds = new Set(q("SELECT id FROM duties WHERE duty_type='CORE'").map(r => r.id));

  // Whoever's already doing a duty today via a COVER-kind label matching
  // a real duty code - whether that's a manual entry or baked directly
  // into their own pattern as a pre-planned rotation - counts as that
  // duty genuinely being covered, by them specifically. It should never
  // also show up as an unresolved gap needing the engine to find someone
  // (the absent core-duty holder's own status still correctly reads
  // OFF/AL/etc), and that person is already committed for the day, so
  // they must not also be double-booked against a different gap.
  const alreadyCoveredDutyIds = new Map(); // dutyId -> employeeId covering it
  const committedEmpIds = new Set(); // employeeIds already covering a specific named duty
  statuses.forEach(s => {
    if (s.kind !== 'COVER' || !s.employeeId) return;
    const duty = q("SELECT id FROM duties WHERE LOWER(code)=LOWER(?) OR LOWER(name)=LOWER(?)", [s.label, s.label])[0];
    if (duty) { alreadyCoveredDutyIds.set(duty.id, s.employeeId); committedEmpIds.add(s.employeeId); }
  });

  // Someone with a manual override already has a specific, deliberately
  // chosen job that day - they must never be double-booked by the
  // auto-cover engine for something else on top of it, and never
  // silently "used up" against a gap they'd have no way to actually show.
  const leaveCoverPool = statuses.filter(s =>
    s.role && s.role.indexOf('Leave Cover') === 0 && s.employeeId && !s.sharedEnabled && !s.isOverride && !committedEmpIds.has(s.employeeId) && ['WORK','SATWORK','COVER','SPARE'].includes(s.kind));

  // Anyone else working today with no core duty of their own (they'd
  // otherwise just show a blank "no job" cell) - a last-resort pool,
  // used only when they're specifically skilled for the gap in question,
  // regardless of their role name or which group they belong to.
  const sparePool = statuses.filter(s =>
    s.employeeId && !s.sharedEnabled && !s.isOverride && !committedEmpIds.has(s.employeeId) && ['WORK','SATWORK','COVER','SPARE'].includes(s.kind) &&
    !(s.dutyId && coreDutyIds.has(s.dutyId)));

  // Every genuine gap across every group, computed up front - a "genuine"
  // gap excludes days where literally nobody anywhere is working (a true
  // universal closure like Sunday), not just this one group being quiet -
  // a single-role group with nobody else to compare against would
  // otherwise look identical to a universal closure and wrongly get skipped.
  const anyoneAnywhereWorking = statuses.some(s => ['WORK','SATWORK','COVER','SPARE'].includes(s.kind));

  const allGaps = [];
  const gapsByGroup = new Map(); // groupId -> { coverAgents, gaps }
  if (anyoneAnywhereWorking) {
    groups.forEach(g => {
      const groupStatuses = statuses.filter(s => s.groupId === g.id);
      const coverAgents = groupStatuses.filter(s =>
        DAY_OFF_COVER_ROLE_NAMES.includes(s.role) && s.employeeId && !s.sharedEnabled && !s.isOverride && !committedEmpIds.has(s.employeeId) && ['WORK','SATWORK','COVER','SPARE'].includes(s.kind));
      const gaps = groupStatuses.filter(s =>
        ['OFF','AL','SICK','OTHER','UNCOVERED'].includes(s.kind) && s.dutyId && coreDutyIds.has(s.dutyId) && !s.sharedEnabled && !DAY_OFF_COVER_ROLE_NAMES.includes(s.role) &&
        !(alreadyCoveredDutyIds.has(s.dutyId) && alreadyCoveredDutyIds.get(s.dutyId) !== s.employeeId));
      if (gaps.length === 0) return;
      gapsByGroup.set(g.id, { coverAgents, gaps });
      allGaps.push(...gaps.map(gap => ({ gap, groupId: g.id })));
    });
  }

  // Every gap picks whoever's actually best for it - but only from among
  // people with a genuinely recorded skill (score > 0) for that specific
  // duty, in ANY tier. Holding a DOC/WOC role or a Leave Cover slot no
  // longer grants automatic eligibility on its own - the Skills Matrix is
  // the one source of truth for whether someone can be trusted with a
  // duty at all. Among the genuinely skilled, the highest score wins
  // outright, even if that means a higher-scored spare or Leave Cover
  // person is preferred over the group's own DOC/WOC; ties fall back to
  // DOC/WOC first, then Leave Cover, then the wider spare-capacity pool.
  // If nobody anywhere has the duty recorded as a skill, the gap is left
  // genuinely unresolved rather than handed to someone unqualified.
  allGaps.forEach(({ gap, groupId }) => {
    const { coverAgents } = gapsByGroup.get(groupId);
    const skillByEmp = new Map(q("SELECT employee_id, score FROM employee_skills WHERE duty_id=?", [gap.dutyId]).map(r => [r.employee_id, r.score]));

    const candidates = [
      ...coverAgents.filter(c => (skillByEmp.get(c.employeeId) || 0) > 0).map(c => ({ c, tier: 0 })),
      ...leaveCoverPool.filter(c => (skillByEmp.get(c.employeeId) || 0) > 0).map(c => ({ c, tier: 1 })),
      ...sparePool.filter(c => (skillByEmp.get(c.employeeId) || 0) > 0).map(c => ({ c, tier: 2 })),
    ].filter(({ c }) => !usedEmpIds.has(c.employeeId));

    candidates.sort((a, b) => {
      const scoreA = skillByEmp.get(a.c.employeeId) || 0;
      const scoreB = skillByEmp.get(b.c.employeeId) || 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.tier - b.tier;
    });

    const best = candidates[0];
    if (best) {
      const duty = q("SELECT * FROM duties WHERE id=?", [gap.dutyId])[0];
      assignments.set(best.c.employeeId, {
        dutyId: gap.dutyId, dutyLabel: duty ? (duty.code || duty.name) : '?',
        coveredEmpName: gap.employeeId ? (q("SELECT name FROM employees WHERE id=?", [gap.employeeId])[0] || {}).name : null,
        reason: gap.kind
      });
      usedEmpIds.add(best.c.employeeId);
    } else {
      // Nobody free at all - a genuine gap, surfaced rather than hidden.
      unresolvedGaps.push(gap);
    }
  });

  const result = { assignments, unresolvedGaps, statuses, coreDutyIds };
  _autoCoverCache.set(dateISO, result);
  return result;
}

// Every CORE duty still genuinely uncovered on this date, after the
// auto-cover engine has done what it can - unassigned slots, someone away
// (A/L, sick, other) with nobody stepped in, and day-off gaps no DOC/WOC/
// Leave Cover person was free to take. Cover-type duties are never
// counted here; that's the whole point of the Core/Cover distinction.
function computeCoreDutyGapsForDate(dateISO, groupFilter){
  const { unresolvedGaps } = computeAutoCoverAssignments(dateISO);
  return unresolvedGaps
    .filter(s => !groupFilter || groupFilter.has(s.groupId))
    .map(s => {
    const duty = q("SELECT * FROM duties WHERE id=?", [s.dutyId])[0];
    const emp = s.employeeId ? q("SELECT name FROM employees WHERE id=?", [s.employeeId])[0] : null;
    return {
      role: s.role, groupName: s.groupName,
      dutyLabel: duty ? (duty.code || duty.name) : '?',
      reason: s.kind === 'OFF' ? 'nobody free to cover' : (REASON_LABEL[s.kind] || s.kind),
      empName: emp ? emp.name : null
    };
  });
}

// Employees skilled for a duty, available on that date (not the absent
// person themselves, and not already down as absent that day). Used to
// power the "suggest a cover" feature when someone's away on a working day.
// Cover suggestions, in the priority order requested: prefer someone
// skilled who is already working today (minimal disruption - just ask
// them to switch/help out) over someone who'd need to be called in on
// their day off. Both tiers still exclude anyone who is themselves away
// (A/L, sick, other absence) that day.
function findSkilledAvailableCovers(dutyId, dateISO, excludeEmployeeId){
  if (!ModuleRegistry.isEnabled('coverSuggestions')) return [];
  if (!dutyId) return [];
  const skilledIds = q("SELECT employee_id FROM employee_skills WHERE duty_id=?", [dutyId]).map(r => r.employee_id);
  const available = skilledIds
    .filter(empId => empId !== excludeEmployeeId)
    .filter(empId => !isEmployeeAbsentOn(empId, dateISO))
    .map(empId => q("SELECT * FROM employees WHERE id=?", [empId])[0])
    .filter(Boolean);
  if (available.length === 0) return [];
  const allStatuses = getAllSlotStatusesForDate(dateISO);
  const alreadyWorking = available.filter(e => isEmployeeWorkingOn(e.id, dateISO, allStatuses));
  return alreadyWorking.length > 0 ? alreadyWorking : available;
}

ModuleRegistry.register({
  id: 'coverSuggestions', name: 'Cover Suggestions', core: false,
  dependencies: ['skillsMatrix'],
  description: 'Skill-based "suggested cover: X, Y" hints on Duty Sheet cells when someone is away. Requires Skills Matrix to be enabled. The automatic DOC/WOC day-off cover engine and the Duty Sheet\'s per-day coverage status stay on regardless - only these suggestion hints are gated.'
});
