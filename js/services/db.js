let SQL = null, db = null;
const IDB_NAME = 'DutyBuilderSystemDB', IDB_STORE = 'kv', IDB_KEY = 'sqlite-bytes';

function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbLoad(){
  const conn = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbSave(bytes){
  const conn = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------------------------------------------------------
   DATABASE SERVICE - sql.js (SQLite compiled to WASM) is the single
   source of truth, persisted as bytes into IndexedDB (optionally
   AES-GCM encrypted - see services/security.js). Every other module
   reads/writes exclusively through q()/run()/lastId() below, and calls
   saveState() after any write - there is no other path to persistence.
   --------------------------------------------------------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS duties (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT DEFAULT '', name TEXT NOT NULL, group_label TEXT DEFAULT '',
  duty_type TEXT NOT NULL DEFAULT 'CORE'
);
CREATE TABLE IF NOT EXISTS patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cycle_length INTEGER NOT NULL,
  roles_json TEXT NOT NULL,
  weeks_json TEXT NOT NULL,
  start_times_json TEXT DEFAULT '{}',
  built_in INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  block_size INTEGER
);
CREATE TABLE IF NOT EXISTS duty_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pattern_id INTEGER,
  anchor_date TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS block_anchor_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_group_id INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  anchor_date TEXT NOT NULL,
  UNIQUE(duty_group_id, block_index)
);
CREATE TABLE IF NOT EXISTS duty_group_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_group_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  slot_order INTEGER DEFAULT 0,
  duty_id INTEGER,
  employee_id INTEGER,
  shared_enabled INTEGER DEFAULT 0,
  employee_id_2 INTEGER,
  shared_pattern_id INTEGER,
  shared_role TEXT,
  shared_anchor_date TEXT,
  primary_pattern_id INTEGER,
  primary_role TEXT,
  primary_anchor_date TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS bank_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS annual_leave (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  week_date TEXT NOT NULL,
  source_label TEXT DEFAULT '',
  UNIQUE(employee_id, week_date)
);
CREATE TABLE IF NOT EXISTS other_absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  type TEXT NOT NULL,
  note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS employee_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  duty_id INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 1,
  UNIQUE(employee_id, duty_id)
);
CREATE TABLE IF NOT EXISTS cell_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  date_iso TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  overtime_minutes INTEGER DEFAULT 0,
  UNIQUE(slot_id, date_iso)
);
CREATE TABLE IF NOT EXISTS employee_times (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  weekday TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  UNIQUE(employee_id, weekday)
);
CREATE TABLE IF NOT EXISTS overtime_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL,
  date_iso TEXT NOT NULL,
  reason TEXT NOT NULL,
  minutes INTEGER NOT NULL
);
`;

function q(sql, params){ const st=db.prepare(sql); if(params) st.bind(params); const rows=[]; while(st.step()) rows.push(st.getAsObject()); st.free(); return rows; }
function run(sql, params){ db.run(sql, params||[]); }
function lastId(){ return db.exec("SELECT last_insert_rowid() AS id")[0].values[0][0]; }

// Adds any columns introduced after a person's DB was first created,
// so older saved files upgrade in place without losing data.
function migrateSchema(){
  const cols = q("PRAGMA table_info(duty_groups)").map(r => r.name);
  if (!cols.includes('pinned')) {
    run("ALTER TABLE duty_groups ADD COLUMN pinned INTEGER DEFAULT 0");
  }
  const slotCols = q("PRAGMA table_info(duty_group_slots)").map(r => r.name);
  [
    ['shared_enabled', 'INTEGER DEFAULT 0'],
    ['employee_id_2', 'INTEGER'],
    ['shared_pattern_id', 'INTEGER'],
    ['shared_role', 'TEXT'],
    ['shared_anchor_date', 'TEXT'],
    ['primary_pattern_id', 'INTEGER'],
    ['primary_role', 'TEXT'],
    ['primary_anchor_date', 'TEXT'],
  ].forEach(([col, type]) => {
    if (!slotCols.includes(col)) run(`ALTER TABLE duty_group_slots ADD COLUMN ${col} ${type}`);
  });
  run("CREATE TABLE IF NOT EXISTS bank_holidays (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT UNIQUE NOT NULL, name TEXT NOT NULL)");
  run("CREATE TABLE IF NOT EXISTS block_anchor_dates (id INTEGER PRIMARY KEY AUTOINCREMENT, duty_group_id INTEGER NOT NULL, block_index INTEGER NOT NULL, anchor_date TEXT NOT NULL, UNIQUE(duty_group_id, block_index))");
  run("CREATE TABLE IF NOT EXISTS annual_leave (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, week_date TEXT NOT NULL, source_label TEXT DEFAULT '', UNIQUE(employee_id, week_date))");
  run("CREATE TABLE IF NOT EXISTS other_absences (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT, type TEXT NOT NULL, note TEXT DEFAULT '')");
  run("CREATE TABLE IF NOT EXISTS employee_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, duty_id INTEGER NOT NULL, score INTEGER NOT NULL DEFAULT 1, UNIQUE(employee_id, duty_id))");
  run("CREATE TABLE IF NOT EXISTS cell_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER NOT NULL, date_iso TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, overtime_minutes INTEGER DEFAULT 0, UNIQUE(slot_id, date_iso))");
  run("CREATE TABLE IF NOT EXISTS employee_times (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, weekday TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, UNIQUE(employee_id, weekday))");
  const ovCols = q("PRAGMA table_info(cell_overrides)").map(r => r.name);
  if (!ovCols.includes('overtime_minutes')) {
    run("ALTER TABLE cell_overrides ADD COLUMN overtime_minutes INTEGER DEFAULT 0");
  }
  run("CREATE TABLE IF NOT EXISTS overtime_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER NOT NULL, date_iso TEXT NOT NULL, reason TEXT NOT NULL, minutes INTEGER NOT NULL)");
  // One-off migration: fold the old single "agreed minutes" field (from
  // before overtime reasons existed) into the new entries table as a
  // "late finish" entry, then never touch it again.
  if (!getLabel('migratedLegacyOvertimeMinutes')) {
    const legacy = q("SELECT * FROM cell_overrides WHERE overtime_minutes > 0");
    legacy.forEach(row => {
      run("INSERT INTO overtime_entries (slot_id, date_iso, reason, minutes) VALUES (?,?,?,?)",
        [row.slot_id, row.date_iso, 'LATE_FINISH', row.overtime_minutes]);
    });
    setLabel('migratedLegacyOvertimeMinutes', '1');
  }
  const patCols = q("PRAGMA table_info(patterns)").map(r => r.name);
  if (!patCols.includes('block_size')) {
    run("ALTER TABLE patterns ADD COLUMN block_size INTEGER");
    // Backfill: for a pattern whose cycle is 4 or 5 weeks - matching the two
    // built-in templates - default to that natural block size (4 or 5) even
    // if the pattern's roles have since been expanded well beyond that,
    // since that's almost always what someone actually wants to see per row.
    // Anything with an unusual cycle length just falls back to "one block".
    q("SELECT id, cycle_length, roles_json FROM patterns").forEach(p => {
      const roleCount = JSON.parse(p.roles_json).length;
      const guess = (p.cycle_length === 4 || p.cycle_length === 5) ? Math.min(p.cycle_length, roleCount) : roleCount;
      run("UPDATE patterns SET block_size=? WHERE id=?", [guess, p.id]);
    });
  }
  // One-off correction for anyone who already picked up block_size before
  // this smarter guess existed (it would have defaulted to the full,
  // already-expanded role count instead of 4/5) - only touches patterns
  // that still show every role in one row and haven't been adjusted by hand.
  if (!getLabel('migratedBlockSizeGuess')) {
    q("SELECT id, cycle_length, roles_json, block_size FROM patterns WHERE built_in=0").forEach(p => {
      const roleCount = JSON.parse(p.roles_json).length;
      if (p.block_size === roleCount && roleCount > 5 && (p.cycle_length === 4 || p.cycle_length === 5)) {
        run("UPDATE patterns SET block_size=? WHERE id=?", [p.cycle_length, p.id]);
      }
    });
    setLabel('migratedBlockSizeGuess', '1');
  }
  // One-off backfill: shared duties used to leave the first person following
  // the group's own pattern - now both sides always have their own. Give
  // existing shared slots a starting point (matching what they already
  // showed) instead of appearing unconfigured after this update.
  if (!getLabel('migratedSharedPrimaryPattern')) {
    q("SELECT id, duty_group_id, role FROM duty_group_slots WHERE shared_enabled=1 AND primary_pattern_id IS NULL").forEach(s => {
      const g = q("SELECT * FROM duty_groups WHERE id=?", [s.duty_group_id])[0];
      if (!g) return;
      run("UPDATE duty_group_slots SET primary_pattern_id=?, primary_role=?, primary_anchor_date=? WHERE id=?",
        [g.pattern_id, s.role, g.anchor_date, s.id]);
    });
    setLabel('migratedSharedPrimaryPattern', '1');
  }
  // other_absences moved from one row per day to one row per continuous
  // block (start_date, nullable end_date = still ongoing). Rebuild the
  // table for any database still on the old day-level schema, preserving
  // each existing row as its own single-day block rather than trying to
  // guess which adjacent days belonged together.
  const otherAbsCols = q("PRAGMA table_info(other_absences)").map(c => c.name);
  if (otherAbsCols.includes('date') && !otherAbsCols.includes('start_date')) {
    run("CREATE TABLE other_absences_new (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT, type TEXT NOT NULL, note TEXT DEFAULT '')");
    run("INSERT INTO other_absences_new (id, employee_id, start_date, end_date, type, note) SELECT id, employee_id, date, date, type, note FROM other_absences");
    run("DROP TABLE other_absences");
    run("ALTER TABLE other_absences_new RENAME TO other_absences");
  }
  // Duties can now be marked CORE (a real round that needs covering every
  // working day) or COVER (a DOC/WOC/Leave-Cover style duty whose whole
  // job is covering others - it never itself generates a "needs cover"
  // gap). Existing duties default to CORE, which is the safe assumption
  // for anything set up before this distinction existed.
  const dutyCols = q("PRAGMA table_info(duties)").map(c => c.name);
  if (!dutyCols.includes('duty_type')) {
    run("ALTER TABLE duties ADD COLUMN duty_type TEXT NOT NULL DEFAULT 'CORE'");
  }
  // Skills moved from a plain yes/no checkbox to a 0-10 proficiency score,
  // so the auto-cover engine can prefer a more experienced person over a
  // merely-capable one. Existing ticked skills default to 1 (some
  // recorded ability) rather than the new default of 1 for freshly-added
  // ones - both start the same, existing data just carries forward as-is.
  const skillCols = q("PRAGMA table_info(employee_skills)").map(c => c.name);
  if (!skillCols.includes('score')) {
    run("ALTER TABLE employee_skills ADD COLUMN score INTEGER NOT NULL DEFAULT 1");
  }
  repairIncompletePatternWeeks();
  seedCopyrightSettings();
}

// A pattern's roles_json lists every role it has; every week in
// weeks_json should have an entry for every one of those roles. If any
// role is missing from any week - however that happened - reading that
// cell throws and can silently blank a whole rotation pattern editor or
// crash pages that compute someone's day (Rota Sheet, auto-cover, Duty
// Sheet all route through this data for every cell). Runs on every load;
// finds nothing and does nothing once a pattern is actually consistent.
function repairIncompletePatternWeeks(){
  const patterns = q("SELECT * FROM patterns");
  patterns.forEach(row => {
    let roles, weeks;
    try { roles = JSON.parse(row.roles_json); weeks = JSON.parse(row.weeks_json); }
    catch (e) { return; } // malformed JSON entirely is a separate, rarer problem - leave it rather than guess
    let changed = false;
    for (let w = 1; w <= row.cycle_length; w++) {
      if (!weeks[w]) { weeks[w] = {}; changed = true; }
      roles.forEach(role => {
        if (!weeks[w][role]) {
          // Prefer copying the same role's schedule from whichever other
          // week does have it, so a role that's simply missing one week
          // out of several keeps the rest of its own rotation intact,
          // rather than resetting the whole role to blank OFF days.
          const anyWeekWithRole = Object.keys(weeks).find(wk => weeks[wk][role]);
          weeks[w][role] = anyWeekWithRole ? weeks[anyWeekWithRole][role] : W(OF,OF,OF,OF,OF,OF);
          changed = true;
        }
      });
    }
    if (changed) run("UPDATE patterns SET weeks_json=? WHERE id=?", [JSON.stringify(weeks), row.id]);
  });
}

// Saves are queued rather than fired independently: db.export() happens
// synchronously at call time (so each write captures exactly the state at
// the moment it was requested), but the actual encrypt+IndexedDB-write work
// is chained onto a single running queue. Without this, two saves fired
// close together race - if the first happens to finish encrypting *after*
// the second, its now-stale bytes would land in IndexedDB last and silently
// overwrite the newer save. Chaining guarantees writes complete in the same
// order they were requested, never out of order.
let saveQueue = Promise.resolve();
function saveState(){
  // Any write invalidates the per-date caches above - the next read for
  // any date recomputes fresh rather than risking a stale answer.
  _slotStatusCache.clear();
  _autoCoverCache.clear();
  const bytes = db.export();
  const keyAtCallTime = cryptoKey;
  const saltAtCallTime = lockSalt;
  saveQueue = saveQueue.then(async () => {
    try {
      if (keyAtCallTime) {
        const {iv, ciphertext} = await encryptBytes(keyAtCallTime, bytes);
        await idbSave({format:'encrypted', salt: saltAtCallTime, iv, ciphertext});
      } else {
        await idbSave({format:'plain', bytes});
      }
    } catch (err) { console.error('IndexedDB save failed', err); }
  });
  const el = document.getElementById('savedIndicator');
  if (el) {
    el.textContent = 'Saved ' + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    el.classList.add('flash');
    setTimeout(()=>el.classList.remove('flash'), 600);
  }
  return saveQueue;
}

function getLabel(key){
  const row = q("SELECT value FROM settings WHERE key=?", [key])[0];
  return row ? row.value : DEFAULT_LABELS[key];
}
function setLabel(key, value){
  run("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
}
const DEFAULT_FISCAL_YEAR_START = '2026-03-30'; // Royal Mail FY2026/27 Week 1
function getFiscalYearStart(){
  const row = q("SELECT value FROM settings WHERE key='fiscalYearStart'")[0];
  return row ? row.value : DEFAULT_FISCAL_YEAR_START;
}
function fiscalWeekNumber(dateISO){
  const anchor = mondayOf(parseISO(getFiscalYearStart()));
  const date = mondayOf(parseISO(dateISO));
  const diffWeeks = Math.floor((date - anchor) / (7 * 86400000));
  return diffWeeks + 1;
}
