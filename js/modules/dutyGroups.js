/* ---------------------------------------------------------------
   DUTY BUILDER - duty groups and their slots: create groups, assign a
   pattern, drag employees/duties onto role slots, shared duties,
   per-block anchor dates, and individual per-slot rotation overrides.
   CORE - the primary data-entry surface the rest of the app is built on.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'dutyBuilder', name: 'Duty Builder', core: true,
  description: 'Duty groups, slots, drag-and-drop assignment, shared duties, and per-block rotation anchors. The primary data-entry surface.'
});

function getEffectiveAnchor(dutyGroupId, blockIndex, groupAnchorDate){
  const row = q("SELECT anchor_date FROM block_anchor_dates WHERE duty_group_id=? AND block_index=?", [dutyGroupId, blockIndex])[0];
  return row ? row.anchor_date : groupAnchorDate;
}

let duplicateEmployeeMap = new Map();
function computeDuplicateEmployeeMap(){
  const rows = q(`SELECT s.id AS slot_id, s.role, s.employee_id, s.employee_id_2, s.shared_enabled, g.name AS group_name
    FROM duty_group_slots s JOIN duty_groups g ON g.id = s.duty_group_id`);
  const byEmp = new Map();
  rows.forEach(r => {
    if (r.employee_id) {
      if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
      byEmp.get(r.employee_id).push({groupName: r.group_name, role: r.role, slotId: r.slot_id});
    }
    if (r.shared_enabled && r.employee_id_2) {
      if (!byEmp.has(r.employee_id_2)) byEmp.set(r.employee_id_2, []);
      byEmp.get(r.employee_id_2).push({groupName: r.group_name, role: r.role, slotId: r.slot_id});
    }
  });
  const dupMap = new Map();
  byEmp.forEach((assignments, empId) => { if (assignments.length > 1) dupMap.set(empId, assignments); });
  return dupMap;
}

function renderDutyGroups(){
  duplicateEmployeeMap = computeDuplicateEmployeeMap();
  const container = document.getElementById('groupsContainer');
  let groups = q("SELECT * FROM duty_groups ORDER BY pinned DESC, sort_order, id");
  if (builderPatternFilter !== 'all') groups = groups.filter(g => String(g.pattern_id) === String(builderPatternFilter));
  container.innerHTML = '';
  if (groups.length === 0) {
    container.innerHTML = builderPatternFilter === 'all'
      ? '<p class="empty-hint">No duty groups yet - click "+ Add Duty Group" to create one and pick a rotation pattern for it.</p>'
      : '<p class="empty-hint">No duty groups use this pattern yet - click "+ Add Duty Group" to create one here.</p>';
    return;
  }
  groups.forEach(g => container.appendChild(makeGroupCard(g)));
}

function makeGroupCard(g){
  const pattern = getPattern(g.pattern_id);
  const patterns = q("SELECT * FROM patterns ORDER BY sort_order, id");
  const card = document.createElement('div');
  card.className = 'group-card' + (g.pinned ? ' group-card-pinned' : '');
  card.dataset.groupId = g.id;

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <span class="drag-handle" draggable="true" title="Drag to reorder this group">&#9776;</span>
    <button class="pin-toggle ${g.pinned ? 'pinned' : ''}" data-pin-group="${g.id}" title="${g.pinned ? 'Unpin - this group is currently shown first on the Duty Sheet' : 'Pin this group to show it first on the Duty Sheet'}">&#128204;</button>
    <input class="group-name-input" value="${escapeHtml(g.name)}" data-group-id="${g.id}">
    <select class="group-pattern-select" data-group-id="${g.id}">
      ${patterns.map(p => `<option value="${p.id}" ${p.id===g.pattern_id?'selected':''}>${escapeHtml(p.name)}</option>`).join('')}
    </select>
    <label class="anchor-label">Cycle Week 1 w/c
      <input type="date" class="anchor-date" data-group-id="${g.id}" value="${g.anchor_date}">
    </label>
    <button class="btn btn-sm" data-sync-group="${g.id}" title="Rebuild slots to match the pattern's current roles">Sync roles</button>
    <button class="btn btn-danger btn-sm" data-del-group="${g.id}">Delete</button>
  `;
  card.appendChild(header);
  wireGroupCardDrag(card, header.querySelector('.drag-handle'));
  wireSlotCardDropTarget(card, g.id);

  const slotsRow = document.createElement('div');
  slotsRow.className = 'slots-row';
  if (!pattern) {
    slotsRow.innerHTML = '<p class="empty-hint">Pattern missing - pick another pattern above.</p>';
  } else {
    slotsRow.style.gridTemplateColumns = `repeat(${pattern.block_size}, minmax(160px, 1fr))`;
    const slots = q("SELECT * FROM duty_group_slots WHERE duty_group_id=? ORDER BY slot_order", [g.id]);
    const showBlockAnchors = pattern.block_size < slots.length;
    let lastBlockIdx = null;
    slots.forEach(slot => {
      const blockIdx = blockIndexFor(slot.slot_order, pattern.block_size);
      if (showBlockAnchors && blockIdx !== lastBlockIdx) {
        slotsRow.appendChild(makeBlockAnchorRow(g, blockIdx, pattern));
        lastBlockIdx = blockIdx;
      }
      const box = makeSlotBox(slot);
      wireSlotBoxDropTarget(box, slot);
      slotsRow.appendChild(box);
    });
  }
  card.appendChild(slotsRow);
  return card;
}

/* ---------------------------------------------------------------
   DUTY GROUP REORDERING (drag whole group cards by their handle)
   --------------------------------------------------------------- */
let draggedGroupId = null;
let draggedSlotId = null;

