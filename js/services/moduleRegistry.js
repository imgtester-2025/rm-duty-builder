/* ---------------------------------------------------------------
   MODULE REGISTRY - classifies every feature as CORE (always on) or
   OPTIONAL (user switchable from Settings -> Modules). Optional modules
   register themselves here (each module's own .js file calls
   ModuleRegistry.register({...}) once, at load time). Enabled/disabled
   state is persisted in the settings table (key 'moduleStates') so it
   survives reloads and travels with database backups, the same as any
   other setting.

   Turning an optional module OFF never deletes or hides its data - only
   its own wireX()/renderX() calls (see js/app/bootstrap.js) stop running,
   and its nav tab / buttons / panels are hidden via applyVisibility().
   Turning it back on restores full access to whatever was already there.

   Dependencies: a module can declare `dependencies: ['otherId']`, which
   blocks turning it on until the dependency is on, and blocks turning the
   dependency off while a dependent module is still on. See
   'coverSuggestions' (depends on 'skillsMatrix') for the concrete case
   called out in the modularisation brief - this dependency is intentionally
   soft on the DATA side (the auto-cover engine reads whatever skill scores
   already exist in the database whether or not the Skills Matrix module is
   currently enabled) and hard-enforced only on the UI/toggle side, so
   turning the Skills Matrix module off never makes data-driven cover
   suggestions error out - it just means their scores can't be edited from
   the Skills Matrix screen while it's off.
   --------------------------------------------------------------- */
const ModuleRegistry = (function(){
  const defs = new Map();

  function register(def){
    defs.set(def.id, Object.assign({
      core: false,
      enabled: true,
      dependencies: [],
      hideSelectors: [],
    }, def));
  }

  function get(id){ return defs.get(id); }
  function all(){ return [...defs.values()]; }
  function optional(){ return all().filter(d => !d.core); }

  function isEnabled(id){
    const d = defs.get(id);
    if (!d) return true; // unregistered id (e.g. a core service) - never gated
    return d.core || !!d.enabled;
  }

  function dependents(id){
    return all().filter(d => !d.core && d.dependencies.includes(id));
  }

  function loadStates(){
    let saved = {};
    try {
      const row = q("SELECT value FROM settings WHERE key='moduleStates'")[0];
      if (row) saved = JSON.parse(row.value);
    } catch (e) { saved = {}; }
    defs.forEach(d => {
      if (!d.core && Object.prototype.hasOwnProperty.call(saved, d.id)) d.enabled = !!saved[d.id];
    });
  }

  function persistStates(){
    const out = {};
    defs.forEach(d => { if (!d.core) out[d.id] = !!d.enabled; });
    run("INSERT INTO settings (key, value) VALUES ('moduleStates', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(out)]);
  }

  // Returns {ok:true} or {ok:false, reason:'...'} - never throws, so the
  // Settings UI can just show `reason` back to the person toggling it.
  function setEnabled(id, enabled){
    const d = defs.get(id);
    if (!d) return { ok:false, reason:'Unknown module.' };
    if (d.core) return { ok:false, reason:'This module is core and is always enabled.' };
    if (enabled) {
      const missing = d.dependencies.filter(depId => !isEnabled(depId));
      if (missing.length) {
        const names = missing.map(depId => (get(depId) || { name: depId }).name).join(', ');
        return { ok:false, reason:'Requires ' + names + ' to be enabled first.' };
      }
    } else {
      const blockers = dependents(id).filter(dep => isEnabled(dep.id));
      if (blockers.length) {
        const names = blockers.map(b => b.name).join(', ');
        return { ok:false, reason:'Turn off ' + names + ' first - it depends on this module.' };
      }
    }
    d.enabled = enabled;
    persistStates();
    return { ok:true };
  }

  // Hides every element matched by a disabled module's hideSelectors, via
  // an inline style (not the `hidden` attribute - several hidden targets,
  // e.g. .page.active, are governed by a same-specificity class rule that
  // would otherwise still win). Safe to call repeatedly, e.g. after a
  // re-render that rebuilt some of that markup.
  function applyVisibility(){
    all().forEach(d => {
      if (d.core) return;
      const on = isEnabled(d.id);
      (d.hideSelectors || []).forEach(sel => {
        document.querySelectorAll(sel).forEach(el => { el.style.display = on ? '' : 'none'; });
      });
    });
  }

  // If the page currently marked .active is for a module that just got
  // hidden (either at boot, from a stale "last open tab" left in the DOM
  // markup, or immediately after a toggle), fall back to Duty Builder -
  // always core, so this can never itself land on a hidden page.
  function landOnEnabledTab(){
    const activeTab = document.querySelector('.nav-tab.active');
    if (activeTab && activeTab.style.display !== 'none') return;
    const fallback = document.querySelector('.nav-tab[data-page="pageDutyBuilder"]');
    if (fallback) fallback.click();
  }

  return { register, get, all, optional, isEnabled, dependents, loadStates, persistStates, setEnabled, applyVisibility, landOnEnabledTab };
})();
