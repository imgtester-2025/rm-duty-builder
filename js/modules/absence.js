/* ---------------------------------------------------------------
   SICKNESS & OTHER ABSENCE - day-level (not week-level like Annual
   Leave), each entry shown in its own colour on the Duty Sheet. OPTIONAL.
   --------------------------------------------------------------- */
// NOTE: shares its nav page/tab with Annual Leave (pageAnnualLeave) as a
// sub-tab - see the comment in modules/annualLeave.js.
ModuleRegistry.register({
  id: 'sicknessAbsence', name: 'Sickness / Other Absence', core: false,
  hideSelectors: ['.absence-tab[data-absencepane="paneOtherAbsence"]', '#paneOtherAbsence'],
  description: 'Day-level sickness and other-absence tracking per employee, each shown in its own colour on the Duty Sheet.'
});

// The Annual Leave / Sickness page shares one nav tab for two independently
// toggleable sub-tabs - hide the parent nav tab only when BOTH are off
// (otherwise hiding just the sub-tab/pane above is enough), and if the
// active sub-tab was just hidden, switch to whichever one is still on.
function syncAnnualLeaveNavVisibility(){
  const navTab = document.querySelector('.nav-tab[data-page="pageAnnualLeave"]');
  const alOn = ModuleRegistry.isEnabled('annualLeave');
  const absOn = ModuleRegistry.isEnabled('sicknessAbsence');
  if (navTab) navTab.style.display = (alOn || absOn) ? '' : 'none';
  const activeSubTab = document.querySelector('.absence-tab.active');
  const activeHidden = activeSubTab && activeSubTab.style.display === 'none';
  if (activeHidden) {
    const fallback = Array.from(document.querySelectorAll('.absence-tab')).find(b => b.style.display !== 'none');
    if (fallback) fallback.click();
  }
}

function renderOtherAbsenceEmployeeList(){
  if (!ModuleRegistry.isEnabled('sicknessAbsence')) return;
  const container = document.getElementById('otherAbsenceEmployeeList');
  if (!container) return;
  const search = (document.getElementById('otherAbsenceEmployeeSearch').value || '').toLowerCase();
  const employees = q("SELECT * FROM employees ORDER BY name COLLATE NOCASE").filter(e => e.name.toLowerCase().includes(search));
  container.innerHTML = employees.map(emp => {
    const entries = q("SELECT * FROM other_absences WHERE employee_id=? ORDER BY start_date DESC", [emp.id]);
    const chips = entries.map(en => {
      const startD = parseISO(en.start_date);
      const dateRange = en.end_date
        ? `${escapeHtml(fmtShort(startD))} &ndash; ${escapeHtml(fmtShort(parseISO(en.end_date)))}`
        : `${escapeHtml(fmtShort(startD))} &ndash; <em>ongoing</em>`;
      return `<span class="absence-entry-chip type-${en.type.toLowerCase()}">
        <strong>${en.type === 'SICK' ? 'Sick' : 'Other'}</strong> ${dateRange}${en.note ? ' &ndash; ' + escapeHtml(en.note) : ''}
        <button class="btn-icon" data-edit-other-absence="${en.id}" title="Edit">&#9998;</button>
        <button class="chip-del" data-del-other-absence="${en.id}" title="Remove">&times;</button>
      </span>
      <div class="absence-add-inline" id="otherAbsenceEditInline_${en.id}">
        <select id="otherAbsenceEditType_${en.id}">
          <option value="SICK" ${en.type==='SICK'?'selected':''}>Sickness</option>
          <option value="OTHER" ${en.type==='OTHER'?'selected':''}>Other</option>
        </select>
        <input type="date" id="otherAbsenceEditStart_${en.id}" value="${en.start_date}">
        <span style="font-size:11px;color:#888;">to (blank = ongoing)</span>
        <input type="date" id="otherAbsenceEditEnd_${en.id}" value="${en.end_date || ''}">
        <input type="text" id="otherAbsenceEditNote_${en.id}" placeholder="Note (optional)" style="width:140px;" value="${escapeHtml(en.note || '')}">
        <button class="btn btn-primary btn-sm" data-confirm-edit-other-absence="${en.id}">Save</button>
        <button class="btn btn-sm" data-cancel-edit-other-absence="${en.id}">Cancel</button>
      </div>`;
    }).join('');
    return `<div class="leave-emp-row" data-emp-id="${emp.id}">
      <div class="leave-emp-head">
        <span class="leave-emp-name">${escapeHtml(emp.name)}</span>
        <span class="leave-count-badge ${entries.length ? 'has-leave' : ''}">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
        <button class="btn btn-sm" data-toggle-other-absence="${emp.id}">${entries.length ? 'Show/hide' : 'Add first entry'}</button>
        <button class="btn btn-sm" data-show-add-other-absence="${emp.id}">+ Add absence</button>
      </div>
      <div class="absence-add-inline" id="otherAbsenceAddInline_${emp.id}">
        <select id="otherAbsenceType_${emp.id}">
          <option value="SICK">Sickness</option>
          <option value="OTHER">Other</option>
        </select>
        <input type="date" id="otherAbsenceStart_${emp.id}">
        <span style="font-size:11px;color:#888;">to (blank = ongoing)</span>
        <input type="date" id="otherAbsenceEnd_${emp.id}">
        <input type="text" id="otherAbsenceNote_${emp.id}" placeholder="Note (optional)" style="width:140px;">
        <button class="btn btn-primary btn-sm" data-confirm-add-other-absence="${emp.id}">Add</button>
        <button class="btn btn-sm" data-cancel-add-other-absence="${emp.id}">Cancel</button>
      </div>
      <div class="leave-weeks-list" id="otherAbsenceList_${emp.id}">${chips || '<span class="empty-hint">No absences recorded.</span>'}</div>
    </div>`;
  }).join('');
}

