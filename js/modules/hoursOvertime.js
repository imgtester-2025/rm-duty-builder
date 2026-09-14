/* ---------------------------------------------------------------
   HOURS & OVERTIME - each employee's optional Mon-Sat start/end time,
   and the overtime log computed live from manual cell overrides vs
   each pattern's own OFF day for that role/weekday. OPTIONAL.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'hoursOvertime', name: 'Hours & Overtime', core: false,
  hideSelectors: ['.nav-tab[data-page="pageHours"]'],
  description: "Each employee's daily start/finish times and the automatically-detected overtime log (worked a scheduled day off, or an agreed early start / late finish)."
});

function parseTimeToMinutes(hhmm){
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
function computeDailyHours(start, end){
  const s = parseTimeToMinutes(start), e = parseTimeToMinutes(end);
  if (s === null || e === null || e <= s) return null;
  return (e - s) / 60;
}
function formatHours(h){
  if (h === null || h === undefined || isNaN(h)) return '\u2013';
  return (Math.round(h * 100) / 100).toString().replace(/\.00$/, '') + 'h';
}
// Pattern start_times are stored like "7:48-16:03" (no leading zero) - pad
// to HH:MM so they work directly in <input type="time">.
function parsePatternTimeRange(rangeStr){
  if (!rangeStr || rangeStr.indexOf('-') === -1) return null;
  const [a, b] = rangeStr.split('-');
  const pad = t => t.trim().split(':').map((p,i) => i===0 ? p.padStart(2,'0') : p).join(':');
  return {start: pad(a), end: pad(b)};
}

function getEmployeeTimesMap(employeeId){
  const rows = q("SELECT * FROM employee_times WHERE employee_id=?", [employeeId]);
  const map = {};
  rows.forEach(r => { map[r.weekday] = {start: r.start_time, end: r.end_time}; });
  return map;
}

function renderTimesEmployeeList(){
  if (!ModuleRegistry.isEnabled('hoursOvertime')) return;
  const container = document.getElementById('timesEmployeeList');
  if (!container) return;
  const search = (document.getElementById('timesEmployeeSearch').value || '').toLowerCase();
  const employees = q("SELECT * FROM employees ORDER BY name COLLATE NOCASE").filter(e => e.name.toLowerCase().includes(search));
  container.innerHTML = employees.map(emp => {
    const times = getEmployeeTimesMap(emp.id);
    let weeklyTotal = 0, anySet = false;
    const rows = TIME_WEEKDAYS.map(wd => {
      const t = times[wd] || {start:'', end:''};
      const hrs = computeDailyHours(t.start, t.end);
      if (hrs !== null) { weeklyTotal += hrs; anySet = true; }
      return `<tr>
        <td>${TIME_WEEKDAY_LABELS[wd]}</td>
        <td><input type="time" data-time-emp="${emp.id}" data-time-day="${wd}" data-time-field="start" value="${t.start||''}"></td>
        <td><input type="time" data-time-emp="${emp.id}" data-time-day="${wd}" data-time-field="end" value="${t.end||''}"></td>
        <td class="hours-cell">${formatHours(hrs)}</td>
      </tr>`;
    }).join('');
    return `<div class="leave-emp-row" data-emp-id="${emp.id}">
      <div class="leave-emp-head">
        <span class="leave-emp-name">${escapeHtml(emp.name)}</span>
        <span class="leave-count-badge ${anySet ? 'has-leave' : ''}">${anySet ? formatHours(weeklyTotal) + '/wk' : 'not set'}</span>
        <button class="btn btn-sm" data-toggle-times="${emp.id}">Edit times</button>
        <button class="btn btn-sm" data-copy-pattern-times="${emp.id}">Copy from rotation</button>
      </div>
      <div class="times-grid" id="timesGrid_${emp.id}">
        <table class="times-table">
          <thead><tr><th>Day</th><th>Start</th><th>End</th><th>Hours</th></tr></thead>
          <tbody>${rows}
            <tr class="times-total-row"><td colspan="3">Weekly total</td><td class="hours-cell">${formatHours(anySet ? weeklyTotal : null)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

// Returns the number of weekday time-pairs applied (0 if the employee has
// no duty-group assignment or their pattern has no start times recorded).
function applyPatternTimesToEmployee(empId){
  const slot = q("SELECT * FROM duty_group_slots WHERE employee_id=? LIMIT 1", [empId])[0];
  if (!slot) return 0;
  const group = q("SELECT * FROM duty_groups WHERE id=?", [slot.duty_group_id])[0];
  if (!group) return 0;
  const pattern = getPattern(group.pattern_id);
  if (!pattern) return 0;
  let applied = 0;
  TIME_WEEKDAYS.forEach(wd => {
    const range = parsePatternTimeRange(pattern.start_times[wd]);
    if (!range) return;
    run("INSERT INTO employee_times (employee_id, weekday, start_time, end_time) VALUES (?,?,?,?) ON CONFLICT(employee_id, weekday) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time",
      [empId, wd, range.start, range.end]);
    applied++;
  });
  return applied;
}

function wireHoursPage(){
  document.querySelectorAll('.hours-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hours-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.hours-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(btn.dataset.hourspane).classList.add('active');
      if (btn.dataset.hourspane === 'paneOvertime') renderOvertimeLog();
    });
  });

  document.getElementById('timesEmployeeSearch').addEventListener('input', renderTimesEmployeeList);

  document.getElementById('overtimeWeekFilter').addEventListener('change', e => {
    overtimeWeekFilter = e.target.value;
    renderOvertimeLog();
  });

  document.getElementById('setAllFromRotationBtn').addEventListener('click', () => {
    const employees = q("SELECT id FROM employees");
    let updated = 0, skipped = 0;
    employees.forEach(e => {
      if (applyPatternTimesToEmployee(e.id) > 0) updated++; else skipped++;
    });
    saveState();
    renderTimesEmployeeList();
    renderOvertimeLog();
    alert(`Set daily times from their rotation for ${updated} employee(s). ${skipped} were skipped (not yet assigned to a duty group, or their pattern has no start times recorded).`);
  });

  document.addEventListener('click', e => {
    if (e.target.matches('[data-toggle-times]')) {
      document.getElementById('timesGrid_' + e.target.dataset.toggleTimes).classList.toggle('open');
    }
    if (e.target.matches('[data-copy-pattern-times]')) {
      const empId = Number(e.target.dataset.copyPatternTimes);
      const applied = applyPatternTimesToEmployee(empId);
      if (applied === 0) { alert('This employee is not yet assigned to a duty group (or their pattern has no start/finish times recorded), so there is nothing to copy.'); return; }
      saveState();
      renderTimesEmployeeList();
      renderOvertimeLog();
      document.getElementById('timesGrid_' + empId).classList.add('open');
    }
  });

  document.addEventListener('change', e => {
    if (e.target.matches('[data-time-emp]')) {
      const empId = Number(e.target.dataset.timeEmp);
      const day = e.target.dataset.timeDay;
      const field = e.target.dataset.timeField;
      const existing = getEmployeeTimesMap(empId)[day] || {start:'', end:''};
      const updated = {...existing, [field]: e.target.value};
      if (updated.start || updated.end) {
        run("INSERT INTO employee_times (employee_id, weekday, start_time, end_time) VALUES (?,?,?,?) ON CONFLICT(employee_id, weekday) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time",
          [empId, day, updated.start || '', updated.end || '']);
      } else {
        run("DELETE FROM employee_times WHERE employee_id=? AND weekday=?", [empId, day]);
      }
      saveState();
      renderTimesEmployeeList();
      document.getElementById('timesGrid_' + empId).classList.add('open');
      renderOvertimeLog();
    }
  });
}

/* ---------------------------------------------------------------
   OVERTIME LOG - computed live from cell_overrides vs each pattern's
   own OFF day for that role/weekday, using the employee's daily times.
   --------------------------------------------------------------- */
