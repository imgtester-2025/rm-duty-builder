/* ---------------------------------------------------------------
   ANONYMISED DEMO COPY - operates entirely on an in-memory CLONE of
   the live database; the real db object is never touched. Employee
   names, duty/round names, group names, and custom-pattern role
   names all get replaced with realistic sample values, and any
   manual override label that happens to exactly match one of those
   real values gets swapped too, so a typed-in name or duty code
   doesn't slip through.
   --------------------------------------------------------------- */
const DEMO_FIRST_NAMES = ['James','John','Robert','Michael','William','David','Richard','Thomas','Charles','Daniel',
  'Matthew','Mark','Paul','Steven','Andrew','Kenneth','Emma','Olivia','Sophia','Isabella','Charlotte','Amelia','Mia',
  'Harper','Evelyn','Abigail','Sarah','Laura','Rachel','Emily','Rebecca','Helen','Karen','Susan','Angela','Julie',
  'Diane','Christine','Margaret','Catherine'];
const DEMO_LAST_NAMES = ['Smith','Jones','Williams','Brown','Taylor','Davies','Evans','Wilson','Thomas','Roberts',
  'Johnson','Lewis','Walker','Robinson','Wood','Thompson','White','Watson','Jackson','Wright','Green','Harris',
  'Cooper','King','Lee','Baker','Hall','Clarke','Turner','Hill','Scott','Adams','Bell','Ward','Cook','Morris',
  'Bailey','Parker','Young','Kelly'];

