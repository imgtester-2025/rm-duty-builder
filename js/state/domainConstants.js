/* ---------------------------------------------------------------
   DOMAIN CONSTANTS - shared vocabulary referenced from multiple
   modules (duty/rotation kinds, day names, built-in patterns, default
   labels). Centralised here purely because more than one module needs
   the same constant; anything used by only one module stays local to it.
   --------------------------------------------------------------- */
const DAYS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
const DAY_LABELS = { MON:'Mon', TUE:'Tue', WED:'Wed', THU:'Thu', FRI:'Fri', SAT:'Sat', SUN:'Sun' };
const KIND_ORDER = ['WORK','OFF','SATWORK','COVER'];
const KIND_LABEL = {
  WORK: 'Working - own round',
  SATWORK: 'Working - rotating Saturday Route',
  COVER: "Working - covering another role's round",
  OFF: 'Day off',
  BH: 'Bank / Public Holiday',
  AL: 'Annual Leave',
  SICK: 'Sickness Absence',
  OTHER: 'Other Absence',
  UNCOVERED: 'Uncovered - no employee assigned to this working day'
};
const KIND_DEFAULT_LABEL = { WORK:'', OFF:'OFF', SATWORK:'A', COVER:'1' };
const OVERTIME_REASON_LABELS = {
  ABSENCE: 'Absence overtime (worked a day off)',
  EARLY_START: 'Pressure overtime (early start)',
  LATE_FINISH: 'Pressure overtime (late finish / worked over)'
};

function W(mon,tue,wed,thu,fri,sat){ return { MON:mon, TUE:tue, WED:wed, THU:thu, FRI:fri, SAT:sat, SUN:['OFF','OFF'] }; }
const WK = ['WORK','']; const OF = ['OFF','OFF'];
function SW(letter){ return ['SATWORK', letter]; }
function CV(n){ return ['COVER', String(n)]; }

const BUILTIN_PATTERNS = [
  {
    name: '9 Day Fortnight (Standard)',
    roles: ['Duty 1','Duty 2','Duty 3','DOC'],
    cycle_length: 4,
    start_times: { MON:'7:48-16:03', TUE:'7:48-16:03', WED:'7:48-16:28', THU:'7:48-16:03', FRI:'7:48-16:03', SAT:'7:48-15:28' },
    weeks: {
      1: { 'Duty 1': W(WK,WK,WK,WK,OF,OF), 'Duty 2': W(WK,WK,WK,OF,WK,SW('A')), 'Duty 3': W(WK,WK,OF,WK,WK,SW('B')), 'DOC': W(OF,OF,CV(3),CV(2),CV(1),SW('C')) },
      2: { 'Duty 1': W(OF,OF,WK,WK,WK,SW('A')), 'Duty 2': W(WK,WK,WK,WK,OF,OF), 'Duty 3': W(WK,WK,WK,OF,WK,SW('B')), 'DOC': W(CV(1),CV(1),OF,CV(3),CV(2),SW('C')) },
      3: { 'Duty 1': W(WK,WK,OF,WK,WK,SW('A')), 'Duty 2': W(OF,OF,WK,WK,WK,SW('B')), 'Duty 3': W(WK,WK,WK,WK,OF,OF), 'DOC': W(CV(2),CV(2),CV(1),OF,CV(3),SW('C')) },
      4: { 'Duty 1': W(WK,WK,WK,OF,WK,SW('A')), 'Duty 2': W(WK,WK,OF,WK,WK,SW('B')), 'Duty 3': W(OF,OF,WK,WK,WK,SW('C')), 'DOC': W(CV(3),CV(3),CV(2),CV(1),OF,OF) },
    }
  },
  {
    name: 'Two Saturdays Off in Every 5 Weeks (Standard)',
    roles: ['Duty 1','Duty 2','Duty 3','Duty 4','DOC'],
    cycle_length: 5,
    start_times: { MON:'7:48-15:48', TUE:'7:48-15:48', WED:'7:48-16:18', THU:'7:48-15:48', FRI:'7:48-15:48', SAT:'7:48-15:38' },
    weeks: {
      1: { 'Duty 1': W(OF,WK,WK,WK,WK,OF), 'Duty 2': W(WK,OF,WK,WK,WK,SW('A')), 'Duty 3': W(WK,WK,OF,WK,WK,SW('B')), 'Duty 4': W(WK,WK,WK,WK,OF,OF), 'DOC': W(CV(1),CV(2),CV(3),OF,CV(4),SW('C')) },
      2: { 'Duty 1': W(WK,OF,WK,WK,WK,SW('A')), 'Duty 2': W(OF,WK,WK,WK,WK,OF), 'Duty 3': W(WK,WK,WK,OF,WK,SW('B')), 'Duty 4': W(WK,WK,OF,WK,WK,SW('C')), 'DOC': W(CV(2),CV(1),CV(4),CV(3),OF,OF) },
      3: { 'Duty 1': W(WK,WK,WK,WK,OF,OF), 'Duty 2': W(WK,WK,OF,WK,WK,SW('A')), 'Duty 3': W(OF,WK,WK,WK,WK,OF), 'Duty 4': W(WK,WK,WK,OF,WK,SW('B')), 'DOC': W(CV(3),OF,CV(2),CV(4),CV(1),SW('C')) },
      4: { 'Duty 1': W(WK,WK,WK,OF,WK,SW('A')), 'Duty 2': W(WK,WK,WK,WK,OF,OF), 'Duty 3': W(WK,OF,WK,WK,WK,SW('B')), 'Duty 4': W(OF,WK,WK,WK,WK,OF), 'DOC': W(CV(4),CV(3),OF,CV(1),CV(2),SW('C')) },
      5: { 'Duty 1': W(WK,WK,OF,WK,WK,SW('A')), 'Duty 2': W(WK,WK,WK,OF,WK,SW('B')), 'Duty 3': W(WK,WK,WK,WK,OF,OF), 'Duty 4': W(WK,OF,WK,WK,WK,SW('C')), 'DOC': W(OF,CV(4),CV(1),CV(2),CV(3),OF) },
    }
  }
];

const ENCRYPTED_EXPORT_FORMAT = 'RM_DUTY_BUILDER_ENCRYPTED_V1';
const DEFAULT_LABELS = {
  navDutyBuilder: 'Duty Builder',
  navDutySheet: 'Duty Sheet',
  navAnnualLeave: 'Annual Leave',
  navHours: 'Hours & Overtime',
  navRotaSheet: 'Rota Sheet',
  navPatterns: 'Rotation Patterns',
  navSettings: 'Settings',
  sidebarEmployees: 'Employees',
  sidebarDuties: 'Duties'
};

const REASON_LABEL = { UNCOVERED: 'nobody assigned', AL: 'Annual Leave', SICK: 'Sickness', OTHER: 'Other absence' };

const TIME_WEEKDAYS = ['MON','TUE','WED','THU','FRI','SAT'];
const TIME_WEEKDAY_LABELS = {MON:'Mon',TUE:'Tue',WED:'Wed',THU:'Thu',FRI:'Fri',SAT:'Sat'};

