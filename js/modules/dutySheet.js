/* ---------------------------------------------------------------
   DUTY SHEET - the main multi-week duty calendar. CORE: this is the
   application's primary output. Its Uncovered Duties and Who's Off
   side panels, and its Excel export / print buttons, are each their
   own OPTIONAL module (registered further down this file) - turning
   any of them off only hides that panel/button; the calendar itself
   and its coverage-status header keep working exactly the same.
   --------------------------------------------------------------- */
function buildSharedEmployeeRow(slot, startMonday, numWeeks, holidaysMap, annualLeaveMap, otherAbsenceMap){
  const pattern = getPattern(slot.shared_pattern_id);
  if (!pattern || !pattern.weeks[1][slot.shared_role]) return null;
  const emp = q("SELECT * FROM employees WHERE id=?", [slot.employee_id_2])[0];

  const tr = document.createElement('tr');
  tr.className = 'shared-duty-row';
  const labelTd = document.createElement('td');
  labelTd.className = 'row-label';
  labelTd.innerHTML = `<div class="row-role">${escapeHtml(slot.shared_role)} <span class="shared-badge">Shared</span></div>
    <div class="row-emp">${emp ? escapeHtml(emp.name) : '<span class="unfilled">unassigned</span>'}</div>
    <div class="row-duty">${escapeHtml(pattern.name)}</div>`;
  tr.appendChild(labelTd);

  const otherAbsenceForEmp = emp ? otherAbsenceMap.get(emp.id) : null;

  for (let w = 0; w < numWeeks; w++) {
    const wMon = addDays(startMonday, w*7);
    const weekDateISO = toISO(wMon);
    const cycleWk = cycleWeekFor(slot.shared_anchor_date, weekDateISO, pattern.cycle_length);
    const weekPattern = pattern.weeks[cycleWk][slot.shared_role] || W(OF,OF,OF,OF,OF,OF);
    const onLeaveThisWeek = emp && annualLeaveMap.has(emp.id) && annualLeaveMap.get(emp.id).has(weekDateISO);
    DAYS.forEach((d, di) => {
      const dateISO = toISO(addDays(wMon, di));
      const holidayName = holidaysMap.get(dateISO);
      const otherAbsence = findOtherAbsenceForDate(otherAbsenceForEmp, dateISO);
      let kind, label, title;
      let coverSuggestions = null;
      if (holidayName) {
        kind = 'BH'; label = 'BH'; title = holidayName;
      } else {
        [kind, label] = weekPattern[d];
        if (kind !== 'OFF' && !emp) {
          kind = 'UNCOVERED'; label = 'GAP'; title = 'No employee assigned - this working day is uncovered';
        } else if (kind !== 'OFF' && otherAbsence) {
          kind = otherAbsence.type; label = otherAbsence.type === 'SICK' ? 'SICK' : 'ABS';
          title = KIND_LABEL[kind] + (otherAbsence.note ? ': ' + otherAbsence.note : '');
          coverSuggestions = findSkilledAvailableCovers(slot.duty_id, dateISO, emp.id);
        } else if (kind !== 'OFF' && onLeaveThisWeek) {
          kind = 'AL'; label = 'A/L'; title = 'Annual Leave';
          coverSuggestions = findSkilledAvailableCovers(slot.duty_id, dateISO, emp.id);
        } else {
          title = KIND_LABEL[kind];
        }
      }
      if (coverSuggestions) {
        title += coverSuggestions.length > 0
          ? ` \u2013 suggested cover: ${coverSuggestions.map(c => c.name).join(', ')}`
          : ' \u2013 no skilled, available cover found';
      }
      const td = document.createElement('td');
      const hasSuggestion = coverSuggestions && coverSuggestions.length > 0;
      td.className = 'cal-cell cell-' + kind.toLowerCase() + (hasSuggestion ? ' cal-cell-editable cal-cell-has-suggestion' : '');
      td.textContent = label;
      if (['AL','SICK','OTHER'].includes(kind)) { td.dataset.absenceType = kind; td.dataset.absenceNote = (otherAbsence && otherAbsence.note) || ''; }
      else if (kind === 'OFF') { td.dataset.absenceType = 'OFF'; td.dataset.absenceNote = ''; }
      td.title = title + (hasSuggestion ? ' (click to see who can cover)' : '');
      if (emp) td.dataset.employeeId = emp.id;
      td.dataset.date = dateISO;
      td.dataset.role = slot.shared_role;
      td.dataset.empName = emp ? emp.name : '';
      if (['UNCOVERED','AL','SICK','OTHER'].includes(kind)) td.dataset.needsCover = '1';
      if (hasSuggestion) {
        td.dataset.suggestedCovers = coverSuggestions.map(c => c.id + ':' + c.name).join('|');
        td.dataset.slotId = slot.id;
        td.dataset.sharedPerson2 = '1';
        td.addEventListener('click', onCalCellClick);
      }
      tr.appendChild(td);
    });
  }
  return tr;
}