function shuffledCopy(arr){
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildAnonymisedCopy(){
  const copy = new SQL.Database(db.export());
  const cq = (sql, params) => { const st = copy.prepare(sql); if (params) st.bind(params); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; };
  const crun = (sql, params) => copy.run(sql, params || []);

  const nameMap = new Map(); // any real value (lowercased) -> its sample replacement

  // Employees -> realistic sample names
  const firstNames = shuffledCopy(DEMO_FIRST_NAMES), lastNames = shuffledCopy(DEMO_LAST_NAMES);
  cq("SELECT id, name FROM employees").forEach((e, i) => {
    const fn = firstNames[i % firstNames.length];
    const ln = lastNames[Math.floor(i / firstNames.length) % lastNames.length];
    const newName = fn + ' ' + ln + (i >= firstNames.length * lastNames.length ? ' ' + (i + 1) : '');
    nameMap.set(e.name.trim().toLowerCase(), newName);
    crun("UPDATE employees SET name=? WHERE id=?", [newName, e.id]);
  });

  // Duties -> generic round codes/names; group_label -> generic zone letters
  const groupLabelMap = new Map();
  cq("SELECT id, code, name, group_label FROM duties").forEach((d, i) => {
    const newCode = 'R' + String(i + 1).padStart(2, '0');
    const newName = 'Sample Round ' + (i + 1);
    let newGroupLabel = '';
    if (d.group_label) {
      if (!groupLabelMap.has(d.group_label)) groupLabelMap.set(d.group_label, 'Zone ' + String.fromCharCode(65 + groupLabelMap.size));
      newGroupLabel = groupLabelMap.get(d.group_label);
    }
    if (d.name) nameMap.set(d.name.trim().toLowerCase(), newName);
    if (d.code) nameMap.set(d.code.trim().toLowerCase(), newCode);
    crun("UPDATE duties SET code=?, name=?, group_label=? WHERE id=?", [newCode, newName, newGroupLabel, d.id]);
  });

  // Duty groups -> generic office names
  cq("SELECT id, name FROM duty_groups").forEach((g, i) => {
    nameMap.set(g.name.trim().toLowerCase(), 'Demo Office ' + (i + 1));
    crun("UPDATE duty_groups SET name=? WHERE id=?", ['Demo Office ' + (i + 1), g.id]);
  });

  // Custom patterns -> generic pattern + role names (built-ins already use
  // plain "Duty 1/2/3/DOC" naming, which isn't identifying, so left as-is).
  cq("SELECT * FROM patterns WHERE built_in=0").forEach((p, pi) => {
    const roles = JSON.parse(p.roles_json);
    const weeks = JSON.parse(p.weeks_json);
    const roleRenames = new Map();
    const roleRenamesLower = new Map(); // case-insensitive lookup for matching cell labels
    roles.forEach((r, ri) => {
      const newRole = 'Round ' + String.fromCharCode(65 + (pi % 26)) + (ri + 1);
      roleRenames.set(r, newRole);
      roleRenamesLower.set(r.trim().toLowerCase(), newRole);
      nameMap.set(r.trim().toLowerCase(), newRole);
    });
    const newRoles = roles.map(r => roleRenames.get(r));
    const newWeeks = {};
    Object.keys(weeks).forEach(w => {
      newWeeks[w] = {};
      Object.keys(weeks[w]).forEach(r => {
        // A cell's own label can itself be another role's name - typing one
        // role's name into another's cell is exactly how "COVER" cells are
        // set (see autoDetectKind) - so that label needs the same rename,
        // not just the object's own key.
        const days = weeks[w][r];
        const renamedDays = {};
        Object.keys(days).forEach(dayKey => {
          const [kind, label] = days[dayKey];
          const relabelled = roleRenamesLower.get(String(label).trim().toLowerCase());
          renamedDays[dayKey] = [kind, relabelled || label];
        });
        newWeeks[w][roleRenames.get(r) || r] = renamedDays;
      });
    });
    crun("UPDATE patterns SET name=?, roles_json=?, weeks_json=? WHERE id=?",
      ['Custom Pattern ' + (pi + 1), JSON.stringify(newRoles), JSON.stringify(newWeeks), p.id]);
    roleRenames.forEach((newRole, oldRole) => {
      crun("UPDATE duty_group_slots SET role=? WHERE role=? AND duty_group_id IN (SELECT id FROM duty_groups WHERE pattern_id=?)", [newRole, oldRole, p.id]);
      crun("UPDATE duty_group_slots SET primary_role=? WHERE primary_role=? AND primary_pattern_id=?", [newRole, oldRole, p.id]);
      crun("UPDATE duty_group_slots SET shared_role=? WHERE shared_role=? AND shared_pattern_id=?", [newRole, oldRole, p.id]);
    });
  });

  // Manual override labels sometimes carry a real name or duty code typed
  // (or one-click-assigned) straight into a cell - swap any exact match,
  // and blank anything else rather than risk leaving unrecognised free
  // text in place (a manager could have typed a note like "covering for
  // [name]'s appointment" that wouldn't exact-match anything above).
  cq("SELECT id, label FROM cell_overrides").forEach(o => {
    const key = (o.label || '').trim().toLowerCase();
    const repl = nameMap.get(key);
    if (repl) { crun("UPDATE cell_overrides SET label=? WHERE id=?", [repl, o.id]); return; }
    // A short, generic-looking code (letters/digits only, <=6 chars) is very
    // unlikely to be a person's name or a written note - leave those as-is
    // since they're almost always duty codes; blank anything longer/wordier.
    if (!/^[A-Za-z0-9]{1,6}$/.test(o.label || '')) {
      crun("UPDATE cell_overrides SET label='NOTE' WHERE id=?", [o.id]);
    }
  });

  // Overtime reason is a fixed enum (ABSENCE/EARLY_START/LATE_FINISH), not
  // identifying on its own - but normalise it anyway so a demo copy can't
  // be used to infer a real recurring pattern (e.g. "this person always
  // logs early-start overtime on Tuesdays") tied to an otherwise-anonymised
  // person. A single fixed value keeps the Overtime Log rendering correctly
  // (still a valid enum) while carrying no distinguishing information.
  crun("UPDATE overtime_entries SET reason='EARLY_START'");

  // Annual leave's "source" is whichever sheet name an import came from -
  // sometimes an office or team name. Sickness/other absence notes are
  // free text and can be health-adjacent - clear both outright rather than
  // attempt to pattern-match them.
  crun("UPDATE annual_leave SET source_label=''");
  crun("UPDATE other_absences SET note=''");

  // Renamed tabs/sidebar labels are free text too (e.g. a tab renamed to
  // an office name) - reset every one back to its shipped default.
  Object.keys(DEFAULT_LABELS).forEach(key => {
    crun("UPDATE settings SET value=? WHERE key=?", [DEFAULT_LABELS[key], key]);
  });

  // Copyright line -> generic, not your real name/email.
  crun("UPDATE settings SET value='Demo User' WHERE key='copyrightName'");
  crun("UPDATE settings SET value='demo@example.com' WHERE key='copyrightEmail'");

  const bytes = copy.export();
  copy.close();
  return bytes;
}