function computeOvertimeLog(){
  const entries = q("SELECT * FROM overtime_entries");
  const byEmployee = new Map(); // employeeId -> {name, entries:[], totalHours, unsetCount}

  entries.forEach(ov => {
    const slot = q("SELECT * FROM duty_group_slots WHERE id=?", [ov.slot_id])[0];
    if (!slot || !slot.employee_id) return;
    const group = q("SELECT * FROM duty_groups WHERE id=?", [slot.duty_group_id])[0];
    const emp = q("SELECT * FROM employees WHERE id=?", [slot.employee_id])[0];
    if (!emp) return;

    const d = parseISO(ov.date_iso);
    const weekdayIdx = (d.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
    const weekdayKey = DAYS[weekdayIdx];

    // Only "Absence overtime" shows the employee's normal start/finish for
    // reference (it represents a whole day worked); pressure overtime is a
    // short extension, not a full shift, so start/finish isn't meaningful there.
    let startTime = null, endTime = null;
    if (ov.reason === 'ABSENCE' && TIME_WEEKDAYS.includes(weekdayKey)) {
      const t = getEmployeeTimesMap(emp.id)[weekdayKey];
      if (t) { startTime = t.start || null; endTime = t.end || null; }
    }

    const overrideRow = q("SELECT label FROM cell_overrides WHERE slot_id=? AND date_iso=?", [ov.slot_id, ov.date_iso])[0];
    const hours = ov.minutes / 60;

    if (!byEmployee.has(emp.id)) byEmployee.set(emp.id, {name: emp.name, entries: [], totalHours: 0, unsetCount: 0});
    const bucket = byEmployee.get(emp.id);
    bucket.entries.push({
      dateISO: ov.date_iso, weekday: weekdayKey, weekNum: fiscalWeekNumber(ov.date_iso),
      hours, startTime, endTime, label: overrideRow ? overrideRow.label : '',
      groupName: group ? group.name : '(deleted group)',
      reason: OVERTIME_REASON_LABELS[ov.reason] || ov.reason,
      dayOffWorked: ov.reason === 'ABSENCE'
    });
    bucket.totalHours += hours;
  });

  byEmployee.forEach(b => b.entries.sort((a,b2) => a.dateISO.localeCompare(b2.dateISO)));
  return byEmployee;
}

let overtimeWeekFilter = 'all';

function populateOvertimeWeekFilter(byEmployee){
  const sel = document.getElementById('overtimeWeekFilter');
  if (!sel) return;
  const weeks = new Set();
  byEmployee.forEach(b => b.entries.forEach(e => weeks.add(e.weekNum)));
  const sortedWeeks = [...weeks].sort((a,b) => a - b);
  const prevValue = sel.value || overtimeWeekFilter;
  sel.innerHTML = '<option value="all">All weeks</option>' +
    sortedWeeks.map(w => `<option value="${w}">Week ${w}</option>`).join('');
  // keep the current selection if it's still a valid option, else fall back to "all"
  if (prevValue !== 'all' && sortedWeeks.includes(Number(prevValue))) {
    sel.value = prevValue;
    overtimeWeekFilter = prevValue;
  } else {
    sel.value = 'all';
    overtimeWeekFilter = 'all';
  }
}

// Shared row markup for both the per-employee grouped view and the
// single-week flat view, so the two stay in sync.
function overtimeRowCellsHtml(e, includeEmployee, empName){
  const startFinish = e.dayOffWorked && e.startTime && e.endTime
    ? escapeHtml(e.startTime) + ' \u2013 ' + escapeHtml(e.endTime)
    : (e.dayOffWorked ? '<span class="unfilled">set daily times</span>' : '<span class="unfilled">&ndash;</span>');
  return `${includeEmployee ? `<td>${escapeHtml(empName)}</td>` : ''}
        <td>Week ${e.weekNum}</td>
        <td>${escapeHtml(fmtShort(parseISO(e.dateISO)))} (${TIME_WEEKDAY_LABELS[e.weekday]})</td>
        <td>${escapeHtml(e.groupName)}</td>
        <td>${escapeHtml(e.label)}</td>
        <td>${escapeHtml(e.reason)}</td>
        <td>${startFinish}</td>
        <td>${e.hours !== null ? formatHours(e.hours) : '<span class="unfilled">&ndash;</span>'}</td>`;
}

function renderOvertimeLog(){
  if (!ModuleRegistry.isEnabled('hoursOvertime')) return;
  const summaryEl = document.getElementById('overtimeSummary');
  const listEl = document.getElementById('overtimeList');
  if (!summaryEl || !listEl) return;
  const byEmployee = computeOvertimeLog();
  populateOvertimeWeekFilter(byEmployee);

  if (byEmployee.size === 0) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = '<p class="empty-hint">No overtime detected - it appears automatically once a manual entry shows someone working on their scheduled day off.</p>';
    return;
  }

  if (overtimeWeekFilter !== 'all') {
    renderOvertimeWeekView(byEmployee, Number(overtimeWeekFilter));
    return;
  }

  let grandTotal = 0, grandUnset = 0;
  byEmployee.forEach(b => { grandTotal += b.totalHours; grandUnset += b.unsetCount; });
  summaryEl.innerHTML = `<div class="leave-auto-summary">${byEmployee.size} employee(s) with overtime, ${formatHours(grandTotal)} total${grandUnset ? ` (plus ${grandUnset} instance(s) where daily times aren't set yet, so hours couldn't be calculated)` : ''}.</div>`;

  const sorted = [...byEmployee.entries()].sort((a,b) => b[1].totalHours - a[1].totalHours);
  listEl.innerHTML = sorted.map(([empId, b]) => {
    const rows = b.entries.map(e => `<tr>${overtimeRowCellsHtml(e, false)}</tr>`).join('');
    return `<div class="overtime-emp-row" data-emp-id="${empId}">
      <div class="leave-emp-head">
        <span class="leave-emp-name">${escapeHtml(b.name)}</span>
        <span class="overtime-hours-badge">${formatHours(b.totalHours)} owed &middot; ${b.entries.length} instance${b.entries.length===1?'':'s'}</span>
        <button class="btn btn-sm" data-toggle-overtime="${empId}">Show/hide</button>
      </div>
      <div class="overtime-list-inner" id="overtimeInner_${empId}">
        <table class="overtime-table">
          <thead><tr><th>Week</th><th>Date</th><th>Group</th><th>Duty code</th><th>Reason</th><th>Start &ndash; Finish</th><th>Hours</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('[data-toggle-overtime]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('overtimeInner_' + btn.dataset.toggleOvertime).classList.toggle('open');
    });
  });
}

// Flat, cross-employee view for a single selected week - everyone who
// worked a day off that week, in one table, for a quick weekly review.
function renderOvertimeWeekView(byEmployee, weekNum){
  const summaryEl = document.getElementById('overtimeSummary');
  const listEl = document.getElementById('overtimeList');

  const rows = [];
  byEmployee.forEach(b => {
    b.entries.filter(e => e.weekNum === weekNum).forEach(e => rows.push({...e, empName: b.name}));
  });
  rows.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.empName.localeCompare(b.empName));

  const weekTotal = rows.reduce((s, r) => s + (r.hours || 0), 0);
  const unsetCount = rows.filter(r => r.hours === null).length;

  if (rows.length === 0) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = `<p class="empty-hint">No overtime recorded for Week ${weekNum}.</p>`;
    return;
  }

  summaryEl.innerHTML = `<div class="leave-auto-summary">Week ${weekNum}: ${rows.length} instance${rows.length===1?'':'s'} across ${new Set(rows.map(r=>r.empName)).size} employee(s), ${formatHours(weekTotal)} total${unsetCount ? ` (plus ${unsetCount} instance(s) where daily times aren't set yet)` : ''}.</div>`;

  const tableRows = rows.map(e => `<tr>${overtimeRowCellsHtml(e, true, e.empName)}</tr>`).join('');

  listEl.innerHTML = `<table class="overtime-table">
    <thead><tr><th>Employee</th><th>Week</th><th>Date</th><th>Group</th><th>Duty code</th><th>Reason</th><th>Start &ndash; Finish</th><th>Hours</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;
}

