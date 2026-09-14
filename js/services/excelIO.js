/* ---------------------------------------------------------------
   EXCEL IMPORT / EXPORT - clean, per-dataset .xlsx import/export
   (employees, duties, skills, annual leave, other absence, bank
   holidays) plus the coloured Duty Sheet export. OPTIONAL: importing
   Royal Mail's own legacy-format Employees/Duties workbook (a
   different, bespoke format) lives in modules/employeesDuties.js and
   is intentionally NOT gated by this module - it's core employee/duty
   setup, not an optional convenience. Everything registered here is
   the generic "download/upload a clean spreadsheet" convenience layer.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'excelImportExport', name: 'Excel Import / Export', core: false,
  hideSelectors: [
    '#exportDutySheetExcelBtn',
    '#exportEmployeesBtn', 'label:has(#importEmployeesInput)',
    '#exportDutiesBtn', 'label:has(#importDutiesInput)',
    '#exportSkillsBtn', 'label:has(#importSkillsInput)',
    '#exportLeaveBtn', 'label:has(#importLeaveInput)',
    '#exportOtherAbsenceBtn', 'label:has(#importOtherAbsenceInput)',
    '#exportHolidaysBtn', 'label:has(#importHolidaysInput)',
  ],
  description: 'Per-dataset .xlsx download/upload (employees, duties, skills matrix, annual leave, sickness/absence, bank holidays) and the coloured Duty Sheet Excel export. The one-off legacy Royal Mail Employees/Duties workbook import stays available regardless, since that is core setup rather than a convenience export.'
});

function downloadXlsx(rows, sheetName, filenamePrefix){
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, {type: 'array', bookType: 'xlsx'});
  const blob = new Blob([out], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filenamePrefix}-${toISO(new Date())}.xlsx`;
  a.click();
}

// Same idea as downloadXlsx but for multiple sheets in one workbook -
// sheets is [{name, rows}, ...]. Excel sheet names are capped at 31
// characters and can't contain \/?*[]: , so names are sanitised and
// de-duplicated (Group Name, Group Name (2), ...) before use.
function downloadMultiSheetXlsx(sheets, filenamePrefix){
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  sheets.forEach(({name, rows}) => {
    let safe = (name || 'Sheet').replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let unique = safe, n = 2;
    while (usedNames.has(unique.toLowerCase())) { const suffix = ` (${n++})`; unique = safe.slice(0, 31 - suffix.length) + suffix; }
    usedNames.add(unique.toLowerCase());
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, unique);
  });
  const out = XLSX.write(wb, {type: 'array', bookType: 'xlsx'});
  const blob = new Blob([out], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filenamePrefix}-${toISO(new Date())}.xlsx`;
  a.click();
}

// Exports the Duty Sheet exactly as it's currently shown on screen - same
// groups, same week range, same pattern filter - by reading the
// already-rendered tables directly rather than recomputing everything
// from the database again, so the export can never drift from the display.
// Matches the on-screen cell colours (style.css --work/--off/etc custom
// properties) so the export looks like the coloured grid people already
// know, not a plain black-and-white table.
const CELL_EXPORT_COLORS = {
  'cell-work': 'C6D9CE', 'cell-satwork': '9DC3E6', 'cell-cover': 'D9C2E9', 'cell-spare': 'FFEE00',
  'cell-off': 'FFD966', 'cell-bh': 'F2A9A0', 'cell-al': 'F6B26B', 'cell-sick': 'E08585',
  'cell-other': 'B5B9C6', 'cell-uncovered': 'D8483A'
};
const THIN_GREY_BORDER = { style: 'thin', color: { argb: 'FFDCDFE3' } };

// Exports the Duty Sheet exactly as it's currently shown on screen - same
// groups, same week range, same pattern filter, same colours - by reading
// the already-rendered tables directly rather than recomputing everything
// from the database again, so the export can never drift from the display.
// Uses ExcelJS (not the bundled SheetJS/xlsx library) because SheetJS's
// free build silently drops any cell fill colour on write - ExcelJS is
// the one library here that actually preserves formatting in the file.
async function exportDutySheetToExcel(){
  const tables = document.querySelectorAll('#calendarContainer table.cal-table');
  if (tables.length === 0) { alert('Nothing to export - no duty groups are currently shown.'); return; }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RM Duty Builder';
  const usedNames = new Set();

  tables.forEach(table => {
    const caption = table.querySelector('caption');
    const rawName = caption ? caption.textContent.trim() : 'Group';
    let safe = rawName.replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Group';
    let unique = safe, n = 2;
    while (usedNames.has(unique.toLowerCase())) { const suffix = ` (${n++})`; unique = safe.slice(0, 31 - suffix.length) + suffix; }
    usedNames.add(unique.toLowerCase());
    const ws = wb.addWorksheet(unique, { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });

    const headRows = table.querySelectorAll('thead tr');
    const weekHeaderRow = headRows[0];
    const dayHeaderRow = headRows[2]; // headRows[1] is the green/red status row - not useful in a spreadsheet

    if (weekHeaderRow) {
      const cells = Array.from(weekHeaderRow.children);
      const wsRow = ws.getRow(1);
      let colIdx = 2;
      cells.slice(1).forEach(th => {
        const span = th.colSpan || 1;
        for (let i = 0; i < span; i++) {
          const c = wsRow.getCell(colIdx + i);
          if (i === 0) c.value = th.textContent.trim();
          c.font = { bold: true };
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
          c.alignment = { horizontal: 'center' };
        }
        if (span > 1) ws.mergeCells(1, colIdx, 1, colIdx + span - 1);
        colIdx += span;
      });
      wsRow.commit();
    }

    if (dayHeaderRow) {
      const cells = Array.from(dayHeaderRow.children);
      const wsRow = ws.getRow(2);
      cells.forEach((th, i) => {
        const c = wsRow.getCell(i + 1);
        c.value = th.textContent.trim();
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC0032' } };
        c.alignment = { horizontal: 'center' };
      });
      wsRow.commit();
    }

    let rowIdx = 3;
    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = Array.from(tr.children);
      if (cells.length === 0) return;
      const labelCell = cells[0];
      const role = labelCell.querySelector('.row-role');
      const emp = labelCell.querySelector('.row-emp');
      const duty = labelCell.querySelector('.row-duty');
      const labelParts = [role ? role.textContent.trim() : '', emp ? emp.textContent.trim() : '', duty ? duty.textContent.trim() : ''].filter(Boolean);
      const wsRow = ws.getRow(rowIdx);
      const labelC = wsRow.getCell(1);
      labelC.value = labelParts.join(' - ');
      labelC.font = { bold: true };
      labelC.border = { top: THIN_GREY_BORDER, bottom: THIN_GREY_BORDER, left: THIN_GREY_BORDER, right: THIN_GREY_BORDER };
      cells.slice(1).forEach((td, i) => {
        const c = wsRow.getCell(i + 2);
        c.value = td.textContent.trim();
        c.alignment = { horizontal: 'center' };
        c.border = { top: THIN_GREY_BORDER, bottom: THIN_GREY_BORDER, left: THIN_GREY_BORDER, right: THIN_GREY_BORDER };
        const cls = Array.from(td.classList).find(cl => CELL_EXPORT_COLORS[cl]);
        if (cls) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + CELL_EXPORT_COLORS[cls] } };
      });
      wsRow.commit();
      rowIdx++;
    });

    ws.getColumn(1).width = 34;
    const dayColCount = dayHeaderRow ? dayHeaderRow.children.length - 1 : 7;
    for (let i = 2; i <= dayColCount + 1; i++) ws.getColumn(i).width = 9;
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `duty-sheet-${toISO(new Date())}.xlsx`;
  a.click();
}

// Finds a header's column index by trying each candidate label (case-
// insensitive) against row 0 of a parsed sheet range. Returns -1 if none found.
function findHeaderCol(ws, range, candidates){
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({r: range.s.r, c})];
    const val = cell && cell.v !== undefined ? String(cell.v).trim().toUpperCase() : '';
    if (candidates.some(cand => cand.toUpperCase() === val)) return c;
  }
  return -1;
}
function cellStr(ws, r, c){
  if (c < 0) return '';
  const cell = ws[XLSX.utils.encode_cell({r, c})];
  return cell && cell.v !== undefined ? String(cell.v).trim() : '';
}

function exportEmployees(){
  const employees = q("SELECT name FROM employees ORDER BY name COLLATE NOCASE");
  downloadXlsx([['Name'], ...employees.map(e => [e.name])], 'Employees', 'employees');
}
function exportDuties(){
  const duties = q("SELECT code, name, group_label, duty_type FROM duties ORDER BY group_label, name COLLATE NOCASE");
  downloadXlsx([['Code','Name','Group','Type'], ...duties.map(d => [d.code, d.name, d.group_label, d.duty_type === 'CORE' ? 'Core' : 'Cover'])], 'Duties', 'duties');
}
function exportSkills(){
  const rows = q(`SELECT e.name AS emp, d.name AS duty, s.score AS score FROM employee_skills s
    JOIN employees e ON e.id=s.employee_id JOIN duties d ON d.id=s.duty_id
    ORDER BY e.name COLLATE NOCASE, d.name COLLATE NOCASE`);
  downloadXlsx([['Employee','Duty','Score'], ...rows.map(r => [r.emp, r.duty, r.score])], 'Skills', 'skills-matrix');
}
function exportAnnualLeave(){
  const rows = q(`SELECT e.name AS emp, a.week_date AS wk FROM annual_leave a
    JOIN employees e ON e.id=a.employee_id ORDER BY e.name COLLATE NOCASE, a.week_date`);
  downloadXlsx([['Employee','Week Commencing'], ...rows.map(r => [r.emp, r.wk])], 'Annual Leave', 'annual-leave');
}
function exportOtherAbsence(){
  const rows = q(`SELECT e.name AS emp, o.start_date AS sd, o.end_date AS ed, o.type AS t, o.note AS n FROM other_absences o
    JOIN employees e ON e.id=o.employee_id ORDER BY e.name COLLATE NOCASE, o.start_date`);
  downloadXlsx([['Employee','Start Date','End Date','Type','Note'],
    ...rows.map(r => [r.emp, r.sd, r.ed || '', r.t === 'SICK' ? 'Sickness' : 'Other', r.n])], 'Absence', 'sickness-other-absence');
}
function exportBankHolidays(){
  const rows = q("SELECT date, name FROM bank_holidays ORDER BY date");
  downloadXlsx([['Date','Name'], ...rows.map(r => [r.date, r.name])], 'Bank Holidays', 'bank-holidays');
}

// Reads a date cell that might be a real Excel date (arrives as a JS Date
// when the workbook is opened with cellDates:true) or plain text in a
// common format, so pasted/typed dates still work, not just formatted ones.
function parseDateCellFlexible(ws, r, c){
  const cell = ws[XLSX.utils.encode_cell({r, c})];
  if (!cell || cell.v === undefined) return null;
  if (cell.v instanceof Date && !isNaN(cell.v.getTime())) return toISO(cell.v);
  const s = String(cell.v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

async function importSkillsFromFile(file){
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array'});
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws['!ref']) { alert('That file has no data in it.'); return; }
  const range = XLSX.utils.decode_range(ws['!ref']);
  const empCol = findHeaderCol(ws, range, ['Employee','Name']);
  const dutyCol = findHeaderCol(ws, range, ['Duty','Round']);
  const scoreCol = findHeaderCol(ws, range, ['Score']); // absent in older exports - falls back to the schema default
  if (empCol === -1 || dutyCol === -1) { alert('Could not find "Employee" and "Duty" column headers in this file.'); return; }
  const empByName = new Map(q("SELECT id, name FROM employees").map(e => [e.name.toLowerCase(), e.id]));
  const dutyByName = new Map(q("SELECT id, name FROM duties").map(d => [d.name.toLowerCase(), d.id]));
  let imported = 0; const unmatched = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const empName = cellStr(ws, r, empCol), dutyName = cellStr(ws, r, dutyCol);
    if (!empName || !dutyName) continue;
    const empId = empByName.get(empName.toLowerCase()), dutyId = dutyByName.get(dutyName.toLowerCase());
    if (!empId || !dutyId) { unmatched.push(`${empName} / ${dutyName}`); continue; }
    if (scoreCol !== -1) {
      let score = Math.round(Number(cellStr(ws, r, scoreCol)));
      if (isNaN(score) || score < 0) score = 0;
      if (score > 10) score = 10;
      run("INSERT INTO employee_skills (employee_id, duty_id, score) VALUES (?,?,?) ON CONFLICT(employee_id, duty_id) DO UPDATE SET score=excluded.score", [empId, dutyId, score]);
    } else {
      run("INSERT OR IGNORE INTO employee_skills (employee_id, duty_id) VALUES (?,?)", [empId, dutyId]);
    }
    imported++;
  }
  saveState(); renderSkillsEmployeeList();
  alert(`Imported ${imported} skill(s).` + (unmatched.length ? `\n\n${unmatched.length} row(s) skipped - employee or duty name not found:\n${unmatched.slice(0,10).join('\n')}${unmatched.length > 10 ? '\n...' : ''}` : ''));
}

async function importOtherAbsenceFromFile(file){
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array', cellDates:true});
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws['!ref']) { alert('That file has no data in it.'); return; }
  const range = XLSX.utils.decode_range(ws['!ref']);
  const empCol = findHeaderCol(ws, range, ['Employee','Name']);
  // Accept "Start Date" (our own export) or plain "Date" (older exports /
  // simple one-day-per-row files) as the same thing.
  const startCol = findHeaderCol(ws, range, ['Start Date','Date']);
  const endCol = findHeaderCol(ws, range, ['End Date']);
  const typeCol = findHeaderCol(ws, range, ['Type']);
  const noteCol = findHeaderCol(ws, range, ['Note']);
  if (empCol === -1 || startCol === -1) { alert('Could not find "Employee" and "Start Date"/"Date" column headers in this file.'); return; }
  const empByName = new Map(q("SELECT id, name FROM employees").map(e => [e.name.toLowerCase(), e.id]));
  let imported = 0; const unmatched = [], badDates = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const empName = cellStr(ws, r, empCol);
    if (!empName) continue;
    const empId = empByName.get(empName.toLowerCase());
    if (!empId) { unmatched.push(empName); continue; }
    const startISO = parseDateCellFlexible(ws, r, startCol);
    if (!startISO) { badDates.push(empName); continue; }
    const endISO = endCol !== -1 ? parseDateCellFlexible(ws, r, endCol) : null; // blank/missing = ongoing
    const typeRaw = (typeCol !== -1 ? cellStr(ws, r, typeCol) : '').toUpperCase();
    const type = typeRaw.startsWith('SICK') ? 'SICK' : 'OTHER';
    const note = noteCol !== -1 ? cellStr(ws, r, noteCol) : '';
    run("INSERT INTO other_absences (employee_id, start_date, end_date, type, note) VALUES (?,?,?,?,?)", [empId, startISO, endISO, type, note]);
    imported++;
  }
  saveState(); renderOtherAbsenceEmployeeList(); renderCalendar();
  let msg = `Imported ${imported} absence day(s).`;
  if (unmatched.length) msg += `\n\n${unmatched.length} row(s) skipped - employee name not found: ${unmatched.slice(0,10).join(', ')}${unmatched.length>10?'...':''}`;
  if (badDates.length) msg += `\n\n${badDates.length} row(s) skipped - date not recognised.`;
  alert(msg);
}

async function importBankHolidaysFromFile(file){
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array', cellDates:true});
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws['!ref']) { alert('That file has no data in it.'); return; }
  const range = XLSX.utils.decode_range(ws['!ref']);
  const dateCol = findHeaderCol(ws, range, ['Date']);
  const nameCol = findHeaderCol(ws, range, ['Name','Holiday']);
  if (dateCol === -1) { alert('Could not find a "Date" column header in this file.'); return; }
  let imported = 0, skipped = 0;
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const dateISO = parseDateCellFlexible(ws, r, dateCol);
    if (!dateISO) continue;
    const name = nameCol !== -1 ? cellStr(ws, r, nameCol) : 'Bank Holiday';
    const existed = q("SELECT 1 FROM bank_holidays WHERE date=?", [dateISO]).length > 0;
    if (existed) { skipped++; continue; }
    run("INSERT INTO bank_holidays (date, name) VALUES (?,?)", [dateISO, name || 'Bank Holiday']);
    imported++;
  }
  saveState(); renderHolidaysList(); renderCalendar();
  alert(`Imported ${imported} bank holiday(s). ${skipped} date(s) already existed and were skipped.`);
}

