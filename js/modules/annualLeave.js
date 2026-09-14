/* ---------------------------------------------------------------
   ANNUAL LEAVE - weekly leave booking, plus a fuzzy name-matching
   import of a Royal Mail "Annual Leave Plan" workbook. OPTIONAL.
   --------------------------------------------------------------- */
// NOTE: "Annual Leave" and "Sickness/Other Absence" are two sub-tabs of
// the SAME nav page/tab (pageAnnualLeave), not separate top-level pages -
// see modules/absence.js. Each module hides only its own sub-tab/pane;
// the shared parent nav tab is hidden only if both are off (handled by
// syncAnnualLeaveNavVisibility() in absence.js).
ModuleRegistry.register({
  id: 'annualLeave', name: 'Annual Leave', core: false,
  hideSelectors: ['.absence-tab[data-absencepane="paneAL"]', '#paneAL'],
  description: 'Weekly annual-leave booking per employee, plus a fuzzy-match Excel import of a Royal Mail-style Annual Leave Plan workbook.'
});

function normalizeNameForMatch(s){
  return String(s).toLowerCase().trim().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}
function levenshteinDistance(a, b){
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + cost);
    }
    prev = cur;
  }
  return prev[lb];
}
function tokenSubsetScore(a, b){
  const ta = new Set(a.split(' ').filter(t => t.length > 1));
  const tb = new Set(b.split(' ').filter(t => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  const isSubset = (x, y) => [...x].every(v => y.has(v));
  return (isSubset(ta, tb) || isSubset(tb, ta)) ? 0.93 : 0;
}
function nameSimilarity(rawA, rawB){
  const a = normalizeNameForMatch(rawA), b = normalizeNameForMatch(rawB);
  if (a === b) return 1.0;
  const lev = 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length, 1);
  const tok = tokenSubsetScore(a, b);
  return Math.max(lev, tok);
}

/* ---------------------------------------------------------------
   ANNUAL LEAVE - parsing the Annual Leave Plan workbook
   A sheet is treated as a "rota" sheet (containing real bookings) if
   cell A2 starts with "ROTA" - matches the Royal Mail template's own
   convention, and generalises to future/renamed rota sheets.
   Column B always holds the booked employee for that week; the
   "WEEK OFF" sheet is the one exception that also uses column C for
   a second concurrent leave-taker (confirmed against real data - all
   other sheets' column C/D are annotations, not names).
   --------------------------------------------------------------- */
function parseLeaveWorkbook(wb){
  const candidates = []; // {rawName, dateISO, sourceLabel}
  wb.SheetNames.forEach(sheetName => {
    const ws = wb.Sheets[sheetName];
    if (!ws['!ref']) return;
    const range = XLSX.utils.decode_range(ws['!ref']);

    // Our own clean export format: "Employee" / "Week Commencing" headers.
    const empCol = findHeaderCol(ws, range, ['Employee','Name']);
    const wkCol = findHeaderCol(ws, range, ['Week Commencing','Week','Date']);
    if (empCol !== -1 && wkCol !== -1) {
      for (let r = range.s.r + 1; r <= range.e.r; r++) {
        const rawName = cellStr(ws, r, empCol);
        const dateISO = parseDateCellFlexible(ws, r, wkCol);
        if (!rawName || !dateISO) continue;
        candidates.push({rawName, dateISO: toISO(mondayOf(parseISO(dateISO))), sourceLabel: sheetName});
      }
      return;
    }

    // Royal Mail rota-sheet format: A2 starts "ROTA", dates down column A.
    const a2 = ws['A2'] ? ws['A2'].v : null;
    if (!(typeof a2 === 'string' && a2.trim().toUpperCase().startsWith('ROTA'))) return;
    const nameCols = sheetName.trim().toUpperCase() === 'WEEK OFF' ? [1, 2] : [1];
    for (let r = range.s.r + 3; r <= range.e.r; r++) {
      const dateCell = ws[XLSX.utils.encode_cell({r, c: 0})];
      if (!dateCell) continue;
      // Workbook is read with cellDates:true, so real date cells arrive as JS Date objects.
      const jsDate = dateCell.v instanceof Date ? dateCell.v : null;
      if (!jsDate || isNaN(jsDate.getTime())) continue;
      const dateISO = toISO(mondayOf(jsDate));
      nameCols.forEach(c => {
        const cell = ws[XLSX.utils.encode_cell({r, c})];
        const v = cell && cell.v !== undefined ? String(cell.v).trim() : '';
        if (v.length > 2) candidates.push({rawName: v, dateISO, sourceLabel: sheetName});
      });
    }
  });
  return candidates;
}

function buildLeaveMatchReport(candidates, employees){
  const byName = new Map();
  candidates.forEach(c => {
    if (!byName.has(c.rawName)) byName.set(c.rawName, []);
    byName.get(c.rawName).push(c);
  });
  const auto = [], confirm = [], unmatched = [];
  byName.forEach((weeks, rawName) => {
    const scored = employees
      .map(e => ({emp: e, score: nameSimilarity(rawName, e.name)}))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    const tiedTop = scored.filter(s => Math.abs(s.score - top.score) < 1e-9);
    if (top.score >= 0.92 && tiedTop.length === 1) {
      auto.push({rawName, weeks, employee: top.emp});
    } else if (top.score >= 0.55) {
      confirm.push({rawName, weeks, candidates: scored.slice(0, 3)});
    } else {
      unmatched.push({rawName, weeks});
    }
  });
  return {auto, confirm, unmatched};
}

let pendingLeaveImport = null;

function renderLeaveImportReview(report){
  pendingLeaveImport = report;
  const body = document.getElementById('leaveImportBody');
  const allEmployees = q("SELECT * FROM employees ORDER BY name COLLATE NOCASE");
  let html = '';

  const totalWeeks = c => c.weeks.length;

  html += `<div class="leave-import-section-title">Matched automatically (${report.auto.length} name${report.auto.length===1?'':'s'})</div>`;
  if (report.auto.length === 0) {
    html += `<p class="empty-hint">None.</p>`;
  } else {
    const totalAutoWeeks = report.auto.reduce((s,a) => s + totalWeeks(a), 0);
    html += `<div class="leave-auto-summary">${report.auto.length} name(s), ${totalAutoWeeks} leave week(s) total, will be imported automatically - exact match to an existing employee.</div>`;
  }

  html += `<div class="leave-import-section-title">Needs your confirmation (${report.confirm.length})</div>`;
  if (report.confirm.length === 0) {
    html += `<p class="empty-hint">None.</p>`;
  } else {
    report.confirm.forEach((c, i) => {
      const opts = [];
      const topScore = c.candidates[0].score;
      c.candidates.forEach((cand, ci) => {
        // Only pre-select the top suggestion when reasonably confident (>=75%).
        // Below that, default to "Skip" so a quick commit can't silently
        // misattribute someone's leave to the wrong person.
        const preselect = ci === 0 && topScore >= 0.75;
        const confidence = cand.score >= 0.75 ? 'strong' : (cand.score >= 0.6 ? 'possible' : 'weak');
        opts.push(`<option value="${cand.emp.id}" ${preselect ? 'selected' : ''}>${escapeHtml(cand.emp.name)} (${Math.round(cand.score*100)}% match - ${confidence})</option>`);
      });
      opts.push(`<option value="" ${topScore < 0.75 ? 'selected' : ''}>-- Skip / do not import --</option>`);
      opts.push(`<option disabled>&mdash;&mdash; or choose any employee &mdash;&mdash;</option>`);
      allEmployees.forEach(e => opts.push(`<option value="${e.id}">${escapeHtml(e.name)}</option>`));
      html += `<div class="leave-confirm-row" data-confirm-index="${i}" data-group="confirm">
        <span class="leave-confirm-source"><span class="src-name">"${escapeHtml(c.rawName)}"</span>
          <span class="src-meta">${totalWeeks(c)} week(s) &middot; from ${escapeHtml([...new Set(c.weeks.map(w=>w.sourceLabel))].join(', '))}</span></span>
        <select data-confirm-select="${i}">${opts.join('')}</select>
      </div>`;
    });
  }

  html += `<div class="leave-import-section-title">Not matched (${report.unmatched.length})</div>`;
  if (report.unmatched.length === 0) {
    html += `<p class="empty-hint">None.</p>`;
  } else {
    report.unmatched.forEach((c, i) => {
      const opts = [`<option value="">-- Skip / do not import --</option>`];
      allEmployees.forEach(e => opts.push(`<option value="${e.id}">${escapeHtml(e.name)}</option>`));
      html += `<div class="leave-confirm-row" data-unmatched-index="${i}" data-group="unmatched">
        <span class="leave-confirm-source"><span class="src-name">"${escapeHtml(c.rawName)}"</span>
          <span class="src-meta">${totalWeeks(c)} week(s) &middot; from ${escapeHtml([...new Set(c.weeks.map(w=>w.sourceLabel))].join(', '))} &middot; no employee matched this name</span></span>
        <select data-unmatched-select="${i}">${opts.join('')}</select>
      </div>`;
    });
  }

  body.innerHTML = html;
  document.getElementById('leaveImportPanel').classList.add('open');
}

function commitLeaveImport(){
  if (!pendingLeaveImport) return;
  let imported = 0, skippedDupe = 0;
  const insertGroup = (entries, employeeIdFor) => {
    entries.forEach((c, i) => {
      const empId = employeeIdFor(c, i);
      if (!empId) return;
      c.weeks.forEach(w => {
        run("INSERT OR IGNORE INTO annual_leave (employee_id, week_date, source_label) VALUES (?,?,?)", [empId, w.dateISO, w.sourceLabel]);
        if (db.getRowsModified() > 0) imported++; else skippedDupe++;
      });
    });
  };
  insertGroup(pendingLeaveImport.auto, c => c.employee.id);
  document.querySelectorAll('[data-confirm-select]').forEach(sel => {
    const i = Number(sel.dataset.confirmSelect);
    const c = pendingLeaveImport.confirm[i];
    const empId = sel.value ? Number(sel.value) : null;
    if (empId) c.weeks.forEach(w => {
      run("INSERT OR IGNORE INTO annual_leave (employee_id, week_date, source_label) VALUES (?,?,?)", [empId, w.dateISO, w.sourceLabel]);
      if (db.getRowsModified() > 0) imported++; else skippedDupe++;
    });
  });
  document.querySelectorAll('[data-unmatched-select]').forEach(sel => {
    const i = Number(sel.dataset.unmatchedSelect);
    const c = pendingLeaveImport.unmatched[i];
    const empId = sel.value ? Number(sel.value) : null;
    if (empId) c.weeks.forEach(w => {
      run("INSERT OR IGNORE INTO annual_leave (employee_id, week_date, source_label) VALUES (?,?,?)", [empId, w.dateISO, w.sourceLabel]);
      if (db.getRowsModified() > 0) imported++; else skippedDupe++;
    });
  });
  pendingLeaveImport = null;
  document.getElementById('leaveImportPanel').classList.remove('open');
  saveState();
  renderLeaveEmployeeList();
  renderCalendar();
  alert(`Imported ${imported} leave week(s). ${skippedDupe} were already recorded and skipped.`);
}

/* ---------------------------------------------------------------
   ANNUAL LEAVE - employee list display
   --------------------------------------------------------------- */
function renderLeaveEmployeeList(){
  if (!ModuleRegistry.isEnabled('annualLeave')) return;
  const container = document.getElementById('leaveEmployeeList');
  if (!container) return;
  const search = (document.getElementById('leaveEmployeeSearch').value || '').toLowerCase();
  const employees = q("SELECT * FROM employees ORDER BY name COLLATE NOCASE").filter(e => e.name.toLowerCase().includes(search));
  container.innerHTML = employees.map(emp => {
    const weeks = q("SELECT * FROM annual_leave WHERE employee_id=? ORDER BY week_date", [emp.id]);
    const weekChips = weeks.map(w => {
      const d = parseISO(w.week_date);
      const display = 'W/C ' + fmtShort(d);
      return `<span class="leave-week-chip">${escapeHtml(display)}${w.source_label ? ' <span style="color:#999;">('+escapeHtml(w.source_label)+')</span>' : ''}
        <button class="chip-del" data-del-leave="${w.id}" title="Remove">&times;</button></span>`;
    }).join('');
    return `<div class="leave-emp-row" data-emp-id="${emp.id}">
      <div class="leave-emp-head">
        <span class="leave-emp-name">${escapeHtml(emp.name)}</span>
        <span class="leave-count-badge ${weeks.length ? 'has-leave' : ''}">${weeks.length} week${weeks.length===1?'':'s'}</span>
        <button class="btn btn-sm" data-toggle-leave="${emp.id}">${weeks.length ? 'Show/hide weeks' : 'Add first week'}</button>
        <button class="btn btn-sm" data-show-add-leave="${emp.id}">+ Add week</button>
        ${weeks.length ? `<button class="btn btn-sm btn-danger" data-clear-emp-leave="${emp.id}">Clear all</button>` : ''}
      </div>
      <div class="leave-add-inline" id="leaveAddInline_${emp.id}">
        <input type="date" id="leaveAddDate_${emp.id}">
        <input type="text" id="leaveAddSource_${emp.id}" placeholder="Note (optional)" style="width:140px;">
        <button class="btn btn-primary btn-sm" data-confirm-add-leave="${emp.id}">Add</button>
        <button class="btn btn-sm" data-cancel-add-leave="${emp.id}">Cancel</button>
      </div>
      <div class="leave-weeks-list" id="leaveWeeksList_${emp.id}">${weekChips || '<span class="empty-hint">No leave weeks recorded.</span>'}</div>
    </div>`;
  }).join('');
}

function wireAnnualLeavePage(){
  document.getElementById('leaveEmployeeSearch').addEventListener('input', renderLeaveEmployeeList);
  document.getElementById('exportLeaveBtn').addEventListener('click', exportAnnualLeave);

  document.getElementById('importLeaveInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const candidates = parseLeaveWorkbook(wb);
    if (candidates.length === 0) {
      alert('No annual-leave rota sheets were recognised in this file (looking for sheets whose cell A2 starts with "ROTA").');
      e.target.value = '';
      return;
    }
    const employees = q("SELECT * FROM employees ORDER BY name COLLATE NOCASE");
    const report = buildLeaveMatchReport(candidates, employees);
    renderLeaveImportReview(report);
    e.target.value = '';
  });

  document.getElementById('closeLeaveImportBtn').addEventListener('click', () => {
    pendingLeaveImport = null;
    document.getElementById('leaveImportPanel').classList.remove('open');
  });
  document.getElementById('commitLeaveImportBtn').addEventListener('click', commitLeaveImport);

  document.addEventListener('click', e => {
    if (e.target.matches('[data-toggle-leave]')) {
      const id = e.target.dataset.toggleLeave;
      document.getElementById('leaveWeeksList_' + id).classList.toggle('open');
    }
    if (e.target.matches('[data-show-add-leave]')) {
      const id = e.target.dataset.showAddLeave;
      document.getElementById('leaveAddInline_' + id).classList.add('open');
    }
    if (e.target.matches('[data-cancel-add-leave]')) {
      const id = e.target.dataset.cancelAddLeave;
      document.getElementById('leaveAddInline_' + id).classList.remove('open');
    }
    if (e.target.matches('[data-confirm-add-leave]')) {
      const id = Number(e.target.dataset.confirmAddLeave);
      const dateVal = document.getElementById('leaveAddDate_' + id).value;
      const sourceVal = document.getElementById('leaveAddSource_' + id).value.trim();
      if (!dateVal) return;
      const weekISO = toISO(mondayOf(parseISO(dateVal)));
      run("INSERT OR IGNORE INTO annual_leave (employee_id, week_date, source_label) VALUES (?,?,?)", [id, weekISO, sourceVal]);
      saveState();
      renderLeaveEmployeeList();
      renderCalendar();
      document.getElementById('leaveWeeksList_' + id).classList.add('open');
    }
    if (e.target.matches('[data-del-leave]')) {
      const id = Number(e.target.dataset.delLeave);
      run("DELETE FROM annual_leave WHERE id=?", [id]);
      saveState();
      renderLeaveEmployeeList();
      renderCalendar();
    }
    if (e.target.matches('[data-clear-emp-leave]')) {
      const id = Number(e.target.dataset.clearEmpLeave);
      const emp = q("SELECT name FROM employees WHERE id=?", [id])[0];
      const count = q("SELECT COUNT(*) AS c FROM annual_leave WHERE employee_id=?", [id])[0].c;
      if (confirm(`Clear all ${count} leave week(s) for ${emp.name}?`)) {
        run("DELETE FROM annual_leave WHERE employee_id=?", [id]);
        saveState();
        renderLeaveEmployeeList();
        renderCalendar();
      }
    }
    if (e.target.matches('#clearAllLeaveBtn')) {
      const count = q("SELECT COUNT(*) AS c FROM annual_leave")[0].c;
      if (count === 0) { alert('There is no annual leave recorded yet.'); return; }
      if (confirm(`Clear ALL annual leave for every employee? This will delete ${count} leave week record(s) - useful before re-importing a fresh plan. This can't be undone.`)) {
        run("DELETE FROM annual_leave");
        saveState();
        renderLeaveEmployeeList();
        renderCalendar();
      }
    }
  });
}

/* ---------------------------------------------------------------
   EMPLOYEE DAILY TIMES + AUTO OVERTIME
   Each employee has an optional Mon-Sat start/end time. When a manual
   cell override (see above) shows someone working on a day their
   rotation says should be OFF, that's logged as overtime using their
   configured hours for that weekday.
   --------------------------------------------------------------- */
