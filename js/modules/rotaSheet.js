/* ---------------------------------------------------------------
   ROTA SHEET - a single-week, spreadsheet-style staff grid (one row
   per person, one column per day, fully colour-coded, matching the
   look of the office's original Excel rota) plus a plain-language
   uncovered list with cover suggestions underneath. Built on the same
   shared day-status computation the Duty Sheet grid uses. OPTIONAL.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'rotaSheet', name: 'Rota Sheet', core: false,
  hideSelectors: ['.nav-tab[data-page="pageRotaSheet"]'],
  description: 'A single-week, spreadsheet-style staff grid plus a plain-language uncovered list with cover suggestions, matching the look of a traditional Excel rota.'
});

function buildRotaWeekGrid(weekMondayISO, groupFilter){
  const startMon = parseISO(weekMondayISO);
  const dates = DAYS.map((_, i) => toISO(addDays(startMon, i)));
  const dayStatuses = dates.map(d => getAllSlotStatusesForDate(d));
  const coreDutyIds = new Set(q("SELECT id FROM duties WHERE duty_type='CORE'").map(r => r.id));

  // One row per real person (a shared duty's two people are two separate
  // people, so two separate rows) - unassigned slots have no name to show
  // here and appear only in the Uncovered list below. Grouped by duty
  // group (matching the group's own sort order) but with no group label
  // printed, just a thin gap between groups.
  const groups = q("SELECT * FROM duty_groups ORDER BY pinned DESC, sort_order, id")
    .filter(g => groupIsInUse(g.id))
    .filter(g => !groupFilter || groupFilter.has(g.id));
  const dayAutoCover = dates.map(d => computeAutoCoverAssignments(d).assignments);
  const rowsHtml = [];
  groups.forEach((g, gi) => {
    const slots = q("SELECT * FROM duty_group_slots WHERE duty_group_id=? ORDER BY slot_order", [g.id]);
    const groupPattern = getPattern(g.pattern_id);
    const blockSize = groupPattern ? groupPattern.block_size : 1;
    const peopleInGroup = new Map(); // "slotId|employeeId" -> {empName, dutyLabel, blockIndex}
    slots.forEach(slot => {
      const duty = slot.duty_id ? q("SELECT * FROM duties WHERE id=?", [slot.duty_id])[0] : null;
      const dutyLabel = duty ? (duty.code || duty.name) : '';
      const blockIndex = blockIndexFor(slot.slot_order, blockSize);
      [slot.employee_id, slot.shared_enabled ? slot.employee_id_2 : null].forEach(empId => {
        if (!empId) return;
        const key = slot.id + '|' + empId;
        if (!peopleInGroup.has(key)) {
          const emp = q("SELECT * FROM employees WHERE id=?", [empId])[0];
          if (emp) peopleInGroup.set(key, { empName: emp.name, dutyLabel, blockIndex });
        }
      });
    });
    // Same order as the Duty Sheet (slot order), not alphabetical - the
    // Map above was already built by iterating slots in that order.
    const sortedPeople = [...peopleInGroup.entries()];
    if (gi > 0 && sortedPeople.length) rowsHtml.push('<tr class="rota-group-gap"><td colspan="9"></td></tr>');
    sortedPeople.forEach(([key, { empName, dutyLabel, blockIndex }], pi) => {
      if (pi > 0 && blockIndex !== sortedPeople[pi - 1][1].blockIndex) {
        rowsHtml.push('<tr class="rota-block-gap"><td colspan="9"></td></tr>');
      }
      const empId = Number(key.split('|')[1]);
      const cells = dayStatuses.map((statuses, di) => {
        const s = statuses.find(x => x.employeeId === empId);
        if (!s) return '<td class="cal-cell cell-off"></td>';
        let label = s.label;
        let title = '';
        let cellClass = 'cell-' + s.kind.toLowerCase();
        const autoCover = ['WORK','SATWORK','COVER','SPARE'].includes(s.kind) ? dayAutoCover[di].get(empId) : null;
        const hasCoreDuty = s.dutyId && coreDutyIds.has(s.dutyId);
        if (s.isOverride) {
          // A manual override's own label is trusted as-is - it may
          // describe something quite different from their home duty
          // (e.g. covering a specific other round that day), so it must
          // never be silently replaced by their usual duty code or by
          // the auto-cover engine's own guess.
        } else if (autoCover) {
          label = autoCover.dutyLabel;
          const reasonPhrase = { OFF: 'day off', AL: 'Annual Leave', SICK: 'sickness', OTHER: 'absence', UNCOVERED: 'shift' }[autoCover.reason] || 'absence';
          title = autoCover.coveredEmpName ? `Covering ${autoCover.coveredEmpName}'s ${reasonPhrase}` : `Covering a ${reasonPhrase}`;
          cellClass += ' rota-auto-cover';
        } else if (s.kind === 'SATWORK') {
          // Saturdays are a separate, reduced duty - Tracked parcels and
          // 1st class only, not the full core round - carrying their own
          // A/B/C style labelling from the pattern rather than a duty
          // code, so the weekday core duty must never be substituted in.
        } else if (['WORK','COVER'].includes(s.kind)) {
          if (hasCoreDuty) {
            const duty = q("SELECT * FROM duties WHERE id=?", [s.dutyId])[0];
            label = duty.code || duty.name;
          } else {
            // Working, but no core duty and nobody needed covering today -
            // a genuinely blank day, flagged the same way a day off is.
            label = '';
            cellClass = 'rota-no-job';
            title = 'No core duty assigned or needed today';
          }
        }
        return `<td class="cal-cell ${cellClass}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</td>`;
      }).join('');
      rowsHtml.push(`<tr><td class="rota-grid-name">${escapeHtml(empName)}</td><td class="rota-grid-duty">${escapeHtml(dutyLabel)}</td>${cells}</tr>`);
    });
  });

  const coreGapsByDay = dates.map(d => computeCoreDutyGapsForDate(d, groupFilter));
  const statusButtons = dates.map((d, i) => {
    const gaps = coreGapsByDay[i];
    if (gaps.length === 0) {
      return `<th class="rota-day-status-cell"><span class="rota-day-status rota-day-status-ok" title="All core duties covered">&#10003;</span></th>`;
    }
    return `<th class="rota-day-status-cell"><button type="button" class="rota-day-status rota-day-status-bad" data-core-gaps-date="${d}" title="Click to see what's uncovered">${gaps.length}</button></th>`;
  }).join('');
  const dayHeaders = dates.map(d => `<th>${escapeHtml(DAY_LABELS[DAYS[dates.indexOf(d)]])} ${escapeHtml(fmtShort(parseISO(d)))}</th>`).join('');

  return `<table class="rota-grid-table">
    <thead>
      <tr><th></th><th></th>${statusButtons}</tr>
      <tr><th>Employee</th><th>Duty</th>${dayHeaders}</tr>
    </thead>
    <tbody>${rowsHtml.join('') || '<tr><td colspan="9" class="rota-empty-note">No one assigned anywhere yet.</td></tr>'}</tbody>
  </table>`;
}

function buildRotaUncoveredSection(weekMondayISO, groupFilter){
  const startMon = parseISO(weekMondayISO);
  const dates = DAYS.map((_, i) => toISO(addDays(startMon, i)));
  const items = [];
  dates.forEach(dateISO => {
    const statuses = getAllSlotStatusesForDate(dateISO);
    statuses.filter(s => ['UNCOVERED','AL','SICK','OTHER'].includes(s.kind) && (!groupFilter || groupFilter.has(s.groupId))).forEach(s => {
      const emp = s.employeeId ? q("SELECT * FROM employees WHERE id=?", [s.employeeId])[0] : null;
      const suggestions = findSkilledAvailableCovers(s.dutyId, dateISO, s.employeeId);
      const alreadyWorking = suggestions.length > 0 && isEmployeeWorkingOn(suggestions[0].id, dateISO, statuses);
      items.push({
        dateISO, role: s.role, groupName: s.groupName, reason: REASON_LABEL[s.kind],
        empName: emp ? emp.name : null, note: s.note,
        suggestions: suggestions.map(sg => sg.name), tier: suggestions.length === 0 ? 'none' : (alreadyWorking ? 'working' : 'callin')
      });
    });
  });
  if (items.length === 0) return '<p class="rota-empty-note">Nothing uncovered this week.</p>';
  return items.map(it => {
    const whoLine = it.empName ? `${escapeHtml(it.empName)} is away (${escapeHtml(it.reason)}${it.note ? ': ' + escapeHtml(it.note) : ''})` : escapeHtml(it.reason);
    let suggestionHtml;
    if (it.tier === 'none') {
      suggestionHtml = `<div class="rota-suggestion tier-none">No one trained and available found.</div>`;
    } else {
      const verb = it.tier === 'working' ? 'Already working that day - ask' : 'Not in that day - would need calling in:';
      suggestionHtml = `<div class="rota-suggestion tier-${it.tier}">${verb} ${escapeHtml(it.suggestions.join(', '))}</div>`;
    }
    return `<div class="rota-uncovered-item">
      <span class="rota-role">${escapeHtml(fmtShort(parseISO(it.dateISO)))} \u2013 ${escapeHtml(it.role)}</span><span class="rota-reason">${escapeHtml(it.groupName)}</span>
      <div>${whoLine}</div>
      ${suggestionHtml}
    </div>`;
  }).join('');
}

function renderRotaSheet(){
  if (!ModuleRegistry.isEnabled('rotaSheet')) return;
  const dateInput = document.getElementById('rotaSheetDate');
  if (!dateInput.value) dateInput.value = toISO(new Date());
  const weekMon = toISO(mondayOf(parseISO(dateInput.value)));
  document.getElementById('rotaSheetContent').innerHTML = `
    ${buildRotaWeekGrid(weekMon)}
    <h3 style="margin-top:22px;">Needs cover this week</h3>
    <div class="rota-uncovered-list">${buildRotaUncoveredSection(weekMon)}</div>`;
}

function wireRotaSheetPage(){
  const dateInput = document.getElementById('rotaSheetDate');
  dateInput.value = toISO(new Date());
  dateInput.addEventListener('change', renderRotaSheet);
  document.getElementById('rotaSheetTodayBtn').addEventListener('click', () => {
    dateInput.value = toISO(new Date());
    renderRotaSheet();
  });
  document.getElementById('rotaSheetPrintDayBtn').addEventListener('click', () => {
    const dateInput = document.getElementById('rotaSheetDate');
    const weekMon = toISO(mondayOf(parseISO(dateInput.value)));
    const groups = q("SELECT * FROM duty_groups ORDER BY pinned DESC, sort_order, id").filter(g => groupIsInUse(g.id));
    if (groups.length === 0) { alert('No duty groups with anyone assigned yet - nothing to print.'); return; }
    document.getElementById('rotaPrintGroupCheckboxes').innerHTML = groups.map(g => `
      <label class="print-group-row">
        <input type="checkbox" value="${g.id}" checked>
        <span>${escapeHtml(g.name)}</span>
      </label>`).join('');
    document.getElementById('rotaPrintSelectModal').classList.add('open');
  });
  document.getElementById('rotaPrintSelectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#rotaPrintGroupCheckboxes input[type=checkbox]').forEach(cb => cb.checked = true);
  });
  document.getElementById('rotaPrintSelectNoneBtn').addEventListener('click', () => {
    document.querySelectorAll('#rotaPrintGroupCheckboxes input[type=checkbox]').forEach(cb => cb.checked = false);
  });
  document.getElementById('rotaPrintSelectCancelBtn').addEventListener('click', () => {
    document.getElementById('rotaPrintSelectModal').classList.remove('open');
  });
  document.getElementById('rotaPrintSelectForm').addEventListener('submit', e => {
    e.preventDefault();
    const selected = Array.from(document.querySelectorAll('#rotaPrintGroupCheckboxes input[type=checkbox]:checked')).map(cb => Number(cb.value));
    if (selected.length === 0) { alert('Tick at least one duty group to print.'); return; }
    const includeUncovered = document.getElementById('rotaPrintIncludeUncovered').checked;
    document.getElementById('rotaPrintSelectModal').classList.remove('open');

    const dateInput = document.getElementById('rotaSheetDate');
    const weekMon = toISO(mondayOf(parseISO(dateInput.value)));
    const groupFilter = new Set(selected);
    const content = document.getElementById('rotaSheetContent');
    const normalHtml = content.innerHTML;
    content.innerHTML = `
      ${buildRotaWeekGrid(weekMon, groupFilter)}
      ${includeUncovered ? `<h3 style="margin-top:22px;">Needs cover this week</h3><div class="rota-uncovered-list">${buildRotaUncoveredSection(weekMon, groupFilter)}</div>` : ''}`;

    document.getElementById('dynamicPageSize').textContent = '@page{ size: A3 portrait; margin: 10mm; }';
    const restore = () => {
      content.innerHTML = normalHtml;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    setTimeout(() => window.print(), 50);
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-core-gaps-date]');
    if (!btn) return;
    const dateISO = btn.dataset.coreGapsDate;
    const groupFilter = btn.dataset.coreGapsGroup ? new Set([Number(btn.dataset.coreGapsGroup)]) : null;
    const gaps = computeCoreDutyGapsForDate(dateISO, groupFilter);
    document.getElementById('coreGapsModalTitle').textContent =
      'Uncovered core duties \u2013 ' + fmtShort(parseISO(dateISO));
    document.getElementById('coreGapsModalContent').innerHTML = gaps.length
      ? `<ul class="core-gaps-list">${gaps.map(g => `<li>
          <strong>${escapeHtml(g.dutyLabel)}</strong> <span class="rota-reason">${escapeHtml(g.groupName)} \u00b7 ${escapeHtml(g.role)}</span>
          <div>${g.empName ? escapeHtml(g.empName) + ' \u2013 ' : ''}${escapeHtml(g.reason)}</div>
        </li>`).join('')}</ul>`
      : '<p class="rota-empty-note">All core duties covered.</p>';
    document.getElementById('coreGapsModal').classList.add('open');
  });
  document.getElementById('coreGapsModalCloseBtn').addEventListener('click', () => {
    document.getElementById('coreGapsModal').classList.remove('open');
  });
}

