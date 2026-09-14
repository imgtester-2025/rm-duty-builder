/* ===================================================================
   RM DUTY BUILDER
   Offline SQLite-backed duty/rota tool. This file is the application's
   entry point: it boots the database, wires every feature module, and
   drives the initial render. See js/services/moduleRegistry.js for the
   CORE vs OPTIONAL module system that decides which of the wireX()/
   renderX() calls below actually run.
   =================================================================== */
'use strict';

// Bumped whenever this file is regenerated, so two copies (e.g. one saved
// on a work computer, one at home) can be told apart at a glance in the
// footer - if they don't match, one is out of date and should be re-downloaded.
const APP_BUILD = '2026-09-10.21';

async function initApp(){
  const stamp = document.getElementById('appBuildStamp');
  if (stamp) stamp.textContent = '(build ' + APP_BUILD + ')';
  SQL = await initSqlJs({ locateFile: () => 'data:application/wasm;base64,' + SQL_WASM_BASE64 });
  wireLockScreen();
  const stored = await idbLoad();

  // Legacy shape: earlier versions stored the raw sqlite bytes directly.
  const isLegacyRaw = stored && (stored instanceof Uint8Array || stored.constructor === Uint8Array || ArrayBuffer.isView(stored));

  if (stored && !isLegacyRaw && stored.format === 'encrypted') {
    lockEnabled = true;
    lockSalt = stored.salt;
    showLockScreen();
    return; // boot continues once wireLockScreen's submit handler confirms the password
  }

  let dbBytes = null;
  if (isLegacyRaw) dbBytes = new Uint8Array(stored);
  else if (stored && stored.format === 'plain') dbBytes = stored.bytes;

  bootWithBytes(dbBytes);
}

function bootWithBytes(dbBytes){
  if (dbBytes) {
    db = new SQL.Database(dbBytes);
    db.run(SCHEMA);
    migrateSchema();
  } else {
    db = new SQL.Database();
    db.run(SCHEMA);
    seedBuiltins();
    saveState();
  }
  document.getElementById('weekPicker').value = toISO(mondayOf(new Date()));

  // Module states are stored in the settings table (see moduleRegistry.js) -
  // load them now that the database is open, before anything checks
  // isEnabled(), and before any optional module's wireX()/renderX() runs.
  ModuleRegistry.loadStates();

  // CORE - always wired, regardless of module settings.
  wireNav();
  wireEmployeesDuties();
  wirePatternsPage();
  wireDutyBuilderPage();
  wireBackupControls();
  wireSettingsPage();
  wireCellOverrideModal();
  wireLockControls();

  // OPTIONAL - each gated on its own ModuleRegistry entry. When a module is
  // off, its wireX() is never called at all: no listeners are registered,
  // no calculations run, and its page/UI stays hidden (see applyVisibility
  // below) - but its data in the database is completely untouched, so
  // turning it back on immediately restores full access to it.
  if (ModuleRegistry.isEnabled('annualLeave')) wireAnnualLeavePage();
  if (ModuleRegistry.isEnabled('sicknessAbsence')) wireOtherAbsencePage();
  if (ModuleRegistry.isEnabled('hoursOvertime')) wireHoursPage();
  if (ModuleRegistry.isEnabled('skillsMatrix')) wireSkillsPage();
  if (ModuleRegistry.isEnabled('uncoveredDuties')) wireUncoveredPanel();
  if (ModuleRegistry.isEnabled('whosOff')) wireWhosOffPanel();
  if (ModuleRegistry.isEnabled('rotaSheet')) wireRotaSheetPage();
  if (ModuleRegistry.isEnabled('printing')) wireDutySheetPrintButton();
  if (ModuleRegistry.isEnabled('excelImportExport')) wireDutySheetExcelExport();

  updateLockStatusUI();
  startAutoLockMonitoring();
  ModuleRegistry.applyVisibility();
  syncAnnualLeaveNavVisibility();
  renderEverything();
  ModuleRegistry.landOnEnabledTab();
}

function seedBuiltins(){
  BUILTIN_PATTERNS.forEach((p, i) => {
    run("INSERT INTO patterns (name, cycle_length, roles_json, weeks_json, start_times_json, built_in, sort_order, block_size) VALUES (?,?,?,?,?,?,?,?)",
      [p.name, p.cycle_length, JSON.stringify(p.roles), JSON.stringify(p.weeks), JSON.stringify(p.start_times), 1, i, p.roles.length]);
  });
  seedCopyrightSettings();
}
// Copyright attribution is stored in the settings table (not hardcoded in
// the templates) so it's data, not markup - kept out of the visible
// Settings UI deliberately, since it isn't meant to be user-editable.
function seedCopyrightSettings(){
  if (!getLabel('copyrightName')) setLabel('copyrightName', 'Brian Davies (Llangefni DO)');
  if (!getLabel('copyrightEmail')) setLabel('copyrightEmail', 'brianllanfairpg@gmail.com');
}
function renderCopyrightFooter(){
  const el = document.getElementById('copyrightFooter');
  if (!el) return;
  const name = getLabel('copyrightName') || '';
  const email = getLabel('copyrightEmail') || '';
  const year = new Date().getFullYear();
  el.innerHTML = `&copy; ${year} ${escapeHtml(name)}` + (email ? ` &middot; <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : '') + `. All rights reserved.`;
}

function renderEverything(){
  applyTabLabels();
  renderCopyrightFooter();
  renderSidebarEmployees();
  renderSidebarDuties();
  renderPatternsList();
  populatePatternSelect();
  renderBuilderPatternTabs();
  renderSheetPatternTabs();
  renderDutyGroups();
  renderSettingsPage();
  renderModulesSettingsPane();
  if (ModuleRegistry.isEnabled('annualLeave')) renderLeaveEmployeeList();
  if (ModuleRegistry.isEnabled('sicknessAbsence')) renderOtherAbsenceEmployeeList();
  if (ModuleRegistry.isEnabled('hoursOvertime')) { renderTimesEmployeeList(); renderOvertimeLog(); }
  if (ModuleRegistry.isEnabled('skillsMatrix')) renderSkillsEmployeeList();
  renderCalendar();
}

// Call this after any create/rename/duplicate/delete of a pattern, since
// both pattern-tab bars and the group/calendar filters depend on the list.
function refreshAfterPatternChange(){
  renderPatternsList();
  populatePatternSelect();
  renderBuilderPatternTabs();
  renderSheetPatternTabs();
  renderDutyGroups();
  renderCalendar();
}

window.addEventListener('DOMContentLoaded', initApp);