function renderCalendar(){
  const container = document.getElementById('calendarContainer');
  const weekStartISO = document.getElementById('weekPicker').value;
  const numWeeks = Math.max(1, Math.min(6, Number(document.getElementById('numWeeks').value) || 4));
  container.innerHTML = '';

  const groups = q("SELECT * FROM duty_groups ORDER BY pinned DESC, sort_order, id")
    .filter(g => printGroupSelection ? printGroupSelection.has(g.id) : (sheetPatternFilter === 'all' || String(g.pattern_id) === String(sheetPatternFilter)))
    .filter(g => groupIsInUse(g.id));
  if (groups.length === 0) {
    container.innerHTML = sheetPatternFilter === 'all'
      ? '<p class="empty-hint">No duty groups have anyone assigned yet - assign employees in Duty Builder to see them here.</p>'
      : '<p class="empty-hint">No duty groups using this pattern have anyone assigned yet.</p>';
    updatePrintTitle(weekStartISO, numWeeks); return;
  }

  const startMonday = mondayOf(parseISO(weekStartISO));
  const holidaysMap = new Map(q("SELECT date, name FROM bank_holidays").map(r => [r.date, r.name]));
  const overrideMap = new Map(q("SELECT * FROM cell_overrides").map(r => [r.slot_id + '|' + r.date_iso, r]));
  const annualLeaveMap = new Map(); // employee_id -> Set of week-commencing ISO dates
  q("SELECT employee_id, week_date FROM annual_leave").forEach(r => {
    if (!annualLeaveMap.has(r.employee_id)) annualLeaveMap.set(r.employee_id, new Set());
    annualLeaveMap.get(r.employee_id).add(r.week_date);
  });
  const otherAbsenceMap = new Map(); // employee_id -> [{start_date, end_date, type, note}, ...]
  q("SELECT * FROM other_absences").forEach(r => {
    if (!otherAbsenceMap.has(r.employee_id)) otherAbsenceMap.set(r.employee_id, []);
    otherAbsenceMap.get(r.employee_id).push(r);
  });
  const overtimeEntryMap = new Map();
  q("SELECT slot_id, date_iso, reason, minutes FROM overtime_entries").forEach(r => {
    const key = r.slot_id + '|' + r.date_iso;
    if (!overtimeEntryMap.has(key)) overtimeEntryMap.set(key, []);
    overtimeEntryMap.get(key).push(r);
  });

  groups.forEach(g => {
    const pattern = getPattern(g.pattern_id);
    if (!pattern) return;
    const table = document.createElement('table');
    table.className = 'cal-table';
    const caption = document.createElement('caption');
    caption.textContent = (g.pinned ? '\ud83d\udccc ' : '') + g.name + '  (' + pattern.name + ')';
    table.appendChild(caption);

    const thead = document.createElement('thead');
    const weekHeaderRow = document.createElement('tr');
    weekHeaderRow.appendChild(document.createElement('th'));
    for (let w = 0; w < numWeeks; w++) {
      const wMon = addDays(startMonday, w*7);
      const th = document.createElement('th');
      th.colSpan = 7; th.className = 'week-band';
      const cycleWk = cycleWeekFor(g.anchor_date, toISO(wMon), pattern.cycle_length);
      th.textContent = 'W/C ' + fmtShort(wMon) + '  \u2013  Cycle Week ' + cycleWk + ' of ' + pattern.cycle_length;
      weekHeaderRow.appendChild(th);
    }
    thead.appendChild(weekHeaderRow);
    // Same idea as the Rota Sheet's per-day status buttons, scoped to just
    // this one group - a quick green/red glance at whether every core
    // duty is covered each day, with the same click-through modal.
    const statusHeaderRow = document.createElement('tr');
    statusHeaderRow.appendChild(document.createElement('th'));
    for (let w = 0; w < numWeeks; w++) {
      const wMon = addDays(startMonday, w*7);
      DAYS.forEach((d, di) => {
        const dateISO = toISO(addDays(wMon, di));
        const th = document.createElement('th');
        th.className = 'rota-day-status-cell';
        const gaps = computeCoreDutyGapsForDate(dateISO, new Set([g.id]));
        if (gaps.length === 0) {
          th.innerHTML = '<span class="rota-day-status rota-day-status-ok" title="All core duties covered">&#10003;</span>';
        } else {
          th.innerHTML = `<button type="button" class="rota-day-status rota-day-status-bad" data-core-gaps-date="${dateISO}" data-core-gaps-group="${g.id}" title="Click to see what's uncovered">${gaps.length}</button>`;
        }
        statusHeaderRow.appendChild(th);
      });
    }
    thead.appendChild(statusHeaderRow);
    const dayHeaderRow = document.createElement('tr');
    dayHeaderRow.appendChild(document.createElement('th')).textContent = 'Role / Duty / Employee';
    for (let w = 0; w < numWeeks; w++) DAYS.forEach(d => { const th=document.createElement('th'); th.className='day-head'; th.textContent=DAY_LABELS[d]; dayHeaderRow.appendChild(th); });
    thead.appendChild(dayHeaderRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const slots = q("SELECT * FROM duty_group_slots WHERE duty_group_id=? ORDER BY slot_order", [g.id]);
    slots.forEach((slot, slotIdx) => {
      // Shared duty overrides the block's own rotation entirely for BOTH
      // people - this row (the slot's own employee) uses their own pattern
      // once shared, instead of inheriting the group's.
      // A slot's own employee uses their own pattern whenever one is set,
      // whether that's because the duty is shared (person 1 always gets an
      // independent rotation once shared) or because an individual
      // rotation override was set directly, with no sharing involved.
      const usesOwnRotation = !!slot.primary_pattern_id;
      const rowPattern = usesOwnRotation ? getPattern(slot.primary_pattern_id) : pattern;
      const rowRole = usesOwnRotation ? slot.primary_role : slot.role;
      if (!rowPattern || !rowPattern.weeks[1][rowRole]) return;
      const blockIdx = blockIndexFor(slot.slot_order, pattern.block_size);
      const rowAnchor = usesOwnRotation ? slot.primary_anchor_date : getEffectiveAnchor(g.id, blockIdx, g.anchor_date);
      const effectiveAnchor = rowAnchor;
      const tr = document.createElement('tr');
      const labelTd = document.createElement('td');
      labelTd.className = 'row-label';
      let empName = '<span class="unfilled">unassigned</span>';
      if (slot.employee_id) { const emp = q("SELECT * FROM employees WHERE id=?", [slot.employee_id])[0]; if (emp) empName = escapeHtml(emp.name); }
      let dutyName = '';
      if (slot.duty_id) { const duty = q("SELECT * FROM duties WHERE id=?", [slot.duty_id])[0]; if (duty) dutyName = `<div class="row-duty">${escapeHtml(duty.name)}</div>`; }
      const sharedBadge = slot.shared_enabled ? ' <span class="shared-badge">Shared</span>'
        : (usesOwnRotation ? ' <span class="individual-badge">Individual</span>' : '');
      const anchorNote = (!usesOwnRotation && effectiveAnchor !== g.anchor_date)
        ? `<div class="row-anchor-note" title="This block's own Cycle Week 1 date, set in Duty Builder">Wk1: ${escapeHtml(fmtShort(parseISO(effectiveAnchor)))}</div>` : '';
      labelTd.innerHTML = `<div class="row-role">${escapeHtml(rowRole)}${sharedBadge}</div><div class="row-emp">${empName}</div>${dutyName}${anchorNote}`;
      tr.appendChild(labelTd);

      for (let w = 0; w < numWeeks; w++) {
        const wMon = addDays(startMonday, w*7);
        const weekDateISO = toISO(wMon);
        const cycleWk = cycleWeekFor(effectiveAnchor, weekDateISO, rowPattern.cycle_length);
        const weekPattern = rowPattern.weeks[cycleWk][rowRole] || W(OF,OF,OF,OF,OF,OF);
        const onLeaveThisWeek = slot.employee_id && annualLeaveMap.has(slot.employee_id) && annualLeaveMap.get(slot.employee_id).has(weekDateISO);
        const otherAbsenceForEmp = slot.employee_id ? otherAbsenceMap.get(slot.employee_id) : null;
        DAYS.forEach((d, di) => {
          const dateISO = toISO(addDays(wMon, di));
          const override = overrideMap.get(slot.id + '|' + dateISO);
          const holidayName = holidaysMap.get(dateISO);
          const otherAbsence = findOtherAbsenceForDate(otherAbsenceForEmp, dateISO);
          // Captured independently of any override, so a "who's off" summary
          // still shows someone even after their duty has since been covered
          // (an arranged cover changes what the cell *displays*, not whether
          // they were actually off that day).
          let underlyingAbsence = null;
          if (!holidayName && weekPattern[d][0] !== 'OFF') {
            if (otherAbsence) underlyingAbsence = {type: otherAbsence.type, note: otherAbsence.note};
            else if (onLeaveThisWeek) underlyingAbsence = {type: 'AL', note: ''};
          }
          let kind, label, title;
          let coverSuggestions = null;
          if (override) {
            kind = override.kind; label = override.label;
            title = 'Manual entry: ' + KIND_LABEL[kind] + ' (click to edit)';
          } else if (holidayName) {
            kind = 'BH'; label = 'BH'; title = holidayName;
          } else {
            [kind, label] = weekPattern[d];
            if (kind !== 'OFF' && !slot.employee_id) {
              kind = 'UNCOVERED'; label = 'GAP';
              title = 'No employee assigned - this working day is uncovered (click to add a manual entry)';
            } else if (kind !== 'OFF' && otherAbsence) {
              kind = otherAbsence.type; label = otherAbsence.type === 'SICK' ? 'SICK' : 'ABS';
              title = KIND_LABEL[kind] + (otherAbsence.note ? ': ' + otherAbsence.note : '') + ' (click to add a manual entry)';
              coverSuggestions = findSkilledAvailableCovers(slot.duty_id, dateISO, slot.employee_id);
            } else if (kind !== 'OFF' && onLeaveThisWeek) {
              kind = 'AL'; label = 'A/L'; title = 'Annual Leave (click to add a manual entry)';
              coverSuggestions = findSkilledAvailableCovers(slot.duty_id, dateISO, slot.employee_id);
            } else {
              title = KIND_LABEL[kind] + ' (click to add a manual entry)';
            }
          }
          if (coverSuggestions) {
            title += coverSuggestions.length > 0
              ? ` \u2013 suggested cover: ${coverSuggestions.map(c => c.name).join(', ')}`
              : ' \u2013 no skilled, available cover found';
          }
          const otEntries = overtimeEntryMap.get(slot.id + '|' + dateISO) || [];
          const hasAgreedOt = otEntries.length > 0;
          if (hasAgreedOt) {
            const summary = otEntries.map(en => `${OVERTIME_REASON_LABELS[en.reason] || en.reason}: ${en.minutes} min`).join('; ');
            title += ` \u2013 ${summary}`;
          }
          const td = document.createElement('td');
          const hasSuggestion = coverSuggestions && coverSuggestions.length > 0;
          td.className = 'cal-cell cell-' + kind.toLowerCase() + ' cal-cell-editable' + (override ? ' cal-cell-override' : '') + (hasAgreedOt ? ' cal-cell-agreed-ot' : '') + (hasSuggestion ? ' cal-cell-has-suggestion' : '');
          td.textContent = label;
          td.title = title;
          td.dataset.slotId = slot.id;
          td.dataset.date = dateISO;
          td.dataset.role = slot.role;
          if (slot.employee_id) td.dataset.employeeId = slot.employee_id;
          if (hasSuggestion) td.dataset.suggestedCovers = coverSuggestions.map(c => c.id + ':' + c.name).join('|');
          if (underlyingAbsence) { td.dataset.absenceType = underlyingAbsence.type; td.dataset.absenceNote = underlyingAbsence.note || ''; }
          else if (kind === 'OFF') { td.dataset.absenceType = 'OFF'; td.dataset.absenceNote = ''; }
          // Flags this cell for the "Uncovered" sidebar - any working day with
          // nobody actually covering it, whether that's because no one is
          // assigned at all, or because the assigned person is on annual
          // leave, sick, or another absence with no cover arranged yet (an
          // arranged cover shows up as kind=COVER via the override above,
          // and is correctly excluded).
          if (['UNCOVERED','AL','SICK','OTHER'].includes(kind)) td.dataset.needsCover = '1';
          td.addEventListener('click', onCalCellClick);
          tr.appendChild(td);
        });
      }
      tbody.appendChild(tr);

      let lastRowForSlot = tr;
      if (slot.shared_enabled && slot.employee_id_2 && slot.shared_pattern_id && slot.shared_role) {
        const sharedTr = buildSharedEmployeeRow(slot, startMonday, numWeeks, holidaysMap, annualLeaveMap, otherAbsenceMap);
        if (sharedTr) { tbody.appendChild(sharedTr); lastRowForSlot = sharedTr; }
      }
      // Only relevant when a pattern has more roles than its "duties per
      // row" block size - draws a darker line after the last row of each
      // block so groups of roles are easier to tell apart at a glance.
      const nextSlot = slots[slotIdx + 1];
      const isBlockBoundary = pattern.block_size < slots.length &&
        (!nextSlot || blockIndexFor(nextSlot.slot_order, pattern.block_size) !== blockIdx);
      if (isBlockBoundary) lastRowForSlot.classList.add('role-block-end');
    });
    table.appendChild(tbody);
    container.appendChild(table);
  });
  flagDuplicateBookings(container);
  updateUncoveredPanel();
  updateWhosOffPanel();
  updatePrintTitle(weekStartISO, numWeeks);
  requestAnimationFrame(updateStickyOffsets);
}

// Scans every "GAP" (uncovered) cell currently on screen and groups them by
// date for the slide-out panel, so gaps across many groups/weeks can be
// scanned at a glance instead of hunting through each table individually.
ModuleRegistry.register({
  id: 'uncoveredDuties', name: 'Uncovered Duties Panel', core: false,
  hideSelectors: ['#uncoveredPanelToggle', '#uncoveredPanel'],
  description: 'Slide-out panel on the Duty Sheet listing every working day nobody is actually covering, with a print and jump-to-cell option.'
});

function scanUncoveredByDate(){
  const byDate = new Map(); // dateISO -> [{groupName, role}]
  Array.from(document.querySelectorAll('#calendarContainer td[data-needs-cover="1"]')).forEach(td => {
    const dateISO = td.dataset.date;
    if (!dateISO) return;
    const table = td.closest('table');
    const groupName = table ? table.querySelector('caption').textContent.trim() : '';
    const roleEl = td.closest('tr').querySelector('.row-role');
    const role = roleEl ? roleEl.textContent.replace('Shared', '').trim() : '';
    if (!byDate.has(dateISO)) byDate.set(dateISO, []);
    byDate.get(dateISO).push({groupName, role});
  });
  return byDate;
}

function updateUncoveredPanel(){
  if (!ModuleRegistry.isEnabled('uncoveredDuties')) return;
  const content = document.getElementById('uncoveredPanelContent');
  const badge = document.getElementById('uncoveredPanelBadge');
  if (!content || !badge) return;

  const byDate = scanUncoveredByDate();
  const totalCount = [...byDate.values()].reduce((sum, items) => sum + items.length, 0);
  badge.textContent = totalCount;
  badge.style.display = totalCount > 0 ? '' : 'none';

  if (byDate.size === 0) {
    content.innerHTML = '<p class="empty-hint">No uncovered duties in the range currently shown.</p>';
    return;
  }

  const sortedDates = [...byDate.keys()].sort();
  content.innerHTML = sortedDates.map(dateISO => {
    const items = byDate.get(dateISO);
    const d = parseISO(dateISO);
    const dayName = d.toLocaleDateString('en-GB', {weekday: 'long', timeZone: 'UTC'});
    return `<div class="uncovered-day-group">
      <div class="uncovered-day-header"><span>${escapeHtml(dayName)} ${escapeHtml(fmtShort(d))}</span><span class="uncovered-day-count">${items.length}</span></div>
      <ul class="uncovered-day-list">
        ${items.map(it => `<li data-jump-date="${dateISO}" data-jump-role="${escapeHtml(it.role)}" data-jump-group="${escapeHtml(it.groupName)}">
          <strong>${escapeHtml(it.role)}</strong><span class="uncovered-group-name">${escapeHtml(it.groupName)}</span>
        </li>`).join('')}
      </ul>
    </div>`;
  }).join('');
}

// Same idea as the Uncovered panel, but shows everyone booked off (A/L,
// Sick, Other) regardless of whether cover has since been arranged for
// them - an informational "who's out" view rather than an action list.
ModuleRegistry.register({
  id: 'whosOff', name: "Who's Off Panel", core: false,
  hideSelectors: ['#whosOffPanelToggle', '#whosOffPanel'],
  description: "Slide-out panel on the Duty Sheet listing everyone booked as Annual Leave, Sick, on another absence, or on their normal day off."
});

function scanWhosOffByDate(){
  const byDate = new Map(); // dateISO -> [{groupName, empName, type, note}]
  Array.from(document.querySelectorAll('#calendarContainer td[data-absence-type]')).forEach(td => {
    const dateISO = td.dataset.date;
    if (!dateISO) return;
    const table = td.closest('table');
    const groupName = table ? table.querySelector('caption').textContent.trim() : '';
    const empEl = td.closest('tr').querySelector('.row-emp');
    const empName = empEl ? empEl.textContent.trim() : (td.dataset.empName || 'Unassigned');
    if (!byDate.has(dateISO)) byDate.set(dateISO, []);
    byDate.get(dateISO).push({groupName, empName, type: td.dataset.absenceType, note: td.dataset.absenceNote || ''});
  });
  return byDate;
}

function updateWhosOffPanel(){
  if (!ModuleRegistry.isEnabled('whosOff')) return;
  const content = document.getElementById('whosOffPanelContent');
  const badge = document.getElementById('whosOffPanelBadge');
  if (!content || !badge) return;

  const byDate = scanWhosOffByDate();
  const totalCount = [...byDate.values()].reduce((sum, items) => sum + items.length, 0);
  badge.textContent = totalCount;
  badge.style.display = totalCount > 0 ? '' : 'none';

  if (byDate.size === 0) {
    content.innerHTML = '<p class="empty-hint">Nobody is booked off in the range currently shown.</p>';
    return;
  }

  const typeLabel = {AL: 'A/L', SICK: 'Sick', OTHER: 'Other', OFF: 'Day Off'};
  const sortedDates = [...byDate.keys()].sort();
  content.innerHTML = sortedDates.map(dateISO => {
    const items = byDate.get(dateISO);
    const d = parseISO(dateISO);
    const dayName = d.toLocaleDateString('en-GB', {weekday: 'long', timeZone: 'UTC'});
    return `<div class="whosoff-day-group">
      <div class="whosoff-day-header"><span>${escapeHtml(dayName)} ${escapeHtml(fmtShort(d))}</span><span class="whosoff-day-count">${items.length}</span></div>
      <ul class="whosoff-day-list">
        ${items.map(it => `<li data-jump-date="${dateISO}" data-jump-emp="${escapeHtml(it.empName)}" data-jump-group="${escapeHtml(it.groupName)}">
          <span><span class="whosoff-type-tag whosoff-type-${it.type.toLowerCase()}">${typeLabel[it.type] || it.type}</span><strong>${escapeHtml(it.empName)}</strong></span>
          <span class="whosoff-group-name">${escapeHtml(it.groupName)}${it.note ? ' &ndash; ' + escapeHtml(it.note) : ''}</span>
        </li>`).join('')}
      </ul>
    </div>`;
  }).join('');
}

// Builds one 7-day-column table per week currently shown on the Duty
// Sheet (matching its own week picker/weeks-to-show range), each on its
// own page - used for the Uncovered Duties and Who's Off prints so a
// manager can see a whole week's picture at a glance, one sheet per
// week, rather than a single long list. itemRenderer turns one item into
// its own little HTML block within a day's cell.
function buildPrintWeekGrids(byDate, itemRenderer, emptyDayText){
  const startMonday = mondayOf(parseISO(document.getElementById('weekPicker').value));
  const numWeeks = Math.min(6, Math.max(1, Number(document.getElementById('numWeeks').value) || 1));
  const weeksHtml = [];
  for (let w = 0; w < numWeeks; w++) {
    const wMon = addDays(startMonday, w*7);
    const dates = DAYS.map((_, i) => toISO(addDays(wMon, i)));
    const headerCells = dates.map(dateISO => `<th>${escapeHtml(fmtShort(parseISO(dateISO)))}</th>`).join('');
    const bodyCells = dates.map(dateISO => {
      const items = byDate.get(dateISO) || [];
      return `<td class="print-week-grid-day">${items.length ? items.map(itemRenderer).join('') : `<span class="print-week-grid-empty">${emptyDayText}</span>`}</td>`;
    }).join('');
    weeksHtml.push(`<div class="print-week-grid-page">
      <h3>W/C ${escapeHtml(fmtShort(wMon))}</h3>
      <table class="print-week-grid-table">
        <thead><tr>${DAYS.map(d => `<th>${DAY_LABELS[d]}</th>`).join('')}</tr><tr>${headerCells}</tr></thead>
        <tbody><tr>${bodyCells}</tr></tbody>
      </table>
    </div>`);
  }
  return weeksHtml.join('');
}

// Shared by both the Uncovered Duties and Who's Off side panels' Print
// buttons - builds a clean, standalone print of just that panel's
// current content (whatever weeks/groups/filters are active on screen),
// hiding the rest of the Duty Sheet page entirely rather than trying to
// print a fixed-position side panel as-is.
function printSidePanel(titleText, hintText, contentHtml, pageSize){
  document.getElementById('sidePanelPrintOutput').innerHTML =
    `<h2>${escapeHtml(titleText)}</h2><p class="empty-hint">${escapeHtml(hintText)}</p>${contentHtml}`;
  document.body.classList.add('printing-side-panel');
  document.getElementById('dynamicPageSize').textContent = pageSize || '@page{ size: A4 portrait; margin: 14mm; }';
  const restore = () => {
    document.body.classList.remove('printing-side-panel');
    document.getElementById('sidePanelPrintOutput').innerHTML = '';
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  setTimeout(() => window.print(), 50);
}

function wireUncoveredPanel(){
  document.getElementById('uncoveredPanelToggle').addEventListener('click', () => {
    document.getElementById('uncoveredPanel').classList.toggle('open');
  });
  document.getElementById('uncoveredPanelClose').addEventListener('click', () => {
    document.getElementById('uncoveredPanel').classList.remove('open');
  });
  document.getElementById('uncoveredPanelPrint').addEventListener('click', () => {
    const byDate = scanUncoveredByDate();
    const grids = buildPrintWeekGrids(byDate,
      it => `<div class="print-week-grid-item"><strong>${escapeHtml(it.role)}</strong><span>${escapeHtml(it.groupName)}</span></div>`,
      'All covered');
    printSidePanel(
      'Uncovered Duties',
      "Any working day with nobody actually covering it, one week per page, for whichever weeks/groups are currently shown.",
      grids,
      '@page{ size: A4 landscape; margin: 10mm; }'
    );
  });
  document.getElementById('uncoveredPanelContent').addEventListener('click', e => {
    const li = e.target.closest('[data-jump-date]');
    if (!li) return;
    const { jumpDate, jumpGroup, jumpRole } = li.dataset;
    const table = Array.from(document.querySelectorAll('table.cal-table'))
      .find(t => t.querySelector('caption').textContent.trim() === jumpGroup);
    if (!table) return;
    const row = Array.from(table.querySelectorAll('tbody tr'))
      .find(tr => { const r = tr.querySelector('.row-role'); return r && r.textContent.replace('Shared', '').trim() === jumpRole; });
    const cell = row ? row.querySelector(`td[data-needs-cover="1"][data-date="${jumpDate}"]`) : null;
    if (!cell) return;
    cell.scrollIntoView({behavior: 'smooth', block: 'center'});
    cell.classList.add('cal-cell-jump-flash');
    setTimeout(() => cell.classList.remove('cal-cell-jump-flash'), 1500);
  });
}

function wireWhosOffPanel(){
  document.getElementById('whosOffPanelToggle').addEventListener('click', () => {
    document.getElementById('whosOffPanel').classList.toggle('open');
  });
  document.getElementById('whosOffPanelClose').addEventListener('click', () => {
    document.getElementById('whosOffPanel').classList.remove('open');
  });
  document.getElementById('whosOffPanelPrint').addEventListener('click', () => {
    const byDate = scanWhosOffByDate();
    const typeLabel = {AL: 'A/L', SICK: 'Sick', OTHER: 'Other', OFF: 'Day Off'};
    const grids = buildPrintWeekGrids(byDate,
      it => `<div class="print-week-grid-item"><span class="whosoff-type-tag whosoff-type-${it.type.toLowerCase()}">${typeLabel[it.type] || it.type}</span><strong>${escapeHtml(it.empName)}</strong><span>${escapeHtml(it.groupName)}</span></div>`,
      'Nobody off');
    printSidePanel(
      "Who's Off",
      'Everyone booked as Annual Leave, Sick, on another absence, or on their normal day off, one week per page, for whichever weeks/groups are currently shown.',
      grids,
      '@page{ size: A4 landscape; margin: 10mm; }'
    );
  });
  document.getElementById('whosOffPanelContent').addEventListener('click', e => {
    const li = e.target.closest('[data-jump-date]');
    if (!li) return;
    const { jumpDate, jumpGroup, jumpEmp } = li.dataset;
    const table = Array.from(document.querySelectorAll('table.cal-table'))
      .find(t => t.querySelector('caption').textContent.trim() === jumpGroup);
    if (!table) return;
    const row = Array.from(table.querySelectorAll('tbody tr'))
      .find(tr => { const r = tr.querySelector('.row-emp'); return r && r.textContent.trim() === jumpEmp; });
    const cell = row ? row.querySelector(`td[data-absence-type][data-date="${jumpDate}"]`) : null;
    if (!cell) return;
    cell.scrollIntoView({behavior: 'smooth', block: 'center'});
    cell.classList.add('cal-cell-jump-flash-blue');
    setTimeout(() => cell.classList.remove('cal-cell-jump-flash-blue'), 1500);
  });
}

// Post-processing pass across every table currently on screen: if the same
// employee is shown actually working (not off/on leave/etc) in more than
// one slot on the same date, they've been double-booked - flag every cell
// involved so it's obvious at a glance, with the clash explained in the
// tooltip. Deliberately only catches structured assignments (the slot's
// own employee), not free-text override labels that happen to match a name.
function flagDuplicateBookings(container){
  const workingKinds = ['cell-work', 'cell-satwork', 'cell-cover'];
  const cells = Array.from(container.querySelectorAll('td.cal-cell[data-employee-id]'))
    .filter(td => workingKinds.some(k => td.classList.contains(k)));
  const byKey = new Map(); // "employeeId|date" -> [td, td, ...]
  cells.forEach(td => {
    const key = td.dataset.employeeId + '|' + td.dataset.date;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(td);
  });
  byKey.forEach(tds => {
    if (tds.length < 2) return;
    tds.forEach(td => {
      td.classList.add('cal-cell-duplicate');
      const others = tds.filter(t => t !== td);
      const context = others.map(t => {
        const roleCell = t.closest('tr').querySelector('.row-role');
        return roleCell ? roleCell.textContent.replace(/Shared$/, '').trim() : '';
      }).filter(Boolean).join(', ');
      td.title += ` \u2013 \u26A0 double-booked: also scheduled as ${context || 'another role'} this day`;
    });
  });
}

// Measures the fixed header + Duty Sheet controls bar so the per-table
// sticky captions/headers know exactly how far down to stick to, rather
// than a guessed/hardcoded pixel value that would break if labels wrap.
function updateStickyOffsets(){
  const header = document.querySelector('header.app-header');
  const bar = document.getElementById('dutySheetStickyBar');
  const headerH = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
  const barH = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
  const firstCaption = document.querySelector('#pageDutySheet table.cal-table caption');
  const captionH = firstCaption ? Math.ceil(firstCaption.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--header-h', headerH + 'px');
  document.documentElement.style.setProperty('--sticky-bar-h', (headerH + barH) + 'px');
  document.documentElement.style.setProperty('--caption-h', captionH + 'px');
}

function updatePrintTitle(weekStartISO, numWeeks){
  const el = document.getElementById('printTitle');
  if (!el) return;
  const startMonday = mondayOf(parseISO(weekStartISO));
  const endMonday = addDays(startMonday, (numWeeks-1)*7);
  el.textContent = 'Duty Sheet  \u2014  W/C ' + fmtShort(startMonday) + '  to  W/C ' + fmtShort(endMonday);
}

let printGroupSelection = null; // null = normal on-screen filter; Set of group IDs while actively printing a specific pick

ModuleRegistry.register({
  id: 'printing', name: 'Printing', core: false,
  hideSelectors: ['#printDutySheetBtn', '#rotaSheetPrintDayBtn', '#uncoveredPanelPrint', '#whosOffPanelPrint'],
  description: 'The A3 colour Duty Sheet print, the Rota Sheet A3 print, and the Uncovered Duties / Who\'s Off panel prints. Excel export (a separate, non-printing output) is controlled by the Excel Import/Export module instead.'
});

// Wires the Duty Sheet's own "Print" button (the OPTIONAL Printing
// module). Kept separate from wireDutySheetExcelExport() below since the
// two buttons belong to different optional modules.
function wireDutySheetPrintButton(){
  document.getElementById('printDutySheetBtn').addEventListener('click', () => {
    const groups = q("SELECT * FROM duty_groups ORDER BY pinned DESC, sort_order, id").filter(g => groupIsInUse(g.id));
    if (groups.length === 0) { alert('No duty groups with anyone assigned yet - nothing to print.'); return; }
    const currentlyShown = new Set(groups
      .filter(g => sheetPatternFilter === 'all' || String(g.pattern_id) === String(sheetPatternFilter))
      .map(g => g.id));
    document.getElementById('printGroupCheckboxes').innerHTML = groups.map(g => `
      <label class="print-group-row">
        <input type="checkbox" value="${g.id}" ${currentlyShown.has(g.id) ? 'checked' : ''}>
        <span>${escapeHtml(g.name)}</span>
      </label>`).join('');
    document.getElementById('printSelectModal').classList.add('open');
  });
  document.getElementById('printSelectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#printGroupCheckboxes input[type=checkbox]').forEach(cb => cb.checked = true);
  });
  document.getElementById('printSelectNoneBtn').addEventListener('click', () => {
    document.querySelectorAll('#printGroupCheckboxes input[type=checkbox]').forEach(cb => cb.checked = false);
  });
  document.getElementById('printSelectCancelBtn').addEventListener('click', () => {
    document.getElementById('printSelectModal').classList.remove('open');
  });
  document.getElementById('printSelectForm').addEventListener('submit', e => {
    e.preventDefault();
    const selected = Array.from(document.querySelectorAll('#printGroupCheckboxes input[type=checkbox]:checked')).map(cb => Number(cb.value));
    if (selected.length === 0) { alert('Tick at least one duty group to print.'); return; }
    document.getElementById('printSelectModal').classList.remove('open');
    printGroupSelection = new Set(selected);
    renderCalendar();
    const restore = () => {
      printGroupSelection = null;
      renderCalendar();
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    document.getElementById('dynamicPageSize').textContent =
      Number(document.getElementById('numWeeks').value) > 1
        ? '@page{ size: A3 landscape; margin: 10mm; }'
        : '@page{ size: A3 portrait; margin: 10mm; }';
    setTimeout(() => window.print(), 50); // let the selective render paint first
  });
}

// Wires the Duty Sheet's "Export to Excel" button (the OPTIONAL Excel
// Import/Export module - see services/excelIO.js).
function wireDutySheetExcelExport(){
  document.getElementById('exportDutySheetExcelBtn').addEventListener('click', exportDutySheetToExcel);
}

/* ---------------------------------------------------------------
   MANUAL CELL OVERRIDES (Duty Sheet) - mark an individual day for a
   slot as a custom duty code, e.g. "covering something else that day",
   in green (own round), blue (another round) or purple (covering).
   Takes priority over both the rotation pattern and bank holidays.
   --------------------------------------------------------------- */
let editingOverride = null; // {slotId, dateISO}

let pendingOvertimeEntries = [];

function onCalCellClick(e){
  const td = e.currentTarget;
  const modalEl = document.querySelector('#cellOverrideModal .modal');
  const dateISO = td.dataset.date;
  const d = parseISO(dateISO);

  if (td.dataset.sharedPerson2 === '1') {
    // The second half of a shared duty doesn't have its own slot identity to
    // store a manual override against (the slot record is the first
    // person's) - so this is suggestion-only: show who's skilled and
    // available, with no colour/label/overtime editing offered here. The
    // shared slot's own duty_id is still what needs covering, so keep it
    // set here for the suggestion-pick handler to look up.
    editingOverride = {slotId: Number(td.dataset.slotId), dateISO};
    modalEl.classList.add('person2-mode');
    document.getElementById('cellOverrideContext').textContent =
      td.dataset.role + ' - ' + (td.dataset.empName || '(unassigned)') + ' - ' + fmtShort(d);
    const suggestedSection = document.getElementById('suggestedCoverSection');
    const suggestedBtns = document.getElementById('suggestedCoverButtons');
    const suggestedRaw = td.dataset.suggestedCovers;
    if (suggestedRaw) {
      const candidates = suggestedRaw.split('|').map(s => { const [id, name] = s.split(':'); return {id, name}; });
      suggestedBtns.innerHTML = candidates.map(c =>
        `<button type="button" class="btn btn-sm" data-cover-employee-id="${c.id}" data-cover-employee-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`).join('');
      const alreadyWorking = isEmployeeWorkingOn(Number(candidates[0].id), dateISO);
      document.getElementById('suggestedCoverLabel').textContent = alreadyWorking
        ? "Already working today and trained for this - click a name to mark them as covering it too:"
        : "Trained for this but not in today - click a name to mark them as coming in to cover:";
      suggestedSection.style.display = '';
    } else {
      suggestedSection.style.display = 'none';
      suggestedBtns.innerHTML = '';
    }
    document.getElementById('cellOverrideModal').classList.add('open');
    return;
  }
  modalEl.classList.remove('person2-mode');

  const slotId = Number(td.dataset.slotId);
  editingOverride = {slotId, dateISO};

  const existing = q("SELECT * FROM cell_overrides WHERE slot_id=? AND date_iso=?", [slotId, dateISO])[0];
  const slot = q("SELECT * FROM duty_group_slots WHERE id=?", [slotId])[0];
  const emp = slot && slot.employee_id ? q("SELECT * FROM employees WHERE id=?", [slot.employee_id])[0] : null;
  const empName = emp ? emp.name : '(unassigned slot)';

  document.getElementById('cellOverrideContext').textContent =
    td.dataset.role + ' - ' + empName + ' - ' + fmtShort(d);
  document.querySelector(`input[name="overrideKind"][value="${existing ? existing.kind : 'WORK'}"]`).checked = true;
  document.getElementById('overrideLabelInput').value = existing ? existing.label : '';

  // Offer a quick-pick of duties this specific person is actually skilled
  // for, so a manual entry can be made from their real skills matrix
  // rather than typing a code from memory - picking one just fills in
  // the label above, which stays freely editable either way.
  const dutyPick = document.getElementById('overrideDutyPick');
  if (emp) {
    const skilled = q(`SELECT d.code, d.name, s.score FROM employee_skills s JOIN duties d ON d.id=s.duty_id
      WHERE s.employee_id=? AND s.score>0 ORDER BY s.score DESC, d.name COLLATE NOCASE`, [emp.id]);
    dutyPick.innerHTML = '<option value="">&ndash; choose a duty they\'re skilled for &ndash;</option>' +
      skilled.map(d => `<option value="${escapeHtml(d.code || d.name)}">${escapeHtml(d.code || d.name)} (score ${d.score}/10)</option>`).join('');
    dutyPick.disabled = skilled.length === 0;
    document.getElementById('overrideDutyPickLabel').style.display = skilled.length === 0 ? 'none' : '';
    dutyPick.style.display = skilled.length === 0 ? 'none' : '';
  } else {
    dutyPick.innerHTML = '';
    dutyPick.disabled = true;
    document.getElementById('overrideDutyPickLabel').style.display = 'none';
    dutyPick.style.display = 'none';
  }
  dutyPick.value = '';

  const suggestedSection = document.getElementById('suggestedCoverSection');
  const suggestedBtns = document.getElementById('suggestedCoverButtons');
  const suggestedRaw = td.dataset.suggestedCovers;
  if (suggestedRaw && !existing) {
    const candidates = suggestedRaw.split('|').map(s => { const [id, name] = s.split(':'); return {id, name}; });
    suggestedBtns.innerHTML = candidates.map(c =>
      `<button type="button" class="btn btn-sm" data-cover-employee-id="${c.id}" data-cover-employee-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`).join('');
    const alreadyWorking = isEmployeeWorkingOn(Number(candidates[0].id), dateISO);
    document.getElementById('suggestedCoverLabel').textContent = alreadyWorking
      ? "Already working today and trained for this - click a name to mark them as covering it too:"
      : "Trained for this but not in today - click a name to mark them as coming in to cover:";
    suggestedSection.style.display = '';
  } else {
    suggestedSection.style.display = 'none';
    suggestedBtns.innerHTML = '';
  }

  pendingOvertimeEntries = q("SELECT reason, minutes FROM overtime_entries WHERE slot_id=? AND date_iso=?", [slotId, dateISO]);
  renderOvertimeEntriesList();
  document.getElementById('clearOverrideBtn').style.display = (existing || pendingOvertimeEntries.length) ? '' : 'none';

  // Suggest logging Absence overtime if this looks like their scheduled day off,
  // pre-filled with their normal hours for that weekday where known.
  const hintEl = document.getElementById('overtimeAbsenceHint');
  const weekdayIdx = (d.getUTCDay() + 6) % 7;
  const weekdayKey = DAYS[weekdayIdx];
  let suggestMinutes = null;
  if (slot) {
    const group = q("SELECT * FROM duty_groups WHERE id=?", [slot.duty_group_id])[0];
    const pattern = group ? getPattern(group.pattern_id) : null;
    if (pattern && pattern.weeks[1][slot.role]) {
      const wMon = mondayOf(d);
      const cycleWk = cycleWeekFor(group.anchor_date, toISO(wMon), pattern.cycle_length);
      const originalKind = (pattern.weeks[cycleWk][slot.role] || W(OF,OF,OF,OF,OF,OF))[weekdayKey][0];
      if (originalKind === 'OFF') {
        suggestMinutes = 0; // fallback if hours aren't known
        if (emp && TIME_WEEKDAYS.includes(weekdayKey)) {
          const t = getEmployeeTimesMap(emp.id)[weekdayKey];
          const hrs = t ? computeDailyHours(t.start, t.end) : null;
          if (hrs !== null) suggestMinutes = Math.round(hrs * 60);
        }
      }
    }
  }
  const alreadyHasAbsence = pendingOvertimeEntries.some(en => en.reason === 'ABSENCE');
  if (suggestMinutes !== null && !alreadyHasAbsence) {
    hintEl.style.display = 'flex';
    hintEl.innerHTML = `<span>This looks like their day off${suggestMinutes ? ` (~${formatHours(suggestMinutes/60)})` : ''} - add Absence overtime?</span>
      <button type="button" class="btn btn-sm" id="acceptAbsenceHintBtn">+ Add</button>`;
    document.getElementById('acceptAbsenceHintBtn').addEventListener('click', () => {
      pendingOvertimeEntries.push({reason: 'ABSENCE', minutes: suggestMinutes || 0});
      hintEl.style.display = 'none';
      renderOvertimeEntriesList();
    });
  } else {
    hintEl.style.display = 'none';
  }

  document.getElementById('cellOverrideModal').classList.add('open');
}

function renderOvertimeEntriesList(){
  const listEl = document.getElementById('overtimeEntriesList');
  if (pendingOvertimeEntries.length === 0) {
    listEl.innerHTML = '<p class="empty-hint" style="margin:0 0 4px;">No overtime logged for this day yet.</p>';
    return;
  }
  listEl.innerHTML = pendingOvertimeEntries.map((en, i) => `
    <div class="overtime-entry-row">
      <span class="oe-reason">${escapeHtml(OVERTIME_REASON_LABELS[en.reason] || en.reason)}</span>
      <span class="oe-minutes">${en.minutes} min (${formatHours(en.minutes/60)})</span>
      <button type="button" class="chip-del" data-remove-oe="${i}" title="Remove">&times;</button>
    </div>`).join('');
  listEl.querySelectorAll('[data-remove-oe]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingOvertimeEntries.splice(Number(btn.dataset.removeOe), 1);
      renderOvertimeEntriesList();
    });
  });
}