function wireGroupCardDrag(card, handle){
  handle.addEventListener('dragstart', e => {
    draggedGroupId = Number(card.dataset.groupId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(draggedGroupId));
    card.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.group-card').forEach(c => c.classList.remove('drop-above','drop-below'));
    draggedGroupId = null;
  });
  card.addEventListener('dragover', e => {
    if (draggedGroupId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = card.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    card.classList.toggle('drop-above', before);
    card.classList.toggle('drop-below', !before);
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('drop-above','drop-below');
  });
  card.addEventListener('drop', e => {
    e.preventDefault();
    const targetId = Number(card.dataset.groupId);
    const dropAbove = card.classList.contains('drop-above');
    card.classList.remove('drop-above','drop-below');
    if (draggedGroupId === null || draggedGroupId === targetId) return;
    reorderGroups(draggedGroupId, targetId, dropAbove);
    draggedGroupId = null;
  });
}

function onSlotCardDragStart(e){
  const box = e.currentTarget.closest('.slot-box');
  draggedSlotId = Number(box.dataset.slotId);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(draggedSlotId));
  box.classList.add('slot-dragging');
}
function onSlotCardDragEnd(e){
  e.currentTarget.closest('.slot-box').classList.remove('slot-dragging');
  document.querySelectorAll('.group-card').forEach(c => c.classList.remove('slot-drop-target'));
  draggedSlotId = null;
}

function wireSlotCardDropTarget(card, groupId){
  card.addEventListener('dragover', e => {
    if (draggedSlotId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('slot-drop-target');
  });
  card.addEventListener('dragleave', e => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('slot-drop-target');
  });
  card.addEventListener('drop', e => {
    if (draggedSlotId === null) return;
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the group-reorder drop handler
    card.classList.remove('slot-drop-target');
    const slotId = draggedSlotId;
    draggedSlotId = null;
    const slot = q("SELECT * FROM duty_group_slots WHERE id=?", [slotId])[0];
    if (!slot || slot.duty_group_id === groupId) return;
    moveSlotToGroup(slotId, groupId);
  });
}

