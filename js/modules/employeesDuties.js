/* ---------------------------------------------------------------
   EMPLOYEES & DUTIES - the sidebar lists on the Duty Builder page:
   add/rename/delete employees and duties, the CORE/COVER duty-type
   toggle, and the legacy Royal-Mail-format Excel import for each. CORE
   - this is foundational data every other module depends on.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'employeesDuties', name: 'Employees & Duties', core: true,
  description: 'The Employees and Duties sidebar lists on the Duty Builder page - foundational data every other module depends on.'
});

function assignedEmployeeIds(){
  const ids = new Set();
  q("SELECT employee_id, employee_id_2 FROM duty_group_slots").forEach(r => {
    if (r.employee_id) ids.add(r.employee_id);
    if (r.employee_id_2) ids.add(r.employee_id_2);
  });
  return ids;
}
function assignedDutyIds(){ return new Set(q("SELECT duty_id FROM duty_group_slots WHERE duty_id IS NOT NULL").map(r=>r.duty_id)); }

function renderSidebarEmployees(){
  const container = document.getElementById('employeeList');
  const search = (document.getElementById('employeeSearch').value || '').toLowerCase();
  const employees = q("SELECT * FROM employees ORDER BY name COLLATE NOCASE");
  const assigned = assignedEmployeeIds();
  container.innerHTML = '';
  employees.filter(e => e.name.toLowerCase().includes(search)).forEach(emp => {
    container.appendChild(makeChip('employee', emp.id, emp.name, '', assigned.has(emp.id), 'sidebar'));
  });
  document.getElementById('employeeCount').textContent = employees.length + ' total, ' + assigned.size + ' allocated';
}

function renderSidebarDuties(){
  const container = document.getElementById('dutyList');
  const search = (document.getElementById('dutySearch').value || '').toLowerCase();
  const duties = q("SELECT * FROM duties ORDER BY group_label, name COLLATE NOCASE");
  const assigned = assignedDutyIds();
  container.innerHTML = '';
  duties.filter(d => (d.name+' '+d.code+' '+d.group_label).toLowerCase().includes(search)).forEach(d => {
    const sub = [d.group_label, d.code].filter(Boolean).join(' \u00b7 ');
    const chip = makeChip('duty', d.id, d.name, sub, assigned.has(d.id), 'sidebar');
    const typeBadge = document.createElement('button');
    typeBadge.type = 'button';
    typeBadge.className = 'duty-type-badge duty-type-' + d.duty_type.toLowerCase();
    typeBadge.title = 'Core duties are real rounds that always need covering. Cover duties (DOC/WOC/Leave Cover style) exist to cover others and never need cover themselves. Click to switch.';
    typeBadge.textContent = d.duty_type === 'CORE' ? 'Core' : 'Cover';
    typeBadge.dataset.toggleDutyType = d.id;
    chip.insertBefore(typeBadge, chip.querySelector('.chip-del'));
    container.appendChild(chip);
  });
  document.getElementById('dutyCount').textContent = duties.length + ' total, ' + assigned.size + ' allocated';
}

function makeChip(kind, id, title, sub, isAssigned, source, extra){
  const chip = document.createElement('div');
  const isDuplicateEmployee = kind === 'employee' && source === 'slot' && duplicateEmployeeMap.has(id);
  chip.className = 'chip chip-' + kind + (isAssigned ? ' chip-assigned' : '') + (isDuplicateEmployee ? ' chip-duplicate' : '');
  chip.draggable = true;
  chip.dataset.kind = kind;
  chip.dataset.id = id;
  chip.dataset.source = source;
  if (extra && extra.slotId) chip.dataset.slotId = extra.slotId;
  if (extra && extra.field) chip.dataset.field = extra.field;
  let dupBadge = '';
  if (isDuplicateEmployee) {
    const others = duplicateEmployeeMap.get(id).filter(a => a.slotId !== (extra && extra.slotId));
    const otherText = others.map(a => `${a.role} (${a.groupName})`).join(', ');
    dupBadge = `<span class="chip-dup-badge" title="Also allocated to: ${escapeHtml(otherText)}">&#9888;</span>`;
  }
  chip.innerHTML = `<span class="chip-text"><span class="chip-title">${escapeHtml(title)}</span>${sub ? `<span class="chip-sub">${escapeHtml(sub)}</span>` : ''}</span>
    ${dupBadge}
    <button class="chip-del" title="Delete" data-del-${kind}="${id}">&times;</button>`;
  chip.addEventListener('dragstart', onDragStart);
  chip.addEventListener('dragend', onDragEnd);
  return chip;
}

function wireEmployeesDuties(){
  document.getElementById('employeeSearch').addEventListener('input', renderSidebarEmployees);
  document.getElementById('dutySearch').addEventListener('input', renderSidebarDuties);

  document.getElementById('addEmployeeForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('newEmployeeName');
    const name = input.value.trim();
    if (!name) return;
    run("INSERT INTO employees (name) VALUES (?)", [name]);
    input.value = '';
    saveState(); renderSidebarEmployees(); renderCalendar(); renderLeaveEmployeeList(); renderTimesEmployeeList(); renderOtherAbsenceEmployeeList(); renderSkillsEmployeeList();
  });

  document.getElementById('addDutyForm').addEventListener('submit', e => {
    e.preventDefault();
    const codeInput = document.getElementById('newDutyCode');
    const nameInput = document.getElementById('newDutyName');
    const typeInput = document.getElementById('newDutyType');
    const name = nameInput.value.trim();
    if (!name) return;
    run("INSERT INTO duties (code, name, duty_type) VALUES (?,?,?)", [codeInput.value.trim(), name, typeInput.value]);
    codeInput.value = ''; nameInput.value = ''; typeInput.value = 'CORE';
    saveState(); renderSidebarDuties(); renderCalendar(); renderSkillsEmployeeList();
  });

  document.addEventListener('click', e => {
    if (e.target.matches('[data-toggle-duty-type]')) {
      const id = Number(e.target.dataset.toggleDutyType);
      const duty = q("SELECT * FROM duties WHERE id=?", [id])[0];
      run("UPDATE duties SET duty_type=? WHERE id=?", [duty.duty_type === 'CORE' ? 'COVER' : 'CORE', id]);
      saveState(); renderSidebarDuties(); renderCalendar();
      return;
    }
    if (e.target.matches('[data-del-employee]')) {
      const id = Number(e.target.dataset.delEmployee);
      if (confirm('Delete this employee? They will be removed from any slot, and any recorded annual leave, absences, daily times or skills too.')) {
        run("UPDATE duty_group_slots SET employee_id=NULL WHERE employee_id=?", [id]);
        run("UPDATE duty_group_slots SET employee_id_2=NULL WHERE employee_id_2=?", [id]);
        run("DELETE FROM annual_leave WHERE employee_id=?", [id]);
        run("DELETE FROM other_absences WHERE employee_id=?", [id]);
        run("DELETE FROM employee_skills WHERE employee_id=?", [id]);
        run("DELETE FROM employee_times WHERE employee_id=?", [id]);
        run("DELETE FROM employees WHERE id=?", [id]);
        saveState(); renderSidebarEmployees(); renderDutyGroups(); renderCalendar(); renderLeaveEmployeeList(); renderTimesEmployeeList(); renderOvertimeLog(); renderSkillsEmployeeList(); renderOtherAbsenceEmployeeList();
      }
    }
    if (e.target.matches('[data-del-duty]')) {
      const id = Number(e.target.dataset.delDuty);
      if (confirm('Delete this duty? It will be removed from any slot and any skills matrix entries too.')) {
        run("UPDATE duty_group_slots SET duty_id=NULL WHERE duty_id=?", [id]);
        run("DELETE FROM employee_skills WHERE duty_id=?", [id]);
        run("DELETE FROM duties WHERE id=?", [id]);
        saveState(); renderSidebarDuties(); renderDutyGroups(); renderCalendar(); renderSkillsEmployeeList();
      }
    }
  });

  document.getElementById('exportEmployeesBtn').addEventListener('click', exportEmployees);
  document.getElementById('exportDutiesBtn').addEventListener('click', exportDuties);

  document.getElementById('importEmployeesInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheetName = wb.SheetNames.includes('Duty Builder') ? 'Duty Builder' : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref']);
    // Our own clean export uses a "Name" header; the legacy Royal Mail
    // sheet has no usable header and always puts names in column F.
    const cleanNameCol = findHeaderCol(ws, range, ['Name']);
    const nameColIdx = cleanNameCol !== -1 ? cleanNameCol : 5;
    const startRow = cleanNameCol !== -1 ? range.s.r + 1 : range.s.r;
    let imported = 0, skipped = 0;
    const existing = new Set(q("SELECT name FROM employees").map(r => r.name.toLowerCase()));
    for (let r = startRow; r <= range.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({r, c: nameColIdx})];
      const name = cell && cell.v !== undefined ? String(cell.v).trim() : '';
      if (!name || name.toUpperCase() === 'NAME') continue;
      if (existing.has(name.toLowerCase())) { skipped++; continue; }
      run("INSERT INTO employees (name) VALUES (?)", [name]);
      existing.add(name.toLowerCase());
      imported++;
    }
    saveState(); renderSidebarEmployees(); renderCalendar(); renderLeaveEmployeeList(); renderTimesEmployeeList(); renderOtherAbsenceEmployeeList(); renderSkillsEmployeeList();
    alert(`Imported ${imported} employee(s) from "${sheetName}". ${skipped} already existed and were skipped.`);
    e.target.value = '';
  });

  document.getElementById('importDutiesInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheetName = wb.SheetNames.includes('Duty Builder') ? 'Duty Builder' : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref']);
    // Our own clean export uses "Code"/"Name"/"Group" headers; the legacy
    // Royal Mail sheet has no usable header and fixed column positions.
    const cleanNameCol = findHeaderCol(ws, range, ['Name']);
    const isClean = cleanNameCol !== -1;
    const linkColIdx = isClean ? findHeaderCol(ws, range, ['Group']) : 2;
    const codeColIdx = isClean ? findHeaderCol(ws, range, ['Code']) : 3;
    const nameColIdx = isClean ? cleanNameCol : 4;
    const typeColIdx = isClean ? findHeaderCol(ws, range, ['Type']) : -1;
    const startRow = isClean ? range.s.r + 1 : range.s.r;
    let imported = 0, skipped = 0;
    const existing = new Set(q("SELECT name||'|'||group_label AS k FROM duties").map(r => r.k));
    for (let r = startRow; r <= range.e.r; r++) {
      const link = cellStr(ws, r, linkColIdx);
      const code = cellStr(ws, r, codeColIdx);
      const name = cellStr(ws, r, nameColIdx);
      if (!name) continue;
      // Robust header-row detection: skip if this looks like a header row
      // (works whether the sheet uses the Royal Mail convention of "DUTY"
      // for both code/name columns, or plainer labels like "NAME"/"CODE").
      const looksLikeHeader = ['DUTY','NAME','CODE'].includes(name.toUpperCase())
        || link.toUpperCase() === 'LINK' || code.toUpperCase() === 'CODE';
      if (looksLikeHeader) continue;
      const key = name + '|' + link;
      if (existing.has(key)) { skipped++; continue; }
      const dutyType = (typeColIdx !== -1 && cellStr(ws, r, typeColIdx).toUpperCase().startsWith('COVER')) ? 'COVER' : 'CORE';
      run("INSERT INTO duties (code, name, group_label, duty_type) VALUES (?,?,?,?)", [code, name, link, dutyType]);
      existing.add(key);
      imported++;
    }
    saveState(); renderSidebarDuties(); renderCalendar(); renderSkillsEmployeeList();
    alert(`Imported ${imported} duty/round(s) from "${sheetName}". ${skipped} already existed and were skipped.`);
    e.target.value = '';
  });

  wireSidebarDropTargets();
}

// Rebuilds one duty group's slots to match its pattern's current roles,
// preserving whatever was assigned to a role that still exists (matched by
// name) and dropping anything tied to a role that's since been removed.