function wireCellOverrideModal(){
  document.querySelectorAll('[data-mins-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('newOvertimeMinutes').value = btn.dataset.minsPreset;
    });
  });

  document.getElementById('suggestedCoverButtons').addEventListener('click', e => {
    const btn = e.target.closest('[data-cover-employee-id]');
    if (!btn || !editingOverride) return;
    const coverEmployeeId = Number(btn.dataset.coverEmployeeId);
    const coverEmployeeName = btn.dataset.coverEmployeeName;

    const absentSlot = q("SELECT * FROM duty_group_slots WHERE id=?", [editingOverride.slotId])[0];
    const duty = absentSlot && absentSlot.duty_id ? q("SELECT * FROM duties WHERE id=?", [absentSlot.duty_id])[0] : null;
    const dutyLabel = duty ? (duty.code || duty.name) : '';
    if (!dutyLabel) {
      alert("This role doesn't have a duty code set, so there's nothing to write into the cover slot.");
      return;
    }

    // Find where this covering employee actually appears on the sheet (their
    // own primary slot, or their side of a shared duty) so the cover shows
    // up against THEIR name, not the absent person's.
    const coverSlot = q("SELECT * FROM duty_group_slots WHERE employee_id=? OR employee_id_2=? LIMIT 1", [coverEmployeeId, coverEmployeeId])[0];
    if (!coverSlot) {
      alert(`${coverEmployeeName} isn't assigned to a duty anywhere, so there's no row to mark them as covering on.`);
      return;
    }

    run("INSERT INTO cell_overrides (slot_id, date_iso, kind, label) VALUES (?,?,?,?) ON CONFLICT(slot_id, date_iso) DO UPDATE SET kind=excluded.kind, label=excluded.label",
      [coverSlot.id, editingOverride.dateISO, 'COVER', dutyLabel.slice(0, 24)]);
    bumpSkillScoreForOverrideLabel(coverSlot.id, dutyLabel.slice(0, 24));
    saveState();
    document.getElementById('cellOverrideModal').classList.remove('open');
    editingOverride = null;
    renderCalendar();
  });

  document.getElementById('addOvertimeEntryBtn').addEventListener('click', () => {
    const reason = document.getElementById('newOvertimeReason').value;
    const minutesRaw = Number(document.getElementById('newOvertimeMinutes').value);
    if (!Number.isFinite(minutesRaw) || minutesRaw <= 0) { alert('Enter how many minutes for this overtime entry.'); return; }
    const minutes = Math.max(1, Math.min(720, Math.round(minutesRaw)));
    pendingOvertimeEntries.push({reason, minutes});
    document.getElementById('newOvertimeMinutes').value = '';
    document.getElementById('overtimeAbsenceHint').style.display = 'none';
    renderOvertimeEntriesList();
  });

  document.getElementById('overrideDutyPick').addEventListener('change', e => {
    if (e.target.value) document.getElementById('overrideLabelInput').value = e.target.value;
  });
  document.getElementById('cellOverrideForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!editingOverride) return;
    if (document.querySelector('#cellOverrideModal .modal').classList.contains('person2-mode')) return;
    const kind = document.querySelector('input[name="overrideKind"]:checked').value;
    const label = document.getElementById('overrideLabelInput').value.trim().slice(0, 24) || kind;
    run("INSERT INTO cell_overrides (slot_id, date_iso, kind, label) VALUES (?,?,?,?) ON CONFLICT(slot_id, date_iso) DO UPDATE SET kind=excluded.kind, label=excluded.label",
      [editingOverride.slotId, editingOverride.dateISO, kind, label]);
    if (kind === 'COVER') bumpSkillScoreForOverrideLabel(editingOverride.slotId, label);
    run("DELETE FROM overtime_entries WHERE slot_id=? AND date_iso=?", [editingOverride.slotId, editingOverride.dateISO]);
    pendingOvertimeEntries.forEach(en => {
      run("INSERT INTO overtime_entries (slot_id, date_iso, reason, minutes) VALUES (?,?,?,?)",
        [editingOverride.slotId, editingOverride.dateISO, en.reason, en.minutes]);
    });
    editingOverride = null;
    pendingOvertimeEntries = [];
    document.getElementById('cellOverrideModal').classList.remove('open');
    saveState();
    renderCalendar();
    renderOvertimeLog();
  });
  document.getElementById('clearOverrideBtn').addEventListener('click', () => {
    if (!editingOverride) return;
    if (document.querySelector('#cellOverrideModal .modal').classList.contains('person2-mode')) return;
    run("DELETE FROM cell_overrides WHERE slot_id=? AND date_iso=?", [editingOverride.slotId, editingOverride.dateISO]);
    run("DELETE FROM overtime_entries WHERE slot_id=? AND date_iso=?", [editingOverride.slotId, editingOverride.dateISO]);
    editingOverride = null;
    pendingOvertimeEntries = [];
    document.getElementById('cellOverrideModal').classList.remove('open');
    saveState();
    renderCalendar();
    renderOvertimeLog();
  });
  document.getElementById('cancelOverrideBtn').addEventListener('click', () => {
    editingOverride = null;
    pendingOvertimeEntries = [];
    document.getElementById('cellOverrideModal').classList.remove('open');
  });

  document.getElementById('clearAllOverridesBtn').addEventListener('click', () => {
    const count = q("SELECT COUNT(*) AS c FROM cell_overrides")[0].c;
    const otCount = q("SELECT COUNT(*) AS c FROM overtime_entries")[0].c;
    if (count === 0 && otCount === 0) { alert('There are no manual overrides to clear.'); return; }
    if (confirm(`Clear all ${count} manual override(s) and ${otCount} logged overtime entry(ies) on the Duty Sheet? Every cell will revert to its normal rotation (or bank holiday) display. This can't be undone.`)) {
      run("DELETE FROM cell_overrides");
      run("DELETE FROM overtime_entries");
      saveState();
      renderCalendar();
      renderOvertimeLog();
    }
  });
}

/* ---------------------------------------------------------------
   GLOBAL WIRING: employees/duties admin, imports, groups
   --------------------------------------------------------------- */
