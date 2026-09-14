# RM Duty Builder

Offline, single-device duty/rota builder for Royal Mail-style delivery offices. Runs entirely
in the browser — SQLite compiled to WebAssembly ([sql.js](https://github.com/sql-js/sql.js)) is
the persistent source of truth, saved to the browser's IndexedDB (optionally AES-GCM encrypted).
No server, no accounts, no network calls of any kind.

This is a modular refactor of a single 6,850-line HTML file. The refactor preserves every
existing feature, calculation and workflow byte-for-byte where the code was simply relocated,
and adds an optional-module system on top. See **Refactor notes** below for what changed and why.

## Running it

Because the app is split into many `.js`/`.css` files loaded via plain `<script src>`/`<link>`
tags (not ES modules), it needs to be served over HTTP rather than opened directly as a
`file://` URL — Chromium-family browsers block `fetch`/relative-path loading oddities under
`file://` for some of the vendored libraries. Any static file server works, e.g.:

```bash
python3 -m http.server 8000    # from the repo root
# then open http://localhost:8000/
```

No build step, no `npm install`, no bundler. Everything (including the vendored SQLite WASM
binary, SheetJS and ExcelJS) is committed as plain files under `js/vendor/`.

## Project structure

```
index.html                  Single HTML shell: all page markup, modals, panels.
                             (Splitting page HTML into separate files isn't practical without a
                             server-side include step or breaking plain <script> loading, so the
                             modularisation here is at the CSS/JS level - the HTML itself is
                             organised into clearly commented per-page sections in one file, as
                             it was in the original.)
css/
  base.css                  Design tokens, header, nav, buttons, form controls.
  duty-builder.css          Sidebar, chips, duty group cards, slots, drag targets.
  duty-sheet.css            Calendar table, controls bar, legend, modals, overtime UI.
  duty-sheet-panels.css     Uncovered Duties / Who's Off slide-out panels.
  patterns.css              Rotation Patterns page and editor grid.
  settings.css              Settings tabs/cards, incl. the Modules toggle list.
  security.css              Lock screen.
  annual-leave.css          Annual Leave + leave-import review panel.
  absence.css               Sickness / Other Absence sub-tab.
  hours-overtime.css        Hours & Overtime page.
  rota-sheet.css            Rota Sheet grid.
  print.css                 @media print rules (unchanged from the original).
js/
  vendor/                   Third-party libraries, committed verbatim, unmodified:
                             sql-wasm.js + sql-wasm-data.js (sql.js loader + WASM binary as
                             base64), xlsx.full.js (SheetJS), exceljs.bundle.js (ExcelJS).
  state/domainConstants.js  Constants shared across 2+ modules (day names, duty "kind" enum,
                             built-in rotation patterns, default tab labels, etc).
  utils/dates.js            Pure date/format helpers - no DOM, no DB.
  services/
    moduleRegistry.js       The optional-module system (see below).
    db.js                   sql.js bootstrap, schema, migrations, q()/run()/lastId(), saveState().
    security.js             Password lock, AES-GCM encryption, auto-lock.
    anonymise.js            Anonymised demo-copy export.
    backup.js               Header's "Import backup" / "Export backup" (.rmvault).
    excelIO.js              Per-dataset .xlsx import/export + the coloured Duty Sheet Excel export.
    coverageEngine.js        Shared day-status computation used by Duty Sheet, Rota Sheet and
                             cover suggestions alike (override > holiday > absence > pattern).
  modules/
    navigation.js           Top nav + Duty Builder sidebar tab switching.
    employeesDuties.js      Employee/Duty CRUD, legacy Excel import, sidebar chips.
    patterns.js             Rotation pattern data/editor + the pattern-tab filter bars.
    dutyGroups.js           Duty groups, slots, drag-and-drop, shared duties, block anchors.
    dutySheet.js            The main calendar, cell overrides, Uncovered/Who's Off panels,
                             Duty Sheet print & Excel-export button wiring.
    coverSuggestions.js     Automatic DOC/WOC cover assignment (core) + skill-based
                             "suggested cover" hints (optional - see below).
    rotaSheet.js            The single-week spreadsheet-style rota grid.
    annualLeave.js          Weekly leave booking + fuzzy-match workbook import.
    skillsMatrix.js         Per-employee/per-duty proficiency scores.
    absence.js              Day-level sickness/other-absence tracking.
    hoursOvertime.js        Daily start/finish times + the automatic overtime log.
    settings.js             Tab renaming, bank holidays, fiscal year, the Modules tab.
  app/bootstrap.js          Boots the database, wires every module (gated by ModuleRegistry),
                             and drives the initial render. The one central place that decides
                             what runs.
```

Every file is loaded via an ordinary `<script src>` tag (see the bottom of `index.html`), in
dependency order. There is deliberately **no ES module system** (`type="module"`, `import`/
`export`): browsers refuse to load ES modules over `file://`, and this app is meant to be run by
double-clicking or hosted trivially, so plain scripts sharing the page's global scope were kept -
the same mechanism the original single file relied on internally, just spread across files
instead of one `(function(){...})()` wrapper.

## Module system

`Settings → Modules` lists every feature and lets you switch off the optional ones. A module is
registered once, in its own file, e.g.:

```js
ModuleRegistry.register({
  id: 'annualLeave', name: 'Annual Leave', core: false,
  hideSelectors: ['.absence-tab[data-absencepane="paneAL"]', '#paneAL'],
  description: '...'
});
```

State is persisted in the `settings` table (key `moduleStates`) — it survives reloads and travels
with database backups like any other setting. Toggling a module **reloads the page** after saving
the change; this app wires every listener exactly once at boot, so a clean reload is what avoids
ending up with duplicated listeners after a module is switched on/off/on again, rather than trying
to live-teardown/rewire a feature's DOM.

### Core (always enabled)

| Module | What it covers |
|---|---|
| Employees & Duties | The Employees/Duties sidebar lists on Duty Builder - foundational data. |
| Rotation Patterns | Built-in + custom rotation templates; every slot/cell resolves through this. |
| Duty Builder | Duty groups, slots, drag-and-drop, shared duties, block anchors. |
| Duty Sheet | The main calendar and its per-day coverage-status header. |
| Settings | Tab renaming, bank holidays, fiscal year, and the Modules tab itself. |
| Security, Locking & Encryption | Password lock, AES-GCM encryption, auto-lock, anonymised demo export. |
| Database Backup Import/Export | The header's encrypted whole-database backup (.rmvault). |

### Optional (toggleable, data always preserved)

| Module | Depends on | What turning it off hides |
|---|---|---|
| Annual Leave | — | The Annual Leave sub-tab (shares a nav tab with Sickness/Absence). |
| Sickness / Other Absence | — | The Sickness/Absence sub-tab. |
| Hours & Overtime | — | The whole Hours & Overtime nav tab. |
| Skills Matrix | — | The Skills Matrix tab on Duty Builder. Existing scores keep powering Cover Suggestions even while this is off - see note below. |
| Cover Suggestions | Skills Matrix | The "suggested cover: X, Y" hints on Duty Sheet/Rota Sheet cells. |
| Uncovered Duties Panel | — | The Uncovered Duties slide-out panel + its toggle tab. |
| Who's Off Panel | — | The Who's Off slide-out panel + its toggle tab. |
| Rota Sheet | — | The whole Rota Sheet nav tab. |
| Excel Import/Export | — | Every per-dataset .xlsx download/upload button, and the Duty Sheet's Excel export. |
| Printing | — | The Duty Sheet/Rota Sheet print buttons and the panel print buttons. |

**Dependency enforcement**: Cover Suggestions cannot be turned on unless Skills Matrix is already
on, and Skills Matrix cannot be turned off while Cover Suggestions is on — `ModuleRegistry.
setEnabled()` refuses both with a clear reason, rather than silently cascading a disable.

**Data vs. UI**: several optional modules' *data* keeps being used automatically even while their
*UI* is off — this is deliberate, not a gap. Example: Skills Matrix scores continue to power the
automatic DOC/WOC cover engine's ranking regardless of whether the Skills Matrix editing screen is
enabled; Absence/Hours data keeps showing on Duty Sheet cells the same way. Disabling a module
only removes the dedicated management screen for that data, never the data's effect elsewhere -
this matches "retain ALL of its database data" and avoids a module boundary silently changing
Duty Sheet output when toggled.

**Automatic day-off cover assignment** (DOC/WOC roles auto-filling a colleague's day off, and the
green/red per-day coverage-status header on both Duty Sheet and Rota Sheet) is CORE, not part of
the Cover Suggestions module - Duty Sheet's own status header depends on it unconditionally.
Cover Suggestions only gates the skill-ranked "who could cover this" hint text/checkmark shown on
individual cells.

## Database / schema

**No schema changes.** The original SQLite schema (11 tables) is reproduced exactly in
`services/db.js`, including every existing migration in `migrateSchema()` (column backfills,
the `other_absences` day-level → range-level rewrite, the legacy-overtime-minutes fold-in, etc.)
verbatim. The only new persisted state is a single `settings` row, key `moduleStates`, holding a
JSON map of optional-module on/off flags - no new table, no altered column.

Existing `.sqlite`/`.db` backups and encrypted `.rmvault` exports from the original single-file
app open exactly as before (same magic-byte / JSON-envelope detection, same password-derivation
parameters).

## Bugs found and fixed during the refactor

- **Module-toggle switch was unclickable.** The new Settings → Modules toggle-switch styling put
  the decorative track/thumb `<span>` on top of the (invisible) checkbox in the paint order,
  intercepting every click. Fixed by pinning the checkbox to `z-index:1` and making the track
  `pointer-events:none`. Caught by automated UI testing (Playwright), not by inspection - a good
  illustration of why every module toggle was exercised end-to-end rather than just code-reviewed.

No other functional bugs were found in the original logic; the day-off/pattern/cover-assignment
algorithms were copied verbatim and re-verified to produce identical output (see Testing below).

## Refactor notes (structural changes, no behaviour change)

A few pieces of code were **relocated** to sensible module boundaries without changing what they
do, since the original had them living inside a differently-named function purely for historical
reasons:
- The header's backup Import/Export listeners lived inside `wireDutyBuilderPage()` in the
  original; they're now `wireBackupControls()` in `services/backup.js`.
- The Duty Sheet's Excel-export and Print button listeners were both wired by one
  `wirePrintButton()` in the original; they're now two functions
  (`wireDutySheetExcelExport()` / `wireDutySheetPrintButton()`) so each can be gated by its own
  optional module (Excel Import/Export vs. Printing) independently.

## Visual refresh

The UI has been restyled (Royal Mail red retained as the brand accent; refined typography,
spacing, rounded corners, subtle shadows and a modern segmented nav bar). This was a CSS/markup-
only pass - every element's `id`/class the JavaScript depends on (`.active`, `.open`, `data-*`
attributes, element IDs) is unchanged, and the semantically load-bearing duty-status cell colours
(work/off/sick/annual leave/etc.) were deliberately left untouched since they're how the whole
app communicates status at a glance.

## Testing performed

All via a local static server + a real Chromium browser (Playwright), against the actual built
app - not unit tests against isolated functions:

- Fresh-DB boot (no existing data) - schema created, built-in patterns seeded, zero console errors.
- Employee/Duty add + duty-group creation + pattern-based slot generation.
- Duty Sheet calendar rendering against real assigned data, cross-checked cell-by-cell against
  the built-in "9 Day Fortnight" pattern's own week-1/2/3 data to confirm identical cycle-week
  computation to the original.
- Core per-day coverage-status header (auto DOC/WOC cover + gap counting).
- Settings → Modules: renders all 16 registered modules (7 core, 10 optional) with correct
  core/optional labelling.
- Module toggle ON→OFF→reload→ON→reload for Annual Leave/Sickness (which share one nav tab as two
  independently-toggleable sub-tabs) - data (`annual_leave` row) confirmed intact throughout.
- Dependency enforcement both directions: blocked disabling Skills Matrix while Cover Suggestions
  was on, and blocked enabling Cover Suggestions while Skills Matrix was off; succeeded once
  disabled in dependency-safe order.
- **ALL optional modules OFF**: correct reduced nav tab set, clicked through every remaining page/
  settings tab, zero console errors.
- **ALL optional modules ON**: full nav tab set, clicked through every page, every settings tab,
  Duty Builder's Skills Matrix sub-tab, Annual Leave/Absence sub-tabs, and opened/closed both
  Uncovered Duties and Who's Off panels - zero console errors.
- IndexedDB persistence across a page reload, and across opening a brand-new tab in the same
  browser profile (simulating close-and-reopen).
- Plain `.sqlite` backup export → wipe database → import the same file → data restored, exercised
  through the real `<input type=file>` import control (not a direct function call).
- Password lock: set password (real AES-GCM key derivation) → Lock Now → wrong password rejected
  → correct password unlocks with data intact → reload still shows the lock screen (encrypted
  IndexedDB persistence) → unlock again.
- Anonymised demo-copy download triggers with no errors.

## Known limitations / not exhaustively tested

- **HTML5 drag-and-drop itself** (dragging an employee/duty chip onto a slot with a real mouse)
  was verified by code inspection only (the handlers were relocated verbatim, unchanged) plus by
  exercising the same code paths' *effects* via direct data manipulation - Playwright's synthetic
  drag events don't reliably trigger the browser's native HTML5 DnD API, so this wasn't driven
  through actual pointer drag gestures in this pass.
- **Legacy Royal Mail Excel formats** (the fixed-column Employees/Duties workbook, the "ROTA"
  Annual Leave Plan sheets) were verified by code inspection (logic untouched) but not against a
  real exported Royal Mail workbook, since none was available in this environment.
- **A genuine pre-existing `.sqlite` file from an earlier version** of the original single-file
  app wasn't available to test the migration path against; the migration logic itself is
  unchanged from the original and was exercised via the plain-backup import round-trip instead.
- **Printed output** (actual paper/PDF result) wasn't visually inspected - the print buttons were
  confirmed to trigger without errors and `print.css` was left byte-for-byte unchanged.
