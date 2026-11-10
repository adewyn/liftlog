'use strict';
/* Lift Log: an offline workout tracker. Everything is stored on this device in IndexedDB. */

const APP_VERSION = '2.21.0';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const ACT_TYPES = { yoga: 'Yoga', walk: 'Walk', run: 'Run' };
// One "Walk/run" button; the pace sorts it once distance and time are in.
const ADD_TYPES = { yoga: 'Yoga', walk: 'Walk/run' };
const WALK_PACE = 15, RUN_PACE = 12.5; // min per mile: slower than 15:00 is a walk, faster than 12:30 a run, between is both
const COACH_MARK = { up: '▲', down: '▼', reps: '↗', hold: '→', beat: '★' };
const DEFAULT_SETTINGS = {
  restSec: 90, smartRest: true, sound: true, lastBackup: null,
  profile: { heightIn: 75 }, yogaLevel: 'beginner',
  goal: 'maintain', creatine: true, deloadUntil: null, deloadLast: null, deloadSnooze: null,
  proteinMode: 'auto', proteinPerLb: 0.85, proteinTarget: 155,
  reminder: { on: false, time: '09:00', streakOn: false, streakTime: '14:00', measureOn: false, measureTime: '10:00', id: null },
  trainer: { on: false, k: null, lastSync: 0, lastId: null, photos: [] },
  prefs: {}, block: null,
};
// The weigh-in reminder server (server/push in this folder) and its public key.
const PUSH_URL = 'https://liftlog-push.sporebound.workers.dev';
const VAPID_PUBLIC = 'BA_437YE5zeBtTMqdI9k9Ek1Jl9qu4Bo9Hmuen9bQmLNGn0MwZUngKJpCJSVXwj1lDQeCmGnbmKQ1zVhWV8yZLc';

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
// A renamed lift keeps its history: the new name looks up the old one's sessions.
const KEY_ALIAS = { 'chest press': 'chest press or dips', 'wide-grip lat pulldown': 'lat pulldown' };
// Close cousins: every 6-week block, a smaller lift moves to the next one in its family (see rotateBlock).
// Big lifts stay put so they can keep climbing. Names here are ones the muscle map knows.
const VARIANTS = [
  ['Cable fly', 'Pec deck', 'Low-to-high cable fly'],
  ['Bar curl', 'EZ-bar curl', 'Cable curl'],
  ['DB curl', 'Incline DB curl', 'Preacher curl'],
  ['Hammer curl', 'Rope hammer curl', 'Cross-body hammer curl'],
  ['Rope pushdown', 'Straight-bar pushdown', 'V-bar pushdown'],
  ['Overhead triceps extension', 'Cable overhead triceps extension', 'EZ-bar skull crusher'],
  ['Lateral raise', 'Cable lateral raise', 'Machine lateral raise', 'Lean-away lateral raise'],
  ['Reverse pec deck', 'Rear delt cable fly', 'Bent-over rear delt raise'],
  ['Hamstring curl', 'Lying leg curl'],
  ['Calf raise', 'Seated calf raise', 'Single-leg calf raise'],
  ['Cable crunch', 'Ab crunch machine', 'Decline sit-up'],
  ['Row', 'Chest-supported row', 'Seated cable row'],
  ['Seated DB shoulder press', 'Shoulder press machine'],
  ['Wide-grip lat pulldown', 'Close-grip lat pulldown'],
  ['Pull-ups', 'Chin-ups'],
  ['Push-ups', 'Decline push-ups'],
  ['Mace 360s', 'Mace whirls', 'Mace rotations'],
  ['Flutter kicks', 'High knee planks', 'Dead bug', 'Hollow hold'],
];
const familyOf = name => VARIANTS.find(f => f.some(n => keyOf(n) === keyOf(name))) || null;
const isHome = e => !!e && e.place === 'home';
// Your rep cap (Nov 7): no weighted lift goes past 12. Big lifts go heavy Monday 6–8, medium Wednesday
// 8–10, light Friday 10–12. Isolation lifts (curls, pushdowns, flys) sit a step higher, 8–10 Monday and
// 10–12 after. Small lifts (raises, rear delts, calves, abs, the mace) are 10–12 any day. Bodyweight
// moves, carries, and max-rep sets keep their own counts.
const REP_CAP = 12;
const SMALL_LIFT = /raise|rear delt|reverse (pec|fly)|face pull|calf|crunch|pallof|sit-?up|\babs?\b|mace|abduct|cuban|external rot|pull-?apart/i;
const DAY_REPS = { mon: [6, 8], wed: [8, 10], fri: [10, 12] }, ISO_REPS = { mon: [8, 10], wed: [10, 12], fri: [10, 12] };
const capExempt = x => x.unit === 'steps' || x.min == null || NO_WEIGHT.test(x.name);
// Workout order, like a trainer would set it (ACSM: big multi-joint lifts before small ones; Nunes
// 2021: lifts done early in a session gain the most strength, so priorities go first; core last so
// your trunk is fresh for heavy lifts):
//   0 big lifts (presses, squats, leg press, hinges, hip thrusts, rows, pulldowns, pull-ups)
//   1 secondary compounds (shoulder presses, dips, push-ups)
//   2 small lifts (raises, rear delts, curls, pushdowns, flys, leg curls, calves)
//   3 core and carries
const CORE_WORK = /crunch|pallof|plank|sit-?up|flutter|dead ?bug|hollow|leg raise|ab wheel|rollout|carry|\babs?\b/i;
const SECONDARY = /shoulder press|overhead press|military|arnold|\bdips?\b|push-?up|mace/i;
function effortTier(x) {
  if (CORE_WORK.test(x.name)) return 3;
  if (SMALL_LIFT.test(x.name) || classify({ ...x }).kind === 'iso') return 2;
  return SECONDARY.test(x.name) ? 1 : 0;
}
// Home work fits around the gym by effort: hard bodyweight pulls (pull-ups, chin-ups, dips) go before
// the gym while you're fresh; easier moves (push-ups, the mace, floor abs) go after, so they don't
// sap your lifts.
const homeWhen = e => (e.when === 'before' || e.when === 'after' ? e.when : /pull-?up|chin-?up|\bdips?\b|muscle-?up/i.test(e.name) ? 'before' : 'after');
const HOME_WHY = { before: 'Hard ones first, while you\'re fresh', after: 'Easier moves that won\'t sap your lifts' };
// Where a lift added on the fly (make-up, sore-day fill-in) goes: after the gym lifts of its tier
// or easier, before the first harder one not started yet. Supersets stay whole.
function insertByEffort(w, e) {
  const ex = w.exercises, t = effortTier(e), started = x => x.sets.some(s => s.done);
  let at = ex.findIndex(x => !isHome(x) && !started(x) && effortTier(x) > t);
  if (at < 0) { at = ex.findIndex(x => isHome(x) && homeWhen(x) === 'after'); if (at < 0) at = ex.length; }
  else at = ex.findIndex(x => x.group === ex[at].group);
  // A big lift never lands next to another big lift for the same half of the body (no leg press
  // straight into RDLs). Look a little later for a spot with an upper/lower switch on both sides,
  // never ahead of the day's first lift.
  if (t <= 1) {
    const half = x => classify({ ...(x.target || {}), name: x.name }).body;
    const clash = x => x && !isHome(x) && effortTier(x) <= 1 && half(x) === half(e);
    const starts = ex.map((x, k) => k).filter(k => k >= 1 && k <= ex.length && (k === ex.length || ex[k].group !== ex[k - 1].group) && !isHome(ex[k - 1]));
    const ok = k => !clash(ex[k - 1]) && !clash(ex[k]) && !(ex[k] && isHome(ex[k]) && homeWhen(ex[k]) === 'before');
    const firstHard = ex.findIndex(x => !isHome(x) && !started(x));
    const better = starts.filter(k => k >= Math.max(1, firstHard) && k >= at - 4 && k <= at + 3).find(ok);
    if (!ok(at) && better != null) at = better;
  }
  ex.splice(at, 0, e);
}
// The same for a lift added to a plan day (by the nightly trainer, with no position given).
function planInsertByEffort(groups, g) {
  const t = Math.min(...g.map(effortTier));
  const at = groups.findIndex(x => x.every(y => y.place !== 'home') && Math.min(...x.map(effortTier)) > t);
  const homeAt = groups.findIndex(x => x.some(y => y.place === 'home'));
  groups.splice(at >= 0 ? at : homeAt >= 0 ? homeAt : groups.length, 0, g);
}
// The client's rule (Nov 7, 2026): at least 3 sets of every exercise, every day. Easy days and deloads go
// lighter instead of shorter.
const MIN_SETS = 3;
function applyMinSets(p) {
  [...Object.values(p.days || {}).map(d => d.groups || []), ...(p.custom || []).map(c => c.groups || [])]
    .forEach(gs => gs.forEach(g => g.forEach(x => { if ((x.sets || 0) < MIN_SETS) x.sets = MIN_SETS; })));
  return p;
}
function applyRepRule(p) {
  Object.entries(p.days || {}).forEach(([d, day]) => (day.type === 'strength' ? day.groups || [] : []).forEach(g => g.forEach(x => {
    if (capExempt(x)) return;
    const r = SMALL_LIFT.test(x.name) ? [10, 12] : (classify(x).kind === 'iso' ? ISO_REPS : DAY_REPS)[d];
    if (r) { x.min = r[0]; x.max = r[1]; } else if ((x.max ?? 0) > REP_CAP) { x.max = REP_CAP; x.min = Math.min(x.min, REP_CAP); }
  })));
  (p.custom || []).forEach(c => (c.groups || []).forEach(g => g.forEach(x => {
    if (!capExempt(x) && (x.max ?? 0) > REP_CAP) { x.max = REP_CAP; x.min = Math.min(x.min, REP_CAP); }
  })));
  return p;
}
const listAnd = a => (a.length <= 1 ? a[0] || '' : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`);
const keyOf = name => { const k = String(name).trim().toLowerCase().replace(/\s+/g, ' '); return KEY_ALIAS[k] || k; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const dayKeyOf = s => DAYS[(parseYmd(s).getDay() + 6) % 7];
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const weekStart = s => addDays(s, -((parseYmd(s).getDay() + 6) % 7));
const fmtDate = (s, o = { weekday: 'short', month: 'short', day: 'numeric' }) => parseYmd(s).toLocaleDateString(undefined, o);
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const round2 = v => Math.round(v * 100) / 100;
const fmtW = w => (w === '' || w == null) ? '—' : (+w === 0 ? 'BW' : String(+w));
const fmtClock = sec => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
const sum = a => a.reduce((x, y) => x + y, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const e1rm = (w, r) => r <= 1 ? w : w * (1 + r / 30);

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chart: '<path d="M4 19h16M6 15l4-4 3 3 5-6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  up: '<path d="M6 14l6-6 6 6"/>',
  down: '<path d="M6 10l6 6 6-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  note: '<path d="M6 4h9l4 4v12H6z"/><path d="M9.5 12h6M9.5 16h4"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3.2"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24">${ICONS[n]}</svg>`;

// ---------- database ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      // Version 2 adds progress photos.
      const r = indexedDB.open('liftlog', 2);
      r.onupgradeneeded = () => {
        const d = r.result, has = n => d.objectStoreNames.contains(n);
        if (!has('kv')) d.createObjectStore('kv', { keyPath: 'k' });
        if (!has('workouts')) d.createObjectStore('workouts', { keyPath: 'id' });
        if (!has('body')) d.createObjectStore('body', { keyPath: 'date' });
        if (!has('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      };
      r.onblocked = () => toast('Close other Lift Log tabs to finish updating.');
      r.onsuccess = () => {
        this.db = r.result;
        // iOS can drop the connection after a long time in the background; reopen on the next save.
        this.db.onclose = () => { this.db = null; };
        this.db.onversionchange = () => { this.db.close(); this.db = null; };
        res();
      };
      r.onerror = () => rej(r.error);
    });
  },
  // One transaction. With a list of stores, fn gets the transaction itself, so a restore is all or nothing.
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const q = fn(Array.isArray(store) ? t : t.objectStore(store));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Save was interrupted'));
    });
  },
  async run(store, mode, fn) {
    if (!this.db) await this.open();
    try {
      return await this.tx(store, mode, fn);
    } catch (err) {
      if (!/InvalidState|Unknown|closing|lost/i.test(`${err && err.name} ${err && err.message}`)) throw err;
      this.db = null;
      await this.open();
      return this.tx(store, mode, fn);
    }
  },
  all: store => DB.run(store, 'readonly', s => s.getAll()),
  put: (store, v) => DB.run(store, 'readwrite', s => s.put(v)),
  del: (store, k) => DB.run(store, 'readwrite', s => s.delete(k)),
  putMany: (store, arr) => DB.run(store, 'readwrite', s => { arr.forEach(v => s.put(v)); }),
  clear: store => DB.run(store, 'readwrite', s => s.clear()),
};

// ---------- default program ----------
const UP = 5, LO = 10;
function ex(name, sets, min, max, inc, extra = {}) {
  return classify({ id: uid('e'), name, sets, min, max, inc, unit: 'reps', note: '', ...extra });
}
// Each exercise is a compound or isolation lift for the upper or lower body, and inc is the smallest
// weight step your gym has for it. Older programs only had inc (5 upper, 10 lower), so guess the rest.
const ISO_WORDS = /curl|raise|fly|flye|crossover|pushdown|push-down|triceps|extension|abduct|adduct|face pull|kickback|shrug|pec deck|calf|abs\b|crunch|plank|cuban|external rot/i;
// Gym names vary ("Tricep rope pull", "Pull ups"), so tidy them before matching lift types and muscles.
const normName = n => String(n || '').replace(/\btricep\b/gi, 'triceps').replace(/\b(pull|push|chin)[ -]?ups?\b/gi, '$1-up').replace(/\bface ?(rope )?pulls?\b/gi, 'face pull');
// Shoulder care drills (like a physical therapist's Cuban press): light, smooth, and never cut.
const REHAB_WORDS = /cuban|external rot|band pull-?apart/i;
const LOWER_WORDS = /squat|deadlift|\brdl\b|leg |lunge|hip |glute|hamstring|calf|step-up|abduct|adduct|thrust/i;
function classify(x) {
  if (!x.kind) x.kind = ISO_WORDS.test(normName(x.name)) ? 'iso' : 'compound';
  if (!x.body) x.body = LOWER_WORDS.test(x.name) || (x.inc || 0) >= 10 ? 'lower' : 'upper';
  if (x.inc >= 10 && !x.stepSet) x.inc = 5;
  x.stepSet = true;
  return x;
}
// Add about 5% (4% for upper-body compounds), never less than one step, rounded to steps you can load.
function jumpFor(t, w) {
  if (t.stack) return 1;
  const step = t.inc || UP;
  const pct = t.kind !== 'iso' && t.body === 'upper' ? 0.04 : 0.05;
  return Math.max(step, roundTo((+w || 0) * pct, step));
}
const PROGRAM_V = 11;
// Brings an older saved program up to date with the trainer review (Nov 2026): wider ranges for
// small lifts, a quad lift and an overhead press on Wednesday, and a real abs exercise. Only touches
// exercises that still match the original program, so your own edits stay.
function migrateProgram(p) {
  const v0 = p.v || 1;
  if (v0 >= PROGRAM_V) return false;
  if (v0 < 2) migrateV2(p);
  // v3: no hack squat machine at your gym, so it's the leg press you already use.
  if (v0 < 3) {
    [...DAYS.map(d => p.days[d]), ...(p.custom || [])].forEach(day => (day.groups || []).forEach(g => g.forEach(x => {
      if (/^hack squat$/i.test(x.name)) x.name = 'Leg press';
    })));
  }
  if (v0 < 4) migrateV4(p);
  if (v0 < 5) migrateV5(p);
  // v6: "Chest press or dips" was always logged as the machine (dips have their own names), so it's just Chest press.
  if (v0 < 6) {
    [...DAYS.map(d => p.days[d]), ...(p.custom || [])].forEach(day => (day.groups || []).forEach(g => g.forEach(x => {
      if (/^chest press or dips$/i.test(x.name)) x.name = 'Chest press';
    })));
  }
  // v7: no two leg lifts back to back. A pull goes between them so your legs rest while your back works.
  if (v0 < 7) {
    const moveBefore = (d, name, before) => {
      const day = p.days[d]; if (!day || !day.groups) return;
      const at = n => day.groups.findIndex(g => g.some(x => keyOf(x.name) === keyOf(n)));
      const i = at(name), j = at(before);
      if (i < 0 || j < 0 || i < j) return;
      const [g] = day.groups.splice(i, 1); day.groups.splice(j, 0, g);
    };
    moveBefore('wed', 'Row', 'Romanian deadlift');
    moveBefore('fri', 'Pull-ups', 'Hip thrust');
  }
  if (v0 < 8) migrateV8(p);
  if (v0 < 9) applyRepRule(p);
  if (v0 < 10) orderV10(p);
  if (v0 < 11) applyMinSets(p);
  p.v = PROGRAM_V;
  return true;
}
// v4 (Nov 2026): heavy, medium, and light days (daily undulating periodization). Monday's big lifts go
// heavy, Wednesday stays in the middle, Friday goes light with high reps and gets a second round of
// hip thrusts, so glutes train twice a week. Only exercises that still match the old plan change.
function migrateV4(p) {
  const tweak = (d, label, newLabel, changes) => {
    const day = p.days[d];
    if (!day || day.type !== 'strength') return null;
    if (day.label === label) day.label = newLabel;
    (day.groups || []).forEach(g => g.forEach(x => {
      const c = changes.find(([n, a, b]) => keyOf(x.name) === n && x.min === a && x.max === b);
      if (c) { x.min = c[3]; x.max = c[4]; }
    }));
    return day;
  };
  tweak('mon', 'Full body A', 'Heavy full body', [['bench press', 6, 8, 4, 6], ['hip thrust', 8, 10, 6, 8], ['lat pulldown', 8, 10, 6, 8]]);
  tweak('wed', 'Full body B', 'Medium full body', []);
  const fri = tweak('fri', 'Full body C', 'Light full body', [['chest press or dips', 8, 10, 12, 15], ['bulgarian split squat', 8, 8, 10, 12], ['cable crossover', 12, 12, 15, 20], ['hamstring curl', 10, 10, 12, 15], ['hammer curl', 10, 12, 12, 15], ['pushdown', 10, 12, 12, 15], ['face pull', 12, 15, 15, 20]]);
  if (fri) {
    const gs = fri.groups = fri.groups || [];
    if (!gs.some(g => g.some(x => /hip thrust|glute bridge/i.test(x.name)))) {
      const at = gs.findIndex(g => g.some(x => /split squat|lunge|squat|leg press/i.test(x.name)));
      gs.splice(at >= 0 ? at + 1 : gs.length, 0, [ex('Hip thrust', 3, 12, 15, LO)]);
    }
  }
}
// v10 (Nov 7, 2026 order audit): each day runs hardest and most important first, alternating upper and
// lower so one half rests while the other works, then small lifts (side delts, your top gap, ahead of
// arms), then core. Monday: leg press moves up with the big lifts. Wednesday: RDLs go second, while
// your hamstrings and lower back are fresh, with rows between them and the leg press. Raises move
// ahead of arms on all three days. Only moves lifts that are still there.
function orderV10(p) {
  const after = (d, name, prev) => {
    const day = p.days[d]; if (!day || !Array.isArray(day.groups)) return;
    const at = n => day.groups.findIndex(g => g.some(x => keyOf(x.name) === keyOf(n) && x.place !== 'home'));
    const i = at(name), j = at(prev);
    if (i < 0 || j < 0 || i === j + 1) return;
    const [g] = day.groups.splice(i, 1);
    day.groups.splice(at(prev) + 1, 0, g);
  };
  after('mon', 'Leg press', 'Wide-grip lat pulldown');
  after('mon', 'Lateral raise', 'Cable fly');
  after('wed', 'Romanian deadlift', 'Incline DB press');
  after('wed', 'Row', 'Romanian deadlift');
  after('wed', 'Calf raise', 'Seated DB shoulder press');
  after('fri', 'Lateral raise', 'Hip thrust');
  return p;
}
// v8 (Nov 7, 2026): wide and close-grip pulldowns are separate lifts (wide keeps the old history).
// Pull-ups move home, where nobody's watching; the gym gets a close-grip pulldown in their place.
// Each lifting day gets a short at-home list from moves you've done before: pull-ups, push-ups, the
// mace, and floor abs. Only touches lifts that still match the plan before.
function migrateV8(p) {
  const day = d => (p.days[d] && p.days[d].type === 'strength' && Array.isArray(p.days[d].groups) ? p.days[d] : null);
  const has = (d, n) => d.groups.some(g => g.some(x => keyOf(x.name) === keyOf(n)));
  const home = (name, sets, min, max, extra = {}) => [ex(name, sets, min, max, UP, { place: 'home', ...extra })];
  const mon = day('mon'), wed = day('wed'), fri = day('fri');
  if (mon) {
    mon.groups.forEach(g => g.forEach(x => { if (/^lat pulldown$/i.test(x.name)) x.name = 'Wide-grip lat pulldown'; }));
    if (!has(mon, 'Mace 360s')) mon.groups.push(home('Mace 360s', 2, 8, 10, { note: 'Per side' }));
    if (!has(mon, 'Flutter kicks')) mon.groups.push(home('Flutter kicks', 2, 20, 30));
  }
  if (wed && !has(wed, 'Pull-ups')) {
    wed.groups.push(home('Pull-ups', 3, null, null, { note: 'Max reps' }));
    if (!has(wed, 'High knee planks')) wed.groups.push(home('High knee planks', 2, 10, 15));
  }
  if (fri) {
    fri.groups.forEach(g => g.forEach((x, k) => {
      if (/^pull-?ups$/i.test(x.name) && x.place !== 'home') g[k] = ex('Close-grip lat pulldown', 3, 10, 12, UP);
    }));
    if (!has(fri, 'Push-ups')) fri.groups.push(home('Push-ups', 2, null, null, { note: 'Max reps' }));
    if (!has(fri, 'Dead bug')) fri.groups.push(home('Dead bug', 2, 8, 12, { note: 'Per side' }));
  }
}
// v5 (Nov 2026 trainer audit): your priorities get more direct work. Side delts train all three days,
// Monday's heavy press goes low-incline for the upper chest, Monday's leg press goes normal stance for
// the quads, and rear delts and a seated hamstring curl join Monday. Friday trims to 10 lifts and
// Wednesday's hip abduction moves to Friday to pay for it. Only exercises that still match the v4 plan change.
function migrateV5(p) {
  const day = d => (p.days[d] && p.days[d].type === 'strength' ? p.days[d] : null);
  const is = (x, name, sets, min, max) => !!x && keyOf(x.name) === keyOf(name) && x.sets === sets && x.min === min && x.max === max;
  const clean = d => { d.groups = d.groups.filter(g => g.length); };
  const mon = day('mon'), wed = day('wed'), fri = day('fri');
  let monHam = false;
  if (mon) {
    const gs = mon.groups = mon.groups || [];
    gs.forEach(g => g.forEach(x => {
      if (is(x, 'Bench press', 3, 4, 6)) { x.name = 'Low-incline bench press'; x.note = x.note || 'Bench at 15–30°'; }
      if (is(x, 'Leg press', 2, 10, 10)) { x.sets = 3; x.max = 12; if (/feet high/i.test(x.note || '')) x.note = ''; }
    }));
    const lat = gs.findIndex(g => g.length === 1 && is(g[0], 'Lateral raise', 3, 12, 20));
    if (lat >= 0) gs[lat].push(ex('Reverse pec deck', 3, 15, 20, UP));
    monHam = gs.some(g => g.some(x => /hamstring|leg curl/i.test(x.name)));
    if (!monHam && fri) { gs.push([ex('Hamstring curl', 3, 10, 12, LO, { note: 'Seated' })]); monHam = true; }
  }
  let abd = null;
  if (wed) {
    const gs = wed.groups = wed.groups || [];
    gs.forEach(g => g.forEach(x => { if (is(x, 'Romanian deadlift', 3, 8, 8)) { x.min = 6; x.max = 10; } }));
    const c = gs.findIndex(g => g.length === 1 && is(g[0], 'Calf raise', 3, 12, 20));
    if (c >= 0) gs[c].push(ex('Cable lateral raise', 3, 12, 20, UP));
    else if (!gs.some(g => g.some(x => /lateral raise/i.test(x.name)))) gs.push([ex('Cable lateral raise', 3, 12, 20, UP)]);
    const h = gs.findIndex(g => g.length === 1 && is(g[0], 'Hip abduction', 3, 12, 15));
    if (h >= 0 && fri) abd = gs.splice(h, 1)[0];
    clean(wed);
  }
  if (fri) {
    const gs = fri.groups = fri.groups || [];
    const drop = (name, sets, min, max) => gs.forEach((g, i) => { gs[i] = g.filter(x => !is(x, name, sets, min, max)); });
    drop('Cable crossover', 2, 15, 20);
    if (monHam) drop('Hamstring curl', 2, 12, 15);
    drop('Pushdown', 3, 12, 15);
    gs.forEach(g => g.forEach(x => { if (is(x, 'Lateral raise', 2, 12, 20) || is(x, 'Face pull', 2, 15, 20)) x.sets = 3; }));
    clean(fri);
    if (abd) {
      const at = fri.groups.findIndex(g => g.some(x => /calf/i.test(x.name)));
      fri.groups.splice(at >= 0 ? at : fri.groups.length, 0, abd);
    }
  }
}
function migrateV2(p) {
  const each = fn => DAYS.forEach(d => (p.days[d].groups || []).forEach(g => g.forEach(fn)));
  each(x => {
    if (/^lateral raise$/i.test(x.name) && x.min === 12 && x.max === 15) x.max = 20;
    if (/^calf raise$/i.test(x.name) && x.min === 10 && x.max === 15) { x.min = 12; x.max = 20; }
    if (/^farmer's carry$/i.test(x.name) && x.min === 40 && x.max === 40) x.max = 60;
  });
  const wed = p.days.wed;
  if (wed && wed.type === 'strength') {
    const gs = wed.groups = wed.groups || [];
    const has = re => gs.some(g => g.some(x => re.test(x.name)));
    const at = re => gs.findIndex(g => g.some(x => re.test(x.name)));
    if (!has(/squat|leg press|lunge/i)) gs.splice(Math.max(0, at(/romanian|rdl/i)), 0, [ex('Leg press', 3, 8, 12, LO)]);
    if (!has(/overhead press|shoulder press|military|arnold/i)) {
      const r = at(/^row$/i);
      gs.splice(r >= 0 ? r + 1 : gs.length, 0, [ex('Seated DB shoulder press', 3, 8, 10, UP)]);
    }
    const a = gs.findIndex(g => g.length === 1 && /^abs$/i.test(g[0].name));
    if (a >= 0) gs.splice(a, 1, [ex('Cable crunch', 3, 10, 15, UP), ex('Pallof press', 2, 10, 12, UP, { note: 'Per side' })]);
  }
}
function defaultProgram() {
  return applyMinSets(orderV10(applyRepRule({
    v: PROGRAM_V,
    days: {
      mon: { label: 'Heavy full body', type: 'strength', groups: [
        [ex('Low-incline bench press', 3, 4, 6, UP, { note: 'Bench at 15–30°' })],
        [ex('Hip thrust', 3, 6, 8, LO)],
        [ex('Wide-grip lat pulldown', 3, 6, 8, UP)],
        [ex('Cable fly', 2, 10, 12, UP)],
        [ex('Leg press', 3, 10, 12, LO)],
        [ex('Bar curl', 3, 8, 12, UP), ex('Rope pushdown', 3, 8, 12, UP)],
        [ex('Lateral raise', 3, 12, 20, UP), ex('Reverse pec deck', 3, 15, 20, UP)],
        [ex('Hamstring curl', 3, 10, 12, LO, { note: 'Seated' })],
        [ex('Mace 360s', 2, 8, 10, UP, { note: 'Per side', place: 'home' })],
        [ex('Flutter kicks', 2, 20, 30, UP, { place: 'home' })],
      ] },
      tue: { label: 'Yoga + walk/run', type: 'cardio' },
      wed: { label: 'Medium full body', type: 'strength', groups: [
        [ex('Incline DB press', 3, 8, 10, UP)],
        [ex('Leg press', 3, 8, 12, LO)],
        [ex('Row', 3, 8, 10, UP)],
        [ex('Romanian deadlift', 3, 6, 10, LO)],
        [ex('Seated DB shoulder press', 3, 8, 10, UP)],
        [ex('DB curl', 3, 10, 12, UP), ex('Overhead triceps extension', 3, 10, 12, UP)],
        [ex('Calf raise', 3, 12, 20, LO), ex('Cable lateral raise', 3, 12, 20, UP)],
        [ex('Cable crunch', 3, 10, 15, UP), ex('Pallof press', 2, 10, 12, UP, { note: 'Per side' })],
        [ex('Pull-ups', 3, null, null, UP, { note: 'Max reps', place: 'home' })],
        [ex('High knee planks', 2, 10, 15, UP, { place: 'home' })],
      ] },
      thu: { label: 'Yoga + easy walk/run', type: 'cardio' },
      fri: { label: 'Light full body', type: 'strength', groups: [
        [ex('Chest press', 3, 12, 15, UP)],
        [ex('Bulgarian split squat', 3, 10, 12, LO, { note: 'Per leg' })],
        [ex('Close-grip lat pulldown', 3, 10, 12, UP)],
        [ex('Hip thrust', 3, 12, 15, LO)],
        [ex('Hammer curl', 3, 12, 15, UP)],
        [ex('Lateral raise', 3, 12, 20, UP), ex('Face pull', 3, 15, 20, UP)],
        [ex('Hip abduction', 3, 12, 15, LO)],
        [ex('Calf raise', 3, 12, 20, LO)],
        [ex("Farmer's carry", 3, 40, 60, UP, { unit: 'steps' })],
        [ex('Push-ups', 2, null, null, UP, { note: 'Max reps', place: 'home' })],
        [ex('Dead bug', 2, 8, 12, UP, { note: 'Per side', place: 'home' })],
      ] },
      sat: { label: 'Rest', type: 'rest' },
      sun: { label: 'Rest', type: 'rest' },
    },
  })));
}

// ---------- state ----------
const S = {
  program: null,
  settings: { ...DEFAULT_SETTINGS },
  workouts: [],
  body: {},
  foods: [],
  tab: 'today',
  view: null,        // a sub-screen: { name, ..., back }
  pickDay: null,     // { date, k }: a day picked on Today instead of the real weekday
  dayView: null,     // another date this week shown on Today
  draft: null,       // today's session before anything is logged
  histSeg: 'workouts',
  bodyDate: todayStr(),
  sheet: null,
  persisted: null,
  say: {},          // the coach's latest word on each lift today: { 'wid:i': { t, tone, why, at } }
  said: {},         // what's been said per workout, so nothing repeats: { wid: { once, quiet } }
};

async function loadState() {
  const kv = Object.fromEntries((await DB.all('kv')).map(r => [r.k, r.v]));
  S.program = kv.program || defaultProgram();
  S.program.custom = S.program.custom || [];
  const oldV = S.program.v || 1, migrated = migrateProgram(S.program);
  allPlans().forEach(p => (p.groups || []).forEach(g => g.forEach(classify)));
  S.settings = { ...DEFAULT_SETTINGS, ...(kv.settings || {}) };
  S.settings.reminder = { ...DEFAULT_SETTINGS.reminder, ...((kv.settings || {}).reminder || {}) };
  S.settings.profile = { ...DEFAULT_SETTINGS.profile, ...((kv.settings || {}).profile || {}) };
  S.settings.trainer = { ...DEFAULT_SETTINGS.trainer, ...((kv.settings || {}).trainer || {}) };
  S.coachLog = kv.coachLog || [];
  if (!S.settings.streakRuleFrom) { S.settings.streakRuleFrom = todayStr(); await saveSettings(); }
  // Trainer check-up (Nov 2026): lean bulk aimed faster than the slow gain you asked for, so it moves to Slow gain once.
  if (!S.settings.goalV) { if (S.settings.goal === 'bulk') S.settings.goal = 'slow'; S.settings.goalV = 1; await saveSettings(); }
  S.foods = kv.foods || [];
  // You told me (Nov 7): no pull-ups at the gym, people watching. They live in your At home list.
  if (!S.settings.prefsV) {
    S.settings.prefs = { ...(S.settings.prefs || {}), 'pull-ups': { no: 'watching', at: Date.now(), ...((S.settings.prefs || {})['pull-ups'] || {}) } };
    S.settings.block = S.settings.block || { start: '2026-11-09', n: 1, log: [] };
    S.settings.prefsV = 1; await saveSettings();
  }
  if (!S.settings.block) { S.settings.block = { start: weekStart(todayStr()), n: 1, log: [] }; await saveSettings(); }
  if (!kv.program || migrated) await saveProgram();
  if (migrated && kv.program) S.notice = oldV >= 9 ? 'Workout order, set like a trainer would: big and priority lifts first while you\'re fresh, switching upper and lower, then side delts before arms, core last. Wednesday\'s RDLs move up to second. At home: pull-ups before the gym, easier moves after. Every lift is now 3 sets at least (easy days and deloads go lighter, not shorter), and each lift has a Note button for your own notes.' : oldV >= 8 ? 'Rep ranges now top out at 12 (Mon 6–8, Wed 8–10, Fri 10–12, small lifts 10–12; bodyweight exempt), and workouts run big and priority lifts first, core last. Pull-ups at home go before the gym.' : oldV >= 7 ? 'New: an At home list each lifting day (pull-ups before the gym, easier moves after), Friday\'s gym slot is a close-grip pulldown, rep ranges top out at 12, and workouts run big and priority lifts first, core last.' : oldV >= 6 ? 'New order: no two leg lifts in a row. Wednesday\'s row now comes between leg press and RDLs, and Friday\'s pull-ups come between split squats and hip thrusts.' : oldV >= 5 ? 'Order tweak: rows and pull-ups now sit between your leg lifts on Wednesday and Friday. Also, Friday\'s "Chest press or dips" is now just Chest press, since the machine is what you\'ve always logged. Your history carries over. Want dips one day? Tap ⋯ on the lift and swap it.' : oldV >= 4 ? 'Trainer check-up: side delts now train all three days, Monday\'s heavy press is low-incline for your upper chest, and Monday adds rear delts and a seated hamstring curl. Friday is trimmed to 10 lifts, and hip abduction moves from Wednesday to Friday. Change anything in More.' : oldV >= 3 ? 'New week shape: heavy Monday (fewer reps, more weight), medium Wednesday, and light Friday (more reps), plus hip thrusts on Friday too. Weights adjust on their own. Change anything in More.' : oldV >= 2 ? "Wednesday's hack squat is now the leg press, since your gym doesn't have a hack squat machine." : 'Program updated from the trainer review: a quad lift, an overhead press, and cable crunches on Wednesday, plus wider rep ranges for raises, calves, and carries. Change anything in More.';
  S.workouts = await DB.all('workouts');
  // 1.9 saved imported activity-only days under Sunday.
  const moved = S.workouts.filter(w => w.imported && w.dayKey === 'sun' && w.type === 'rest');
  moved.forEach(w => { w.dayKey = 'act'; });
  if (moved.length) await DB.putMany('workouts', moved);
  S.body = {};
  (await DB.all('body')).forEach(b => { S.body[b.date] = b; });
  S.photos = await DB.all('photos').catch(() => []);
  S.inspo = kv.inspo || [];
  S.draft = null;
  freezeTargets();
  // Today's workout may already be saved with the hack squat in it: swap any not started yet.
  S.workouts.filter(w => w.date === todayStr()).forEach(w => (w.exercises || []).forEach(e => {
    if (/^hack squat$/i.test(e.name) && !e.sets.some(x => x.done)) { e.name = 'Leg press'; e.key = keyOf(e.name); fillSets(e, w); persist(w); }
  }));
  // Nov 7: Friday's pulldown today was the close grip, so it starts that lift's own history.
  if (!S.settings.gripFix) {
    S.workouts.filter(w => w.date === todayStr() && w.dayKey === 'fri').forEach(w => (w.exercises || []).forEach(e => {
      if (/^lat pulldown$/i.test(e.name) && !e.makeUp) { e.name = 'Close-grip lat pulldown'; e.key = keyOf(e.name); if (!e.sets.some(x => x.done)) fillSets(e, w); persist(w); }
    }));
    S.settings.gripFix = 1; saveSettings();
  }
  // The At home list is new (2.14): today's workout, already saved, gets its day's home lifts too.
  if (!S.settings.homeAdd) {
    S.workouts.filter(w => w.date === todayStr() && w.type === 'strength').forEach(w => {
      const plan = planOf(w.dayKey);
      let g = Math.max(-1, ...w.exercises.map(e => +e.group || 0)) + 1;
      (plan && plan.groups || []).forEach(gr => gr.filter(x => x.place === 'home' && !w.exercises.some(e => e.key === keyOf(x.name))).forEach(x => w.exercises.push(sessionExercise(x, g++, w))));
      persist(w);
    });
    S.settings.homeAdd = 1; saveSettings();
  }
  // The 12-rep cap (2.14): today's lifts not started yet take their new ranges.
  // 3 sets at least (Nov 7, 2026): today's and upcoming lifts you haven't started get their third set back.
  if (!S.settings.setsFix) {
    S.workouts.filter(w => w.date >= todayStr() && w.type === 'strength').forEach(w => {
      let ch = false;
      (w.exercises || []).forEach(e => { if (e.target && e.sets.length < MIN_SETS && !e.sets.some(x => x.done)) { e.target = { ...e.target, sets: Math.max(MIN_SETS, e.target.sets || 0) }; fillSets(e, w); ch = true; } });
      if (ch) persist(w);
    });
    S.settings.setsFix = 1; saveSettings();
  }
  if (!S.settings.repFix) {
    S.workouts.filter(w => w.date === todayStr() && w.type === 'strength').forEach(w => {
      const plan = planOf(w.dayKey);
      (w.exercises || []).forEach(e => {
        if (e.sets.some(x => x.done) || !e.target || capExempt({ ...e.target, name: e.name })) return;
        const at = plan && e.pid && findPlanItem(plan, e.pid), x = at && at.g[at.k];
        const r = x ? [x.min, x.max] : SMALL_LIFT.test(e.name) ? [10, 12] : (e.target.kind === 'iso' ? ISO_REPS : DAY_REPS)[w.dayKey] || [e.target.min, Math.min(e.target.max, REP_CAP)];
        if (r[0] === e.target.min && r[1] === e.target.max) return;
        e.target = { ...e.target, min: r[0], max: r[1] }; fillSets(e, w);
      });
      persist(w);
    });
    S.settings.repFix = 1; saveSettings();
  }
  rotateBlock();
  // Same for a saved, unstarted "Chest press or dips" (the key stays, so history carries over).
  S.workouts.filter(w => w.date >= todayStr()).forEach(w => (w.exercises || []).forEach(e => {
    if (/^chest press or dips$/i.test(e.name) && !e.sets.some(x => x.done)) { e.name = 'Chest press'; persist(w); }
  }));
}

// Days before today keep the protein target they ended with.
function freezeTargets() {
  const t = todayStr(), up = Object.values(S.body).filter(b => b.date < t && !b.target && (b.protein || (b.items || []).length));
  up.forEach(b => { b.target = liveTarget(b.date); });
  if (up.length) DB.putMany('body', up).catch(() => {});
}
const saveFailed = err => toast(`Couldn't save: ${err.message}`, 6000);
const saveProgram = () => { S.draft = null; return DB.put('kv', { k: 'program', v: S.program }).catch(saveFailed); };
const saveSettings = () => DB.put('kv', { k: 'settings', v: S.settings }).catch(saveFailed);
let progTimer;
const saveProgramSoon = () => { clearTimeout(progTimer); progTimer = setTimeout(saveProgram, 400); };

function adopt(w) {
  S.ver = (S.ver || 0) + 1;
  if (!S.workouts.includes(w)) S.workouts.push(w);
  if (S.draft === w) S.draft = null;
  w.updatedAt = Date.now();
}
function persist(w) {
  adopt(w);
  DB.put('workouts', w).catch(err => toast(`Couldn't save: ${err.message}`));
}
const pendingSaves = new Map();
function saveSoon(w) {
  adopt(w);
  clearTimeout(pendingSaves.get(w));
  pendingSaves.set(w, setTimeout(() => { pendingSaves.delete(w); persist(w); }, 400));
}
function flushSaves() {
  pendingSaves.forEach((t, w) => { clearTimeout(t); persist(w); });
  pendingSaves.clear();
}

const getW = id => S.workouts.find(w => w.id === id) || (S.draft && S.draft.id === id ? S.draft : null);
const sortedW = () => [...S.workouts].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
const doneSets = e => e.sets.filter(s => s.done && s.w !== '' && s.r !== '');
// An activity counts once it has something in it (yoga counts as soon as it's logged).
const actDone = a => a.type === 'yoga' || +a.dist > 0 || +a.min > 0 || +a.hr > 0 || +a.sec > 0;
const hasWork = w => (w.exercises || []).some(e => doneSets(e).length) || (w.activities || []).some(actDone);

// A session comes from a weekday in the program, one of your saved workouts, or a blank one ('free').
const isDayKey = k => DAYS.includes(k);
const BLANK_PLAN = { label: 'Custom workout', type: 'strength', groups: [] };
const ACT_PLAN = { label: 'Activity', type: 'rest' };
// "Take today as a rest day": settings.dayMoves maps a date to the day plan it uses instead of its
// weekday's ('off' = rest). Today's lift moves to tomorrow, and each lift after it moves back a day
// until a rest day takes it in.
// What "Take today as a rest day" would do: today goes off and its lift moves to tomorrow, pushing later
// lifts back a day until a rest day takes one in. A lift never moves into next week or onto the day
// right before next week's first lift (no back-to-back full-body days); it's skipped instead.
function restPlan(today) {
  const cur = dayMoves(), m = { ...cur }, prev = {}, key = planKeyOn(today), wk = weekStart(today);
  const set = (d, k) => { prev[d] = d in cur ? cur[d] : null; if (k === dayKeyOf(d)) delete m[d]; else m[d] = k; };
  const blocked = d => weekStart(d) !== wk || (weekStart(addDays(d, 1)) !== wk && (planOf(planKeyOn(addDays(d, 1))) || {}).type === 'strength');
  set(today, 'off');
  let carry = key, to = null;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, i), was = planKeyOn(d);
    if (blocked(d)) break;
    if (i === 1) to = d;
    set(d, carry);
    if ((planOf(was) || {}).type === 'rest') break;
    carry = was;
  }
  return { m, prev, key, to };
}
const OFF_PLAN = { label: 'Rest day', type: 'rest' };
const dayMoves = () => S.settings.dayMoves || {};
const planKeyOn = date => dayMoves()[date] || dayKeyOf(date);
const planOn = date => planOf(planKeyOn(date)) || S.program.days[dayKeyOf(date)];
const planOf = k => (k === 'off' ? OFF_PLAN : k === 'act' ? ACT_PLAN : isDayKey(k) ? S.program.days[k] : S.program.custom.find(c => c.id === k)) || null;
const titleOf = w => (isDayKey(w.dayKey) ? DAY_NAMES[w.dayKey] : w.label);
const allPlans = () => [...DAYS.map(d => S.program.days[d]), ...S.program.custom];
const targetOf = e => classify(e.target);
const lastSetAt = w => Math.max(0, ...(w.exercises || []).flatMap(e => e.sets.filter(s => s.done).map(s => s.at || 0)));
const isLive = w => w.date === todayStr() || Date.now() - lastSetAt(w) < 3 * 3600000;
const hasAny = w => hasWork(w) || !!(w.notes || '').trim() || (w.exercises || []).some(hasExNote);

// ---------- workout logic ----------
function targetText(t) {
  let s;
  if (t.min != null && t.max != null) s = t.min === t.max ? `${t.sets} × ${t.min}` : `${t.sets} × ${t.min}–${t.max}`;
  else if (t.min != null) s = `${t.sets} × ${t.min}+`;
  else if (t.max != null) s = `${t.sets} × up to ${t.max}`;
  else s = `${t.sets} sets`;
  if (t.unit === 'steps' && (t.min != null || t.max != null)) s += ' steps';
  if (t.note) s += ` · ${t.note}`;
  return s;
}

// Real rest between sets, from when each set was logged. Gaps under 15 sec are catch-up taps, and gaps
// over 15 min mean you stepped away, so neither counts as rest.
function restInfo(w, e) {
  const ats = e.sets.filter(s => s.done && s.at).map(s => +s.at).sort((a, b) => a - b), g = [];
  for (let k = 1; k < ats.length; k++) { const d = (ats[k] - ats[k - 1]) / 1000; if (d >= 15 && d <= 900) g.push(d); }
  if (!g.length) return null;
  g.sort((a, b) => a - b);
  const med = g.length % 2 ? g[(g.length - 1) / 2] : (g[g.length / 2 - 1] + g[g.length / 2]) / 2;
  return { med: Math.round(med), n: g.length, plan: restFor(w, e) };
}
// Rested well under the timer (30% less, and at least 25 sec less).
const rushed = p => !!(p && p.rest && p.rest.med <= p.rest.plan * 0.7 && p.rest.med <= p.rest.plan - 25);
// ...and kept your reps up anyway (the last set within a rep of the first): you had more in you.
const quickAndStrong = p => rushed(p) && p.sets.length >= 2 && +p.sets[p.sets.length - 1].r >= +p.sets[0].r - 1;
const restTxt = p => `about ${fmtClock(p.rest.med)} rest (timer ${fmtClock(p.rest.plan)})`;
// Earlier sessions of this exercise (newest first), with only the logged sets.
function recentPerf(key, w, n) {
  const out = [];
  for (const o of sortedW()) {
    if (out.length >= n) break;
    if (o.id === w.id) continue;
    if (o.date > w.date || (o.date === w.date && o.createdAt > w.createdAt)) continue;
    const e = (o.exercises || []).find(x => x.key === key && doneSets(x).length && !!x.pin === pinOn(key));
    if (e) out.push({ date: o.date, sets: doneSets(e), easy: !!o.deload || lowDay(o.date) || offDay(o), note: liftNote(o, e.name), t: e.target ? { min: e.target.min, max: e.target.max } : null, grace: (e.coach && e.coach.grace) || 0, rest: o.imported ? null : restInfo(o, e) });
  }
  return out;
}
const lastPerf = (key, w) => recentPerf(key, w, 1)[0] || null;
const roundTo = (v, step) => Math.round(v / step) * step;

// Today's plan for an exercise, worked out from the last two sessions (double progression):
// top of the range on every set → more weight; inside the range → same weight, one more rep;
// short of the range → same weight again; short two sessions running → drop about 10%.
// If you used different weights on different sets last time, each set moves on its own.
// opts.energy 'low' or opts.tired (a reason, like yesterday's hike) holds off weight jumps.
function coachPlan(t, recent, opts = {}) {
  const last = recent[0];
  if (!last) return null;
  const at = (a, k) => a[Math.min(k, a.length - 1)];
  const lw = last.sets.map(s => +s.w || 0), reps = last.sets.map(s => +s.r);
  const top = Math.max(...lw);
  const prev = Array.from({ length: t.sets }, (_, k) => at(lw, k));
  const unit = t.unit === 'steps' ? 'steps' : 'reps';
  const wTxt = w => (w ? `${w} lb` : 'bodyweight');
  const plan = (kind, ws, r, note) => ({ kind, ws, w: Math.max(...ws), from: top, prev, reps: r, note });
  const fill = v => Array(t.sets).fill(v);
  // No rep target (like max-rep pull-ups): build total reps, then add weight once you reach about 9 a set.
  if (t.min == null && t.max == null) {
    // Bodyweight (often at home, with no weights around): keep building reps, compared over today's set count.
    if (!top) {
      const n = Math.min(t.sets, reps.length), total = sum(reps.slice(0, n)), per = n ? total / n : 0;
      const tip = per >= 20 ? ' Getting easy? Slow the lowering to 3 seconds, or try a harder version.' : reps.length && Math.max(...reps) < 5 ? ' Under 5 a set? A band or slow lowering reps help.' : '';
      return plan('beat', fill(0), Array.from({ length: t.sets }, (_, k) => at(reps, k)), `Beat ${total} ${unit} total${n < reps.length ? ` across ${n} sets` : ''}. Just one more.${tip}`);
    }
    const total = sum(reps);
    if (unit === 'reps' && last.sets.length >= t.sets && total >= 9 * t.sets && opts.energy !== 'low') {
      const w = round2(top + jumpFor(t, top));
      return plan('up', fill(w), fill(6), `${total} reps last time. Add ${w - top} lb (a belt, a dumbbell, or a harder version) and build back up.`);
    }
    const tip = unit === 'reps' && !top && reps.length && Math.max(...reps) < 5 ? ' Under 5 a set? A band or slow lowering reps help.' : '';
    return plan('beat', prev, reps, `Beat ${total} ${unit} total. Just one more.${tip}`);
  }
  const lo = t.min ?? t.max, hi = t.max ?? t.min;
  const holdWhy = opts.energy === 'low' ? (opts.sick ? "you're sick" : "energy's low") : opts.tired || (opts.noted === 'lift-pain' ? 'it hurt last time' : opts.noted === 'lift-hard' ? 'it felt hard last time' : '');
  // Sessions logged on a low-energy day don't count as misses. Right after a big jump (p.grace), a few
  // reps under the range is expected (about 3, and a rep less on later sets), so that isn't a miss either.
  // A session where you rushed the rests doesn't count as a miss either: the weight wasn't the problem.
  const short = p => !p.easy && !rushed(p) && (p.sets.length < t.sets || p.sets.some(x => +x.r < lo - (p.grace ? 4 : 0)));
  const total = p => sum(p.sets.map(x => +x.r || 0));
  const bestE = p => Math.max(0, ...p.sets.filter(x => +x.w).map(x => e1rm(+x.w, Math.min(+x.r || 0, 20))));

  if (new Set(lw).size > 1) {
    const ws = [], rr = [];
    let earned = 0;
    for (let k = 0; k < t.sets; k++) {
      const w = prev[k], r = reps[k];
      if (r != null && r >= hi && w) earned++;
      if (r != null && r >= hi && w && !holdWhy) { ws.push(round2(w + jumpFor(t, w))); rr.push(lo); } else {
        ws.push(w); rr.push(r == null ? lo : Math.min(hi, r >= lo ? r + 1 : lo));
      }
    }
    const ups = ws.filter((w, k) => w > prev[k]).length;
    if (ups) return plan('up', ws, rr, `${ups === 1 ? 'One set' : `${ups} sets`} hit ${hi}, so ${ups === 1 ? 'it goes' : 'they go'} up. The rest chase one more rep.`);
    if (earned) return plan('hold', ws, rr, `You earned a jump, but ${holdWhy}. Same weights today.`);
    return plan('reps', ws, rr, `Same weights as last time. One more rep each (top is ${hi}).`);
  }

  if (last.sets.length >= t.sets && reps.every(r => r >= hi)) {
    if (!top) return plan('reps', prev, reps.map(r => r + 1), `${hi} on every set. Add a little weight or slow it down.`);
    if (holdWhy) return plan('hold', prev, reps, `You earned ${round2(top + jumpFor(t, top))} lb, but ${holdWhy}. Stay at ${top} today, it'll keep.`);
    // A step bigger than 10% (20 → 25 lb dumbbells) has to be earned with 2 extra reps first.
    if (jumpFor(t, top) / top > 0.1 && !reps.every(r => r >= hi + 2)) {
      return plan('reps', prev, fill(hi + 2), `${round2(top + jumpFor(t, top))} lb is a big step, so earn it: ${hi + 2} on every set first.`);
    }
    // Short rests with reps held (or "felt easy") earn a double step, as long as that stays within about 10%.
    const quick = !holdWhy && quickAndStrong(last);
    const easy = opts.noted === 'lift-easy' || (quick && (2 * jumpFor(t, top)) / top <= 0.1);
    const w = round2(top + jumpFor(t, top) * (easy ? 2 : 1));
    // A jump over 10% (25 → 30 lb dumbbells) won't allow the bottom of the range yet, so aim for what the
    // estimated max says you can do, and give it a few sessions to climb back into the range.
    const aim = (w - top) / top > 0.1 ? Math.max(1, Math.min(lo, Math.round((e1rm(top, Math.min(Math.min(...reps), 20)) / w - 1) * 30))) : lo;
    if (aim < lo) return { ...plan('up', fill(w), fill(aim), `${hi} on every set. ${w} lb is a big step, so aim for ${aim} and climb from there. Under ${lo} is fine for a few sessions.`), grace: 3 };
    return plan('up', fill(w), fill(lo), opts.noted === 'lift-easy' ? `${hi} on every set and you said it felt easy. Bigger jump: ${w} lb, aim for ${lo}+.` : quick ? `${hi} on every set with only ${restTxt(last)}. You had more in you, so ${easy ? 'a bigger jump: ' : ''}${w} lb, aim for ${lo}+${easy ? '' : ', and push the top of the range'}.` : `${hi} on every set last time. Up to ${w} lb, aim for ${lo}+.`);
  }
  if (rushed(last) && !last.easy && (last.sets.length < t.sets || last.sets.some(x => +x.r < lo))) {
    return plan('hold', prev, reps.map(r => Math.max(r, lo)), `Short of ${lo}, but with only ${restTxt(last)}. Same ${wTxt(top)}, and take the full rest this time.`);
  }
  if (short(last)) {
    const p2 = recent[1];
    const prevTop = p2 ? Math.max(...p2.sets.map(s => +s.w || 0)) : 0;
    // Two short sessions only mean a drop when the second wasn't any better (more reps or a higher estimated max).
    const better = p2 && (bestE(last) > bestE(p2) + 0.01 || (top === prevTop && total(last) > total(p2)));
    if (top && p2 && short(p2) && prevTop >= top && daysBetween(p2.date, last.date) <= 21 && !better) {
      const step = t.inc || UP;
      const w = Math.max(step, Math.min(top - step, roundTo(top * 0.9, step)));
      return plan('down', fill(w), fill(hi), `Two tough ones in a row. ${w} lb today, build back from here.`);
    }
    return { ...plan('hold', prev, reps.map(r => (last.grace ? Math.min(hi, r + 1) : Math.max(r, lo))), better ? `Short of ${lo}, but better than last time. Same ${wTxt(top)}, go for ${lo} on every set.` : `Same ${wTxt(top)}. Go for ${lo} on every set.`), grace: last.grace ? last.grace - 1 : 0 };
  }
  if (opts.energy === 'low') return plan('hold', prev, reps, `${opts.sick ? 'Sick day' : 'Low energy'}, so just match last time at ${wTxt(top)}.`);
  if (opts.noted === 'lift-pain' || opts.noted === 'lift-hard') return plan('hold', prev, reps, `Match last time at ${wTxt(top)}, since ${opts.noted === 'lift-pain' ? 'it hurt last time' : 'it felt hard last time'}.`);
  if (opts.noted === 'lift-easy') {
    return plan('reps', prev, Array.from({ length: t.sets }, (_, k) => Math.min(hi, Math.max(lo, at(reps, k) + 2))), `You said it felt easy. Same weight, two more reps a set (top is ${hi}).`);
  }
  // Still climbing into the range after a big jump: one more rep a set, from wherever you are.
  if (last.grace && last.sets.some(x => +x.r < lo)) {
    return { ...plan('reps', prev, Array.from({ length: t.sets }, (_, k) => Math.min(hi, at(reps, k) + 1)), `Settling in at ${wTxt(top)} after the jump. One more rep a set.`), grace: last.grace - 1 };
  }
  // An all-out last set still gets one more rep next time (training close to failure builds muscle),
  // unless your reps dipped from the time before at the same weight.
  const p2 = recent[1];
  // You always push hard, so a set with no effort answer counts as all-out.
  if ((last.sets[last.sets.length - 1].rir || 0) === 0 && last.sets.some(x => +x.r < hi) && p2 && Math.max(...p2.sets.map(s => +s.w || 0)) === top && total(last) < total(p2)) {
    return plan('hold', prev, reps, `Last set was all-out and reps dipped. Match ${wTxt(top)} before adding reps.`);
  }
  if (quickAndStrong(last)) {
    return plan('reps', prev, Array.from({ length: t.sets }, (_, k) => Math.min(hi, Math.max(lo, at(reps, k) + 2))), `Only ${restTxt(last)} and your reps held, so two more reps a set (top is ${hi}).`);
  }
  return plan('reps', prev,
    Array.from({ length: t.sets }, (_, k) => Math.min(hi, Math.max(lo, at(reps, k) + 1))),
    `Same weight, one more rep a set (top is ${hi}).`);
}

// Tailor the rest of today's sets to how this one went. Reps usually drop a little from set to set,
// so only raise after a big early set, and only lower after a clear miss (2 short, or short on set 1).
function adjustRest(w, e, j) {
  const t = effTarget(e), s = e.sets[j];
  if (t.min == null && t.max == null) return null;
  // Easy days (low energy, deload) aim 2 reps lower on purpose, so judge sets against that. Right after
  // a big jump, a few reps under the range is expected.
  const easy = lowDay(w.date) || !!w.deload, cut = easy ? 2 : (e.coach && e.coach.grace ? 4 : 0);
  const lo = Math.max(1, (t.min ?? t.max) - cut), hi = (t.max ?? t.min) - (easy ? 2 : 0), step = t.inc || UP, w0 = +s.w;
  const rest = e.sets.filter((x, k) => k > j && !x.done && !x.own && +x.w === w0);
  if (!rest.length || !w0) return null;
  // Lifts that bother you (and shoulder care) never go up mid-workout.
  const careful = REHAB_WORDS.test(e.name) || !!careOf(e.name);
  if (+s.r >= hi + 2 && j <= 1 && !easy && !careful) {
    rest.forEach(x => { x.w = x.pw = round2(w0 + step); x.r = x.pr = lo; });
    return { t: isPin(e) ? 'Strong set. Next one up a pin.' : `Strong set. Next one +${step} lb.`, tone: 'up' };
  }
  if ((+s.r <= lo - 2 || (j === 0 && +s.r < lo)) && w0 > step) {
    rest.forEach(x => { x.w = x.pw = round2(w0 - step); x.r = x.pr = lo; });
    return { t: isPin(e) ? `Under ${lo}, so down a pin next set to stay in range.` : `Under ${lo}, so −${step} lb next set to stay in range.`, tone: 'down' };
  }
  return null;
}

// One exercise for a session, with sets filled in from the coach's plan.
function sessionExercise(x, group, w) {
  classify(x);
  const e = {
    key: keyOf(x.name), name: x.name, group, pid: x.id || null, ...(x.place === 'home' ? { place: 'home', ...(x.when ? { when: x.when } : {}) } : {}), ...(pinOn(x.name) ? { pin: true } : {}),
    target: { sets: x.sets, min: x.min, max: x.max, inc: x.inc, kind: x.kind, body: x.body, stepSet: true, unit: x.unit || 'reps', note: x.note || '' },
    sets: [],
  };
  fillSets(e, w);
  return e;
}
// Low energy: hold the weights, keep all your sets (3 at least), and stop each with a couple of reps left.
// Deload weeks: the same sets about 10% lighter, with about 3 reps left. Plans build on your last regular sessions,
// so low-energy days and deloads never drag the numbers down.
// A lift you've never logged starts from a close cousin you have: low-incline bench at about 85% of
// your flat bench (a little less if that bench was a while ago).
const FIRST_FROM = [[/incline (bench|barbell)/i, 'Bench press', 0.85]];
function firstFrom(e, t, w) {
  if (isPin(e)) return null;
  const f = FIRST_FROM.find(([re]) => re.test(e.name)) || familyStart(e, w);
  if (!f || t.min == null) return null;
  const h = recentPerf(keyOf(f[1]), w, 1)[0];
  const best = h ? Math.max(0, ...h.sets.filter(x => +x.w).map(x => e1rm(+x.w, Math.min(+x.r || 0, 20)))) : 0;
  if (!best) return null;
  const step = t.inc || UP, aim = Math.max(t.min, (t.max ?? t.min) - 1), pct = f[2] * (daysBetween(h.date, w.date) >= 21 ? 0.9 : 1);
  const wNew = Math.max(step, Math.floor(best * pct / (1 + aim / 30) / step) * step), fill = v => Array(t.sets).fill(v);
  return { kind: 'hold', ws: fill(wNew), w: wNew, from: 0, prev: null, reps: fill(aim), note: `First time: ${wNew} lb for ${aim}, about ${Math.round(f[2] * 100)}% of your ${f[1].toLowerCase()}. Adjust after the first set if it's off.` };
}
// A new cousin in a lift's family (a new block's curl, say) starts at about 90% of the cousin you've
// done most recently in the last 3 months.
function familyStart(e, w) {
  const fam = familyOf(e.name);
  if (!fam) return null;
  const cands = fam.filter(n => keyOf(n) !== keyOf(e.name)).map(n => ({ n, h: recentPerf(keyOf(n), w, 1)[0] }))
    .filter(c => c.h && daysBetween(c.h.date, w.date) <= 90 && c.h.sets.some(x => +x.w > 0)).sort((a, b) => b.h.date.localeCompare(a.h.date));
  return cands.length ? [null, cands[0].n, 0.9] : null;
}
// Weight-stack machines logged by pin number ("Pec fly (stack #)", or "stack" in the lift's note) go up one pin at a time.
const isStack = (name, note) => /\(stack ?#?\)/i.test(name || '') || /\bstack\b/i.test(note || '');
// Cable machines whose stack shows 1, 2, 3… instead of pounds: switch the lift to pin numbers in its
// ⋯ menu. It's remembered per lift, and pin sessions and pound sessions keep separate histories.
const pinOn = key => !!((S.settings.prefs || {})[keyOf(key)] || {}).pin;
const isPin = e => !!e && (!!e.pin || isStack(e.name, (e.target || {}).note));
const pinText = t => String(t || '').replace(/([+−-])(\d+(?:\.\d+)?) lb\b/g, '$1$2 pin').replace(/(\d+(?:\.\d+)?) lb\b/g, 'pin $1');
// The target a lift is really aiming for today: shoulder care stays at 10 to 12 reps, lifts that cause
// pressure move to lighter sets of 8 to 12 (never past 12, your cap), and stack machines step one pin.
function effTarget(e) {
  const base = targetOf(e);
  const lo = REHAB_WORDS.test(e.name) ? 10 : 8;
  let t = REHAB_WORDS.test(e.name) || careOf(e.name) === 'pressure' ? { ...base, min: Math.max(base.min ?? lo, lo), max: Math.max(Math.min(base.max ?? REP_CAP, REP_CAP), lo) } : base;
  if (isPin(e)) t = { ...t, inc: 1, stack: true };
  return t;
}
function fillSets(e, w) {
  const rehab = REHAB_WORDS.test(e.name), care = careOf(e.name);
  const base = targetOf(e), t = effTarget(e);
  const low = !rehab && lowDay(w.date), deload = !rehab && !!w.deload;
  // Easy-day sessions (low energy, deload, tired or sick in your notes) only count if you still hit every set.
  const full = p => p.sets.length >= t.sets && p.sets.every(x => +x.r >= (t.min ?? t.max ?? 0));
  const pick = rehab ? { recent: recentPerf(e.key, w, 6) } : rangeBasis(base, t, recentPerf(e.key, w, 8));
  const recent = pick.recent, real = recent.filter(p => !p.easy || full(p));
  const tired = sleepShort(w.date) ? 'you slept under 6 hours' : t.body === 'lower' ? legsTired(w.date) : '';
  const short2 = !rehab && energyFor(w.date) !== 'low' && twoShortNights(w.date) ? "you've had two short nights" : '';
  const helps = soreHelpers(e.name, w.date);
  // Every reason to hold off weight jumps today, in one place, so plans and comebacks treat them the same.
  const noJump = rehab ? '' : tired || short2 || (deload ? "it's a deload week" : '') || (helps ? `your ${helps} ${/s$| and /.test(helps) ? 'are' : 'is'} sore` : '');
  // Never reach back past a break for the last normal session: build on the easy one instead (it isn't a miss).
  const stale = real.length && recent.length && daysBetween(real[0].date, recent[0].date) >= 21;
  const basis = real.length && !stale ? real.slice(0, 2) : recent.slice(0, 2), noted = basis[0] && basis[0].note;
  let plan = coachPlan(t, basis, { energy: rehab ? null : energyFor(w.date) || (sickNoted(w.date) ? 'low' : null), sick: !rehab && !energyFor(w.date) && !!sickNoted(w.date), tired: noJump, noted: noted && noted.k });
  if (pick.conv) plan = pick.conv;
  let cb = rehab ? null : comeback(t, recent, w.date);
  // Building back after a break waits a session when today's an easy day or your note said hard or pain.
  const pause = cb && cb.kind === 'up' && (low ? 'today is an easy day' : noJump || [noted, recent[0] && recent[0].note].some(x => x && (x.k === 'lift-hard' || x.k === 'lift-pain')) ? 'your note said it was rough' : '');
  if (pause) cb = { ...cb, kind: 'hold', ws: cb.ws.map(() => cb.from), note: `Same ${cb.from} lb, since ${pause}. Building back picks up next time.` };
  if (cb) plan = { ...(plan || { prev: null }), kind: cb.kind, ws: cb.ws, w: Math.max(...cb.ws), from: cb.from, reps: cb.reps, note: cb.note };
  else if (plan && deload) plan = { ...plan, kind: 'hold', ws: plan.prev, w: plan.from, reps: plan.prev.map(() => t.min ?? t.max ?? 8), note: '' };
  // Deload weeks keep every set but go about 10% lighter (also while building back from a break).
  if (plan && deload && plan.ws) {
    const st = isPin(e) ? 1 : t.inc || UP, lite = x => (+x > 0 ? Math.max(st, Math.floor((+x * 0.9) / st) * st) : x);
    const ws = plan.ws.map(lite);
    plan = { ...plan, kind: 'hold', ws, w: Math.max(...ws.map(x => +x || 0)), note: '' };
  }
  if (plan && (care || rehab)) {
    const last = (real[0] || recent[0]).sets, top = Math.max(...last.map(s => +s.w || 0)), step = t.inc || UP;
    if (care === 'pressure' && top && Math.max(...last.map(s => +s.r)) < 10) {
      // Moving to lighter sets: about 15% less so 10 reps feel smooth.
      const lw = Math.min(plan.w || Infinity, Math.max(step, roundTo(top * 0.85, step)));
      plan = { ...plan, kind: 'down', ws: plan.ws.map(() => lw), w: lw, reps: plan.reps.map(() => 10), note: `${lw} lb today so 8 to 12 reps feel smooth.` };
    } else if (plan.w > top + step) {
      // No big jumps on a lift that bothers you: one step at a time.
      plan = { ...plan, ws: plan.ws.map(x => Math.min(x, top + step)), w: Math.min(plan.w, top + step), note: `Up one step to ${round2(top + step)} lb, aim for ${t.min ?? t.max}+.` };
    }
  }
  if (!plan && !recent.length && !rehab) plan = firstFrom(e, t, w);
  e.coach = plan ? { kind: plan.kind, note: plan.note, from: plan.from, w: plan.w, prev: plan.prev, ...(plan.grace > 0 ? { grace: plan.grace } : {}) } : null;
  const sets = Math.max(MIN_SETS, cb ? cb.n : t.sets);
  const extra = deload ? `Deload: ${sets} sets${plan ? ' about 10% lighter' : ', go lighter'}, about 3 left in the tank.`
    : low ? `Easy day: all ${sets} sets, stop each with 2 or 3 left in the tank.` : '';
  if (extra && (!plan || deload)) e.coach = e.coach ? { ...e.coach, note: `${e.coach.note} ${extra}`.trim() } : { kind: 'hold', note: extra, from: 0, w: 0, prev: null };
  const noteCue = !noted ? '' : noted.k === 'lift-pain' ? 'Keep it light, stop if it hurts.'
    : noted.k === 'lift-cramp' && care !== 'cramp' ? CARE_CUES.cramp : '';
  const cue = [rehab ? REHAB_CUE : care ? CARE_CUES[care] : '', noteCue, helps ? `Sore ${helps} ${/^(chest|back)$/.test(helps) ? 'helps' : 'help'} here. Go lighter, stop if it pulls.` : ''].filter(Boolean).join(' ');
  if (cue) e.coach = e.coach ? { ...e.coach, note: `${e.coach.note} ${cue}`.trim() } : { kind: 'hold', note: cue, from: 0, w: 0, prev: null };
  const n = sets;
  // Sets you've logged or typed in yourself stay exactly as they are; only the rest get re-planned.
  const keep = s => s && (s.done || s.own);
  const len = Math.max(n, e.sets.reduce((a, s, k) => (keep(s) ? k + 1 : a), 0));
  e.sets = Array.from({ length: len }, (_, k) => {
    if (keep(e.sets[k])) return e.sets[k];
    const r = plan ? plan.reps[Math.min(k, plan.reps.length - 1)] : null;
    const pr = plan && low && !deload && r > 3 ? r - 2 : r;
    const pw = plan && plan.ws[Math.min(k, plan.ws.length - 1)];
    return plan ? { w: pw, r: pr, done: false, pw, pr }
      : { w: NO_WEIGHT.test(e.name) ? 0 : '', r: t.min ?? t.max ?? '', done: false };
  });
  if (isPin(e) && e.coach && e.coach.note) e.coach.note = pinText(e.coach.note);
}

// A lift done at different rep ranges on different days (heavy Monday, light Friday) builds on the
// last sessions at today's range, when there's one from the last 3 weeks. Otherwise the last session
// is turned into today's range with an estimated max (Epley), so the first heavy or light day starts
// at a weight that fits: aim one under the top of the range to leave a rep in the tank.
function rangeBasis(base, t, all) {
  const same = p => !p.t || p.t.min == null || (p.t.min === base.min && p.t.max === base.max);
  const plain = { recent: all.slice(0, 6) };
  if (!all.length || same(all[0]) || t.min == null || t.max == null) return plain;
  const mine = all.filter(same);
  if (mine.length && daysBetween(mine[0].date, all[0].date) <= 21) return { recent: mine.slice(0, 6) };
  const last = all[0], lw = last.sets.map(x => +x.w || 0), top = Math.max(...lw);
  const reps = last.sets.map(x => +x.r).sort((a, b) => a - b), med = reps[Math.floor(reps.length / 2)];
  if (!top || (med >= t.min - 1 && med <= t.max + 1)) return plain;
  const best = Math.max(...last.sets.filter(x => +x.w).map(x => e1rm(+x.w, Math.min(+x.r, 20))));
  const step = t.inc || UP, aim = Math.max(t.min, t.max - 1), heavier = med > t.max;
  const wNew = Math.max(step, Math.floor(best / (1 + t.max / 30) / step) * step);
  const fill = v => Array(t.sets).fill(v);
  const prev = Array.from({ length: t.sets }, (_, k) => lw[Math.min(k, lw.length - 1)]);
  return { ...plain, conv: { kind: heavier ? 'up' : 'hold', ws: fill(wNew), w: wNew, from: top, prev, reps: fill(aim),
    note: heavier ? `Heavier today: ${wNew} lb for ${aim}. Fewer reps, more weight, full rest between sets.` : `Lighter today: ${wNew} lb for ${aim}. More reps, keep them smooth.` } };
}

// Time off: strength mostly holds for about 4 weeks, then fades, and it comes back quickly (Bosquet 2013).
// After 3+ weeks away, start lighter; then climb a step each session you hit your reps until you're back.
function comeback(t, recent, date) {
  const last = recent[0];
  if (!last || (t.min == null && t.max == null)) return null;
  const lo = t.min ?? t.max, hi = t.max ?? t.min, step = t.inc || UP;
  const topOf = p => Math.max(...p.sets.map(s => +s.w || 0));
  // A session's weight in today's rep range: as lifted when its reps fit today's range, otherwise
  // converted with an estimated max (135 × 5 means more than 135 for 10).
  const atReps = p => {
    const top = topOf(p);
    if (!top) return 0;
    const best = Math.max(...p.sets.filter(s => +s.w === top).map(s => +s.r || 0));
    if (best >= lo - 1 && best <= hi + 1) return top;
    const e = Math.max(...p.sets.filter(s => +s.w).map(s => e1rm(+s.w, Math.min(+s.r || 0, 20))));
    return Math.max(step, Math.floor(e / (1 + lo / 30) / step) * step);
  };
  const top = topOf(last), gap = daysBetween(last.date, date), wks = Math.round(gap / 7);
  const fill = (v, n = t.sets) => Array(n).fill(v);
  if (gap >= 21) {
    const away = gap > 90 ? `about ${Math.round(gap / 30)} months` : `${wks} weeks`;
    if (!top) return { kind: 'hold', ws: fill(0), reps: fill(lo), n: Math.max(MIN_SETS, t.sets - 1), from: 0, note: `First time in ${away}. Aim for ${lo} and see how it feels.` };
    // Strength mostly holds for a few weeks, then fades: ease in at 90%, 85% after 6 weeks, 70% after 3 months.
    const base = atReps(last), pct = gap > 90 ? 0.7 : gap > 42 ? 0.85 : 0.9;
    const n = gap > 42 ? Math.max(MIN_SETS, t.sets - 1) : t.sets;
    const w = Math.max(step, roundTo(base * pct, step));
    return { kind: w < top ? 'down' : 'hold', ws: fill(w, n), reps: fill(lo, n), n, from: top,
      note: `First time in ${away}, so ${n === t.sets ? '' : `${n} sets at `}${w} lb for ${lo} (about ${Math.round(pct * 100)}% of where you left off) to ease in. Builds back to ${base} lb from here.` };
  }
  // Already back for a session or few: find where the break was and the weight from before it, in today's range.
  const k = recent.findIndex((p, i) => i < 4 && recent[i + 1] && daysBetween(recent[i + 1].date, p.date) >= 21);
  if (k < 0 || !top) return null;
  const oldTop = atReps(recent[k + 1]);
  if (top >= oldTop || last.sets.length < 2 || last.sets.some(s => +s.r < lo)) return null;
  const w = Math.min(oldTop, round2(top + jumpFor(t, top)));
  return { kind: 'up', ws: fill(w), reps: fill(lo), n: t.sets, from: top, note: `Building back to ${oldTop} lb, a step each session.` };
}
// Lifts you've marked as bothering you (More options on an exercise), by name.
const careOf = name => (S.settings.care || {})[keyOf(name)] || null;
const CARE_CUES = {
  pressure: 'Easy does it: breathe out as you push, no big breath-hold, 8 to 12 smooth reps. Aches? Swap it.',
  joint: 'Smooth, controlled reps. Stop if it hurts.',
  cramp: 'Cramped here before. A bit lighter and slower, sip water between sets.',
};
const REHAB_CUE = 'Shoulder care: light and smooth, stop well before it burns. Your PT\'s numbers win if you have them.';

function buildSession(dayKey, date) {
  const day = planOf(dayKey) || BLANK_PLAN;
  const w = { id: uid('w'), date, dayKey, type: day.type, label: day.label, notes: '', createdAt: Date.now(), activities: [], planKey: planKeyFor(date) };
  if (day.type === 'strength' && deloadState(date).active) w.deload = true;
  if (day.type === 'strength') {
    w.exercises = [];
    (day.groups || []).forEach((g, gi) => g.forEach(x => w.exercises.push(sessionExercise(x, gi, w))));
    applyMakeUp(w);
    applySore(w);
  }
  return w;
}

function todaySession() {
  const date = todayStr();
  const todays = sortedW().filter(w => w.date === date);
  // Still lifting after midnight: keep showing that workout until you've been done for a while.
  const late = sortedW().find(w => w.date === addDays(date, -1) && lastSetAt(w) && isLive(w));
  if (late && !todays.some(hasWork) && !(S.pickDay && S.pickDay.date === date)) return late;
  const picked = S.pickDay && S.pickDay.date === date ? S.pickDay.k : null;
  const dayKey = picked || (todays.find(dayMoves()[date] === 'off' ? hasWork : hasAny) || {}).dayKey || planKeyOn(date);
  const found = todays.find(w => w.dayKey === dayKey);
  if (!found && (!S.draft || S.draft.date !== date || S.draft.dayKey !== dayKey)) S.draft = buildSession(dayKey, date);
  const w = found || S.draft;
  // Energy, sleep, or a deload changed since this was planned: re-plan the lifts not started yet.
  const key = planKeyFor(date);
  if (w.planKey !== key) {
    if (w.type === 'strength') w.deload = deloadState(date).active;
    (w.exercises || []).forEach(e => { if (!e.sets.some(x => x.done)) fillSets(e, w); });
    if (w.type === 'strength') { applyMakeUp(w); applySore(w); }
    w.planKey = key;
    if (found) persist(w);
  }
  if (found && sortByLogged(w)) persist(w);
  return w;
}
const sleepFor = date => (S.body[date] || {}).sleep ?? null;
const sleepShort = date => sleepFor(date) != null && sleepFor(date) < 6;
// Two nights of 5 hours or less in a row count like a low-energy day, unless you check in OK or Great
// (then it's just no weight jumps). A little lost sleep barely touches strength.
const twoShortNights = date => [date, addDays(date, -1)].every(d => sleepFor(d) != null && sleepFor(d) < 6);
const lowDay = date => energyFor(date) === 'low' || (!energyFor(date) && (twoShortNights(date) || !!sickNoted(date)));
const planKeyFor = date => `${energyFor(date) || ''}|${sleepShort(date) ? 's' : ''}|${twoShortNights(date) ? 't' : ''}|${deloadState(date).active ? 'd' : ''}|${JSON.stringify(S.settings.care || {})}|${soreFor(date).join(',')}|${!energyFor(date) && sickNoted(date) ? 'sick' : ''}`;

// ----- weekly sets per muscle -----
// Direct work counts as a full set, big helpers as half (a bench set is 1 chest, ½ triceps).
// Front and side delts count apart: presses hit the front hard and the sides only a little, so the
// side delt work you want for width shows on its own.
const MUSCLES = { chest: 'Chest', back: 'Back', shoulders: 'Front delts', side: 'Side delts', rear: 'Rear delts', biceps: 'Biceps', triceps: 'Triceps', quads: 'Quads', hams: 'Hamstrings', glutes: 'Glutes', calves: 'Calves', abs: 'Abs' };
// 10 or more weekly sets builds more muscle (ACSM 2026); smaller areas do fine with about 6.
const MUSCLE_GOAL = { shoulders: 6, rear: 6, calves: 6, abs: 6 };
// Each rule: [names, muscles that count toward weekly sets, light helpers you'll feel but that don't
// count]. Light helpers only show on the pictures and in "Helps".
const MUSCLE_RULES = [
  [/wrist curl/i, {}],
  [/side.?(lying )?leg raise|lateral leg raise|clamshell|fire hydrant/i, { glutes: 0.5 }, ['abs']],
  [/cuban|external rot/i, { rear: 1 }, ['shoulders', 'back']],
  [/face pull|rear delt|reverse (fly|pec)|pull-?apart/i, { rear: 1 }, ['back']],
  [/front raise/i, { shoulders: 1 }, ['chest']],
  [/mace (360|churn|rotation|twirl|whirl|swing|overhead)/i, { shoulders: 1, back: 0.5, abs: 0.5 }, ['triceps']],
  [/(chair|bench) dips?/i, { triceps: 1, shoulders: 0.5 }, ['chest']],
  [/glute (lift|drive|machine)/i, { glutes: 1, hams: 0.5 }, ['quads']],
  [/single.?leg (kettlebell |kb |db |dumbbell )?(deadlift|rdl)|single.?leg romanian/i, { hams: 1, glutes: 0.5, back: 0.5 }, ['abs', 'calves']],
  [/back extension|hyperextension/i, { hams: 0.5, glutes: 0.5, back: 0.5 }],
  [/overhead (triceps|tricep|cable) extension|french press/i, { triceps: 1 }, ['shoulders']],
  [/triceps|pushdown|push-down|skull/i, { triceps: 1 }],
  [/pullover/i, { back: 1 }, ['chest', 'triceps']],
  [/lateral raise|side raise|square raise|upright row/i, { side: 1 }, ['back']],
  [/overhead press|shoulder press|military|arnold press|standing (bar |barbell )?press|\bohp\b/i, { shoulders: 1, side: 0.5, triceps: 0.5 }, ['chest', 'back']],
  [/pallof|woodchop/i, { abs: 1 }, ['glutes', 'shoulders']],
  [/hanging (knee|leg) raise|leg raise|ab wheel|rollout|flutter kick|mountain climber|v-?up|hollow|dead ?bug/i, { abs: 1 }, ['back']],
  [/russian twist|dead ?bug|bird ?dog/i, { abs: 1 }],
  [/crunch|plank|\babs\b|sit-?up/i, { abs: 1 }],
  [/calf/i, { calves: 1 }],
  [/hamstring|leg curl|nordic/i, { hams: 1 }, ['calves']],
  [/romanian|\brdl\b|good morning|stiff.?leg/i, { hams: 1, glutes: 0.5, back: 0.5 }, ['abs']],
  [/(hex|trap).?bar deadlift/i, { quads: 0.5, hams: 0.5, glutes: 0.5, back: 0.5 }, ['abs']],
  [/deadlift/i, { hams: 0.5, glutes: 0.5, back: 0.5 }, ['quads', 'abs']],
  [/sled/i, { quads: 0.5, glutes: 0.5 }, ['hams', 'calves']],
  [/hip thrust|glute bridge/i, { glutes: 1, hams: 0.5 }, ['quads', 'abs']],
  [/glute kickback/i, { glutes: 1 }, ['hams']],
  [/abduct/i, { glutes: 0.5 }],
  [/adduct/i, {}, ['glutes', 'quads']],
  [/leg extension/i, { quads: 1 }],
  [/split squat|lunge|step-?up/i, { quads: 1, glutes: 0.5 }, ['hams', 'abs', 'calves']],
  [/leg press|pendulum|hack squat|belt squat|machine squat/i, { quads: 1, glutes: 0.5 }, ['hams', 'calves']],
  [/squat/i, { quads: 1, glutes: 0.5 }, ['hams', 'abs', 'back']],
  [/row/i, { back: 1, biceps: 0.5, rear: 0.5 }, ['abs']],
  [/pull-?up|chin-?up/i, { back: 1, biceps: 0.5 }, ['rear', 'abs', 'triceps']],
  [/pulldown/i, { back: 1, biceps: 0.5 }, ['rear', 'triceps']],
  [/hammer curl|reverse curl/i, { biceps: 1 }],
  [/curl/i, { biceps: 1 }, ['shoulders']],
  [/kickback|close-grip/i, { triceps: 1 }, ['chest']],
  [/fly|flye|crossover|pec deck/i, { chest: 1 }, ['shoulders', 'biceps']],
  [/push-?up/i, { chest: 1, triceps: 0.5, shoulders: 0.5 }, ['abs']],
  [/\bdips?\b/i, { chest: 1, triceps: 0.5, shoulders: 0.5 }, ['back']],
  [/bench|chest press|incline|decline|floor press|free press|machine press|d(umb)?b(ell)? press|dumbbell chest/i, { chest: 1, triceps: 0.5, shoulders: 0.5 }],
  [/farmer|suitcase carry|\bcarry\b/i, { back: 0.5, abs: 0.5 }, ['glutes', 'calves']],
];
const musclesOf = name => { const n = normName(name); return (MUSCLE_RULES.find(([re]) => re.test(n)) || [null, {}])[1]; };
// For the pictures: the counted muscles plus light helpers (a quarter, so they show as helping).
const musclesShown = name => {
  const n = normName(name), r = MUSCLE_RULES.find(([re]) => re.test(n)) || [null, {}, []], out = { ...r[1] };
  (r[2] || []).forEach(m => { if (!out[m]) out[m] = 0.25; });
  return out;
};

// ---------- muscle map ----------
// A front and back body drawn on a 100 × 214 grid. Each side is drawn once (x under 50) and mirrored,
// so both halves always match. Muscle shapes carry the same names as MUSCLES.
const mirrorPath = d => d.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => `${+(100 - x).toFixed(1)},${y}`);
const BODY = {
  front: {
    sil: 'M50,27 L45,27 Q44,31 43,32 Q37,33 31,35 Q24,37 22.5,45 Q21.5,55 21,64 Q20,72 18.5,80 Q16.5,90 15,99 Q13.5,104 12.5,110 Q12,116 15,117 Q17,116 17.5,111 Q19,106 20.5,101 Q23.5,92 26,83 Q28,75 29.5,67 Q31,60 32.5,58 Q33.5,68 34.5,78 Q35,88 33.5,98 Q32,108 32,118 Q31.5,133 33,146 Q33.5,152 33.5,156 Q32,166 33,178 Q34,190 35.5,198 Q35,203 33.5,205 Q34,208 40,208 Q44,207 43.5,202 Q43,198 43.5,192 Q45,178 45,166 Q45,158 45.5,152 Q47,140 47.5,128 Q48.5,118 50,114',
    head: 'M50,1.5 Q41,1.5 40.5,12 Q40.5,21 45,25.5 Q47.5,27.5 50,27.5',
    parts: [
      ['back', 'M45,29.5 Q41,32.5 35.5,34.5 Q40,36 44,36 Q46,33 46.5,30 Z'],
      ['shoulders', 'M34.5,35.5 Q27,36.5 24.5,42.5 Q23,48.5 24,54.5 Q27,51 29.5,47.5 Q33,41.5 38.5,38.5 Q37,36.5 34.5,35.5 Z'],
      ['chest', 'M49,38.5 Q43.5,37 39.5,38.5 Q33.5,42 31.5,50 Q31.5,56.5 36.5,59 Q42.5,61 49,58.5 Z'],
      ['biceps', 'M24.5,57 Q22.5,63 22.5,70 Q23.5,73.5 26.5,72.5 Q29.5,66.5 30.5,59 Q31,55 29.5,52.5 Q26,53.5 24.5,57 Z'],
      ['abs', 'M37,61.5 Q35,72 35.5,84 Q36,92 39.5,98 Q41.5,94 41.5,86 Q41.5,73 40,62 Z'],
      ['quads', 'M34.5,108 Q32.5,120 33.5,134 Q34.5,144 37.5,149 Q40.5,150.5 43,148 Q46,138 47,126 Q47.5,117 45,111 Q40,108 34.5,108 Z'],
      ['calves', 'M35,158 Q33.5,168 34.5,180 Q35.5,188 37.5,192 Q39.5,190 40.5,182 Q41.5,170 40.5,159 Q37.5,155 35,158 Z'],
    ],
    center: [['abs', 'M43.5,61.5 L56.5,61.5 Q57.5,76 56.5,92 Q53.5,100 50,101 Q46.5,100 43.5,92 Q42.5,76 43.5,61.5 Z']],
    lines: 'M50,62 L50,100 M44,70 L56,70 M43.7,78.5 L56.3,78.5 M43.8,87 L56.2,87',
  },
  back: {
    head: 'M50,1.5 Q41,1.5 40.5,12 Q40.5,21 45,25.5 Q47.5,27.5 50,27.5',
    parts: [
      ['back', 'M50,26 Q47,29.5 44,31.5 Q39,34 35,35.5 Q40,38.5 43,42 Q47,50 49.5,60 L50,60 Z'],
      ['rear', 'M34.5,35.5 Q27,36.5 24.5,42.5 Q23,48.5 24,54.5 Q27,51 29.5,47.5 Q32.5,42 37.5,39.5 Q36.5,37 34.5,35.5 Z'],
      ['triceps', 'M24.5,57 Q22.5,63 22.5,70 Q23.5,73.5 26.5,72.5 Q29.5,66.5 30.5,59 Q31,55 29.5,52.5 Q26,53.5 24.5,57 Z'],
      ['back', 'M38,42 Q33.5,48 33.5,58 Q34,70 37.5,79 Q42,86 48.5,88 L48.5,64 Q46,50 42.5,43.5 Q40,41.5 38,42 Z'],
      ['back', 'M41,90 Q44.5,91 48.5,91.5 L48.5,103 Q44.5,102.5 40.5,100.5 Q39.5,95 41,90 Z'],
      ['glutes', 'M49,105 Q41,103.5 36,107 Q32.5,112 33.5,119 Q35.5,126 42,127 Q47,127 49,123.5 Z'],
      ['hams', 'M34,129 Q32.5,138 33.5,146 Q35,151 38.5,152 Q41.5,149 43.5,142 Q46,135 46.5,129.5 Q41,130.5 34,129 Z'],
      ['calves', 'M34.5,157 Q32.5,165 33.5,174 Q35,180.5 38.5,181 Q42,180.5 43,173 Q43.5,164 42,157.5 Q38,154 34.5,157 Z'],
    ],
    center: [],
    lines: 'M50,62 L50,104',
  },
};
BODY.back.sil = BODY.front.sil;
const BODY_SIDE = { chest: 'front', shoulders: 'front', side: 'front', biceps: 'front', abs: 'front', quads: 'front', back: 'back', rear: 'back', triceps: 'back', glutes: 'back', hams: 'back', calves: 'back' };
const LOWER_M = new Set(['quads', 'hams', 'glutes', 'calves']);
// Where each muscle sits from top to bottom on the 214-tall body, for zooming a small picture in.
const MUSCLE_Y = { back: [26, 104], rear: [35, 55], side: [35, 55], triceps: [52, 73], chest: [37, 61], shoulders: [35, 55], biceps: [52, 73], abs: [61, 101], glutes: [103, 127], hams: [129, 152], quads: [108, 150], calves: [155, 192] };
// How lit a muscle is: main muscles (worked directly) start dim and glow as sets get checked off;
// helping muscles do the same, softer. state = { m: { role: 'main' | 'help', p: 0..1 } }
function muscleOpacity(st, floor = 0) {
  if (!st) return 0;
  return st.role === 'main' ? Math.max(floor, 0.2) + st.p * (1 - Math.max(floor, 0.2)) : 0.12 + floor / 2 + st.p * (0.43 - floor / 2);
}
// One body view as SVG. key names it so the light-up can animate from where it was last time.
const bodyLast = {};
function bodySVG(side, state, key, opts = {}) {
  // The drawing has one shoulder cap: it shows front and side delts together, the stronger of the two.
  if (state.side) {
    const a = state.shoulders, c = state.side;
    state = { ...state, shoulders: !a ? c : a.role === c.role ? { role: a.role, p: Math.max(a.p, c.p) } : a.role === 'main' ? a : c };
  }
  const b = BODY[side], vb = opts.vb || '0 0 100 214';
  const seen = {};
  const part = (m, d) => {
    const st = state[m], o = muscleOpacity(st, opts.floor), id = `${key}:${side}:${m}`;
    const from = seen[id] ?? (seen[id] = bodyLast[id] ?? (st ? muscleOpacity({ ...st, p: 0 }, opts.floor) : 0));
    bodyLast[id] = o;
    return `<path class="bm-m${st ? ` ${st.role}` : ''}${st && st.p >= 1 ? ' lit' : ''}" d="${d}"${st ? ` style="fill-opacity:${from.toFixed(3)}" data-o="${o.toFixed(3)}"` : ''}/>`;
  };
  const both = d => `${d} Z ${mirrorPath(d)} Z`;
  return `<svg class="bm${opts.cls ? ` ${opts.cls}` : ''}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="bm-sil" d="${both(b.sil)} ${both(b.head)}"/>
    ${b.parts.map(([m, d]) => part(m, d) + part(m, mirrorPath(d))).join('')}
    ${b.center.map(([m, d]) => part(m, d)).join('')}
    <path class="bm-line" d="${b.lines}"/>
  </svg>`;
}

// The muscles a set of lifts works: main where any lift hits it directly, helping otherwise.
// p is the share of that muscle's sets checked off (helping sets count half).
function muscleState(exs) {
  const plan = {}, done = {}, role = {}, mPlan = {}, mDone = {};
  exs.forEach(e => {
    const ms = Object.entries(musclesShown(e.name)), top = Math.max(0, ...ms.map(([, f]) => f));
    const n = e.sets.length, d = e.sets.filter(s => s.done).length;
    ms.forEach(([m, f]) => {
      plan[m] = (plan[m] || 0) + f * n;
      done[m] = (done[m] || 0) + f * d;
      // A lift with no direct muscle (like a carry) still counts its biggest one as main.
      if (f >= 1 || f === top) { role[m] = 'main'; mPlan[m] = (mPlan[m] || 0) + n; mDone[m] = (mDone[m] || 0) + d; } else if (!role[m]) role[m] = 'help';
    });
  });
  // A main muscle fills from the lifts that train it; lifts that only help don't hold it back.
  const st = {};
  Object.keys(plan).forEach(m => {
    if (!(plan[m] > 0)) return;
    st[m] = role[m] === 'main' ? { role: 'main', p: Math.min(1, mDone[m] / mPlan[m]) } : { role: 'help', p: Math.min(1, done[m] / plan[m]) };
  });
  return st;
}
const byRole = st => ['main', 'help'].map(r => Object.keys(MUSCLES).filter(m => st[m] && st[m].role === r));
function muscleChips(st) {
  const [main, help] = byRole(st);
  const chip = m => `<span class="bm-chip ${st[m].role}${st[m].p >= 1 ? ' lit' : ''}" style="--p:${Math.round(st[m].p * 100)}%">${MUSCLES[m]}</span>`;
  return `<div class="bc-row"><span class="bc-key main">Main</span>${main.map(chip).join('')}</div>
    ${help.length ? `<div class="bc-row"><span class="bc-key help">Helping</span>${help.map(chip).join('')}</div>` : ''}`;
}
// The lift you're on: the first one with sets left (or the last one once everything's done).
const currentLift = w => { const i = w.exercises.findIndex(e => e.sets.some(s => !s.done)); return i >= 0 ? i : w.exercises.length - 1; };
// The day's body map: every muscle today's lifts work, lighting up as sets get checked off.
// While you're lifting, switch to just the lift you're on.
function bodyCard(w) {
  if (!w.exercises.some(e => Object.keys(musclesShown(e.name)).length)) return '';
  const live = isLive(w) && w.exercises.some(e => e.sets.some(s => !s.done));
  const mode = live && S.settings.bodyView === 'lift' ? 'lift' : 'day';
  const ce = w.exercises[currentLift(w)];
  const st = muscleState(mode === 'lift' ? [ce] : w.exercises);
  if (!Object.keys(st).length) return '';
  const key = `w:${w.id}:${mode}${mode === 'lift' ? `:${ce.key}` : ''}`;
  const done = Object.values(st).filter(x => x.role === 'main' && x.p >= 1).length, mains = Object.values(st).filter(x => x.role === 'main').length;
  return `<div class="card body-card">
    <div class="bc-head">
      <div><div class="lbl" style="margin:0">${mode === 'lift' ? 'Up now' : live ? 'Muscles today' : 'Muscles worked'}</div>
      <div class="bc-sub">${mode === 'lift' ? esc(ce.name) : live ? `${done} of ${mains} main muscles done` : `${mains} main ${mains === 1 ? 'muscle' : 'muscles'}`}</div></div>
    </div>
    ${live ? `<div class="seg bc-seg"><button class="${mode === 'day' ? 'on' : ''}" data-a="bm-view" data-v="day">Whole day</button><button class="${mode === 'lift' ? 'on' : ''}" data-a="bm-view" data-v="lift">This lift</button></div>` : ''}
    <div class="bc-figs">
      <figure>${bodySVG('front', st, key)}<figcaption>Front</figcaption></figure>
      <figure>${bodySVG('back', st, key)}<figcaption>Back</figcaption></figure>
    </div>
    ${muscleChips(st)}
  </div>`;
}
// The small picture on each lift: the side of the body its main muscles are on, zoomed to the upper or
// lower body when that's all it works, lighting up set by set.
function exMuscles(w, i) {
  const e = w.exercises[i], st = muscleState([{ ...e, sets: e.sets.length ? e.sets : [{ done: false }] }]);
  const ms = Object.keys(st);
  if (!ms.length) return '';
  const [main, help] = byRole(st), sideW = { front: 0, back: 0 };
  main.forEach(m => { sideW[BODY_SIDE[m]] += 1; });
  const side = sideW.back > sideW.front ? 'back' : 'front';
  const y0 = Math.max(0, Math.min(...ms.map(m => MUSCLE_Y[m][0])) - 8), y1 = Math.min(214, Math.max(...ms.map(m => MUSCLE_Y[m][1])) + 8);
  const h = y1 - y0, wd = Math.min(100, Math.max(60, h * 0.9)), vb = `${(50 - wd / 2).toFixed(1)} ${y0} ${wd.toFixed(1)} ${h}`;
  return `<div class="ex-mus">${bodySVG(side, st, `x:${w.id}:${i}:${e.key}`, { vb, cls: 'bm-thumb', floor: 0.45 })}
    <div class="ex-mus-t"><b>${main.map(m => MUSCLES[m]).join(', ')}</b>${help.length ? `<span>Helps: ${help.map(m => MUSCLES[m].toLowerCase()).join(', ')}</span>` : ''}</div></div>`;
}
// Fade each muscle from where it was to where it is now (a full redraw would otherwise jump).
function lightMuscles() {
  const els = document.querySelectorAll('.bm-m[data-o]');
  if (!els.length) return;
  void document.body.offsetWidth; // lay out the starting look first, so the change below animates
  els.forEach(el => { el.style.fillOpacity = el.dataset.o; });
}

// ----- too sore today -----
// Pick what's sore and today's lifts work around it: lifts aimed at it sit out (until you un-pick it),
// lifts it only helps with stay but go lighter, and lifts for muscles that are behind this week fill in.
const SORE_GROUPS = { chest: ['Chest', ['chest']], back: ['Back', ['back']], shoulders: ['Shoulders', ['shoulders', 'side', 'rear']], arms: ['Arms', ['biceps', 'triceps']], legs: ['Legs', ['quads', 'hams', 'glutes', 'calves']], core: ['Core', ['abs']] };
const soreFor = date => ((S.body[date] || {}).sore || []).filter(g => SORE_GROUPS[g]);
const soreMuscles = date => soreFor(date).flatMap(g => SORE_GROUPS[g][1]);
const soreHit = (name, ms) => sum(ms.map(m => musclesOf(name)[m] || 0));
function soreHelpers(name, date) {
  const ms = soreMuscles(date), hit = soreHit(name, ms);
  if (!hit || hit >= 1) return '';
  const names = ms.filter(m => musclesOf(name)[m]).map(m => MUSCLES[m].toLowerCase());
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}
function applySore(w) {
  const ms = soreMuscles(w.date), started = e => e.sets.some(x => x.done);
  w.soreOut = w.soreOut || [];
  // Start over each time: drop fill-ins not started yet and bring back lifts that aren't sore any more.
  w.exercises = w.exercises.filter(e => !e.soreAdd || started(e) || hasExNote(e));
  w.soreOut = w.soreOut.filter(e => {
    if (soreHit(e.name, ms) >= 1) return true;
    fillSets(e, w);
    w.exercises.splice(Math.min(e.at ?? w.exercises.length, w.exercises.length), 0, e);
    return false;
  });
  w.exercises = w.exercises.filter((e, i) => {
    if (started(e) || soreHit(e.name, ms) < 1) return true;
    w.soreOut.push({ ...e, at: i });
    return false;
  });
  w.soreOut.forEach(e => { delete e.soreAdd; });
  if (!w.soreOut.length) return;
  // Fill in with lifts from your other workouts for muscles that aren't sore, most behind this week first.
  const have = new Set([...w.exercises, ...w.soreOut].map(e => e.key));
  const vol = weeklyVolume(weekStart(w.date)), need = {};
  vol.forEach(v => { need[v.m] = v.goal - v.done; });
  w.exercises.forEach(e => Object.entries(musclesOf(e.name)).forEach(([m, f]) => { need[m] -= f * e.sets.length; }));
  const y = addDays(w.date, -1), worked = new Set();
  S.workouts.filter(x => x.date === y).forEach(x => (x.exercises || []).forEach(e => { if (doneSets(e).length) Object.entries(musclesOf(e.name)).forEach(([m, f]) => { if (f >= 1) worked.add(m); }); }));
  const main = name => Object.entries(musclesOf(name)).sort((a, b) => b[1] - a[1])[0];
  const pool = [], seen = new Set();
  allPlans().filter(p => p && p.type === 'strength').forEach(p => (p.groups || []).forEach(g => g.forEach(x => {
    const k = keyOf(x.name), m = main(x.name);
    if (!m || m[1] < 1 || seen.has(k) || have.has(k) || REHAB_WORDS.test(x.name) || soreHit(x.name, ms) > 0 || worked.has(m[0])) return;
    seen.add(k);
    pool.push({ x, m: m[0], score: need[m[0]] + (recentPerf(k, w, 1).length ? 0.5 : 0) });
  })));
  pool.sort((a, b) => b.score - a.score);
  const picks = [], used = new Set();
  pool.forEach(c => { if (picks.length < Math.min(3, w.soreOut.length) && !used.has(c.m)) { used.add(c.m); picks.push(c.x); } });
  let gid = Math.max(0, ...w.exercises.map(e => +e.group || 0)) + 1;
  picks.forEach(x => { const e = sessionExercise(x, gid++, w); e.soreAdd = true; insertByEffort(w, e); });
}
// Make-up lifts: the whole week is connected. Muscles matter more than exact exercises, but each
// one should get direct work every week (twice is better for growth). Walking the week so far:
// - days already gone count what you actually lifted, and their planned lifts you didn't do are owed;
// - today counts what's in today's workout, so a lift you removed, swapped, or sat out sore is owed;
// - days still ahead count their own plan.
// An owed lift whose main muscle has no direct work yet this week moves in: at most 2 a day, up to 3
// sets each, before the small lifts. A lift you removed today never comes back today; it moves on to
// your next lifting day. Runs again whenever today's workout changes. Past days stay as they were.
function applyMakeUp(w) {
  if (w.type !== 'strength' || w.short) return [];
  const today = todayStr();
  if (w.date < today) return [];
  const started = e => e.sets.some(x => x.done);
  const had = new Set(w.exercises.filter(e => e.makeUp && !started(e)).map(e => e.key));
  w.exercises = w.exercises.filter(e => !e.makeUp || started(e) || hasExNote(e));
  const ws = weekStart(w.date), dropped = new Set(w.dropped || []);
  // Weekly sets per muscle (direct 1, helpers ½): what this week's plan calls for, and what you've done
  // plus what's still planned. A lift is owed when one of its muscles would end the week under half.
  const have = new Set(), got = {}, need = {}, owed = [];
  const add = (bag, name, n) => Object.entries(musclesOf(name)).forEach(([m, f]) => { bag[m] = (bag[m] || 0) + f * n; });
  const count = (name, n) => { have.add(keyOf(name)); add(got, name, n); };
  for (let i = 0; i < 7; i++) { const plan = planOn(addDays(ws, i)); if (plan && plan.type === 'strength') (plan.groups || []).forEach(g => g.forEach(x => add(need, x.name, x.sets || 3))); }
  w.exercises.forEach(e => count(e.name, e.sets.length));
  S.workouts.filter(o => o.id !== w.id && o.date >= ws && o.date <= w.date).forEach(o => (o.exercises || []).forEach(e => { if (doneSets(e).length) count(e.name, doneSets(e).length); }));
  const owe = d => { const plan = planOn(d); if (plan && plan.type === 'strength') (plan.groups || []).forEach(g => g.forEach(x => owed.push({ x, d }))); };
  for (let d = ws; d < w.date; d = addDays(d, 1)) {
    if (d < today) { owe(d); continue; }
    const sess = d === today ? todaySession() : (planOn(d) || {}).type === 'strength' ? buildSession(planKeyOn(d), d) : null;
    if (d === today) owe(d);
    if (sess && sess.type === 'strength') (sess.exercises || []).forEach(e => count(e.name, e.sets.length));
  }
  for (let d = addDays(w.date, 1); d < addDays(ws, 7); d = addDays(d, 1)) {
    const plan = planOn(d);
    if (plan && plan.type === 'strength') (plan.groups || []).forEach(g => g.forEach(x => count(x.name, x.sets || 3)));
  }
  const low = m => (got[m] || 0) < 0.5 * (need[m] || 0);
  // Keep the day a sensible size: about one extra lift past a full plan day.
  let total = sum(w.exercises.map(e => e.sets.length));
  const sore = soreMuscles(w.date), seen = new Set(), cands = [];
  owed.forEach(({ x, d }) => {
    const k = keyOf(x.name), main = Object.entries(musclesOf(x.name)).filter(([, f]) => f >= 1).map(([m]) => m);
    if (seen.has(k) || have.has(k) || dropped.has(k) || REHAB_WORDS.test(x.name) || !main.length || soreHit(x.name, sore) >= 1) return;
    seen.add(k);
    cands.push({ x, d, main, iso: classify({ ...x }).kind === 'iso' });
  });
  cands.sort((p, q) => p.iso - q.iso);
  let gid = Math.max(0, ...w.exercises.map(e => +e.group || 0)) + 1;
  const added = [];
  cands.forEach(c => {
    const n = Math.min(c.x.sets || 3, 3);
    if (added.length >= 2 || !c.main.some(low) || total + n > 33) return;
    add(got, c.x.name, n); total += n;
    const e = sessionExercise({ ...c.x, sets: n }, gid++, w);
    e.makeUp = fmtDate(c.d, { weekday: 'long' });
    insertByEffort(w, e);
    added.push(e);
  });
  return added.filter(e => !had.has(e.key)).map(e => e.name);
}
// After a change to today's workout: where a removed lift's muscle gets made up (today or a day ahead).
function weekShift(w, e) {
  const added = applyMakeUp(w);
  if (added.length) return ` Added ${added.join(' and ')} so every muscle still gets its week.`;
  if (!e || w.date !== todayStr()) return '';
  const main = Object.entries(musclesOf(e.name || e.key)).filter(([, f]) => f >= 1).map(([m]) => m);
  for (let d = addDays(w.date, 1); d <= addDays(weekStart(w.date), 6); d = addDays(d, 1)) {
    const plan = planOn(d);
    if (!plan || plan.type !== 'strength') continue;
    const ahead = buildSession(planKeyOn(d), d), day = fmtDate(d, { weekday: 'long' });
    if (ahead.exercises.some(x => x.makeUp && x.key === e.key)) return ` It moves to ${day}.`;
    if (ahead.exercises.some(x => x.key === e.key)) return ` You've got it again ${day}.`;
    const cover = ahead.exercises.find(x => main.some(m => (musclesOf(x.name)[m] || 0) >= 1));
    if (cover) return ` ${day}'s ${cover.name.toLowerCase()} covers ${main.map(m => MUSCLES[m].toLowerCase()).join(' and ')}.`;
  }
  return '';
}
// Things from recent notes that change today, said up front.
function noteBanner(date) {
  const sick = !energyFor(date) && sickNoted(date), cramp = notedSince(addDays(date, -1), 1, ['cramp'])[0];
  const day = d => (d === addDays(date, -1) ? 'yesterday' : esc(fmtDate(d, { weekday: 'long' })));
  const lines = [];
  if (sick) lines.push(`<b>Sick ${day(sick.date)}.</b> Going easy: lighter effort, no jumps, a walk instead of a run. Feeling fine? Check in OK or Great above.`);
  if (cramp) lines.push(`<b>Cramps ${day(cramp.date)}.</b> Water and something salty an hour before you train.`);
  return lines.length ? `<div class="card note-banner">${lines.map(l => `<div>${l}</div>`).join('')}</div>` : '';
}
function soreCard(w) {
  if (w.type !== 'strength' || w.date !== todayStr()) return '';
  const ex = w.exercises || [];
  if (ex.length && ex.every(e => e.sets.every(x => x.done))) return '';
  const on = soreFor(w.date), out = w.soreOut || [], add = ex.filter(e => e.soreAdd);
  const sug = Object.values(soreFromNotes(w.date)).filter(x => !on.includes(x.about));
  const day = d => (d === w.date ? 'today' : d === addDays(w.date, -1) ? 'yesterday' : esc(fmtDate(d, { weekday: 'long' })));
  return `<div class="card sore-card">
    <div class="lbl" style="margin-top:0">Too sore for something today?</div>
    <div class="chips">${Object.entries(SORE_GROUPS).map(([k, [n]]) => `<button class="chip ${on.includes(k) ? 'on' : sug.some(x => x.about === k) ? 'sug' : ''}" data-a="sore-tog" data-g="${k}">${n}</button>`).join('')}</div>
    ${sug.map(x => `<div class="note-sug"><span>Your notes ${day(x.date)}: <b>${esc(x.k === 'pain-part' ? `${x.word} pain` : `sore ${x.word}`)}</b></span><button class="linkbtn" data-a="sore-tog" data-g="${x.about}">Work around ${MUSCLE_GROUP_NAME[x.about]}</button></div>`).join('')}
    ${on.length ? `<div class="sh-hint">${out.length ? `Sitting out: <b>${out.map(e => esc(e.name)).join(', ')}</b>.` : 'Nothing today hits it hard.'}${add.length ? ` Added: <b>${add.map(e => esc(e.name)).join(', ')}</b>, for muscles behind this week.` : ''} Tap again to undo.</div>`
      : '<div class="sh-hint">Tap one and its lifts sit out while other muscles fill in.</div>'}
  </div>`;
}
function weeklyVolume(ws) {
  const planned = {}, done = {};
  Object.keys(MUSCLES).forEach(m => { planned[m] = 0; done[m] = 0; });
  DAYS.forEach(d => { const day = S.program.days[d]; if (day.type === 'strength') (day.groups || []).forEach(g => g.forEach(x => { Object.entries(musclesOf(x.name)).forEach(([m, f]) => { planned[m] += f * x.sets; }); })); });
  const end = addDays(ws, 6);
  S.workouts.filter(w => w.date >= ws && w.date <= end).forEach(w => (w.exercises || []).forEach(e => {
    Object.entries(musclesOf(e.name)).forEach(([m, f]) => { done[m] += f * doneSets(e).length; });
  }));
  return Object.keys(MUSCLES).map(m => ({ m, name: MUSCLES[m], planned: planned[m], done: done[m], goal: MUSCLE_GOAL[m] || 10 }));
}

// ----- warm-ups, reps left, and deloads -----
// After a set: how many more could you have done? Easy early sets move the next ones up a step.
// A lighter week after about 7 weeks of steady training, or sooner when 3 or more lifts have stalled.
function deloadState(date) {
  const st = S.settings, mk = `${date}|${S.ver}|${st.deloadUntil}|${st.deloadSnooze}|${st.deloadLast}`;
  if (S.deloadMemo && S.deloadMemo.k === mk) return S.deloadMemo.v;
  const v = deloadCalc(date, st);
  S.deloadMemo = { k: mk, v };
  return v;
}
function deloadCalc(date, st) {
  if (st.deloadUntil && date <= st.deloadUntil && date >= (st.deloadLast || date)) return { active: true, until: st.deloadUntil };
  const lifts = S.workouts.filter(w => (w.exercises || []).some(e => doneSets(e).length)).map(w => w.date).sort();
  if (!lifts.length || (st.deloadSnooze && date <= st.deloadSnooze)) return {};
  // A break of 10+ days is recovery too, so count from the first lift after the latest one.
  let start = lifts[0];
  for (let i = 1; i < lifts.length; i++) if (lifts[i] <= date && daysBetween(lifts[i - 1], lifts[i]) >= 10) start = lifts[i];
  const since = st.deloadUntil && st.deloadUntil > start ? st.deloadUntil : start;
  const weeks = Math.floor(daysBetween(since, date) / 7);
  const probe = { id: null, date, createdAt: Infinity };
  const seen = new Set();
  let stalls = 0;
  allPlans().forEach(p => (p.groups || []).forEach(g => g.forEach(x => {
    const k = keyOf(x.name);
    if (seen.has(k)) return;
    seen.add(k);
    // Judge the latest session against its own day's range (heavy Monday and medium Wednesday differ),
    // with the care and stack rules it was planned with.
    const all = recentPerf(k, probe, 8).filter(r => !r.easy);
    if (!all.length || all[0].date < addDays(date, -21)) return;
    const rt = all[0].t || {}, same = r => !r.t || (r.t.min === rt.min && r.t.max === rt.max);
    const t = effTarget({ name: x.name, target: { ...x, sets: x.sets, min: rt.min ?? x.min, max: rt.max ?? x.max } });
    if ((coachPlan(t, all.filter(same).slice(0, 2)) || {}).kind === 'down') stalls++;
  })));
  return { suggest: weeks >= 7 || stalls >= 3, weeks, stalls };
}
function deloadCard(date) {
  const d = deloadState(date);
  if (d.active) return `<div class="card coach coach-hold deload"><span>→ Deload week through ${esc(fmtDate(d.until, { weekday: 'short', month: 'short', day: 'numeric' }))}: same sets, about 10% lighter. This is when you rebuild.</span><button data-a="deload-end">End now</button></div>`;
  if (!d.suggest) return '';
  const why = d.stalls >= 3 ? `${d.stalls} lifts have stalled` : `You've trained ${d.weeks} weeks straight`;
  return `<div class="card plan">
    <div class="ss-tag">Time for a lighter week?</div>
    <div class="sh-hint" style="margin-top:6px">${why}. For a week: same sets about 10% lighter, about 3 left in the tank. You come back stronger.</div>
    <div class="btn-row" style="margin-top:12px"><button class="btn pri" data-a="deload-start">Start it</button><button class="btn" data-a="deload-snooze">Not now</button></div>
  </div>`;
}

function tick(w, i, j) {
  const s = w.exercises[i].sets[j];
  if (s.done) { s.done = false; s.own = true; persist(w); render(); return; }
  if (s.w === '' || s.r === '') { openSetSheet(w, i, j); return; }
  logInOrder(w, i, j);
}
// Log a set, keeping the next set (or this one) still on screen even when the list reorders.
function logInOrder(w, i, j) {
  const e = w.exercises[i], nx = nextSet(w, i, j);
  const [ae, aj] = nx ? [w.exercises[nx[0]], nx[1]] : [e, j];
  const sel = () => setSel(w, w.exercises.indexOf(ae), aj);
  const a = document.querySelector(sel()), t = a && a.getBoundingClientRect().top;
  logSet(w, i, j);
  const b = document.querySelector(sel());
  if (a && b) window.scrollBy(0, b.getBoundingClientRect().top - t);
  if (nx) showAboveTimer(sel());
}
// Today's list reads in the order you lifted: lifts you've started come first, in the order you
// started them (supersets stay together), then the rest as planned. A lift done ahead of ones planned
// before it gets a note on the workout, which the nightly trainer reads. Returns true if anything moved.
function sortByLogged(w) {
  if (w.type !== 'strength' || !Array.isArray(w.exercises)) return false;
  const groups = [];
  w.exercises.forEach(e => { let g = groups.find(x => x.id === e.group); if (!g) groups.push(g = { id: e.group, items: [] }); g.items.push(e); });
  const started = g => g.items.some(e => e.sets.some(x => x.done));
  const firstAt = g => Math.min(...g.items.flatMap(e => e.sets.filter(x => x.done).map(x => +x.at || Infinity)));
  const home = g => g.items.some(isHome), when = g => homeWhen(g.items.find(isHome));
  const gym = groups.filter(g => !home(g)), doneG = gym.filter(started);
  const next = groups.filter(g => home(g) && when(g) === 'before').concat([...doneG].sort((a, b) => (firstAt(a) === firstAt(b) ? 0 : firstAt(a) - firstAt(b))), gym.filter(g => !started(g)), groups.filter(g => home(g) && when(g) === 'after'));
  if (next.every((g, k) => g === groups[k])) return false;
  const name = g => g.items.map(e => e.name).join(' + ');
  w.reorder = w.reorder || [];
  next.forEach((g, k) => {
    if (!started(g) || home(g)) return;
    const passed = groups.slice(0, groups.indexOf(g)).filter(h => next.indexOf(h) > k);
    if (passed.length && !w.reorder.some(r => r.lift === name(g))) w.reorder.push({ lift: name(g), ahead: passed.map(name), at: Number.isFinite(firstAt(g)) ? firstAt(g) : Date.now() });
  });
  w.exercises = next.flatMap(g => g.items);
  return true;
}
// ---------- what you like and what you don't ----------
// Every workout keeps what you swapped away (w.swaps), dropped (w.dropped), and left untouched. Over the
// last 6 weeks that adds up to a habit per lift. A lift you keep skipping gets a "change it for good?"
// card; one you keep choosing counts as a favorite (first in swap lists, never rotated out). "Not for
// me" on a lift records why, and the plan, swaps, and block rotation all steer around it.
const PREF_WHY = { watching: 'People watching', hurts: 'Hurts or feels off', boring: 'Boring', busy: "Machine's always taken", meh: "Just don't like it" };
const prefOf = name => (S.settings.prefs || {})[keyOf(name)] || {};
function setPref(name, patch) {
  const k = keyOf(name), all = { ...(S.settings.prefs || {}) };
  all[k] = { ...(all[k] || {}), ...patch };
  Object.keys(all[k]).forEach(f => all[k][f] == null && delete all[k][f]);
  S.settings.prefs = all; saveSettings();
}
// "People watching" on a bodyweight move sends it home, so it's only off the table at the gym.
const disliked = (name, atHome) => { const p = prefOf(name); return !!p.no && !(atHome && p.no === 'watching' && BODYWEIGHT.test(name)); };
function liftHabits(since) {
  const from = since || addDays(todayStr(), -42), out = {};
  const get = k => (out[k] = out[k] || { done: 0, skipped: 0, swapped: 0, removed: 0, added: 0, to: {} });
  S.workouts.filter(w => w.type === 'strength' && w.date >= from && w.date < todayStr() && hasWork(w)).forEach(w => {
    const swapped = new Map((w.swaps || []).map(x => [keyOf(x.from), x.to]));
    (w.exercises || []).forEach(e => {
      const h = get(e.key);
      if (doneSets(e).length) { h.done++; if (!e.pid && !e.makeUp) h.added++; } else h.skipped++;
    });
    (w.dropped || []).forEach(k => {
      if ((w.exercises || []).some(e => e.key === k)) return;
      const h = get(k), to = swapped.get(k);
      if (to) { h.swapped++; h.to[to] = (h.to[to] || 0) + 1; } else h.removed++;
    });
  });
  Object.values(out).forEach(h => { h.missed = h.skipped + h.swapped + h.removed; });
  return out;
}
const favored = (name, H) => { const h = (H || liftHabits())[keyOf(name)]; return !!prefOf(name).like || !!(h && h.done >= 3 && !h.missed) || !!(h && h.added >= 2); };
// The lift to bring up on today's card, if any: skipped, swapped, or dropped 3+ times in 6 weeks and done
// at most half as often, not already marked, and not waved off in the last 6 weeks.
function habitNudge(w) {
  if (!w || w.date !== todayStr() || w.type !== 'strength') return null;
  const H = liftHabits();
  for (const e of w.exercises || []) {
    const h = H[e.key], pr = prefOf(e.name);
    if (!h || e.sets.some(x => x.done) || pr.no || (pr.keepUntil && pr.keepUntil > todayStr())) continue;
    if (h.missed >= 3 && h.done * 2 <= h.missed) {
      const to = Object.entries(h.to).sort((a, b) => b[1] - a[1])[0];
      return { e, h, to: to ? to[0] : swapPicks(w, w.exercises.indexOf(e))[0]?.name || null };
    }
  }
  return null;
}
function habitCard(w) {
  const n = habitNudge(w);
  if (!n) return '';
  const i = w.exercises.indexOf(n.e), bits = [n.h.skipped && `skipped it ${n.h.skipped}×`, n.h.swapped && `swapped it ${n.h.swapped}×`, n.h.removed && `removed it ${n.h.removed}×`].filter(Boolean);
  return `<div class="card habit-card"><b>${esc(n.e.name)} keeps getting passed over</b>
    <div class="muted small">In the last 6 weeks you ${listAnd(bits)}, and did it ${n.h.done}×. Want to change it for good?</div>
    <div class="btn-row">${n.to ? `<button class="btn pri" data-a="habit-swap" data-wid="${w.id}" data-ex="${i}" data-to="${esc(n.to)}">Swap for ${esc(n.to)}</button>` : ''}
      <button class="btn" data-a="ex-opts" data-wid="${w.id}" data-ex="${i}">Not for me…</button>
      <button class="btn ghost" data-a="habit-keep" data-n="${esc(n.e.name)}">Keep it</button></div></div>`;
}
// Put a lift's replacement into the plan everywhere it appears, and into today if it's not started.
function swapForGood(w, i, to) {
  const e = w.exercises[i], from = e.name;
  allPlans().forEach(p => (p.groups || []).forEach(g => g.forEach((x, k) => {
    if (keyOf(x.name) === keyOf(from)) { g[k] = classify({ ...x, id: uid('e'), name: to, note: '' }); delete g[k].kind; delete g[k].body; classify(g[k]); }
  })));
  saveProgram();
  if (!e.sets.some(x => x.done)) {
    w.swaps = [...(w.swaps || []), { from, to, at: Date.now() }];
    w.dropped = [...new Set([...(w.dropped || []), e.key])];
    e.name = to; e.key = keyOf(to); delete e.makeUp; fillSets(e, w); persist(w);
  }
  return from;
}
// Swap choices for a lift in today's session: same muscles first, gentler ones first for a lift that
// bothers you, favorites ahead of the rest, and nothing you've marked "not for me".
function swapPicks(w, i) {
  const ex = i != null ? w.exercises[i] : null;
  let picks = knownExercises(new Set(w.exercises.map(e => e.key))).filter(p => !disliked(p.name, isHome(ex)));
  if (ex) {
    const mine = musclesOf(ex.name), gentle = careOf(ex.name) ? 1 : 0, H = liftHabits();
    const overlap = n => sum(Object.entries(musclesOf(n)).map(([m, f]) => Math.min(f, mine[m] || 0)));
    const score = n => overlap(n) + (gentle && LOW_STRAIN.test(n) ? 1 : 0) + (favored(n, H) ? 0.4 : 0);
    picks = picks.map(p => ({ p, sc: score(p.name) })).sort((a, b) => b.sc - a.sc).map(x => x.p);
    const near = picks.filter(p => overlap(p.name) > 0);
    if (near.length >= 3) picks = near;
  }
  return picks;
}
function pinSeg(name) {
  const on = pinOn(name);
  return `<label class="lbl">How the weight is counted</label>
    <div class="seg"><button class="${on ? '' : 'on'}" data-a="pin-mode" data-v="">Pounds</button><button class="${on ? 'on' : ''}" data-a="pin-mode" data-v="1">Pin number (1, 2, 3…)</button></div>
    <div class="sh-hint">${on ? 'Log the number on the pin. It goes up one pin at a time, and pin sessions keep their own history.' : "Machine shows 1, 2, 3… instead of pounds? Pick pin number."}</div>`;
}
function notForMeHTML(name, isBodyweight) {
  const pr = prefOf(name);
  const b = (v, n) => `<button class="${pr.no === v ? 'on' : ''}" data-a="pref-no" data-v="${pr.no === v ? '' : v}">${n}</button>`;
  return `<label class="lbl">Not for you?</label>
    <div class="chip-row">${Object.entries(PREF_WHY).map(([v, n]) => b(v, n)).join('')}</div>
    <div class="sh-hint">${pr.no ? `Noted: ${esc(PREF_WHY[pr.no] || pr.no)}. ${pr.no === 'watching' && isBodyweight ? "It's in your At home list now." : "It won't come back in swaps or new blocks. Swap it above to change the plan."} Tap it again to undo.` : 'Pick a reason and the app (and your nightly trainer) steer around it from now on.'}</div>
    <button class="linkbtn" data-a="pref-like">${pr.like ? '★ One of your favorites' : '☆ Mark as a favorite'}</button>`;
}
// Moves that start at bodyweight when there's no history yet.
const NO_WEIGHT = /pull-?up|chin-?up|push-?up|plank|flutter|dead ?bug|hollow|leg raise|bodyweight/i;
const BODYWEIGHT = /pull-?up|chin-?up|push-?up|\bdips?\b|plank|crunch|sit-?up|flutter|dead ?bug|hollow|leg raise|lunge|bodyweight|glute bridge|mace/i;

// ---------- 6-week blocks ----------
// The same week every week gets stale, and a fresh angle on small muscles helps them grow. So every
// 6 weeks half the smaller lifts move to the next cousin in their family (the other half next time,
// so each version gets 12 weeks to progress). Big lifts stay so their numbers keep climbing. A favorite never rotates out, a lift you've marked "not for me" never rotates in, and
// a lift that bothers you stays as it is.
const BLOCK_WEEKS = 6;
function rotateBlock() {
  const b = S.settings.block;
  if (!b || !b.start) return null;
  const due = addDays(b.start, BLOCK_WEEKS * 7);
  if (todayStr() < due) return null;
  const H = liftHabits(addDays(todayStr(), -BLOCK_WEEKS * 7)), changes = [];
  const inPlan = () => new Set(allPlans().flatMap(p => (p.groups || []).flat().map(x => keyOf(x.name))));
  let slot = 0;
  DAYS.map(d => S.program.days[d]).filter(d => d && d.type === 'strength').forEach(day => (day.groups || []).forEach(g => g.forEach((x, k) => {
    const fam = familyOf(x.name);
    if (!fam) return;
    if ((slot++ + b.n) % 2 || favored(x.name, H) || careOf(x.name)) return;
    const used = inPlan(), at = fam.findIndex(n => keyOf(n) === keyOf(x.name));
    for (let s = 1; s < fam.length; s++) {
      const n = fam[(at + s) % fam.length];
      if (used.has(keyOf(n)) || disliked(n, x.place === 'home')) continue;
      const y = { ...x, id: uid('e'), name: n, note: /per (side|leg|arm)|max reps/i.test(x.note || '') ? x.note : '' };
      delete y.kind; delete y.body; classify(y);
      g[k] = y; changes.push(`${x.name} → ${n}`);
      break;
    }
  })));
  b.log = [...(b.log || []), { n: b.n + 1, start: weekStart(todayStr()), changes }].slice(-12);
  b.n += 1; b.start = weekStart(todayStr());
  saveSettings();
  if (changes.length) { saveProgram(); S.notice = `New 6-week block: ${listAnd(changes)}. Big lifts stay the same so they keep climbing.`; }
  return changes;
}
const nextBlockOn = () => (S.settings.block && S.settings.block.start ? addDays(S.settings.block.start, BLOCK_WEEKS * 7) : null);

// The next set to do: the rest of this round in a superset (A1, B1, then A2…), then the next exercise.
function nextSet(w, i, j) {
  const ex = w.exercises, grp = ex.map((e, k) => k).filter(k => ex[k].group === ex[i].group);
  const rounds = Math.max(...grp.map(k => ex[k].sets.length));
  for (let jj = j; jj < rounds; jj++) {
    for (const k of grp) if ((jj > j || k > i) && ex[k].sets[jj] && !ex[k].sets[jj].done) return [k, jj];
  }
  for (const k of grp) { const jj = ex[k].sets.findIndex(x => !x.done); if (jj >= 0 && !(k === i && jj === j)) return [k, jj]; }
  for (let k = 0; k < ex.length; k++) {
    if (grp.includes(k)) continue;
    const jj = ex[k].sets.findIndex(x => !x.done);
    if (jj >= 0 && k > i) return [k, jj];
  }
  return null;
}
const setSel = (w, i, j) => `.check[data-wid="${w.id}"][data-ex="${i}"][data-s="${j}"]`;
// Re-render without the page jumping: whatever is at `sel` stays where it was on screen.
function keepInPlace(sel, fn) {
  const a = document.querySelector(sel), t = a && a.getBoundingClientRect().top;
  fn();
  const b = document.querySelector(sel);
  if (a && b) window.scrollBy(0, b.getBoundingClientRect().top - t);
}
// Make sure the next set row is in view: below the rest timer (top corner) and above the tab bar.
function showAboveTimer(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  const r = el.closest('.set').getBoundingClientRect();
  const timer = $('#timer'), tabs = $('#tabs');
  const floor = (tabs ? tabs.getBoundingClientRect().top : innerHeight) - 12;
  const ceil = timer && !timer.hidden ? timer.getBoundingClientRect().bottom + 10 : 70;
  if (r.bottom > floor) window.scrollBy({ top: r.bottom - floor + 8, behavior: 'smooth' });
  else if (r.top < ceil) window.scrollBy({ top: r.top - ceil, behavior: 'smooth' });
}

function logSet(w, i, j) {
  const e = w.exercises[i], s = e.sets[j];
  s.done = true;
  s.at = Date.now();
  e.sets.forEach((x, k) => { if (k > j && !x.done && x.w === '') x.w = s.w; });
  const today = isLive(w);
  let say = null;
  if (today) {
    say = setReaction(w, i, j, adjustRest(w, e, j));
    if (say) S.say[`${w.id}:${e.key}`] = { ...say, at: Date.now() };
    sortByLogged(w);
  }
  persist(w);
  haptic();
  // In a superset, rest only after the whole round is done.
  if (today) {
    const grp = w.exercises.filter(x => x.group === e.group);
    const roundDone = grp.every(x => !x.sets[j] || x.sets[j].done);
    if (roundDone) startTimer(restFor(w, e) + ((say && say.rest) || 0));
    else { startTimer(0, true); toast(`Next: ${grp.find(x => x.sets[j] && !x.sets[j].done).name}`); }
  }
  render();
}

// ---------- pocket coach ----------
// One voice across the app: short, casual, and only when it's worth saying. Lines are worked out live
// from what you've logged and the time of day, and they're only ever about today. Past days show
// exactly what you logged.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const anyOf = a => a[Math.floor(Math.random() * a.length)];
// The same pick all day for a given seed, so a line doesn't flicker between renders.
const dayPick = (a, seed) => { let h = 0; for (const ch of `${todayStr()}|${seed}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return a[h % a.length]; };
const hourNow = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const clockNow = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctUp = (a, b) => Math.round((a / b - 1) * 100);

// The science behind a line, for its ⓘ.
const WHY = {
  rest: { title: 'Why rest longer?', body: ['Longer rests between hard sets (about 2 to 3 minutes on big lifts) get you more reps, and more good reps means more growth.', 'A big drop in reps usually means you came back before you were ready.'] },
  sessionSets: { title: 'Why stop there?', body: ['Past about 10 hard sets for one muscle in one workout, extra sets add a lot less. Spreading them across the week works better.', 'Energy left over? Bank it for next time.'] },
  rir: { title: 'Reps in the tank', body: ['Stopping 1 or 2 reps short of failure builds about as much muscle as going all-out, with less fatigue, so you recover faster.', 'All-out now and then is fine, especially on a last set.'] },
  bed: { title: 'Protein before bed', body: ['A slow protein before sleep (cottage cheese, Greek yogurt, or casein) keeps muscle repair going overnight.', 'It counts toward your daily total like anything else.'] },
  gap: { title: 'Spreading it out', body: ['Protein every 3 to 5 hours keeps muscle building topped up through the day.', 'Your daily total still matters most. Spacing it out is the bonus.'] },
  water: { title: 'Daily weight swings', body: ['Weight swings 1 to 3 lb day to day from water, salt, carbs, and when you last ate. That isn’t fat.', 'The 7-day average is the real trend, so that’s the one to watch.'] },
  weigh: { title: 'Why the morning?', body: ['After the bathroom and before you eat or drink is your most consistent weight, so day-to-day numbers compare fairly.'] },
  rest_day: { title: 'Rest days', body: ['Lifting is the signal. Muscle actually gets built while you recover, so rest days are part of the plan.', 'Easy movement like a walk helps you feel fresh without cutting into recovery.'] },
};
const mealWhy = (g, kg) => ({ title: 'How much per meal', body: [`About 0.4 g per kg of bodyweight per meal works well, so roughly ${g} g for you, 3 to 5 times a day.`, 'Bigger servings still count. The daily total matters most.', `Based on ${Math.round(kg * 2.2046)} lb.`] });

// ----- every earlier session of a lift -----
// Estimated max uses weight × reps (sets of 15 or fewer, where it's a fair guess at strength).
const bestE1 = sets => Math.max(0, ...sets.filter(s => +s.w > 0 && +s.r > 0 && +s.r <= 15).map(s => e1rm(+s.w, +s.r)));
const bestSetTxt = sets => { const b = [...sets].sort((x, y) => e1rm(+y.w, +y.r) - e1rm(+x.w, +x.r))[0]; return b ? `${fmtW(b.w)} × ${b.r}` : ''; };
function liftHist(key, w) {
  const out = [];
  for (const o of sortedW()) {
    if (o.id === w.id || o.date > w.date || (o.date === w.date && o.createdAt > w.createdAt)) continue;
    const e = (o.exercises || []).find(x => x.key === key && doneSets(x).length);
    if (!e) continue;
    const sets = doneSets(e);
    out.push({ date: o.date, sets, e1: bestE1(sets) });
  }
  return out;
}
const bestIn = (h, from, to) => h.filter(p => p.date >= from && p.date <= to && p.e1).sort((a, b) => b.e1 - a.e1)[0] || null;
// The last break of 3+ weeks in the past 8 weeks, and your best before it.
function breakBefore(h, date) {
  for (let k = 0; k < h.length - 1 && k < 6; k++) {
    if (h[k].date < addDays(date, -56)) break;
    if (daysBetween(h[k + 1].date, h[k].date) >= 21) return { best: Math.max(...h.slice(k + 1, k + 4).map(p => p.e1)), since: k };
  }
  return null;
}
// How today's best set compares with around this time last year, about a month ago, or when you first
// logged it. Only worth a mention when it's a real step: +5% on a year or a month, +10% since the start.
function longView(e, w, h) {
  const cur = bestE1(doneSets(e));
  if (!cur || !h.length) return null;
  const yr = bestIn(h, addDays(w.date, -410), addDays(w.date, -320)), mo = bestIn(h, addDays(w.date, -60), addDays(w.date, -21));
  // Well under your best (coming back from time off), "since you started" and "since last month" would
  // flatter a dip, so only a year-on-year gain counts then.
  const peak = Math.max(...h.map(p => p.e1)), dip = cur < peak * 0.9;
  const first = h.filter(p => p.e1).slice(-3).sort((a, b) => b.e1 - a.e1)[0], start = !dip && h.length >= 6 && first && daysBetween(h[h.length - 1].date, w.date) >= 90 ? first : null;
  const why = (p, when) => ({ title: `Since ${when}`, body: [`${fmtDate(p.date, { month: 'short', day: 'numeric', year: 'numeric' })}: ${bestSetTxt(p.sets)}.`, `Today: ${bestSetTxt(doneSets(e))}.`, 'Compared by estimated max (weight and reps together), so different rep counts still line up.'] });
  if (yr && cur >= yr.e1 * 1.05) return { k: 'year', pct: pctUp(cur, yr.e1), t: `Up ${pctUp(cur, yr.e1)}% on ${e.name} since this time last year. 📈`, why: why(yr, 'this time last year') };
  if (start && cur >= start.e1 * 1.1) {
    const when = fmtDate(h[h.length - 1].date, { month: 'long', year: daysBetween(h[h.length - 1].date, w.date) > 300 ? 'numeric' : undefined });
    return { k: 'start', pct: pctUp(cur, start.e1), t: `Up ${pctUp(cur, start.e1)}% on ${e.name} since you started it in ${when}. 📈`, why: why(start, 'your first sessions') };
  }
  if (mo && !dip && cur >= mo.e1 * 1.05) return { k: 'month', pct: pctUp(cur, mo.e1), t: `Up ${pctUp(cur, mo.e1)}% on this since a month ago. Keep stacking.`, why: why(mo, 'a month ago') };
  return null;
}

// The coach remembers what it told you about each lift's long-term progress, and only brings it up
// again with real news: 3 weeks later and 5 points higher, or a different comparison after 2 weeks.
const coachMem = () => S.settings.coachMem || (S.settings.coachMem = {});
function lvFresh(key, lv, date) {
  const m = coachMem()[key];
  if (!m || m.date === date) return true;
  const days = daysBetween(m.date, date);
  return m.k === lv.k ? days >= 21 && lv.pct >= m.pct + 5 : days >= 14;
}
function lvRemember(key, lv, date) { coachMem()[key] = { k: lv.k, pct: lv.pct, date }; saveSettings(); }

// ----- after a set -----
// Everything worth saying gets a score; the best one shows under the lift, or nothing does.
// Things to act on (weights changing, a big rep drop, an easy day) always show. Praise and history
// show for big moments, or after a few quiet sets, so it never turns into a stream of chatter.
const sayState = w => S.said[w.id] || (S.said[w.id] = { once: {}, quiet: 0 });
function setReaction(w, i, j, tip) {
  const e = w.exercises[i], s = e.sets[j], t = targetOf(e), st = sayState(w);
  const ranged = t.min != null || t.max != null, lo = t.min ?? t.max, hi = t.max ?? t.min;
  const easyDay = lowDay(w.date) || !!w.deload, cut = easyDay ? 2 : 0;
  const wt = +s.w || 0, r = +s.r || 0, done = doneSets(e), allDone = e.sets.every(x => x.done);
  const h = liftHist(e.key, w), c = [];
  const add = (k, score, text, tone, x = {}) => { if (!x.once || !st.once[x.once]) c.push({ k, score, t: text, tone, ...x }); };
  if (tip) add('adjust', 90, tip.t, tip.tone, { act: true });

  // New bests. One more rep than last week is the plan working, so the big moments are a weight you've
  // never handled for real reps, or a clear jump (3%+) in estimated max. Small bests wait their turn.
  const e1 = wt && r <= 15 ? e1rm(wt, r) : 0, allBest = Math.max(0, ...h.map(p => p.e1));
  const heaviest = Math.max(0, ...h.flatMap(p => p.sets.map(x => +x.w || 0)));
  const prWhy = { title: 'A new best', body: [`${fmtW(wt)} × ${r} works out to an estimated max of ${Math.round(e1)} lb.`, `Your best before today was about ${Math.round(allBest)} lb.`, 'Estimated max uses weight and reps together, so 10 reps at 100 and 6 at 115 compare fairly.'] };
  if (h.length >= 3 && wt > heaviest && heaviest && r >= (ranged ? Math.max(3, lo - 2) : 3)) add('pr', 88, `Heaviest you've ever gone on ${e.name}. 🎉`, 'good', { once: `pr:${e.key}`, big: true, why: prWhy });
  else if (e1 && h.length >= 3 && allBest && e1 > allBest * 1.03) add('pr', 82, dayPick([`New best on ${e.name}. 🎉`, `Strongest ${e.name} you've ever logged. 🎉`], e.key), 'good', { once: `pr:${e.key}`, big: true, why: prWhy });
  else if (h.length >= 3) {
    const before = h.flatMap(p => p.sets.filter(x => (+x.w || 0) >= wt && (wt || !+x.w)).map(x => +x.r));
    if (before.length && r >= Math.max(...before) + 2) add('reps-pr', 55, wt ? `Most reps you've ever done at ${fmtW(wt)} lb. 💪` : 'Most reps you\'ve ever done in a set. 💪', 'good', { once: `rp:${e.key}` });
  }

  // Signs you're pushing too hard, or coming back before you're ready.
  const prev = j > 0 ? e.sets[j - 1] : null;
  if (prev && prev.done && ranged && +prev.w === wt && wt) {
    const drop = +prev.r - r;
    if (drop >= Math.max(3, Math.ceil(+prev.r * 0.3)) && r < lo - cut) add('drop', 65, 'Big drop from your last set. Adding 30 sec to your rest.', 'care', { act: true, rest: 30, why: WHY.rest });
    // Caught-up logging (ticks seconds apart) doesn't count; a real short rest that cost reps does.
    const gap = (s.at - (prev.at || 0)) / 1000, solo = w.exercises.filter(x => x.group === e.group).length === 1;
    if (solo && t.kind !== 'iso' && gap >= 20 && gap < 60 && r < (+s.pr || lo)) add('fast', 55, 'Quick turnaround. A full rest gets you more reps.', 'care', { act: true, once: 'fast', why: WHY.rest });
    else if (gap >= 15 && gap <= restFor(w, e) * 0.7 && gap <= restFor(w, e) - 25 && r >= (+s.pr || lo) && r >= +prev.r - 1) add('quick', 50, `Back in ${fmtClock(Math.round(gap))}, before the timer, and still hit ${r}. Noted: next time asks for more.`, 'good', { once: `qk:${e.key}` });
  }
  const pw = s.pw === '' || s.pw == null ? null : +s.pw;
  if (easyDay && pw != null && (wt > pw || (s.pr && r >= +s.pr + 3))) add('easy', 60, 'Easy day, remember. Leave 2 or 3 in the tank.', 'care', { act: true, once: 'easy' });
  else if (!easyDay && bigJump(s, wt)) add('jump', 62, `${fmtW(wt)} lb is a big jump over today's ${fmtW(pw)}. ${ranged && r < lo ? `Reps fell short, so go back to ${fmtW(pw)} for the rest.` : 'Reps held, so the plan will catch up. Bigger jumps than this are where strains happen.'}`, 'care', { act: true, once: `jp:${e.key}` });
  else if (!easyDay && pw && wt >= pw * 1.1 && ranged && r >= lo) add('heavy', 50, `Went heavier and still hit ${r}. Strong.`, 'good', { once: `hv:${e.key}` });
  // The first set of the day: lifting day after day with no rest.
  if (done.length === 1 && !w.exercises.some((x, k) => k !== i && doneSets(x).length)) {
    const n = liftStreakBefore(w.date) + 1;
    if (n >= 6) add('streak', 70, `Day ${n} of lifting in a row. Muscle grows while you rest, so take tomorrow fully off.`, 'care', { act: true, once: 'streak', why: WHY.rest_day });
    else if (!isTrainingDay(w.date) && n >= 3) add('streak', 70, `Lifting on a rest day, ${n} days straight. Go easy today and rest tomorrow.`, 'care', { act: true, once: 'streak', why: WHY.rest_day });
  }
  if (t.sets && j + 1 >= t.sets + 2) add('extra', 48, `${j + 1 - t.sets} extra sets on this one. Fine if it feels good, but the payoff tapers from here.`, 'care', { act: true, once: `x:${e.key}`, why: WHY.sessionSets });
  Object.entries(musclesOf(e.name)).filter(([, f]) => f >= 1).forEach(([m]) => {
    const n = sum(w.exercises.map(x => ((musclesOf(x.name)[m] || 0) >= 1 ? doneSets(x).length : 0)));
    const planned = sum(w.exercises.map(x => ((musclesOf(x.name)[m] || 0) >= 1 ? x.target.sets || 0 : 0)));
    if (n > 10 && n > planned) add('muscle', 55, `That's ${n} ${MUSCLES[m].toLowerCase()} sets today. Past about 10, more in one go adds little.`, 'care', { act: true, once: `m:${m}`, why: WHY.sessionSets });
  });

  // Beat last time on this set (more than the plan's one extra rep).
  const last = h[0], ls = last && last.sets[Math.min(j, last.sets.length - 1)];
  if (ls && daysBetween(last.date, w.date) < 21) {
    const more = r - +ls.r;
    if (wt === +ls.w && more >= 2) add('beat', 45, `${more} more reps than last time. 💪`, 'good', { once: `bt:${e.key}` });
    else if (wt > +ls.w && +ls.w && more >= 1) add('beat', 45, `More weight and more reps than last time. 💪`, 'good', { once: `bt:${e.key}` });
  }

  // Finishing a lift: the bigger picture.
  if (allDone) {
    const brk = breakBefore(h, w.date), cur = bestE1(done);
    if (brk && !st.once[`pr:${e.key}`] && cur >= brk.best * 0.97 && h[0].e1 < brk.best * 0.97) add('back', 80, `Back to your pre-break numbers on ${e.name}. 🙌`, 'good', { once: `bk:${e.key}` });
    // A new best on this lift today already says it, and the same news doesn't repeat week after week.
    const lv = !st.once[`pr:${e.key}`] && longView(e, w, h);
    if (lv && lvFresh(e.key, lv, w.date)) add(lv.k, lv.k === 'month' ? 60 : 75, lv.t, 'good', { once: `lv:${e.key}`, big: true, lv, why: lv.why });
    if (ranged && !easyDay && done.length >= t.sets && done.some(x => +x.w > 0) && done.every(x => +x.r >= hi)) add('top', 55, `Every set at ${hi}. Weight goes up next time.`, 'good', { once: `top:${e.key}` });
  }

  c.sort((a, b) => b.score - a.score);
  // Two big moments a workout, then even good news waits for a few quiet sets.
  // A weight you've never lifted before always gets its moment.
  const acts = c.filter(x => x.act), praise = c.find(x => !x.act && (x.score >= 88 || (x.score >= 70 && (st.big || 0) < 2) || st.quiet >= 3));
  if (!acts.length && !praise) { st.quiet++; return null; }
  st.quiet = 0;
  // A weight change and a big rep drop on the same set: one line, with the longer rest.
  let act = acts[0];
  const drop = acts.find(x => x.k === 'drop');
  if (act && drop && act !== drop) act = { ...act, t: `${act.t} Adding 30 sec to your rest too.`, rest: drop.rest, why: drop.why };
  // Only what's actually said is marked as said; a warning that lost out this set can still show next set.
  [act, act && act.rest && drop, praise].forEach(x => { if (x && x.once) st.once[x.once] = true; });
  if (praise && praise.score >= 70) st.big = (st.big || 0) + 1;
  if (praise && praise.lv) lvRemember(e.key, praise.lv, w.date);
  // A big moment and something to act on: say both, the good news first.
  if (act && praise && praise.score >= 70) return { ...praise, t: `${praise.t} ${act.t}`, tone: act.tone === 'care' ? 'care' : praise.tone, rest: act.rest, why: act.why || praise.why, score: praise.score };
  return act || praise;
}
// After "how many more could you have done?" on a lift's last set.
function rirReaction(w, i) {
  const e = w.exercises[i], s = e.sets[e.sets.length - 1], t = targetOf(e), st = sayState(w);
  const hi = t.max ?? t.min, top = hi != null && doneSets(e).length >= t.sets && doneSets(e).every(x => +x.r >= hi);
  const zeros = w.exercises.filter(x => x.sets.length && x.sets[x.sets.length - 1].rir === 0).length;
  if (s.rir === 0 && zeros >= 3 && !st.once.rir0x) { st.once.rir0x = true; return { t: "That's a lot of all-out sets today. 1 or 2 in the tank builds just as well.", tone: 'care', score: 50, why: WHY.rir }; }
  if (s.rir === 0 && !st.once.rir0) { st.once.rir0 = true; return { t: 'All out. Fine sometimes. Stopping 1 or 2 short grows you just as well.', tone: 'care', score: 50, why: WHY.rir }; }
  return null;
}
// Keeps a closing emoji on the same line as the word before it.
const nb = t => esc(t).replace(/ (\p{Extended_Pictographic})/gu, '\u00a0$1');
const SAY_MARK = { good: '✓', care: '!', up: '▲', down: '▼' };
function sayHTML(w, i, small) {
  const k = `${w.id}:${w.exercises[i].key}`, x = isLive(w) && S.say[k];
  if (!x) return '';
  const fresh = Date.now() - x.at < 1500 ? ' fresh' : '';
  const inner = `<span class="say-mark">${SAY_MARK[x.tone] || '›'}</span><span>${nb(x.t)}</span>`;
  if (small) return `<span class="fold-say say-${x.tone}">${inner}</span>`;
  return x.why ? `<button class="say say-${x.tone}${fresh}" data-a="say-why" data-k="${esc(k)}">${inner}<i>ⓘ</i></button>` : `<div class="say say-${x.tone}${fresh}">${inner}</div>`;
}

// ----- protein through the day -----
// Your usual eating hours, learned from when you log food (8am to 9pm until there's enough to go on).
function eatWindow() {
  const firsts = [], lasts = [], today = todayStr();
  Object.values(S.body).forEach(b => {
    if (b.date >= today || b.date < addDays(today, -30)) return;
    const ats = (b.items || []).map(x => x.at).filter(Boolean);
    if (ats.length < 2) return;
    const hr = t => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };
    firsts.push(hr(Math.min(...ats))); lasts.push(hr(Math.max(...ats)));
  });
  if (firsts.length < 7) return { start: 8, end: 21 };
  const start = clamp(median(firsts), 5, 12), end = clamp(median(lasts) + 0.5, Math.max(17, start + 8), 24);
  return { start, end };
}
// How much you've usually had by this time of day, from the last 3 weeks of logged days.
function usualBy(h) {
  const today = todayStr(), got = [];
  Object.values(S.body).forEach(b => {
    if (b.date >= today || b.date < addDays(today, -21)) return;
    const items = (b.items || []).filter(x => x.at);
    if (items.length < 2 || b.protein < 0.6 * proteinTargetFor(b.date)) return;
    got.push(sum(items.filter(x => { const d = new Date(x.at); return d.getHours() + d.getMinutes() / 60 <= h; }).map(x => +x.g || 0)));
  });
  return got.length >= 5 ? Math.round(median(got) / 5) * 5 : null;
}
// A saved food close to what you need, leaning on the ones you use most.
// Before bed, slow-digesting ones (yogurt, cottage cheese, casein, milk) come first.
const SLOW_FOOD = /yogh?urt|cottage|casein|skyr|quark|milk|cheese/i;
function foodFor(need, slow) {
  const fs = S.foods.filter(f => +f.g >= 10);
  if (!fs.length) return null;
  const aim = clamp(need, 20, 50);
  return fs.map(f => ({ f, s: Math.abs(f.g - aim) / 8 - Math.log2(1 + (f.used || 0)) - (f.fav ? 1 : 0) - (slow && SLOW_FOOD.test(f.name) ? 4 : 0) })).sort((a, b) => a.s - b.s)[0].f;
}
// "Protein shake" reads as "your protein shake" mid-sentence; names like "PB&J" stay as typed.
const lcFirst = n => (/^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n);
function proteinCoach(date) {
  if (date !== todayStr()) return null;
  const b = bodyEntry(date), target = proteinTargetFor(date), have = b.protein, left = target - have, h = hourNow();
  const kg = ((latestWeighIn(date) || {}).weight || 170) / 2.2046, meal = clamp(Math.round(0.4 * kg / 5) * 5, 25, 50);
  const win = eatWindow(), usual = usualBy(h);
  const linear = target * clamp((h - win.start) / (win.end - win.start), 0, 1);
  const pace = usual != null ? Math.min(target, (usual + linear) / 2) : linear;
  const base = { left, have, target };
  if (left <= 0) return { ...base, t: have >= target * 1.4 ? "Way past target. Extra's fine, it just won't build more." : dayPick(['Target hit. 💪', 'Protein done for the day. Nice.', 'Target hit. Your muscles thank you.'], 'p'), tone: 'good' };
  if (h >= win.end - 0.5) {
    const f = foodFor(Math.min(left, 40), true);
    return { ...base, behind: true, urgent: left > 20, t: left <= meal * 1.2 ? `${left} g left. ${f && f.name ? `Your ${lcFirst(f.name)} before bed` : 'Greek yogurt or cottage cheese before bed'} closes it out.` : `${left} g left tonight. Get what you can, a slow protein before bed is a solid move.`, food: f, why: WHY.bed, tone: 'care' };
  }
  if (!have && h < Math.max(11, win.start + 3)) {
    const f = foodFor(meal);
    return { ...base, t: `Start with about ${meal} g at your first meal. It sets up the day.`, food: f, why: mealWhy(meal, kg), tone: '' };
  }
  const lastAt = Math.max(0, ...b.items.map(x => x.at || 0)), gapH = lastAt ? (Date.now() - lastAt) / 36e5 : null;
  const behind = pace - have >= Math.max(20, 0.18 * target);
  if (h >= 17 && left > meal * 2.5) return { ...base, behind: true, urgent: true, t: `${left} g to go. A big protein dinner plus a shake gets you there.`, food: foodFor(meal), why: mealWhy(meal, kg), tone: 'care' };
  if (behind && h >= 11) {
    const f = foodFor(Math.min(left, meal));
    return { ...base, behind: true, urgent: h >= 13, t: `It's ${clockNow()} and you're at ${have} g${usual != null && usual > have + 15 ? ` (usually ~${usual} by now)` : ''}. ${f && f.name ? `Grab your ${lcFirst(f.name)} now` : 'Grab a shake now'} and you're back on pace.`, food: f, why: mealWhy(meal, kg), tone: 'care' };
  }
  if (gapH != null && gapH >= 4.5 && h < win.end - 1.5 && left > 20) return { ...base, t: `${Math.floor(gapH)} hours since your last protein. Good time for a snack.`, food: foodFor(Math.min(left, meal)), why: WHY.gap, tone: '' };
  if (have >= pace + 0.15 * target && have) return { ...base, t: `Ahead of pace. ${left} g to go. 🙌`, tone: 'good' };
  return { ...base, t: `${left} g to go. Right on pace.`, tone: '' };
}
function proteinSayHTML(pc, src) {
  if (!pc) return '';
  const add = pc.food ? `<button class="pc-add" data-a="food-quick" data-n="${esc(pc.food.name)}">+ ${esc(pc.food.name || 'Protein')} · ${pc.food.g} g</button>` : '';
  return `<div class="pcoach ${pc.tone || ''}">${pc.why ? `<button class="pc-txt" data-a="coach-why" data-k="protein">${nb(pc.t)}&nbsp;<i>ⓘ</i></button>` : `<span class="pc-txt">${nb(pc.t)}</span>`}${add}</div>`;
}
// What adding food does to the day, as a quick toast.
function proteinAddSay(g, date) {
  const b = bodyEntry(date), target = proteinTargetFor(date), left = target - b.protein, before = b.protein - g;
  if (date !== todayStr()) return `Added ${g} g`;
  if (before < target && left <= 0) return dayPick(['Target hit! 🎉', 'That does it. Target hit! 🎉', 'Protein done. 🎉'], 'hit');
  if (left <= 0) return `+${g} g`;
  if (left <= 20) return `+${g} g · almost there, ${left} to go`;
  return `+${g} g · ${left} to go`;
}

// ----- weigh-ins -----
// Day-to-day swings are mostly water, so a big one gets a calm word. A new low or high in the
// 7-day average that matches your goal gets a nod. Everything else stays quiet.
function weighSay(b) {
  if (b.date !== todayStr() || b.weight == null) return null;
  const prev = Object.values(S.body).filter(x => x.date < b.date && x.date >= addDays(b.date, -3) && x.weight != null).sort((x, y) => y.date.localeCompare(x.date))[0];
  const diff = prev ? round1(b.weight - prev.weight) : 0, when = prev && prev.date === addDays(b.date, -1) ? 'yesterday' : prev ? fmtDate(prev.date, { weekday: 'long' }) : '';
  if (Math.abs(diff) >= 1.5) return diff > 0 ? `Up ${diff} since ${when}. That's water and salt, not fat. The 7-day average is what counts.` : `Down ${-diff} since ${when}. Mostly water, so watch the 7-day average.`;
  const t = weightTrend(b.date), goal = S.settings.goal;
  if (!t || (goal !== 'cut' && goal !== 'bulk' && goal !== 'slow')) return null;
  const avgs = [];
  for (let k = 1; k <= 60; k++) { const x = weightTrend(addDays(b.date, -k)); if (x) avgs.push(x.avg); }
  if (avgs.length < 14) return null;
  if (goal === 'cut' && t.avg < Math.min(...avgs)) return `Lowest 7-day average in ${avgs.length >= 50 ? '2 months' : 'a while'}: ${t.avg} lb. 👌`;
  if (goal !== 'cut' && t.avg > Math.max(...avgs) && (t.pct == null || t.pct <= GOALS[goal].hi)) return `Highest 7-day average yet: ${t.avg} lb, at a steady pace. 👌`;
  return null;
}

// ----- the line at the top of Today -----
// One thing, the most useful right now: the wrap-up once you're done, where you're at mid-workout,
// protein when it's slipping late in the day, the morning weigh-in, or what today holds.
function wrapHighlight(w) {
  const ex = w.exercises.filter(e => doneSets(e).length);
  const prs = ex.filter(e => {
    const h = liftHist(e.key, w), best = Math.max(0, ...h.map(p => p.e1)), heavy = Math.max(0, ...h.flatMap(p => p.sets.map(x => +x.w || 0)));
    return h.length >= 3 && best && (bestE1(doneSets(e)) > best * 1.03 || (heavy && Math.max(...doneSets(e).map(x => +x.w || 0)) > heavy));
  });
  if (prs.length) return prs.length === 1 ? `New best on ${prs[0].name}. 🎉` : `${prs.length} new bests today. 🎉`;
  const lv = ex.map(e => ({ e, lv: longView(e, w, liftHist(e.key, w)) })).filter(x => x.lv && x.lv.k !== 'month' && lvFresh(x.e.key, x.lv, w.date)).sort((a, b) => b.lv.pct - a.lv.pct)[0];
  if (lv && (coachMem()[lv.e.key] || {}).date !== w.date) lvRemember(lv.e.key, lv.lv, w.date);
  if (lv) return lv.lv.k === 'year' ? `${lv.e.name} is up ${lv.lv.pct}% on last year. 📈` : `${lv.e.name} is up ${lv.lv.pct}% since you started it. 📈`;
  const prevW = sortedW().find(o => o.id !== w.id && o.dayKey === w.dayKey && o.date < w.date && (o.exercises || []).some(e => doneSets(e).length));
  const vol = x => sum((x.exercises || []).flatMap(e => doneSets(e).map(s => (+s.w || 0) * (+s.r || 0))));
  if (prevW && daysBetween(prevW.date, w.date) <= 14 && vol(prevW) && vol(w) >= vol(prevW) * 1.05) return `More total work than last ${DAY_NAMES[dayKeyOf(prevW.date)] || 'time'}.`;
  return '';
}
function planPreview(w) {
  const gym = w.exercises.filter(e => !isHome(e)), first = w.exercises.filter(e => isHome(e) && homeWhen(e) === 'before').map(e => e.name);
  const n = gym.length, sets = sum(gym.map(e => e.sets.length));
  const mins = Math.round(sets * (S.settings.restSec + 50) / 60 / 5) * 5;
  const up = w.exercises.find(e => e.coach && e.coach.kind === 'up' && e.coach.w), back = w.exercises.find(e => e.coach && e.coach.kind === 'down');
  const focus = up ? `${up.name} goes up to ${fmtW(up.coach.w)} lb.` : back ? `Easing back in on ${back.name}.` : 'Same weights, chasing reps.';
  return `${first.length ? `${listAnd(first)} at home first. Then ` : ''}${n} ${n === 1 ? 'lift' : 'lifts'}${first.length ? ' at the gym' : ''}, about ${mins} min. ${focus}`;
}
function dayCoach(date, w) {
  if (date !== todayStr()) return null;
  const h = hourNow(), b = bodyEntry(date), strength = w.type === 'strength' && w.exercises.length;
  const gymEx = strength ? w.exercises.filter(e => !isHome(e)) : [];
  const total = sum(gymEx.map(e => e.sets.length)), done = sum(gymEx.map(e => e.sets.filter(s => s.done).length));
  const homeLeft = strength ? w.exercises.filter(e => isHome(e) && e.sets.some(s => !s.done)).map(e => e.name) : [];
  const afterLeft = strength ? w.exercises.filter(e => isHome(e) && homeWhen(e) === 'after' && e.sets.some(s => !s.done)).map(e => e.name) : [];
  const homeTail = afterLeft.length ? ` At home after: ${listAnd(afterLeft)}.` : homeLeft.length ? ` At home: ${listAnd(homeLeft)}.` : '';
  const acts = (w.activities || []).filter(actDone).length, pc = proteinCoach(date);
  const pTail = pc && pc.left > 0 && h >= 11 && h < 22 ? ` Protein next: ${pc.left} g to go.` : '';
  if (strength && done && done >= total) {
    const hi = wrapHighlight(w);
    return { t: `${homeLeft.length ? 'Gym done' : "That's a wrap"} ✓ ${done} sets in ${liftMinutes(w)} min.${hi ? ` ${hi}` : ''}${homeTail || pTail}`, tone: 'good' };
  }
  if (!strength && w.type !== 'rest' && acts) return { t: `Done for today ✓${pTail}`, tone: 'good' };
  if (strength && done) {
    const mins = Math.max(5, Math.round((total - done) * (S.settings.restSec + 50) / 60 / 5) * 5);
    return { t: `${done} of ${total} sets. About ${mins} min to go.${homeTail}`, tone: '' };
  }
  if (pc && pc.urgent) return { ...pc, src: 'protein' };
  if (w.type === 'rest' && !acts) return { t: dayPick(['Rest day. This is when the muscle actually gets built.', 'Rest day. Recover, eat your protein, sleep well.', 'Rest day. A walk is a nice bonus, nothing more needed.'], 'rest'), tone: '', why: WHY.rest_day };
  if (h < 11 && b.weight == null && !b.protein) return { t: `Morning! Weigh in before breakfast${strength ? ', then lift later' : ''}.`, tone: '', why: WHY.weigh, btn: { a: 'go-body', label: 'Weigh in' } };
  if (h >= 21 && strength) return { t: 'Late one. A short session still counts, or rest up and go tomorrow.', tone: '', btn: w.exercises.length > 3 && !w.short ? { a: 'short-version', wid: w.id, label: '25-min version' } : null };
  if (h >= 18 && strength && w.exercises.length > 3 && !w.short) return { t: 'Still time today. Tight on time? The 25-min version works.', tone: '', btn: { a: 'short-version', wid: w.id, label: '25-min version' } };
  if (strength && lowDay(date)) return { t: 'Low day, lighter plan. Showing up is the win today.', tone: '' };
  if (strength) return { t: planPreview(w), tone: '' };
  return null;
}
function dayCoachHTML(dc) {
  if (!dc) return '';
  const txt = dc.why ? `<button class="dc-txt" data-a="coach-why" data-k="${dc.src || 'day'}">${nb(dc.t)}&nbsp;<i>ⓘ</i></button>` : `<span class="dc-txt">${nb(dc.t)}</span>`;
  const btn = dc.btn ? `<button class="dc-btn" data-a="${dc.btn.a}"${dc.btn.wid ? ` data-wid="${dc.btn.wid}"` : ''}>${esc(dc.btn.label)}</button>`
    : dc.food ? `<button class="dc-btn" data-a="food-quick" data-n="${esc(dc.food.name)}">+ ${esc(dc.food.name || 'Protein')} · ${dc.food.g} g</button>` : '';
  return `<div class="daycoach ${dc.tone || ''}">${txt}${btn}</div>`;
}
// Lines that depend on the clock, so the screen can refresh when one changes.
function liveSig() {
  if (S.tab === 'body') return S.bodyDate === todayStr() ? (proteinCoach(todayStr()) || {}).t || '' : '';
  if (S.tab !== 'today' || S.dayView) return '';
  const w = todaySession();
  // Mid-workout, leave the screen alone.
  if (Date.now() - lastSetAt(w) < 20 * 60000) return 'busy';
  return `${(dayCoach(todayStr(), w) || {}).t || ''}|${(proteinCoach(todayStr()) || {}).t || ''}`;
}

// ---------- rest timer ----------
// A small timer in the corner after every set. Rest counts down; partway through a superset round it
// counts up instead (no alarm), so you can see how long you've taken to switch.
const T = { end: 0, total: 0, iv: null, doneAt: 0, up: false, start: 0, openT: null };
function startTimer(sec, up = false) {
  T.total = sec; T.up = up; T.start = Date.now();
  T.end = Date.now() + sec * 1000;
  T.doneAt = 0;
  clearInterval(T.iv);
  T.iv = setInterval(drawTimer, 250);
  const el = $('#timer');
  const fresh = el.hidden;
  el.hidden = false;
  el.classList.remove('done', 'open');
  el.classList.toggle('up', up);
  if (fresh) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  document.body.classList.add('has-timer');
  drawTimer();
}
function stopTimer() {
  clearInterval(T.iv);
  T.iv = null;
  $('#timer').hidden = true;
  $('#timer').classList.remove('open');
  document.body.classList.remove('has-timer');
}
// (An old cached page may not have the ring yet.)
const ring = v => { const p = $('#tm-prog'); if (p) p.style.strokeDashoffset = String(v); };
function drawTimer() {
  if (T.up) {
    const gone = Math.floor((Date.now() - T.start) / 1000);
    if (gone > 300) { stopTimer(); return; }
    $('#tm-left').textContent = fmtClock(gone);
    $('#tm-label').textContent = 'Switch';
    ring(0);
    return;
  }
  const left = Math.max(0, Math.ceil((T.end - Date.now()) / 1000));
  if (left === 0 && !T.doneAt) {
    T.doneAt = Date.now();
    timerDone();
  }
  if (T.doneAt && Date.now() - T.doneAt > 8000) { stopTimer(); return; }
  $('#tm-left').textContent = T.doneAt ? 'Go!' : fmtClock(left);
  $('#tm-label').textContent = T.doneAt ? 'Done' : 'Rest';
  ring(T.total ? 100 - (left / T.total) * 100 : 100);
}
function timerDone() {
  $('#timer').classList.add('done');
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  else haptic();
  if (S.settings.sound) beep();
  document.body.classList.remove('flash');
  void document.body.offsetWidth;
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 1300);
}

// Sound needs a tap first on iPhone, so the audio is unlocked on every tap.
let actx = null;
function unlockAudio(ev) {
  try {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    // A level pop-up's sound waits for the first tap, unless that tap closes it.
    if (S.lvSoundPending && ev && ev.target && ev.target.closest && ev.target.closest('[data-a="lv-close"]')) S.lvSoundPending = null;
    const play = () => { const f = S.lvSoundPending; if (f && actx && actx.state === 'running') { S.lvSoundPending = null; try { f(); } catch (e) { /* no audio */ } } };
    if (actx && actx.state === 'suspended') actx.resume().then(play, () => {});
    else play();
  } catch (e) { /* no audio */ }
}
function beep() {
  if (!actx) return;
  const t0 = actx.currentTime + 0.02;
  [0, 0.28, 0.56].forEach((d, k) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = k === 2 ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.22);
    o.connect(g).connect(actx.destination);
    o.start(t0 + d);
    o.stop(t0 + d + 0.25);
  });
}

// iPhone has no vibration for web apps; toggling a hidden switch gives a small tap of haptics on iOS 18+.
let hapEl = null;
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(12); return; }
    // iPhone's buzz comes from tapping a hidden switch, and that tap pulls focus out of whatever
    // you're typing in (the keyboard drops and the sheet jumps). While you type, skip the buzz.
    const a = document.activeElement;
    if (a && a.matches('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]')) return;
    if (!hapEl) {
      hapEl = document.createElement('label');
      hapEl.setAttribute('aria-hidden', 'true');
      hapEl.style.display = 'none';
      hapEl.innerHTML = '<input type="checkbox" switch>';
      document.body.appendChild(hapEl);
    }
    hapEl.click();
  } catch (e) { /* no haptics */ }
}

// ---------- toast ----------
let toastTimer;
let undoUntil = 0;
function toast(msg, ms) {
  if (Date.now() < undoUntil) { setTimeout(() => toast(msg, ms), undoUntil - Date.now() + 150); return; }
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('undo');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || (msg.length > 30 ? 3200 : 2200));
}

// A toast with an Undo button, for about 5 seconds.
function toastUndo(msg, undo, label = 'Undo', ms = 5000) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span><button>${label}</button>`;
  el.classList.add('show', 'undo');
  el.querySelector('button').onclick = () => { undoUntil = 0; el.classList.remove('show', 'undo'); undo(); };
  clearTimeout(toastTimer);
  undoUntil = Date.now() + ms;
  toastTimer = setTimeout(() => { undoUntil = 0; el.classList.remove('show', 'undo'); }, ms);
}

// ---------- charts ----------
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function lineChart(series) {
  const W = 340, H = 180, L = 36, R = 12, Tp = 12, B = 24;
  const pts = series.flatMap(s => s.pts);
  if (!pts.length) return '';
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let x0 = xmin, x1 = xmax, y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x0 === x1) { x0 -= 864e5 * 3; x1 += 864e5 * 3; }
  if (y1 - y0 < 4) { const mid = (y0 + y1) / 2; y0 = mid - 2; y1 = mid + 2; }
  const py = (y1 - y0) * 0.12;
  y0 = Math.max(0, y0 - py); y1 += py;
  const yfmt = v => (y1 - y0 < 12 ? String(Math.round(v * 10) / 10) : String(Math.round(v)));
  const X = x => L + (x - x0) / (x1 - x0) * (W - L - R);
  const Y = y => Tp + (1 - (y - y0) / (y1 - y0)) * (H - Tp - B);
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = y0 + (y1 - y0) * i / 3;
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
    g += `<text class="ylab" x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}">${yfmt(v)}</text>`;
  }
  const xl = xmin === xmax
    ? `<text class="xlab" x="${X(xmin)}" y="${H - 6}" text-anchor="middle">${shortDate(xmin)}</text>`
    : `<text class="xlab" x="${L}" y="${H - 6}">${shortDate(xmin)}</text><text class="xlab" x="${W - R}" y="${H - 6}" text-anchor="end">${shortDate(xmax)}</text>`;
  const lines = series.map(s => {
    const p = [...s.pts].sort((a, b) => a[0] - b[0]);
    const d = p.map((q, i) => `${i ? 'L' : 'M'}${X(q[0]).toFixed(1)},${Y(q[1]).toFixed(1)}`).join('');
    const dots = p.length <= 40 ? p.map(q => `<circle cx="${X(q[0]).toFixed(1)}" cy="${Y(q[1]).toFixed(1)}" r="3" style="fill:${s.color}"/>`).join('') : '';
    return `<path class="ln" d="${d}" style="stroke:${s.color}"/>${dots}`;
  }).join('');
  const legend = series.length > 1
    ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`
    : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}${xl}${lines}</svg>${legend}`;
}

function barChart(items, target) {
  const W = 340, H = 150, L = 30, R = 8, Tp = 14, B = 22;
  const max = Math.max(target * 1.2, ...items.map(i => i.y), 10);
  const bw = (W - L - R) / items.length;
  const Y = y => Tp + (1 - y / max) * (H - Tp - B);
  let out = '';
  items.forEach((it, k) => {
    const x = L + k * bw + bw * 0.15, h = H - B - Y(it.y);
    out += `<rect class="bar ${it.y >= (it.t ?? target) ? 'hit' : ''}" x="${x.toFixed(1)}" y="${Y(it.y).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3"/>`;
    if (k % 2 === items.length % 2 || k === items.length - 1) {
      out += `<text class="xlab" x="${(x + bw * 0.35).toFixed(1)}" y="${H - 6}" text-anchor="middle">${it.label}</text>`;
    }
  });
  const ty = Y(target).toFixed(1);
  out += `<line class="tgt" x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}"/><text class="tgtlab" x="${L - 4}" y="${(+ty + 3.5).toFixed(1)}" text-anchor="end">${target}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
}

// ---------- rendering ----------
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === S.tab));
  let html;
  if (S.view) html = ({ workout: viewWorkout, exercise: viewExercise, progDay: viewProgDay, compare: viewCompare })[S.view.name]();
  else html = ({ today: viewToday, history: viewHistory, body: viewBody, stats: viewStats, outlook: viewOutlook, more: viewMore })[S.tab]();
  $('#view').innerHTML = html;
  lightMuscles();
  celebrateDay();
  checkLevels();
}

// ----- daily streak -----
// Rest is part of the plan, so rest days count on their own: the weekend ones and any day you take with
// "Take today as a rest day". A training day counts when you move (any workout or activity), or once
// its lift gets done later that week ("Do this workout today"). (Days before Nov 3, 2026 keep the old
// rule too, where a weigh-in or protein counted any day, so no streak was lost to a change.)
const isTrainingDay = date => planOn(date).type !== 'rest';
function madeUpLater(date) {
  const k = planKeyOn(date);
  if ((planOf(k) || {}).type !== 'strength') return false;
  const end = addDays(weekStart(date), 6);
  return S.workouts.some(w => w.dayKey === k && w.date > date && w.date <= end && (w.exercises || []).some(e => doneSets(e).length));
}
function dayCounts(date) {
  if (!isTrainingDay(date) || S.workouts.some(w => w.date === date && hasWork(w)) || madeUpLater(date)) return true;
  const b = S.body[date] || {};
  return date < (S.settings.streakRuleFrom || '9999') && (b.weight != null || (b.protein || 0) >= proteinTargetFor(date));
}
const streakTodo = date => (isTrainingDay(date) ? 'lift, run, walk, or do yoga' : 'rest up, today counts');
// Today still keeps the streak alive until midnight, so count back from yesterday if today isn't done yet.
function dailyStreak() {
  let d = dayCounts(todayStr()) ? todayStr() : addDays(todayStr(), -1);
  let n = 0;
  while (dayCounts(d)) { n++; d = addDays(d, -1); }
  return n;
}
function bestStreak() {
  const dates = [...S.workouts.filter(hasWork).map(w => w.date), ...Object.keys(S.body)].sort();
  let best = 0, run = 0;
  for (let d = dates[0], today = todayStr(); d && d <= today; d = addDays(d, 1)) {
    run = dayCounts(d) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}
// The first time today counts, cheer once.
function celebrateDay() {
  const today = todayStr(), done = dayCounts(today);
  if (S.celebrated && S.celebrated.date === today && !S.celebrated.done && done) {
    const n = dailyStreak();
    haptic();
    setTimeout(() => toast(n > 1 ? `🔥 ${n}-day streak! Today counts.` : '🔥 Day 1. Your streak starts now.'), 900);
  }
  S.celebrated = { date: today, done };
  // Tell the reminder server today counts (once a day), and leave the streak where sw.js can read it.
  if (done && S.activePinged !== today && S.settings.reminder.id && remAny(S.settings.reminder)) {
    S.activePinged = today;
    pushApi('active', { id: S.settings.reminder.id }).catch(() => { S.activePinged = null; });
  }
  // The server skips the streak reminder on rest days (planned or taken), so send the next two weeks' rest days when they change.
  const rest = Array.from({ length: 14 }, (_, k) => addDays(today, k)).filter(d => !isTrainingDay(d));
  const rsig = `${S.settings.reminder.id}|${rest.join(',')}`;
  if (S.settings.reminder.id && remAny(S.settings.reminder) && S.restSent !== rsig) {
    S.restSent = rsig;
    pushApi('rest', { id: S.settings.reminder.id, rest }).catch(() => {}); // tried again next time the app opens
  }
  const st = JSON.stringify({ date: today, n: dailyStreak(), done, train: isTrainingDay(today) });
  if (st !== S.savedStreak) { S.savedStreak = st; DB.put('kv', { k: 'streak', v: JSON.parse(st) }); }
}
function streakCard() {
  const today = todayStr(), n = dailyStreak(), best = Math.max(bestStreak(), n), done = dayCounts(today);
  const start = addDays(weekStart(today), -21);
  const cells = Array.from({ length: 28 }, (_, k) => {
    const d = addDays(start, k);
    const cls = [d > today ? 'future' : dayCounts(d) ? 'on' : '', d === today ? 'today' : ''].join(' ');
    return `<i class="${cls}"></i>`;
  }).join('');
  return `<div class="card">
      <div class="streak"><div class="big-num">🔥 ${n}</div>
        <div><b>day streak</b><div class="muted small">Best: ${best} day${best === 1 ? '' : 's'}</div></div></div>
      <div class="sh-hint">${done && !isTrainingDay(today) && !S.workouts.some(w => w.date === today && hasWork(w)) ? 'Rest day: it counts for your streak. Recovery is part of training.' : done ? 'Today counts. See you tomorrow.' : n ? `Keep it going today: ${streakTodo(today)}.` : `To start one today: ${streakTodo(today)}.`}</div>
      <div class="sh-hint">Training days count when you move. Rest days count on their own, and so does a day you take with “Take today as a rest day.”</div>
      <div class="cal">${DAYS.map(d => `<span>${DAY_SHORT[d][0]}</span>`).join('')}${cells}</div>
    </div>`;
}

// ----- you: profile, energy, estimates, and recommendations -----
const YOGA_CLASSES = [
  { id: 'combo30', style: 'combo', min: 30, name: 'Combination', len: '30 min' },
  { id: 'flex30', style: 'flex', min: 30, name: 'Flexibility', len: '30 min' },
  { id: 'strength30', style: 'strength', min: 30, name: 'Strength', len: '30 min' },
  { id: 'combo60', style: 'combo', min: 60, name: 'Combination', len: '1 hour' },
];
const YOGA_STYLES = { combo: 'Combination', flex: 'Flexibility', strength: 'Strength' };
// 2024 Compendium of Physical Activities: Hatha 2.3, stretching 2.3, Vinyasa 2.7 (a mix sits between).
const YOGA_MET = { combo: 2.5, flex: 2.3, strength: 2.7 };
// Everything else you might do, with 2024 Compendium MET values for each effort level.
// legs/upper say what it works, for tomorrow's picks. dist: 'pace' or 'mph' shows a distance box.
const ACTIVITIES = [
  { id: 'hike', name: 'Hike', mets: [3.8, 5.3, 7.5], levels: ['Easy', 'Moderate', 'Hard'], hint: ['Slow and mostly flat', 'Normal pace, some hills', 'Steep climbs or a heavy pack'], dist: 'pace', legs: true },
  { id: 'climb', name: 'Rock climbing', mets: [5.8, 7.3, 8.0], levels: ['Easy', 'Moderate', 'Hard'], hint: ['Easy routes, lots of rest', 'Steady climbing', 'Hard routes, little rest'], upper: true },
  { id: 'boulder', name: 'Bouldering', mets: [5.8, 7.3, 8.8], levels: ['Easy', 'Moderate', 'Hard'], hint: ['Easy problems, lots of rest', 'Steady session', 'Hard problems, short rests'], upper: true },
  { id: 'bike', name: 'Bike ride', mets: [4.0, 8.0, 10.0], levels: ['Easy', 'Moderate', 'Hard'], hint: ['Cruising, under 10 mph', 'About 12 to 14 mph', '14 mph or faster'], dist: 'mph', legs: true },
  { id: 'spin', name: 'Stationary bike', mets: [4.0, 6.8, 9.0], levels: ['Light', 'Steady', 'Spin class'], legs: true },
  { id: 'swim', name: 'Swimming', mets: [5.8, 8.0, 9.8], levels: ['Easy', 'Steady', 'Fast'], hint: ['Easy laps or just swimming around', 'Steady laps', 'Fast laps'], upper: true },
  { id: 'row', name: 'Rowing machine', mets: [5.0, 7.3], levels: ['Moderate', 'Hard'], upper: true, legs: true },
  { id: 'elliptical', name: 'Elliptical', mets: [5.0, 9.0], levels: ['Moderate', 'Hard'], legs: true },
  { id: 'stairs', name: 'Stair climber', mets: [9.3], legs: true },
  { id: 'hiit', name: 'HIIT class', mets: [7.0, 11.0], levels: ['Moderate', 'Hard'], legs: true },
  { id: 'circuit', name: 'Circuit training', mets: [3.5, 5.0, 7.5], levels: ['Light', 'Moderate', 'Hard'] },
  { id: 'rope', name: 'Jump rope', mets: [11.0], legs: true },
  { id: 'basketball', name: 'Basketball', mets: [5.0, 7.5, 8.0], levels: ['Shooting', 'Pickup', 'Full game'], legs: true },
  { id: 'soccer', name: 'Soccer', mets: [7.0, 9.5], levels: ['Casual', 'Competitive'], legs: true },
  { id: 'tennis', name: 'Tennis', mets: [4.5, 6.8, 8.0], levels: ['Doubles', 'Rallying', 'Singles'], legs: true },
  { id: 'pickleball', name: 'Pickleball', mets: [4.5], legs: true },
  { id: 'volleyball', name: 'Volleyball', mets: [3.0, 4.0, 8.0], levels: ['Casual', 'Indoor game', 'Beach'] },
  { id: 'golf', name: 'Golf', mets: [3.5, 4.3], levels: ['With a cart', 'Walking'] },
  { id: 'ski', name: 'Skiing', mets: [4.3, 6.3, 8.0], levels: ['Easy', 'Moderate', 'Hard'], legs: true },
  { id: 'snowboard', name: 'Snowboarding', mets: [7.5], legs: true },
  { id: 'kayak', name: 'Kayaking', mets: [5.0], upper: true },
  { id: 'paddle', name: 'Paddleboarding', mets: [6.5] },
  { id: 'surf', name: 'Surfing', mets: [3.0], upper: true },
  { id: 'dance', name: 'Dancing', mets: [3.0, 3.8, 5.5], levels: ['Slow', 'Moderate', 'Fast'] },
  { id: 'martial', name: 'Martial arts', mets: [5.3, 10.3], levels: ['Learning', 'Sparring pace'] },
  { id: 'pilates', name: 'Pilates', mets: [2.8] },
  { id: 'stretch', name: 'Stretching', mets: [2.3] },
  { id: 'yard', name: 'Yard work', mets: [2.3, 4.0, 6.0], levels: ['Light', 'Moderate', 'Heavy'] },
];
// "Something else": a rough guess from how hard it felt.
const CUSTOM_ACT = { id: 'custom', mets: [3.5, 5.5, 7.5], levels: ['Easy', 'Moderate', 'Hard'], hint: ['Could chat easily', 'Breathing harder, could still talk', 'Hard to talk'], dist: 'pace' };
const actDef = a => ACTIVITIES.find(x => x.id === a.kind) || { ...CUSTOM_ACT, name: a.name };
const actLevel = (a, def) => Math.max(0, Math.min(def.mets.length - 1, a.level ?? Math.floor((def.mets.length - 1) / 2)));
const actName = a => (a.type === 'other' ? a.name : a.type === 'yoga' ? `${YOGA_STYLES[a.style] || ''} yoga`.trim() : moveLabel(a));
const ENERGY = { low: 'Low', ok: 'OK', great: 'Great' };
const SLEEP = [[5, '≤5'], [6, '6'], [7, '7'], [8, '8'], [9, '9+']];
// Older entries were stored as range midpoints (6.5, 7.5); show them as the nearest hour.
const sleepPick = v => (v == null ? null : SLEEP.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a)));
const fmtK = n => (n >= 1000 ? `${round1(n / 1000)}k` : String(n));
const ENERGY_HINT = {
  low: 'Easy day: same sets, no jumps, a couple of reps left on each, gentler cardio.',
  ok: 'Normal plan today.',
  great: 'Feeling good. Cardio and yoga lean a bit harder.',
};
// ----- notes the coach reads -----
// Notes are split into clauses (sentences, lines, and "but"), and each clause is checked for what it's
// about (a lift from that workout, a body part) and how it went (sore, pain, easy, hard, and so on).
// "No pain", "not sore", and "knee felt fine" don't count. Everything it acts on shows as a tag under
// the note, and tapping one says exactly what it changes.
const NOTE_SIG = {
  sore: /\b(sore|soreness|tight|tightness|stiff|stiffness|achy|aching|aches?|doms)\b/,
  pain: /\b(pain|painful|hurts?|hurting|sharp|tweak(?:ed|y)?|strain(?:ed)?|pulled|pinch(?:ed|ing|y)?|injur(?:y|ed)|twinge|tender|swollen|throbbing|clicking|popping)\b/,
  easy: /\b(easy|too light|felt light|was light|breeze|more in the tank|could(?:'ve| have)? done more|could do more)\b/,
  hard: /\b(hard|heavy|tough|grind(?:y|ed|ing)?|struggl(?:e|ed|ing)|fail(?:ed|ure)?|barely|brutal|killer|form broke|all out|nothing left|maxed out|max effort|gassed|couldn'?t (?:do|get|finish) (?:another|one more))\b/,
  cramp: /\b(cramp(?:s|ed|ing|y)?|charley horse|spasms?)\b/,
  sick: /\b(sick|ill|flu|fever|covid|nause(?:a|ous)|stomach bug|food poisoning|migraine|under the weather|(?:a|head|chest) cold)\b/,
  tired: /\b(tired|exhausted|drained|wiped|fatigued|no energy|low energy|sluggish|sleepy|groggy)\b/,
  heat: /\b(hot|heat|humid|humidity|hills?|hilly|trail|windy|wind|uphill|snow|rain(?:y|ing)?|altitude|stroller|incline)\b/,
};
const NOTE_PARTS = [
  [/\b(lower back|upper back|mid back|lats?|traps?)\b/, 'back'],
  [/\b(chest|pecs?)\b/, 'chest'],
  [/\b(shoulders?|delts?|rotator cuff)\b/, 'shoulders'],
  [/\b(biceps?|triceps?|bis|tris|forearms?|elbows?|wrists?|arms?)\b/, 'arms'],
  [/\b(quads?|hamstrings?|hams|glutes?|butt|calf|calves|knees?|hips?|groin|adductors?|ankles?|shins?|feet|foot|achilles|heels?|it band|legs?)\b/, 'legs'],
  [/\b(abs|core|obliques?|stomach)\b/, 'core'],
];
// "Back" alone is too common ("back to normal"), so it only counts next to a soreness or pain word.
const BACK_RE = /\b(my back|back (?:is|was|feels?|felt|pain|hurts?|hurting|sore|tight|stiff|achy)|(?:sore|tight|stiff|achy|hurt|tweaked|strained|painful) back)\b/;
const RUN_PARTS = /\b(ankles?|knees?|shins?|feet|foot|calf|calves|hips?|achilles|heels?|it band|hamstrings?)\b/;
const NEG_BEFORE = /\b(no|not|never|without|zero|nothing|isn'?t|wasn'?t|didn'?t|don'?t|doesn'?t|aren'?t|weren'?t|hasn'?t|haven'?t|less|hardly)(?: \S+){0,2} ?$/;
const NEG_AFTER = /^ ?(free|is gone|gone|went away)\b/;
// "Felt a pinch but it didn't hurt": a no-pain line in the same sentence cancels the soft words
// (pinch, click, pop), but not a real one like "hurts" ("no pain in my back, but my knee hurts").
const PAIN_DENY = /\b(?:(?:didn'?t|doesn'?t|don'?t|did not|does not|wasn'?t|isn'?t|not|no|never|without)(?: \S+)? (?:hurt|hurting|pain|painful)|painless|pain free)\b/;
const PAIN_SOFT = /^(?:sharp|tweak|tweaky|strain|pinch(?:ed|ing|y)?|twinge|tender|clicking|popping)$/;
const RECOVERED = /\b(better|fine|healed|recovered|gone|went away|no longer|all good|feels? good|felt good|feels? great|felt great)\b/;
const LIFT_GENERIC = new Set(['db', 'dumbbell', 'dumbbells', 'bb', 'barbell', 'machine', 'cable', 'cables', 'seated', 'standing', 'smith', 'the', 'of', 'with', 'single', 'one', 'arm', 'press', 'row', 'curl', 'fly', 'flye', 'raise', 'extension', 'lying', 'stack', 'and', 'or', 'up']);
const MOVE_WORDS = new Set(['press', 'row', 'curl', 'fly', 'flye', 'raise', 'extension']);
const isPartWord = t => t === 'back' || RUN_PARTS.test(t) || NOTE_PARTS.some(([re]) => re.test(t));
const noteText = s => ` ${String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\b(pull|push|chin)[ -]?ups?\b/g, '$1 up').replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What each lift in the workout can be called: its full name, word pairs from it, and words only it
// has ("pulldown", "thrust"). Body-part words ("shoulder", "calf") only count inside a pair.
function liftAliases(names) {
  const toks = names.map(n => noteText(normName(n).replace(/\(.*?\)/g, '')).trim().split(' ').filter(Boolean));
  const cands = toks.map(ws => {
    const al = new Set([ws.join(' ')]);
    for (let k = 0; k + 1 < ws.length; k++) if (!(LIFT_GENERIC.has(ws[k]) && LIFT_GENERIC.has(ws[k + 1]))) al.add(`${ws[k]} ${ws[k + 1]}`);
    // Movement words ("curls", "fly") count when only one lift in the workout has them.
    ws.forEach(t => { if (t.length > 2 && (!LIFT_GENERIC.has(t) || MOVE_WORDS.has(t)) && !isPartWord(t)) al.add(t); });
    const j = ws.join(' ');
    if (/romanian|\brdl\b/.test(j)) al.add('rdl');
    if (/bench/.test(j)) al.add('bench');
    if (/overhead press/.test(j)) al.add('ohp');
    return al;
  });
  const count = {};
  cands.forEach(al => al.forEach(a => { count[a] = (count[a] || 0) + 1; }));
  return names.map((name, i) => ({ name, res: [...cands[i]].filter(a => a.length > 2 && (count[a] === 1 || a === toks[i].join(' '))).sort((a, b) => b.length - a.length).map(a => new RegExp(`\\b${reEsc(a)}(?:s|es|ing)?\\b`)) }));
}
const noteMemo = new Map();
function parseNotes(text, ctx = {}) {
  const t = String(text || '').trim();
  if (!t) return [];
  const mk = `${t}\u0001${(ctx.lifts || []).join('|')}\u0001${ctx.self || ''}\u0001${ctx.run ? 1 : 0}${ctx.pace ? 1 : 0}`;
  if (noteMemo.has(mk)) return noteMemo.get(mk);
  const lifts = liftAliases(ctx.lifts || []), out = [], seen = new Set();
  const add = x => { const k = `${x.k}|${x.about || ''}`; if (!seen.has(k)) { seen.add(k); out.push(x); } };
  // Two lifts in one sentence ("bench was easy, incline was heavy"): each comma part stands alone.
  const clauses = t.split(/[.!?;\n]+/).flatMap(sent => {
    const deny = PAIN_DENY.test(noteText(sent));
    return sent.split(/\bbut\b|\bthough\b|\bhowever\b|\bwhile\b/i).flatMap(c => {
      const n = lifts.filter(L => L.res.some(r => r.test(noteText(c)))).length;
      return n > 1 && /,/.test(c) ? c.split(',') : [c];
    }).map(c => ({ c, deny }));
  });
  clauses.forEach(({ c: raw, deny }) => {
    const quote = raw.trim().replace(/^(and|so|then)\s+/i, '');
    let rest = noteText(raw);
    if (!rest.trim()) return;
    // Lifts named here, blanked out so "calf raise" isn't read as your calf.
    const named = [];
    lifts.forEach(L => { const re = L.res.find(r => r.test(rest)); if (re) { named.push(L.name); rest = rest.replace(re, ' '); } });
    if (!named.length && ctx.self) named.push(ctx.self);
    const recovered = RECOVERED.test(rest);
    const hit = (k, noNeg) => {
      const m = rest.match(NOTE_SIG[k]);
      if (!m) return null;
      const neg = !noNeg && (NEG_BEFORE.test(rest.slice(0, m.index)) || NEG_AFTER.test(rest.slice(m.index + m[0].length)));
      return { word: m[1], neg };
    };
    const ok = x => (x && !x.neg ? x : null);
    const sore = !recovered && ok(hit('sore')), painHit = !recovered && ok(hit('pain')), pain = painHit && !(deny && PAIN_SOFT.test(painHit.word)) ? painHit : null;
    const easyHit = hit('easy'), easy = ok(easyHit), hard = ok(hit('hard')) || (easyHit && easyHit.neg ? { word: `not ${easyHit.word}` } : null);
    const cramp = ok(hit('cramp')), sick = ok(hit('sick')), tired = ok(hit('tired')), heat = ctx.pace && ok(hit('heat'));
    const parts = [];
    NOTE_PARTS.forEach(([re, g]) => { const m = rest.match(re); if (m && !NEG_BEFORE.test(rest.slice(0, m.index))) parts.push({ g, word: m[1] }); });
    if (!parts.some(x => x.g === 'back') && BACK_RE.test(rest)) parts.push({ g: 'back', word: 'back' });
    named.forEach(name => {
      const how = pain ? ['lift-pain', pain] : cramp ? ['lift-cramp', cramp] : hard ? ['lift-hard', hard] : easy ? ['lift-easy', easy] : ['lift-note', {}];
      add({ k: how[0], about: name, word: how[1].word || '', quote });
    });
    if (sore || pain) parts.forEach(x => add({ k: pain ? 'pain-part' : 'sore-part', about: x.g, word: x.word, sig: (pain || sore).word, quote }));
    if ((sore || pain) && !parts.length && !named.length) add({ k: 'sore', word: (sore || pain).word, quote });
    if (ctx.run && !recovered) {
      const m = rest.match(RUN_PARTS);
      if (m && !NEG_BEFORE.test(rest.slice(0, m.index))) add({ k: 'run-part', about: m[1], word: m[1], quote });
    }
    if (cramp && !named.length) add({ k: 'cramp', word: cramp.word, quote });
    if (sick) add({ k: 'sick', word: sick.word, quote });
    if (tired) add({ k: 'tired', word: tired.word, quote });
    if (heat) add({ k: 'pace', word: heat.word, quote });
  });
  if (noteMemo.size > 400) noteMemo.clear();
  noteMemo.set(mk, out);
  return out;
}
// The notes in a workout, each read with what it can be about.
const workoutCtx = w => ({ lifts: (w.exercises || []).map(e => e.name), run: (w.activities || []).some(a => a.type === 'run'), pace: (w.activities || []).some(a => a.type === 'run' || a.type === 'walk') });
const actCtx = a => ({ lifts: [], run: a.type === 'run', pace: a.type === 'run' || a.type === 'walk' });
const exCtx = (w, e) => ({ lifts: workoutCtx(w).lifts, self: e.name });
const hasExNote = e => !!String(e.notes || '').trim();
const workoutSigs = w => [...parseNotes(w.notes, workoutCtx(w)), ...(w.exercises || []).filter(hasExNote).flatMap(e => parseNotes(e.notes, exCtx(w, e))), ...(w.activities || []).flatMap(a => parseNotes(a.notes, actCtx(a)))];
const LIFT_RANK = ['lift-pain', 'lift-cramp', 'lift-hard', 'lift-easy', 'lift-note'];
const liftNote = (w, name) => workoutSigs(w).filter(x => x.about === name && LIFT_RANK.includes(x.k)).sort((a, b) => LIFT_RANK.indexOf(a.k) - LIFT_RANK.indexOf(b.k))[0] || null;
// A rough day (tired or sick, in your notes) doesn't count as a miss, the same as a low-energy check-in.
const offDay = w => workoutSigs(w).some(x => x.k === 'tired' || x.k === 'sick');
// Signs in notes from a span of days before (and including) a date.
function notedSince(date, back, kinds) {
  const from = addDays(date, -back), out = [];
  S.workouts.forEach(w => { if (w.date >= from && w.date <= date) workoutSigs(w).forEach(x => { if (kinds.includes(x.k)) out.push({ ...x, date: w.date }); }); });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
// Sick in the last 2 days, and no check-in today to say otherwise: plan it like a low-energy day.
function sickNoted(date) {
  const mk = `${date}|${S.ver}`;
  if (S.sickMemo && S.sickMemo.k === mk) return S.sickMemo.v;
  const v = notedSince(addDays(date, -1), 1, ['sick'])[0] || null;
  S.sickMemo = { k: mk, v };
  return v;
}
// What's sore in your notes: sore for 2 days, pain for 4, offered on the "too sore" card.
function soreFromNotes(date) {
  const found = {};
  [...notedSince(date, 2, ['sore-part']), ...notedSince(date, 4, ['pain-part'])].forEach(x => { if (!found[x.about]) found[x.about] = x; });
  return found;
}
const MUSCLE_GROUP_NAME = Object.fromEntries(Object.entries(SORE_GROUPS).map(([k, [n]]) => [k, n.toLowerCase()]));
const NOTE_LBL = { 'lift-pain': 'pain', 'lift-cramp': 'cramp', 'lift-hard': 'felt hard', 'lift-easy': 'felt easy', 'lift-note': 'shown next time' };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function noteLabel(x) {
  if (NOTE_LBL[x.k]) return `${x.about} · ${NOTE_LBL[x.k]}`;
  if (x.k === 'sore-part' || x.k === 'pain-part') return `${cap(x.word)} · ${x.k === 'pain-part' ? 'pain' : 'sore'}`;
  if (x.k === 'run-part') return `${cap(x.word)} · next run`;
  if (x.k === 'pace') return `${cap(x.word)} · pace`;
  return cap(x.k === 'sore' ? x.word : x.k);
}
// What a tag does, in plain words, with when it applies.
function noteInfo(x, date) {
  const until = n => fmtDate(addDays(date, n), { weekday: 'short', month: 'short', day: 'numeric' });
  const live = n => (addDays(date, n) >= todayStr() ? `On through ${until(n)}.` : 'That one’s done now.');
  const L = x.about, q = x.quote ? `From your note: “${x.quote}”` : '';
  const G = MUSCLE_GROUP_NAME[x.about];
  switch (x.k) {
    case 'lift-easy': return { title: `${L} felt easy`, body: [`Next time, hit the top of your range on every set and it jumps two steps instead of one. Otherwise, two more reps a set.`, `Lasts until you do ${L} again.`], q };
    case 'lift-hard': return { title: `${L} felt hard`, body: [`Next time, ${L} stays at the same weight, even if you hit your reps. Own it first.`, 'Rough day overall? Write “tired” or “sick” too and it won’t count as a miss.'], q };
    case 'lift-pain': return { title: `Pain on ${L}`, body: [`Next time, ${L} stays at the same weight with a reminder to keep it light.`, 'Keeps happening? Tap ⋯ on the lift, then “Does it bother you?”, and I’ll go easier on it every time.', 'Sharp pain, or pain that sticks around a few days, is worth getting checked.'], q };
    case 'lift-cramp': return { title: `Cramp on ${L}`, body: [`Next time, ${L} gets a reminder: a bit lighter and slower, sip water between sets.`], q };
    case 'lift-note': return { title: `Note for ${L}`, body: [`This shows on ${L} next time, right under “Last time”.`, 'Easy, hard, heavy, pain, or cramp in the same sentence also change the plan.'], q };
    case 'sore-part': return { title: `Sore ${x.word}`, body: [`Through ${until(2)}, lifting days offer to work around your ${G}. One tap and other muscles fill in.`, 'Yoga leans toward Flexibility for 3 days too.', live(2)], q };
    case 'pain-part': return { title: `${cap(x.word)} pain`, body: [`Through ${until(4)}, lifting days offer to work around your ${G}.`, 'Yoga leans toward Flexibility for 3 days.', 'Sharp or lasting pain is worth getting checked.', live(4)], q };
    case 'sore': return { title: 'Soreness', body: ['Yoga leans toward Flexibility for 3 days.', 'Name the spot (“sore chest”) and lifting days can work around it too.', live(3)], q };
    case 'run-part': return { title: `${cap(x.word)} on your run`, body: ['Your next run stays the same distance on flat ground, no speed work, with a quick balance drill first (one leg, 3 × 30 sec a side).', 'A run without a note like this brings the normal plan back.'], q };
    case 'cramp': return { title: 'Cramps', body: [`Through ${until(2)}, workouts start with a reminder: water and something salty an hour before.`, live(2)], q };
    case 'sick': return { title: 'Sick', body: ['Won’t count as a miss, so your weights don’t drop because of it.', `Through ${until(2)}, skipping the check-in means an easy plan: no jumps, a couple of reps left on each set, a walk instead of a run. Check in OK or Great to go back to normal.`, live(2)], q };
    case 'tired': return { title: 'Tired', body: ['Won’t count as a miss. Next time, each lift builds on your last normal session.'], q };
    case 'pace': return { title: `${cap(x.word)} run`, body: ['Heat, hills, wind, and trails slow you down for reasons that aren’t fitness, so this run stays out of your pace targets. Distance still counts.'], q };
  }
  return { title: noteLabel(x), body: [], q };
}
const NOTE_TONE = { 'lift-pain': 'warn', 'pain-part': 'warn', 'run-part': 'warn', sick: 'warn', 'lift-cramp': 'warn', cramp: 'warn', 'lift-easy': 'good', 'lift-hard': 'mid', tired: 'mid', 'sore-part': 'mid', sore: 'mid' };
const noteTagsHTML = (sigs, id, wid, src) => `<div class="note-tags" id="${id}">${sigs.map((x, i) => `<button class="note-tag ${NOTE_TONE[x.k] || ''}" data-a="note-tag" data-wid="${wid}" data-src="${src}" data-i="${i}">${esc(noteLabel(x))}</button>`).join('')}</div>`;
const fieldSigs = (w, src) => (src === 'w' ? parseNotes(w.notes, workoutCtx(w)) : /^e\d+$/.test(src) ? (e => (e ? parseNotes(e.notes, exCtx(w, e)) : []))(w.exercises[+src.slice(1)]) : parseNotes((w.activities[+src] || {}).notes, actCtx(w.activities[+src] || {})));
function noteTagsFor(w, src) {
  return noteTagsHTML(fieldSigs(w, src), `ntags-${w.id}-${src}`, w.id, src);
}
const round1 = v => Math.round(v * 10) / 10;
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
const fmtHeight = inches => `${Math.floor(inches / 12)}′${inches % 12}″`;
const fmtDur = m => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${Math.round(m % 60)} min` : ''}` : `${Math.round(m)} min`);
const energyFor = date => (S.body[date] || {}).energy || null;
const kgFor = date => { const b = latestWeighIn(date); return b ? b.weight * 0.4536 : null; };
const actMinutes = a => (+a.hr || 0) * 60 + (+a.min || 0) + (+a.sec || 0) / 60;
// Walks and runs take a start and finish time; the length comes from the two (past midnight works too).
const clockMin = t => (/^\d{1,2}:\d{2}/.test(t || '') ? +t.slice(0, t.indexOf(':')) * 60 + +t.slice(t.indexOf(':') + 1, t.indexOf(':') + 3) : null);
function actFromTimes(a) {
  const s0 = clockMin(a.start), e0 = clockMin(a.end);
  if (s0 == null || e0 == null) return false;
  const len = (e0 - s0 + 1440) % 1440;
  if (!len) return false;
  a.hr = ''; a.min = len; a.sec = 0;
  return true;
}
const nowClock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtLen = m => (m >= 60 ? `${Math.floor(m / 60)} hr ${Math.round(m % 60)} min` : `${Math.round(m)} min`);
const durText = a => {
  const s0 = clockMin(a.start), e0 = clockMin(a.end), m = actMinutes(a);
  if (s0 != null && e0 != null && s0 === e0) return 'Start and finish are the same minute.';
  if (!m) return 'Add a start and finish time.';
  return `Length: ${fmtLen(m)}${clockMin(a.start) == null || clockMin(a.end) == null ? ' (typed in)' : ''}`;
};
const paceOf = a => (+a.dist > 0 && actMinutes(a) > 0) ? actMinutes(a) / +a.dist : null;
// Walk/runs logged since 2.8 (a.auto) take their type from the pace. Older ones keep the type picked then.
function autoMoveType(a) {
  if (!a || !a.auto) return;
  const p = paceOf(a);
  if (a.style === 'intervals') { a.type = 'run'; a.mix = false; }
  else if (p) { a.type = p >= WALK_PACE ? 'walk' : 'run'; a.mix = p < WALK_PACE && p >= RUN_PACE; }
}
const moveLabel = a => (a.auto && !paceOf(a) && a.style !== 'intervals' ? 'Walk/run' : a.mix ? 'Walk + run' : ACT_TYPES[a.type]);
const fmtPace = m => { const sec = Math.round(m * 60); return `${Math.floor(sec / 60)}:${pad(sec % 60)}`; };

// How hard an activity is, in METs (1 = sitting still). Walks and runs use the ACSM equations from
// your speed; brisk walks above 3.7 mph, where that equation runs low, follow the Compendium instead.
function actMet(a) {
  if (a.type === 'yoga') return YOGA_MET[a.style] || 2.5;
  if (a.type === 'other') { const d = actDef(a); return d.mets[actLevel(a, d)]; }
  const min = actMinutes(a);
  if (!(+a.dist > 0) || !min) return a.type === 'run' ? 8 : 3.5;
  const mpm = +a.dist * 1609.34 / min, mph = +a.dist / (min / 60);
  const run = (0.2 * mpm + 3.5) / 3.5;
  const walk = () => {
    if (mpm <= 100) return (0.1 * mpm + 3.5) / 3.5;
    const pts = [[3.73, 3.86], [4.2, 5.5], [4.7, 7.0], [5.25, 8.5]];
    for (let k = 1; k < pts.length; k++) {
      if (mph <= pts[k][0]) { const [x0, y0] = pts[k - 1], [x1, y1] = pts[k]; return y0 + (y1 - y0) * (mph - x0) / (x1 - x0); }
    }
    return 8.5;
  };
  // A walk + run mix (a pace between 12:30 and 15:00 a mile) blends the two: all walking at 15:00, all
  // running at 12:30, so calories don't jump at either pace.
  if (a.mix) { const p = 60 / mph, r = Math.min(1, Math.max(0, (WALK_PACE - p) / (WALK_PACE - RUN_PACE))); return (1 - r) * walk() + r * run; }
  return a.type === 'run' ? run : walk();
}
// Active calories (on top of what you'd burn resting anyway, like a watch shows): (MET − 1) × kg × hours.
function actKcal(a, date) {
  const kg = kgFor(date), min = actMinutes(a);
  if (!kg || !min) return null;
  return Math.round((actMet(a) - 1) * kg * min / 60);
}
// How big a day it was: active MET-hours. 8 or more (a 2-hour hike, a long run) counts as a hard day.
const actLoad = a => Math.max(0, actMet(a) - 1) * actMinutes(a) / 60;
// Lifting time from when sets were logged, or about 2.5 minutes a set when that's missing.
function liftMinutes(w) {
  const gym = (w.exercises || []).filter(e => !isHome(e)), list = gym.some(e => doneSets(e).length) ? gym : (w.exercises || []);
  const n = sum(list.map(e => doneSets(e).length));
  const ats = list.flatMap(e => e.sets.filter(x => x.done && x.at).map(x => x.at)).sort((a, b) => a - b);
  if (ats.length >= 2) return Math.round(Math.max(n * 1.5, (ats[ats.length - 1] - ats[0]) / 60000 + 2));
  return Math.round(n * 2.5);
}
// Lifting is 3.5 METs with straight sets, up to 5.8 when it's all supersets (Compendium 02054, 02055).
function liftKcal(w) {
  const ex = (w.exercises || []).filter(e => doneSets(e).length);
  if (!ex.length) return null;
  const kg = kgFor(w.date), m = liftMinutes(w);
  if (!kg || !m) return null;
  const sets = e => doneSets(e).length;
  const inSS = sum(ex.filter(e => ex.some(x => x !== e && x.group === e.group)).map(sets));
  const met = 3.5 + 2.3 * inSS / sum(ex.map(sets));
  return Math.round((met - 1) * kg * m / 60);
}
function workoutKcal(w) {
  const parts = [liftKcal(w), ...(w.activities || []).map(a => actKcal(a, w.date))].filter(x => x != null);
  return parts.length ? sum(parts) : null;
}
function actStatsText(a, date) {
  const bits = [];
  if (a.type === 'yoga') bits.push(`${YOGA_STYLES[a.style] || 'Yoga'} · ${+a.min >= 60 ? '1 hour' : `${a.min} min`} · ${a.level === 'intermediate' ? 'Intermediate' : 'Beginner'}`);
  if (a.type === 'other' && actMinutes(a)) bits.push(fmtDur(actMinutes(a)));
  const p = paceOf(a);
  if (p && a.type === 'other' && actDef(a).dist === 'mph') bits.push(`${round1(60 / p)} mph`);
  else if (p) bits.push(`Pace ${fmtPace(p)} /mi`);
  const k = actKcal(a, date);
  if (k) bits.push(`~${k} active cal`);
  if (!kgFor(date) && actMinutes(a)) bits.push('log your weight to see calories');
  return bits.join(' · ');
}
// What a day asked of your body, so the next day's picks can go easier: legs, upper body, or a hard day.
function dayLoad(date) {
  const out = { legs: '', upper: '', hard: '' };
  S.workouts.filter(w => w.date === date).forEach(w => {
    if ((w.exercises || []).some(e => targetOf(e).body === 'lower' && doneSets(e).length)) out.legs = out.legs || 'lifting';
    (w.activities || []).forEach(a => {
      const load = actLoad(a), def = a.type === 'other' ? actDef(a) : {};
      const name = actName(a).toLowerCase();
      if ((a.type === 'run' || def.legs) && load >= 3) out.legs = name;
      if (def.upper && load >= 3) out.upper = name;
      if (load >= 8) out.hard = name;
    });
  });
  return out;
}
// A hard leg day yesterday (a long hike, a big run) holds off weight jumps on lower-body lifts.
function legsTired(date) {
  const y = dayLoad(addDays(date, -1));
  return y.hard && y.legs === y.hard ? `yesterday's ${y.hard} worked your legs hard` : '';
}

// ----- yoga -----
function yogaHistory(before) {
  const out = [];
  for (const w of sortedW()) {
    if (before && w.date >= before) continue;
    (w.activities || []).forEach(a => {
      if (a.type === 'yoga') out.push({ date: w.date, style: a.style || 'combo', min: +a.min >= 60 ? 60 : 30, feel: a.feel || '', level: a.level || 'beginner' });
    });
  }
  return out;
}
const recentSoreness = date => notedSince(date, 3, ['sore', 'sore-part', 'pain-part', 'lift-pain', 'run-part']).length > 0;
// Picks a class from variety (what you haven't done lately), how you feel, soreness in your notes,
// what you did yesterday (legs, upper body, a hard day) and lift tomorrow, whether you've done the hour this week, and how the last one felt.
function recommendYoga(date) {
  const hist = yogaHistory(date);
  const energy = energyFor(date);
  const sore = recentSoreness(date), y = dayLoad(addDays(date, -1)), legs = y.legs;
  const tomorrow = planOn(addDays(date, 1));
  const tomorrowLift = tomorrow && tomorrow.type === 'strength';
  const did60 = hist.some(h => h.min >= 60 && h.date >= addDays(date, -6));
  const scored = YOGA_CLASSES.map(c => {
    const last = hist.find(h => h.style === c.style && h.min === c.min);
    const gap = last ? daysBetween(last.date, date) : null;
    let score = Math.min(gap ?? 10, 14);
    const why = [];
    if (c.id === 'flex30') {
      if (sore) { score += 5; why.push('Your notes mention soreness, so stretching helps.'); }
      if (legs) { score += 3; why.push(legs === 'lifting' ? 'Legs worked hard yesterday, so this helps them recover.' : `Yesterday's ${legs} hit your legs, so this helps.`); }
      if (y.upper) { score += 3; why.push(`Yesterday's ${y.upper} worked your back and grip, so a stretch helps.`); }
      if (y.hard) score += 2;
      if (energy === 'low') { score += 6; why.push(sleepShort(date) ? 'Low energy and short sleep, so gentle.' : 'Low energy, so gentle.'); }
      if (sleepShort(date)) { score += 3; why.push('Under 6 hrs of sleep, so gentle.'); }
    }
    if (c.id === 'strength30') {
      if (energy === 'low') score -= 5;
      if (energy === 'great') { score += 3; why.push('Got energy today, so build some strength.'); }
      if (tomorrowLift) score -= 2;
      if (legs) score -= 2;
      if (y.hard) score -= 4;
      if (sleepShort(date)) score -= 3;
    }
    if (c.id === 'combo60') {
      if (energy === 'low') score -= 9;
      if (y.hard) score -= 6;
      if (sleepShort(date)) score -= 4;
      if (did60) score -= 7;
      else if (energy === 'great') { score += 5; why.push("No full hour yet this week, and you're feeling good."); }
    }
    if (c.id === 'combo30') score += 1;
    if (last && last.feel === 'hard') score -= 2;
    if (last && last.feel === 'easy') score += 1;
    if (gap == null) why.push("Haven't logged this one yet.");
    else if (gap >= 7) why.push(`${gap} days since this one.`);
    return { c, score, why };
  }).sort((a, b) => b.score - a.score);
  const pick = scored[0];
  if (!pick.why.length || (pick.c.id === 'combo30' && pick.why.length < 2)) pick.why.unshift('Balanced class, a bit of everything.');
  return { pick: pick.c, why: pick.why.slice(0, 2), others: scored.slice(1).map(x => x.c) };
}
// Ready for intermediate after enough sessions at your level, once most recent ones feel easy.
function yogaReadiness() {
  const hist = yogaHistory().filter(h => h.level === S.settings.yogaLevel);
  const rated = hist.filter(h => h.feel).slice(0, 8);
  const easy = rated.filter(h => h.feel === 'easy').length;
  const hardLately = rated.slice(0, 4).some(h => h.feel === 'hard');
  const need = 24;
  return { count: hist.length, need, easy, ready: hist.length >= need && easy >= 5 && !hardLately };
}

// ----- walks and runs -----
function cardioHistory(type, before) {
  const out = [];
  for (const w of sortedW()) {
    if (before && w.date >= before) continue;
    const easyDay = /easy/i.test((planOf(w.dayKey) || {}).label || '');
    const wSigs = parseNotes(w.notes, workoutCtx(w));
    (w.activities || []).forEach(a => {
      if (a.type !== type || !paceOf(a)) return;
      const sigs = [...parseNotes(a.notes, actCtx(a)), ...wSigs];
      // Hot, hilly, or windy in the notes: slower for reasons that aren't fitness, so it's left out of pace.
      out.push({ date: w.date, dist: +a.dist, min: actMinutes(a), pace: paceOf(a), intervals: a.style === 'intervals', easyDay, skip: sigs.some(x => x.k === 'pace'), part: (sigs.find(x => x.k === 'run-part') || {}).word || '' });
    });
  }
  return out;
}
// Builds from your last six weeks. A run is never more than 10% (and at most half a mile) longer than
// your longest run of the past 30 days: single-run spikes past that raise injury risk (Frandsen 2025).
// Easy days, low energy, and the day after a hard one go easier.
function recommendCardio(date, dayKey) {
  const energy = energyFor(date);
  const easyDay = /easy/i.test((planOf(dayKey) || {}).label || '');
  const hardYesterday = dayLoad(addDays(date, -1)).hard, tiredSleep = sleepShort(date);
  const runs = cardioHistory('run', date).filter(r => r.date >= addDays(date, -42));
  const walks = cardioHistory('walk', date);
  const talk = 'Easy enough to chat.';
  const sick = !energy && sickNoted(date);
  if (energy === 'low' || sick) {
    const m = walks.length ? Math.round(sum(walks.slice(0, 5).map(x => x.min)) / Math.min(5, walks.length)) : 20;
    return { type: 'walk', text: `Easy walk, about ${m} min`, why: sick ? `Sick ${sick.date === addDays(date, -1) ? 'yesterday' : 'recently'}, so an easy walk. Keeps you moving, still counts.` : 'Low energy, so a walk. Still counts for your streak.' };
  }
  if (!runs.length) {
    // Back after a break from running: half your usual distance, easy, then build.
    const older = cardioHistory('run', date).filter(r => !r.intervals && !r.skip).slice(0, 5);
    if (older.length) {
      const d = round1(Math.max(1, sum(older.map(r => r.dist)) / older.length / 2)), p = sum(older.map(r => r.pace)) / older.length + 0.5;
      return { type: 'run', dist: d, pace: p, text: `Easy run: ${d} mi at about ${fmtPace(p)} /mi`, why: `First run in ${Math.round(daysBetween(older[0].date, date) / 7)} weeks, so about half your usual. Add up to 10% a run from here. ${talk}` };
    }
    if (walks.length >= 3) return { type: 'run', text: 'Run/walk for 20 min: jog 1 minute, walk 90 seconds, 8 times', why: "You've been walking steadily, so mix in some jogging. Stretch the jogs as it gets easier." };
    return { type: 'walk', text: 'Walk 20 to 30 min at a comfortable pace', why: 'Log distance and time, and suggestions build from there.' };
  }
  const steady = runs.filter(r => !r.intervals && !r.skip), recent = (steady.length ? steady : runs.filter(r => !r.skip).length ? runs.filter(r => !r.skip) : runs).slice(0, 5);
  const avg = sum(recent.map(r => r.pace)) / recent.length;
  // Something felt off on the last run (ankle, knee, shin): same distance, flat ground, no speed work.
  const sorePart = runs[0].date >= addDays(date, -14) && runs[0].part;
  if (sorePart) {
    const d = round1(runs[0].dist);
    return { type: 'run', dist: d, pace: avg + 0.5, text: `Same distance as last time: ${d} mi on flat ground`, why: `You mentioned your ${sorePart.toLowerCase()} last run, so no step up and no speed work. Balance on one leg first, 3 × 30 sec a side. Stop if it hurts.` };
  }
  if (easyDay || hardYesterday || tiredSleep) {
    // About three quarters of your usual distance, so an easy day after a long run stays easy.
    const d = round1(Math.min(runs[0].dist, Math.max(1, 0.75 * sum(recent.map(r => r.dist)) / recent.length))), p = avg + 0.75;
    const why = hardYesterday ? `Yesterday's ${hardYesterday} was a big one, so easy today.` : tiredSleep ? 'Under 6 hrs of sleep, so easy today.' : 'An easy day keeps your legs fresh for lifting.';
    return { type: 'run', dist: d, pace: p, text: `Easy run: ${d} mi at about ${fmtPace(p)} /mi`, why: `${why} About 45 sec/mi slower than your recent ${fmtPace(avg)}. ${talk}` };
  }
  const longest = Math.max(...runs.filter(r => r.date >= addDays(date, -30)).map(r => r.dist), runs[0].dist);
  // Base built (3+ miles): every other regular run day becomes intervals, for conditioning.
  const lastRegular = runs.find(r => !r.easyDay);
  if (longest >= 3 && lastRegular && !lastRegular.intervals) {
    return { type: 'run', intervals: true, text: 'Intervals: 6 × 1 min fast',
      why: `10 min easy, then 6 × (1 min fast, 2 min easy jog), then 10 min easy. Fast = hard but steady, about 8 out of 10. Your base is built (${round1(longest)} mi this month), so every other run gets some speed.` };
  }
  const d = round1(Math.min(longest * 1.1, longest + 0.5));
  const why = energy === 'great' ? 'Feeling good? Push the pace, keep the distance step small.' : 'Staying within about 10% of your longest keeps injury risk down.';
  return { type: 'run', dist: d, pace: avg, text: `Run ${d} mi at about ${fmtPace(avg)} /mi`, why: `A small step up from your longest this month (${round1(longest)} mi). ${why}` };
}
function cardioRecords(before, excludeId) {
  const rec = { longRun: null, fastRun: null, longWalk: null, longHike: null };
  for (const w of S.workouts) {
    if (w.id === excludeId || (before && w.date > before)) continue;
    (w.activities || []).forEach(a => {
      const p = paceOf(a);
      if (!p) return;
      if (a.type === 'run') {
        if (!rec.longRun || +a.dist > rec.longRun.dist) rec.longRun = { dist: +a.dist, date: w.date };
        if (+a.dist >= 1 && (!rec.fastRun || p < rec.fastRun.pace)) rec.fastRun = { pace: p, date: w.date };
      } else if (a.type === 'walk' && (!rec.longWalk || +a.dist > rec.longWalk.dist)) rec.longWalk = { dist: +a.dist, date: w.date };
      else if (a.kind === 'hike' && (!rec.longHike || +a.dist > rec.longHike.dist)) rec.longHike = { dist: +a.dist, date: w.date };
    });
  }
  return rec;
}
function newRecords(w) {
  const before = cardioRecords(null, w.id), msgs = [];
  (w.activities || []).forEach(a => {
    const p = paceOf(a);
    if (!p) return;
    if (a.type === 'run' && before.longRun && +a.dist > before.longRun.dist) msgs.push(`longest run (${a.dist} mi)`);
    if (a.type === 'run' && +a.dist >= 1 && before.fastRun && p < before.fastRun.pace) msgs.push(`fastest pace (${fmtPace(p)} /mi)`);
    if (a.type === 'walk' && before.longWalk && +a.dist > before.longWalk.dist) msgs.push(`longest walk (${a.dist} mi)`);
    if (a.kind === 'hike' && before.longHike && +a.dist > before.longHike.dist) msgs.push(`longest hike (${a.dist} mi)`);
  });
  return msgs;
}

// Compound lifts rest 2:30 (3:00 when the range tops out at 8 or fewer, 2:00 for light sets of 12+); isolation lifts use your
// rest setting. A superset rests after the round, as long as its longest member needs.
function restFor(w, e) {
  const base = S.settings.restSec;
  if (!S.settings.smartRest) return base;
  const grp = w.exercises.filter(x => x.group === e.group).map(targetOf);
  return Math.max(...grp.map(t => (t.kind === 'iso' ? base : Math.max(base, t.max != null && t.max <= 8 ? 180 : t.min != null && t.min >= 12 ? 120 : 150))));
}

function setEnergy(v) {
  const today = todayStr(), b = bodyEntry(today);
  b.energy = b.energy === v ? null : v;
  saveBody(b);
  render();
}

function todaySummary(date, w) {
  const b = bodyEntry(date), target = proteinTargetFor(date), en = energyFor(date), pc = proteinCoach(date);
  let status;
  const acts = (w.activities || []).filter(actDone).length;
  if (w.type === 'strength' && w.exercises.length) status = `${sum(w.exercises.map(e => e.sets.filter(x => x.done).length))}/${sum(w.exercises.map(e => e.sets.length))}`;
  else if (acts) status = 'Done';
  else status = w.type === 'rest' ? 'Rest' : 'Not yet';
  return `<div class="card today-card">
    ${dayCoachHTML(dayCoach(date, w))}
    <div class="day-strip">
      <button class="${b.weight != null ? 'ok' : ''}" data-a="go-body"><span>Weigh-in</span><b>${b.weight != null ? b.weight : 'Not yet'}</b></button>
      <button class="${b.protein >= 0.9 * target ? 'ok' : pc && pc.behind ? 'behind' : ''}" data-a="go-body" data-f="food-name"><span>Protein</span><b>${b.protein}/${target}</b></button>
      <button class="${hasWork(w) ? 'ok' : ''}" data-a="scroll-work"><span>${w.type === 'strength' && w.exercises.length ? 'Sets' : w.type === 'rest' ? 'Today' : 'Workout'}</span><b>${status}</b></button>
    </div>
    ${en && sleepFor(date) != null && !S.checkinOpen ? `<button class="checkin-sum" data-a="checkin-open"><span>Energy <b>${ENERGY[en]}</b> · Sleep <b>${sleepPick(sleepFor(date))[1]} hrs</b></span><span class="linkbtn">Change</span></button>` : `
    <div class="energy"><span>Energy</span>
      <div class="seg">${Object.entries(ENERGY).map(([k, n]) => `<button class="${en === k ? 'on' : ''}" data-a="energy" data-v="${k}">${n}</button>`).join('')}</div>
    </div>
    <div class="energy"><span>Sleep hrs</span>
      <div class="seg">${SLEEP.map(([v, n]) => `<button class="${(sleepPick(sleepFor(date)) || [])[0] === v ? 'on' : ''}" data-a="sleep" data-v="${v}">${n}</button>`).join('')}</div>
    </div>`}
    <div class="sh-hint">${en ? ENERGY_HINT[en] : 'How are you feeling? The plan adjusts.'}${twoShortNights(date) ? (en && en !== 'low' ? ' Two short nights: no weight jumps today.' : en ? '' : ' Two short nights: no jumps, a couple of reps left on each set. Feeling OK? Tap it for the normal plan.') : sleepShort(date) ? ' Under 6 hrs of sleep: no jumps, easier cardio.' : ''}</div>
    ${w.type === 'strength' && !hasWork(w) && isDayKey(w.dayKey) && w.dayKey === planKeyOn(date) && date === todayStr()
      ? `<button class="rest-today" data-a="rest-today"><b>Take today as a rest day</b><span>Too sore or busy? ${esc(planOf(w.dayKey).label)} ${restPlan(w.date).to ? 'moves to tomorrow' : 'is skipped this week, so you never lift two days in a row'}.</span></button>` : ''}
  </div>`;
}

// ----- pushing too far -----
// You like to push, so the app says when it's too much: lifting day after day with no rest, going
// all-out on lots of lifts (from your notes), or jumping well past the plan's weights.
const liftedOn = date => S.workouts.some(x => x.date === date && (x.exercises || []).some(e => doneSets(e).length));
function liftStreakBefore(date) {
  let n = 0;
  while (n < 30 && liftedOn(addDays(date, -(n + 1)))) n++;
  return n;
}
const bigJump = (s, wt) => { const pw = s.pw === '' || s.pw == null ? null : +s.pw; return pw > 0 && wt >= pw * 1.15 && wt - pw >= 10; };
function pushGuard(w) {
  if (w.type !== 'strength' || w.date !== todayStr() || !hasWork(w)) return '';
  const out = [], n = liftStreakBefore(w.date) + 1;
  if (n >= 6) out.push(`<b>Day ${n} of lifting in a row.</b> Muscle grows while you rest, so take tomorrow fully off. A walk is fine.`);
  else if (!isTrainingDay(w.date) && n >= 3) out.push(`<b>Lifting on a rest day, ${n} days straight.</b> Go easy today and rest tomorrow. Rest is when the muscle gets built.`);
  const hard = [...new Set(workoutSigs(w).filter(x => x.k === 'lift-hard').map(x => x.about))];
  if (hard.length >= 3) out.push(`<b>${hard.length} lifts went all-out or felt hard today.</b> Going to failure now and then is fine. On most sets, stopping 1 or 2 reps short builds the same muscle and you recover faster.`);
  const jumps = w.exercises.filter(e => e.sets.some(x => x.done && bigJump(x, +x.w || 0)));
  if (jumps.length >= 2) out.push(`<b>Well over the plan on ${jumps.length} lifts.</b> Big jumps are where strains happen. The plan adds weight in steps you can keep.`);
  return out.length ? `<div class="card tip care">${out.join('<br><br>')}</div>` : '';
}
// After a week or more away: a welcome back, and a short version for busy days.
function comebackCard(w) {
  if (w.type !== 'strength' || hasWork(w) || !w.exercises.length) return '';
  const last = S.workouts.filter(x => x.date < w.date && (x.exercises || []).some(e => doneSets(e).length)).map(x => x.date).sort().pop();
  const gap = last ? daysBetween(last, w.date) : 0;
  if (gap < 7) return '';
  const short = w.exercises.length > 3 && !w.short ? `<button class="btn block" style="margin-top:12px" data-a="short-version" data-wid="${w.id}">Short on time? 25-minute version</button>` : '';
  return `<div class="card tip"><b>Welcome back!</b> ${gap >= 21
    ? `${gap} days off, so weights start lighter and climb back each session. It comes back faster than it took to build.`
    : `${gap} days off. Even a short session keeps your strength.`}${short}</div>`;
}

function welcomeCard() {
  if (S.settings.welcomed || S.workouts.some(hasWork)) return '';
  return `<div class="card tip"><b>Welcome to Lift Log.</b> Your plan for today is below, and everything saves as you go. First, set your height and goal so protein and calories fit you.
    <div class="btn-row" style="margin-top:10px"><button class="btn pri" data-a="go-goal">Set up</button><button class="btn" data-a="welcome-done">Got it</button></div></div>`;
}
function backupNudge() {
  const lb = S.settings.lastBackup, n = S.workouts.filter(hasWork).length;
  if (n < 5 || (lb && Date.now() - lb < 14 * 864e5)) return '';
  return `<div class="card tip"><b>Back up your log.</b> It only lives on this phone. ${lb ? 'Last backup was 2+ weeks ago.' : 'No backup yet.'}
    <div class="btn-row" style="margin-top:10px"><button class="btn pri" data-a="export">Save a backup</button></div></div>`;
}

function weekDoneKeys(ws) {
  const end = addDays(ws, 6);
  // A lifting day only counts as done with lifting in it; other days count with anything logged.
  const did = w => (w.type === 'strength' ? (w.exercises || []).some(e => doneSets(e).length) : hasWork(w));
  const keys = new Set(S.workouts.filter(w => w.date >= ws && w.date <= end && did(w)).map(w => w.dayKey));
  return plannedKeys().filter(k => keys.has(k));
}
// Planned sessions done this week: matching weekdays, plus other days you trained, up to the plan's count.
function weekDoneCount(ws) {
  const keys = weekDoneKeys(ws), end = addDays(ws, 6);
  const inWeek = S.workouts.filter(w => w.date >= ws && w.date <= end && hasWork(w));
  const keyDays = new Set(inWeek.filter(w => keys.includes(w.dayKey)).map(w => w.date));
  const liftDayNoLift = w => (S.program.days[w.dayKey] || {}).type === 'strength' && !(w.exercises || []).some(e => doneSets(e).length);
  const extra = new Set(inWeek.filter(w => !keys.includes(w.dayKey) && !keyDays.has(w.date) && !liftDayNoLift(w)).map(w => w.date)).size;
  // A rest day you take ("Take today as a rest day") is recovery, not a miss: if its lift couldn't fit back
  // into the week, it still counts, once a week at most.
  const took = Array.from({ length: 7 }, (_, k) => addDays(ws, k)).some(d => dayMoves()[d] === 'off' && (S.program.days[dayKeyOf(d)] || {}).type !== 'rest') ? 1 : 0;
  return Math.min(plannedKeys().length, keys.length + extra + took);
}
const plannedKeys = () => DAYS.filter(d => S.program.days[d].type !== 'rest');

// ----- Today -----
// This week's real dates. Tapping one shows that day: what you logged, or what's coming up.
function weekChips(shown) {
  const today = todayStr(), ws = weekStart(today);
  return `<div class="chips days">${DAYS.map((d, k) => {
    const date = addDays(ws, k);
    const did = S.workouts.some(w => w.date === date && hasWork(w));
    const cls = [date === shown ? 'on' : '', date === today ? 'today' : '', planOn(date).type === 'rest' ? 'rest' : ''].join(' ');
    return `<button class="chip ${cls}" data-a="day-view" data-d="${date}" aria-label="${DAY_NAMES[d]} ${esc(fmtDate(date, { month: 'long', day: 'numeric' }))}">${DAY_SHORT[d]}<small>${parseYmd(date).getDate()}</small>${did ? '<span class="dot"></span>' : ''}</button>`;
  }).join('')}</div>`;
}
const sessionBody = w => (w.type === 'strength' ? sessionStrength(w) : w.type === 'cardio' ? sessionCardio(w) : sessionRest(w));

// Other things logged today that aren't on screen (after switching workouts).
function alsoToday(w) {
  const other = S.workouts.filter(x => x.date === w.date && x !== w && hasWork(x));
  if (!other.length) return '';
  const bits = other.flatMap(x => [...(x.exercises || []).filter(e => doneSets(e).length).map(e => e.name), ...(x.activities || []).filter(actDone).map(a => (a.type === 'other' ? a.name || 'Activity' : a.type === 'yoga' ? 'Yoga' : moveLabel(a)))]);
  return `<div class="note-line muted">Also logged today: ${esc([...new Set(bits)].slice(0, 4).join(', '))}</div>`;
}
function viewToday() {
  const date = todayStr();
  if (S.dayView && S.dayView !== date && weekStart(S.dayView) === weekStart(date)) return viewDay(S.dayView);
  const w = todaySession();
  const realKey = dayKeyOf(date), planned = planKeyOn(date);
  const day = planOf(w.dayKey) || { label: w.label };
  const custom = !isDayKey(w.dayKey) && w.dayKey !== 'off';
  return `
    <header class="top">
      <div class="top-row">
        <div class="eyebrow">Today · ${esc(fmtDate(date, { month: 'long', day: 'numeric' }))}</div>
        <div class="pills">${levelPill()}<button class="streak-pill ${dayCounts(date) ? 'on' : ''}" data-a="tab" data-t="stats" aria-label="Daily streak">🔥 ${dailyStreak()}</button></div>
      </div>
      ${custom ? `<h1>${esc(w.label)}<span class="sub">${w.dayKey === 'free' ? 'Build it as you go' : 'One of your saved workouts'}</span></h1>`
        : `<h1>${DAY_NAMES[realKey]}<span class="sub">${esc(day.label)}${isDayKey(w.dayKey) && w.dayKey !== realKey ? ` (${DAY_NAMES[w.dayKey]}'s workout)` : ''}</span></h1>`}
      ${!custom && w.dayKey !== planned ? `<div class="note-line">Doing ${w.dayKey === 'off' ? 'a rest day' : `${DAY_NAMES[w.dayKey]}'s workout`} today. <button class="linkbtn inline" data-a="pick-day" data-k="${planned}">Switch back</button></div>` : ''}
      ${!custom && w.dayKey === planned && isDayKey(planned) && planned !== realKey ? `<div class="note-line muted">Moved here from ${DAY_NAMES[planned]} after a rest day.</div>` : ''}
      ${alsoToday(w)}
    </header>
    ${welcomeCard()}
    ${trainerCard()}
    ${todaySummary(date, w)}
    ${noteBanner(date)}
    ${comebackCard(w)}
    ${pushGuard(w)}
    ${w.type === 'strength' && deloadState(date).active ? deloadCard(date) : ''}
    ${weekChips(date)}
    <button class="linkbtn diff-btn ${custom ? 'on' : ''}" data-a="pick-other">${custom ? '✓ Doing a different workout · change' : '+ Different workout (saved or blank)'}</button>
    <div id="work"></div>
    ${soreCard(w)}
    ${sessionBody(w)}`;
}

// Another day this week: look back at what you logged, or ahead at what's planned.
function viewDay(date) {
  const k = dayKeyOf(date), pk = planKeyOn(date), plan = planOn(date), past = date < todayStr();
  const logged = sortedW().filter(w => w.date === date && hasAny(w));
  const missed = past && plan.type !== 'rest' && !weekDoneKeys(weekStart(date)).includes(pk);
  let body;
  if (logged.length) {
    body = logged.map(w => `${logged.length > 1 ? `<div class="lbl day-lbl">${esc(w.label)}</div>` : ''}${sessionBody(w)}`).join('');
  } else if (past) {
    body = `<div class="card empty"><b>Nothing logged</b>${plan.type === 'rest' ? 'It was a rest day.' : `The plan was ${esc(plan.label)}.`}</div>
      <button class="btn block" data-a="past-open" data-d="${date}">+ Log something for ${DAY_NAMES[k]}</button>`;
  } else body = previewDay(pk, date);
  return `<header class="top">
      <div class="top-row"><button class="linkbtn back-today" data-a="day-view" data-d="${todayStr()}">‹ Back to today</button></div>
      <h1>${DAY_NAMES[k]}<span class="sub">${esc(fmtDate(date, { month: 'long', day: 'numeric' }))} · ${past ? (logged.length ? esc(logged[0].label) : 'Past day') : `Coming up · ${esc(plan.label)}`}</span></h1>
    </header>
    ${weekChips(date)}
    ${body}
    ${missed || (!past && plan.type !== 'rest') ? `<button class="btn block" data-a="do-today" data-k="${pk}">${past ? 'Do this workout today' : 'Do this workout today instead'}</button>` : ''}`;
}
function previewDay(k, date) {
  const plan = planOf(k) || S.program.days[dayKeyOf(date)];
  if (plan.type === 'rest') return '<div class="card rest-card"><div class="big">Rest day</div><div class="muted">Nothing planned. Recover, eat, sleep.</div></div>';
  if (plan.type === 'cardio') {
    const rec = recommendCardio(date, k);
    return `<div class="card"><div class="lbl">The plan</div><b>${esc(rec.text)}</b><div class="muted small">${esc(rec.why || '')}</div></div>`;
  }
  const w = buildSession(k, date);
  return `<div class="card plan-card"><div class="lbl">The plan</div>
    ${w.exercises.map(e => `<div class="row"><div>${esc(e.name)}<div class="muted small">${isHome(e) ? 'At home · ' : ''}${e.makeUp ? `Make-up from ${esc(e.makeUp)} · ` : ''}${esc(targetText(e.target))}</div></div>${e.sets[0] && +e.sets[0].w ? `<small>${fmtW(e.sets[0].w)} lb</small>` : ''}</div>`).join('')}
    ${w.exercises.some(e => e.sets[0] && +e.sets[0].w) ? '<div class="sh-hint">Weights are a guess for now. They update as you lift.</div>' : ''}</div>`;
}

function sessionStrength(w) {
  const groups = [];
  w.exercises.forEach((e, i) => {
    const g = groups.find(x => x.id === e.group);
    if (g) g.items.push(i); else groups.push({ id: e.group, items: [i] });
  });
  const homeG = g => g.items.some(i => isHome(w.exercises[i]));
  const card = g => {
    const multi = g.items.length > 1;
    const up = isLive(w) && g.items.some(i => (w.exercises[i].coach || {}).kind === 'up' && !isFolded(w, i));
    const inner = g.items.map((i, k) => exBlock(w, i, multi ? String.fromCharCode(65 + k) : '')).join('');
    return `<section class="card ${multi ? 'ss' : ''} ${up ? 'up' : ''}">
      ${multi ? '<div class="ss-tag">Superset <span>· alternate, rest after the round</span></div>' : ''}
      ${inner}
    </section>`;
  };
  const homeWhenG = g => homeWhen(w.exercises[g.items.find(i => isHome(w.exercises[i]))]);
  const homePart = when => {
    const list = groups.filter(g => homeG(g) && homeWhenG(g) === when).map(card).join('');
    return list ? `<div class="home-head"><b>At home, ${when} the gym</b><span>${HOME_WHY[when]}</span></div>${list}` : '';
  };
  const gymCards = groups.filter(g => !homeG(g)).map(card).join(''), before = homePart('before');
  const cards = before + (before && gymCards ? '<div class="home-head"><b>At the gym</b></div>' : '') + gymCards + homePart('after');
  const total = sum(w.exercises.map(e => e.sets.length));
  const logged = sum(w.exercises.map(e => e.sets.filter(s => s.done).length));
  const kcal = hasWork(w) ? workoutKcal(w) : null;
  const plan = planOf(w.dayKey);
  const free = w.dayKey === 'free';
  return `${free ? `<div class="card"><label class="lbl" for="wname-${w.id}">Workout name</label>
      <input class="inp" id="wname-${w.id}" data-wid="${w.id}" data-wb="label" value="${esc(w.label)}" placeholder="e.g. Hotel gym"></div>` : ''}
    ${w.exercises.length && !S.workouts.some(x => (x.exercises || []).some(e => doneSets(e).length)) ? '<div class="sh-hint tap-hint">Tap a set to change it, then ✓ when it\'s done. Saves as you go.</div>' : ''}
    ${w.date === todayStr() && !deloadState(w.date).active && !hasWork(w) ? deloadCard(w.date) : ''}
    ${!isLive(w) && w.exercises.some(e => e.sets.some(x => !x.done && x.w !== '' && x.r !== '')) ? `<button class="btn pri block" data-a="log-all" data-wid="${w.id}">${ic('check')} Log all sets as shown</button><div class="sh-hint" style="margin-bottom:10px">Or tick just the ones you did. Only ticked sets count.</div>` : ''}
    ${bodyCard(w)}
    ${habitCard(w)}
    ${cards || '<div class="card empty"><b>No exercises yet</b>Add your first one below.</div>'}
    <div class="btn-row add-pair">
      <button class="btn" data-a="sx-add" data-wid="${w.id}">+ Exercise</button>
      <button class="btn" data-a="act-pick" data-wid="${w.id}">+ Activity</button>
    </div>
    ${actCards(w)}
    ${notesCard(w)}
    ${total ? `<div class="sh-hint center" style="margin-bottom:8px">${logged} of ${total} sets${logged ? ` · about ${liftMinutes(w)} min` : ''}${kcal ? ` · ~${kcal} active cal` : ''}</div>` : ''}
    ${free && logged ? `<button class="btn block" data-a="save-plan" data-wid="${w.id}">Save as a workout you can repeat</button>` : ''}
    ${plan && w.date === todayStr() ? `<button class="linkbtn block center" data-a="plan-edit" data-k="${w.dayKey}">Edit ${isDayKey(w.dayKey) ? `${DAY_NAMES[w.dayKey]}'s` : 'this'} workout for next time</button>` : ''}`;
}

function exBlock(w, i, letter) {
  const e = w.exercises[i];
  if (isFolded(w, i)) {
    return `<button class="ex ex-fold" data-a="ex-unfold" data-wid="${w.id}" data-ex="${i}">
      <span class="ex-name">${letter ? `<span class="ss-letter">${letter}</span>` : ''}${esc(e.name)}</span>
      <span class="fold-sum">${ic('check')} ${e.sets.map(s => `${fmtW(s.w)}×${s.r}`).join(', ')}${hasExNote(e) ? ` · ${ic('note')}` : ''}</span>${sayHTML(w, i, true)}</button>`;
  }
  const last = lastPerf(e.key, w);
  const c = isLive(w) ? e.coach : null;
  // Machines logged by pin number show "#8", not "8 lb".
  const stack = isPin(e);
  const unit = e.target.unit === 'steps' ? 'steps' : 'reps';
  const lastTxt = last
    ? `Last time (${esc(fmtDate(last.date, { month: 'short', day: 'numeric' }))}): <b>${last.sets.map(s => `${fmtW(s.w)}×${s.r}`).join(', ')}</b>${last.rest ? ` · rested ${fmtClock(last.rest.med)}` : ''}`
    : doneSets(e).length ? '' : 'First time logging this. Enter a weight to start.';
  const keepW = (k, s) => (c.prev ? c.prev[Math.min(k, c.prev.length - 1)] : (+s.w === c.w ? c.from : +s.w));
  const canKeep = c && (c.kind === 'up' || c.kind === 'down') && e.sets.some((s, k) => !s.done && +s.w !== keepW(k, s));
  const banner = c ? `<div class="coach coach-${c.kind}"><span>${COACH_MARK[c.kind] || '→'} ${esc(c.note)}</span>
      ${canKeep ? `<button data-a="keep-w" data-wid="${w.id}" data-ex="${i}">${c.prev && new Set(c.prev).size > 1 ? 'Stay at last' : `Stay at ${c.from}`}</button>` : ''}</div>` : '';
  const rows = e.sets.map((s, j) => `
    <div class="set ${s.done ? 'done' : ''}">
      <span class="set-no">${j + 1}</span>
      <button class="set-val" data-a="edit-set" data-wid="${w.id}" data-ex="${i}" data-s="${j}" aria-label="Edit set ${j + 1}">
        <b>${stack && s.w !== '' ? '#' : ''}${fmtW(s.w)}</b>${s.w !== '' && +s.w !== 0 && !stack ? '<small>lb</small>' : ''}<span class="x">×</span><b>${s.r === '' ? '—' : s.r}</b><small>${unit}</small>
      </button>
      <button class="check" data-a="tick" data-wid="${w.id}" data-ex="${i}" data-s="${j}" aria-label="${s.done ? 'Undo set' : 'Log set'}">${ic('check')}</button>
    </div>`).join('');
  return `<div class="ex">
    <div class="ex-head">
      <div>
        <div class="ex-name">${letter ? `<span class="ss-letter">${letter}</span>` : ''}${esc(e.name)}</div>
        <div class="ex-target">${e.makeUp ? `<span class="mk-tag">Make-up from ${esc(e.makeUp)}</span>` : ''}${esc(targetText(e.target))}${isLive(w) && e.target.sets && e.sets.length !== e.target.sets ? ` · <b>${e.sets.length} ${e.sets.length === 1 ? 'set' : 'sets'} today</b>` : ''}</div>
      </div>
      <div class="ex-btns">
        <a class="icon-btn" href="${formUrl(e.name)}" target="_blank" rel="noopener" aria-label="How to do it">${ic('play')}</a>
        <button class="icon-btn" data-a="ex-chart" data-key="${esc(e.key)}" aria-label="Progress chart">${ic('chart')}</button>
        <button class="icon-btn" data-a="ex-opts" data-wid="${w.id}" data-ex="${i}" aria-label="Change or remove">${ic('more')}</button>
      </div>
    </div>
    ${exMuscles(w, i)}
    <div class="ex-last">${lastTxt}</div>
    ${last && last.note && last.note.quote ? `<div class="ex-note">“${esc(last.note.quote)}”<span>Your note, ${esc(fmtDate(last.date, { month: 'short', day: 'numeric' }))}</span></div>` : ''}
    ${banner}
    <div class="sets">${rows}</div>
    ${sayHTML(w, i)}
    <div class="ex-tools">
      <button data-a="add-set" data-wid="${w.id}" data-ex="${i}">+ Set</button>
      ${e.sets.length > 1 ? `<button data-a="rm-set" data-wid="${w.id}" data-ex="${i}">− Set</button>` : ''}
      <button class="ex-note-btn ${hasExNote(e) ? 'has' : ''}" data-a="ex-note" data-wid="${w.id}" data-ex="${i}" aria-expanded="${noteOpen(w, i)}">${ic('note')}<span id="exn-sum-${w.id}-${i}">${esc(exNoteSum(e))}</span></button>
    </div>
    ${noteOpen(w, i) ? `<div class="ex-notes">
      <textarea class="inp" id="exn-${w.id}-${i}" data-wid="${w.id}" data-wb="exercises.${i}.notes" placeholder="Form cues, how it felt, the machine you used…">${esc(e.notes || '')}</textarea>
      ${noteTagsFor(w, `e${i}`)}
      <div class="sh-hint">Shows here next time. “Felt easy”, “too heavy”, or “hurt” also changes the plan.</div>
    </div>` : ''}
  </div>`;
}

// A lift's own notes: folded behind a small button until you need them (open while a note has text and you tapped it).
const noteOpen = (w, i) => !!(S.noteOpen || {})[`${w.id}:${(w.exercises[i] || {}).key}`];
const exNoteSum = e => { const t = String((e && e.notes) || '').trim().replace(/\s+/g, ' '); return !t ? 'Note' : t.length > 24 ? `${t.slice(0, 22)}…` : t; };
// A finished exercise folds to one line once you've moved on (answered the reps question or started the next one).
function isFolded(w, i) {
  const e = w.exercises[i];
  if (w.date !== todayStr() || !e.sets.length || !e.sets.every(s => s.done) || (S.unfold || {})[`${w.id}:${i}`]) return false;
  const last = e.sets[e.sets.length - 1];
  return true;
}
function notesCard(w) {
  return `<div class="card">
    <label class="lbl" for="notes-${w.id}">Workout notes</label>
    <textarea class="inp" id="notes-${w.id}" data-wid="${w.id}" data-wb="notes" placeholder="Pain, form cues, energy, how it felt…">${esc(w.notes)}</textarea>
    ${noteTagsFor(w, 'w')}
    ${fieldSigs(w, 'w').length ? '' : `<div class="sh-hint">Try “bench felt easy” or “sore chest”. Words I act on turn into tags. Tap one to see what it does.</div>`}
  </div>`;
}

function sessionCardio(w) {
  const today = w.date === todayStr();
  const recC = recommendCardio(w.date, w.dayKey);
  const kcal = workoutKcal(w);
  return `${today ? cardioPlan(w, recC) : ''}
    ${actCards(w, recC)}
    <div class="add-row four">
      ${Object.entries(ADD_TYPES).map(([t, n]) => `<button class="btn" data-a="add-act" data-wid="${w.id}" data-t="${t}">+ ${n}</button>`).join('')}
      <button class="btn" data-a="act-pick" data-wid="${w.id}">+ Other</button>
    </div>
    ${notesCard(w)}
    <div class="sh-hint center">${kcal ? `~${kcal} active cal · ` : ''}Everything saves as you go.</div>`;
}
// Rest days can still hold a hike, a climb, or anything else.
function sessionRest(w) {
  const acts = (w.activities || []).length;
  const kcal = acts ? workoutKcal(w) : null;
  const isToday = w.date === todayStr();
  const u = S.settings.restUndo, off = isToday && dayMoves()[w.date] === 'off' && u && u.date === w.date;
  if (off && !acts) return `<div class="card rest-card"><div class="big">Rest day</div><div class="muted">Taking today off. ${esc((planOf(u.key) || {}).label || 'Your lift')} ${u.to ? `moves to ${esc(fmtDate(u.to, { weekday: 'long' }))}` : 'is skipped this week'}. Recover, eat your protein, sleep well.</div>
      <button class="linkbtn" style="margin-top:10px" data-a="rest-undo">Undo, I'll lift today</button></div>
    ${actCards(w)}
    <button class="btn block" data-a="act-pick" data-wid="${w.id}">+ Activity</button>
    <button class="btn block" data-a="go-body">Log bodyweight and protein</button>`;
  return `${acts || !isToday ? '' : `<div class="card rest-card"><div class="big">Rest day</div><div class="muted">Recover, eat your protein, sleep well. Missed a session? Tap its day above.</div></div>`}
    ${actCards(w)}
    <button class="btn block" data-a="act-pick" data-wid="${w.id}">+ Activity</button>
    ${acts ? `${notesCard(w)}
      <div class="sh-hint center">${kcal ? `~${kcal} active cal · ` : ''}Everything saves as you go.</div>`
    : isToday ? '<button class="btn block" data-a="go-body">Log bodyweight and protein</button>' : ''}`;
}
function actCards(w, recC) {
  return (w.activities || []).map((a, k) => (a.type === 'yoga' ? yogaCard(w, a, k) : a.type === 'other' ? otherCard(w, a, k) : moveCard(w, a, k, recC))).join('');
}

function cardioPlan(w, recC) {
  const recY = recommendYoga(w.date);
  const hasYoga = w.activities.some(a => a.type === 'yoga');
  const hasMove = w.activities.some(a => a.type !== 'yoga');
  const rd = S.settings.yogaLevel === 'beginner' ? yogaReadiness() : null;
  return `<div class="card plan">
    <div class="ss-tag">Today's plan</div>
    <div class="plan-item ${hasYoga ? 'done' : ''}">
      <div><b>Yoga: ${recY.pick.name}, ${recY.pick.len}</b>${hasYoga ? '' : `<small>${esc(recY.why.join(' '))}</small>`}</div>
      ${hasYoga ? ic('check') : `<button class="btn pri" data-a="add-yoga" data-wid="${w.id}" data-id="${recY.pick.id}">Log it</button>`}
    </div>
    ${hasYoga ? '' : `<div class="alt-row"><span>Or:</span>${recY.others.map(c => `<button class="chip" data-a="add-yoga" data-wid="${w.id}" data-id="${c.id}">${c.name} ${c.len}</button>`).join('')}</div>`}
    <div class="plan-item ${hasMove ? 'done' : ''}">
      <div><b>${esc(recC.text)}</b>${hasMove ? '' : `<small>${esc(recC.why)}</small>`}</div>
      ${hasMove ? ic('check') : `<button class="btn pri" data-a="add-act" data-wid="${w.id}" data-t="${recC.type}"${recC.intervals ? ' data-style="intervals"' : ''}>Log it</button>`}
    </div>
    ${rd && rd.ready ? `<div class="coach coach-up" style="margin-top:12px"><span>▲ Your beginner classes have felt easy for a while. You might be ready for intermediate.</span><button data-a="yoga-level" data-v="intermediate">Switch</button></div>` : ''}
    ${hasYoga && hasMove ? '' : '<div class="sh-hint">Tap "Log it" after you finish.</div>'}
  </div>`;
}

function actSeg(w, k, a, field, opts) {
  return `<div class="seg">${opts.map(([v, n]) => `<button class="${String(a[field]) === String(v) ? 'on' : ''}" data-a="act-set" data-wid="${w.id}" data-i="${k}" data-f="${field}" data-v="${v}">${n}</button>`).join('')}</div>`;
}
function actHead(w, k, title) {
  return `<div class="act-head"><b>${title}</b><button class="icon-btn" data-a="rm-act" data-wid="${w.id}" data-i="${k}" aria-label="Remove">${ic('x')}</button></div>`;
}
function yogaCard(w, a, k) {
  return `<div class="card">
    ${actHead(w, k, 'Yoga')}
    <label class="lbl">Class</label>${actSeg(w, k, a, 'style', [['combo', 'Combination'], ['flex', 'Flexibility'], ['strength', 'Strength']])}
    <label class="lbl">Length</label>${actSeg(w, k, a, 'min', [[30, '30 min'], [60, '1 hour']])}
    <label class="lbl">How did it feel?</label>${actSeg(w, k, a, 'feel', [['easy', 'Easy'], ['right', 'Just right'], ['hard', 'Hard']])}
    <label class="lbl">Notes</label>
    <input class="inp" data-wid="${w.id}" data-wb="activities.${k}.notes" value="${esc(a.notes)}" placeholder="Tight, sore, or great?">
    ${noteTagsFor(w, k)}
    <div class="act-stats" id="act-stats-${k}">${actStatsText(a, w.date)}</div>
  </div>`;
}
function moveCard(w, a, k, rec) {
  autoMoveType(a);
  const sug = rec && rec.dist && (a.auto || rec.type === a.type) ? rec : null;
  return `<div class="card">
    ${actHead(w, k, moveLabel(a))}
    ${a.auto ? `<div class="sh-hint" style="margin-top:0">Your pace sorts it: slower than ${fmtPace(WALK_PACE)} /mi is a walk, faster than ${fmtPace(RUN_PACE)} a run, and between counts as both.</div>` : ''}
    ${a.type === 'run' || a.auto ? `<div class="seg" style="margin-bottom:4px">${[['steady', 'Steady'], ['intervals', 'Intervals']].map(([v, n]) => `<button class="${(a.style || 'steady') === v ? 'on' : ''}" data-a="act-set" data-wid="${w.id}" data-i="${k}" data-f="style" data-v="${v}">${n}</button>`).join('')}</div>` : ''}
    <label class="lbl">Distance (miles)</label>
    <input class="inp" inputmode="decimal" data-wid="${w.id}" data-wb="activities.${k}.dist" value="${esc(a.dist)}" placeholder="${sug ? sug.dist : '0.0'}">
    <div class="grid2" style="margin-top:12px">
      ${[['start', 'Start'], ['end', 'Finish']].map(([f, n]) => `<div><div class="lbl-row"><label class="lbl">${n}</label>
        <button class="linkbtn" data-a="act-now" data-wid="${w.id}" data-i="${k}" data-f="${f}">Now</button></div>
        <input class="inp time-inp" type="time" data-wid="${w.id}" data-wb="activities.${k}.${f}" value="${esc(clockMin(a[f]) == null ? '' : a[f])}"></div>`).join('')}
    </div>
    <div class="dur" id="act-dur-${k}">${durText(a)}</div>
    <details class="len-type"${clockMin(a.start) == null && actMinutes(a) ? ' open' : ''}><summary>Type the length instead</summary>
      <div class="grid2">
        <div><label class="lbl">Minutes</label><input class="inp" inputmode="numeric" id="act-min-${k}" data-wid="${w.id}" data-wb="activities.${k}.min" value="${esc(a.min)}" placeholder="0"></div>
        <div><label class="lbl">Seconds</label><input class="inp" inputmode="numeric" id="act-sec-${k}" data-wid="${w.id}" data-wb="activities.${k}.sec" value="${esc(a.sec)}" placeholder="0"></div>
      </div>
    </details>
    <div class="act-stats" id="act-stats-${k}">${actStatsText(a, w.date) || 'Enter distance and time to see pace and calories.'}</div>
    ${sug ? `<div class="sh-hint">Suggested today: ${sug.dist} mi at about ${fmtPace(sug.pace)} /mi</div>` : ''}
    <label class="lbl">Notes</label>
    <input class="inp" data-wid="${w.id}" data-wb="activities.${k}.notes" value="${esc(a.notes)}" placeholder="Route, how it felt">
    ${noteTagsFor(w, k)}
  </div>`;
}

function otherCard(w, a, k) {
  const def = actDef(a), lv = actLevel(a, def);
  const levels = def.levels || [];
  return `<div class="card">
    ${actHead(w, k, esc(a.name))}
    ${levels.length > 1 ? `<label class="lbl">How hard?</label>${actSeg(w, k, { ...a, level: lv }, 'level', levels.map((n, i) => [i, n]))}
      ${def.hint ? `<div class="sh-hint">${esc(def.hint[lv])}</div>` : ''}` : ''}
    <div class="grid2" style="margin-top:12px">
      <div><label class="lbl">Hours</label><input class="inp" inputmode="numeric" data-wid="${w.id}" data-wb="activities.${k}.hr" value="${esc(a.hr)}" placeholder="0"></div>
      <div><label class="lbl">Minutes</label><input class="inp" inputmode="numeric" data-wid="${w.id}" data-wb="activities.${k}.min" value="${esc(a.min)}" placeholder="0"></div>
    </div>
    ${def.dist ? `<label class="lbl">Distance (miles, optional)</label>
      <input class="inp" inputmode="decimal" data-wid="${w.id}" data-wb="activities.${k}.dist" value="${esc(a.dist)}" placeholder="0.0">` : ''}
    <div class="act-stats" id="act-stats-${k}">${actStatsText(a, w.date) || 'Enter how long it took to see calories.'}</div>
    <label class="lbl">Notes</label>
    <input class="inp" data-wid="${w.id}" data-wb="activities.${k}.notes" value="${esc(a.notes)}" placeholder="Where, how it felt">
    ${noteTagsFor(w, k)}
  </div>`;
}

// ----- History -----
function summaryOf(w) {
  const kcal = workoutKcal(w);
  const parts = [];
  const n = sum((w.exercises || []).map(e => doneSets(e).length));
  if (n) {
    const exs = (w.exercises || []).filter(e => doneSets(e).length).length;
    parts.push(`${n} set${n === 1 ? '' : 's'} · ${exs} exercise${exs === 1 ? '' : 's'}`);
  }
  (w.activities || []).forEach(a => {
    if (a.type === 'yoga') { parts.push(`${YOGA_STYLES[a.style] || 'Yoga'} yoga ${+a.min >= 60 ? '1 hr' : `${a.min || 30} min`}`); return; }
    const p = paceOf(a), m = actMinutes(a);
    if (a.type === 'other') { parts.push(`${a.name}${m ? ` ${fmtDur(m)}` : ''}${+a.dist ? ` · ${a.dist} mi` : ''}`); return; }
    const n = moveLabel(a);
    if (p) parts.push(`${n} ${a.dist} mi · ${fmtPace(p)} /mi`);
    else parts.push(a.dist ? `${n} ${a.dist} mi` : m ? `${n} ${fmtDur(m)}` : n);
  });
  return (parts.join(' · ') || 'Notes only') + (kcal ? ` · ~${kcal} cal` : '');
}

function viewHistory() {
  const seg = `<div class="seg">
    <button class="${S.histSeg === 'workouts' ? 'on' : ''}" data-a="seg" data-v="workouts">Workouts</button>
    <button class="${S.histSeg === 'exercises' ? 'on' : ''}" data-a="seg" data-v="exercises">Exercises</button>
  </div>`;
  let list = '';
  if (S.histSeg === 'workouts') {
    const ws = sortedW().filter(hasAny);
    if (!ws.length) list = '<div class="empty"><b>No workouts yet</b>Your logged sessions show up here.</div>';
    let month = '';
    let rows = [];
    const flush = () => { if (rows.length) list += `<div class="card flush">${rows.join('')}</div>`; rows = []; };
    ws.forEach(w => {
      const m = fmtDate(w.date, { month: 'long', year: 'numeric' });
      if (m !== month) { flush(); list += `<div class="month">${esc(m)}</div>`; month = m; }
      rows.push(`<button class="row" data-a="open-w" data-id="${w.id}">
        <div><b>${esc(fmtDate(w.date))} · ${esc(w.label)}</b><small>${esc(summaryOf(w))}${(w.notes || '').trim() ? ` · “${esc(w.notes.trim().slice(0, 60))}”` : ''}</small></div>
        ${ic('chev')}</button>`);
    });
    flush();
  } else {
    const ex = allExercises();
    if (!ex.length) list = '<div class="empty"><b>No exercise history yet</b>Log some sets and their progress charts show up here.</div>';
    else list = `<div class="card flush" style="margin-top:12px">${ex.map(x => `
      <button class="row" data-a="ex-chart" data-key="${esc(x.key)}">
        <div><b>${esc(x.name)}</b><small>${x.count} session${x.count === 1 ? '' : 's'} · last ${esc(fmtDate(x.last, { month: 'short', day: 'numeric' }))}</small></div>
        <span class="val">${x.iso && x.bestSet ? `${fmtW(x.bestSet.w)}×${x.bestSet.r}` : x.best ? `${x.best}` : ''}</span>${ic('chev')}</button>`).join('')}</div>
      <div class="foot">On the right: your best estimated 1-rep max (lb) for big lifts, and your best set for small lifts, where a 1-rep max doesn't mean much.</div>`;
  }
  return `<header class="top"><h1>History</h1></header>
    <button class="btn block" data-a="past-open" style="margin-bottom:12px">+ Log a past day</button>
    ${seg}${list}`;
}

// A 1-rep max from 15-rep raises means little: skip it for isolation lifts and 12+ rep work.
const noOneRm = e => { const t = e.target ? targetOf(e) : classify({ name: e.name }); return t.kind === 'iso' || (t.min != null && t.min >= 12); };
function exHistory(key) {
  const out = [];
  for (const w of S.workouts) {
    for (const e of w.exercises || []) {
      if (e.key !== key) continue;
      const sets = doneSets(e);
      if (sets.length) out.push({ date: w.date, t: parseYmd(w.date).getTime(), name: e.name, unit: e.target && e.target.unit, iso: noOneRm(e), sets, wid: w.id });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
function sessStats(s) {
  let top = s.sets[0];
  s.sets.forEach(x => { if (+x.w > +top.w || (+x.w === +top.w && +x.r > +top.r)) top = x; });
  return { top, e1: Math.round(Math.max(...s.sets.map(x => e1rm(+x.w, +x.r)))), reps: sum(s.sets.map(x => +x.r)) };
}
function allExercises() {
  const m = new Map();
  for (const w of S.workouts) for (const e of w.exercises || []) {
    const sets = doneSets(e);
    if (!sets.length) continue;
    const x = m.get(e.key) || { key: e.key, name: e.name, count: 0, last: w.date, best: 0, steps: e.target && e.target.unit === 'steps', iso: noOneRm(e) };
    x.count++;
    if (w.date >= x.last) { x.last = w.date; x.name = e.name; }
    if (x.iso) sets.forEach(s => { if (!x.bestSet || +s.w > +x.bestSet.w || (+s.w === +x.bestSet.w && +s.r > +x.bestSet.r)) x.bestSet = s; });
    else if (!x.steps) x.best = Math.max(x.best, Math.round(Math.max(...sets.map(s => e1rm(+s.w, +s.r)))));
    m.set(e.key, x);
  }
  return [...m.values()].sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name));
}

// Form videos for any exercise: a YouTube search, so the link never goes stale.
const FORM_SEARCH = [[/cuban/i, 'cuban press rotator cuff'], [/rope pushdown|rope pull/i, 'rope triceps pushdown'], [/pendulum squat/i, 'pendulum squat machine'], [/mace/i, 'steel mace']];
const formUrl = name => {
  const q = (FORM_SEARCH.find(([re]) => re.test(name)) || [])[1];
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${q && !/mace/i.test(q) ? q : `${name.replace(/\(.*?\)/g, '').trim()}${q ? '' : ''}`} proper form`)}`;
};
const formLink = name => `<a class="howto" href="${formUrl(name)}" target="_blank" rel="noopener">${ic('play')} How to do it</a>`;
function viewExercise() {
  const hist = exHistory(S.view.key);
  const name = hist.length ? hist[hist.length - 1].name : S.view.key;
  const back = `<button class="backbtn" data-a="back">${ic('back')} Back</button>`;
  if (!hist.length) {
    return `${back}<header class="top"><h1>${esc(name)}</h1>${formLink(name)}</header>
      <div class="card empty"><b>No sets logged yet</b>Your chart fills in after the first session.</div>`;
  }
  const stats = hist.map(h => ({ ...h, ...sessStats(h) }));
  const steps = hist.some(h => h.unit === 'steps') || hist.some(h => h.iso);
  const bw = stats.every(s => !+s.top.w);
  let chart, kpis;
  if (bw) {
    chart = lineChart([{ name: 'Total reps', color: 'var(--acc)', pts: stats.map(s => [s.t, s.reps]) }]);
    kpis = [[Math.max(...stats.map(s => s.reps)), 'Best total reps'], [Math.max(...stats.map(s => +s.top.r)), 'Best set'], [stats.length, 'Sessions']];
  } else {
    const series = [{ name: 'Top set weight', color: 'var(--acc)', pts: stats.map(s => [s.t, +s.top.w]) }];
    if (!steps) series.push({ name: 'Estimated 1RM', color: '#7cc4ff', pts: stats.map(s => [s.t, s.e1]) });
    chart = lineChart(series);
    const bestTop = stats.reduce((a, s) => (+s.top.w > +a.top.w || (+s.top.w === +a.top.w && +s.top.r > +a.top.r) ? s : a), stats[0]);
    kpis = [[`${fmtW(bestTop.top.w)}×${bestTop.top.r}`, 'Best top set'], (hist.some(h => h.iso) ? [Math.max(...stats.map(s => s.reps)), 'Best total reps'] : [steps ? stats.length : Math.max(...stats.map(s => s.e1)), steps ? 'Sessions' : 'Best est. 1RM']), [`${fmtW(stats[stats.length - 1].top.w)}×${stats[stats.length - 1].top.r}`, 'Last top set']];
  }
  const rows = [...stats].reverse().map(s => `<tr>
      <td>${esc(fmtDate(s.date, { month: 'short', day: 'numeric' }))}</td>
      <td>${s.sets.map(x => `${fmtW(x.w)}×${x.r}`).join(', ')}</td>
      <td>${bw || steps ? '' : s.e1}</td></tr>`).join('');
  const head = bw || steps ? '' : '<tr><td></td><td></td><td class="muted small">Est. 1RM</td></tr>';
  return `${back}
    <header class="top"><h1>${esc(name)}</h1>${formLink(name)}</header>
    <div class="kpis">${kpis.map(k => `<div class="kpi"><b>${esc(k[0])}</b><span>${k[1]}</span></div>`).join('')}</div>
    <div class="card">${chart}</div>
    <h2>Sessions</h2>
    <div class="card"><table class="sess-table">${head}${rows}</table></div>
    ${bw || steps ? (hist.some(h => h.iso) ? '<div class="foot">No 1-rep max here: for small lifts, your best set and total reps tell you more.</div>' : '') : '<div class="foot">Estimated 1RM uses the Epley formula: weight × (1 + reps ÷ 30).</div>'}`;
}

function viewWorkout() {
  const w = getW(S.view.id);
  if (!w) { S.view = null; return viewHistory(); }
  return `<button class="backbtn" data-a="back">${ic('back')} History</button>
    <header class="top">
      <div class="eyebrow">${w.type === 'rest' ? 'Activity day' : isDayKey(w.dayKey) ? `${esc(DAY_NAMES[w.dayKey])}'s session` : 'Custom workout'}</div>
      <h1>${esc(fmtDate(w.date, { weekday: 'long', month: 'short', day: 'numeric' }))}<span class="sub">${esc(w.label)}</span></h1>
    </header>
    ${w.type === 'strength' ? sessionStrength(w) : w.type === 'cardio' ? sessionCardio(w) : sessionRest(w)}
    <div class="card" style="margin-top:24px"><label class="lbl">Wrong day? Change the date</label><input class="inp" type="date" data-wid="${w.id}" data-wb="date" value="${w.date}" max="${todayStr()}"></div>
    <button class="btn danger block" style="margin-top:12px" data-a="del-w" data-id="${w.id}">Delete this workout</button>`;
}

// ----- Body -----
function bodyEntry(date) {
  const b = S.body[date] || { date, weight: null, protein: 0 };
  if (!b.items) b.items = (b.adds || []).map(g => ({ name: '', g }));
  return b;
}
function saveBody(b) {
  delete b.adds;
  b.protein = sum(b.items.map(x => +x.g || 0));
  if (b.date >= todayStr() || !b.target) b.target = liveTarget(b.date);
  S.body[b.date] = b;
  DB.put('body', b).catch(saveFailed);
}
function latestWeighIn(date) {
  return Object.values(S.body).filter(x => x.date <= date && x.weight != null).sort((a, c) => c.date.localeCompare(a.date))[0] || null;
}
// Protein follows bodyweight. Above a BMI of 30, extra weight is mostly not muscle, so the goal uses
// the weight at a BMI of 25 for your height instead (ISSN; Morton 2018).
function proteinBasisLb(lb) {
  const hIn = S.settings.profile.heightIn, bmi = 703 * lb / (hIn * hIn);
  return bmi > 30 ? Math.round(25 * hIn * hIn / 703) : lb;
}
// A cut raises protein to at least 1 g per lb to protect muscle while eating less (Helms 2014).
const perLbFor = () => (S.settings.goal === 'cut' ? Math.max(1, S.settings.proteinPerLb) : S.settings.proteinPerLb);
// Weekly weight change aims, as % of bodyweight: lean bulk slowly, cut 0.5–1% a week (Helms 2014; Iraki 2019).
// Slow gain (recomp toward size): hold steady or gain up to about 0.3% a week (Helms; Iraki 2019).
const GOALS = {
  slow: { name: 'Slow gain', lo: -0.1, hi: 0.3, aim: 'hold steady or gain up to about 0.3% of your weight a week' },
  bulk: { name: 'Lean bulk', lo: 0.1, hi: 0.5, aim: 'gain about 0.25% of your weight a week' },
  maintain: { name: 'Maintain', lo: -0.2, hi: 0.2, aim: 'hold steady' },
  cut: { name: 'Cut', lo: -1, hi: -0.5, aim: 'lose 0.5 to 1% of your weight a week' },
};
// The 7-day average is the number you see. The pace comes from a trend line through the last 3 weeks of
// weigh-ins (least squares), which daily water swings and an after-breakfast weigh-in barely move.
// It needs 6 weigh-ins spread over 10+ days.
function weightTrend(date) {
  const from = addDays(date, -20);
  const pts = Object.values(S.body).filter(b => b.weight != null && b.date >= from && b.date <= date).map(b => [daysBetween(from, b.date), +b.weight]);
  const cur = pts.filter(([x]) => x >= 14).map(p => p[1]);
  if (cur.length < 2) return null;
  const avg = sum(cur) / cur.length, out = { avg: round1(avg) };
  const xs = pts.map(p => p[0]);
  if (pts.length >= 6 && Math.max(...xs) - Math.min(...xs) >= 10) {
    const mx = sum(xs) / xs.length, my = sum(pts.map(p => p[1])) / pts.length;
    const slope = sum(pts.map(([x, y]) => (x - mx) * (y - my))) / sum(pts.map(([x]) => (x - mx) ** 2));
    out.rate = round1(slope * 7); out.pct = slope * 7 / avg * 100;
  }
  return out;
}
// Calorie advice only after the trend has been off target for two weeks running, so one odd week of
// weigh-ins never flips it.
function goalNote(t, date = todayStr()) {
  const g = GOALS[S.settings.goal] || GOALS.maintain, k = S.settings.goal;
  if (!t || t.pct == null) return `Goal: ${g.name}, ${g.aim}. ${Object.values(S.body).filter(b => b.weight != null).length >= 10 ? 'A few more morning weigh-ins and the trend shows here.' : 'Weigh in most mornings and the trend shows up in about two weeks.'}`;
  const side = x => (!x || x.pct == null ? 0 : x.pct > g.hi ? 1 : x.pct < g.lo ? -1 : 0);
  const now = side(t), before = side(weightTrend(addDays(date, -7)));
  if (now && now !== before) return `${now > 0 ? (k === 'cut' ? 'Losing a bit slower' : 'Gaining a bit faster') : (k === 'cut' ? 'Losing a bit faster' : k === 'slow' || k === 'bulk' ? 'Gaining a bit slower' : 'Drifting down a bit')} than your goal this week. Give it another week before changing anything.`;
  if (now > 0) return k === 'cut' ? 'Losing slower than planned for two weeks. About 200 fewer calories a day, or walk a bit more.'
    : k === 'bulk' || k === 'slow' ? 'Gaining faster than planned for two weeks, so some of it is likely fat. About 200 fewer calories a day.' : 'Creeping up for two weeks. About 200 fewer calories a day.';
  if (now < 0) return k === 'cut' ? 'Losing fast for two weeks, which can cost muscle. About 200 more calories a day.'
    : k === 'bulk' || k === 'slow' ? 'Losing weight for two weeks. Add about 200 calories a day, like a glass of milk.' : 'Drifting down for two weeks. Add about 200 calories a day.';
  return `On track for your ${g.name.toLowerCase()}. 👌`;
}
// Past days keep the target they had, so changing a setting never rewrites how a day went.
function proteinTargetFor(date) {
  const b = S.body[date];
  if (b && b.target && date < todayStr()) return b.target;
  return liveTarget(date);
}
// Protein follows your 7-day average weight, so a daily swing doesn't move it, or your latest weigh-in
// from the last 3 weeks. Older weigh-ins don't count: the fixed target stands in until you weigh in again.
function proteinWeight(date) {
  const ins = Object.values(S.body).filter(b => b.weight != null && b.date <= date && b.date >= addDays(date, -6));
  if (ins.length) return { lb: sum(ins.map(b => +b.weight)) / ins.length, n: ins.length, on: ins.length === 1 ? ins[0].date : null };
  const wi = latestWeighIn(date);
  return wi && wi.date >= addDays(date, -20) ? { lb: +wi.weight, n: 1, on: wi.date } : null;
}
function liveTarget(date) {
  if (S.settings.proteinMode === 'auto') {
    const pw = proteinWeight(date);
    if (pw) return Math.round(proteinBasisLb(pw.lb) * perLbFor());
  }
  return S.settings.proteinTarget;
}

// Saved foods: everything you've typed in. Starred ones stay as favorites.
const saveFoods = () => DB.put('kv', { k: 'foods', v: S.foods });
const findFood = name => S.foods.find(f => keyOf(f.name) === keyOf(name));
function rememberFood(name, g) {
  let f = findFood(name);
  if (!f) { f = { name, g, fav: false, used: 0 }; S.foods.push(f); }
  f.name = name; f.g = g; f.used++; f.last = Date.now();
  saveFoods();
}
function addFood(name, g, date = S.bodyDate) {
  const b = bodyEntry(date);
  b.items = [...b.items, { name, g, at: Date.now() }];
  saveBody(b);
  if (name) rememberFood(name, g);
  haptic();
  render();
}

function viewBody() {
  const date = S.bodyDate, today = todayStr();
  const b = bodyEntry(date);
  const target = proteinTargetFor(date);
  const pct = Math.min(100, (b.protein / target) * 100);
  const prevW = Object.values(S.body).filter(x => x.date < date && x.weight != null).sort((a, c) => c.date.localeCompare(a.date))[0];
  const diff = (b.weight != null && prevW) ? Math.round((b.weight - prevW.weight) * 10) / 10 : null;
  const left = target - b.protein;
  const pw = proteinWeight(date), plb = pw ? Math.round(proteinBasisLb(pw.lb)) : 0;
  const why = date < today && b.target ? `${b.target} g, what it was that day` : S.settings.proteinMode !== 'auto' ? 'Fixed target. Change it in More.'
    : pw ? `${perLbFor()} g × ${plb} lb${proteinBasisLb(pw.lb) !== pw.lb ? ' (weight at a BMI of 25 for your height)' : pw.n > 1 ? ' (your 7-day average weight)' : ' bodyweight'}${pw.on && pw.on !== date ? `, weighed ${esc(fmtDate(pw.on, { month: 'short', day: 'numeric' }))}` : ''}${S.settings.goal === 'cut' ? '. Higher on a cut to protect muscle' : ''}`
    : Object.values(S.body).some(x => x.weight != null) ? 'No weigh-in in 3 weeks, so this is your fixed target for now. Weigh in and it follows your weight again.' : 'Log your weight and the target follows it.';
  const trend = weightTrend(date);
  const wk7 = Array.from({ length: 7 }, (_, k) => addDays(date, k - 6));
  const creatineDays = wk7.filter(d => (S.body[d] || {}).creatine).length;

  const favs = S.foods.filter(f => f.fav).sort((a, c) => a.name.localeCompare(c.name));
  const recent = S.foods.filter(f => !f.fav).sort((a, c) => (c.last || 0) - (a.last || 0)).slice(0, 8);
  const foodBtn = f => `<div class="food">
      <button class="food-add" data-a="food-quick" data-n="${esc(f.name)}"><b>${esc(f.name)}</b><span>+${f.g} g</span></button>
      <button class="food-star ${f.fav ? 'on' : ''}" data-a="food-fav" data-n="${esc(f.name)}" aria-label="${f.fav ? 'Remove from favorites' : 'Add to favorites'}">${f.fav ? '★' : '☆'}</button>
    </div>`;
  const eaten = b.items.map((x, k) => `<div class="row">
      <div><b>${esc(x.name || 'Protein')}</b></div><span class="val">${x.g} g</span>
      <button class="icon-btn" data-a="item-rm" data-i="${k}" aria-label="Remove">${ic('x')}</button></div>`).join('');

  const weights = Object.values(S.body).filter(x => x.weight != null).sort((a, c) => a.date.localeCompare(c.date)).slice(-120);
  const days14 = Array.from({ length: 14 }, (_, k) => addDays(today, k - 13));
  const hits = days14.slice(-7).filter(d => bodyEntry(d).protein >= 0.9 * proteinTargetFor(d)).length;

  return `
    <header class="top"><h1>Body</h1></header>
    <div class="datebar">
      <button class="icon-btn" data-a="body-day" data-d="-1" aria-label="Previous day">${ic('left')}</button>
      <b>${date === today ? 'Today' : esc(fmtDate(date))}</b>
      <button class="icon-btn" data-a="body-day" data-d="1" aria-label="Next day" ${date >= today ? 'disabled' : ''}>${ic('right')}</button>
    </div>

    <div class="card">
      <label class="lbl" for="bw-inp">Bodyweight (lb)</label>
      <input class="inp" id="bw-inp" inputmode="decimal" value="${b.weight ?? ''}" placeholder="Tap to enter" style="font-size:24px;font-weight:700;min-height:60px">
      ${diff != null ? `<div class="sh-hint">${diff === 0 ? 'Same as' : diff > 0 ? `+${diff} lb since` : `${diff} lb since`} ${esc(fmtDate(prevW.date, { month: 'short', day: 'numeric' }))}</div>` : ''}
      ${trend ? `<div class="trend"><div><b>${trend.avg} lb</b><span>7-day average</span></div>
        ${trend.rate != null ? `<div><b>${trend.rate > 0 ? '+' : ''}${trend.rate} lb</b><span>a week, 3-week trend</span></div>` : ''}</div>` : ''}
      <div class="sh-hint">${esc(goalNote(trend, date))} <button class="linkbtn inline" data-a="go-goal">Change goal</button></div>
    </div>

    <div class="card">
      <label class="lbl">Protein</label>
      <div class="prot-row"><div class="big-num">${b.protein}<small> / ${target} g</small></div>
        <div class="prot-left ${left > 0 ? '' : 'hit'}">${left > 0 ? `<b>${left} g</b><span>${date === today ? 'left to eat' : 'short'}</span>` : `<b>Hit</b><span>${left < 0 ? `${-left} g over` : 'right on'}</span>`}</div></div>
      <div class="prog ${b.protein >= target ? 'hit' : ''}"><div style="width:${pct}%"></div></div>
      ${date === today ? proteinSayHTML(proteinCoach(date)) : `<div class="muted small" style="margin-top:-6px">${left > 0 ? `${left} g short that day` : 'Target hit.'}</div>`}
      <div class="sh-hint">Target: ${why}</div>
    </div>

    <div class="card" id="food-card">
      <label class="lbl" for="food-name">Add what you ate <span class="muted">· ${b.protein} / ${target} g</span></label>
      <div class="food-form">
        <input class="inp" id="food-name" placeholder="e.g. 3 eggs" autocomplete="off">
        <input class="inp" id="food-g" inputmode="numeric" placeholder="g">
      </div>
      <button class="btn pri block" style="margin-top:8px" data-a="food-form">Add protein</button>
      ${favs.length ? `<label class="lbl">Favorites</label>${favs.map(foodBtn).join('')}` : ''}
      ${recent.length ? `<label class="lbl">Recent</label>${recent.map(foodBtn).join('')}<div class="sh-hint">Tap ☆ to keep one as a favorite.</div>` : ''}
    </div>

    ${S.settings.creatine ? `<div class="card"><div class="rem-row">
        <div><b>Creatine, 3 to 5 g</b><small>${creatineDays} of the last 7 days. Any time works, daily is what counts.</small></div>
        <button class="toggle ${b.creatine ? 'on' : ''}" data-a="creatine">${b.creatine ? 'Took it' : 'Not yet'}</button>
      </div></div>` : ''}

    ${eaten ? `<h2>Eaten ${date === today ? 'today' : 'this day'}</h2><div class="card flush">${eaten}</div>` : ''}

    <h2>Protein · last 14 days</h2>
    <div class="card">
      ${barChart(days14.map(d => ({ label: parseYmd(d).getDate(), y: bodyEntry(d).protein, t: proteinTargetFor(d) })), proteinTargetFor(today))}
      <div class="muted small" style="margin-top:6px">Target hit on ${hits} of the last 7 days.</div>
    </div>

    <h2>Bodyweight trend</h2>
    <div class="card">${weights.length
      ? lineChart([
        { name: 'Weigh-ins', color: 'var(--dim)', pts: weights.map(x => [parseYmd(x.date).getTime(), x.weight]) },
        { name: '7-day average', color: 'var(--acc)', pts: weights.map(x => [parseYmd(x.date).getTime(), weightTrend(x.date)?.avg ?? x.weight]) },
      ])
      : '<div class="empty" style="padding:16px">Log your weight a few mornings to see the trend.</div>'}</div>
    ${measureCard(date)}
    ${photoCard()}`;
}

// Monthly measurements: weight alone hides building muscle while losing fat.
const MEASURES = [['waist', 'Waist', 'At your belly button'], ['chest', 'Chest', 'Across the nipples'], ['arm', 'Arms', 'Biggest part, flexed'], ['thigh', 'Thighs', 'Biggest part']];
function measureHistory() {
  return Object.values(S.body).filter(b => b.meas && Object.values(b.meas).some(v => v)).sort((a, c) => a.date.localeCompare(c.date));
}
function measureCard(date) {
  const hist = measureHistory(), first = hist[0], last = hist[hist.length - 1];
  const due = !last || daysBetween(last.date, todayStr()) >= 28;
  const rows = last ? MEASURES.map(([k, n]) => {
    const v = last.meas[k], f = first.meas[k], d = v && f && first !== last ? round1(v - f) : null;
    return v ? `<div class="row"><div><b>${n}</b></div><span class="val">${v}″${d ? ` <small class="${(k === 'waist') === (d < 0) ? 'good' : 'muted'}">${d > 0 ? '+' : ''}${d}</small>` : ''}</span></div>` : '';
  }).join('') : '';
  return `<h2>Measurements</h2>
    <div class="card ${rows ? 'flush' : ''}">
      ${rows || '<div class="muted" style="margin:0 2px 12px">Measure once a month: waist, chest, arms, and thighs.</div>'}
      <div ${rows ? 'style="padding:12px 16px 14px"' : ''}>
        <button class="btn ${due ? 'pri' : ''} block" data-a="meas-open" data-d="${date}">${due ? 'Time to measure' : 'Measure again'}</button>
        <div class="sh-hint">${last ? `Last measured ${esc(fmtDate(last.date, { month: 'short', day: 'numeric' }))}${first !== last ? `. Changes are since ${esc(fmtDate(first.date, { month: 'short', day: 'numeric' }))}` : ''}.` : 'Measure in the morning, relaxed, at the same spots each time.'}</div>
      </div>
    </div>`;
}
function measSheetHTML() {
  const b = bodyEntry(S.sheet.date), m = b.meas || {};
  return `<div class="sh-grip"></div>
    <div class="sh-title">Measurements<span>${esc(fmtDate(S.sheet.date))} · inches · morning, relaxed</span></div>
    ${MEASURES.map(([k, n, tip]) => `<label class="lbl" for="meas-${k}">${n} <small class="muted">· ${tip}</small></label>
      <input class="inp" id="meas-${k}" inputmode="decimal" value="${m[k] ?? ''}" placeholder="0.0">`).join('')}
    <div class="sheet-actions">
      <button class="btn pri block big" data-a="meas-save">Save</button>
      <button class="btn ghost block" data-a="sheet-close">Cancel</button>
    </div>`;
}

// Progress photos stay in this phone's storage (not in backups), shrunk to about 1280 px.
const photoUrls = new Map();
const photoUrl = p => { if (!photoUrls.has(p.id)) photoUrls.set(p.id, URL.createObjectURL(p.blob)); return photoUrls.get(p.id); };
const POSES = [['front', 'Front'], ['side', 'Side'], ['back', 'Back'], ['flex', 'Flex']];
const poseName = p => (POSES.find(x => x[0] === p.pose) || [])[1] || '';
const phDate = (d, o = {}) => fmtDate(d, { month: 'short', day: 'numeric', ...(d.slice(0, 4) !== todayStr().slice(0, 4) || o.year ? { year: 'numeric' } : {}) });
const photoThumb = (p, a, extra = '') => `<button data-a="${a}" data-id="${p.id}"${extra} aria-label="Photo from ${esc(fmtDate(p.date))}"><img src="${photoUrl(p)}" alt="" loading="lazy">${poseName(p) ? `<span>${poseName(p)}</span>` : ''}</button>`;
// Photos grouped by day, newest first; the newest three days show, the rest fold away.
function photoCard() {
  const ps = [...S.photos].sort((a, c) => c.date.localeCompare(a.date) || a.at - c.at);
  const days = [...new Set(ps.map(p => p.date))], shown = S.photoAll ? days : days.slice(0, 3);
  const due = !ps.length || ps[0].date <= addDays(todayStr(), -85);
  return `<h2>Progress photos</h2>
    <div class="card">
      ${shown.map(d => {
        const g = ps.filter(p => p.date === d), pumped = g.every(p => p.pumped);
        return `<div class="ph-day"><b>${esc(phDate(d))}</b><small>${g.length} photo${g.length > 1 ? 's' : ''}</small>
          <button class="ph-pump ${pumped ? 'on' : ''}" data-a="photo-day-pump" data-d="${d}" aria-pressed="${pumped}">${pumped ? 'Pumped' : 'Pumped?'}</button></div>
        <div class="photos">${g.map(p => photoThumb(p, 'photo-open')).join('')}</div>`;
      }).join('')}
      ${days.length > 3 ? `<button class="btn ghost block" data-a="photo-all">${S.photoAll ? 'Show fewer' : `Show all ${days.length} days`}</button>` : ''}
      <div class="add-row" style="grid-template-columns:repeat(${days.length > 1 ? 2 : 1},1fr);margin-top:4px">
        <button class="btn ${due ? 'pri' : ''}" data-a="photo-add">${ps.length && due ? '+ Time for new photos' : '+ Add photos'}</button>
        ${days.length > 1 ? '<button class="btn" data-a="pcmp-open">Compare</button>' : ''}
      </div>
      <div class="sh-hint">Pick several at once. Same spot, same light, before you eat is fairest. Tap “Pumped?” on a day you took them after a workout. Photos stay on this phone and aren't in backups.</div>
    </div>`;
}
function photoSheetHTML() {
  const p = S.photos.find(x => x.id === S.sheet.id);
  if (!p) return '';
  const others = S.photos.some(x => x.date !== p.date);
  return `<div class="sh-grip"></div>
    <div class="sh-title">${esc(fmtDate(p.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</div>
    <div class="photo-view"><figure><img src="${photoUrl(p)}" alt="Progress photo"></figure></div>
    <div class="lbl">Pose</div>
    <div class="seg">${POSES.map(([k, n]) => `<button class="${p.pose === k ? 'on' : ''}" data-a="photo-pose" data-v="${k}">${n}</button>`).join('')}</div>
    <div class="alt-row pick-row" style="margin-top:8px"><button class="chip ${p.pumped ? 'on' : ''}" data-a="photo-pump">${p.pumped ? 'Pumped (after a workout)' : 'Not pumped'}</button></div>
    <div class="sheet-actions">
      ${others ? `<button class="btn pri block" data-a="pcmp-open" data-id="${p.id}">Compare with another day</button>` : ''}
      <button class="btn danger block" data-a="photo-del">Delete photo</button>
      <button class="btn ghost block" data-a="sheet-close">Close</button>
    </div>`;
}
// Compare: any two photos, as a slider (drag to wipe between them) or side by side, with your weight
// and tape from each date. It starts on the same pose from your earliest day.
function pcmpPick(bId) {
  const asc = [...S.photos].sort((a, c) => a.date.localeCompare(c.date) || a.at - c.at);
  const b = asc.find(p => p.id === bId) || asc[asc.length - 1];
  const older = asc.filter(p => p.date !== b.date);
  const a = (b.pose && older.find(p => p.pose === b.pose)) || older.find(p => !!p.pumped === !!b.pumped) || older[0];
  return { a: a && a.id, b: b && b.id };
}
// Each picker row scrolls to the photo picked in it.
const pcStripFocus = () => document.querySelectorAll('.pc-strip').forEach(el => { const b = el.querySelector('.on'); if (b) el.scrollLeft += b.getBoundingClientRect().left - el.getBoundingClientRect().left - (el.clientWidth - b.offsetWidth) / 2; });
function measOn(date) {
  const h = measureHistory().filter(m => m.date <= addDays(date, 7));
  return h.length ? h[h.length - 1] : null;
}
function pcmpSheetHTML() {
  const sh = S.sheet, asc = [...S.photos].sort((a, c) => a.date.localeCompare(c.date) || a.at - c.at);
  const A = asc.find(p => p.id === sh.a), B = asc.find(p => p.id === sh.b);
  if (!A || !B) return '<div class="sh-title">Compare photos</div><div class="sh-hint">Add photos on two different days to compare them.</div>';
  const [o, n] = A.date <= B.date ? [A, B] : [B, A];
  const gap = daysBetween(o.date, n.date), gapTxt = gap < 14 ? `${gap} day${gap === 1 ? '' : 's'}` : gap < 70 ? `${Math.round(gap / 7)} weeks` : `${Math.round(gap / 30.4)} months`;
  const wt = d => { const t = weightTrend(d); if (t) return t.avg; const b = Object.values(S.body).filter(x => x.weight != null && x.date <= d && x.date >= addDays(d, -10)).sort((x, y) => y.date.localeCompare(x.date))[0]; return b ? +b.weight : null; };
  const mo = measOn(o.date), mn = measOn(n.date), same = mo && mn && mo.date === mn.date;
  const rows = [['Weight', wt(o.date), wt(n.date), ' lb', 'up'], ...(same ? [] : [['Chest', 'chest', '', '″', 'up'], ['Arms', 'arm', '', '″', 'up'], ['Waist', 'waist', '', '″', 'down']].map(([nm, k, , u, dir]) => [nm, mo && mo.meas[k], mn && mn.meas[k], u, dir]))]
    .filter(r => r[1] != null && r[2] != null).map(([nm, x, y, u, dir]) => {
      const d = round1(y - x), good = d === 0 ? '' : (d > 0) === (dir === 'up') ? 'good' : 'bad';
      return `<tr><th>${nm}</th><td>${round1(x)}${u}</td><td>${round1(y)}${u}</td><td class="cmp-d ${good}">${d === 0 ? '—' : `${d > 0 ? '+' : ''}${d}${u}`}</td></tr>`;
    }).join('');
  const cap = p => `${esc(phDate(p.date, { year: 1 }))}${poseName(p) ? ` · ${poseName(p)}` : ''}${p.pumped ? ' · pumped' : ''}`;
  const strip = side => `<div class="pc-strip">${asc.map(p => photoThumb(p, 'pcmp-pick', ` data-side="${side}" class="${sh[side] === p.id ? 'on' : ''}"`).replace('</button>', `<em>${esc(fmtDate(p.date, { month: 'short', day: 'numeric' }))}</em></button>`)).join('')}</div>`;
  const slide = sh.mode !== 'side';
  return `<div class="sh-grip"></div>
    <div class="sh-title">Compare photos</div>
    <div class="seg"><button class="${slide ? 'on' : ''}" data-a="pcmp-mode" data-v="slide">Slider</button><button class="${slide ? '' : 'on'}" data-a="pcmp-mode" data-v="side">Side by side</button></div>
    ${slide ? `<div class="pc-slide" id="pc-slide" style="--x:${sh.x ?? 50}%">
        <img src="${photoUrl(o)}" alt="Earlier photo"><img class="top" src="${photoUrl(n)}" alt="Later photo">
        <div class="pc-line"><i></i></div><span class="pc-tag l">${esc(phDate(o.date))}</span><span class="pc-tag r">${esc(phDate(n.date))}</span>
      </div>
      <div class="sh-hint center">Drag across the photo to wipe between them.</div>`
    : `<div class="photo-view two"><figure><img src="${photoUrl(o)}" alt="Earlier photo"><figcaption>${cap(o)}</figcaption></figure><figure><img src="${photoUrl(n)}" alt="Later photo"><figcaption>${cap(n)}</figcaption></figure></div>`}
    <p class="ol-insp-est"><b>${gapTxt}</b> apart${slide ? ` · ${cap(o)} → ${cap(n)}` : ''}.</p>
    ${!!o.pumped !== !!n.pumped ? `<div class="sh-hint warn">Only the ${o.pumped ? 'earlier' : 'later'} one is pumped, so it looks bigger than it really is.</div>` : ''}
    ${o.pose && n.pose && o.pose !== n.pose ? '<div class="sh-hint warn">Different poses. Pick the same pose for a fair look.</div>' : ''}
    ${rows ? `<table class="ol-tgt"><thead><tr><th></th><th>${esc(phDate(o.date))}</th><th>${esc(phDate(n.date))}</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <div class="lbl" style="margin-top:12px">First photo</div>${strip('a')}
    <div class="lbl">Second photo</div>${strip('b')}
    <div class="sheet-actions"><button class="btn ghost block" data-a="sheet-close">Close</button></div>`;
}
function shrinkPhoto(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? res(b) : rej(new Error('Could not read that photo'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that photo')); };
    img.src = url;
  });
}

// ----- Stats -----
function viewStats() {
  const today = todayStr();
  const ws = weekStart(today);
  const planned = plannedKeys();
  const need = planned.length;
  const doneNow = new Set(weekDoneKeys(ws));
  const dots = DAYS.map(d => {
    const dd = addDays(ws, DAYS.indexOf(d)), rest = planOn(dd).type === 'rest', did = doneNow.has(d) || S.workouts.some(x => x.date === dd && hasWork(x));
    const cls = [did ? 'done' : '', rest ? 'rest' : '', d === dayKeyOf(today) ? 'today' : ''].join(' ');
    return `<div class="wd ${cls}"><i>${did ? ic('check') : ''}</i>${DAY_SHORT[d]}</div>`;
  }).join('');

  const worked = S.workouts.filter(hasWork);
  if (!worked.length) {
    return `<header class="top"><h1>Stats</h1></header>
      ${streakCard()}
      <div class="card"><b>This week</b><div class="week-dots">${dots}</div></div>
      <div class="card empty"><b>No sessions yet</b>Log your first set or activity and your weekly numbers show up here.</div>`;
  }
  const firstWeek = weekStart(worked.map(w => w.date).sort()[0]);
  const weeks = [];
  for (let wk = firstWeek; wk <= ws; wk = addDays(wk, 7)) weeks.push({ wk, n: weekDoneCount(wk) });
  const full = x => need > 0 && x.n >= need;
  // Current streak: full weeks in a row, counting this week only once it is full.
  let streak = 0;
  for (let k = weeks.length - 1; k >= 0; k--) {
    if (full(weeks[k])) streak++;
    else if (k === weeks.length - 1) continue;
    else break;
  }
  let best = 0, run = 0;
  weeks.forEach(x => { run = full(x) ? run + 1 : 0; best = Math.max(best, run); });
  const past = weeks.slice(0, -1).slice(-12);
  const consistency = past.length && need ? Math.round(sum(past.map(x => Math.min(x.n, need))) / (past.length * need) * 100) : null;

  const end = addDays(ws, 6);
  const thisWeek = S.workouts.filter(w => w.date >= ws && w.date <= end);
  const setsWeek = sum(thisWeek.map(w => sum((w.exercises || []).map(e => doneSets(e).length))));
  const cardioMin = Math.round(sum(thisWeek.map(w => sum((w.activities || []).map(actMinutes)))));
  const soFar = Array.from({ length: 7 }, (_, k) => addDays(ws, k)).filter(d => d <= today);
  const protHits = soFar.filter(d => bodyEntry(d).protein >= 0.9 * proteinTargetFor(d)).length;
  const kcalWeek = sum(thisWeek.map(w => workoutKcal(w) || 0));
  const milesWeek = sum(thisWeek.flatMap(w => (w.activities || []).map(a => ((a.type === 'walk' || a.type === 'run' || a.kind === 'hike') && +a.dist) || 0)));
  const yogaWeek = thisWeek.flatMap(w => (w.activities || []).filter(a => a.type === 'yoga')).length;

  const rows = weeks.slice(-12).reverse().map(x => `
    <div class="wk ${full(x) ? 'full' : ''}">
      <span>${esc(fmtDate(x.wk, { month: 'short', day: 'numeric' }))}</span>
      <div class="wk-bar">${Array.from({ length: need }, (_, k) => `<i class="${k < x.n ? 'on' : ''}"></i>`).join('')}</div>
      <span>${x.n}/${need}</span>
    </div>`).join('');

  return `<header class="top"><h1>Stats</h1></header>
    ${levelsCard()}
    ${streakCard()}
    ${S.workouts.some(hasWork) ? `<button class="card cmp-entry" data-a="cmp-open">${ic('chart')}<div><b>Months and years</b><small>Compare any two months or years, with graphs</small></div>${ic('chev')}</button>` : ''}
    <div class="card">
      <b>This week</b> <span class="muted">· ${weekDoneCount(ws)} of ${need} planned sessions</span>
      <div class="week-dots">${dots}</div>
    </div>
    <div class="card streak">
      <div class="big-num">${streak}</div>
      <div><b>full week${streak === 1 ? '' : 's'} in a row</b><div class="muted small">with every planned session done · best ${best}</div></div>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${setsWeek}</b><span>sets this week</span></div>
      <div class="kpi"><b>${cardioMin}</b><span>active min (not lifting)</span></div>
      <div class="kpi"><b>${protHits}/${soFar.length}</b><span>protein goal days</span></div>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${kcalWeek ? kcalWeek.toLocaleString() : '—'}</b><span>est. active calories</span></div>
      <div class="kpi"><b>${round1(milesWeek)}</b><span>miles on foot</span></div>
      <div class="kpi"><b>${yogaWeek}</b><span>yoga classes</span></div>
    </div>
    <div class="kpis"${S.settings.creatine ? ' style="grid-template-columns:repeat(2,1fr)"' : ' style="grid-template-columns:1fr"'}>
      <div class="kpi"><b>${soFar.filter(d => (S.body[d] || {}).weight != null).length}/${soFar.length}</b><span>weigh-in days</span></div>
      ${S.settings.creatine ? `<div class="kpi"><b>${soFar.filter(d => (S.body[d] || {}).creatine).length}/${soFar.length}</b><span>creatine days</span></div>` : ''}
    </div>
    ${volumeCard(ws)}
    ${yogaStatsCard()}
    ${recordsCard()}
    <h2>Weekly consistency${consistency != null ? ` · ${consistency}%` : ''}</h2>
    <div class="card">${rows}</div>
    <div class="foot">${worked.length} sessions logged in total. Weeks start on Monday. Calories are active calories (on top of what you'd burn resting), the way a watch counts them, estimated from your weight and the 2024 Compendium of Physical Activities.</div>`;
}

function volumeCard(ws) {
  const v = weeklyVolume(ws);
  const max = Math.max(12, ...v.map(x => Math.max(x.planned, x.done)));
  const low = v.filter(x => x.planned < x.goal);
  return `<h2>Sets per muscle each week</h2>
    <div class="card vol">
      ${v.map(x => `<div class="vol-row">
        <span>${x.name}</span>
        <div class="vol-bar"><i class="plan" style="width:${x.planned / max * 100}%"></i><i class="done" style="width:${Math.min(x.done, x.planned || x.done) / max * 100}%"></i><b style="left:${x.goal / max * 100}%"></b></div>
        <span class="vol-n ${x.planned < x.goal ? 'low' : ''}">${Math.round(x.done)}/${Math.round(x.planned)}</span>
      </div>`).join('')}
      <div class="sh-hint">Sets done this week out of planned. The tick is the weekly goal: 10 sets for big muscles, 6 for smaller ones.${low.length ? ` Under it in your program: ${low.map(x => x.name.toLowerCase()).join(', ')}. Add a set to a lift that works it in More → Program.` : ''} Big helpers count as half a set (a bench set is ½ triceps).</div>
    </div>`;
}

function yogaStatsCard() {
  const hist = yogaHistory().filter(h => h.date >= addDays(todayStr(), -27));
  const count = c => hist.filter(h => h.style === c.style && h.min === c.min).length;
  const rd = yogaReadiness();
  const beginner = S.settings.yogaLevel === 'beginner';
  return `<h2>Yoga · last 4 weeks</h2>
    <div class="card flush">
      ${YOGA_CLASSES.map(c => `<div class="row"><div><b>${c.name}</b><small>${c.len}</small></div><span class="val">${count(c)}</span></div>`).join('')}
    </div>
    <div class="card">
      <b>${beginner ? 'Beginner' : 'Intermediate'} level</b>
      ${beginner ? `<div class="prog"><div style="width:${Math.min(100, rd.count / rd.need * 100)}%"></div></div>
      <div class="muted small">${rd.count} of ${rd.need} beginner classes. Once you're there and most classes feel easy, Lift Log suggests trying intermediate. ${rd.easy} of your last rated classes felt easy.</div>`
      : '<div class="muted small">Rate each class Easy, Just right, or Hard, and the picks keep adjusting.</div>'}
    </div>`;
}
// Your most-done lifts, each with its best estimated one-rep max.
function liftBests(from, to, n = 6) {
  const m = new Map();
  for (const w of S.workouts) {
    if ((from && w.date < from) || (to && w.date > to)) continue;
    for (const e of w.exercises || []) {
      const sets = doneSets(e).filter(x => +x.w > 0 && +x.r > 0);
      if (!sets.length || isPin(e)) continue;
      const best = Math.round(Math.max(...sets.map(x => e1rm(+x.w, +x.r))));
      const o = m.get(e.key) || { key: e.key, name: e.name, n: 0, e1: 0, date: w.date };
      o.n++;
      if (best > o.e1) { o.e1 = best; o.date = w.date; }
      m.set(e.key, o);
    }
  }
  return [...m.values()].sort((a, b) => b.n - a.n).slice(0, n);
}
function recordsCard() {
  const r = cardioRecords(), lifts = liftBests(null, null);
  if (!r.longRun && !r.longWalk && !r.longHike && !lifts.length) return '';
  const row = (label, val, date) => `<div class="row"><div><b>${label}</b><small>${esc(fmtDate(date, { month: 'short', day: 'numeric', year: 'numeric' }))}</small></div><span class="val">${val}</span></div>`;
  return `<h2>Records</h2><div class="card flush">
    ${lifts.map(l => `<button class="row" data-a="ex-chart" data-key="${esc(l.key)}"><div><b>${esc(l.name)}</b><small>Best est. 1RM · ${esc(fmtDate(l.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</small></div><span class="val">${l.e1} lb</span>${ic('chev')}</button>`).join('')}
    ${r.longRun ? row('Longest run', `${r.longRun.dist} mi`, r.longRun.date) : ''}
    ${r.fastRun ? row('Fastest run pace', `${fmtPace(r.fastRun.pace)} /mi`, r.fastRun.date) : ''}
    ${r.longWalk ? row('Longest walk', `${r.longWalk.dist} mi`, r.longWalk.date) : ''}
    ${r.longHike ? row('Longest hike', `${r.longHike.dist} mi`, r.longHike.date) : ''}
  </div>`;
}

// ----- Months and years -----
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodName = (k, short) => (k.length === 4 ? k : `${MONTH_SHORT[+k.slice(5) - 1]}${short ? ` ’${k.slice(2, 4)}` : ` ${k.slice(0, 4)}`}`);
const periodRange = k => (k.length === 4 ? [`${k}-01-01`, `${k}-12-31`] : [`${k}-01`, `${k}-31`]);
// Every month (or year) from your first log to now, oldest first.
function periodKeys(mode) {
  const first = S.workouts.filter(hasWork).map(w => w.date).sort()[0] || todayStr();
  const out = [], end = todayStr();
  if (mode === 'year') { for (let y = +first.slice(0, 4); y <= +end.slice(0, 4); y++) out.push(String(y)); return out; }
  let [y, m] = first.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad(m)}`); if (++m > 12) { m = 1; y++; } }
  return out;
}
function periodStats(k) {
  const [from, to] = periodRange(k);
  const ws = S.workouts.filter(w => w.date >= from && w.date <= to && hasWork(w));
  const acts = ws.flatMap(w => (w.activities || []).filter(actDone));
  const runs = acts.filter(a => a.type === 'run' && paceOf(a));
  const sets = ws.flatMap(w => (w.exercises || []).flatMap(doneSets));
  const weights = Object.values(S.body).filter(b => b.date >= from && b.date <= to && b.weight != null).map(b => +b.weight);
  return {
    workouts: new Set(ws.map(w => w.date)).size,
    liftDays: new Set(ws.filter(w => (w.exercises || []).some(e => doneSets(e).length)).map(w => w.date)).size,
    sets: sets.length,
    volume: Math.round(sum(sets.map(x => (+x.w || 0) * (+x.r || 0)))),
    miles: round1(sum(acts.filter(a => a.type === 'run' || a.type === 'walk' || a.kind === 'hike').map(a => +a.dist || 0))),
    cardioMin: Math.round(sum(acts.filter(a => a.type !== 'yoga').map(actMinutes)) + sum(acts.filter(a => a.type === 'yoga').map(a => +a.min || 0))),
    pace: runs.filter(a => +a.dist >= 1).length ? Math.min(...runs.filter(a => +a.dist >= 1).map(paceOf)) : null,
    weight: weights.length ? round1(sum(weights) / weights.length) : null,
    from, to,
  };
}
const CMP_METRICS = [
  ['workouts', 'Workouts', v => v],
  ['sets', 'Sets', v => v],
  ['volume', 'Weight lifted', v => (v >= 1000 ? `${round1(v / 1000)}k lb` : `${v} lb`)],
  ['miles', 'Miles', v => `${v} mi`],
];
function viewCompare() {
  const v = S.view, mode = v.mode || 'month', metric = CMP_METRICS.find(m => m[0] === (v.metric || 'workouts'));
  const keys = periodKeys(mode), cur = keys[keys.length - 1];
  const a = keys.includes(v.a) ? v.a : cur;
  const lastYear = mode === 'month' ? `${+a.slice(0, 4) - 1}${a.slice(4)}` : null;
  const b = keys.includes(v.b) ? v.b : (lastYear && keys.includes(lastYear) ? lastYear : keys[keys.indexOf(a) - 1] || a);
  const shown = keys.slice(mode === 'month' ? -12 : -6);
  const stats = Object.fromEntries([...new Set([...shown, a, b])].map(k => [k, periodStats(k)]));
  const items = shown.map(k => ({ k, y: stats[k][metric[0]] }));
  const max = Math.max(1, ...items.map(i => i.y));
  const bars = `<div class="cmp-bars">${items.map(i => `<button class="cmp-bar ${i.k === a ? 'a' : i.k === b ? 'b' : ''}" data-a="cmp-pick" data-k="${i.k}" aria-label="${esc(periodName(i.k))}: ${esc(String(metric[2](i.y)))}">
      <span class="cmp-val">${i.y ? esc(String(metric[2](i.y))).replace(' lb', '').replace(' mi', '') : ''}</span>
      <i style="height:${Math.max(i.y ? 4 : 0, i.y / max * 100)}%"></i>
      <span class="cmp-lab">${mode === 'month' ? MONTH_SHORT[+i.k.slice(5) - 1].slice(0, 1) : `’${i.k.slice(2)}`}</span></button>`).join('')}</div>`;
  const sa = stats[a], sb = stats[b];
  const delta = (x, y, better = 1) => {
    if (x == null || y == null || x === y) return '<span class="cmp-d">—</span>';
    const up = x > y, good = better > 0 ? up : !up;
    return `<span class="cmp-d ${good ? 'good' : 'bad'}">${up ? '▲' : '▼'}</span>`;
  };
  const row = (label, x, y, fmt, better) => `<tr><td>${label}</td><td>${x == null ? '—' : esc(String(fmt(x)))}</td><td>${y == null ? '—' : esc(String(fmt(y)))}</td><td>${delta(x, y, better)}</td></tr>`;
  const opts = sel => keys.slice().reverse().map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(periodName(k))}</option>`).join('');
  const la = liftBests(sa.from, sa.to, 20), lb = liftBests(sb.from, sb.to, 20);
  const lifts = liftBests(null, null, 8).map(l => ({ name: l.name, x: (la.find(z => z.key === l.key) || {}).e1, y: (lb.find(z => z.key === l.key) || {}).e1 })).filter(l => l.x || l.y);
  return `<button class="backbtn" data-a="back">${ic('back')} Stats</button>
    <header class="top"><h1>Months and years</h1></header>
    <div class="seg"><button class="${mode === 'month' ? 'on' : ''}" data-a="cmp-mode" data-v="month">Months</button><button class="${mode === 'year' ? 'on' : ''}" data-a="cmp-mode" data-v="year">Years</button></div>
    <div class="alt-row pick-row">${CMP_METRICS.map(m => `<button class="chip ${m === metric ? 'on' : ''}" data-a="cmp-metric" data-v="${m[0]}">${m[1]}</button>`).join('')}</div>
    <div class="card">
      <div class="cmp-head"><b>${metric[1]} by ${mode}</b><span class="muted small">Tap a bar to compare it</span></div>
      ${bars}
      <div class="legend"><span><i style="background:var(--acc)"></i>${esc(periodName(a))}</span><span><i style="background:#7cc4ff"></i>${esc(periodName(b))}</span></div>
    </div>
    <h2>Compare</h2>
    <div class="card">
      <div class="cmp-pickers">
        <select class="inp cmp-sel a" data-cmp="a" aria-label="First ${mode}">${opts(a)}</select>
        <span class="muted">vs</span>
        <select class="inp cmp-sel b" data-cmp="b" aria-label="Second ${mode}">${opts(b)}</select>
      </div>
      <table class="cmp-table">
        ${row('Workouts', sa.workouts, sb.workouts, x => x, 1)}
        ${row('Lifting days', sa.liftDays, sb.liftDays, x => x, 1)}
        ${row('Sets', sa.sets, sb.sets, x => x, 1)}
        ${row('Weight lifted', sa.volume, sb.volume, x => (x >= 1000 ? `${round1(x / 1000)}k` : x), 1)}
        ${row('Miles on foot', sa.miles, sb.miles, x => x, 1)}
        ${row('Cardio and yoga', sa.cardioMin, sb.cardioMin, x => `${x} min`, 1)}
        ${row('Fastest mile pace', sa.pace, sb.pace, fmtPace, -1)}
        ${row('Average weight', sa.weight, sb.weight, x => `${x} lb`, 0)}
      </table>
      <div class="sh-hint">Weight lifted is every logged set's weight × reps. Average weight has no arrow color, since up or down depends on your goal.</div>
    </div>
    ${lifts.length ? `<h2>Strongest lifts</h2><div class="card">
      <table class="cmp-table">
        <tr class="cmp-th"><td>Best est. 1RM</td><td>${esc(periodName(a, true))}</td><td>${esc(periodName(b, true))}</td><td></td></tr>
        ${lifts.map(l => row(esc(l.name), l.x ?? null, l.y ?? null, x => x, 1)).join('')}
      </table>
      <div class="sh-hint">— means you didn't do that lift then. Tap Records on Stats for each lift's full chart.</div></div>` : ''}`;
}

// ----- More (program + settings) -----
function viewMore() {
  const standalone = isStandalone();
  const typeName = { strength: 'Lifting', cardio: 'Cardio/yoga', rest: 'Rest' };
  const days = DAYS.map(d => {
    const day = S.program.days[d];
    const n = day.type === 'strength' ? sum((day.groups || []).map(g => g.length)) : 0;
    return `<button class="row" data-a="prog-open" data-d="${d}">
      <div><b>${DAY_NAMES[d]}</b><small>${esc(day.label)} · ${typeName[day.type]}${day.type === 'strength' ? ` · ${n} exercises` : ''}</small></div>${ic('chev')}</button>`;
  }).join('');
  const lb = S.settings.lastBackup;
  return `<header class="top"><h1>More</h1></header>
    ${standalone ? '' : `<div class="card tip"><b>Install it:</b> in Safari, tap Share → Add to Home Screen, then always open Lift Log from that icon. The icon and Safari keep separate data on iPhone.</div>`}
    <h2>Program</h2>
    <div class="card flush">${days}</div>
    <h2>Your other workouts</h2>
    ${S.program.custom.length ? `<div class="card flush">${S.program.custom.map(c => `<button class="row" data-a="prog-open" data-d="${c.id}">
      <div><b>${esc(c.label)}</b><small>${plural(sum((c.groups || []).map(g => g.length)), 'exercise')}</small></div>${ic('chev')}</button>`).join('')}</div>` : ''}
    <button class="btn block" data-a="plan-new">+ New workout</button>
    <div class="sh-hint">Extra lifting workouts you can do any day: tap "Different workout" on Today.</div>
    ${profileCard()}
    ${goalCard()}

    <h2>Rest timer</h2>
    <div class="card">
      <div class="stepper three">
        <button class="st-btn" data-a="set-rest" data-d="-15">−15</button>
        <div class="st-inp" style="display:grid;place-items:center">${fmtClock(S.settings.restSec)}</div>
        <button class="st-btn" data-a="set-rest" data-d="15">+15</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ${S.settings.sound ? 'pri' : ''}" data-a="set-sound">${S.settings.sound ? 'Beep on' : 'Beep off'}</button>
        <button class="btn" data-a="test-timer">Test (5 sec)</button>
      </div>
      <div class="rem-row" style="margin-top:14px">
        <div><b>Smart rest</b><small>Big lifts like presses, rows, and squats get ${fmtClock(Math.max(S.settings.restSec, 150))} (${fmtClock(Math.max(S.settings.restSec, 180))} at 8 reps or fewer). Smaller lifts like curls and raises use the time above.</small></div>
        <button class="toggle ${S.settings.smartRest ? 'on' : ''}" data-a="smart-rest">${S.settings.smartRest ? 'On' : 'Off'}</button>
      </div>
      <div class="sh-hint">Pops up in the top corner after each set. Partway through a superset round it counts up instead. iPhone doesn't let web apps vibrate, so it beeps and flashes the screen. Keep the app open and your ringer on to hear it.</div>
    </div>

    ${proteinCard()}
    ${reminderCard()}
    ${trainerSettingsCard()}

    <h2>Backup</h2>
    <div class="card">
      <button class="btn pri block" data-a="export">Save a backup</button>
      <button class="btn block" data-a="import">Import backup</button>
      <div class="sh-hint">${lb ? `Last backup: ${esc(new Date(lb).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}.` : 'No backup saved yet.'} Everything lives only on this phone, so save a backup now and then to iCloud Drive or Files.</div>
      <div class="sh-hint">${S.persisted === true ? 'iPhone will keep your data safe on this device.' : S.persisted === false ? 'Add Lift Log to your Home Screen so iPhone is less likely to clear your data.' : ''}</div>
    </div>

    <h2>App version</h2>
    <div class="card"><div class="rem-row">
      <div><b>Lift Log ${APP_VERSION}</b><small>Updates install on their own. Tap to get one right now.</small></div>
      <button class="btn" data-a="check-update">Update now</button>
    </div></div>

    <h2>Reset program</h2>
    <div class="card">
      <button class="btn danger block" data-a="prog-reset">Reset program to the original</button>
      <div class="sh-hint">Only resets the exercises and days. Your logged history stays.</div>
    </div>
    <div class="foot">Works offline · no account · your data stays on this phone</div>`;
}

function profileCard() {
  const wi = latestWeighIn(todayStr());
  const beginner = S.settings.yogaLevel === 'beginner';
  return `<h2 id="about-card">About you</h2>
    <div class="card">
      <label class="lbl">Height</label>
      <div class="stepper three">
        <button class="st-btn" data-a="set-height" data-d="-1">−1″</button>
        <div class="st-inp" style="display:grid;place-items:center">${fmtHeight(S.settings.profile.heightIn)}</div>
        <button class="st-btn" data-a="set-height" data-d="1">+1″</button>
      </div>
      <div class="sh-hint">Weight comes from your latest weigh-in${wi ? ` (${wi.weight} lb)` : ''}. Together they set your protein goal and calories.</div>
      <label class="lbl">Yoga level</label>
      <div class="seg">
        <button class="${beginner ? 'on' : ''}" data-a="yoga-level" data-v="beginner">Beginner</button>
        <button class="${beginner ? '' : 'on'}" data-a="yoga-level" data-v="intermediate">Intermediate</button>
      </div>
      <div class="sh-hint">Lift Log suggests moving up when your classes have felt easy for a while.</div>
    </div>`;
}

function goalCard() {
  const g = S.settings.goal;
  return `<h2 id="goal-card">Goals</h2>
    <div class="card">
      <label class="lbl">Body goal</label>
      <div class="seg">${Object.entries(GOALS).map(([k, x]) => `<button class="${g === k ? 'on' : ''}" data-a="goal" data-v="${k}">${x.name}</button>`).join('')}</div>
      <div class="sh-hint">${GOALS[g].name}: ${GOALS[g].aim}. The Body tab checks your 3-week weight trend against it${g === 'cut' ? ', and protein goes up to at least 1 g per lb' : ''}.</div>
      <div class="rem-row" style="margin-top:14px">
        <div><b>Track creatine</b><small>A daily check-off on the Body tab.</small></div>
        <button class="toggle ${S.settings.creatine ? 'on' : ''}" data-a="creatine-track">${S.settings.creatine ? 'On' : 'Off'}</button>
      </div>
    </div>`;
}

function proteinCard() {
  const auto = S.settings.proteinMode === 'auto';
  const today = todayStr(), wi = latestWeighIn(today);
  return `<h2>Protein target</h2>
    <div class="card">
      <div class="seg">
        <button class="${auto ? 'on' : ''}" data-a="prot-mode" data-v="auto">Follows weight</button>
        <button class="${auto ? '' : 'on'}" data-a="prot-mode" data-v="fixed">Fixed</button>
      </div>
      ${auto ? `<label class="lbl">Grams per pound of bodyweight</label>
      <div class="stepper three">
        <button class="st-btn" data-a="set-perlb" data-d="-0.05">−</button>
        <div class="st-inp" style="display:grid;place-items:center">${S.settings.proteinPerLb.toFixed(2)} g</div>
        <button class="st-btn" data-a="set-perlb" data-d="0.05">+</button>
      </div>
      <div class="sh-hint">${proteinWeight(today) ? `Today's target is ${proteinTargetFor(today)} g, from your ${proteinWeight(today).n > 1 ? `7-day average weight (${Math.round(proteinWeight(today).lb)} lb)` : `${Math.round(proteinWeight(today).lb)} lb weigh-in`}.` : wi ? `No weigh-in in 3 weeks, so it's ${S.settings.proteinTarget} g until you weigh in.` : `Log your weight on the Body tab and the target follows it. Until then it's ${S.settings.proteinTarget} g.`} A common range for lifting is 0.7 to 1 g per pound.</div>`
      : `<label class="lbl">Grams per day</label>
      <div class="stepper three">
        <button class="st-btn" data-a="set-prot" data-d="-5">−5</button>
        <div class="st-inp" style="display:grid;place-items:center">${S.settings.proteinTarget} g</div>
        <button class="st-btn" data-a="set-prot" data-d="5">+5</button>
      </div>`}
    </div>`;
}

function reminderCard() {
  const r = S.settings.reminder;
  const can = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let body;
  if (!isStandalone() && /iPhone|iPad/.test(navigator.userAgent)) {
    body = `<div class="muted small">Open Lift Log from your Home Screen icon to turn these on. iPhone only allows notifications for installed web apps.</div>`;
  } else if (!can) {
    body = `<div class="muted small">This browser can't show notifications. On iPhone you need iOS 16.4 or newer and the Home Screen app.</div>`;
  } else {
    const row = (k, title, sub, timeId, time) => `
      <div class="rem-row">
        <div><b>${title}</b><small>${sub}</small></div>
        <button class="toggle ${r[k] ? 'on' : ''}" data-a="rem-toggle" data-k="${k}" aria-pressed="${r[k]}">${r[k] ? 'On' : 'Off'}</button>
      </div>
      <input class="inp" type="time" id="${timeId}" value="${time}" style="font-size:20px;font-weight:700">`;
    body = `${row('on', 'Weigh-in', 'A morning nudge to weigh in. Skipped if you already did.', 'rem-time', r.time)}
      <div style="height:16px"></div>
      ${row('streakOn', 'Streak saver', "An evening nudge, only if today doesn't count for your streak yet.", 'rem-streak-time', r.streakTime)}
      <div style="height:16px"></div>
      ${row('measureOn', 'Check-in day', 'On the 1st of each month: take your measurements. Every 3 months (January, April, July, and October) it adds progress photos.', 'rem-measure-time', r.measureTime)}
      ${remAny(r) ? '<button class="btn block" style="margin-top:14px" data-a="rem-test">Send a test</button>' : ''}`;
  }
  return `<h2>Reminders</h2><div class="card">${body}</div>`;
}


function viewProgDay() {
  const d = S.view.d, day = planOf(d);
  if (!day) { S.view = null; return viewMore(); }
  const types = [['strength', 'Lifting'], ['cardio', 'Cardio/yoga'], ['rest', 'Rest']];
  const stepTxt = x => (x.kind === 'iso' ? 'Isolation' : 'Compound') + ` · ${x.body === 'lower' ? 'lower' : 'upper'} body · adds ${x.inc} lb at a time`;
  let body = '';
  if (day.type === 'strength') {
    const groups = day.groups || [];
    body = groups.map((g, gi) => `
      <div class="card flush ${g.length > 1 ? 'ss' : ''}">
        ${g.length > 1 ? '<div class="ss-tag" style="margin:12px 16px 0">Superset</div>' : ''}
        ${g.map((x, ei) => `<button class="row" data-a="edit-ex" data-g="${gi}" data-e="${ei}">
          <div><b>${esc(x.name)}</b><small>${esc(targetText(x))} · ${stepTxt(x)}</small></div>${ic('chev')}</button>`).join('')}
        <div class="ex-tools" style="padding:0 12px 12px;margin-top:0;flex-wrap:wrap">
          <button data-a="grp-move" data-g="${gi}" data-dir="-1" ${gi === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button data-a="grp-move" data-g="${gi}" data-dir="1" ${gi === groups.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          ${gi < groups.length - 1 ? `<button data-a="grp-link" data-g="${gi}">Superset with next</button>` : ''}
          ${g.length > 1 ? `<button data-a="grp-unlink" data-g="${gi}">Split superset</button>` : ''}
        </div>
      </div>`).join('') || '<div class="card empty"><b>No exercises</b>Add your first one below.</div>';
    body += `<button class="btn pri block" data-a="add-ex">+ Add exercise</button>`;
  } else if (day.type === 'cardio') {
    body = '<div class="card muted">On this day you log yoga, walks, runs, and anything else, with time, distance, and notes.</div>';
  } else {
    body = '<div class="card muted">A rest day. It doesn\'t count toward your weekly sessions, but you can still log a hike or anything else.</div>';
  }
  const custom = !isDayKey(d);
  return `<button class="backbtn" data-a="back">${ic('back')} ${S.view.back ? 'Back' : 'More'}</button>
    <header class="top"><h1>${custom ? esc(day.label) : DAY_NAMES[d]}</h1></header>
    <div class="card">
      <label class="lbl">Name</label>
      <input class="inp" data-pl="${d}" value="${esc(day.label)}">
      ${custom ? '' : `<label class="lbl">Type</label>
      <div class="seg">${types.map(([t, n]) => `<button class="${day.type === t ? 'on' : ''}" data-a="prog-type" data-v="${t}">${n}</button>`).join('')}</div>`}
    </div>
    ${body}
    ${custom ? `<button class="btn block" data-a="start-plan" data-k="${d}">Do this workout today</button>
      <button class="btn danger block" data-a="plan-del" data-k="${d}">Delete this workout</button>` : ''}
    <div class="foot">Changes apply to your next session. Renaming an exercise starts a fresh history under the new name.</div>`;
}

// ---------- sheets ----------
function openSetSheet(w, i, j) {
  const e = w.exercises[i], s = e.sets[j];
  const later = e.sets.filter((x, k) => k > j && !x.done);
  // Change later sets too, unless the sets already use different weights.
  const chain = later.length > 0 && later.every(x => x.w === '' || +x.w === +s.w);
  S.sheet = { kind: 'set', wid: w.id, i, j, w: s.w === '' ? '' : String(s.w), r: s.r === '' ? '' : String(s.r), later: later.length, chain };
  renderSheet();
}
const EX_DEFAULT = { name: '', sets: 3, min: 8, max: 12, inc: UP, kind: 'compound', body: 'upper', unit: 'reps', note: '', place: 'gym' };
const exData = x => ({ name: x.name, sets: x.sets, min: x.min ?? '', max: x.max ?? '', inc: x.inc || UP, kind: x.kind, body: x.body, unit: x.unit || 'reps', note: x.note || '', place: x.place === 'home' ? 'home' : 'gym' });
// Program mode edits a day or saved workout; session mode (wid set) changes just today's session.
function openExSheet(g, e) {
  const day = planOf(S.view.d);
  const x = g == null ? EX_DEFAULT : classify(day.groups[g][e]);
  S.sheet = { kind: 'ex', g, e, data: exData(x) };
  renderSheet();
}
function openSessExSheet(w, i) {
  const e = i == null ? null : w.exercises[i];
  S.sheet = { kind: 'ex', wid: w.id, i, data: exData(e ? { ...targetOf(e), name: e.name } : EX_DEFAULT), toPlan: false };
  renderSheet();
}
// A set you typed into is saved when the sheet is swiped or tapped away, or the app closes. Only
// Cancel throws it away.
function keepTyped() {
  const sh = S.sheet;
  if (!sh || sh.kind !== 'set') return;
  const w = getW(sh.wid), e = w && w.exercises[sh.i], s = e && e.sets[sh.j];
  const nw = num(sh.w), nr = num(sh.r);
  if (!s) return;
  const newW = nw != null && (s.w === '' || +s.w !== nw), newR = nr != null && (s.r === '' || +s.r !== nr);
  if (!newW && !newR) return;
  if (newW) s.w = nw;
  if (newR) s.r = nr;
  if (!s.done) s.own = true;
  persist(w);
}
const dismissSheet = () => { keepTyped(); closeSheet(); render(); };
function closeSheet() {
  S.sheet = null;
  renderSheet();
}
function renderSheet() {
  const el = $('#sheet');
  if (!S.sheet) { el.hidden = true; document.body.classList.remove('sheet-open'); return; }
  el.hidden = false;
  document.body.classList.add('sheet-open');
  // A close button that stays in reach while the sheet scrolls.
  $('#sheet-panel').innerHTML = `<div class="sh-top"><button class="sh-x" data-a="sheet-close" aria-label="Close">${ic('x')}</button></div>`
    + ({ set: setSheetHTML, ex: exSheetHTML, act: actSheetHTML, other: otherSheetHTML, meas: measSheetHTML, photo: photoSheetHTML, pcmp: pcmpSheetHTML, inspo: inspoSheetHTML, past: pastSheetHTML, info: infoSheetHTML })[S.sheet.kind]();
}
// Swipe a sheet down to close it: from the top edge, or anywhere once it's scrolled to the top.
(function sheetSwipe() {
  const panel = document.getElementById('sheet-panel');
  if (!panel) return;
  let y0 = 0, t0 = 0, dy = 0, drag = false, armed = false;
  panel.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1) return;
    const t = ev.target, nearTop = ev.touches[0].clientY - panel.getBoundingClientRect().top < 56;
    armed = (panel.scrollTop <= 0 || nearTop) && !t.closest('input, textarea, select, .pc-slide, .pc-strip');
    y0 = ev.touches[0].clientY; t0 = Date.now(); dy = 0; drag = false;
  }, { passive: true });
  panel.addEventListener('touchmove', ev => {
    if (!armed) return;
    dy = ev.touches[0].clientY - y0;
    if (!drag && dy > 8 && (panel.scrollTop <= 0 || y0 - panel.getBoundingClientRect().top < 56)) { drag = true; panel.style.transition = 'none'; }
    if (!drag) { if (dy < -4) armed = false; return; }
    ev.preventDefault();
    panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  const end = () => {
    if (!drag) { armed = false; return; }
    const fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.5;
    panel.style.transition = 'transform .2s ease-out';
    if (dy > Math.min(140, panel.offsetHeight * 0.25) || fast) {
      panel.style.transform = 'translateY(100%)';
      setTimeout(() => { panel.style.transition = ''; panel.style.transform = ''; dismissSheet(); }, 190);
    } else {
      panel.style.transform = '';
      setTimeout(() => { panel.style.transition = ''; }, 210);
    }
    drag = false; armed = false;
  };
  panel.addEventListener('touchend', end);
  panel.addEventListener('touchcancel', end);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && S.sheet) closeSheet(); });
})();

function infoSheetHTML() {
  const sh = S.sheet;
  return `<div class="sh-grip"></div>
    <div class="sh-title">${esc(sh.title)}<span>${esc(sh.sub || 'What the coach does with it')}</span></div>
    ${sh.q ? `<div class="ex-note" style="margin:0 0 12px">${esc(sh.q)}</div>` : ''}
    <div class="info-body">${sh.body.map(p => `<p>${esc(p)}</p>`).join('')}</div>
    <button class="btn block" data-a="sheet-close">Got it</button>`;
}
function pastSheetHTML() {
  const opt = (k, name, sub) => `<button class="row" data-a="past-make" data-k="${k}"><div><b>${esc(name)}</b><small>${esc(sub)}</small></div>${ic('chev')}</button>`;
  return `<div class="sh-grip"></div>
    <div class="sh-title">Log a past day<span>Pick the day, then what you did</span></div>
    <label class="lbl" for="past-date">Date</label>
    <input class="inp" type="date" id="past-date" value="${S.sheet.date}" max="${todayStr()}">
    <label class="lbl">What you did</label>
    <div class="card flush">
      ${DAYS.filter(d => S.program.days[d].type !== 'rest').map(d => opt(d, S.program.days[d].label, `${DAY_NAMES[d]}'s workout`)).join('')}
      ${S.program.custom.map(c => opt(c.id, c.label, 'Saved workout')).join('')}
      ${opt('free', 'Blank workout', 'Add exercises yourself')}
      ${opt('act', 'Just an activity', 'A hike, a climb, a walk, anything')}
    </div>
    <div class="sheet-actions"><button class="btn ghost block" data-a="sheet-close">Cancel</button></div>`;
}

function setSheetHTML() {
  const sh = S.sheet, w = getW(sh.wid), e = w.exercises[sh.i], s = e.sets[sh.j];
  const steps = e.target.unit === 'steps';
  const rd = steps ? 5 : 1, pin = isPin(e);
  return `<div class="sh-grip"></div>
    <div class="sh-title">${esc(e.name)}<span>Set ${sh.j + 1} of ${e.sets.length} · target ${esc(targetText(e.target))}</span></div>
    <label class="lbl">${pin ? 'Pin number on the stack' : 'Weight (lb)'}</label>
    ${pin ? `<div class="stepper three">
      <button class="st-btn" data-a="ss-step" data-f="w" data-d="-1">−1</button>
      <input class="st-inp" inputmode="numeric" data-ssf="w" value="${esc(sh.w)}" placeholder="">
      <button class="st-btn" data-a="ss-step" data-f="w" data-d="1">+1</button>
    </div>` : `<div class="stepper">
      <button class="st-btn" data-a="ss-step" data-f="w" data-d="-5">−5</button>
      <button class="st-btn sm" data-a="ss-step" data-f="w" data-d="-2.5">−2.5</button>
      <input class="st-inp" inputmode="decimal" data-ssf="w" value="${esc(sh.w)}" placeholder="">
      <button class="st-btn sm" data-a="ss-step" data-f="w" data-d="2.5">+2.5</button>
      <button class="st-btn" data-a="ss-step" data-f="w" data-d="5">+5</button>
    </div>
    <button class="linkbtn" data-a="ss-bw">No weight (bodyweight)</button>`}
    ${sh.later ? `<div class="rem-row" style="margin-top:6px">
      <div><b>Same ${pin ? 'pin' : 'weight'} for the next ${sh.later === 1 ? 'set' : `${sh.later} sets`}</b><small>${sh.chain ? 'A new weight here carries forward.' : 'Only this set changes, so each set keeps its own weight.'}</small></div>
      <button class="toggle ${sh.chain ? 'on' : ''}" data-a="ss-chain">${sh.chain ? 'On' : 'Off'}</button>
    </div>` : ''}
    <label class="lbl">${steps ? 'Steps' : 'Reps'}</label>
    <div class="stepper three">
      <button class="st-btn" data-a="ss-step" data-f="r" data-d="-${rd}">−${rd}</button>
      <input class="st-inp" inputmode="numeric" data-ssf="r" value="${esc(sh.r)}" placeholder="0">
      <button class="st-btn" data-a="ss-step" data-f="r" data-d="${rd}">+${rd}</button>
    </div>
    <div class="sheet-actions">
      <button class="btn pri block big" data-a="ss-save">${s.done ? 'Save changes' : 'Log set'}</button>
      ${s.done ? '' : '<button class="btn block" data-a="ss-only">Save without logging</button>'}
      <button class="btn ghost block" data-a="sheet-close">Cancel</button>
    </div>`;
}

// Exercises you already know (from your program, your saved workouts, and your history), for quick picks.
function knownExercises(skip) {
  const m = new Map();
  allPlans().forEach(p => (p.groups || []).forEach(g => g.forEach(x => { if (!m.has(keyOf(x.name))) m.set(keyOf(x.name), x); })));
  allExercises().forEach(x => { if (!m.has(x.key)) m.set(x.key, { name: x.name }); });
  return [...m.values()].filter(x => !skip.has(keyOf(x.name)));
}

const LOW_STRAIN = /leg extension|leg press|hamstring|leg curl|back extension|pull-?through|kickback|glute bridge/i;
function careSeg(name) {
  const c = careOf(name) || '';
  const b = (v, n) => `<button class="${c === v ? 'on' : ''}" data-a="care-set" data-v="${v}">${n}</button>`;
  return `<label class="lbl">Does it bother you?</label>
    <div class="seg">${b('', 'No')}${b('pressure', 'Strain')}${b('joint', 'Joint')}${b('cramp', 'Cramps')}</div>
    <div class="sh-hint">${c ? 'The coach goes easier on this one and adds a reminder.' : 'Pick one and the coach goes easier on it from now on.'}</div>`;
}
function exSheetHTML() {
  const sh = S.sheet, x = sh.data, sess = sh.wid != null;
  const w = sess ? getW(sh.wid) : null;
  const plan = sess ? planOf(w.dayKey) : null;
  const segBtn = (f, v, n) => `<button class="${String(x[f]) === String(v) ? 'on' : ''}" data-a="sf-set" data-f="${f}" data-v="${v}">${n}</button>`;
  const hi = num(x.max) ?? num(x.min);
  const title = sess ? (sh.i == null ? 'Add an exercise' : 'Change this exercise') : (sh.g == null ? 'New exercise' : 'Edit exercise');
  const ex = sess && sh.i != null ? w.exercises[sh.i] : null;
  let picks = ex ? swapPicks(w, sh.i) : sess || sh.g == null ? knownExercises(new Set(sess ? w.exercises.map(e => e.key) : [])).filter(p => !disliked(p.name)) : [];
  picks = picks.slice(0, ex ? 8 : 16);
  const sample = ex ? (+(ex.sets.find(s => s.w !== '') || {}).w || 0) : 0;
  return `<div class="sh-grip"></div>
    <div class="sh-title">${title}${sess ? `<span>${sh.i == null ? 'Just for today, unless you save it below' : 'Swap it, or change today\'s sets and reps'}</span>` : ''}</div>
    ${picks.length ? `<label class="lbl">${sh.i == null ? 'Pick one you know' : 'Swap for (one tap)'}</label>
      <div class="alt-row pick-row">${picks.map(p => `<button class="chip" data-a="${ex ? 'sx-swap' : 'sf-pick'}" data-n="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
    ${ex ? formLink(ex.name) : ''}
    ${(ex || sh.g != null) && !NO_WEIGHT.test(ex ? ex.name : x.name) ? pinSeg(ex ? ex.name : x.name) : ''}
    ${ex || sh.g != null ? careSeg(ex ? ex.name : x.name) : ''}
    ${ex ? notForMeHTML(ex.name, BODYWEIGHT.test(ex.name)) : ''}
    ${ex ? '<button class="btn danger block" style="margin-top:12px" data-a="sx-rm">Remove from today</button><label class="lbl" style="margin-top:20px">Or change it</label>' : ''}
    <label class="lbl">Name</label>
    <input class="inp" data-sf="name" value="${esc(x.name)}" placeholder="e.g. Goblet squat">
    <label class="lbl">Where</label>
    <div class="seg">${segBtn('place', 'gym', 'At the gym')}${segBtn('place', 'home', 'At home')}</div>
    <label class="lbl">Sets</label>
    <div class="stepper three">
      <button class="st-btn" data-a="sf-step" data-f="sets" data-d="-1">−1</button>
      <div class="st-inp" style="display:grid;place-items:center">${x.sets}</div>
      <button class="st-btn" data-a="sf-step" data-f="sets" data-d="1">+1</button>
    </div>
    <label class="lbl">${x.unit === 'steps' ? 'Step' : 'Rep'} range</label>
    <div class="grid2">
      <input class="inp" inputmode="numeric" data-sf="min" value="${esc(x.min)}" placeholder="Low">
      <input class="inp" inputmode="numeric" data-sf="max" value="${esc(x.max)}" placeholder="High">
    </div>
    <div class="sh-hint">Use the same number twice for a fixed target (like 3 × 8). Leave both blank for max reps: you'll build total reps, then add weight.</div>
    <details class="more-opts"><summary>More options</summary>
    <label class="lbl">Count</label>
    <div class="seg">${segBtn('unit', 'reps', 'Reps')}${segBtn('unit', 'steps', 'Steps')}</div>
    <label class="lbl">Type</label>
    <div class="seg">${segBtn('kind', 'compound', 'Compound')}${segBtn('kind', 'iso', 'Isolation')}</div>
    <div class="seg" style="margin-top:8px">${segBtn('body', 'upper', 'Upper body')}${segBtn('body', 'lower', 'Lower body')}</div>
    <div class="sh-hint">Compound lifts move several joints (presses, rows, squats) and rest longer. Isolation lifts work one muscle (curls, raises).</div>
    <label class="lbl">Smallest weight step you can make</label>
    <div class="seg">${segBtn('inc', 2.5, '2.5 lb')}${segBtn('inc', 5, '5 lb')}${segBtn('inc', 10, '10 lb')}</div>
    <div class="sh-hint">When you hit ${hi != null ? `${hi} on every set` : 'your rep goal'}, the weight goes up about ${x.kind !== 'iso' && x.body === 'upper' ? '4' : '5'}%, rounded to this step${sample ? ` (${sample} → ${round2(sample + jumpFor(x, sample))} lb)` : ''}.</div>
    <label class="lbl">Note</label>
    <input class="inp" data-sf="note" value="${esc(x.note)}" placeholder="e.g. per leg, feet high">
    </details>
    ${sess && plan ? `<div class="rem-row" style="margin-top:16px">
      <div><b>Save to ${isDayKey(w.dayKey) ? `${DAY_NAMES[w.dayKey]}'s` : 'this'} workout too</b><small>So it's there next time.</small></div>
      <button class="toggle ${sh.toPlan ? 'on' : ''}" data-a="sf-toplan">${sh.toPlan ? 'On' : 'Off'}</button>
    </div>` : ''}
    <div class="sheet-actions">
      <button class="btn pri block big" data-a="sf-save">${sess && sh.i == null ? 'Add' : 'Save'}</button>
      ${!sess && sh.g != null ? '<button class="btn danger block" data-a="sf-del">Delete exercise</button>' : ''}
      <button class="btn ghost block" data-a="sheet-close">Cancel</button>
    </div>`;
}

// Anything you've done besides yoga, walks, and runs, most recent first.
function recentOtherActs() {
  const seen = new Set(), out = [];
  for (const w of sortedW()) for (const a of w.activities || []) {
    if (a.type !== 'other' || seen.has(keyOf(a.name))) continue;
    seen.add(keyOf(a.name)); out.push(a);
  }
  return out.slice(0, 6);
}
function actSheetHTML() {
  const recent = recentOtherActs();
  const btn = (attrs, label) => `<button class="chip" data-a="act-add" ${attrs}>${esc(label)}</button>`;
  const known = new Set(recent.map(a => a.kind));
  return `<div class="sh-grip"></div>
    <div class="sh-title">Add an activity<span>Counts for your streak, calories, and tomorrow's picks</span></div>
    <div class="alt-row pick-row">${Object.entries(ADD_TYPES).map(([t, n]) => btn(`data-t="${t}"`, n)).join('')}</div>
    ${recent.length ? `<label class="lbl">Recent</label><div class="alt-row pick-row">${recent.map(a => btn(`data-t="other" data-kind="${esc(a.kind)}" data-n="${esc(a.name)}"`, a.name)).join('')}</div>` : ''}
    <label class="lbl">More</label>
    <div class="alt-row pick-row">${ACTIVITIES.filter(x => !known.has(x.id)).map(x => btn(`data-t="other" data-kind="${x.id}" data-n="${esc(x.name)}"`, x.name)).join('')}</div>
    <label class="lbl" for="act-name">Something else</label>
    <div class="grid-add"><input class="inp" id="act-name" placeholder="e.g. Paintball" autocomplete="off"><button class="btn pri" data-a="act-custom">Add</button></div>
    <div class="sheet-actions"><button class="btn ghost block" data-a="sheet-close">Cancel</button></div>`;
}
function otherSheetHTML() {
  const cs = S.program.custom;
  return `<div class="sh-grip"></div>
    <div class="sh-title">Do a different workout<span>Instead of today's planned one</span></div>
    ${S.pickDay && S.pickDay.date === todayStr() && S.pickDay.k !== planKeyOn(todayStr()) ? `<button class="btn block" data-a="pick-day" data-k="${planKeyOn(todayStr())}">Back to today's plan (${esc(planOn(todayStr()).label)})</button>` : ''}
    ${cs.length ? `<div class="card flush">${cs.map(c => `<button class="row" data-a="start-plan" data-k="${c.id}">
      <div><b>${esc(c.label)}</b><small>${plural(sum((c.groups || []).map(g => g.length)), 'exercise')}</small></div>${ic('chev')}</button>`).join('')}</div>` : ''}
    <button class="btn pri block" data-a="start-plan" data-k="free">Start a blank workout</button>
    <div class="sh-hint">Add exercises as you go. Afterward you can save it to repeat.</div>
    <button class="btn block" data-a="plan-new">Build a saved workout first</button>
    <div class="sh-hint">Did something that isn't lifting, like a hike? Use "+ Activity" on any day instead.</div>
    <div class="sheet-actions"><button class="btn ghost block" data-a="sheet-close">Cancel</button></div>`;
}

const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const b64uBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), ch => ch.charCodeAt(0));

const remAny = r => !!(r.on || r.streakOn || r.measureOn);
async function pushApi(path, body) {
  const res = await fetch(`${PUSH_URL}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server said ${res.status}`);
  return data;
}
async function reminderSync() {
  const r = S.settings.reminder;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(VAPID_PUBLIC) });
  r.id = r.id || uid('r');
  await pushApi('subscribe', {
    id: r.id, sub: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    time: r.time, weighOn: r.on, streakTime: r.streakTime, streakOn: r.streakOn, measureTime: r.measureTime, measureOn: !!r.measureOn,
  });
  if (dayCounts(todayStr())) { S.activePinged = todayStr(); await pushApi('active', { id: r.id }); }
}
async function reminderToggle(k) {
  const r = S.settings.reminder;
  const name = { on: 'Weigh-in reminder', streakOn: 'Streak saver', measureOn: 'Check-in day' }[k];
  const time = { on: r.time, streakOn: r.streakTime, measureOn: r.measureTime }[k];
  if (!r[k]) {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications are off for Lift Log. Turn them on in iPhone Settings → Notifications.'); return; }
      r[k] = true;
      await reminderSync();
      saveSettings(); render();
      toast(`${name} set for ${k === 'measureOn' ? 'the 1st at ' : ''}${fmtTime(time)}`);
    } catch (err) {
      r[k] = false;
      render();
      toast(`Couldn't turn it on: ${err.message}`);
    }
    return;
  }
  r[k] = false;
  saveSettings(); render();
  toast(`${name} off`);
  if (remAny(r)) { reminderSync().catch(() => {}); return; }
  try { if (r.id) await pushApi('unsubscribe', { id: r.id }); } catch (err) { /* offline: the server drops it once pushes start failing */ }
  try { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (err) { /* ignore */ }
}
function reminderWeighed() {
  const r = S.settings.reminder;
  if (remAny(r) && r.id) pushApi('weighed', { id: r.id }).catch(() => {});
}
function reminderTimeChanged(field, value) {
  const r = S.settings.reminder;
  r[field] = value;
  saveSettings();
  if (remAny(r)) reminderSync().then(() => toast(`Moved to ${fmtTime(value)}`)).catch(err => toast(`Couldn't update: ${err.message}`));
}

// ---------- nightly trainer ----------
// Opt-in. The app copies the log (no photos, no food items) to the Lift Log server under a long secret
// key. At midnight a trainer reads it and may leave program changes, which the app applies to upcoming
// workouts only. Logged workouts never change.
function trainerSnapshot() {
  try { olSnap(olCompute()); } catch (err) { /* outlook is a bonus; never block the sync */ }
  const { reminder, ...settings } = S.settings;
  return {
    app: 'liftlog', version: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    program: S.program, settings, workouts: S.workouts,
    body: Object.values(S.body),
    proteinToday: liveTarget(todayStr()),
    photos: S.photos.map(p => ({ id: p.id, date: p.date, pose: p.pose || null, pumped: !!p.pumped })),
    coachLog: S.coachLog.slice(0, 10).map(c => ({ id: c.id, date: c.date, undone: !!c.undone })),
  };
}
let trainerBusy = false, trainerLastPull = 0;
async function trainerSync(force) {
  const t = S.settings.trainer;
  if (!t.on || !t.k || trainerBusy || !navigator.onLine) return;
  const data = trainerSnapshot();
  const sig = JSON.stringify({ ...data, exportedAt: 0 });
  const sentP = new Set(t.photos || []);
  const photosLeft = S.photos.some(p => !sentP.has(p.id)) || sentP.size > S.photos.length;
  if (!force && sig === S.trainerSig && !photosLeft) return;
  trainerBusy = true;
  try {
    if (force || sig !== S.trainerSig) await pushApi('sync', { k: t.k, data });
    S.trainerSig = sig;
    t.lastSync = Date.now();
    saveSettings();
    await trainerPhotos();
  } catch (err) { /* try again next time */ } finally { trainerBusy = false; }
}
// Progress photos go up one at a time, once each; deleted ones come down from the server too.
const blobUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function trainerPhotos() {
  const t = S.settings.trainer, sent = new Set(t.photos || []), have = new Set(S.photos.map(p => p.id));
  for (const id of [...sent].filter(id => !have.has(id))) {
    await pushApi('photo', { k: t.k, id, del: true });
    sent.delete(id); t.photos = [...sent]; saveSettings();
  }
  for (const p of S.photos.filter(p => !sent.has(p.id) && p.blob)) {
    await pushApi('photo', { k: t.k, id: p.id, date: p.date, data: await blobUrl(p.blob) });
    sent.add(p.id); t.photos = [...sent]; saveSettings();
  }
}
async function trainerPull() {
  const t = S.settings.trainer;
  if (!t.on || !t.k || !navigator.onLine) return;
  trainerLastPull = Date.now();
  try {
    const plan = await pushApi('coach', { k: t.k });
    if (plan && plan.id && plan.id !== t.lastId) applyCoachPlan(plan);
    // A look update that an older version skipped still lands once.
    else if (plan && plan.look && typeof plan.look === 'object' && (S.settings.look || {}).id !== String(plan.id)) { applyLook(plan.look, plan.id); if (!S.sheet && !typing()) render(); }
  } catch (err) { /* offline */ }
}

const COACH_NUM = (v, lo, hi) => (v == null || v === '' ? undefined : Number.isFinite(+v) && +v >= lo && +v <= hi ? Math.round(+v) : NaN);
function coachFind(day, name) {
  const k = keyOf(name || '');
  for (let gi = 0; gi < (day.groups || []).length; gi++) {
    const ii = day.groups[gi].findIndex(x => keyOf(x.name) === k);
    if (ii >= 0) return { gi, ii, x: day.groups[gi][ii] };
  }
  return null;
}
const rangeTxt = x => (x.min == null ? (x.note || 'max reps') : `${x.min === x.max ? x.min : `${x.min}–${x.max}`}${x.unit === 'steps' ? ' steps' : ''}`);
const presTxt = x => `${x.sets} × ${rangeTxt(x)}`;
// One change from the trainer. Returns a line to show, or null when it doesn't fit the program.
function coachOp(prog, c) {
  if (!c || !isDayKey(c.day)) return null;
  const day = prog.days[c.day], D = DAY_NAMES[c.day];
  if (c.op === 'label') {
    const label = String(c.label || '').trim().slice(0, 40);
    if (!label || day.type !== 'strength') return null;
    day.label = label;
    return `${D} is now "${label}"`;
  }
  if (day.type !== 'strength' || !Array.isArray(day.groups)) return null;
  const sets = COACH_NUM(c.sets, 1, 5), min = COACH_NUM(c.min, 1, 60), max = COACH_NUM(c.max, 1, 60);
  if ([sets, min, max].some(Number.isNaN) || (min != null && max != null && max < min)) return null;
  const note = c.note != null ? String(c.note).trim().slice(0, 60) : undefined;
  const shape = x => {
    if (sets != null) x.sets = Math.max(MIN_SETS, sets);
    if (min != null) x.min = min;
    if (max != null) x.max = max;
    if (min != null && max == null && x.max < min) x.max = min;
    if (note !== undefined) x.note = note;
  };
  const name = String(c.name || '').trim().slice(0, 50);
  // Your 12-rep cap holds for the trainer too (bodyweight and carries excepted).
  const capped = n => !NO_WEIGHT.test(n || '') && c.unit !== 'steps';
  if (capped(c.op === 'swap' ? c.to : name) && ((min ?? 0) > REP_CAP || (max ?? 0) > REP_CAP)) return null;
  if (c.op === 'add') {
    if (!name || coachFind(day, name) || sets == null) return null;
    const x = ex(name, Math.max(MIN_SETS, sets), min ?? null, max ?? min ?? null, UP, { note: note || '', ...(c.body === 'lower' || c.body === 'upper' ? { body: c.body } : {}), ...(c.place === 'home' ? { place: 'home' } : {}) });
    const w = c.with && coachFind(day, c.with), a = c.after && coachFind(day, c.after);
    if (w) day.groups[w.gi].push(x);
    else if (a) day.groups.splice(a.gi + 1, 0, [x]);
    else planInsertByEffort(day.groups, [x]);
    return `${D}: added ${name}${x.place === 'home' ? ' (at home)' : ''}, ${presTxt(x)}${w ? ` (paired with ${w.x.name})` : ''}`;
  }
  const f = coachFind(day, name);
  if (!f) return null;
  if (c.op === 'remove') {
    day.groups[f.gi].splice(f.ii, 1);
    if (!day.groups[f.gi].length) day.groups.splice(f.gi, 1);
    return `${D}: dropped ${f.x.name}`;
  }
  if (c.op === 'swap') {
    const to = String(c.to || '').trim().slice(0, 50);
    if (!to || coachFind(day, to)) return null;
    const old = f.x.name, x = { ...f.x, id: uid('e'), name: to, unit: 'reps', stepSet: false, inc: UP };
    delete x.kind; delete x.body;
    if (c.body === 'lower' || c.body === 'upper') x.body = c.body;
    if (note === undefined) x.note = '';
    shape(x); classify(x);
    day.groups[f.gi][f.ii] = x;
    return `${D}: ${old} → ${to}, ${presTxt(x)}`;
  }
  // Move a lift (with its superset partner) to go right after another, or first.
  if (c.op === 'move') {
    const to = c.after && coachFind(day, c.after);
    if (!to && !c.first) return null;
    if (to && to.gi === f.gi) return null;
    const [g] = day.groups.splice(f.gi, 1);
    const at = to ? day.groups.findIndex(x => x.includes(to.x)) + 1 : 0;
    day.groups.splice(at, 0, g);
    return `${D}: ${f.x.name} now comes ${to ? `right after ${to.x.name}` : 'first'}`;
  }
  if (c.op === 'set') {
    const before = presTxt(f.x);
    shape(f.x);
    const after = presTxt(f.x);
    return before === after && note === undefined ? null : `${D}: ${f.x.name} ${before} → ${after}`;
  }
  return null;
}
function applyCoachPlan(plan) {
  const t = S.settings.trainer;
  t.lastId = String(plan.id).slice(0, 60);
  saveSettings();
  const note = String(plan.note || '').trim().slice(0, 1500), outlook = String(plan.outlook || '').trim().slice(0, 600);
  if (outlook) { S.settings.outlookNote = { date: todayStr(), text: outlook }; saveSettings(); }
  const look = plan.look && typeof plan.look === 'object' ? plan.look : null;
  if (look) applyLook(look, plan.id);
  const prog = JSON.parse(JSON.stringify(S.program));
  const lines = (Array.isArray(plan.changes) ? plan.changes.slice(0, 12) : []).map(c => {
    const t2 = coachOp(prog, c);
    return t2 && { t: t2, why: String((c && c.why) || '').trim().slice(0, 200) };
  }).filter(Boolean);
  if (!note && !lines.length) { if ((outlook || look) && !S.sheet && !typing()) render(); return; }
  const entry = { id: t.lastId, date: todayStr(), note, lines, seen: false, undone: false };
  if (lines.length) {
    DB.put('kv', { k: 'coachUndo', v: { id: entry.id, program: S.program } }).catch(() => {});
    S.program = prog;
    saveProgram();
  }
  S.coachLog = [entry, ...S.coachLog.filter(c => c.id !== entry.id)].slice(0, 30);
  saveCoachLog();
  if (!S.sheet && !typing()) render();
}
const saveCoachLog = () => DB.put('kv', { k: 'coachLog', v: S.coachLog }).catch(saveFailed);

function coachLines(c) {
  return c.lines.length ? `<div class="tr-lines">${c.lines.map(l => `<div class="tr-line">${esc(l.t)}${l.why ? `<small>${esc(l.why)}</small>` : ''}</div>`).join('')}</div>` : '';
}
function trainerCard() {
  const c = S.coachLog.find(x => !x.seen);
  if (!c) return '';
  return `<div class="card tr-card">
    <div class="lbl">From your trainer · ${esc(fmtDate(c.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</div>
    ${c.note ? `<div class="tr-note">${esc(c.note).replace(/\n+/g, '<br>')}</div>` : ''}
    ${coachLines(c)}
    ${c.lines.length ? '<div class="sh-hint">Changes start with your next workout. What you already logged stays the same.</div>' : ''}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn pri" data-a="coach-ok" data-k="${esc(c.id)}">Got it</button>
      ${c.lines.length && !c.undone ? `<button class="btn" data-a="coach-undo" data-k="${esc(c.id)}">Undo</button>` : ''}
    </div></div>`;
}
function trainerSettingsCard() {
  const t = S.settings.trainer;
  const ago = t.lastSync ? new Date(t.lastSync).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'not yet';
  const past = S.coachLog.slice(0, 8);
  return `<h2>Nightly trainer</h2>
    <div class="card">
      <div class="rem-row">
        <div><b>Midnight check-in</b><small>Each night a trainer looks at your lifts, weigh-ins, measurements, progress photos, protein, check-ins, and notes, then adjusts your upcoming workouts for a strong, balanced, athletic build. Notes show up on Today.</small></div>
        <button class="toggle ${t.on ? 'on' : ''}" data-a="trainer-toggle" aria-pressed="${!!t.on}">${t.on ? 'On' : 'Off'}</button>
      </div>
      ${t.on ? `<div class="sh-hint">Last sent: ${esc(ago)}. Sends on its own while you use the app, progress photos and protein included (not the foods you ate). Turning it off deletes the copy.</div>
        <button class="btn block" style="margin-top:10px" data-a="trainer-now">Send now</button>` : ''}
      ${past.length ? `<button class="linkbtn" style="margin-top:12px" data-a="coach-notes">${S.coachNotesOpen ? 'Hide past notes' : `Past notes (${past.length})`}</button>
        ${S.coachNotesOpen ? past.map(c => `<div class="tr-past"><div class="lbl">${esc(fmtDate(c.date, { weekday: 'short', month: 'short', day: 'numeric' }))}${c.undone ? ' · undone' : ''}</div>${c.note ? `<div class="tr-note">${esc(c.note).replace(/\n+/g, '<br>')}</div>` : ''}${coachLines(c)}</div>`).join('') : ''}` : ''}
    </div>`;
}
async function trainerToggle() {
  const t = S.settings.trainer;
  if (!t.on) {
    if (!confirm('Turn on the nightly trainer?\n\nA copy of your log (workouts, weigh-ins, measurements, check-ins, notes, protein, and progress photos) goes to your private Lift Log server while you use the app. At midnight your trainer reads it and may change your upcoming workouts. Turn it off anytime to delete the copy.')) return;
    t.k = t.k || `t_${Array.from(crypto.getRandomValues(new Uint8Array(28)), b => (b % 36).toString(36)).join('')}`;
    t.on = true; t.lastSync = 0;
    saveSettings(); render();
    await trainerSync(true);
    toast(t.lastSync ? 'Nightly trainer on. First check-in tonight at midnight.' : "Nightly trainer on, but couldn't send yet. It'll try again.", 5000);
    return;
  }
  t.on = false; t.photos = [];
  saveSettings(); render();
  try { await pushApi('sync', { k: t.k, off: true }); toast('Nightly trainer off. Your copy on the server is deleted.'); } catch (err) { toast("Trainer off. Couldn't reach the server to delete the copy; turn it on and off again later."); }
}

// ---------- levels ----------
// Each skill has its own level, like an RPG: 1 is your lowest point on record and 60 is fully built and
// athletic. Your overall level is the average. A skill goes up as soon as it earns the next level. It
// only drops once it slips more than a full level below, and drops are checked once a day, so normal
// day-to-day swings don't bounce it around.
const LV_MAX = 60;
const LV_DB = /\b(db|dumbbells?|kettlebells?|kb|one.?arm|single.?arm)\b/;
// Strength skills turn every matching lift into one reference lift (an estimated one-rep max), so
// switching between, say, barbell bench and DB bench doesn't reset you. Dumbbell factors include both hands.
// Goals are written as weight for 12 reps (what you actually lift); the math runs on the 1-rep estimate.
const LV_12 = 1 + 12 / 30;
const LV_V = 2;
const LV_LIFTS = {
  chest: { ref: 'bench press', goal: 185 * LV_12, no: /\b(dip|fly|flye|shoulder|overhead|triceps|close|pushdown|crossover)/, rules: [
    [n => /incline/.test(n) && LV_DB.test(n), 2.9], [n => LV_DB.test(n) && /bench|chest press|floor press|\bpress\b/.test(n), 2.5],
    [n => /incline/.test(n) && /press|bench/.test(n), 1.15], [n => /bench press|barbell bench/.test(n), 1], [n => /chest press/.test(n), 0.9]] },
  shoulders: { ref: 'overhead press', goal: 115 * LV_12, no: /\b(cuban|raise|bench|chest|incline)/, rules: [
    [n => /(shoulder|overhead|military|arnold) press/.test(n) && LV_DB.test(n), 2.35], [n => /machine/.test(n) && /shoulder press/.test(n), 0.9],
    [n => /(overhead|military|shoulder) press|^ohp\b/.test(n), 1]] },
  lats: { ref: 'lat pulldown', goal: 165 * LV_12, no: /\b(assist|band|negative|straight.?arm)/, rules: [[n => /pulldown/.test(n), 1], [n => /\b(pull|chin)-up/.test(n), 'bw']] },
  back: { ref: 'row', goal: 170 * LV_12, no: /\b(upright|couch|face|inverted|ring)/, rules: [[n => /\brows?\b/.test(n) && LV_DB.test(n), 2.25], [n => /\brows?\b/.test(n), 1]] },
  legs: { ref: 'leg press', goal: 300 * LV_12, no: /\b(bodyweight|kettlebell|kb|goblet|split|single|lunge|wide single|curl|extension|calf|jump)/, rules: [
    [n => /leg press/.test(n), 1], [n => /pendulum|hack|belt squat/.test(n), 1.8], [n => /hex bar squat|trap bar squat/.test(n), 1.4], [n => /\bsquat/.test(n), 1.6]] },
  glutes: { ref: 'hip thrust', goal: 300 * LV_12, no: /\b(single|one.?leg|kettlebell|kb)/, rules: [
    [n => /hip thrust|glute bridge/.test(n), 1], [n => /romanian|\brdl\b|stiff/.test(n), 1.45], [n => /(hex|trap) bar deadlift/.test(n), 1], [n => /deadlift/.test(n), 1.1]] },
  arms: { ref: 'barbell curl', goal: 90 * LV_12, no: /\b(leg|hamstring|wrist|mace|nordic)/, rules: [
    [n => /curl/.test(n) && (LV_DB.test(n) || /hammer/.test(n)), 2.4], [n => /(bar|barbell|ez|ez-bar|cable) curl/.test(n), 1], [n => /curl/.test(n), 0.9]] },
};
const LV_SKILLS = [
  { k: 'chest', name: 'Chest', group: 'Strength' }, { k: 'shoulders', name: 'Shoulders', group: 'Strength' },
  { k: 'lats', name: 'Lats', group: 'Strength' }, { k: 'back', name: 'Back', group: 'Strength' },
  { k: 'legs', name: 'Legs', group: 'Strength' }, { k: 'glutes', name: 'Glutes', group: 'Strength' },
  { k: 'arms', name: 'Arms', group: 'Strength' },
  { k: 'chestSize', name: 'Chest size', group: 'Size', meas: 'chest', goal: 46 },
  { k: 'armSize', name: 'Arm size', group: 'Size', meas: 'arm', goal: 16 },
  { k: 'thighSize', name: 'Thigh size', group: 'Size', meas: 'thigh', goal: 26 },
  { k: 'waist', name: 'Waist', group: 'Size', meas: 'waist', goal: 34, lower: true },
  { k: 'weight', name: 'Bodyweight', group: 'Athlete' },
  { k: 'cardio', name: 'Cardio', group: 'Athlete', goal: 60 / 8.5 },
  { k: 'habit', name: 'Consistency', group: 'Athlete', goal: 40 },
];
const LV_TRY = {
  chest: 'Get both weekly presses in (incline and flat), 3 hard sets each, stopping 1–2 reps short of failure.',
  shoulders: 'Press overhead once a week and keep the lateral raises going.',
  lats: 'Do pulldowns or pull-ups twice a week, and add a rep before you add weight.',
  back: 'Row twice a week, with a short squeeze at the top of each rep.',
  legs: 'Leg press or pendulum squat every week, 8–12 smooth reps, adding a little at a time.',
  glutes: 'Keep hip thrusts in twice a week, plus your RDLs.',
  arms: 'Do curls and pushdowns twice a week, close to failure.',
  chestSize: 'Keep chest work twice a week and eat enough to grow. Measure the same spot each time.',
  armSize: 'Do curls and pushdowns twice a week, close to failure. Measure flexed, at the biggest part.',
  thighSize: 'Keep leg press, split squats, and RDLs in, and eat enough to grow.',
  waist: "That one's mostly diet: a small daily trim while keeping protein high.",
  cardio: 'One easy run a week keeps it, and a faster one raises it.',
  habit: 'Aim for 3 lifting days and 2 cardio days a week. Showing up is the biggest lever there is.',
};
const lvGoal = sk => (LV_LIFTS[sk.k] ? LV_LIFTS[sk.k].goal : sk.k === 'weight' ? Math.round(25 * (S.settings.profile.heightIn || 75) ** 2 / 703) : sk.goal);
function lvLevel(v, base, goal, lower) {
  const span = lower ? base - goal : goal - base;
  const t = span > 0 ? (lower ? base - v : v - base) / span : (lower ? v <= goal : v >= goal) ? 1 : 0;
  return 1 + (LV_MAX - 1) * Math.min(1, Math.max(0, t));
}
const lvFirstDate = () => S.workouts.filter(w => w.date <= todayStr() && hasWork(w)).map(w => w.date).sort()[0] || null;
// Bodyweight: the average of the last two weeks of weigh-ins (before the first weigh-in, the first one).
function lvWeight(date) {
  const all = Object.values(S.body).filter(b => b.weight != null && +b.weight > 0).sort((a, c) => a.date.localeCompare(c.date));
  if (!all.length) return null;
  const near = all.filter(b => b.date <= date && b.date >= addDays(date, -13));
  if (near.length) return { v: sum(near.map(b => +b.weight)) / near.length, n: near.length };
  const before = all.filter(b => b.date <= date);
  return { v: +(before.length ? before[before.length - 1] : all[0]).weight };
}
function lvMeas(key, date) {
  const all = Object.values(S.body).filter(b => b.meas && +b.meas[key] > 0).sort((a, c) => a.date.localeCompare(c.date));
  if (!all.length) return null;
  const before = all.filter(b => b.date <= date), b = before.length ? before[before.length - 1] : all[0];
  return { v: +b.meas[key], on: b.date };
}
// Every lift session turned into reference-lift numbers, per skill, plus runs as speed (mph).
function lvSessions() {
  const out = { cardio: [] }, today = todayStr();
  Object.keys(LV_LIFTS).forEach(k => { out[k] = []; });
  S.workouts.filter(w => w.date <= today).forEach(w => {
    (w.exercises || []).forEach(e => {
      const n = normName(e.name).toLowerCase(), note = ((e.target || {}).note || '').toLowerCase();
      if (/stack|#/.test(n) || /stack|assist/.test(note) || e.pin) return;
      for (const [k, sk] of Object.entries(LV_LIFTS)) {
        if (sk.no.test(n)) continue;
        const rule = sk.rules.find(([m]) => m(n));
        if (!rule) continue;
        const f = rule[1];
        let best = 0, top = null;
        doneSets(e).filter(s => +s.r >= 1 && +s.r <= 15).forEach(s => {
          const wt = f === 'bw' ? ((lvWeight(w.date) || {}).v || 185) + (+s.w || 0) : +s.w;
          const v = wt > 0 ? e1rm(wt, +s.r) * (f === 'bw' ? 0.8 : f) : 0;
          if (v > best) { best = v; top = s; }
        });
        if (best) out[k].push({ date: w.date, v: best, f, name: e.name, set: `${+top.w ? `${+top.w}×` : ''}${top.r}` });
        break;
      }
    });
    (w.activities || []).forEach(a => {
      // Each run counts as its 5K-equal pace (Riegel's formula), so a fast mile isn't worth the same as a fast 5K.
      const p = a.type === 'run' && a.style !== 'intervals' && +a.dist >= 1 ? paceOf(a) : null;
      if (p && p > 4.5 && p < 20) out.cardio.push({ date: w.date, v: 60 / (p * Math.pow(3.107 / +a.dist, 0.06)), name: `${a.dist} mi run`, set: `${fmtPace(p)} /mi` });
    });
  });
  Object.values(out).forEach(l => l.sort((a, c) => a.date.localeCompare(c.date)));
  return out;
}
// A lift skill's value on a date: the best of its last six weeks of sessions. After three weeks
// without it, it fades about 2% a week (to 75% at most), because strength does too.
function lvLiftAt(list, date) {
  let i = list.length - 1;
  while (i >= 0 && list[i].date > date) i--;
  if (i < 0) return list.length ? { v: list[0].v, idle: 0, best: list[0] } : null;
  const from = addDays(list[i].date, -42), days = new Set();
  let best = list[i];
  for (let j = i; j >= 0 && list[j].date >= from; j--) { days.add(list[j].date); if (list[j].v > best.v) best = list[j]; }
  const idle = daysBetween(list[i].date, date);
  return { v: best.v * (idle > 21 ? Math.max(0.75, 1 - 0.02 * (idle - 21) / 7) : 1), idle, best, n: days.size };
}
function lvValue(sk, ses, date) {
  if (LV_LIFTS[sk.k] || sk.k === 'cardio') return lvLiftAt(ses[sk.k], date);
  if (sk.meas) return lvMeas(sk.meas, date);
  if (sk.k === 'weight') return lvWeight(date);
  if (sk.k === 'habit') {
    if (!lvFirstDate()) return null;
    const from = addDays(date, -55);
    return { v: new Set(S.workouts.filter(w => w.date >= from && w.date <= date && hasWork(w)).map(w => w.date)).size };
  }
  return null;
}
// Level 1 is the lowest point on record: checked week by week from your first workout to today.
// Lift skills only count weeks backed by 2+ sessions in the last six weeks, so one lone light session
// after a break (a single set of easy dumbbell rows) can't set level 1 too low.
function lvLowest(sk, ses) {
  const today = todayStr(), first = lvFirstDate() || today;
  let low = null, sturdy = null;
  for (let d = first; ; d = addDays(d, 7)) {
    const at = d > today ? today : d, x = lvValue(sk, ses, at);
    if (x && (low == null || (sk.lower ? x.v > low : x.v < low))) low = x.v;
    if (x && LV_LIFTS[sk.k] && x.n >= 2 && (sturdy == null || x.v < sturdy)) sturdy = x.v;
    if (at === today) break;
  }
  return sturdy ?? low;
}
function lvCompute() {
  const ses = lvSessions(), today = todayStr(), bases = (S.settings.levels || {}).bases || {};
  const skills = [];
  LV_SKILLS.forEach(sk => {
    const cur = lvValue(sk, ses, today);
    if (!cur) return;
    const base = bases[sk.k] ?? lvLowest(sk, ses), goal = lvGoal(sk);
    skills.push({ ...sk, ...cur, base, goal, lv: lvLevel(cur.v, base, goal, sk.lower) });
  });
  return skills;
}
// Level history: rebuilt from your saved workouts and measurements, one point a week from your first
// workout to today, using the same level 1 starting points. Cached until your log changes.
let lvHistCache = null;
function lvHistory(skills) {
  const today = todayStr(), recent = S.workouts.slice(-12).map(w => `${w.date}${(w.exercises || []).map(e => doneSets(e).length).join('')}${(w.activities || []).length}`).join('|');
  const key = `${today}#${S.workouts.length}#${Object.keys(S.body).length}#${skills.map(k => k.k + k.base).join()}#${recent}`;
  if (lvHistCache && lvHistCache.key === key) return lvHistCache;
  const ses = lvSessions(), first = lvFirstDate() || today, by = {}, overall = [];
  skills.forEach(k => { by[k.k] = []; });
  for (let d = first; ; d = addDays(d, 7)) {
    const at = d > today ? today : d, t = parseYmd(at).getTime(), lvs = [];
    skills.forEach(k => {
      const x = lvValue(k, ses, at);
      const lv = x ? lvLevel(x.v, k.base, k.goal, k.lower) : 1;
      by[k.k].push([t, Math.round(lv * 10) / 10]); lvs.push(lv);
    });
    if (lvs.length) overall.push([t, Math.round(sum(lvs) / lvs.length * 10) / 10]);
    if (at === today) break;
  }
  return (lvHistCache = { key, by, overall });
}
const LV_RANGES = [[91, '3 months'], [365, 'Year'], [0, 'All']];
function lvChart(pts) {
  const days = S.lvRange ?? 0, from = days ? Date.now() - days * 864e5 : 0, p = pts.filter(q => q[0] >= from);
  return p.length > 1 ? lineChart([{ name: 'Level', color: 'var(--acc)', pts: p }]) : '<p class="muted small">Not enough history in this range yet.</p>';
}
const lvRangeSeg = () => `<div class="seg lv-range">${LV_RANGES.map(([d, n]) => `<button class="${(S.lvRange ?? 0) === d ? 'on' : ''}" data-a="lv-range" data-v="${d}">${n}</button>`).join('')}</div>`;
const lvOverall = shown => { const v = Object.values(shown); return v.length ? Math.floor(sum(v) / v.length) : 1; };
// Lift numbers show in the lift you actually did lately (your DB bench, your RDL), as weight for 12 reps.
const lvF = s => (LV_LIFTS[s.k] && s.best && typeof s.best.f === 'number' ? s.best.f : 1);
const lvLift = s => (lvF(s) !== 1 || (s.best && s.best.f === 1) ? lvLower(normName(s.best.name)).replace(/\bromanian\b/, 'Romanian') : LV_LIFTS[s.k].ref);
function lvFmt(sk, v) {
  if (v == null) return '–';
  if (LV_LIFTS[sk.k]) return `${Math.round(v / lvF(sk) / LV_12)} lb × 12`;
  if (sk.meas) return `${round1(v)}"`;
  if (sk.k === 'weight') return `${round1(v)} lb`;
  if (sk.k === 'cardio') return `${fmtPace(60 / v)} /mi 5K pace`;
  return `${Math.round(v)} workouts`;
}
// The value a level starts at, for "next level at …".
const lvValueFor = (s, lv) => s.base + (s.lower ? -1 : 1) * Math.abs(s.goal - s.base) * (lv - 1) / (LV_MAX - 1);
const lvLower = n => (/^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n);
function lvWhy(s, was) {
  const old = was != null && lvFmt(s, was) !== lvFmt(s, s.v) ? was : null;
  if ((LV_LIFTS[s.k] || s.k === 'cardio') && s.idle > 21) return `No ${s.k === 'cardio' ? 'runs' : `${s.name.toLowerCase()} work`} logged in ${Math.round(s.idle / 7)} weeks, so it's fading.`;
  if (LV_LIFTS[s.k]) return `Your best ${lvLift(s)} set lately was ${s.best.set.replace('×', ' × ')}, about ${lvFmt(s, s.v)}${old ? `, down from ${lvFmt(s, old)}` : ''}.`;
  if (s.k === 'cardio') return `Your best recent pace is ${lvFmt(s, s.v)}${old ? `, down from ${lvFmt(s, old)}` : ''}.`;
  if (s.k === 'weight') return `Your two-week average is ${lvFmt(s, s.v)}${old ? `, down from ${lvFmt(s, old)}` : ''}.`;
  if (s.k === 'waist') return `Your waist measured ${lvFmt(s, s.v)}${old ? `, up from ${lvFmt(s, old)}` : ''}.`;
  if (s.meas) return `Your ${s.name.toLowerCase().replace(' size', '')} measured ${lvFmt(s, s.v)}${old ? `, down from ${lvFmt(s, old)}` : ''}.`;
  return `${Math.round(s.v)} workout days in the last 8 weeks${old ? `, down from ${Math.round(old)}` : ''}.`;
}
const lvTry = s => (s.k === 'weight' ? `For size, hold steady or gain slowly: eat a little more and hit your protein (${liveTarget(todayStr())} g).` : LV_TRY[s.k]);

// ---------- outlook ----------
// When you'll reach each goal if you keep going. Every body area's level (1 to 60) is read as progress
// along one growth curve for steady training: p = 1 - e^(-weeks / 43.5). That puts "you see it" near
// 3 months, "others notice" near 6, and Halloween-ready near a year of consistent work, which matches
// typical natural gains for a returning lifter (fast at first thanks to muscle memory, then slower).
// Your pace scales it: lifting days done out of 3 a week over the last 4 weeks, times how fast your
// levels have actually grown compared with the curve. Breaks slow the pace (and fade levels), workouts
// speed it up, so the dates move after every workout and every nightly check-in.
const OL_TAU = 43.5, OL_HALLOWEEN = '2027-10-31';
const olP = w => 1 - Math.exp(-Math.max(0, w) / OL_TAU);
const olW = p => -OL_TAU * Math.log(1 - Math.min(0.995, Math.max(0, p)));
const lvP = lv => (lv - 1) / (LV_MAX - 1);
const OL_AREAS = [
  { k: 'chest', name: 'Chest', of: ['chest', 'chestSize'], look: 'a full, square chest that fills out a shirt' },
  { k: 'glutes', name: 'Glutes', of: ['glutes'], look: 'round, strong glutes from the side' },
  { k: 'back', name: 'Back', of: ['lats', 'back'], look: 'a wide V from behind' },
  { k: 'shoulders', name: 'Shoulders', of: ['shoulders'], look: 'capped, wide shoulders' },
  { k: 'arms', name: 'Arms', of: ['arms', 'armSize'], look: 'tank-top arms (about 15.5" flexed)' },
];
const OL_MILES = [
  { k: 'mirror', p: 0.25, title: 'You see it in the mirror', body: 'Fuller chest and shoulders, tighter shirts. You notice first.' },
  { k: 'notice', p: 0.45, title: 'Others notice', body: '"Damn, that dude works out." Friends ask what you\'re doing.' },
  { k: 'tank', p: 0.6, title: 'Tank-top arms', body: 'Arms and shoulders that pop in a tank top.', areas: ['arms', 'shoulders'] },
  { k: 'halloween', p: 0.7, title: 'Halloween-ready', body: 'Lean, strong, and athletic with very little on.' },
  { k: 'built', p: 0.92, title: 'Fully built', body: 'The polished, athletic build. From here it\'s keeping and refining.' },
];
// The last comeback: the first workout after 3+ weeks off (your clock starts there).
function olRestart() {
  const ds = [...new Set(S.workouts.filter(w => w.date <= todayStr() && (w.exercises || []).some(e => doneSets(e).length)).map(w => w.date))].sort();
  for (let i = ds.length - 1; i > 0; i--) if (daysBetween(ds[i - 1], ds[i]) >= 21) return ds[i];
  return ds[0] || todayStr();
}
// Lifting days in the last 4 weeks (or since you came back) out of 3 a week. Two weeks at a typical 85%
// are blended in, so one great or missed week early on doesn't swing every date.
function olConsistency() {
  const today = todayStr(), from = [addDays(today, -27), olRestart()].sort()[1];
  const days = new Set(S.workouts.filter(w => w.date >= from && w.date <= today && (w.exercises || []).some(e => doneSets(e).length)).map(w => w.date)).size;
  const wks = Math.max(1, (daysBetween(from, today) + 1) / 7), per = plannedKeys().filter(k => S.program.days[k].type === 'strength').length || 3;
  return { c: Math.max(0.15, Math.min(1, (days + 0.85 * per * 2) / (per * (wks + 2)))), days, wks, per };
}
function olCompute() {
  const skills = lvCompute(), by = Object.fromEntries(skills.map(x => [x.k, x])), today = todayStr();
  if (!skills.some(x => LV_LIFTS[x.k])) return null;
  const hist = lvHistory(skills), con = olConsistency();
  const weeksLeft = Math.max(0, daysBetween(today, OL_HALLOWEEN) / 7);
  const areas = OL_AREAS.map(a => {
    const parts = a.of.map(k => by[k]).filter(Boolean);
    if (!parts.length) return null;
    const p = sum(parts.map(x => lvP(x.lv))) / parts.length;
    // Your real growth over the last 6 weeks against what the curve expects for the lifting you did.
    const pts = a.of.map(k => (hist.by[k] || [])).filter(x => x.length);
    let r = 1;
    if (pts.length) {
      const back = pts.map(x => x[Math.max(0, x.length - 7)][1]), past = sum(back.map(lvP)) / back.length;
      const span = Math.min(6, daysBetween(olRestart(), today) / 7), want = olP(olW(past) + span * con.c) - past;
      if (span >= 3 && want > 0.01) r = Math.max(0.6, Math.min(1.6, (p - past) / want));
    }
    const pace = con.c * r, w = olW(p);
    const when = target => (p >= target ? today : pace > 0 ? addDays(today, Math.round(((olW(target) - w) / pace) * 7)) : null);
    return { ...a, parts, p, lv: Math.floor(1 + p * (LV_MAX - 1)), r, pace, w, when, atH: olP(w + weeksLeft * pace) };
  }).filter(Boolean);
  if (!areas.length) return null;
  const mean = f => sum(areas.map(f)) / areas.length;
  const miles = OL_MILES.map(m => {
    const list = m.areas ? areas.filter(a => m.areas.includes(a.k)) : areas;
    // A milestone lands when most of its areas get there (the middle date).
    const ds = list.map(a => a.when(m.p)).filter(Boolean).sort();
    return { ...m, date: ds.length ? ds[Math.floor((ds.length - 1) / 2)] : null, done: list.every(a => a.p >= m.p) };
  });
  // Back to your old bests: lifts at or above their best from the year before your comeback.
  const ses = lvSessions(), start = olRestart();
  const old = Object.keys(LV_LIFTS).map(k => {
    const before = (ses[k] || []).filter(x => x.date < start && x.date >= addDays(start, -365));
    return before.length && by[k] ? { k, best: Math.max(...before.map(x => x.v)), now: by[k].v } : null;
  }).filter(Boolean);
  const back = old.filter(x => x.now >= x.best * 0.99).length;
  // How far along you are today toward the Halloween look (each area counts the same).
  const ready = Math.round(mean(a => Math.min(1, a.p / 0.7)) * 100);
  const lean = addDays(OL_HALLOWEEN, -84);
  return { areas, miles, con, ready, weeksLeft, old: { n: old.length, back }, lean, pace: mean(a => a.pace), today };
}
// Strength standards in the lift you actually do: now, at the Halloween look (70% of the way from your
// level 1 to the fully built goal), and fully built. Weights for 12 reps, rounded to 5 lb (2.5 for dumbbells).
function olLiftTargets(a) {
  return a.parts.filter(x => LV_LIFTS[x.k] && x.best).map(x => {
    const f = lvF(x), step = f > 1.5 ? 2.5 : 5, lb = v => Math.max(step, Math.round(v / f / LV_12 / step) * step);
    const at = p => x.base + (x.goal - x.base) * p, name = lvLift(x), db = f > 1.5 ? ' (each hand)' : '';
    return { name: name[0].toUpperCase() + name.slice(1), now: lb(x.v), h: lb(Math.max(x.v, at(0.7))), built: lb(Math.max(x.v, x.goal)), db };
  });
}
// One snapshot a day, so the tab can say what moved (and the nightly trainer can see it).
function olSnap(o) {
  if (!o) return;
  const st = S.settings.outlook = S.settings.outlook || { log: [] }, today = todayStr();
  const snap = { d: today, h: o.ready, c: Math.round(o.con.c * 100) / 100, m: Object.fromEntries(o.miles.map(m => [m.k, m.date])), a: Object.fromEntries(o.areas.map(a => [a.k, a.lv])) };
  const last = st.log[st.log.length - 1];
  if (last && last.d === today) { if (JSON.stringify(last) === JSON.stringify(snap)) return; st.log[st.log.length - 1] = snap; } else st.log.push(snap);
  st.log = st.log.slice(-120);
  saveSettings();
}
const olMonth = d => (d ? fmtDate(d, { month: 'short', year: 'numeric' }) : 'Not yet');
function viewOutlook() {
  const o = olCompute();
  if (!o) return `<header class="top"><h1>Outlook</h1></header><div class="card empty"><b>Log a few workouts first</b>Your timeline shows up once there are lifts to build from.</div>`;
  olSnap(o);
  const log = (S.settings.outlook || {}).log || [], wkAgo = [...log].reverse().find(x => x.d <= addDays(o.today, -7)) || log[0];
  const dh = wkAgo && wkAgo.d !== o.today ? o.ready - wkAgo.h : 0;
  const moved = k => { const a = wkAgo && wkAgo.d !== o.today && wkAgo.m[k], b = o.miles.find(m => m.k === k).date; if (!a || !b) return ''; const n = daysBetween(b, a); return Math.abs(n) < 4 ? '' : `<span class="ol-move ${n > 0 ? 'up' : 'down'}">${n > 0 ? `${n} days sooner` : `${-n} days later`}</span>`; };
  const H = o.miles.find(m => m.k === 'halloween'), onTrack = H.date && H.date <= OL_HALLOWEEN;
  const perWk = round1(o.con.c * o.con.per);
  const lean = o.today < o.lean ? `<div class="ol-mile"><i class="ol-dot plan"></i><div><b>Lean-out starts</b><span class="ol-date">${esc(fmtDate(o.lean, { month: 'short', day: 'numeric', year: 'numeric' }))}</span><p>12 weeks of a small calorie trim (about 0.5 to 0.75% of bodyweight a week), protein high, lifting heavy, so the muscle shows. Until then: grow.</p></div></div>` : '';
  const miles = o.miles.map(m => `<div class="ol-mile ${m.done ? 'done' : ''}"><i class="ol-dot ${m.done ? 'done' : ''}">${m.done ? ic('check') : ''}</i><div><b>${esc(m.title)}</b><span class="ol-date">${m.done ? 'Done' : esc(olMonth(m.date))}</span>${moved(m.k)}<p>${esc(m.body)}</p></div></div>`);
  miles.splice(3, 0, lean);
  const first = o.old.n ? `<div class="ol-mile ${o.old.back >= o.old.n ? 'done' : ''}"><i class="ol-dot ${o.old.back >= o.old.n ? 'done' : ''}">${o.old.back >= o.old.n ? ic('check') : ''}</i><div><b>Back to your old bests</b><span class="ol-date">${o.old.back} of ${o.old.n} lifts</span><p>Muscle memory brings these back fast, usually 4 to 8 weeks of steady lifting.</p></div></div>` : '';
  const areas = o.areas.map(a => {
    const d = a.when(0.7), status = a.p >= 0.7 ? ['good', 'There'] : d && d <= OL_HALLOWEEN ? (a.r > 1.15 ? ['good', 'Ahead'] : ['good', 'On pace']) : ['warn', 'Behind'];
    return `<div class="ol-area"><div class="ol-area-top"><b>${esc(a.name)}</b><span class="ol-tag ${status[0]}">${status[1]}</span></div>
      <div class="prog ${a.p >= 0.7 ? 'hit' : ''}"><div style="width:${Math.round(Math.min(1, a.p / 0.7) * 100)}%"></div></div>
      <div class="sh-hint">Lv ${a.lv} now · Halloween look at Lv ${Math.ceil(1 + 0.7 * (LV_MAX - 1))} · ${a.p >= 0.7 ? 'reached' : `about ${esc(olMonth(d))}`}</div>
      ${olLiftTargets(a).map(t => `<div class="ol-lift"><span>${esc(t.name)}${t.db}</span><b>${t.now} → ${t.h} lb × 12</b></div>`).join('')}
      <div class="ol-look">Goal: ${esc(a.look)}.${a.p < 0.7 && LV_TRY[a.of[0]] ? ` ${esc(LV_TRY[a.of[0]])}` : ''}</div></div>`;
  }).join('');
  const note = S.settings.outlookNote;
  return `<header class="top"><h1>Outlook</h1></header>
    <div class="card ol-hero">
      <div class="lbl">Halloween 2027 · ${Math.round(o.weeksLeft)} weeks</div>
      <div class="ol-big"><span>${o.ready}%</span><small>of the way to your Halloween look${dh ? ` <b class="ol-move ${dh > 0 ? 'up' : 'down'}">${dh > 0 ? '+' : ''}${dh}% this week</b>` : ''}</small></div>
      <div class="prog ${o.ready >= 100 ? 'hit' : ''}"><div style="width:${o.ready}%"></div></div>
      <p class="sh-hint">${onTrack ? `On track: at ${perWk} lifting days a week you get there around <b>${esc(fmtDate(H.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</b>, ahead of Oct 31.` : `At ${perWk} lifting days a week it lands around <b>${esc(olMonth(H.date))}</b>, after Oct 31. All ${o.con.per} lifting days a week pulls it in.`} Every workout moves this, and so do breaks.</p>
    </div>
    ${note && note.text ? `<div class="card tr-card"><div class="lbl">From your trainer · ${esc(fmtDate(note.date, { month: 'short', day: 'numeric' }))}</div><p>${esc(note.text)}</p></div>` : ''}
    <h2>Milestones</h2>
    <div class="card ol-miles">${first}${miles.join('')}</div>
    <h2>Your goals</h2>
    <p class="sh-hint" style="margin:-4px 4px 10px">Lift targets show now → Halloween, for 12 reps. The Halloween numbers are about 70% of the way to the fully built strength standards for your size.</p>
    <div class="card">${areas}</div>
    ${bodyTargetsCard()}
    ${inspoCard()}
    <p class="sh-hint center" style="margin:6px 12px 18px">Dates assume you keep your current pace. They come from your levels and a growth curve for steady natural training, and they're checked every night by your trainer.</p>`;
}

// ----- inspiration board -----
// Physiques you like, with your trainer's estimates, plus body targets sized for your height. The
// pictures and numbers come from your trainer (plan.look) or from you, and stay on this phone: they're
// not in backups, not in trainer syncs, and never in the app's code.
const INSPO_TIER = { h: ['good', 'Halloween'], lean: ['', 'Abs goal'], stretch: ['', '~2 years'], long: ['warn', '4+ years'] };
const INSPO_GROUPS = [['Short term', 'By Halloween 2027', ['h', 'lean']], ['Long term', 'Two years and beyond', ['stretch', 'long']], ['Your picks', '', [null]]];
const LOOK_ROWS = [['weight', 'Weight', ' lb'], ['bf', 'Body fat', '%'], ['chest', 'Chest', '″'], ['arm', 'Arms (flexed)', '″'], ['waist', 'Waist', '″'], ['thigh', 'Thighs', '″']];
const saveInspo = () => DB.put('kv', { k: 'inspo', v: S.inspo }).catch(saveFailed);
const fmtIn = n => `${Math.floor(n / 12)}′${Math.round(n % 12)}″`;
function lookNow(k) {
  if (k === 'weight') { const t = weightTrend(todayStr()); return t ? t.avg : null; }
  if (k === 'bf') { const t = ((S.settings.look || {}).targets || {}).bf; return t && t.now != null ? t.now : null; }
  const h = measureHistory().filter(b => b.meas[k]);
  return h.length ? h[h.length - 1].meas[k] : null;
}
function bodyTargetsCard() {
  const tg = (S.settings.look || {}).targets;
  if (!tg) return '';
  const rows = LOOK_ROWS.filter(([k]) => tg[k]).map(([k, n, u]) => {
    const now = lookNow(k), t = tg[k], f = v => (v == null ? '–' : `${k === 'bf' ? '~' : ''}${round1(v)}${u}`);
    return `<tr><th>${n}</th><td>${f(now)}</td><td class="acc">${f(t.h)}</td><td>${f(t.built)}</td></tr>`;
  }).join('');
  return `<h2>Body targets</h2>
    <div class="card"><table class="ol-tgt"><thead><tr><th></th><th>Now</th><th>Halloween</th><th>Built</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="sh-hint">Sized for your height (${esc(fmtIn(S.settings.profile.heightIn || 75))}) from the physiques you picked. Now uses your latest measurements and two-week weight average.</div></div>`;
}
function inspoCard() {
  const look = S.settings.look || {}, ps = S.inspo || [];
  return `<h2>Inspiration</h2>
    <div class="card">
      ${look.text ? `<p class="ol-insp-txt">${esc(look.text)}</p>` : ''}
      ${INSPO_GROUPS.map(([name, sub, tiers]) => {
        const g = tiers.flatMap(t => ps.filter(p => (INSPO_TIER[p.tier] ? p.tier : null) === t));
        return g.length ? `<div class="ol-insp-grp"><b>${name}</b>${sub ? `<small>${sub}</small>` : ''}</div>
      <div class="photos insp">${g.map(p => { const t = INSPO_TIER[p.tier]; return `<button data-a="inspo-open" data-id="${esc(p.id)}" aria-label="Inspiration photo"><img src="${p.img}" alt="" loading="lazy">${t ? `<span class="${t[0]}">${t[1]}</span>` : ''}</button>`; }).join('')}</div>` : '';
      }).join('')}
      <button class="btn block" data-a="inspo-add">+ Add a photo</button>
      <div class="sh-hint">Builds you want to work toward. Tap one for its estimates. They stay on this phone: not in backups or trainer syncs.</div>
    </div>`;
}
function inspoSheetHTML() {
  const p = (S.inspo || []).find(x => x.id === S.sheet.id);
  if (!p) return '';
  const e = p.est || {}, tg = (S.settings.look || {}).targets || {}, myH = S.settings.profile.heightIn || 75, t = INSPO_TIER[p.tier];
  const scaled = e.wt && e.htIn ? Math.round(e.wt * (myH / e.htIn) ** 2 / 5) * 5 : null;
  const rows = [['chest', 'Chest'], ['arm', 'Arms (flexed)'], ['waist', 'Waist'], ['thigh', 'Thighs']].filter(([k]) => e[k]).map(([k, n]) => {
    const now = lookNow(k), h = tg[k] && tg[k].h;
    return `<tr><th>${n}</th><td>${round1(e[k])}″</td><td>${now != null ? `${round1(now)}″` : '–'}</td><td class="acc">${h != null ? `${round1(h)}″` : '–'}</td></tr>`;
  }).join('');
  return `<div class="sh-grip"></div>
    <div class="sh-title">${p.mine ? 'Your pick' : t ? `${['h', 'lean'].includes(p.tier) ? 'Short term' : 'Long term'} · ${t[1]}` : 'Estimates'}</div>
    <div class="photo-view"><figure><img src="${p.img}" alt="Inspiration photo"></figure></div>
    ${e.wt ? `<p class="ol-insp-est">About <b>${esc(fmtIn(e.htIn || 70))}</b>, <b>${e.wt} lb</b>, <b>${esc(e.bf || '?')}</b> body fat.${scaled ? ` The same look at your height is about <b>${scaled} lb</b>.` : ''}</p>` : ''}
    ${rows ? `<table class="ol-tgt"><thead><tr><th></th><th>Him</th><th>You now</th><th>Halloween</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    ${p.take ? `<p class="ol-insp-est">${esc(p.take)}</p>` : ''}
    ${e.wt ? '<div class="sh-hint">Eyeball estimates from one photo, so give or take a few pounds and half an inch. Ad photos use lighting, pumps, and posing.</div>' : ''}
    <div class="sheet-actions">
      <button class="btn danger block" data-a="inspo-del">Remove from board</button>
      <button class="btn ghost block" data-a="sheet-close">Close</button>
    </div>`;
}
// The trainer's look update: targets, a short read, and a fresh set of pictures (yours stay).
function applyLook(l, id) {
  const n = (v, lo, hi) => (v != null && Number.isFinite(+v) && +v >= lo && +v <= hi ? +v : null);
  const s = (v, max) => String(v || '').trim().slice(0, max);
  const look = { id: String(id || '').slice(0, 60), date: todayStr(), text: s(l.text, 900), targets: {} };
  const lim = { weight: [90, 400], bf: [3, 40], chest: [25, 70], arm: [8, 30], waist: [20, 60], thigh: [12, 45] };
  Object.entries(lim).forEach(([k, [lo, hi]]) => {
    const t = l.targets && l.targets[k];
    if (t && (n(t.h, lo, hi) != null || n(t.built, lo, hi) != null)) look.targets[k] = { h: n(t.h, lo, hi), built: n(t.built, lo, hi), now: n(t.now, lo, hi) };
  });
  if (!Object.keys(look.targets).length) delete look.targets;
  S.settings.look = look;
  saveSettings();
  if (Array.isArray(l.pics)) {
    const pics = l.pics.slice(0, 30).filter(p => p && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.img || '') && p.img.length < 600000).map((p, i) => {
      const e = p.est || {};
      return {
        id: s(p.id, 30) || `t${i}`, img: p.img, tier: INSPO_TIER[p.tier] ? p.tier : null, take: s(p.take, 300),
        est: { htIn: n(e.htIn, 55, 90), wt: n(e.wt, 90, 400), bf: s(e.bf, 12), chest: n(e.chest, 25, 70), arm: n(e.arm, 8, 30), waist: n(e.waist, 20, 60), thigh: n(e.thigh, 12, 45) },
      };
    });
    S.inspo = [...pics, ...(S.inspo || []).filter(p => p.mine)];
    saveInspo();
  }
}

// Runs after every render: level-ups right away, level drops once a day.
function checkLevels() {
  if (S.lvChecking || document.querySelector('.lv-pop')) return;
  S.lvChecking = true;
  try {
    const skills = lvCompute(), today = todayStr();
    if (!skills.length) return;
    let st = S.settings.levels;
    if (!st || !st.shown) {
      st = S.settings.levels = { bases: {}, shown: {}, vals: {}, downDay: today, v: LV_V };
      skills.forEach(s => { st.bases[s.k] = s.base; st.shown[s.k] = Math.floor(s.lv); st.vals[s.k] = s.v; });
      saveSettings();
      lvPop({ kind: 'intro', overall: lvOverall(st.shown), n: skills.length });
      return;
    }
    // Nov 2026 trainer check-up: new legs and waist goals and sturdier level 1 starting points. Levels
    // move to where they now land without any pop-up, since nothing about you changed.
    if ((st.v || 1) < LV_V) {
      const ses = lvSessions();
      skills.forEach(s => { if (LV_LIFTS[s.k]) { const b = lvLowest(s, ses); if (b != null) { st.bases[s.k] = b; s.base = b; } } s.lv = lvLevel(s.v, s.base, s.goal, s.lower); st.shown[s.k] = Math.floor(s.lv); st.vals[s.k] = s.v; });
      st.v = LV_V; saveSettings();
      return;
    }
    const before = lvOverall(st.shown), ups = [], downs = [], checkDown = st.downDay !== today;
    let changed = false;
    skills.forEach(s => {
      const was = st.shown[s.k];
      if (was == null) { st.bases[s.k] = s.base; st.shown[s.k] = Math.floor(s.lv); st.vals[s.k] = s.v; changed = true; return; }
      if (Math.floor(s.lv) > was) ups.push({ s, from: was, to: Math.floor(s.lv) });
      else if (checkDown && s.lv < was - 1) downs.push({ s, from: was, to: Math.floor(s.lv) + 1, old: st.vals[s.k] });
    });
    if (checkDown) { st.downDay = today; changed = true; }
    [...ups, ...downs].forEach(c => { st.shown[c.s.k] = c.to; st.vals[c.s.k] = c.s.v; changed = true; });
    if (changed) saveSettings();
    const after = lvOverall(st.shown);
    if (ups.length) lvPop({ kind: 'up', list: ups, from: before, to: downs.length ? before : after });
    if (downs.length) lvPop({ kind: 'down', list: downs, from: before, to: after });
  } finally { S.lvChecking = false; }
}

// ----- level pop-ups -----
const lvQueue = [];
function lvPop(p) { lvQueue.push(p); if (!document.querySelector('.lv-pop')) lvNext(); }
function lvNext() {
  const p = lvQueue.shift();
  if (!p) return;
  const el = document.createElement('div');
  el.className = `lv-pop ${p.kind === 'down' ? 'down' : 'up'}`;
  el.setAttribute('role', 'dialog');
  el.innerHTML = lvPopHTML(p);
  document.body.appendChild(el);
  haptic();
  lvSound(p.kind === 'down' ? sadTrombone : fanfare);
}
function lvPopHTML(p) {
  const conf = p.kind === 'down' ? '' : `<div class="lv-conf" aria-hidden="true">${Array.from({ length: 18 }, (_, k) => `<i style="--x:${(k * 37) % 100}%;--d:${(k % 6) * 0.12}s;--c:${['var(--acc)', '#ffd34e', '#7cc6ff', '#ff8fb1'][k % 4]}"></i>`).join('')}</div>`;
  if (p.kind === 'intro') {
    return `<div class="lv-box">${conf}
      <div class="lv-kicker">Levels unlocked</div>
      <div class="lv-num">${p.overall}</div>
      <div class="lv-sub">Your overall level, the average of ${p.n} skills. Each one runs from 1, your lowest point on record, to 60, fully built and athletic. Lift more, grow, and show up, and they climb. Slack off and they slip.</div>
      <div class="btn-row"><button class="btn" data-a="lv-close">Let's go</button><button class="btn pri" data-a="lv-close" data-go="stats">See my skills</button></div>
    </div>`;
  }
  const overall = p.to !== p.from;
  if (p.kind === 'up') {
    const top = p.list[0];
    return `<div class="lv-box">${conf}
      <div class="lv-kicker">${overall ? 'Level up!' : `${esc(top.s.name)} level up!`}</div>
      <div class="lv-num">${overall ? p.to : top.to}</div>
      <div class="lv-sub">${overall ? `Overall level ${p.from} → ${p.to}` : `Overall level ${p.to}. Keep stacking.`}</div>
      <div class="lv-list">${p.list.map(c => `<div class="lv-row"><b>${esc(c.s.name)}</b><span>${c.from} → <em>${c.to}</em></span></div>`).join('')}</div>
      <button class="btn pri block" data-a="lv-close">Let's go</button>
    </div>`;
  }
  return `<div class="lv-box">
    <div class="lv-sad" aria-hidden="true">😞</div>
    <div class="lv-kicker">${overall ? 'Level lost' : `${p.list.length > 1 ? 'Skills' : esc(p.list[0].s.name)} slipped`}</div>
    <div class="lv-num">${overall ? p.to : p.list[0].to}</div>
    <div class="lv-sub">${overall ? `Overall level ${p.from} → ${p.to}` : `Overall level ${p.to}, for now.`}</div>
    <div class="lv-list">${p.list.map(c => `<div class="lv-drop"><div class="lv-row"><b>${esc(c.s.name)}</b><span>${c.from} → <em>${c.to}</em></span></div>
      <p>${esc(lvWhy(c.s, c.old))}</p><p class="lv-fix"><b>To win it back:</b> ${esc(lvTry(c.s))}</p></div>`).join('')}</div>
    <button class="btn block" data-a="lv-close">I'll get it back</button>
  </div>`;
}
// Sound needs a tap first on iPhone. A pop-up that opens before any tap plays its sound on the next tap,
// unless that tap closes it.
function lvSound(fn) {
  if (!S.settings.sound) return;
  if (actx && actx.state === 'running') { try { fn(); } catch (e) { /* no audio */ } } else S.lvSoundPending = fn;
}
function lvTone(f, t, len, type, vol, dest) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(dest || actx.destination);
  o.start(t);
  o.stop(t + len + 0.05);
  return o;
}
function fanfare() {
  const t = actx.currentTime + 0.03;
  [[392, 0], [523, 0.11], [659, 0.22], [784, 0.33]].forEach(([f, d]) => lvTone(f, t + d, 0.14, 'square', 0.08));
  [523, 659, 784, 1047].forEach(f => lvTone(f, t + 0.46, 1.1, 'triangle', 0.14));
  lvTone(1568, t + 0.46, 1.1, 'sine', 0.05);
}
function sadTrombone() {
  const t = actx.currentTime + 0.03, lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1100; lp.connect(actx.destination);
  [[294, 0, 0.36], [277, 0.4, 0.36], [262, 0.8, 0.36], [247, 1.2, 1.3]].forEach(([f, d, len], k) => {
    const o = lvTone(f, t + d, len, 'sawtooth', 0.13, lp);
    if (k === 3) {
      const l = actx.createOscillator(), lg = actx.createGain();
      l.frequency.value = 5.5; lg.gain.value = 7;
      l.connect(lg).connect(o.frequency);
      l.start(t + d + 0.2); l.stop(t + d + len);
      o.frequency.linearRampToValueAtTime(f * 0.93, t + d + len);
    }
  });
}

// ----- levels card (Stats) and pill (Today) -----
function levelsCard() {
  const st = S.settings.levels;
  if (!st || !st.shown) return '';
  const skills = lvCompute();
  if (!skills.length) return '';
  const overall = lvOverall(st.shown), total = sum(skills.map(s => st.shown[s.k] || 1));
  const open = skills.find(s => s.k === S.lvOpen);
  const tile = s => {
    const lv = st.shown[s.k] || 1, prog = lv >= LV_MAX ? 1 : Math.min(1, Math.max(0, s.lv - lv));
    return `<button class="lv-tile ${S.lvOpen === s.k ? 'on' : ''}" data-a="lv-info" data-k="${s.k}" aria-label="${esc(s.name)} level ${lv}">
      <span>${esc(s.name)}</span><b>${lv}</b><i style="--p:${Math.round(prog * 100)}%"></i></button>`;
  };
  const groups = [...new Set(skills.map(s => s.group))];
  return `<div class="card lv-card">
    <div class="lv-head"><div class="lv-big">${overall}</div>
      <div><b>Overall level</b><div class="muted small">Total ${total} of ${skills.length * LV_MAX} · tap a skill for details</div></div></div>
    ${S.lvHist ? `<div class="lv-hist">${lvRangeSeg()}${lvChart(lvHistory(skills).overall)}</div>` : ''}
    <button class="lv-hist-btn" data-a="lv-hist">${S.lvHist ? 'Hide history' : 'Show history'}</button>
    ${groups.map(g => `<div class="lbl">${g}</div><div class="lv-grid">${skills.filter(s => s.group === g).map(tile).join('')}</div>`).join('')}
    ${open ? lvDetail(open, st.shown[open.k] || 1, skills) : ''}
  </div>`;
}
function lvDetail(s, lv, skills) {
  const ref = LV_LIFTS[s.k] ? ` on ${esc(lvLift(s))}` : '';
  const now = LV_LIFTS[s.k] && s.best ? `Your best single ${esc(lvLift(s))} set lately: ${esc(s.best.set.replace('×', ' × '))}. That's about ${lvFmt(s, s.v)}${s.idle > 21 ? `, faded after ${Math.round(s.idle / 7)} weeks off` : ''}.`
    : s.k === 'cardio' && s.best ? `Best recent pace ${lvFmt(s, s.v)} (${esc(s.best.name)})${s.idle > 21 ? `, faded after ${Math.round(s.idle / 7)} weeks off` : ''}.`
      : s.k === 'habit' ? `${Math.round(s.v)} workout days in the last 8 weeks.`
        : s.k === 'weight' ? `Two-week average ${lvFmt(s, s.v)}.` : `Last measured ${lvFmt(s, s.v)}${s.on ? ` on ${esc(fmtDate(s.on, { month: 'short', day: 'numeric' }))}` : ''}.`;
  return `<div class="lv-detail"><b>${esc(s.name)} · level ${lv}</b>
    <p>${now}</p>
    <p class="muted small">Level 1 = ${lvFmt(s, s.base)} (your lowest on record). Level 60 = ${lvFmt(s, s.goal)}${ref}.${lv < LV_MAX ? ` Level ${lv + 1} at ${lvFmt(s, lvValueFor(s, lv + 1))}.` : ''}</p>
    <p class="muted small">${esc(LV_TRY[s.k] && s.k !== 'weight' ? LV_TRY[s.k] : lvTry(s))}</p>
    ${skills ? `<div class="lv-hist">${S.lvHist ? '' : lvRangeSeg()}${lvChart(lvHistory(skills).by[s.k] || [])}</div>` : ''}</div>`;
}
const levelPill = () => (S.settings.levels && S.settings.levels.shown ? `<button class="streak-pill lv-pill" data-a="tab" data-t="stats" aria-label="Overall level">Lv ${lvOverall(S.settings.levels.shown)}</button>` : '');

// ---------- backup ----------
async function exportData() {
  const data = {
    app: 'liftlog', version: 1, exportedAt: new Date().toISOString(),
    program: S.program, settings: S.settings, workouts: S.workouts,
    body: Object.values(S.body), foods: S.foods,
  };
  const name = `lift-log-backup-${todayStr()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  const mark = () => { S.settings.lastBackup = Date.now(); saveSettings(); render(); };
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Lift Log backup' });
      mark();
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  mark();
}

async function importData(f) {
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (e) { data = null; }
  // History files say app 'liftlog-history' so versions before 1.9 refuse them instead of replacing everything.
  if (data && (data.app === 'liftlog-history' || (data.app === 'liftlog' && data.kind === 'history')) && Array.isArray(data.workouts)) { await importHistory(data); return; }
  if (!backupOk(data)) { toast("That file isn't a Lift Log backup. Nothing was changed."); return; }
  cleanBackup(data);
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString() : 'an unknown date';
  if (!confirm(`Replace everything on this phone with the backup from ${when}? It has ${data.workouts.length} workouts.`)) return;
  // Keep what's here so a bad restore can be put back.
  const before = { program: S.program, settings: S.settings, workouts: S.workouts, body: Object.values(S.body), foods: S.foods };
  // One transaction: if anything fails or the app is closed partway, nothing changes.
  const write = d => DB.run(['kv', 'workouts', 'body'], 'readwrite', t => {
    const kv = t.objectStore('kv'), wo = t.objectStore('workouts'), bo = t.objectStore('body');
    kv.clear(); wo.clear(); bo.clear();
    kv.put({ k: 'program', v: d.program || defaultProgram() });
    kv.put({ k: 'settings', v: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } });
    kv.put({ k: 'foods', v: d.foods || [] });
    if (S.inspo && S.inspo.length) kv.put({ k: 'inspo', v: S.inspo });
    d.workouts.forEach(w => wo.put(w));
    (d.body || []).forEach(x => bo.put(x));
  });
  try {
    await write(data);
    await loadState();
  } catch (err) {
    await write(before).catch(() => {});
    await loadState(); render();
    toast(`Couldn't restore that backup (${err.message}). Your data is as it was.`, 7000);
    return;
  }
  S.view = null; S.pickDay = null; S.dayView = null;
  render();
  toastUndo('Backup restored.', async () => { await write(before); await loadState(); render(); toast('Put back the way it was.'); }, 'Undo', 10000);
}

// A full backup must have the shape the app saves, or it isn't touched.
const isYmd = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
function backupOk(d) {
  if (!d || d.app !== 'liftlog' || !Array.isArray(d.workouts)) return false;
  const p = d.program;
  if (p && (!p.days || DAYS.some(k => !p.days[k] || typeof p.days[k].type !== 'string' || (p.days[k].groups && !Array.isArray(p.days[k].groups))))) return false;
  return d.workouts.every(w => w && typeof w.id === 'string' && /^[\w-]+$/.test(w.id) && isYmd(w.date)
      && (w.exercises == null || (Array.isArray(w.exercises) && w.exercises.every(e => e && typeof e.name === 'string' && Array.isArray(e.sets) && e.target))))
    && (d.body || []).every(b => b && isYmd(b.date));
}
// Numbers stay numbers, so nothing odd in a file can end up in the page.
function cleanBackup(d) {
  const n = v => (v === '' || v == null || !Number.isFinite(+v) ? '' : +v);
  d.workouts.forEach(w => {
    (w.exercises || []).forEach(e => { e.sets = e.sets.map(x => ({ ...x, w: n(x.w), r: n(x.r), rir: x.rir == null ? x.rir : n(x.rir) })); });
    (w.activities || []).forEach(a => { ['dist', 'min', 'sec', 'hr'].forEach(k => { if (k in a) a[k] = n(a[k]); }); ['start', 'end'].forEach(k => { if (k in a && clockMin(a[k]) == null) a[k] = ''; }); });
  });
  (d.body || []).forEach(b => {
    if (b.weight != null) b.weight = n(b.weight) === '' ? null : n(b.weight);
    if (b.steps != null) b.steps = n(b.steps) === '' ? null : n(b.steps);
    if (b.sore != null) b.sore = Array.isArray(b.sore) ? b.sore.filter(g => SORE_GROUPS[g]) : [];
    b.items = (Array.isArray(b.items) ? b.items : []).map(x => ({ ...x, g: n(x.g) || 0 }));
  });
  d.foods = (Array.isArray(d.foods) ? d.foods : []).map(f => ({ ...f, g: n(f.g) || 0 }));
}

// A history file adds past days to what's here; it never replaces anything.
// Days already on the phone are skipped, so importing the same file twice is safe.
async function importHistory(data) {
  // Skip bad dates, repeats in the file, and days you already logged here.
  const seen = new Set(), num0 = v => (v === '' || v == null || !Number.isFinite(+v) ? '' : +v);
  const ws = data.workouts.filter(h => {
    if (!h || !/^\d{4}-\d{2}-\d{2}$/.test(h.date || '') || seen.has(h.date)) return false;
    seen.add(h.date);
    return !getW(histId(h.date)) && !S.workouts.some(w => w.date === h.date && hasWork(w));
  });
  ws.forEach(h => {
    h.lifts = (h.lifts || []).filter(x => x && x.name && Array.isArray(x.sets) && x.sets.length).map(x => ({ ...x, name: String(x.name), sets: x.sets.map(t => ({ w: num0(t.w), r: num0(t.r) })) }));
    h.acts = (h.acts || []).filter(a => a && typeof a.type === 'string').map(a => ({ ...a, dist: num0(a.dist), min: num0(a.min), sec: num0(a.sec) }));
  });
  const nPh = (data.photos || []).length;
  // Lifts to go easy on, from notes in the history ({ name: 'pressure' | 'joint' | 'cramp' }). Your own picks win.
  const addCare = () => {
    const care = { ...(S.settings.care || {}) }, add = Object.entries(data.care || {}).filter(([k, v]) => CARE_CUES[v] && !care[k]);
    add.forEach(([k, v]) => { care[k] = v; });
    if (add.length) { S.settings.care = care; saveSettings(); }
    return add.length;
  };
  // Weigh-ins, protein, and photos fill in only what's missing, so they're safe to run again.
  const addBodyAndPhotos = async () => {
    for (const b of data.body || []) {
      if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) continue;
      const e = bodyEntry(b.date);
      let changed = false;
      if (num0(b.weight) !== '' && e.weight == null) { e.weight = +b.weight; changed = true; }
      if (Array.isArray(b.items) && !e.items.length) { e.items = b.items.filter(g => num0(g) !== '').map(g => ({ name: '', g: +g })); changed = true; }
      if (changed) saveBody(e);
    }
    let k = 0, failed = 0;
    for (const ph of data.photos || []) {
      const id = `ph_hist_${ph.date}_${k++}`;
      if (S.photos.some(p => p.id === id) || !/^data:image\//.test(ph.data || '')) continue;
      try {
        const blob = await (await fetch(ph.data)).blob();
        const p = { id, date: ph.date, at: Date.parse(`${ph.date}T12:00`) + k, blob };
        await DB.put('photos', p);
        S.photos.push(p);
      } catch (e) { failed++; }
    }
    return failed;
  };
  if (!ws.length) {
    const n = addCare(), failed = await addBodyAndPhotos();
    render();
    toast(failed ? `${failed} photos couldn't be saved. Try again.` : n ? `Your days were already here. Marked ${n} lifts to go easy on.` : 'Those days are already in your log.');
    return;
  }
  if (!confirm(`Add ${ws.length} past days (${esc(data.title || 'workout history')})${nPh ? ` and ${nPh} photos` : ''} to your log? Nothing on this phone gets replaced.`)) return;
  const made = ws.map(h => {
    const lifts = h.lifts || [];
    const at = Date.parse(`${h.date}T12:00`);
    return {
      id: histId(h.date), date: h.date, dayKey: lifts.length ? 'free' : 'act', type: lifts.length ? 'strength' : 'rest',
      label: h.label || 'Workout', notes: h.notes || '', createdAt: at, finishedAt: at, imported: true,
      activities: h.acts || [], exercises: lifts.map((x, k) => importedExercise(x, k, at)),
    };
  });
  await DB.putMany('workouts', made);
  made.forEach(adopt);
  addCare();
  const failed = await addBodyAndPhotos();
  S.view = null; S.tab = 'history';
  render(); scrollTo(0, 0);
  toast(`Added ${made.length} past days. Your stats and coach use them now.${failed ? ` ${failed} photos couldn't be saved; import again to retry.` : ''}`, 6000);
}
const histId = date => `wh_${date.replace(/-/g, '')}`;
// Past lifts line up with your program when the names match, so the coach picks up where you left off.
function importedExercise(x, k, at) {
  let plan = null;
  allPlans().forEach(p => (p.groups || []).forEach(g => g.forEach(y => { if (!plan && keyOf(y.name) === keyOf(x.name)) plan = y; })));
  const reps = x.sets.map(s => +s.r);
  const t = classify({
    name: x.name, sets: plan ? plan.sets : x.sets.length,
    min: plan ? plan.min : Math.min(...reps), max: plan ? plan.max : Math.max(...reps),
    inc: plan ? plan.inc : UP, kind: plan && plan.kind, body: plan && plan.body,
  });
  return {
    key: keyOf(x.name), name: x.name, group: k, pid: null,
    target: { sets: t.sets, min: t.min, max: t.max, inc: t.inc, kind: t.kind, body: t.body, stepSet: true, unit: 'reps', note: x.note || '' },
    sets: x.sets.map((s, j) => ({ w: s.w, r: s.r, done: true, at: at + j * 120000 })), coach: null,
  };
}

// ---------- actions ----------
function findSheetSet() {
  const w = getW(S.sheet.wid);
  return { w, e: w.exercises[S.sheet.i], s: w.exercises[S.sheet.i].sets[S.sheet.j] };
}
function progDay() { return planOf(S.view.d); }
function startPlan(k) {
  S.pickDay = { date: todayStr(), k };
  S.tab = 'today'; S.view = null;
  closeSheet(); render(); scrollTo(0, 0);
}
function openPlanEditor(k) {
  S.tab = 'more';
  S.view = { name: 'progDay', d: k, back: null };
  closeSheet(); render(); scrollTo(0, 0);
}
// Turn the sheet's fields into a program exercise.
function sheetItem(id) {
  const x = S.sheet.data;
  let min = num(x.min), max = num(x.max);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { id: id || uid('e'), name: String(x.name).trim(), sets: +x.sets, min, max, inc: +x.inc, kind: x.kind, body: x.body, stepSet: true, unit: x.unit, note: String(x.note).trim(), ...(x.place === 'home' ? { place: 'home' } : {}) };
}
function findPlanItem(plan, pid) {
  for (const g of plan.groups || []) { const k = g.findIndex(x => x.id === pid); if (k >= 0) return { g, k }; }
  return null;
}
function addOther(w, kind, name) {
  w.activities = w.activities || [];
  const last = recentOtherActs().find(a => keyOf(a.name) === keyOf(name));
  w.activities.push({ type: 'other', kind: kind || 'custom', name, level: last ? last.level : null, hr: '', min: '', dist: '', notes: '' });
  persist(w); render(); scrollToAct(w);
  toast(`Added ${name}. Fill in how long below.`);
}
function scrollToAct(w) {
  const el = document.getElementById(`act-stats-${w.activities.length - 1}`);
  if (el) el.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Add or change an exercise in today's session, and in its program workout too if asked.
function saveSessExercise() {
  const sh = S.sheet, w = getW(sh.wid), plan = planOf(w.dayKey);
  const item = sheetItem();
  if (sh.i == null) {
    const g = Math.max(-1, ...w.exercises.map(e => e.group)) + 1;
    if (sh.toPlan && plan) { plan.groups = plan.groups || []; plan.groups.push([item]); }
    w.exercises.push(sessionExercise({ ...item, id: sh.toPlan && plan ? item.id : null }, g, w));
    toast(`Added ${item.name}${sh.toPlan && plan ? ' here and for next time' : ' for today'}`);
  } else {
    const e = w.exercises[sh.i], t = targetOf(e);
    if (keyOf(item.name) !== e.key && e.sets.some(s => s.done)) {
      // Sets already logged stay with the old exercise; the new one goes right after it.
      e.sets = e.sets.filter(s => s.done);
      const g = Math.max(...w.exercises.map(x => x.group)) + 1;
      w.exercises.splice(sh.i + 1, 0, sessionExercise({ ...item, id: null }, g, w));
      persist(w); closeSheet(); render();
      toast(`Kept your ${e.name} sets. ${item.name} is next.`);
      return;
    }
    const changed = keyOf(item.name) !== e.key || ['sets', 'min', 'max', 'inc', 'kind', 'body', 'unit'].some(f => item[f] !== t[f]);
    const oldKey = e.key, oldName = e.name;
    if (keyOf(item.name) !== e.key) { w.dropped = [...new Set([...(w.dropped || []), e.key])]; delete e.makeUp; }
    if (keyOf(item.name) !== e.key) w.swaps = [...(w.swaps || []), { from: oldName, to: item.name, at: Date.now() }];
    e.name = item.name; e.key = keyOf(item.name);
    if (item.place === 'home') e.place = 'home'; else delete e.place;
    e.target = { sets: item.sets, min: item.min, max: item.max, inc: item.inc, kind: item.kind, body: item.body, stepSet: true, unit: item.unit, note: item.note };
    if (changed) fillSets(e, w);
    if (sh.toPlan && plan) {
      const at = e.pid && findPlanItem(plan, e.pid);
      if (at) at.g[at.k] = { ...item, id: e.pid };
      else { plan.groups = plan.groups || []; plan.groups.push([item]); e.pid = item.id; }
    }
    toast(`${sh.toPlan && plan ? 'Changed here and for next time.' : 'Swapped for today.'}${weekShift(w, oldKey !== e.key ? { key: oldKey, name: oldName } : null)}`);
  }
  if (sh.i == null) applyMakeUp(w);
  persist(w);
  if (sh.toPlan && plan) DB.put('kv', { k: 'program', v: S.program });
  closeSheet(); render();
}

const ACT = {
  tab: d => {
    if (d.t === 'body' && S.tab !== 'body') S.bodyDate = todayStr();
    S.tab = d.t; S.view = null; if (d.t === 'today') S.dayView = null; closeSheet(); render(); scrollTo(0, 0);
  },
  back: () => { S.view = S.view && S.view.back; render(); scrollTo(0, 0); },
  'pick-day': d => { S.pickDay = { date: todayStr(), k: d.k }; closeSheet(); render(); },
  'pick-other': () => { S.sheet = { kind: 'other' }; renderSheet(); },
  'start-plan': d => startPlan(d.k),
  'plan-edit': d => openPlanEditor(d.k),
  'plan-new': () => {
    const c = { id: uid('c'), label: 'New workout', type: 'strength', groups: [] };
    S.program.custom.push(c);
    saveProgram();
    openPlanEditor(c.id);
    toast('Name it, then add exercises');
  },
  'plan-del': d => {
    if (!confirm('Delete this saved workout? Sessions you already logged stay in your history.')) return;
    S.program.custom = S.program.custom.filter(c => c.id !== d.k);
    saveProgram();
    S.view = null; render(); toast('Workout deleted');
  },
  'save-plan': d => {
    const w = getW(d.wid);
    const name = (prompt('Name this workout', w.label === BLANK_PLAN.label ? '' : w.label) || '').trim();
    if (!name) return;
    const groups = [];
    w.exercises.forEach(e => {
      const t = targetOf(e);
      const item = { id: uid('e'), name: e.name, sets: Math.max(t.sets, e.sets.length), min: t.min, max: t.max, inc: t.inc, kind: t.kind, body: t.body, stepSet: true, unit: t.unit, note: t.note, ...(isHome(e) ? { place: 'home' } : {}) };
      e.pid = item.id;
      const g = groups.find(x => x.id === e.group);
      if (g) g.items.push(item); else groups.push({ id: e.group, items: [item] });
    });
    const c = { id: uid('c'), label: name, type: 'strength', groups: groups.map(g => g.items) };
    S.program.custom.push(c);
    w.dayKey = c.id; w.label = name;
    persist(w); saveProgram();
    S.pickDay = { date: w.date, k: c.id };
    render(); toast(`Saved "${name}". Find it under Other on Today.`);
  },
  'ex-opts': d => openSessExSheet(getW(d.wid), +d.ex),
  'sx-add': d => openSessExSheet(getW(d.wid), null),
  'sx-rm': () => {
    const w = getW(S.sheet.wid), e = w.exercises[S.sheet.i];
    const at = S.sheet.i, before = w.exercises.slice(), dropped0 = (w.dropped || []).slice();
    w.exercises.splice(at, 1);
    if (!e.sets.some(x => x.done)) w.dropped = [...new Set([...dropped0, e.key])];
    const shift = weekShift(w, e);
    persist(w); closeSheet(); render();
    toastUndo(`Removed ${e.name} for today.${shift}`, () => { w.exercises = before; w.dropped = dropped0; persist(w); render(); });
  },
  'sf-pick': d => {
    const known = knownExercises(new Set()).find(x => keyOf(x.name) === keyOf(d.n));
    S.sheet.data = known && known.sets ? exData(classify({ ...known })) : { ...S.sheet.data, name: d.n };
    renderSheet();
  },
  'sx-swap': d => { ACT['sf-pick'](d); saveSessExercise(); },
  'habit-swap': d => {
    const w = getW(d.wid), from = swapForGood(w, +d.ex, d.to);
    render(); toast(`${from} → ${d.to}, here and in your plan.`);
  },
  'habit-keep': d => { setPref(d.n, { keepUntil: addDays(todayStr(), 42) }); render(); toast(`OK, ${d.n} stays. I won't ask again for 6 weeks.`); },
  'pref-no': d => {
    const sh = S.sheet, w = getW(sh.wid), e = w && w.exercises[sh.i];
    if (!e) return;
    setPref(e.name, { no: d.v || null, at: d.v ? Date.now() : null });
    // Bodyweight work you'd rather not do in front of people goes to your At home list.
    if (d.v === 'watching' && BODYWEIGHT.test(e.name)) {
      allPlans().forEach(p => (p.groups || []).forEach(g => g.forEach(x => { if (keyOf(x.name) === e.key) x.place = 'home'; })));
      saveProgram();
      e.place = 'home'; persist(w);
      toast(`${e.name} is in your At home list now.`);
    } else if (d.v) { sh.toPlan = true; toast('Got it. Pick a swap above and it goes in your plan too.'); }
    renderSheet(); render();
  },
  'pin-mode': d => {
    const sh = S.sheet, w = sh.wid != null ? getW(sh.wid) : null, e = w && sh.i != null ? w.exercises[sh.i] : null;
    const name = e ? e.name : sh.data && sh.data.name;
    if (!name) return;
    const on = !!d.v;
    setPref(name, { pin: on || null });
    if (e && !e.sets.some(x => x.done)) {
      if (on) e.pin = true; else delete e.pin;
      e.sets = [];
      fillSets(e, w); persist(w);
      toast(on ? `${e.name} now counts pin numbers. Enter the pin you use.` : `${e.name} is back to pounds.`);
    } else toast(on ? `${name} counts pin numbers from next time.` : `${name} is back to pounds from next time.`);
    renderSheet(); render();
  },
  'pref-like': () => {
    const sh = S.sheet, w = getW(sh.wid), e = w && w.exercises[sh.i];
    if (!e) return;
    setPref(e.name, { like: prefOf(e.name).like ? null : true });
    renderSheet();
  },
  'sf-toplan': () => { S.sheet.toPlan = !S.sheet.toPlan; renderSheet(); },
  'act-pick': d => { S.sheet = { kind: 'act', wid: d.wid }; renderSheet(); },
  'act-add': d => {
    const wid = S.sheet.wid;
    closeSheet();
    if (d.t === 'other') addOther(getW(wid), d.kind, d.n);
    else ACT['add-act']({ wid, t: d.t });
  },
  'act-custom': () => {
    const name = $('#act-name').value.trim();
    if (!name) { toast('Type what you did'); $('#act-name').focus(); return; }
    const def = ACTIVITIES.find(x => keyOf(x.name) === keyOf(name));
    const wid = S.sheet.wid;
    closeSheet();
    addOther(getW(wid), def ? def.id : 'custom', def ? def.name : name);
  },
  'ss-chain': () => { S.sheet.chain = !S.sheet.chain; renderSheet(); },
  seg: d => { S.histSeg = d.v; render(); },

  tick: d => tick(getW(d.wid), +d.ex, +d.s),
  'edit-set': d => openSetSheet(getW(d.wid), +d.ex, +d.s),
  'keep-w': d => {
    const w = getW(d.wid), e = w.exercises[+d.ex], c = e.coach;
    e.sets.forEach((s, k) => {
      if (s.done) return;
      if (c.prev) s.w = s.pw = c.prev[Math.min(k, c.prev.length - 1)];
      else if (+s.w === c.w) s.w = s.pw = c.from;
    });
    persist(w); render(); toast(c.prev && new Set(c.prev).size > 1 ? 'Keeping last time\'s weights' : `Keeping ${c.from} lb`);
  },
  'add-set': d => {
    const w = getW(d.wid), e = w.exercises[+d.ex];
    const l = e.sets[e.sets.length - 1] || { w: '', r: '' };
    e.sets.push({ w: l.w, r: l.r, done: false });
    persist(w); render();
  },
  'rm-set': d => {
    const w = getW(d.wid), e = w.exercises[+d.ex];
    if (e.sets[e.sets.length - 1].done && !confirm('Remove a set you already logged?')) return;
    e.sets.pop();
    persist(w); render();
  },
  'ex-chart': d => { S.view = { name: 'exercise', key: d.key, back: S.view }; render(); scrollTo(0, 0); },
  'day-view': d => { S.dayView = d.d === todayStr() ? null : d.d; render(); scrollTo(0, 0); },
  'rest-today': () => {
    const today = todayStr(), { m, prev, key, to } = restPlan(today);
    Object.keys(m).forEach(d => { if (d < addDays(today, -30)) delete m[d]; });
    S.settings.dayMoves = m;
    S.settings.restUndo = { date: today, prev, key, to };
    S.pickDay = null; S.draft = null;
    saveSettings(); render(); scrollTo(0, 0);
  },
  'rest-undo': () => {
    const u = S.settings.restUndo;
    if (!u) return;
    const m = { ...dayMoves() };
    Object.entries(u.prev).forEach(([d, k]) => { if (k == null) delete m[d]; else m[d] = k; });
    S.settings.dayMoves = m; delete S.settings.restUndo;
    S.pickDay = null; S.draft = null;
    saveSettings(); render(); scrollTo(0, 0);
  },
  'do-today': d => { S.pickDay = { date: todayStr(), k: d.k }; S.dayView = null; render(); scrollTo(0, 0); },
  'add-act': d => {
    const w = getW(d.wid);
    w.activities = w.activities || [];
    if (d.t === 'yoga') { ACT['add-yoga']({ wid: d.wid, id: recommendYoga(w.date).pick.id }); return; }
    w.activities.push({ type: d.t, auto: true, dist: '', min: '', sec: '', notes: '', ...(d.style ? { style: d.style } : {}) });
    persist(w); render(); scrollToAct(w);
  },
  'add-yoga': d => {
    const w = getW(d.wid), c = YOGA_CLASSES.find(x => x.id === d.id);
    w.activities = w.activities || [];
    w.activities.push({ type: 'yoga', style: c.style, min: c.min, level: S.settings.yogaLevel, feel: '', notes: '' });
    persist(w); render();
    toast(`Logged ${c.name} yoga, ${c.len}. Rate how it felt below.`);
  },
  'act-set': d => {
    const w = getW(d.wid), a = w.activities[+d.i];
    a[d.f] = d.f === 'min' || d.f === 'level' ? +d.v : (d.f === 'feel' && a.feel === d.v ? '' : d.v);
    autoMoveType(a);
    persist(w); render();
  },
  energy: d => setEnergy(d.v),
  sleep: d => { const b = bodyEntry(todayStr()); b.sleep = (sleepPick(b.sleep) || [])[0] === +d.v ? null : +d.v; saveBody(b); render(); },
  'go-body': d => {
    S.bodyDate = todayStr(); ACT.tab({ t: 'body' });
    const el = d && d.f && document.getElementById(d.f);
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
  },
  'go-goal': () => { S.settings.welcomed = true; saveSettings(); ACT.tab({ t: 'more' }); const el = document.getElementById('about-card'); if (el) el.scrollIntoView({ block: 'start' }); },
  goal: d => { S.settings.goal = d.v; saveSettings(); render(); toast(`Goal: ${GOALS[d.v].name}`); },
  'creatine-track': () => { S.settings.creatine = !S.settings.creatine; saveSettings(); render(); },
  creatine: () => { const b = bodyEntry(S.bodyDate); b.creatine = !b.creatine; saveBody(b); render(); },
  rir: d => {
    const w = getW(d.wid), e = w.exercises[+d.ex], s = e.sets[+d.s];
    s.rir = s.rir === +d.v ? null : +d.v;
    if (s.rir != null && isLive(w)) {
      const say = rirReaction(w, +d.ex), k = `${w.id}:${e.key}`, cur = S.say[k];
      if (say && (!cur || (cur.score || 0) <= say.score || Date.now() - cur.at > 120000)) S.say[k] = { ...say, at: Date.now() };
    }
    // The finished exercise folds up; keep the next one where your thumb is.
    const k = w.exercises.findIndex((x, n) => n > +d.ex && x.sets.some(y => !y.done));
    const sel = k >= 0 ? setSel(w, k, w.exercises[k].sets.findIndex(y => !y.done)) : null;
    persist(w);
    if (sel) { keepInPlace(sel, render); showAboveTimer(sel); } else render();
  },
  'deload-start': () => {
    const t = todayStr();
    Object.assign(S.settings, { deloadLast: t, deloadUntil: addDays(t, 6), deloadSnooze: null });
    saveSettings(); render(); toast('Deload week started. Half the sets, same weights.');
  },
  'deload-snooze': () => { S.settings.deloadSnooze = addDays(todayStr(), 7); saveSettings(); render(); toast("OK. I'll ask again in a week."); },
  'deload-end': () => { S.settings.deloadUntil = addDays(todayStr(), -1); saveSettings(); render(); toast('Deload ended. Back to normal sets.'); },
  'meas-open': d => { S.sheet = { kind: 'meas', date: d.d }; renderSheet(); },
  'meas-save': () => {
    const b = bodyEntry(S.sheet.date);
    b.meas = Object.fromEntries(MEASURES.map(([k]) => [k, num($(`#meas-${k}`).value)]));
    saveBody(b); closeSheet(); render(); toast('Measurements saved');
  },
  'photo-add': () => $('#photo-file').click(),
  'inspo-add': () => $('#inspo-file').click(),
  'inspo-open': d => { S.sheet = { kind: 'inspo', id: d.id }; renderSheet(); },
  'inspo-del': () => {
    if (!confirm('Remove this photo from your board?')) return;
    S.inspo = S.inspo.filter(p => p.id !== S.sheet.id);
    saveInspo(); closeSheet(); render(); toast('Removed');
  },
  'photo-open': d => { S.sheet = { kind: 'photo', id: d.id }; renderSheet(); },
  'photo-all': () => { S.photoAll = !S.photoAll; render(); },
  'photo-pose': d => { const p = S.photos.find(x => x.id === S.sheet.id); if (!p) return; p.pose = p.pose === d.v ? null : d.v; DB.put('photos', p).catch(saveFailed); renderSheet(); render(); },
  'photo-pump': () => { const p = S.photos.find(x => x.id === S.sheet.id); if (!p) return; p.pumped = !p.pumped; DB.put('photos', p).catch(saveFailed); renderSheet(); render(); },
  'photo-day-pump': d => {
    const g = S.photos.filter(p => p.date === d.d), on = !g.every(p => p.pumped);
    g.forEach(p => { p.pumped = on; DB.put('photos', p).catch(saveFailed); });
    render(); toast(on ? 'Marked as pumped. Compare fairly against other pumped days.' : 'Marked as not pumped');
  },
  'pcmp-open': d => { if (S.photos.length < 2) return; S.sheet = { kind: 'pcmp', ...pcmpPick(d.id), mode: 'slide', x: 50 }; renderSheet(); pcStripFocus(); },
  'pcmp-mode': d => { S.sheet.mode = d.v; renderSheet(); pcStripFocus(); },
  'pcmp-pick': d => {
    const keep = [...document.querySelectorAll('.pc-strip')].map(el => el.scrollLeft), top = $('#sheet-panel').scrollTop;
    S.sheet[d.side] = d.id; renderSheet();
    document.querySelectorAll('.pc-strip').forEach((el, i) => { el.scrollLeft = keep[i] || 0; });
    $('#sheet-panel').scrollTop = top;
  },
  'photo-del': () => {
    if (!confirm('Delete this photo? This can\'t be undone.')) return;
    const id = S.sheet.id;
    S.photos = S.photos.filter(p => p.id !== id);
    if (photoUrls.has(id)) { URL.revokeObjectURL(photoUrls.get(id)); photoUrls.delete(id); }
    DB.del('photos', id); closeSheet(); render(); toast('Photo deleted');
  },
  'scroll-work': () => { const el = $('#work'); if (el) el.scrollIntoView({ behavior: 'smooth' }); },
  'yoga-level': d => {
    S.settings.yogaLevel = d.v; saveSettings(); render();
    toast(d.v === 'intermediate' ? 'Moved up to intermediate yoga. Nice.' : 'Yoga level set to beginner');
  },
  'set-height': d => { const p = S.settings.profile; p.heightIn = Math.max(48, Math.min(96, p.heightIn + +d.d)); saveSettings(); render(); },
  'smart-rest': () => { S.settings.smartRest = !S.settings.smartRest; saveSettings(); render(); },
  'rm-act': d => {
    const w = getW(d.wid), [a] = w.activities.splice(+d.i, 1);
    persist(w); render();
    toastUndo(`Removed ${a.type === 'other' ? a.name || 'activity' : (a.type === 'yoga' ? 'Yoga' : moveLabel(a) || 'activity')}`, () => { w.activities.splice(+d.i, 0, a); persist(w); render(); });
  },
  'checkin-open': () => { S.checkinOpen = true; render(); },
  'bm-view': d => { S.settings.bodyView = d.v; saveSettings(); render(); },
  'ex-note': d => {
    const w = getW(d.wid), e = w && w.exercises[+d.ex];
    if (!e) return;
    const k = `${w.id}:${e.key}`, open = !(S.noteOpen || {})[k];
    S.noteOpen = { ...(S.noteOpen || {}), [k]: open };
    render();
    if (open) setTimeout(() => { const t = document.getElementById(`exn-${d.wid}-${d.ex}`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }, 30);
  },
  'ex-unfold': d => { S.unfold = { ...(S.unfold || {}), [`${d.wid}:${d.ex}`]: true }; render(); },
  'past-open': d => { S.sheet = { kind: 'past', date: d.d || addDays(todayStr(), -1) }; renderSheet(); },
  'past-make': d => {
    const date = ($('#past-date') || {}).value || S.sheet.date;
    if (date > todayStr()) { toast('Pick today or an earlier day.'); return; }
    const w = buildSession(d.k, date);
    w.finishedAt = Date.now();
    persist(w); closeSheet();
    if (S.tab === 'today' && weekStart(date) === weekStart(todayStr())) S.dayView = date;
    else { S.tab = 'history'; S.view = { name: 'workout', id: w.id, back: null }; }
    render(); scrollTo(0, 0);
  },
  'welcome-done': () => { S.settings.welcomed = true; saveSettings(); render(); },
  'open-w': d => { S.view = { name: 'workout', id: d.id, back: S.view }; render(); scrollTo(0, 0); },
  'del-w': d => {
    if (!confirm('Delete this workout? This can\'t be undone.')) return;
    const gone = getW(d.id);
    if (gone && pendingSaves.has(gone)) { clearTimeout(pendingSaves.get(gone)); pendingSaves.delete(gone); }
    S.workouts = S.workouts.filter(w => w.id !== d.id);
    DB.del('workouts', d.id);
    S.view = S.view && S.view.back;
    render(); toast('Workout deleted');
  },

  'tm-add': d => {
    clearTimeout(T.openT); T.openT = setTimeout(() => $('#timer').classList.remove('open'), 5000); T.end += +d.d * 1000; T.total = Math.max(T.total + +d.d, 1); if (T.doneAt) { T.doneAt = 0; $('#timer').classList.remove('done'); } drawTimer(); },
  'tm-stop': () => stopTimer(),
  // Tap the timer for −15, +15, and Skip; they tuck away again after a few seconds.
  'tm-toggle': () => {
    const el = $('#timer'), open = el.classList.toggle('open');
    clearTimeout(T.openT);
    if (open) T.openT = setTimeout(() => el.classList.remove('open'), 5000);
  },
  'test-timer': () => startTimer(5),

  'sheet-close': () => closeSheet(),
  'sheet-dismiss': () => dismissSheet(),
  'ss-step': d => {
    const v = (num(S.sheet[d.f]) || 0) + +d.d;
    S.sheet[d.f] = String(Math.max(0, round2(v)));
    renderSheet();
  },
  'ss-bw': () => { S.sheet.w = '0'; renderSheet(); },
  'ss-save': d => {
    const { w, e, s } = findSheetSet();
    const nw = num(S.sheet.w), nr = num(S.sheet.r);
    if (nw == null) { toast('Enter a weight (0 for bodyweight)'); return; }
    if (nr == null) { toast('Enter how many you did'); return; }
    const old = s.w;
    s.w = nw; s.r = nr;
    if (!s.done) s.own = true;
    if (S.sheet.chain && +old !== nw) e.sets.forEach((x, k) => { if (k > S.sheet.j && !x.done) x.w = nw; });
    const wasDone = s.done, i = S.sheet.i, j = S.sheet.j;
    closeSheet();
    if (wasDone || (d && d.only)) { persist(w); render(); return; }
    logInOrder(w, i, j);
  },
  'ss-only': () => ACT['ss-save']({ only: true }),

  'sf-step': d => { S.sheet.data[d.f] = Math.max(1, Math.min(10, (+S.sheet.data[d.f] || 0) + +d.d)); renderSheet(); },
  'sf-set': d => { S.sheet.data[d.f] = d.f === 'inc' ? +d.v : d.v; renderSheet(); },
  'sf-save': () => {
    const sh = S.sheet;
    if (!String(sh.data.name).trim()) { toast('Give it a name'); return; }
    if (sh.wid != null) { saveSessExercise(); return; }
    const day = progDay();
    day.groups = day.groups || [];
    const prev = sh.g == null ? null : day.groups[sh.g][sh.e];
    const item = sheetItem(prev && prev.id);
    if (prev) day.groups[sh.g][sh.e] = item; else day.groups.push([item]);
    saveProgram(); closeSheet(); render();
  },
  'sf-del': () => {
    if (!confirm('Delete this exercise from the program? Its history stays.')) return;
    const day = progDay(), g = day.groups[S.sheet.g];
    g.splice(S.sheet.e, 1);
    if (!g.length) day.groups.splice(S.sheet.g, 1);
    saveProgram(); closeSheet(); render();
  },
  'prog-open': d => { S.view = { name: 'progDay', d: d.d, back: null }; render(); scrollTo(0, 0); },
  'prog-type': d => {
    const day = progDay();
    day.type = d.v;
    if (d.v === 'strength' && !day.groups) day.groups = [];
    saveProgram(); render();
  },
  'edit-ex': d => openExSheet(+d.g, +d.e),
  'add-ex': () => openExSheet(null, null),
  'grp-move': d => {
    const gs = progDay().groups, a = +d.g, b = a + +d.dir;
    if (b < 0 || b >= gs.length) return;
    [gs[a], gs[b]] = [gs[b], gs[a]];
    saveProgram(); render();
  },
  'grp-link': d => {
    const gs = progDay().groups, a = +d.g;
    gs.splice(a, 2, [...gs[a], ...gs[a + 1]]);
    saveProgram(); render();
  },
  'grp-unlink': d => {
    const gs = progDay().groups, a = +d.g;
    gs.splice(a, 1, ...gs[a].map(x => [x]));
    saveProgram(); render();
  },
  'prog-reset': () => {
    if (!confirm('Reset all days and exercises to the original program? Your logged history stays.')) return;
    S.program = defaultProgram();
    saveProgram(); render(); toast('Program reset');
  },

  'body-day': d => {
    const n = addDays(S.bodyDate, +d.d);
    if (n > todayStr()) return;
    S.bodyDate = n; render();
  },
  'food-form': () => {
    const name = $('#food-name').value.trim(), g = num($('#food-g').value);
    if (!g || g <= 0) { toast('Enter the grams of protein'); $('#food-g').focus(); return; }
    addFood(name, Math.round(g));
    toast(proteinAddSay(Math.round(g), S.bodyDate));
  },
  'food-quick': d => {
    const f = findFood(d.n), date = S.tab === 'body' ? S.bodyDate : todayStr();
    if (f) { addFood(f.name, f.g, date); toast(proteinAddSay(+f.g, date)); }
  },
  'food-fav': d => { const f = findFood(d.n); if (f) { f.fav = !f.fav; saveFoods(); render(); } },
  'item-rm': d => {
    const b = bodyEntry(S.bodyDate), [it] = b.items.splice(+d.i, 1);
    saveBody(b); render();
    toastUndo(`Removed ${it.name || `${it.g} g`}`, () => { b.items.splice(+d.i, 0, it); saveBody(b); render(); });
  },

  'set-rest': d => { S.settings.restSec = Math.max(15, Math.min(600, S.settings.restSec + +d.d)); saveSettings(); render(); },
  'prot-mode': d => { S.settings.proteinMode = d.v; saveSettings(); render(); },
  'set-perlb': d => { S.settings.proteinPerLb = Math.max(0.5, Math.min(1.5, round2(S.settings.proteinPerLb + +d.d))); saveSettings(); render(); },
  'rem-toggle': d => reminderToggle(d.k),
  'act-now': d => {
    const w = getW(d.wid), a = w && w.activities[+d.i];
    if (!a) return;
    a[d.f] = nowClock();
    actTimeSync(w, +d.i, d.f);
    autoMoveType(a);
    persist(w); render();
  },
  'care-set': d => {
    const sh = S.sheet, w = sh.wid != null ? getW(sh.wid) : null, e = w && sh.i != null ? w.exercises[sh.i] : null;
    const name = e ? e.name : sh.data.name, care = { ...(S.settings.care || {}) };
    if (d.v) care[keyOf(name)] = d.v; else delete care[keyOf(name)];
    S.settings.care = care; saveSettings();
    if (e && !e.sets.some(x => x.done)) { fillSets(e, w); if (S.workouts.includes(w)) saveSoon(w); }
    renderSheet(); render();
  },
  'cmp-open': () => { S.view = { name: 'compare', mode: 'month', metric: 'workouts', back: null }; render(); scrollTo(0, 0); },
  'cmp-mode': d => { S.view = { ...S.view, mode: d.v, a: null, b: null }; render(); },
  'cmp-metric': d => { S.view = { ...S.view, metric: d.v }; render(); },
  // Tapping a bar makes it the second pick; the first stays (it starts as now).
  'cmp-pick': d => { S.view = { ...S.view, b: d.k === (S.view.a || null) ? S.view.b : d.k }; render(); },
  'log-all': d => {
    const w = getW(d.wid), at = Date.parse(`${w.date}T12:00`);
    w.exercises.forEach(e => e.sets.forEach((x, k) => { if (!x.done && x.w !== '' && x.r !== '') { x.done = true; x.at = at + k; } }));
    persist(w); render(); toast('Logged.');
  },
  'say-why': d => {
    const x = S.say[d.k];
    if (!x || !x.why) return;
    S.sheet = { kind: 'info', title: x.why.title, body: x.why.body, q: '', sub: 'The short version' };
    renderSheet();
  },
  'coach-why': d => {
    const x = d.k === 'protein' ? proteinCoach(todayStr()) : dayCoach(todayStr(), todaySession());
    if (!x || !x.why) return;
    S.sheet = { kind: 'info', title: x.why.title, body: x.why.body, q: '', sub: 'The short version' };
    renderSheet();
  },
  'note-tag': d => {
    const w = getW(d.wid), x = w && fieldSigs(w, d.src)[+d.i];
    if (!x) return;
    const info = noteInfo(x, w.date);
    S.sheet = { kind: 'info', title: info.title, body: info.body, q: info.q };
    renderSheet();
  },
  'sore-tog': d => {
    const b = bodyEntry(todayStr()), cur = soreFor(b.date);
    b.sore = cur.includes(d.g) ? cur.filter(g => g !== d.g) : [...cur, d.g];
    saveBody(b); haptic(); render();
  },
  'short-version': d => {
    const w = getW(d.wid), before = w.exercises;
    // The 3 biggest lifts, 3 sets each: about 25 minutes, and enough to keep your strength.
    const big = before.filter(e => targetOf(e).kind !== 'iso'), pick = (big.length >= 3 ? big : before).slice(0, 3);
    w.exercises = pick.map((e, k) => ({ ...e, group: k, sets: e.sets.slice(0, Math.max(MIN_SETS, e.sets.filter(s => s.done || s.own).length)) }));
    w.short = true; persist(w); render();
    toastUndo('Short version: 3 lifts, 3 sets each.', () => { w.exercises = before; w.short = false; persist(w); render(); });
  },
  'check-update': async () => {
    if (!navigator.onLine) { toast("You're offline. Connect and try again."); return; }
    toast('Checking for an update…', 8000);
    try {
      // no-store skips the offline copy (see sw.js), so this reads what's live right now.
      const txt = await (await fetch(`./app.js?check=${Date.now()}`, { cache: 'no-store' })).text();
      const v = (txt.match(/APP_VERSION = '([\d.]+)'/) || [])[1];
      if (!v) throw new Error('no version');
      if (v === APP_VERSION) { toast(`You're on the latest version, ${APP_VERSION}.`); return; }
      toast(`Updating to ${v}…`, 8000);
      flushSaves();
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) await reg.update().catch(() => {});
      for (const k of await caches.keys()) await caches.delete(k);
      location.reload();
    } catch (e) {
      toast("Couldn't check for an update. Try again in a minute.");
    }
  },
  'rem-test': () => {
    pushApi('test', { id: S.settings.reminder.id })
      .then(() => toast('Sending in 5 seconds. Go to your Home Screen to see it.'))
      .catch(err => toast(`Couldn't send: ${err.message}`));
  },
  'set-prot': d => { S.settings.proteinTarget = Math.max(5, S.settings.proteinTarget + +d.d); saveSettings(); render(); },
  'set-sound': () => { S.settings.sound = !S.settings.sound; saveSettings(); render(); if (S.settings.sound) beep(); },
  export: () => exportData(),
  'trainer-toggle': () => trainerToggle(),
  'trainer-now': async () => { await trainerSync(true); await trainerPull(); render(); toast(Date.now() - S.settings.trainer.lastSync < 5000 ? 'Sent.' : "Couldn't send. Check your connection."); },
  'coach-notes': () => { S.coachNotesOpen = !S.coachNotesOpen; render(); },
  'lv-close': d => {
    S.lvSoundPending = null;
    const el = document.querySelector('.lv-pop');
    if (el) el.remove();
    if (d.go) { S.tab = d.go; S.view = null; S.lvOpen = null; render(); scrollTo(0, 0); }
    lvNext();
  },
  'lv-info': d => { S.lvOpen = S.lvOpen === d.k ? null : d.k; render(); },
  'lv-hist': () => { S.lvHist = !S.lvHist; render(); },
  'lv-range': d => { S.lvRange = +d.v; render(); },
  'coach-ok': d => { const c = S.coachLog.find(x => x.id === d.k); if (c) { c.seen = true; saveCoachLog(); } render(); },
  'coach-undo': async d => {
    const c = S.coachLog.find(x => x.id === d.k);
    const u = (await DB.all('kv')).find(r => r.k === 'coachUndo');
    if (!c || !u || !u.v || u.v.id !== c.id) { toast("Can't undo that one anymore. Change anything in More → Program."); return; }
    S.program = u.v.program; await saveProgram();
    c.undone = true; c.seen = true; saveCoachLog();
    render(); toast('Put your program back the way it was.');
  },
  import: () => $('#import-file').click(),
};

function setPath(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (let k = 0; k < parts.length - 1; k++) o = o[parts[k]];
  o[parts[parts.length - 1]] = val;
}

// ---------- events ----------
document.addEventListener('pointerdown', unlockAudio, { passive: true });
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-a]');
  if (!b || b.disabled) return;
  const fn = ACT[b.dataset.a];
  if (fn) fn(b.dataset, b, ev);
});
// Start/finish fill in the length; typing a length by hand drops the times so the two never disagree.
function actTimeSync(w, k, f) {
  const a = w.activities[k];
  if (!a || (a.type !== 'walk' && a.type !== 'run')) return;
  if (f === 'start' || f === 'end') {
    if (actFromTimes(a)) {
      const mi = document.getElementById(`act-min-${k}`), se = document.getElementById(`act-sec-${k}`);
      if (mi) mi.value = a.min;
      if (se) se.value = a.sec;
    }
  } else if (f === 'min' || f === 'sec') {
    a.start = ''; a.end = '';
    document.querySelectorAll(`input[data-wid="${w.id}"][data-wb="activities.${k}.start"], input[data-wid="${w.id}"][data-wb="activities.${k}.end"]`).forEach(x => { x.value = ''; });
  } else return;
  const d = document.getElementById(`act-dur-${k}`);
  if (d) d.textContent = durText(a);
}
// Compare slider: drag anywhere on the photo to move the wipe.
document.addEventListener('pointerdown', ev => {
  const box = ev.target.closest && ev.target.closest('#pc-slide');
  if (!box) return;
  const move = e => {
    const r = box.getBoundingClientRect(), x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
    box.style.setProperty('--x', `${x}%`);
    if (S.sheet && S.sheet.kind === 'pcmp') S.sheet.x = Math.round(x);
  };
  move(ev);
  box.setPointerCapture && box.setPointerCapture(ev.pointerId);
  const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up); };
  box.addEventListener('pointermove', move); box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
});
document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset.wb && el.dataset.wb !== 'date') {
    const w = getW(el.dataset.wid);
    if (w) {
      setPath(w, el.dataset.wb, el.value);
      const m = el.dataset.wb.match(/^activities\.(\d+)\.(\w+)/);
      if (m) actTimeSync(w, +m[1], m[2]);
      const ma = m && w.activities[+m[1]];
      if (ma && ma.auto) {
        autoMoveType(ma);
        const head = document.getElementById(`act-stats-${m[1]}`)?.closest('.card')?.querySelector('.act-head b');
        if (head) head.textContent = moveLabel(ma);
      }
      const me = el.dataset.wb.match(/^exercises\.(\d+)\.notes$/);
      const src = el.dataset.wb === 'notes' ? 'w' : me ? `e${me[1]}` : m && m[2] === 'notes' ? m[1] : null;
      if (me) { const sm = document.getElementById(`exn-sum-${w.id}-${me[1]}`); if (sm) sm.textContent = exNoteSum(w.exercises[+me[1]]); }
      const tags = src != null && document.getElementById(`ntags-${w.id}-${src}`);
      if (tags) tags.outerHTML = noteTagsFor(w, src);
      saveSoon(w);
      const box = m && document.getElementById(`act-stats-${m[1]}`);
      if (box) box.textContent = actStatsText(w.activities[+m[1]], w.date) || 'Enter distance and time to see pace and calories.';
    }
  } else if (el.dataset.ssf) {
    S.sheet[el.dataset.ssf] = el.value;
  } else if (el.dataset.sf) {
    S.sheet.data[el.dataset.sf] = el.value;
  } else if (el.dataset.pl) {
    planOf(el.dataset.pl).label = el.value;
    saveProgramSoon();
  }
});
document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.id === 'bw-inp') {
    const b = bodyEntry(S.bodyDate);
    b.weight = num(el.value);
    saveBody(b);
    if (S.bodyDate === todayStr() && b.weight != null) reminderWeighed();
    const ws = weighSay(b);
    if (ws) setTimeout(() => toast(ws, 5200), 300);
    setTimeout(render, 250);
  } else if (el.dataset.wb && /^activities\./.test(el.dataset.wb)) {
    const w = getW(el.dataset.wid);
    const recs = w ? newRecords(w).filter(m => !(w.recShown || []).includes(m)) : [];
    if (recs.length) { w.recShown = [...(w.recShown || []), ...recs]; persist(w); haptic(); toast(`New record: ${recs.join(' and ')}!`); }
  } else if (el.dataset.cmp && S.view && S.view.name === 'compare') {
    S.view = { ...S.view, [el.dataset.cmp]: el.value };
    render();
  } else if (el.id === 'inspo-file' && el.files[0]) {
    const f = el.files[0];
    el.value = '';
    shrinkPhoto(f).then(blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read that photo')); r.readAsDataURL(blob); }))
      .then(img => { S.inspo = [...(S.inspo || []), { id: uid('i'), img, mine: true, at: Date.now() }]; return saveInspo().then(() => { render(); toast('Added to your board'); }); })
      .catch(err => toast(`Couldn't add that photo: ${err.message}`));
  } else if (el.id === 'photo-file' && el.files.length) {
    // Several at once: each is shrunk and saved in turn, in the order you picked them.
    const files = [...el.files], base = Date.now();
    el.value = '';
    if (files.length > 1) toast(`Saving ${files.length} photos…`);
    (async () => {
      let n = 0, bad = 0;
      for (const [i, f] of files.entries()) {
        try {
          const p = { id: uid('p'), date: S.bodyDate, at: base + i, blob: await shrinkPhoto(f) };
          await DB.put('photos', p);
          S.photos.push(p); n++;
        } catch (err) { bad++; }
      }
      render();
      toast(n ? `${n === 1 ? 'Photo' : `${n} photos`} saved on this phone${bad ? `. ${bad} couldn't be read` : ''}` : "Couldn't save those photos");
    })();
  } else if (el.id === 'rem-time' && el.value) {
    reminderTimeChanged('time', el.value);
  } else if (el.id === 'rem-streak-time' && el.value) {
    reminderTimeChanged('streakTime', el.value);
  } else if (el.id === 'rem-measure-time' && el.value) {
    reminderTimeChanged('measureTime', el.value);
  } else if (el.id === 'import-file') {
    importData(el.files[0]);
    el.value = '';
  } else if (el.dataset.wb === 'date' && el.value) {
    const w = getW(el.dataset.wid);
    w.date = el.value;
    persist(w); render();
  }
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && (ev.target.id === 'food-name' || ev.target.id === 'food-g')) ACT['food-form']();
  if (ev.key === 'Enter' && ev.target.dataset && ev.target.dataset.ssf) ACT['ss-save']();
});
const typing = () => !!document.activeElement && document.activeElement.matches('#view input, #view textarea');
let shownDay = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Save what's half-typed (change fires on blur) and anything waiting on a timer.
    if (typing()) document.activeElement.blur();
    keepTyped();
    flushSaves();
    if (progTimer) { clearTimeout(progTimer); progTimer = null; saveProgram(); }
    trainerSync();
  } else if (S.program) {
    if (Date.now() - trainerLastPull > 30 * 60000) trainerPull().then(() => trainerSync());
    if (T.iv) drawTimer();
    // A new day since you last looked: start from today everywhere.
    if (shownDay !== todayStr()) {
      if (S.bodyDate === shownDay || S.bodyDate > todayStr()) S.bodyDate = todayStr();
      S.dayView = null; S.checkinOpen = false; S.say = {}; S.said = {};
      freezeTargets();
      const sw = S.sheet && S.sheet.wid != null ? getW(S.sheet.wid) : null;
      if (S.sheet && S.sheet.wid != null && (!sw || !isLive(sw))) closeSheet();
      shownDay = todayStr();
    }
    if (!S.sheet && !typing()) render();
    // Check for a new version every time the app comes back, not just on a cold start.
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
  }
});

// While the app is open, send the log a couple of minutes after anything changes.
setInterval(() => { if (S.program && document.visibilityState === 'visible' && !typing()) trainerSync(); }, 120000);

let liveLast = '';
setInterval(() => {
  if (!S.program || document.visibilityState !== 'visible' || S.sheet || S.view || typing()) return;
  const sig = liveSig();
  if (sig === 'busy' || sig === liveLast) return;
  if (liveLast) render();
  liveLast = sig;
}, 60000);

// ---------- start ----------
(async function start() {
  try {
    await DB.open();
    await loadState();
  } catch (err) {
    $('#view').innerHTML = `<div class="card empty"><b>Storage isn't available</b>${esc(err.message)}. Private browsing can block it.</div>`;
    return;
  }
  if (location.hash === '#body') {
    S.tab = 'body';
    history.replaceState(null, '', location.pathname);
  }
  render();
  if (S.notice) { const n = S.notice; S.notice = null; setTimeout(() => toast(n, 7000), 600); }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data && ev.data.open) { S.tab = ev.data.open; S.view = null; S.bodyDate = todayStr(); S.pickDay = null; S.dayView = null; closeSheet(); render(); scrollTo(0, 0); }
    });
  }
  if (remAny(S.settings.reminder) && navigator.onLine) reminderSync().catch(() => {});
  trainerPull().then(() => trainerSync());
  if (navigator.storage && navigator.storage.persist) {
    try { S.persisted = await navigator.storage.persisted() || await navigator.storage.persist(); } catch (e) { /* ignore */ }
  }
  if ('serviceWorker' in navigator) {
    // A new version takes over in the background; offer a reload so it shows right away.
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (had) toastUndo('Lift Log was updated.', () => { flushSaves(); location.reload(); }, 'Reload', 12000);
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