// Dropping a role card directly onto another slot (rather than the group's
// open background) swaps their two positions when they're in the same
// group - the natural way to move a role between blocks, since a block is
// just a range of positions within one pattern, not a separate list roles
// can be appended to. Dropping onto a slot in a *different* group still
// falls through to the existing cross-group move.
function wireSlotBoxDropTarget(box, slot){
  box.addEventListener('dragover', e => {
    if (draggedSlotId === null || draggedSlotId === slot.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    box.classList.add('slot-drop-target');
  });
  box.addEventListener('dragleave', e => {
    if (!box.contains(e.relatedTarget)) box.classList.remove('slot-drop-target');
  });
  box.addEventListener('drop', e => {
    if (draggedSlotId === null || draggedSlotId === slot.id) return;
    e.preventDefault();
    e.stopPropagation();
    box.classList.remove('slot-drop-target');
    const draggedId = draggedSlotId;
    draggedSlotId = null;
    const draggedSlot = q("SELECT * FROM duty_group_slots WHERE id=?", [draggedId])[0];
    if (!draggedSlot) return;
    if (draggedSlot.duty_group_id === slot.duty_group_id) {
      swapSlotOrder(draggedId, slot.id);
    } else {
      moveSlotToGroup(draggedId, slot.duty_group_id);
    }
  });
}

// Swaps two slots' positions (and therefore which block they fall into,
// per blockIndexFor) within the same group. Everything about each slot -
// its role, duty, employee, shared-duty settings - moves with it; only the
// two slot_order values themselves change, so block sizes are never
// disturbed by this.
function swapSlotOrder(slotIdA, slotIdB){
  const a = q("SELECT * FROM duty_group_slots WHERE id=?", [slotIdA])[0];
  const b = q("SELECT * FROM duty_group_slots WHERE id=?", [slotIdB])[0];
  if (!a || !b) return;
  run("UPDATE duty_group_slots SET slot_order=? WHERE id=?", [b.slot_order, a.id]);
  run("UPDATE duty_group_slots SET slot_order=? WHERE id=?", [a.slot_order, b.id]);
  saveState();
  renderDutyGroups();
  renderCalendar();
}

// Moves a role card (with whatever duty/employee is assigned to it) from
// its current duty group to a different one - and keeps the underlying
// rotation patterns in sync, since a role only really exists as an entry
// in its pattern's role list. Warns first if either pattern is shared by
// other groups, since editing it here would affect them too.
function moveSlotToGroup(slotId, targetGroupId){
  const slot = q("SELECT * FROM duty_group_slots WHERE id=?", [slotId])[0];
  const sourceGroup = q("SELECT * FROM duty_groups WHERE id=?", [slot.duty_group_id])[0];
  const targetGroup = q("SELECT * FROM duty_groups WHERE id=?", [targetGroupId])[0];
  if (!sourceGroup || !targetGroup) return;

  const sourcePattern = getPattern(sourceGroup.pattern_id);
  const targetPattern = getPattern(targetGroup.pattern_id);
  if (!sourcePattern || !targetPattern) return;

  if (targetPattern.roles.includes(slot.role) && targetPattern.id !== sourcePattern.id) {
    alert(`"${targetGroup.name}"'s pattern already has a role called "${slot.role}" - rename one of them first.`);
    return;
  }

  const sourceUsedElsewhere = q("SELECT COUNT(*) AS c FROM duty_groups WHERE pattern_id=?", [sourcePattern.id])[0].c > 1;
  const targetUsedElsewhere = q("SELECT COUNT(*) AS c FROM duty_groups WHERE pattern_id=?", [targetPattern.id])[0].c > 1 && targetPattern.id !== sourcePattern.id;
  if (sourceUsedElsewhere || targetUsedElsewhere) {
    const parts = [];
    if (sourceUsedElsewhere) parts.push(`"${sourcePattern.name}" is also used by other duty group(s) - they'll lose this role too`);
    if (targetUsedElsewhere) parts.push(`"${targetPattern.name}" is also used by other duty group(s) - they'll gain this role too`);
    if (!confirm(`Moving "${slot.role}" to "${targetGroup.name}":\n\n${parts.join('\n')}\n\nContinue?`)) return;
  }

  if (targetPattern.id !== sourcePattern.id) {
    // Remove the role from its old pattern.
    sourcePattern.roles = sourcePattern.roles.filter(r => r !== slot.role);
    for (let w = 1; w <= sourcePattern.cycle_length; w++) delete sourcePattern.weeks[w][slot.role];
    run("UPDATE patterns SET roles_json=?, weeks_json=? WHERE id=?",
      [JSON.stringify(sourcePattern.roles), JSON.stringify(sourcePattern.weeks), sourcePattern.id]);

    // Add it to the new one - carrying its existing day-off structure across
    // if the two patterns run the same cycle length, since that's still
    // meaningful; otherwise default it to a plain working week, same as
    // "+ Add role" does for a brand new one.
    targetPattern.roles.push(slot.role);
    for (let w = 1; w <= targetPattern.cycle_length; w++) {
      targetPattern.weeks[w][slot.role] = (sourcePattern.cycle_length === targetPattern.cycle_length)
        ? sourcePattern.weeks[w][slot.role] : W(WK,WK,WK,WK,WK,WK);
    }
    run("UPDATE patterns SET roles_json=?, weeks_json=? WHERE id=?",
      [JSON.stringify(targetPattern.roles), JSON.stringify(targetPattern.weeks), targetPattern.id]);
  }

  // Move the slot itself to the end of the target group.
  const maxOrder = q("SELECT COALESCE(MAX(slot_order),-1) AS m FROM duty_group_slots WHERE duty_group_id=?", [targetGroupId])[0].m;
  run("UPDATE duty_group_slots SET duty_group_id=?, slot_order=? WHERE id=?", [targetGroupId, maxOrder + 1, slotId]);

  saveState();
  renderDutyGroups();
  renderCalendar();
  if (editingPatternId === sourcePattern.id || editingPatternId === targetPattern.id) {
    renderPatternGrid(getPattern(editingPatternId));
  }
  renderPatternsList();
}

// Reassigns sort_order across ALL duty groups (not just the currently
// filtered/visible ones) so relative ordering elsewhere is preserved.
function reorderGroups(draggedId, targetId, dropAbove){
  const all = q("SELECT id FROM duty_groups ORDER BY pinned DESC, sort_order, id").map(r => r.id);
  const fromIndex = all.indexOf(draggedId);
  if (fromIndex === -1) return;
  all.splice(fromIndex, 1);
  let toIndex = all.indexOf(targetId);
  if (toIndex === -1) return;
  if (!dropAbove) toIndex += 1;
  all.splice(toIndex, 0, draggedId);
  all.forEach((id, i) => run("UPDATE duty_groups SET sort_order=? WHERE id=?", [i, id]));
  saveState();
  renderDutyGroups();
  renderCalendar();
}

// A spanning divider shown above each block of roles (matching the pattern's
// "duties per row") so its own Cycle Week 1 date can be set independently
// of the group's - e.g. staggering several 9-Day-Fortnight teams within
// one big group so they don't all have the same week off.
function makeBlockAnchorRow(g, blockIdx, pattern){
  const row = document.createElement('div');
  row.className = 'block-anchor-row';
  row.style.gridColumn = `1 / -1`;
  const override = q("SELECT anchor_date FROM block_anchor_dates WHERE duty_group_id=? AND block_index=?", [g.id, blockIdx])[0];
  const value = override ? override.anchor_date : g.anchor_date;
  row.innerHTML = `
    <span class="block-anchor-label">Block ${blockIdx + 1} &middot; Cycle Week 1 w/c</span>
    <input type="date" class="block-anchor-date" data-duty-group-id="${g.id}" data-block-index="${blockIdx}" value="${value}">
    ${override ? `<button class="btn-icon" data-clear-block-anchor="${g.id}|${blockIdx}" title="Reset to the group's own date">&times; use group date</button>` : '<span class="block-anchor-hint">(using group date)</span>'}
  `;
  return row;
}

function makeSlotBox(slot){
  const box = document.createElement('div');
  box.className = 'slot-box' + (slot.shared_enabled ? ' slot-box-shared' : '');
  box.dataset.slotId = slot.id;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'slot-role';
  roleLabel.draggable = true;
  roleLabel.title = 'Drag to move this role to a different duty group';
  roleLabel.innerHTML = `<span class="slot-drag-handle">&#8942;&#8942;</span>${escapeHtml(slot.role)}`;
  roleLabel.addEventListener('dragstart', onSlotCardDragStart);
  roleLabel.addEventListener('dragend', onSlotCardDragEnd);
  box.appendChild(roleLabel);

  const sharedToggle = document.createElement('label');
  sharedToggle.className = 'slot-shared-toggle';
  sharedToggle.innerHTML = `<input type="checkbox" data-shared-toggle="${slot.id}" ${slot.shared_enabled ? 'checked' : ''}> Shared duty`;
  box.appendChild(sharedToggle);

  const dutyZone = document.createElement('div');
  dutyZone.className = 'slot-dropzone dropzone-duty';
  dutyZone.dataset.slotId = slot.id;
  dutyZone.dataset.field = 'duty';
  if (slot.duty_id) {
    const duty = q("SELECT * FROM duties WHERE id=?", [slot.duty_id])[0];
    if (duty) {
      const sub = [duty.group_label, duty.code].filter(Boolean).join(' \u00b7 ');
      dutyZone.appendChild(makeChip('duty', duty.id, duty.name, sub, true, 'slot', {slotId: slot.id}));
    }
  } else {
    dutyZone.innerHTML = '<span class="dropzone-placeholder">Drop a duty here</span>';
  }
  addDropHandlers(dutyZone);
  box.appendChild(dutyZone);

  if (slot.shared_enabled) {
    // Shared duty overrides the block's own rotation entirely - BOTH people
    // get their own independent pattern/role/anchor, not just the second one.
    box.appendChild(makePersonSection(slot, 1));
    box.appendChild(makePersonSection(slot, 2));
  } else {
    const empZone = document.createElement('div');
    empZone.className = 'slot-dropzone dropzone-employee';
    empZone.dataset.slotId = slot.id;
    empZone.dataset.field = 'employee';
    if (slot.employee_id) {
      const emp = q("SELECT * FROM employees WHERE id=?", [slot.employee_id])[0];
      if (emp) empZone.appendChild(makeChip('employee', emp.id, emp.name, '', true, 'slot', {slotId: slot.id}));
    } else {
      empZone.innerHTML = '<span class="dropzone-placeholder">Drop an employee here</span>';
    }
    addDropHandlers(empZone);
    box.appendChild(empZone);

    // An individual rotation lets this one person follow their own
    // pattern - e.g. a different, more predictable cycle to fit around
    // childcare or other personal circumstances - while everyone else in
    // the group carries on with the group's own rotation as normal.
    const individualToggle = document.createElement('label');
    individualToggle.className = 'slot-shared-toggle';
    individualToggle.innerHTML = `<input type="checkbox" data-individual-toggle="${slot.id}" ${slot.primary_pattern_id ? 'checked' : ''}> Individual rotation`;
    box.appendChild(individualToggle);
    if (slot.primary_pattern_id) {
      box.appendChild(makeIndividualRotationPicker(slot));
    }
  }

  return box;
}

// Just the pattern/role/anchor picker used for a non-shared slot's
// individual rotation override - same underlying fields (and change
// handlers) as a shared duty's "person 1" section, just without an
// employee dropzone of its own (the slot already has one above).
function makeIndividualRotationPicker(slot){
  const wrap = document.createElement('div');
  wrap.className = 'slot-shared-section';

  const label = document.createElement('div');
  label.className = 'slot-shared-label';
  label.textContent = 'Individual rotation for this person:';
  wrap.appendChild(label);

  const patterns = q("SELECT * FROM patterns ORDER BY sort_order, id");
  const patternSel = document.createElement('select');
  patternSel.className = 'primary-pattern-select';
  patternSel.dataset.slotId = slot.id;
  patternSel.innerHTML = patterns.map(p => `<option value="${p.id}" ${p.id===slot.primary_pattern_id?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
  wrap.appendChild(patternSel);

  const effectivePatternId = slot.primary_pattern_id || Number(patternSel.value);
  const effPattern = getPattern(effectivePatternId);
  const roleSel = document.createElement('select');
  roleSel.className = 'primary-role-select';
  roleSel.dataset.slotId = slot.id;
  if (effPattern) {
    roleSel.innerHTML = effPattern.roles.map(r => `<option value="${escapeHtml(r)}" ${r===slot.primary_role?'selected':''}>${escapeHtml(r)}</option>`).join('');
  }
  wrap.appendChild(roleSel);

  const anchorLabel = document.createElement('label');
  anchorLabel.className = 'anchor-label';
  anchorLabel.innerHTML = `Their Cycle Week 1 w/c <input type="date" class="primary-anchor-date" data-slot-id="${slot.id}" value="${slot.primary_anchor_date || ''}">`;
  wrap.appendChild(anchorLabel);

  return wrap;
}

// One person's half of a shared duty - their own employee slot plus their
// own independent pattern/role/anchor, entirely separate from the block's.
// personNum 1 = the slot's own employee_id; 2 = employee_id_2.
function makePersonSection(slot, personNum){
  const isP1 = personNum === 1;
  const empField = isP1 ? 'employee' : 'employee2';
  const empId = isP1 ? slot.employee_id : slot.employee_id_2;
  const patternId = isP1 ? slot.primary_pattern_id : slot.shared_pattern_id;
  const role = isP1 ? slot.primary_role : slot.shared_role;
  const anchorDate = isP1 ? slot.primary_anchor_date : slot.shared_anchor_date;
  const patternField = isP1 ? 'primary-pattern-select' : 'shared-pattern-select';
  const roleField = isP1 ? 'primary-role-select' : 'shared-role-select';
  const anchorField = isP1 ? 'primary-anchor-date' : 'shared-anchor-date';

  const wrap = document.createElement('div');
  wrap.className = 'slot-shared-section';

  const label = document.createElement('div');
  label.className = 'slot-shared-label';
  label.textContent = `Person ${personNum} (own rotation):`;
  wrap.appendChild(label);

  const empZone = document.createElement('div');
  empZone.className = 'slot-dropzone ' + (isP1 ? 'dropzone-employee' : 'dropzone-employee2');
  empZone.dataset.slotId = slot.id;
  empZone.dataset.field = empField;
  if (empId) {
    const emp = q("SELECT * FROM employees WHERE id=?", [empId])[0];
    if (emp) empZone.appendChild(makeChip('employee', emp.id, emp.name, '', true, 'slot', {slotId: slot.id, field: empField}));
  } else {
    empZone.innerHTML = `<span class="dropzone-placeholder">Drop ${isP1 ? '1st' : '2nd'} employee here</span>`;
  }
  addDropHandlers(empZone);
  wrap.appendChild(empZone);

  const patterns = q("SELECT * FROM patterns ORDER BY sort_order, id");
  const patternSel = document.createElement('select');
  patternSel.className = patternField;
  patternSel.dataset.slotId = slot.id;
  patternSel.innerHTML = patterns.map(p => `<option value="${p.id}" ${p.id===patternId?'selected':''}>${escapeHtml(p.name)}</option>`).join('');
  wrap.appendChild(patternSel);

  const effectivePatternId = patternId || Number(patternSel.value);
  const effPattern = getPattern(effectivePatternId);
  const roleSel = document.createElement('select');
  roleSel.className = roleField;
  roleSel.dataset.slotId = slot.id;
  if (effPattern) {
    roleSel.innerHTML = effPattern.roles.map(r => `<option value="${escapeHtml(r)}" ${r===role?'selected':''}>${escapeHtml(r)}</option>`).join('');
  }
  wrap.appendChild(roleSel);

  const anchorLabel = document.createElement('label');
  anchorLabel.className = 'anchor-label';
  anchorLabel.innerHTML = `Their Cycle Week 1 w/c <input type="date" class="${anchorField}" data-slot-id="${slot.id}" value="${anchorDate || ''}">`;
  wrap.appendChild(anchorLabel);

  return wrap;
}

/* ---------------------------------------------------------------
   DRAG AND DROP (generalised for employees + duties)
   --------------------------------------------------------------- */
let dragPayload = null;

function onDragStart(e){
  const chip = e.currentTarget;
  dragPayload = {
    kind: chip.dataset.kind,
    id: Number(chip.dataset.id),
    source: chip.dataset.source,
    slotId: chip.dataset.slotId ? Number(chip.dataset.slotId) : null,
    field: chip.dataset.field || null
  };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragPayload.id));
  chip.classList.add('dragging');
}
function onDragEnd(e){
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));
}
function addDropHandlers(zone){
  zone.addEventListener('dragover', e => {
    if (!dragPayload) return;
    if (!fieldAcceptsKind(zone.dataset.field, dragPayload.kind)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('drop-hover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-hover'));
  zone.addEventListener('drop', onDropToSlotZone);
}

// 'duty' zones only accept duty chips; both the primary 'employee' zone and
// the shared-duty 'employee2' zone accept ordinary employee chips.
function fieldAcceptsKind(field, kind){
  return field === 'duty' ? kind === 'duty' : kind === 'employee';
}
function fieldToColumn(field){
  return field === 'duty' ? 'duty_id' : (field === 'employee2' ? 'employee_id_2' : 'employee_id');
}

// Which pattern and role actually governs a slot's rotation - its own
// individual override if it has one, otherwise its group's shared pattern.
function getEffectivePatternAndRoleForSlot(slot){
  if (slot.primary_pattern_id) {
    return { pattern: getPattern(slot.primary_pattern_id), role: slot.primary_role };
  }
  const group = q("SELECT * FROM duty_groups WHERE id=?", [slot.duty_group_id])[0];
  return { pattern: group ? getPattern(group.pattern_id) : null, role: slot.role };
}

// How many places (groups using it directly, or slots with it as their own
// individual override) currently rely on this pattern - used to warn
// before editing it, since a pattern template can be shared.
function countUsersOfPattern(patternId){
  const groupCount = q("SELECT COUNT(*) AS c FROM duty_groups WHERE pattern_id=?", [patternId])[0].c;
  const individualCount = q("SELECT COUNT(*) AS c FROM duty_group_slots WHERE primary_pattern_id=?", [patternId])[0].c;
  return groupCount + individualCount;
}

function onDropToSlotZone(e){
  e.preventDefault();
  e.currentTarget.classList.remove('drop-hover');
  if (!dragPayload) return;
  const targetField = e.currentTarget.dataset.field;
  if (!fieldAcceptsKind(targetField, dragPayload.kind)) return;
  const targetSlotId = Number(e.currentTarget.dataset.slotId);
  const targetColumn = fieldToColumn(targetField);

  if (dragPayload.slotId === targetSlotId && (dragPayload.field || 'employee') === targetField) { dragPayload = null; return; }

  // Dragging a duty card from one slot to another is a deliberate decision
  // that the duty itself now belongs there - so its actual work/off
  // schedule should move with it, not just its code. Swapping only the
  // duty_id column would leave two duties silently running on each
  // other's old schedules, which is exactly the "vanishing pattern"
  // problem this exists to prevent. Only applies slot-to-slot (not a
  // fresh drag from the sidebar, which has no "own" schedule to bring).
  const isDutySwap = dragPayload.source === 'slot' && dragPayload.slotId && dragPayload.slotId !== targetSlotId &&
    targetField === 'duty' && (dragPayload.field === 'duty' || (!dragPayload.field && dragPayload.kind === 'duty'));
  if (isDutySwap) {
    const sourceSlot = q("SELECT * FROM duty_group_slots WHERE id=?", [dragPayload.slotId])[0];
    const targetSlot = q("SELECT * FROM duty_group_slots WHERE id=?", [targetSlotId])[0];
    const src = getEffectivePatternAndRoleForSlot(sourceSlot);
    const tgt = getEffectivePatternAndRoleForSlot(targetSlot);
    // Check EVERY week has both roles, not just week 1 - a pattern that's
    // ever had a role added/removed/renamed unevenly across its weeks
    // could otherwise pass a week-1-only check and then swap week 3 or 4
    // straight into a hole, leaving the other role's data silently gone
    // once serialised (JSON.stringify drops an undefined value entirely).
    const bothRolesExistEveryWeek = src.pattern && tgt.pattern && src.pattern.id === tgt.pattern.id && src.role !== tgt.role &&
      Object.keys(src.pattern.weeks).every(wk => src.pattern.weeks[wk][src.role] && src.pattern.weeks[wk][tgt.role]);
    if (bothRolesExistEveryWeek) {
      const usageCount = countUsersOfPattern(src.pattern.id);
      const proceed = usageCount <= 1 || confirm(
        `The rotation pattern "${src.pattern.name}" is used in ${usageCount} places. ` +
        `Swapping these duties will swap the "${src.role}" and "${tgt.role}" schedules everywhere this pattern is used, not just here. Continue?`);
      if (proceed) {
        const weeks = src.pattern.weeks;
        Object.keys(weeks).forEach(wk => {
          const tmp = weeks[wk][src.role];
          weeks[wk][src.role] = weeks[wk][tgt.role];
          weeks[wk][tgt.role] = tmp;
        });
        run("UPDATE patterns SET weeks_json=? WHERE id=?", [JSON.stringify(weeks), src.pattern.id]);
      }
    }
  }

  const targetRow = q(`SELECT ${targetColumn} AS v FROM duty_group_slots WHERE id=?`, [targetSlotId])[0];
  const occupantId = targetRow ? targetRow.v : null;

  if (dragPayload.source === 'slot' && dragPayload.slotId) {
    const sourceColumn = fieldToColumn(dragPayload.field || (dragPayload.kind === 'duty' ? 'duty' : 'employee'));
    run(`UPDATE duty_group_slots SET ${sourceColumn}=? WHERE id=?`, [occupantId, dragPayload.slotId]);
  }
  run(`UPDATE duty_group_slots SET ${targetColumn}=? WHERE id=?`, [dragPayload.id, targetSlotId]);
  bumpSkillScoreIfComplete(targetSlotId);
  if (dragPayload.source === 'slot' && dragPayload.slotId && dragPayload.slotId !== targetSlotId) {
    bumpSkillScoreIfComplete(dragPayload.slotId);
  }

  dragPayload = null;
  saveState();
  renderDutyGroups();
  renderSidebarEmployees();
  renderSidebarDuties();
  renderCalendar();
}

// Whenever a slot ends up with BOTH an employee and a duty (whichever one
// was just dropped), that's a fresh, deliberate assignment - nudge that
// person's skill score for that duty up a notch, capped at 10. A slot
// missing either half doesn't count for anything yet.
// The Duty Builder assignment represents the duty someone actually holds
// in the office - their real, everyday job, not an occasional cover -
// so if the Skills Matrix already has any score recorded for it, holding
// it as their own duty confirms full expertise and jumps it straight to
// 10. If nothing's recorded yet at all, this does NOT invent a skill from
// the assignment alone - the Skills Matrix stays the one place that
// decides whether someone is skilled for a duty in the first place.
function bumpSkillScoreIfComplete(slotId){
  const slot = q("SELECT employee_id, duty_id FROM duty_group_slots WHERE id=?", [slotId])[0];
  if (!slot || !slot.employee_id || !slot.duty_id) return;
  const existing = q("SELECT score FROM employee_skills WHERE employee_id=? AND duty_id=?", [slot.employee_id, slot.duty_id])[0];
  if (!existing || existing.score <= 0) return;
  if (existing.score === 10) return;
  run("UPDATE employee_skills SET score=10 WHERE employee_id=? AND duty_id=?", [slot.employee_id, slot.duty_id]);
}

// A manual COVER override's label is free text, but when it happens to
// exactly match a real duty's code or name (as it does whenever someone
// picks a suggested cover, which fills the label in automatically), that's
// good evidence of a genuine cover instance worth crediting - nudge that
// person's score for the matched duty up a notch, same as an assignment.
function bumpSkillScoreForOverrideLabel(slotId, label){
  const slot = q("SELECT employee_id FROM duty_group_slots WHERE id=?", [slotId])[0];
  if (!slot || !slot.employee_id) return;
  const duty = q("SELECT * FROM duties WHERE LOWER(code)=LOWER(?) OR LOWER(name)=LOWER(?)", [label, label])[0];
  if (!duty) return;
  const existing = q("SELECT score FROM employee_skills WHERE employee_id=? AND duty_id=?", [slot.employee_id, duty.id])[0];
  const newScore = Math.min(10, (existing ? existing.score : 0) + 1);
  run("INSERT INTO employee_skills (employee_id, duty_id, score) VALUES (?,?,?) ON CONFLICT(employee_id, duty_id) DO UPDATE SET score=excluded.score", [slot.employee_id, duty.id, newScore]);
}

function wireSidebarDropTargets(){
  ['employeeList','dutyList'].forEach(id => {
    const el = document.getElementById(id);
    const kind = id === 'employeeList' ? 'employee' : 'duty';
    el.addEventListener('dragover', e => {
      if (!dragPayload || dragPayload.kind !== kind) return;
      e.preventDefault();
      el.classList.add('drop-hover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop-hover');
      if (!dragPayload || dragPayload.kind !== kind) return;
      if (dragPayload.source === 'slot' && dragPayload.slotId) {
        const column = fieldToColumn(dragPayload.field || (kind === 'duty' ? 'duty' : 'employee'));
        run(`UPDATE duty_group_slots SET ${column}=NULL WHERE id=?`, [dragPayload.slotId]);
        saveState();
        renderDutyGroups();
        renderSidebarEmployees();
        renderSidebarDuties();
        renderCalendar();
      }
      dragPayload = null;
    });
  });
}

/* ---------------------------------------------------------------
   CALENDAR
   --------------------------------------------------------------- */
// Renders the second row for a shared duty - the sharing employee's own
// pattern/role/anchor, entirely independent of the slot's main rotation.
// Read-only for now: no manual overrides or overtime on this row yet,
// just their computed day-off calendar plus bank holidays and their leave.
function syncGroupSlots(groupId){
  const g = q("SELECT * FROM duty_groups WHERE id=?", [groupId])[0];
  const pattern = getPattern(g.pattern_id);
  const existingSlots = q("SELECT * FROM duty_group_slots WHERE duty_group_id=?", [groupId]);
  const byRole = {}; existingSlots.forEach(s => byRole[s.role] = s);
  run("DELETE FROM cell_overrides WHERE slot_id IN (SELECT id FROM duty_group_slots WHERE duty_group_id=?)", [groupId]);
  run("DELETE FROM duty_group_slots WHERE duty_group_id=?", [groupId]);
  pattern.roles.forEach((role, i) => {
    const old = byRole[role];
    run(`INSERT INTO duty_group_slots (duty_group_id, role, slot_order, duty_id, employee_id, shared_enabled,
         employee_id_2, shared_pattern_id, shared_role, shared_anchor_date,
         primary_pattern_id, primary_role, primary_anchor_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [groupId, role, i, old ? old.duty_id : null, old ? old.employee_id : null,
       old ? old.shared_enabled : 0, old ? old.employee_id_2 : null, old ? old.shared_pattern_id : null, old ? old.shared_role : null, old ? old.shared_anchor_date : null,
       old ? old.primary_pattern_id : null, old ? old.primary_role : null, old ? old.primary_anchor_date : null]);
  });
}
// Called whenever a pattern's role list changes, so every group using it
// updates immediately (right number of slots, right grid width) instead of
// needing someone to remember to click "Sync roles" afterwards.
function syncAllGroupsForPattern(patternId){
  q("SELECT id FROM duty_groups WHERE pattern_id=?", [patternId]).forEach(g => syncGroupSlots(g.id));
}

