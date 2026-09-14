/* ---------------------------------------------------------------
   ROTATION PATTERNS - the built-in and custom weekly/fortnightly
   rotation templates (day-off calendars per role), and the pattern-tab
   bars used to filter both the Duty Builder and Duty Sheet pages by
   pattern. CORE - every duty group and every Duty Sheet cell resolves
   through getPattern().
   --------------------------------------------------------------- */
function getPattern(id){
  const row = q("SELECT * FROM patterns WHERE id=?", [id])[0];
  if (!row) return null;
  const roles = JSON.parse(row.roles_json);
  return {
    id: row.id, name: row.name, built_in: !!row.built_in,
    cycle_length: row.cycle_length,
    roles,
    weeks: JSON.parse(row.weeks_json),
    start_times: JSON.parse(row.start_times_json || '{}'),
    block_size: Math.min(row.block_size || roles.length, roles.length)
  };
}

ModuleRegistry.register({
  id: 'rotationPatterns', name: 'Rotation Patterns', core: true,
  description: 'Built-in and custom rotation pattern templates, and the pattern-tab filters on Duty Builder / Duty Sheet. Every duty group and Duty Sheet cell resolves through this.'
});

function populatePatternSelect(){
  const sel = document.getElementById('newGroupPattern');
  const patterns = q("SELECT * FROM patterns ORDER BY sort_order, id");
  sel.innerHTML = patterns.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

/* ---------------------------------------------------------------
   PATTERN TABS (Duty Builder + Duty Sheet pages) - filter by pattern
   so each rotation can be configured/viewed on its own tab.
   --------------------------------------------------------------- */
let builderPatternFilter = 'all';
let sheetPatternFilter = 'all';

function renderPatternTabBar(containerId, activeValue, onSelect){
  const container = document.getElementById(containerId);
  if (!container) return;
  const patterns = q("SELECT * FROM patterns ORDER BY sort_order, id");
  let html = `<button class="pattern-tab ${activeValue==='all'?'active':''}" data-tabvalue="all">All Groups</button>`;
  patterns.forEach(p => {
    html += `<button class="pattern-tab ${String(activeValue)===String(p.id)?'active':''}" data-tabvalue="${p.id}">${escapeHtml(p.name)}</button>`;
  });
  container.innerHTML = html;
  container.querySelectorAll('.pattern-tab').forEach(btn => {
    btn.addEventListener('click', () => onSelect(btn.dataset.tabvalue));
  });
}
function renderBuilderPatternTabs(){
  renderPatternTabBar('builderPatternTabs', builderPatternFilter, (val) => {
    builderPatternFilter = val;
    renderBuilderPatternTabs();
    renderDutyGroups();
  });
}
function renderSheetPatternTabs(){
  renderPatternTabBar('sheetPatternTabs', sheetPatternFilter, (val) => {
    sheetPatternFilter = val;
    renderSheetPatternTabs();
    renderCalendar();
  });
}

function renderPatternsList(){
  const container = document.getElementById('patternsContainer');
  const patterns = q("SELECT * FROM patterns ORDER BY sort_order, id");
  container.innerHTML = '';
  patterns.forEach(p => container.appendChild(makePatternCard(p)));
}

function makePatternCard(p){
  const roles = JSON.parse(p.roles_json);
  const card = document.createElement('div');
  card.className = 'pattern-card';
  card.innerHTML = `
    <div class="pattern-card-head">
      <div>
        <div class="pattern-card-title">${escapeHtml(p.name)} ${p.built_in ? '<span class="badge-builtin">Built-in</span>' : '<span class="badge-custom">Custom</span>'}</div>
        <div class="pattern-card-sub">${roles.length} roles &middot; ${p.cycle_length}-week cycle</div>
      </div>
      <div class="pattern-card-actions">
        <button class="btn btn-sm" data-rename-pattern="${p.id}">Rename</button>
        <button class="btn btn-sm" data-edit-pattern="${p.id}">${p.built_in ? 'View schedule' : 'Edit schedule'}</button>
        <button class="btn btn-sm" data-dup-pattern="${p.id}">Duplicate</button>
        <button class="btn btn-sm btn-danger" data-del-pattern="${p.id}">Delete</button>
      </div>
    </div>`;
  return card;
}

let editingPatternId = null;

function openPatternEditor(id){
  editingPatternId = id;
  const p = getPattern(id);
  document.getElementById('editorTitle').textContent = (p.built_in ? 'View pattern: ' : 'Edit pattern: ') + p.name;
  document.getElementById('editorNameInput').value = p.name;
  document.getElementById('editorNameInput').disabled = false;
  document.getElementById('editorReadonlyNote').style.display = p.built_in ? 'block' : 'none';
  document.getElementById('blockSizeInput').value = p.block_size;
  document.getElementById('blockSizeInput').max = p.roles.length;
  document.getElementById('blockSizeLabel').style.display = p.built_in ? 'none' : 'flex';
  renderPatternGrid(p);
  document.getElementById('patternEditorPanel').classList.add('open');
}
function closePatternEditor(){
  document.getElementById('patternEditorPanel').classList.remove('open');
  editingPatternId = null;
}

let draggedRoleName = null;
function wireRoleRowDrag(tr, handle, role){
  handle.addEventListener('dragstart', e => {
    draggedRoleName = role;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', role);
    tr.classList.add('role-row-dragging');
  });
  handle.addEventListener('dragend', () => {
    tr.classList.remove('role-row-dragging');
    document.querySelectorAll('#patternGridWrap tr').forEach(r => r.classList.remove('role-drop-above', 'role-drop-below'));
    draggedRoleName = null;
  });
  tr.addEventListener('dragover', e => {
    if (draggedRoleName === null || draggedRoleName === role) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = tr.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    tr.classList.toggle('role-drop-above', before);
    tr.classList.toggle('role-drop-below', !before);
  });
  tr.addEventListener('dragleave', () => tr.classList.remove('role-drop-above', 'role-drop-below'));
  tr.addEventListener('drop', e => {
    e.preventDefault();
    const dropAbove = tr.classList.contains('role-drop-above');
    tr.classList.remove('role-drop-above', 'role-drop-below');
    if (draggedRoleName === null || draggedRoleName === role) return;
    reorderPatternRole(draggedRoleName, role, dropAbove);
    draggedRoleName = null;
  });
}

// Reorders a pattern's roles array (display order only - the day-off data
// is keyed by role name, not position, so nothing else needs to change),
// and keeps every duty group using this pattern in the same new order.
function reorderPatternRole(draggedRole, targetRole, dropAbove){
  const p = getPattern(editingPatternId);
  if (!p.roles.includes(draggedRole) || !p.roles.includes(targetRole)) return;
  const roles = p.roles.filter(r => r !== draggedRole);
  let toIdx = roles.indexOf(targetRole);
  if (!dropAbove) toIdx += 1;
  roles.splice(toIdx, 0, draggedRole);
  p.roles = roles;
  run("UPDATE patterns SET roles_json=? WHERE id=?", [JSON.stringify(p.roles), p.id]);
  q("SELECT id FROM duty_groups WHERE pattern_id=?", [p.id]).forEach(g => {
    p.roles.forEach((r, i) => {
      run("UPDATE duty_group_slots SET slot_order=? WHERE duty_group_id=? AND role=?", [i, g.id, r]);
    });
  });
  saveState();
  renderPatternGrid(p);
  renderDutyGroups();
  renderCalendar();
}

function renderPatternGrid(p){
  const wrap = document.getElementById('patternGridWrap');
  const readOnly = p.built_in;
  const table = document.createElement('table');
  table.className = 'pattern-grid';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  for (let w = 1; w <= p.cycle_length; w++) {
    const th = document.createElement('th');
    th.colSpan = 7;
    th.className = 'week-band';
    th.textContent = 'Week ' + w;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const dayRow = document.createElement('tr');
  dayRow.appendChild(document.createElement('th')).textContent = 'Role';
  for (let w = 1; w <= p.cycle_length; w++) DAYS.forEach(d => { const th=document.createElement('th'); th.textContent=DAY_LABELS[d]; dayRow.appendChild(th); });
  thead.appendChild(dayRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  p.roles.forEach(role => {
    const tr = document.createElement('tr');
    const roleTd = document.createElement('td');
    roleTd.className = 'role-cell';
    if (readOnly) {
      roleTd.textContent = role;
    } else {
      roleTd.innerHTML = `<span class="role-drag-handle" draggable="true" title="Drag to reorder">&#8942;&#8942;</span>
        <input class="role-name-input" value="${escapeHtml(role)}" data-role="${escapeHtml(role)}">
        <button class="btn-icon" data-remove-role="${escapeHtml(role)}" title="Remove role">&times;</button>`;
    }
    tr.appendChild(roleTd);
    if (!readOnly) wireRoleRowDrag(tr, roleTd.querySelector('.role-drag-handle'), role);
    for (let w = 1; w <= p.cycle_length; w++) {
      // Defensive: a role should exist in every week, but if some earlier
      // inconsistency ever left one missing, default to OFF rather than
      // crashing the whole grid - the role/week gap can be seen and fixed
      // directly from the grid itself once it renders.
      if (!p.weeks[w][role]) p.weeks[w][role] = W(OF,OF,OF,OF,OF,OF);
      DAYS.forEach(d => {
        const [kind, label] = p.weeks[w][role][d];
        const td = document.createElement('td');
        td.className = 'cal-cell cell-' + kind.toLowerCase() + (readOnly ? '' : ' editable-cell');
        td.title = KIND_LABEL[kind];
        if (readOnly) {
          td.textContent = label;
        } else {
          const dot = document.createElement('span');
          dot.className = 'cell-cycle-dot';
          dot.title = 'Click to change colour (Working \u2192 Off \u2192 Saturday Route \u2192 Covering)';
          dot.dataset.role = role; dot.dataset.week = w; dot.dataset.day = d;
          dot.addEventListener('click', onPatternCellClick);
          td.appendChild(dot);

          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'pattern-cell-input';
          input.value = label;
          input.maxLength = 6;
          input.dataset.role = role; input.dataset.week = w; input.dataset.day = d;
          input.addEventListener('click', e => e.stopPropagation());
          input.addEventListener('change', onPatternCellLabelChange);
          td.appendChild(input);
        }
        tr.appendChild(td);
      });
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.innerHTML = '';
  wrap.appendChild(table);

  document.getElementById('addRoleBtn').style.display = readOnly ? 'none' : '';
  document.getElementById('addWeekBtn').style.display = readOnly ? 'none' : '';
  document.getElementById('removeWeekBtn').style.display = readOnly ? 'none' : '';
  document.getElementById('savePatternBtn').style.display = readOnly ? 'none' : '';

  const blockSizeInput = document.getElementById('blockSizeInput');
  blockSizeInput.max = p.roles.length;
  if (Number(blockSizeInput.value) > p.roles.length) blockSizeInput.value = p.roles.length;
}

function onPatternCellClick(e){
  const p = getPattern(editingPatternId);
  const { role, week, day } = e.target.dataset;
  const [curKind, curLabel] = p.weeks[week][role][day];
  const nextKind = KIND_ORDER[(KIND_ORDER.indexOf(curKind) + 1) % KIND_ORDER.length];
  // Keep whatever text is already there when just cycling colour (so you can
  // freely retype a duty code without it resetting) - only fall back to a
  // sensible default label the first time a cell has nothing in it yet.
  const label = curLabel && curLabel.trim() !== '' ? curLabel : KIND_DEFAULT_LABEL[nextKind];
  p.weeks[week][role][day] = [nextKind, label];
  run("UPDATE patterns SET weeks_json=? WHERE id=?", [JSON.stringify(p.weeks), p.id]);
  saveState();
  renderPatternGrid(p);
}

// Guesses the right colour from what was typed, so you don't need the
// cycle-dot for the common cases - it's still there as a manual backup/override.
//  - Saturday + a single letter -> Saturday Route (blue)
//  - Any other day + text matching a DIFFERENT role's name -> Covering (purple)
//  - Typing "OFF" -> Day off (yellow); blank, or anything else (including your
//    own role's name) -> Working, own round (green)
function autoDetectKind(text, dayKey, currentRole, allRoles){
  const t = text.trim();
  if (t === '') return 'WORK';
  if (t.toUpperCase() === 'OFF') return 'OFF';
  if (dayKey === 'SAT') {
    return /^[A-Za-z]$/.test(t) ? 'SATWORK' : 'WORK';
  }
  const matchesOtherRole = allRoles.some(r => r !== currentRole && r.toLowerCase() === t.toLowerCase());
  return matchesOtherRole ? 'COVER' : 'WORK';
}

function onPatternCellLabelChange(e){
  const p = getPattern(editingPatternId);
  const { role, week, day } = e.target.dataset;
  const newLabel = e.target.value;
  const kind = autoDetectKind(newLabel, day, role, p.roles);
  p.weeks[week][role][day] = [kind, newLabel];
  run("UPDATE patterns SET weeks_json=? WHERE id=?", [JSON.stringify(p.weeks), p.id]);
  saveState();
  const td = e.target.closest('td');
  td.className = 'cal-cell cell-' + kind.toLowerCase() + ' editable-cell';
  td.title = KIND_LABEL[kind];
}

function wirePatternsPage(){
  document.getElementById('newPatternBtn').addEventListener('click', () => {
    const name = prompt('New pattern name:', 'New Rotation Pattern');
    if (!name) return;
    const cycleLength = Math.max(1, Math.min(12, Number(prompt('How many weeks in the cycle?', '4')) || 4));
    const roles = ['Duty 1','Duty 2','DOC'];
    const weeks = {};
    for (let w = 1; w <= cycleLength; w++) {
      weeks[w] = {};
      roles.forEach(r => { weeks[w][r] = W(WK,WK,WK,WK,WK,WK); });
    }
    const maxOrder = q("SELECT COALESCE(MAX(sort_order),-1) AS m FROM patterns")[0].m;
    run("INSERT INTO patterns (name, cycle_length, roles_json, weeks_json, start_times_json, built_in, sort_order, block_size) VALUES (?,?,?,?,?,?,?,?)",
      [name, cycleLength, JSON.stringify(roles), JSON.stringify(weeks), '{}', 0, maxOrder+1, roles.length]);
    const newId = lastId(); // captured immediately after the insert, before any other db calls
    saveState();
    refreshAfterPatternChange();
    openPatternEditor(newId);
  });

  document.getElementById('patternsContainer').addEventListener('click', e => {
    if (e.target.matches('[data-edit-pattern]')) openPatternEditor(Number(e.target.dataset.editPattern));
    if (e.target.matches('[data-rename-pattern]')) {
      const id = Number(e.target.dataset.renamePattern);
      const current = q("SELECT name FROM patterns WHERE id=?", [id])[0].name;
      const newName = prompt('Rename this rotation pattern:', current);
      if (!newName || !newName.trim() || newName.trim() === current) return;
      run("UPDATE patterns SET name=? WHERE id=?", [newName.trim(), id]);
      saveState();
      refreshAfterPatternChange();
    }
    if (e.target.matches('[data-dup-pattern]')) {
      const src = q("SELECT * FROM patterns WHERE id=?", [Number(e.target.dataset.dupPattern)])[0];
      const maxOrder = q("SELECT COALESCE(MAX(sort_order),-1) AS m FROM patterns")[0].m;
      run("INSERT INTO patterns (name, cycle_length, roles_json, weeks_json, start_times_json, built_in, sort_order, block_size) VALUES (?,?,?,?,?,?,?,?)",
        [src.name + ' (copy)', src.cycle_length, src.roles_json, src.weeks_json, src.start_times_json, 0, maxOrder+1, src.block_size || JSON.parse(src.roles_json).length]);
      saveState();
      refreshAfterPatternChange();
    }
    if (e.target.matches('[data-del-pattern]')) {
      const id = Number(e.target.dataset.delPattern);
      const pattern = q("SELECT * FROM patterns WHERE id=?", [id])[0];
      const inUse = q("SELECT COUNT(*) AS c FROM duty_groups WHERE pattern_id=?", [id])[0].c;
      if (inUse > 0) { alert('This pattern is used by ' + inUse + ' duty group(s). Change their pattern first.'); return; }
      const warning = pattern.built_in
        ? `"${pattern.name}" is one of the two built-in patterns - once deleted it can't be brought back automatically, only recreated by hand. Delete it anyway?`
        : 'Delete this rotation pattern?';
      if (confirm(warning)) {
        run("DELETE FROM patterns WHERE id=?", [id]);
        saveState();
        refreshAfterPatternChange();
      }
    }
  });

  document.getElementById('editorNameInput').addEventListener('change', e => {
    if (!editingPatternId) return;
    run("UPDATE patterns SET name=? WHERE id=?", [e.target.value, editingPatternId]);
    saveState();
    refreshAfterPatternChange();
  });

  document.getElementById('blockSizeInput').addEventListener('change', e => {
    if (!editingPatternId) return;
    const p = getPattern(editingPatternId);
    const val = Math.max(1, Math.min(p.roles.length, Number(e.target.value) || p.roles.length));
    e.target.value = val;
    run("UPDATE patterns SET block_size=? WHERE id=?", [val, editingPatternId]);
    saveState();
    renderDutyGroups();
  });

  document.getElementById('addRoleBtn').addEventListener('click', () => {
    const p = getPattern(editingPatternId);
    const name = prompt('New role name:', 'Duty ' + (p.roles.length));
    if (!name || p.roles.includes(name)) return;
    p.roles.push(name);
    for (let w = 1; w <= p.cycle_length; w++) p.weeks[w][name] = W(WK,WK,WK,WK,WK,WK);
    run("UPDATE patterns SET roles_json=?, weeks_json=? WHERE id=?", [JSON.stringify(p.roles), JSON.stringify(p.weeks), p.id]);
    syncAllGroupsForPattern(p.id);
    saveState();
    renderPatternGrid(p);
    renderDutyGroups();
  });

  document.getElementById('patternGridWrap').addEventListener('click', e => {
    if (e.target.matches('[data-remove-role]')) {
      const p = getPattern(editingPatternId);
      const role = e.target.dataset.removeRole;
      if (p.roles.length <= 1) { alert('A pattern needs at least one role.'); return; }
      if (!confirm(`Remove role "${role}"?`)) return;
      p.roles = p.roles.filter(r => r !== role);
      for (let w = 1; w <= p.cycle_length; w++) delete p.weeks[w][role];
      run("UPDATE patterns SET roles_json=?, weeks_json=? WHERE id=?", [JSON.stringify(p.roles), JSON.stringify(p.weeks), p.id]);
      syncAllGroupsForPattern(p.id);
      saveState();
      renderPatternGrid(p);
      renderDutyGroups();
    }
  });

  document.getElementById('patternGridWrap').addEventListener('change', e => {
    if (e.target.matches('.role-name-input')) {
      const p = getPattern(editingPatternId);
      const oldName = e.target.dataset.role;
      const newName = e.target.value.trim();
      if (!newName || newName === oldName) { renderPatternGrid(p); return; }
      if (p.roles.includes(newName)) { alert('That role name already exists.'); renderPatternGrid(p); return; }
      p.roles = p.roles.map(r => r === oldName ? newName : r);
      for (let w = 1; w <= p.cycle_length; w++) { p.weeks[w][newName] = p.weeks[w][oldName]; delete p.weeks[w][oldName]; }
      run("UPDATE patterns SET roles_json=?, weeks_json=? WHERE id=?", [JSON.stringify(p.roles), JSON.stringify(p.weeks), p.id]);
      run("UPDATE duty_group_slots SET role=? WHERE role=? AND duty_group_id IN (SELECT id FROM duty_groups WHERE pattern_id=?)", [newName, oldName, p.id]);
      saveState();
      renderPatternGrid(p);
      renderDutyGroups();
    }
  });

  document.getElementById('addWeekBtn').addEventListener('click', () => {
    const p = getPattern(editingPatternId);
    const newWeekNum = p.cycle_length + 1;
    p.weeks[newWeekNum] = {};
    p.roles.forEach(r => { p.weeks[newWeekNum][r] = W(WK,WK,WK,WK,WK,WK); });
    p.cycle_length = newWeekNum;
    run("UPDATE patterns SET cycle_length=?, weeks_json=? WHERE id=?", [p.cycle_length, JSON.stringify(p.weeks), p.id]);
    saveState();
    renderPatternGrid(p);
  });
  document.getElementById('removeWeekBtn').addEventListener('click', () => {
    const p = getPattern(editingPatternId);
    if (p.cycle_length <= 1) { alert('A pattern needs at least one week.'); return; }
    delete p.weeks[p.cycle_length];
    p.cycle_length -= 1;
    run("UPDATE patterns SET cycle_length=?, weeks_json=? WHERE id=?", [p.cycle_length, JSON.stringify(p.weeks), p.id]);
    saveState();
    renderPatternGrid(p);
  });

  document.getElementById('savePatternBtn').addEventListener('click', () => {
    closePatternEditor();
    refreshAfterPatternChange();
  });
  document.getElementById('closeEditorBtn').addEventListener('click', closePatternEditor);
}

/* ---------------------------------------------------------------
   DUTY BUILDER PAGE: groups + slots
   --------------------------------------------------------------- */
// Recomputed once per Duty Builder render: which employees are currently
// sitting in more than one slot (primary or the second half of a shared
// duty) - a common accidental double-assignment worth flagging directly
// where it's fixable, rather than only discovering it later via the Duty
// Sheet's day-by-day double-booking check.
