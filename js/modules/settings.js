/* ---------------------------------------------------------------
   SETTINGS - renameable tab labels, bank holidays, fiscal year week
   numbering, and (new) the Modules tab where optional features are
   switched on/off. CORE.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'settings', name: 'Settings', core: true,
  description: 'Tab renaming, bank holidays, fiscal year numbering, and the Modules tab itself.'
});

// England & Wales bank holidays, verified against the official GOV.UK list
// (gov.uk/bank-holidays) as of the dates this app was built. Add/edit/delete
// freely on the Settings > Bank Holidays tab - these are just a quick-start.
const QUICK_ADD_HOLIDAYS = [
  {date:'2026-01-01', name:"New Year's Day"},
  {date:'2026-04-03', name:'Good Friday'},
  {date:'2026-04-06', name:'Easter Monday'},
  {date:'2026-05-04', name:'Early May bank holiday'},
  {date:'2026-05-25', name:'Spring bank holiday'},
  {date:'2026-08-31', name:'Summer bank holiday'},
  {date:'2026-12-25', name:'Christmas Day'},
  {date:'2026-12-28', name:'Boxing Day (substitute day)'},
  {date:'2027-01-01', name:"New Year's Day"},
  {date:'2027-03-26', name:'Good Friday'},
  {date:'2027-03-29', name:'Easter Monday'},
  {date:'2027-05-03', name:'Early May bank holiday'},
  {date:'2027-05-31', name:'Spring bank holiday'},
  {date:'2027-08-30', name:'Summer bank holiday'},
  {date:'2027-12-27', name:'Christmas Day (substitute day)'},
  {date:'2027-12-28', name:'Boxing Day (substitute day)'},
];

function applyTabLabels(){
  document.querySelectorAll('[data-labelkey]').forEach(el => {
    el.textContent = getLabel(el.dataset.labelkey);
  });
}
function renderSettingsPage(){
  const navKeys = ['navDutyBuilder','navDutySheet','navAnnualLeave','navHours','navRotaSheet','navPatterns','navSettings'];
  const sidebarKeys = ['sidebarEmployees','sidebarDuties'];
  const navWrap = document.getElementById('navLabelSettings');
  const sideWrap = document.getElementById('sidebarLabelSettings');
  navWrap.innerHTML = navKeys.map(k => `
    <div class="settings-row">
      <label for="lbl_${k}">${escapeHtml(DEFAULT_LABELS[k])}</label>
      <input type="text" id="lbl_${k}" data-labelsetting="${k}" value="${escapeHtml(getLabel(k))}">
    </div>`).join('');
  sideWrap.innerHTML = sidebarKeys.map(k => `
    <div class="settings-row">
      <label for="lbl_${k}">${escapeHtml(DEFAULT_LABELS[k])}</label>
      <input type="text" id="lbl_${k}" data-labelsetting="${k}" value="${escapeHtml(getLabel(k))}">
    </div>`).join('');
  renderHolidaysList();
  document.getElementById('fiscalYearStartInput').value = getFiscalYearStart();
}

function renderHolidaysList(){
  const wrap = document.getElementById('holidaysList');
  if (!wrap) return;
  const holidays = q("SELECT * FROM bank_holidays ORDER BY date");
  if (holidays.length === 0) {
    wrap.innerHTML = '<p class="empty-hint">No holidays added yet.</p>';
    return;
  }
  wrap.innerHTML = holidays.map(h => {
    const d = parseISO(h.date);
    const display = d.toLocaleDateString('en-GB', {weekday:'short', day:'2-digit', month:'short', year:'numeric', timeZone:'UTC'});
    return `<div class="holiday-row">
      <span class="holiday-date">${display}</span>
      <span class="holiday-name">${escapeHtml(h.name)}</span>
      <button class="chip-del" data-del-holiday="${h.id}" title="Delete">&times;</button>
    </div>`;
  }).join('');
}

// Renders the Settings -> Modules tab: one row per registered module,
// CORE ones shown as always-on for transparency, OPTIONAL ones with a
// working toggle. Re-run after every toggle so dependency-blocked
// checkboxes reflect the current state immediately.
function renderModulesSettingsPane(){
  const wrap = document.getElementById('modulesSettingsList');
  if (!wrap) return;
  const modules = ModuleRegistry.all();
  wrap.innerHTML = modules.map(m => {
    const on = ModuleRegistry.isEnabled(m.id);
    if (m.core) {
      return `<div class="module-row module-row-core">
        <div class="module-row-head">
          <span class="module-row-name">${escapeHtml(m.name)}</span>
          <span class="module-core-badge">Core - Always Enabled</span>
        </div>
        <p class="module-row-desc">${escapeHtml(m.description || '')}</p>
      </div>`;
    }
    const deps = (m.dependencies || []).map(id => (ModuleRegistry.get(id) || {name:id}).name);
    const depsNote = deps.length ? `<p class="module-row-deps">Requires: ${escapeHtml(deps.join(', '))}</p>` : '';
    return `<div class="module-row">
      <div class="module-row-head">
        <span class="module-row-name">${escapeHtml(m.name)}</span>
        <label class="module-toggle">
          <input type="checkbox" data-module-toggle="${m.id}" ${on ? 'checked' : ''}>
          <span class="module-toggle-track"><span class="module-toggle-thumb"></span></span>
        </label>
      </div>
      <p class="module-row-desc">${escapeHtml(m.description || '')}</p>
      ${depsNote}
    </div>`;
  }).join('');
}

function wireSettingsPage(){
  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(btn.dataset.settingspane).classList.add('active');
    });
  });

  document.addEventListener('change', e => {
    if (e.target.matches('[data-labelsetting]')) {
      const key = e.target.dataset.labelsetting;
      const value = e.target.value.trim() || DEFAULT_LABELS[key];
      setLabel(key, value);
      e.target.value = value;
      saveState();
      applyTabLabels();
    }
  });
  document.getElementById('resetLabelsBtn').addEventListener('click', () => {
    if (!confirm('Reset all tab names back to their defaults?')) return;
    Object.keys(DEFAULT_LABELS).forEach(k => run("DELETE FROM settings WHERE key=?", [k]));
    saveState();
    applyTabLabels();
    renderSettingsPage();
  });

  document.getElementById('fiscalYearStartInput').addEventListener('change', e => {
    const val = e.target.value || DEFAULT_FISCAL_YEAR_START;
    setLabel('fiscalYearStart', val);
    e.target.value = val;
    saveState();
    renderOvertimeLog();
  });

  document.getElementById('addHolidayForm').addEventListener('submit', e => {
    e.preventDefault();
    const dateInput = document.getElementById('newHolidayDate');
    const nameInput = document.getElementById('newHolidayName');
    const date = dateInput.value;
    const name = nameInput.value.trim();
    if (!date || !name) return;
    const existing = q("SELECT id FROM bank_holidays WHERE date=?", [date])[0];
    if (existing) {
      if (!confirm('A holiday is already set for this date. Replace its name with "' + name + '"?')) return;
      run("UPDATE bank_holidays SET name=? WHERE date=?", [name, date]);
    } else {
      run("INSERT INTO bank_holidays (date, name) VALUES (?,?)", [date, name]);
    }
    dateInput.value = ''; nameInput.value = '';
    saveState();
    renderHolidaysList();
    renderCalendar();
  });

  document.getElementById('exportHolidaysBtn').addEventListener('click', exportBankHolidays);
  document.getElementById('importHolidaysInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    await importBankHolidaysFromFile(file);
    e.target.value = '';
  });

  document.getElementById('quickAddHolidaysBtn').addEventListener('click', () => {
    const before = q("SELECT COUNT(*) AS c FROM bank_holidays")[0].c;
    QUICK_ADD_HOLIDAYS.forEach(h => run("INSERT OR IGNORE INTO bank_holidays (date, name) VALUES (?,?)", [h.date, h.name]));
    const after = q("SELECT COUNT(*) AS c FROM bank_holidays")[0].c;
    saveState();
    renderHolidaysList();
    renderCalendar();
    alert(`Added ${after - before} new bank holiday(s). ${QUICK_ADD_HOLIDAYS.length - (after - before)} were already in your list.`);
  });

  document.addEventListener('click', e => {
    if (e.target.matches('[data-del-holiday]')) {
      const id = Number(e.target.dataset.delHoliday);
      run("DELETE FROM bank_holidays WHERE id=?", [id]);
      saveState();
      renderHolidaysList();
      renderCalendar();
    }
  });

  // Module toggles reload the app after persisting the change, rather than
  // trying to live-wire/unwire listeners for the module being switched on
  // or off - this app wires every feature's event listeners exactly once
  // at boot (see bootstrap.js), so a clean reload is what avoids ending up
  // with duplicated listeners after a module is toggled on, off, and on
  // again. The database (already saved before reload) and the new module
  // state (persisted in the settings table) both survive the reload.
  document.addEventListener('change', e => {
    if (e.target.matches('[data-module-toggle]')) {
      const id = e.target.dataset.moduleToggle;
      const wantEnabled = e.target.checked;
      const result = ModuleRegistry.setEnabled(id, wantEnabled);
      if (!result.ok) {
        alert("Can't do that: " + result.reason);
        e.target.checked = !wantEnabled;
        return;
      }
      saveState().then(() => location.reload());
    }
  });
}