function wireOtherAbsencePage(){
  document.getElementById('otherAbsenceEmployeeSearch').addEventListener('input', renderOtherAbsenceEmployeeList);
  document.getElementById('exportOtherAbsenceBtn').addEventListener('click', exportOtherAbsence);
  document.getElementById('importOtherAbsenceInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    await importOtherAbsenceFromFile(file);
    e.target.value = '';
  });

  document.querySelectorAll('.absence-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.absence-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.absence-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(btn.dataset.absencepane).classList.add('active');
    });
  });

  document.addEventListener('click', e => {
    if (e.target.matches('[data-toggle-other-absence]')) {
      document.getElementById('otherAbsenceList_' + e.target.dataset.toggleOtherAbsence).classList.toggle('open');
    }
    if (e.target.matches('[data-show-add-other-absence]')) {
      document.getElementById('otherAbsenceAddInline_' + e.target.dataset.showAddOtherAbsence).classList.add('open');
    }
    if (e.target.matches('[data-cancel-add-other-absence]')) {
      document.getElementById('otherAbsenceAddInline_' + e.target.dataset.cancelAddOtherAbsence).classList.remove('open');
    }
    if (e.target.matches('[data-confirm-add-other-absence]')) {
      const id = Number(e.target.dataset.confirmAddOtherAbsence);
      const type = document.getElementById('otherAbsenceType_' + id).value;
      const startVal = document.getElementById('otherAbsenceStart_' + id).value;
      const endVal = document.getElementById('otherAbsenceEnd_' + id).value || null; // blank = ongoing
      const note = document.getElementById('otherAbsenceNote_' + id).value.trim();
      if (!startVal) return;
      if (endVal && parseISO(endVal) < parseISO(startVal)) { alert('The end date must be on or after the start date.'); return; }
      if (endVal && Math.round((parseISO(endVal) - parseISO(startVal)) / 86400000) > 730) { alert('That range is over 2 years - please check the dates.'); return; }
      run("INSERT INTO other_absences (employee_id, start_date, end_date, type, note) VALUES (?,?,?,?,?)", [id, startVal, endVal, type, note]);
      saveState();
      renderOtherAbsenceEmployeeList();
      renderCalendar();
      const list = document.getElementById('otherAbsenceList_' + id);
      if (list) list.classList.add('open');
    }
    if (e.target.matches('[data-edit-other-absence]')) {
      document.getElementById('otherAbsenceEditInline_' + e.target.dataset.editOtherAbsence).classList.add('open');
    }
    if (e.target.matches('[data-cancel-edit-other-absence]')) {
      document.getElementById('otherAbsenceEditInline_' + e.target.dataset.cancelEditOtherAbsence).classList.remove('open');
    }
    if (e.target.matches('[data-confirm-edit-other-absence]')) {
      const id = Number(e.target.dataset.confirmEditOtherAbsence);
      const type = document.getElementById('otherAbsenceEditType_' + id).value;
      const startVal = document.getElementById('otherAbsenceEditStart_' + id).value;
      const endVal = document.getElementById('otherAbsenceEditEnd_' + id).value || null; // blank = ongoing
      const note = document.getElementById('otherAbsenceEditNote_' + id).value.trim();
      if (!startVal) { alert('A start date is required.'); return; }
      if (endVal && parseISO(endVal) < parseISO(startVal)) { alert('The end date must be on or after the start date.'); return; }
      run("UPDATE other_absences SET start_date=?, end_date=?, type=?, note=? WHERE id=?", [startVal, endVal, type, note, id]);
      saveState();
      renderOtherAbsenceEmployeeList();
      renderCalendar();
    }
    if (e.target.matches('[data-del-other-absence]')) {
      const id = Number(e.target.dataset.delOtherAbsence);
      run("DELETE FROM other_absences WHERE id=?", [id]);
      saveState();
      renderOtherAbsenceEmployeeList();
      renderCalendar();
    }
  });
}