function wireDutyBuilderPage(){
  document.querySelectorAll('.builder-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.builder-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.builder-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(btn.dataset.buildertab).classList.add('active');
      // Skill scores now change automatically as a side effect of ordinary
      // assignments elsewhere, so this pane needs a fresh render on every
      // visit rather than showing whatever it looked like at page load.
      if (btn.dataset.buildertab === 'paneBuilderSkills') renderSkillsEmployeeList();
    });
  });

  document.getElementById('addGroupBtn').addEventListener('click', () => {
    document.getElementById('addGroupModal').classList.add('open');
    document.getElementById('newGroupAnchor').value = toISO(mondayOf(new Date()));
    if (builderPatternFilter !== 'all') {
      document.getElementById('newGroupPattern').value = builderPatternFilter;
    }
  });
  document.getElementById('cancelAddGroup').addEventListener('click', () => document.getElementById('addGroupModal').classList.remove('open'));
  document.getElementById('addGroupForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('newGroupName').value.trim() || 'New Duty Group';
    const patternId = Number(document.getElementById('newGroupPattern').value);
    const anchor = document.getElementById('newGroupAnchor').value;
    const maxOrder = q("SELECT COALESCE(MAX(sort_order),-1) AS m FROM duty_groups")[0].m;
    run("INSERT INTO duty_groups (name, pattern_id, anchor_date, sort_order) VALUES (?,?,?,?)", [name, patternId, anchor, maxOrder+1]);
    const gid = lastId();
    const pattern = getPattern(patternId);
    pattern.roles.forEach((role, i) => {
      run("INSERT INTO duty_group_slots (duty_group_id, role, slot_order, duty_id, employee_id) VALUES (?,?,?,?,?)", [gid, role, i, null, null]);
    });
    document.getElementById('addGroupModal').classList.remove('open');
    document.getElementById('addGroupForm').reset();
    saveState();
    renderDutyGroups(); renderCalendar();
  });

  document.addEventListener('click', e => {
    if (e.target.matches('[data-clear-block-anchor]')) {
      const [gid, blockIdx] = e.target.dataset.clearBlockAnchor.split('|').map(Number);
      run("DELETE FROM block_anchor_dates WHERE duty_group_id=? AND block_index=?", [gid, blockIdx]);
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.matches('[data-pin-group]')) {
      const id = Number(e.target.dataset.pinGroup);
      const g = q("SELECT pinned FROM duty_groups WHERE id=?", [id])[0];
      const nowPinned = g.pinned ? 0 : 1;
      if (nowPinned) run("UPDATE duty_groups SET pinned=0"); // exclusive - only one top group at a time
      run("UPDATE duty_groups SET pinned=? WHERE id=?", [nowPinned, id]);
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.matches('[data-del-group]')) {
      const id = Number(e.target.dataset.delGroup);
      if (confirm('Delete this duty group and its slots? Employees and duties stay in their lists.')) {
        run("DELETE FROM cell_overrides WHERE slot_id IN (SELECT id FROM duty_group_slots WHERE duty_group_id=?)", [id]);
        run("DELETE FROM block_anchor_dates WHERE duty_group_id=?", [id]);
        run("DELETE FROM duty_group_slots WHERE duty_group_id=?", [id]);
        run("DELETE FROM duty_groups WHERE id=?", [id]);
        saveState(); renderDutyGroups(); renderCalendar();
      }
    }
    if (e.target.matches('[data-sync-group]')) {
      syncGroupSlots(Number(e.target.dataset.syncGroup));
      saveState(); renderDutyGroups(); renderSidebarEmployees(); renderSidebarDuties(); renderCalendar();
    }
  });

  document.addEventListener('change', e => {
    if (e.target.matches('.group-name-input')) {
      run("UPDATE duty_groups SET name=? WHERE id=?", [e.target.value, Number(e.target.dataset.groupId)]);
      saveState(); renderCalendar();
    }
    if (e.target.matches('.group-pattern-select')) {
      const gid = Number(e.target.dataset.groupId);
      const newPatternId = Number(e.target.value);
      run("UPDATE duty_groups SET pattern_id=? WHERE id=?", [newPatternId, gid]);
      const existingSlots = q("SELECT * FROM duty_group_slots WHERE duty_group_id=?", [gid]);
      const byRole = {}; existingSlots.forEach(s => byRole[s.role] = s);
      run("DELETE FROM cell_overrides WHERE slot_id IN (SELECT id FROM duty_group_slots WHERE duty_group_id=?)", [gid]);
      run("DELETE FROM duty_group_slots WHERE duty_group_id=?", [gid]);
      const pattern = getPattern(newPatternId);
      pattern.roles.forEach((role, i) => {
        const old = byRole[role];
        run("INSERT INTO duty_group_slots (duty_group_id, role, slot_order, duty_id, employee_id, shared_enabled, employee_id_2, shared_pattern_id, shared_role, shared_anchor_date) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [gid, role, i, old ? old.duty_id : null, old ? old.employee_id : null,
           old ? old.shared_enabled : 0, old ? old.employee_id_2 : null, old ? old.shared_pattern_id : null, old ? old.shared_role : null, old ? old.shared_anchor_date : null]);
      });
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.matches('.anchor-date')) {
      run("UPDATE duty_groups SET anchor_date=? WHERE id=?", [e.target.value, Number(e.target.dataset.groupId)]);
      saveState(); renderCalendar();
    }
    if (e.target.matches('.block-anchor-date')) {
      const gid = Number(e.target.dataset.dutyGroupId);
      const blockIdx = Number(e.target.dataset.blockIndex);
      run("INSERT INTO block_anchor_dates (duty_group_id, block_index, anchor_date) VALUES (?,?,?) ON CONFLICT(duty_group_id, block_index) DO UPDATE SET anchor_date=excluded.anchor_date",
        [gid, blockIdx, e.target.value]);
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.matches('.shared-pattern-select')) {
      const slotId = Number(e.target.dataset.slotId);
      const newPatternId = Number(e.target.value);
      const pattern = getPattern(newPatternId);
      run("UPDATE duty_group_slots SET shared_pattern_id=?, shared_role=? WHERE id=?", [newPatternId, pattern.roles[0], slotId]);
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.matches('.shared-role-select')) {
      const slotId = Number(e.target.dataset.slotId);
      run("UPDATE duty_group_slots SET shared_role=? WHERE id=?", [e.target.value, slotId]);
      saveState(); renderCalendar();
    }
    if (e.target.matches('.shared-anchor-date')) {
      const slotId = Number(e.target.dataset.slotId);
      run("UPDATE duty_group_slots SET shared_anchor_date=? WHERE id=?", [e.target.value, slotId]);
      saveState(); renderCalendar();
    }
    if (e.target.matches('.primary-pattern-select')) {
      const slotId = Number(e.target.dataset.slotId);
      const newPatternId = Number(e.target.value);
      const pattern = getPattern(newPatternId);
      run("UPDATE duty_group_slots SET primary_pattern_id=?, primary_role=? WHERE id=?", [newPatternId, pattern.roles[0], slotId]);
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.matches('.primary-role-select')) {
      const slotId = Number(e.target.dataset.slotId);
      run("UPDATE duty_group_slots SET primary_role=? WHERE id=?", [e.target.value, slotId]);
      saveState(); renderCalendar();
    }
    if (e.target.matches('.primary-anchor-date')) {
      const slotId = Number(e.target.dataset.slotId);
      run("UPDATE duty_group_slots SET primary_anchor_date=? WHERE id=?", [e.target.value, slotId]);
      saveState(); renderCalendar();
    }
    if (e.target.matches('[data-shared-toggle]')) {
      const slotId = Number(e.target.dataset.sharedToggle);
      const enabled = e.target.checked ? 1 : 0;
      const slot = q("SELECT * FROM duty_group_slots WHERE id=?", [slotId])[0];
      const group = q("SELECT * FROM duty_groups WHERE id=?", [slot.duty_group_id])[0];
      // Sensible first-time defaults so the dropdowns aren't blank the moment
      // it's switched on - both sides start from the block's own rotation,
      // then can be changed independently from there.
      if (enabled) {
        const updates = { shared_enabled: 1 };
        if (!slot.primary_pattern_id) { updates.primary_pattern_id = group.pattern_id; updates.primary_role = slot.role; updates.primary_anchor_date = group.anchor_date; }
        if (!slot.shared_pattern_id) { updates.shared_pattern_id = group.pattern_id; updates.shared_role = slot.role; updates.shared_anchor_date = group.anchor_date; }
        const cols = Object.keys(updates);
        run(`UPDATE duty_group_slots SET ${cols.map(c => c + '=?').join(', ')} WHERE id=?`, [...cols.map(c => updates[c]), slotId]);
      } else {
        run("UPDATE duty_group_slots SET shared_enabled=0 WHERE id=?", [slotId]);
      }
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.matches('[data-individual-toggle]')) {
      const slotId = Number(e.target.dataset.individualToggle);
      const enabled = e.target.checked;
      const slot = q("SELECT * FROM duty_group_slots WHERE id=?", [slotId])[0];
      const group = q("SELECT * FROM duty_groups WHERE id=?", [slot.duty_group_id])[0];
      if (enabled) {
        // Start from the group's own pattern/role/anchor so the pickers
        // aren't blank the moment it's switched on - change freely from there.
        run("UPDATE duty_group_slots SET primary_pattern_id=?, primary_role=?, primary_anchor_date=? WHERE id=?",
          [group.pattern_id, slot.role, group.anchor_date, slotId]);
      } else {
        run("UPDATE duty_group_slots SET primary_pattern_id=NULL, primary_role=NULL, primary_anchor_date=NULL WHERE id=?", [slotId]);
      }
      saveState(); renderDutyGroups(); renderCalendar();
    }
    if (e.target.id === 'weekPicker' || e.target.id === 'numWeeks') renderCalendar();
  });
}
