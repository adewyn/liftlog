'use strict';
/* Lift Log: an offline workout tracker. Everything is stored on this device in IndexedDB. */

const APP_VERSION = '2.4.4';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const ACT_TYPES = { yoga: 'Yoga', walk: 'Walk', run: 'Run' };
const COACH_MARK = { up: '▲', down: '▼', reps: '↗', hold: '→', beat: '★' };
const DEFAULT_SETTINGS = {
  restSec: 90, smartRest: true, sound: true, lastBackup: null,
  profile: { heightIn: 75 }, yogaLevel: 'beginner',
  goal: 'maintain', creatine: true, deloadUntil: null, deloadLast: null, deloadSnooze: null,
  proteinMode: 'auto', proteinPerLb: 0.85, proteinTarget: 155,
  reminder: { on: false, time: '09:00', streakOn: false, streakTime: '14:00', measureOn: false, measureTime: '10:00', id: null },
};
// The weigh-in reminder server (server/push in this folder) and its public key.
const PUSH_URL = 'https://liftlog-push.sporebound.workers.dev';
const VAPID_PUBLIC = 'BA_437YE5zeBtTMqdI9k9Ek1Jl9qu4Bo9Hmuen9bQmLNGn0MwZUngKJpCJSVXwj1lDQeCmGnbmKQ1zVhWV8yZLc';

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const keyOf = name => String(name).trim().toLowerCase().replace(/\s+/g, ' ');
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
  const step = t.inc || UP;
  const pct = t.kind !== 'iso' && t.body === 'upper' ? 0.04 : 0.05;
  return Math.max(step, roundTo((+w || 0) * pct, step));
}
const PROGRAM_V = 3;
// Brings an older saved program up to date with the trainer review (Nov 2026): wider ranges for
// small lifts, a quad lift and an overhead press on Wednesday, and a real abs exercise. Only touches
// exercises that still match the original program, so your own edits stay.
function migrateProgram(p) {
  if ((p.v || 1) >= PROGRAM_V) return false;
  // v3: no hack squat machine at your gym, so it's the leg press you already use.
  if ((p.v || 1) >= 2) {
    [...DAYS.map(d => p.days[d]), ...(p.custom || [])].forEach(day => (day.groups || []).forEach(g => g.forEach(x => {
      if (/^hack squat$/i.test(x.name)) x.name = 'Leg press';
    })));
    p.v = PROGRAM_V;
    return true;
  }
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
  p.v = PROGRAM_V;
  return true;
}
function defaultProgram() {
  return {
    v: PROGRAM_V,
    days: {
      mon: { label: 'Full body A', type: 'strength', groups: [
        [ex('Bench press', 3, 6, 8, UP)],
        [ex('Hip thrust', 3, 8, 10, LO)],
        [ex('Lat pulldown', 3, 8, 10, UP)],
        [ex('Cable fly', 2, 10, 12, UP)],
        [ex('Leg press', 2, 10, 10, LO, { note: 'Feet high' })],
        [ex('Bar curl', 3, 8, 12, UP), ex('Rope pushdown', 3, 8, 12, UP)],
        [ex('Lateral raise', 3, 12, 20, UP)],
      ] },
      tue: { label: 'Yoga + walk/run', type: 'cardio' },
      wed: { label: 'Full body B', type: 'strength', groups: [
        [ex('Incline DB press', 3, 8, 10, UP)],
        [ex('Leg press', 3, 8, 12, LO)],
        [ex('Romanian deadlift', 3, 8, 8, LO)],
        [ex('Row', 3, 8, 10, UP)],
        [ex('Seated DB shoulder press', 3, 8, 10, UP)],
        [ex('Hip abduction', 3, 12, 15, LO)],
        [ex('DB curl', 3, 10, 12, UP), ex('Overhead triceps extension', 3, 10, 12, UP)],
        [ex('Calf raise', 3, 12, 20, LO)],
        [ex('Cable crunch', 3, 10, 15, UP), ex('Pallof press', 2, 10, 12, UP, { note: 'Per side' })],
      ] },
      thu: { label: 'Yoga + easy walk/run', type: 'cardio' },
      fri: { label: 'Full body C', type: 'strength', groups: [
        [ex('Chest press or dips', 3, 8, 10, UP)],
        [ex('Bulgarian split squat', 3, 8, 8, LO, { note: 'Per leg' })],
        [ex('Pull-ups', 3, null, null, UP, { note: 'Max reps' })],
        [ex('Cable crossover', 2, 12, 12, UP)],
        [ex('Hamstring curl', 2, 10, 10, LO)],
        [ex('Hammer curl', 3, 10, 12, UP), ex('Pushdown', 3, 10, 12, UP)],
        [ex('Lateral raise', 2, 12, 20, UP), ex('Face pull', 2, 12, 15, UP)],
        [ex('Calf raise', 3, 12, 20, LO)],
        [ex("Farmer's carry", 3, 40, 60, UP, { unit: 'steps' })],
      ] },
      sat: { label: 'Rest', type: 'rest' },
      sun: { label: 'Rest', type: 'rest' },
    },
  };
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
  if (!S.settings.streakRuleFrom) { S.settings.streakRuleFrom = todayStr(); await saveSettings(); }
  S.foods = kv.foods || [];
  if (!kv.program || migrated) await saveProgram();
  if (migrated && kv.program) S.notice = oldV >= 2 ? "Wednesday's hack squat is now the leg press, since your gym doesn't have a hack squat machine." : 'Program updated from the trainer review: a quad lift, an overhead press, and cable crunches on Wednesday, plus wider rep ranges for raises, calves, and carries. Change anything in More.';
  S.workouts = await DB.all('workouts');
  // 1.9 saved imported activity-only days under Sunday.
  const moved = S.workouts.filter(w => w.imported && w.dayKey === 'sun' && w.type === 'rest');
  moved.forEach(w => { w.dayKey = 'act'; });
  if (moved.length) await DB.putMany('workouts', moved);
  S.body = {};
  (await DB.all('body')).forEach(b => { S.body[b.date] = b; });
  S.photos = await DB.all('photos').catch(() => []);
  S.draft = null;
  freezeTargets();
  // Today's workout may already be saved with the hack squat in it: swap any not started yet.
  S.workouts.filter(w => w.date === todayStr()).forEach(w => (w.exercises || []).forEach(e => {
    if (/^hack squat$/i.test(e.name) && !e.sets.some(x => x.done)) { e.name = 'Leg press'; e.key = keyOf(e.name); fillSets(e, w); persist(w); }
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
const planOf = k => (k === 'act' ? ACT_PLAN : isDayKey(k) ? S.program.days[k] : S.program.custom.find(c => c.id === k)) || null;
const titleOf = w => (isDayKey(w.dayKey) ? DAY_NAMES[w.dayKey] : w.label);
const allPlans = () => [...DAYS.map(d => S.program.days[d]), ...S.program.custom];
const targetOf = e => classify(e.target);
const lastSetAt = w => Math.max(0, ...(w.exercises || []).flatMap(e => e.sets.filter(s => s.done).map(s => s.at || 0)));
const isLive = w => w.date === todayStr() || Date.now() - lastSetAt(w) < 3 * 3600000;
const hasAny = w => hasWork(w) || !!(w.notes || '').trim();

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

// Earlier sessions of this exercise (newest first), with only the logged sets.
function recentPerf(key, w, n) {
  const out = [];
  for (const o of sortedW()) {
    if (out.length >= n) break;
    if (o.id === w.id) continue;
    if (o.date > w.date || (o.date === w.date && o.createdAt > w.createdAt)) continue;
    const e = (o.exercises || []).find(x => x.key === key && doneSets(x).length);
    if (e) out.push({ date: o.date, sets: doneSets(e), easy: !!o.deload || lowDay(o.date) || offDay(o), note: liftNote(o, e.name) });
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
  // Sessions logged on a low-energy day don't count as misses.
  const short = p => !p.easy && (p.sets.length < t.sets || p.sets.some(x => +x.r < lo));

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
    const lastRir = last.sets[last.sets.length - 1].rir;
    const easy = (lastRir != null && lastRir >= 3) || opts.noted === 'lift-easy';
    const w = round2(top + jumpFor(t, top) * (easy ? 2 : 1));
    return plan('up', fill(w), fill(lo), easy ? `${hi} on every set ${opts.noted === 'lift-easy' ? 'and you said it felt easy' : 'with reps to spare'}. Bigger jump: ${w} lb, aim for ${lo}+.` : `${hi} on every set last time. Up to ${w} lb, aim for ${lo}+.`);
  }
  if (short(last)) {
    const p2 = recent[1];
    const prevTop = p2 ? Math.max(...p2.sets.map(s => +s.w || 0)) : 0;
    if (top && p2 && short(p2) && prevTop >= top && daysBetween(p2.date, last.date) <= 21) {
      const step = t.inc || UP;
      const w = Math.max(step, Math.min(top - step, roundTo(top * 0.9, step)));
      return plan('down', fill(w), fill(hi), `Two tough ones in a row. ${w} lb today, build back from here.`);
    }
    return plan('hold', prev, reps.map(r => Math.max(r, lo)), `Same ${wTxt(top)}. Go for ${lo} on every set.`);
  }
  if (opts.energy === 'low') return plan('hold', prev, reps, `${opts.sick ? 'Sick day' : 'Low energy'}, so just match last time at ${wTxt(top)}.`);
  if (opts.noted === 'lift-pain' || opts.noted === 'lift-hard') return plan('hold', prev, reps, `Match last time at ${wTxt(top)}, since ${opts.noted === 'lift-pain' ? 'it hurt last time' : 'it felt hard last time'}.`);
  if (opts.noted === 'lift-easy') {
    return plan('reps', prev, Array.from({ length: t.sets }, (_, k) => Math.min(hi, Math.max(lo, at(reps, k) + 2))), `You said it felt easy. Same weight, two more reps a set (top is ${hi}).`);
  }
  if (last.sets[last.sets.length - 1].rir === 0 && last.sets.some(x => +x.r < hi)) return plan('hold', prev, reps, `Last set was all-out. Match ${wTxt(top)} before adding reps.`);
  return plan('reps', prev,
    Array.from({ length: t.sets }, (_, k) => Math.min(hi, Math.max(lo, at(reps, k) + 1))),
    `Same weight, one more rep a set (top is ${hi}).`);
}

// Tailor the rest of today's sets to how this one went. Reps usually drop a little from set to set,
// so only raise after a big early set, and only lower after a clear miss (2 short, or short on set 1).
function adjustRest(w, e, j) {
  const t = targetOf(e), s = e.sets[j];
  if (t.min == null && t.max == null) return null;
  // Easy days (low energy, deload) aim 2 reps lower on purpose, so judge sets against that.
  const easy = lowDay(w.date) || !!w.deload, cut = easy ? 2 : 0;
  const lo = Math.max(1, (t.min ?? t.max) - cut), hi = (t.max ?? t.min) - cut, step = t.inc || UP, w0 = +s.w;
  const rest = e.sets.filter((x, k) => k > j && !x.done && +x.w === w0);
  if (!rest.length || !w0) return null;
  if (+s.r >= hi + 2 && j <= 1 && !easy) {
    rest.forEach(x => { x.w = x.pw = round2(w0 + step); x.r = x.pr = lo; });
    return { t: `Strong set. Next one +${step} lb.`, tone: 'up' };
  }
  if ((+s.r <= lo - 2 || (j === 0 && +s.r < lo)) && w0 > step) {
    rest.forEach(x => { x.w = x.pw = round2(w0 - step); x.r = x.pr = lo; });
    return { t: `Under ${lo}, so −${step} lb next set to stay in range.`, tone: 'down' };
  }
  return null;
}

// One exercise for a session, with sets filled in from the coach's plan.
function sessionExercise(x, group, w) {
  classify(x);
  const e = {
    key: keyOf(x.name), name: x.name, group, pid: x.id || null,
    target: { sets: x.sets, min: x.min, max: x.max, inc: x.inc, kind: x.kind, body: x.body, stepSet: true, unit: x.unit || 'reps', note: x.note || '' },
    sets: [],
  };
  fillSets(e, w);
  return e;
}
// Low energy: hold the weights, do 2 sets, and stop with a couple of reps left (about a third
// of normal volume still keeps your gains).
// Deload weeks: half the sets at last time's weights. Plans build on your last regular sessions,
// so low-energy days and deloads never drag the numbers down.
function fillSets(e, w) {
  const rehab = REHAB_WORDS.test(e.name), care = careOf(e.name);
  const base = targetOf(e);
  // Shoulder care stays at 10 to 15 reps; lifts that cause pressure move to lighter sets of 10 to 15.
  const t = rehab || care === 'pressure' ? { ...base, min: Math.max(base.min ?? 10, 10), max: Math.max(base.max ?? 15, 15) } : base;
  const low = !rehab && lowDay(w.date), deload = !rehab && !!w.deload;
  // Easy-day sessions (low energy, deload, tired or sick in your notes) only count if you still hit every set.
  const full = p => p.sets.length >= t.sets && p.sets.every(x => +x.r >= (t.min ?? t.max ?? 0));
  const recent = recentPerf(e.key, w, 6), real = recent.filter(p => !p.easy || full(p));
  const tired = sleepShort(w.date) ? 'you slept under 6 hours' : t.body === 'lower' ? legsTired(w.date) : '';
  const short2 = !rehab && energyFor(w.date) !== 'low' && twoShortNights(w.date) ? "you've had two short nights" : '';
  // Never reach back past a break for the last normal session: build on the easy one instead (it isn't a miss).
  const stale = real.length && recent.length && daysBetween(real[0].date, recent[0].date) >= 21;
  const basis = real.length && !stale ? real.slice(0, 2) : recent.slice(0, 2), noted = basis[0] && basis[0].note;
  let plan = coachPlan(t, basis, { energy: rehab ? null : energyFor(w.date) || (sickNoted(w.date) ? 'low' : null), sick: !rehab && !energyFor(w.date) && !!sickNoted(w.date), tired: rehab ? '' : tired || short2 || (deload ? "it's a deload week" : ''), noted: noted && noted.k });
  let cb = rehab ? null : comeback(t, recent, w.date);
  // Building back after a break waits a session when today's an easy day or your note said hard or pain.
  const pause = cb && cb.kind === 'up' && (low ? 'today is an easy day' : [noted, recent[0] && recent[0].note].some(x => x && (x.k === 'lift-hard' || x.k === 'lift-pain')) ? 'your note said it was rough' : '');
  if (pause) cb = { ...cb, kind: 'hold', ws: cb.ws.map(() => cb.from), note: `Same ${cb.from} lb, since ${pause}. Building back picks up next time.` };
  if (cb) plan = { ...(plan || { prev: null }), kind: cb.kind, ws: cb.ws, w: Math.max(...cb.ws), from: cb.from, reps: cb.reps, note: cb.note };
  else if (plan && deload) plan = { ...plan, kind: 'hold', ws: plan.prev, w: plan.from, reps: plan.prev.map(() => t.min ?? t.max ?? 8), note: '' };
  if (plan && (care || rehab) && !cb) {
    const last = (real[0] || recent[0]).sets, top = Math.max(...last.map(s => +s.w || 0)), step = t.inc || UP;
    if (care === 'pressure' && top && Math.max(...last.map(s => +s.r)) < 10) {
      // Moving to lighter sets: about 15% less so 10 reps feel smooth.
      const lw = Math.max(step, roundTo(top * 0.85, step));
      plan = { ...plan, kind: 'down', ws: plan.ws.map(() => lw), w: lw, reps: plan.reps.map(() => 10), note: `${lw} lb today so 10 to 15 reps feel smooth.` };
    } else if (plan.w > top + step) {
      // No big jumps on a lift that bothers you: one step at a time.
      plan = { ...plan, ws: plan.ws.map(x => Math.min(x, top + step)), w: Math.min(plan.w, top + step), note: `Up one step to ${round2(top + step)} lb, aim for ${t.min ?? t.max}+.` };
    }
  }
  e.coach = plan ? { kind: plan.kind, note: plan.note, from: plan.from, w: plan.w, prev: plan.prev } : null;
  const sets = cb ? cb.n : t.sets;
  const extra = deload && !cb ? `Deload: ${Math.ceil(sets / 2) === 1 ? '1 set' : `${Math.ceil(sets / 2)} sets`}${plan ? " at last time's weights" : ''}, about 3 left in the tank.`
    : low ? '2 sets today. Stop each with 2 or 3 left in the tank.' : '';
  if (extra && (!plan || (deload && !cb))) e.coach = e.coach ? { ...e.coach, note: `${e.coach.note} ${extra}`.trim() } : { kind: 'hold', note: extra, from: 0, w: 0, prev: null };
  const helps = soreHelpers(e.name, w.date);
  const noteCue = !noted ? '' : noted.k === 'lift-pain' ? 'Keep it light, stop if it hurts.'
    : noted.k === 'lift-cramp' && care !== 'cramp' ? CARE_CUES.cramp : '';
  const cue = [rehab ? REHAB_CUE : care ? CARE_CUES[care] : '', noteCue, helps ? `Sore ${helps} ${/^(chest|back)$/.test(helps) ? 'helps' : 'help'} here. Go lighter, stop if it pulls.` : ''].filter(Boolean).join(' ');
  if (cue) e.coach = e.coach ? { ...e.coach, note: `${e.coach.note} ${cue}`.trim() } : { kind: 'hold', note: cue, from: 0, w: 0, prev: null };
  const n = deload && !cb ? Math.ceil(sets / 2) : low ? Math.min(2, sets) : sets;
  const done = e.sets.filter(s => s.done);
  e.sets = done.concat(Array.from({ length: Math.max(0, n - done.length) }, (_, m) => {
    const k = done.length + m;
    const r = plan ? plan.reps[Math.min(k, plan.reps.length - 1)] : null;
    const pr = plan && (low || deload) && r > 3 ? r - 2 : r;
    return plan ? { w: plan.ws[k], r: pr, done: false, pw: plan.ws[k], pr }
      : { w: '', r: t.min ?? t.max ?? '', done: false };
  }));
}

// Time off: strength mostly holds for about 4 weeks, then fades, and it comes back quickly (Bosquet 2013).
// After 3+ weeks away, start lighter; then climb a step each session you hit your reps until you're back.
function comeback(t, recent, date) {
  const last = recent[0];
  if (!last || (t.min == null && t.max == null)) return null;
  const lo = t.min ?? t.max, step = t.inc || UP;
  const topOf = p => Math.max(...p.sets.map(s => +s.w || 0));
  const top = topOf(last), gap = daysBetween(last.date, date), wks = Math.round(gap / 7);
  const fill = (v, n = t.sets) => Array(n).fill(v);
  if (gap >= 21) {
    const away = gap > 90 ? `about ${Math.round(gap / 30)} months` : `${wks} weeks`;
    if (!top) return { kind: 'hold', ws: fill(0), reps: fill(lo), n: Math.max(2, t.sets - 1), from: 0, note: `First time in ${away}. Aim for ${lo} and see how it feels.` };
    if (gap <= 42) return { kind: 'hold', ws: fill(top), reps: fill(lo), n: t.sets, from: top, note: `First time in ${away}. Same ${top} lb, ${lo} reps. Strength holds fine this long.` };
    const pct = gap > 90 ? 0.7 : 0.85, n = gap > 90 ? 2 : Math.max(2, t.sets - 1);
    const w = Math.max(step, roundTo(top * pct, step));
    return { kind: 'down', ws: fill(w, n), reps: fill(lo, n), n, from: top, note: `First time in ${away}, so ${n} sets at ${w} lb (about ${Math.round(pct * 100)}%) to ease in. Builds back to ${t.sets} × ${top} lb from here.` };
  }
  // Already back for a session or few: find where the break was and the weight from before it.
  const k = recent.findIndex((p, i) => i < 4 && recent[i + 1] && daysBetween(recent[i + 1].date, p.date) >= 21);
  if (k < 0 || !top) return null;
  const oldTop = topOf(recent[k + 1]);
  if (top >= oldTop || last.sets.length < 2 || last.sets.some(s => +s.r < lo)) return null;
  const w = Math.min(oldTop, round2(top + jumpFor(t, top)));
  return { kind: 'up', ws: fill(w), reps: fill(lo), n: t.sets, from: top, note: `Building back to ${oldTop} lb, a step each session.` };
}
// Lifts you've marked as bothering you (More options on an exercise), by name.
const careOf = name => (S.settings.care || {})[keyOf(name)] || null;
const CARE_CUES = {
  pressure: 'Easy does it: breathe out as you push, no big breath-hold, 10 to 15 smooth reps. Aches? Swap it.',
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
  const dayKey = picked || (todays.find(hasAny) || {}).dayKey || dayKeyOf(date);
  const found = todays.find(w => w.dayKey === dayKey);
  if (!found && (!S.draft || S.draft.date !== date || S.draft.dayKey !== dayKey)) S.draft = buildSession(dayKey, date);
  const w = found || S.draft;
  // Energy, sleep, or a deload changed since this was planned: re-plan the lifts not started yet.
  const key = planKeyFor(date);
  if (w.planKey !== key) {
    if (w.type === 'strength') w.deload = deloadState(date).active;
    (w.exercises || []).forEach(e => { if (!e.sets.some(x => x.done)) fillSets(e, w); });
    if (w.type === 'strength') applySore(w);
    w.planKey = key;
    if (found) persist(w);
  }
  return w;
}
const sleepFor = date => (S.body[date] || {}).sleep ?? null;
const sleepShort = date => sleepFor(date) != null && sleepFor(date) < 6;
// Two nights of 6 hours or less in a row count like a low-energy day.
const twoShortNights = date => [date, addDays(date, -1)].every(d => sleepFor(d) != null && sleepFor(d) <= 6);
const lowDay = date => energyFor(date) === 'low' || twoShortNights(date) || (!energyFor(date) && !!sickNoted(date));
const planKeyFor = date => `${energyFor(date) || ''}|${sleepShort(date) ? 's' : ''}|${twoShortNights(date) ? 't' : ''}|${deloadState(date).active ? 'd' : ''}|${JSON.stringify(S.settings.care || {})}|${soreFor(date).join(',')}|${!energyFor(date) && sickNoted(date) ? 'sick' : ''}`;

// ----- weekly sets per muscle -----
// Direct work counts as a full set, big helpers as half (a bench set is 1 chest, ½ triceps).
const MUSCLES = { chest: 'Chest', back: 'Back', shoulders: 'Shoulders', rear: 'Rear delts', biceps: 'Biceps', triceps: 'Triceps', quads: 'Quads', hams: 'Hamstrings', glutes: 'Glutes', calves: 'Calves', abs: 'Abs' };
// 10 or more weekly sets builds more muscle (ACSM 2026); smaller areas do fine with about 6.
const MUSCLE_GOAL = { rear: 6, calves: 6, abs: 6 };
const MUSCLE_RULES = [
  [/wrist curl/i, {}],
  [/face pull|rear delt|reverse fly|cuban|external rot|pull-?apart/i, { rear: 1 }],
  [/back extension|hyperextension/i, { hams: 0.5, glutes: 0.5, back: 0.5 }],
  [/triceps|pushdown|push-down|skull|french press/i, { triceps: 1 }],
  [/pullover/i, { back: 1 }],
  [/lateral raise|side raise|upright row/i, { shoulders: 1 }],
  [/overhead press|shoulder press|military|arnold|standing (bar |barbell )?press|\bohp\b/i, { shoulders: 1, triceps: 0.5 }],
  [/pallof|crunch|leg raise|plank|\babs\b|sit-?up|ab wheel|woodchop/i, { abs: 1 }],
  [/calf/i, { calves: 1 }],
  [/hamstring|leg curl|nordic/i, { hams: 1 }],
  [/romanian|\brdl\b|good morning|stiff.?leg/i, { hams: 1, glutes: 0.5 }],
  [/(hex|trap).?bar deadlift/i, { quads: 0.5, hams: 0.5, glutes: 0.5, back: 0.5 }],
  [/deadlift/i, { hams: 0.5, glutes: 0.5, back: 0.5 }],
  [/sled/i, { quads: 0.5, glutes: 0.5 }],
  [/hip thrust|glute bridge|glute kickback/i, { glutes: 1 }],
  [/abduct/i, { glutes: 0.5 }],
  [/leg extension/i, { quads: 1 }],
  [/squat|leg press|lunge|step-?up/i, { quads: 1, glutes: 0.5 }],
  [/row/i, { back: 1, biceps: 0.5, rear: 0.5 }],
  [/pull-?up|chin-?up|pulldown|pullover/i, { back: 1, biceps: 0.5 }],
  [/curl/i, { biceps: 1 }],
  [/pushdown|push-down|triceps|skull|kickback|french press|close-grip/i, { triceps: 1 }],
  [/fly|flye|crossover|pec deck/i, { chest: 1 }],
  [/bench|chest press|\bdips?\b|push-?up|incline|decline|floor press|free press|machine press|d(umb)?b(ell)? press|dumbbell chest/i, { chest: 1, triceps: 0.5 }],
];
const musclesOf = name => { const n = normName(name); return (MUSCLE_RULES.find(([re]) => re.test(n)) || [null, {}])[1]; };

// ----- too sore today -----
// Pick what's sore and today's lifts work around it: lifts aimed at it sit out (until you un-pick it),
// lifts it only helps with stay but go lighter, and lifts for muscles that are behind this week fill in.
const SORE_GROUPS = { chest: ['Chest', ['chest']], back: ['Back', ['back']], shoulders: ['Shoulders', ['shoulders', 'rear']], arms: ['Arms', ['biceps', 'triceps']], legs: ['Legs', ['quads', 'hams', 'glutes', 'calves']], core: ['Core', ['abs']] };
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
  w.exercises = w.exercises.filter(e => !e.soreAdd || started(e));
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
  picks.forEach(x => { const e = sessionExercise(x, gid++, w); e.soreAdd = true; w.exercises.push(e); });
}
// Things from recent notes that change today, said up front.
function noteBanner(date) {
  const sick = !energyFor(date) && sickNoted(date), cramp = notedSince(addDays(date, -1), 1, ['cramp'])[0];
  const day = d => (d === addDays(date, -1) ? 'yesterday' : esc(fmtDate(d, { weekday: 'long' })));
  const lines = [];
  if (sick) lines.push(`<b>Sick ${day(sick.date)}.</b> Going easy: 2 sets a lift, no jumps, a walk instead of a run. Feeling fine? Check in OK or Great above.`);
  if (cramp) lines.push(`<b>Cramps ${day(cramp.date)}.</b> Water and something salty an hour before you train.`);
  return lines.length ? `<div class="card note-banner">${lines.map(l => `<div>${l}</div>`).join('')}</div>` : '';
}
function soreCard(w) {
  const allDone = w.exercises.length && w.exercises.every(e => e.sets.every(x => x.done));
  if (w.type !== 'strength' || w.date !== todayStr() || allDone) return '';
  const on = soreFor(w.date), out = w.soreOut || [], add = w.exercises.filter(e => e.soreAdd);
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
// A quick ramp before the first big lift of the session (and the first big leg lift): about 50% for 8, then 70% for 3.
function warmupFor(w, i) {
  const e = w.exercises[i];
  if (w.date !== todayStr()) return '';
  const firstOf = f => w.exercises.findIndex(x => targetOf(x).kind !== 'iso' && f(targetOf(x)));
  if (i !== firstOf(() => true) && i !== firstOf(t => t.body === 'lower')) return '';
  const wt = +(e.sets.find(x => x.w !== '') || {}).w || 0;
  if (wt < 60) return '';
  const step = targetOf(e).inc || UP, r = v => Math.max(step, roundTo(wt * v, step));
  return `Warm-up (not logged): ${r(0.5)} × 8, then ${r(0.7)} × 3.`;
}
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
    const real = recentPerf(k, probe, 6).filter(r => !r.easy).slice(0, 2);
    if (real.length && real[0].date >= addDays(date, -21) && (coachPlan(classify({ ...x }), real) || {}).kind === 'down') stalls++;
  })));
  return { suggest: weeks >= 7 || stalls >= 3, weeks, stalls };
}
function deloadCard(date) {
  const d = deloadState(date);
  if (d.active) return `<div class="card coach coach-hold deload"><span>→ Deload week through ${esc(fmtDate(d.until, { weekday: 'short', month: 'short', day: 'numeric' }))}: half the sets, usual weights. This is when you rebuild.</span><button data-a="deload-end">End now</button></div>`;
  if (!d.suggest) return '';
  const why = d.stalls >= 3 ? `${d.stalls} lifts have stalled` : `You've trained ${d.weeks} weeks straight`;
  return `<div class="card plan">
    <div class="ss-tag">Time for a lighter week?</div>
    <div class="sh-hint" style="margin-top:6px">${why}. For a week: half the sets, same weights, about 3 left in the tank. You come back stronger.</div>
    <div class="btn-row" style="margin-top:12px"><button class="btn pri" data-a="deload-start">Start it</button><button class="btn" data-a="deload-snooze">Not now</button></div>
  </div>`;
}

function tick(w, i, j) {
  const s = w.exercises[i].sets[j];
  if (s.done) { s.done = false; persist(w); render(); return; }
  if (s.w === '' || s.r === '') { openSetSheet(w, i, j); return; }
  const next = nextSet(w, i, j);
  keepInPlace(next ? setSel(w, ...next) : setSel(w, i, j), () => logSet(w, i, j));
  if (next) showAboveTimer(setSel(w, ...next));
}
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
  }
  const pw = s.pw === '' || s.pw == null ? null : +s.pw;
  if (easyDay && pw != null && (wt > pw || (s.pr && r >= +s.pr + 3))) add('easy', 60, 'Easy day, remember. Leave 2 or 3 in the tank.', 'care', { act: true, once: 'easy' });
  else if (!easyDay && pw && wt >= pw * 1.1 && ranged && r >= lo) add('heavy', 50, `Went heavier and still hit ${r}. Strong.`, 'good', { once: `hv:${e.key}` });
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
  [...acts, praise].forEach(x => { if (x && x.once) st.once[x.once] = true; });
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
  if (s.rir === 3 && top) return { t: 'Lots left and every set at the top. Bigger jump next time.', tone: 'good', score: 55 };
  if (s.rir === 3 && hi != null) return { t: "Lots left. Chase more reps next time, you've got them.", tone: 'good', score: 45 };
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
  if (!t || (goal !== 'cut' && goal !== 'bulk')) return null;
  const avgs = [];
  for (let k = 1; k <= 60; k++) { const x = weightTrend(addDays(b.date, -k)); if (x) avgs.push(x.avg); }
  if (avgs.length < 14) return null;
  if (goal === 'cut' && t.avg < Math.min(...avgs)) return `Lowest 7-day average in ${avgs.length >= 50 ? '2 months' : 'a while'}: ${t.avg} lb. 👌`;
  if (goal === 'bulk' && t.avg > Math.max(...avgs) && (t.pct == null || t.pct <= GOALS.bulk.hi)) return `Highest 7-day average yet: ${t.avg} lb, at a steady pace. 👌`;
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
  const n = w.exercises.length, sets = sum(w.exercises.map(e => e.sets.length));
  const mins = Math.round(sets * (S.settings.restSec + 50) / 60 / 5) * 5;
  const up = w.exercises.find(e => e.coach && e.coach.kind === 'up' && e.coach.w), back = w.exercises.find(e => e.coach && e.coach.kind === 'down');
  const focus = up ? `${up.name} goes up to ${fmtW(up.coach.w)} lb.` : back ? `Easing back in on ${back.name}.` : 'Same weights, chasing reps.';
  return `${n} ${n === 1 ? 'lift' : 'lifts'}, about ${mins} min. ${focus}`;
}
function dayCoach(date, w) {
  if (date !== todayStr()) return null;
  const h = hourNow(), b = bodyEntry(date), strength = w.type === 'strength' && w.exercises.length;
  const total = strength ? sum(w.exercises.map(e => e.sets.length)) : 0, done = strength ? sum(w.exercises.map(e => e.sets.filter(s => s.done).length)) : 0;
  const acts = (w.activities || []).filter(actDone).length, pc = proteinCoach(date);
  const pTail = pc && pc.left > 0 && h >= 11 && h < 22 ? ` Protein next: ${pc.left} g to go.` : '';
  if (strength && done && done >= total) {
    const hi = wrapHighlight(w);
    return { t: `That's a wrap ✓ ${done} sets in ${liftMinutes(w)} min.${hi ? ` ${hi}` : ''}${pTail}`, tone: 'good' };
  }
  if (!strength && w.type !== 'rest' && acts) return { t: `Done for today ✓${pTail}`, tone: 'good' };
  if (strength && done) {
    const mins = Math.max(5, Math.round((total - done) * (S.settings.restSec + 50) / 60 / 5) * 5);
    return { t: `${done} of ${total} sets. About ${mins} min to go.`, tone: '' };
  }
  if (pc && pc.urgent) return { ...pc, src: 'protein' };
  if (w.type === 'rest' && !acts) return { t: dayPick(['Rest day. This is when the muscle actually gets built.', 'Rest day. Recover, eat your protein, sleep well.', 'Rest day. A walk is a nice bonus, nothing more needed.'], 'rest'), tone: '', why: WHY.rest_day };
  if (h < 11 && b.weight == null && !b.protein) return { t: `Morning! Weigh in before breakfast${strength ? ', then lift later' : ''}.`, tone: '', why: WHY.weigh, btn: { a: 'go-body', label: 'Weigh in' } };
  if (h >= 21 && strength) return { t: 'Late one. A short session still counts, or rest up and go tomorrow.', tone: '', btn: w.exercises.length > 3 && !w.short ? { a: 'short-version', wid: w.id, label: '20-min version' } : null };
  if (h >= 18 && strength && w.exercises.length > 3 && !w.short) return { t: 'Still time today. Tight on time? The 20-min version works.', tone: '', btn: { a: 'short-version', wid: w.id, label: '20-min version' } };
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
function unlockAudio() {
  try {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === 'suspended') actx.resume();
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
  else html = ({ today: viewToday, history: viewHistory, body: viewBody, stats: viewStats, more: viewMore })[S.tab]();
  $('#view').innerHTML = html;
  celebrateDay();
}

// ----- daily streak -----
// A training day counts when you move: any workout or activity. A rest day also
// counts with a weigh-in or your protein goal. (Days before this rule started keep the old one, where
// a weigh-in or protein counted any day, so no streak was lost to the change.)
const isTrainingDay = date => S.program.days[dayKeyOf(date)].type !== 'rest';
function dayCounts(date) {
  const b = S.body[date] || {};
  if (S.workouts.some(w => w.date === date && hasWork(w))) return true;
  if (isTrainingDay(date) && date >= (S.settings.streakRuleFrom || '9999')) return false;
  return b.weight != null || (b.protein || 0) >= proteinTargetFor(date);
}
const streakTodo = date => (isTrainingDay(date) ? 'lift, run, walk, or do yoga' : 'move, weigh in, or hit your protein');
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
      <div class="sh-hint">${done ? 'Today counts. See you tomorrow.' : n ? `Keep it going today: ${streakTodo(today)}.` : `To start one today: ${streakTodo(today)}.`}</div>
      <div class="sh-hint">Training days count when you move. Rest days also count with a weigh-in or your protein.</div>
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
const actName = a => (a.type === 'other' ? a.name : a.type === 'yoga' ? `${YOGA_STYLES[a.style] || ''} yoga`.trim() : ACT_TYPES[a.type]);
const ENERGY = { low: 'Low', ok: 'OK', great: 'Great' };
const SLEEP = [[5, '≤5'], [6, '6'], [7, '7'], [8, '8'], [9, '9+']];
// Older entries were stored as range midpoints (6.5, 7.5); show them as the nearest hour.
const sleepPick = v => (v == null ? null : SLEEP.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a)));
const fmtK = n => (n >= 1000 ? `${round1(n / 1000)}k` : String(n));
const ENERGY_HINT = {
  low: 'Easy day: 2 sets a lift, no jumps, gentler cardio.',
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
  hard: /\b(hard|heavy|tough|grind(?:y|ed|ing)?|struggl(?:e|ed|ing)|fail(?:ed|ure)?|barely|brutal|killer|form broke)\b/,
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
  const mk = `${t}\u0001${(ctx.lifts || []).join('|')}\u0001${ctx.run ? 1 : 0}${ctx.pace ? 1 : 0}`;
  if (noteMemo.has(mk)) return noteMemo.get(mk);
  const lifts = liftAliases(ctx.lifts || []), out = [], seen = new Set();
  const add = x => { const k = `${x.k}|${x.about || ''}`; if (!seen.has(k)) { seen.add(k); out.push(x); } };
  // Two lifts in one sentence ("bench was easy, incline was heavy"): each comma part stands alone.
  const clauses = t.split(/[.!?;\n]+|\bbut\b|\bthough\b|\bhowever\b|\bwhile\b/i).flatMap(c => {
    const n = lifts.filter(L => L.res.some(r => r.test(noteText(c)))).length;
    return n > 1 && /,/.test(c) ? c.split(',') : [c];
  });
  clauses.forEach(raw => {
    const quote = raw.trim().replace(/^(and|so|then)\s+/i, '');
    let rest = noteText(raw);
    if (!rest.trim()) return;
    // Lifts named here, blanked out so "calf raise" isn't read as your calf.
    const named = [];
    lifts.forEach(L => { const re = L.res.find(r => r.test(rest)); if (re) { named.push(L.name); rest = rest.replace(re, ' '); } });
    const recovered = RECOVERED.test(rest);
    const hit = (k, noNeg) => {
      const m = rest.match(NOTE_SIG[k]);
      if (!m) return null;
      const neg = !noNeg && (NEG_BEFORE.test(rest.slice(0, m.index)) || NEG_AFTER.test(rest.slice(m.index + m[0].length)));
      return { word: m[1], neg };
    };
    const ok = x => (x && !x.neg ? x : null);
    const sore = !recovered && ok(hit('sore')), pain = !recovered && ok(hit('pain'));
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
const workoutSigs = w => [...parseNotes(w.notes, workoutCtx(w)), ...(w.activities || []).flatMap(a => parseNotes(a.notes, actCtx(a)))];
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
    case 'sick': return { title: 'Sick', body: ['Won’t count as a miss, so your weights don’t drop because of it.', `Through ${until(2)}, skipping the check-in means an easy plan: 2 sets a lift, no jumps, a walk instead of a run. Check in OK or Great to go back to normal.`, live(2)], q };
    case 'tired': return { title: 'Tired', body: ['Won’t count as a miss. Next time, each lift builds on your last normal session.'], q };
    case 'pace': return { title: `${cap(x.word)} run`, body: ['Heat, hills, wind, and trails slow you down for reasons that aren’t fitness, so this run stays out of your pace targets. Distance still counts.'], q };
  }
  return { title: noteLabel(x), body: [], q };
}
const NOTE_TONE = { 'lift-pain': 'warn', 'pain-part': 'warn', 'run-part': 'warn', sick: 'warn', 'lift-cramp': 'warn', cramp: 'warn', 'lift-easy': 'good', 'lift-hard': 'mid', tired: 'mid', 'sore-part': 'mid', sore: 'mid' };
const noteTagsHTML = (sigs, id, wid, src) => `<div class="note-tags" id="${id}">${sigs.map((x, i) => `<button class="note-tag ${NOTE_TONE[x.k] || ''}" data-a="note-tag" data-wid="${wid}" data-src="${src}" data-i="${i}">${esc(noteLabel(x))}</button>`).join('')}</div>`;
const fieldSigs = (w, src) => (src === 'w' ? parseNotes(w.notes, workoutCtx(w)) : parseNotes((w.activities[+src] || {}).notes, actCtx(w.activities[+src] || {})));
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
const fmtPace = m => { const sec = Math.round(m * 60); return `${Math.floor(sec / 60)}:${pad(sec % 60)}`; };

// How hard an activity is, in METs (1 = sitting still). Walks and runs use the ACSM equations from
// your speed; brisk walks above 3.7 mph, where that equation runs low, follow the Compendium instead.
function actMet(a) {
  if (a.type === 'yoga') return YOGA_MET[a.style] || 2.5;
  if (a.type === 'other') { const d = actDef(a); return d.mets[actLevel(a, d)]; }
  const min = actMinutes(a);
  if (!(+a.dist > 0) || !min) return a.type === 'run' ? 8 : 3.5;
  const mpm = +a.dist * 1609.34 / min, mph = +a.dist / (min / 60);
  if (a.type === 'run') return (0.2 * mpm + 3.5) / 3.5;
  if (mpm <= 100) return (0.1 * mpm + 3.5) / 3.5;
  const pts = [[3.73, 3.86], [4.2, 5.5], [4.7, 7.0], [5.25, 8.5]];
  for (let k = 1; k < pts.length; k++) {
    if (mph <= pts[k][0]) { const [x0, y0] = pts[k - 1], [x1, y1] = pts[k]; return y0 + (y1 - y0) * (mph - x0) / (x1 - x0); }
  }
  return 8.5;
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
  const n = sum((w.exercises || []).map(e => doneSets(e).length));
  const ats = (w.exercises || []).flatMap(e => e.sets.filter(x => x.done && x.at).map(x => x.at)).sort((a, b) => a - b);
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
  const tomorrow = S.program.days[dayKeyOf(addDays(date, 1))];
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

// Compound lifts rest 2:30 (3:00 when the range tops out at 8 or fewer); isolation lifts use your
// rest setting. A superset rests after the round, as long as its longest member needs.
function restFor(w, e) {
  const base = S.settings.restSec;
  if (!S.settings.smartRest) return base;
  const grp = w.exercises.filter(x => x.group === e.group).map(targetOf);
  return Math.max(...grp.map(t => (t.kind === 'iso' ? base : Math.max(base, t.max != null && t.max <= 8 ? 180 : 150))));
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
    <div class="sh-hint">${en ? ENERGY_HINT[en] : 'How are you feeling? The plan adjusts.'}${twoShortNights(date) ? ' Two short nights: 2 sets a lift, no jumps.' : sleepShort(date) ? ' Under 6 hrs of sleep: no jumps, easier cardio.' : ''}</div>
  </div>`;
}

// After a week or more away: a welcome back, and a short version for busy days.
function comebackCard(w) {
  if (w.type !== 'strength' || hasWork(w) || !w.exercises.length) return '';
  const last = S.workouts.filter(x => x.date < w.date && (x.exercises || []).some(e => doneSets(e).length)).map(x => x.date).sort().pop();
  const gap = last ? daysBetween(last, w.date) : 0;
  if (gap < 7) return '';
  const short = w.exercises.length > 3 && !w.short ? `<button class="btn block" style="margin-top:12px" data-a="short-version" data-wid="${w.id}">Short on time? 20-minute version</button>` : '';
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
  return Math.min(plannedKeys().length, keys.length + extra);
}
const plannedKeys = () => DAYS.filter(d => S.program.days[d].type !== 'rest');

// ----- Today -----
// This week's real dates. Tapping one shows that day: what you logged, or what's coming up.
function weekChips(shown) {
  const today = todayStr(), ws = weekStart(today);
  return `<div class="chips days">${DAYS.map((d, k) => {
    const date = addDays(ws, k);
    const did = S.workouts.some(w => w.date === date && hasWork(w));
    const cls = [date === shown ? 'on' : '', date === today ? 'today' : '', S.program.days[d].type === 'rest' ? 'rest' : ''].join(' ');
    return `<button class="chip ${cls}" data-a="day-view" data-d="${date}" aria-label="${DAY_NAMES[d]} ${esc(fmtDate(date, { month: 'long', day: 'numeric' }))}">${DAY_SHORT[d]}<small>${parseYmd(date).getDate()}</small>${did ? '<span class="dot"></span>' : ''}</button>`;
  }).join('')}</div>`;
}
const sessionBody = w => (w.type === 'strength' ? sessionStrength(w) : w.type === 'cardio' ? sessionCardio(w) : sessionRest(w));

// Other things logged today that aren't on screen (after switching workouts).
function alsoToday(w) {
  const other = S.workouts.filter(x => x.date === w.date && x !== w && hasWork(x));
  if (!other.length) return '';
  const bits = other.flatMap(x => [...(x.exercises || []).filter(e => doneSets(e).length).map(e => e.name), ...(x.activities || []).filter(actDone).map(a => (a.type === 'other' ? a.name || 'Activity' : a.type === 'yoga' ? 'Yoga' : a.type === 'run' ? 'Run' : 'Walk'))]);
  return `<div class="note-line muted">Also logged today: ${esc([...new Set(bits)].slice(0, 4).join(', '))}</div>`;
}
function viewToday() {
  const date = todayStr();
  if (S.dayView && S.dayView !== date && weekStart(S.dayView) === weekStart(date)) return viewDay(S.dayView);
  const w = todaySession();
  const realKey = dayKeyOf(date);
  const day = planOf(w.dayKey) || { label: w.label };
  const custom = !isDayKey(w.dayKey);
  return `
    <header class="top">
      <div class="top-row">
        <div class="eyebrow">Today · ${esc(fmtDate(date, { month: 'long', day: 'numeric' }))}</div>
        <button class="streak-pill ${dayCounts(date) ? 'on' : ''}" data-a="tab" data-t="stats" aria-label="Daily streak">🔥 ${dailyStreak()}</button>
      </div>
      ${custom ? `<h1>${esc(w.label)}<span class="sub">${w.dayKey === 'free' ? 'Build it as you go' : 'One of your saved workouts'}</span></h1>`
        : `<h1>${DAY_NAMES[realKey]}<span class="sub">${esc(day.label)}${w.dayKey !== realKey ? ` (${DAY_NAMES[w.dayKey]}'s workout)` : ''}</span></h1>`}
      ${!custom && w.dayKey !== realKey ? `<div class="note-line">Doing ${DAY_NAMES[w.dayKey]}'s workout today. <button class="linkbtn inline" data-a="pick-day" data-k="${realKey}">Switch back</button></div>` : ''}
      ${alsoToday(w)}
    </header>
    ${welcomeCard()}
    ${todaySummary(date, w)}
    ${noteBanner(date)}
    ${comebackCard(w)}
    ${w.type === 'strength' && deloadState(date).active ? deloadCard(date) : ''}
    ${weekChips(date)}
    <button class="linkbtn diff-btn ${custom ? 'on' : ''}" data-a="pick-other">${custom ? '✓ Doing a different workout · change' : '+ Different workout (saved or blank)'}</button>
    <div id="work"></div>
    ${soreCard(w)}
    ${sessionBody(w)}`;
}

// Another day this week: look back at what you logged, or ahead at what's planned.
function viewDay(date) {
  const k = dayKeyOf(date), plan = S.program.days[k], past = date < todayStr();
  const logged = sortedW().filter(w => w.date === date && hasAny(w));
  const missed = past && plan.type !== 'rest' && !weekDoneKeys(weekStart(date)).includes(k);
  let body;
  if (logged.length) {
    body = logged.map(w => `${logged.length > 1 ? `<div class="lbl day-lbl">${esc(w.label)}</div>` : ''}${sessionBody(w)}`).join('');
  } else if (past) {
    body = `<div class="card empty"><b>Nothing logged</b>${plan.type === 'rest' ? 'It was a rest day.' : `The plan was ${esc(plan.label)}.`}</div>
      <button class="btn block" data-a="past-open" data-d="${date}">+ Log something for ${DAY_NAMES[k]}</button>`;
  } else body = previewDay(k, date);
  return `<header class="top">
      <div class="top-row"><button class="linkbtn back-today" data-a="day-view" data-d="${todayStr()}">‹ Back to today</button></div>
      <h1>${DAY_NAMES[k]}<span class="sub">${esc(fmtDate(date, { month: 'long', day: 'numeric' }))} · ${past ? (logged.length ? esc(logged[0].label) : 'Past day') : `Coming up · ${esc(plan.label)}`}</span></h1>
    </header>
    ${weekChips(date)}
    ${body}
    ${missed || (!past && plan.type !== 'rest') ? `<button class="btn block" data-a="do-today" data-k="${k}">${past ? 'Do this workout today' : 'Do this workout today instead'}</button>` : ''}`;
}
function previewDay(k, date) {
  const plan = S.program.days[k];
  if (plan.type === 'rest') return '<div class="card rest-card"><div class="big">Rest day</div><div class="muted">Nothing planned. Recover, eat, sleep.</div></div>';
  if (plan.type === 'cardio') {
    const rec = recommendCardio(date, k);
    return `<div class="card"><div class="lbl">The plan</div><b>${esc(rec.text)}</b><div class="muted small">${esc(rec.why || '')}</div></div>`;
  }
  const w = buildSession(k, date);
  return `<div class="card plan-card"><div class="lbl">The plan</div>
    ${w.exercises.map(e => `<div class="row"><div>${esc(e.name)}<div class="muted small">${esc(targetText(e.target))}</div></div>${e.sets[0] && +e.sets[0].w ? `<small>${fmtW(e.sets[0].w)} lb</small>` : ''}</div>`).join('')}
    ${w.exercises.some(e => e.sets[0] && +e.sets[0].w) ? '<div class="sh-hint">Weights are a guess for now. They update as you lift.</div>' : ''}</div>`;
}

function sessionStrength(w) {
  const groups = [];
  w.exercises.forEach((e, i) => {
    const g = groups.find(x => x.id === e.group);
    if (g) g.items.push(i); else groups.push({ id: e.group, items: [i] });
  });
  const cards = groups.map(g => {
    const multi = g.items.length > 1;
    const up = isLive(w) && g.items.some(i => (w.exercises[i].coach || {}).kind === 'up' && !isFolded(w, i));
    const inner = g.items.map((i, k) => exBlock(w, i, multi ? String.fromCharCode(65 + k) : '')).join('');
    return `<section class="card ${multi ? 'ss' : ''} ${up ? 'up' : ''}">
      ${multi ? '<div class="ss-tag">Superset <span>· alternate, rest after the round</span></div>' : ''}
      ${inner}
    </section>`;
  }).join('');
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
      <span class="fold-sum">${ic('check')} ${e.sets.map(s => `${fmtW(s.w)}×${s.r}`).join(', ')}</span>${sayHTML(w, i, true)}</button>`;
  }
  const last = lastPerf(e.key, w);
  const c = isLive(w) ? e.coach : null;
  // Machines logged by pin number show "#8", not "8 lb".
  const stack = /\(stack #\)/.test(e.name);
  const unit = e.target.unit === 'steps' ? 'steps' : 'reps';
  const lastTxt = last
    ? `Last time (${esc(fmtDate(last.date, { month: 'short', day: 'numeric' }))}): <b>${last.sets.map(s => `${fmtW(s.w)}×${s.r}`).join(', ')}</b>`
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
        <div class="ex-target">${esc(targetText(e.target))}${isLive(w) && e.target.sets && e.sets.length !== e.target.sets ? ` · <b>${e.sets.length} ${e.sets.length === 1 ? 'set' : 'sets'} today</b>` : ''}</div>
      </div>
      <div class="ex-btns">
        <a class="icon-btn" href="${formUrl(e.name)}" target="_blank" rel="noopener" aria-label="How to do it">${ic('play')}</a>
        <button class="icon-btn" data-a="ex-chart" data-key="${esc(e.key)}" aria-label="Progress chart">${ic('chart')}</button>
        <button class="icon-btn" data-a="ex-opts" data-wid="${w.id}" data-ex="${i}" aria-label="Change or remove">${ic('more')}</button>
      </div>
    </div>
    <div class="ex-last">${lastTxt}</div>
    ${last && last.note && last.note.quote ? `<div class="ex-note">“${esc(last.note.quote)}”<span>Your note, ${esc(fmtDate(last.date, { month: 'short', day: 'numeric' }))}</span></div>` : ''}
    ${banner}
    ${warmupFor(w, i) ? `<div class="warmup">${esc(warmupFor(w, i))}</div>` : ''}
    <div class="sets">${rows}</div>
    ${sayHTML(w, i)}
    ${rirAsk(w, i)}
    <div class="ex-tools">
      <button data-a="add-set" data-wid="${w.id}" data-ex="${i}">+ Set</button>
      ${e.sets.length > 1 ? `<button data-a="rm-set" data-wid="${w.id}" data-ex="${i}">− Set</button>` : ''}
    </div>
  </div>`;
}

// A finished exercise folds to one line once you've moved on (answered the reps question or started the next one).
function isFolded(w, i) {
  const e = w.exercises[i];
  if (w.date !== todayStr() || !e.sets.length || !e.sets.every(s => s.done) || (S.unfold || {})[`${w.id}:${i}`]) return false;
  const last = e.sets[e.sets.length - 1];
  return last.rir != null || S.settings.askRir === false || w.exercises.some((x, k) => k > i && x.group !== e.group && x.sets.some(s => s.done));
}
// After the last set of a lift: could you have done one more rep? Yes is saved as 2 reps left, No as 0
// (all-out), so older answers (0 to 3) still read the same way.
function rirAsk(w, i) {
  const e = w.exercises[i], j = e.sets.length - 1, s = e.sets[j];
  if (S.settings.askRir === false || w.date !== todayStr() || !e.sets.every(x => x.done) || targetOf(e).unit === 'steps') return '';
  return `<div class="rir">
      <span>That last set: could you have done one more rep?</span>
      <div class="seg">${[[2, 'Yes'], [0, 'No']].map(([v, n]) => `<button class="${s.rir === v ? 'on' : ''}" data-a="rir" data-wid="${w.id}" data-ex="${i}" data-s="${j}" data-v="${v}">${n}</button>`).join('')}</div>
    </div>`;
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
      ${Object.entries(ACT_TYPES).map(([t, n]) => `<button class="btn" data-a="add-act" data-wid="${w.id}" data-t="${t}">+ ${n}</button>`).join('')}
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
  const sug = rec && rec.type === a.type && rec.dist ? rec : null;
  return `<div class="card">
    ${actHead(w, k, ACT_TYPES[a.type])}
    ${a.type === 'run' ? `<div class="seg" style="margin-bottom:4px">${[['steady', 'Steady'], ['intervals', 'Intervals']].map(([v, n]) => `<button class="${(a.style || 'steady') === v ? 'on' : ''}" data-a="act-set" data-wid="${w.id}" data-i="${k}" data-f="style" data-v="${v}">${n}</button>`).join('')}</div>` : ''}
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
    if (p) parts.push(`${ACT_TYPES[a.type]} ${a.dist} mi · ${fmtPace(p)} /mi`);
    else parts.push(a.dist ? `${ACT_TYPES[a.type]} ${a.dist} mi` : m ? `${ACT_TYPES[a.type]} ${fmtDur(m)}` : ACT_TYPES[a.type]);
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
const GOALS = {
  bulk: { name: 'Lean bulk', lo: 0.1, hi: 0.5, aim: 'gain about 0.25% of your weight a week' },
  maintain: { name: 'Maintain', lo: -0.2, hi: 0.2, aim: 'hold steady' },
  cut: { name: 'Cut', lo: -1, hi: -0.5, aim: 'lose 0.5 to 1% of your weight a week' },
};
// 7-day average weight and how far it moved from the week before. Daily weight swings with water and salt.
function weightTrend(date) {
  const ins = (from, to) => Object.values(S.body).filter(b => b.weight != null && b.date >= from && b.date <= to).map(b => +b.weight);
  const cur = ins(addDays(date, -6), date), prev = ins(addDays(date, -13), addDays(date, -7));
  if (cur.length < 2) return null;
  const avg = sum(cur) / cur.length, out = { avg: round1(avg) };
  if (prev.length >= 2) { const pa = sum(prev) / prev.length; out.rate = round1(avg - pa); out.pct = (avg - pa) / pa * 100; }
  return out;
}
function goalNote(t) {
  const g = GOALS[S.settings.goal] || GOALS.maintain, k = S.settings.goal;
  if (!t || t.pct == null) return `Goal: ${g.name}, ${g.aim}. ${Object.values(S.body).filter(b => b.weight != null).length >= 10 ? 'A few more morning weigh-ins and the trend shows here.' : 'Weigh in most mornings and the trend shows up in two weeks.'}`;
  if (t.pct > g.hi) return k === 'cut' ? 'Losing slower than planned. About 200 fewer calories a day, or walk a bit more.'
    : k === 'bulk' ? 'Gaining fast, so some of it is likely fat. About 200 fewer calories a day.' : 'Creeping up. About 200 fewer calories a day.';
  if (t.pct < g.lo) return k === 'cut' ? 'Losing fast, which can cost muscle. About 200 more calories a day.'
    : k === 'bulk' ? 'Not gaining yet. Add about 200 calories a day, like a glass of milk.' : 'Drifting down. Add about 200 calories a day.';
  return `On track for your ${g.name.toLowerCase()}. 👌`;
}
// Past days keep the target they had, so changing a setting never rewrites how a day went.
function proteinTargetFor(date) {
  const b = S.body[date];
  if (b && b.target && date < todayStr()) return b.target;
  return liveTarget(date);
}
function liveTarget(date) {
  if (S.settings.proteinMode === 'auto') {
    const b = latestWeighIn(date);
    if (b) return Math.round(proteinBasisLb(b.weight) * perLbFor());
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
  const wi = latestWeighIn(date);
  const why = date < today && b.target ? `${b.target} g, what it was that day` : S.settings.proteinMode !== 'auto' ? 'Fixed target. Change it in More.'
    : wi ? `${perLbFor()} g × ${proteinBasisLb(wi.weight)} lb${proteinBasisLb(wi.weight) !== wi.weight ? ' (weight at a BMI of 25 for your height)' : ' bodyweight'}${wi.date !== date ? `, weighed ${esc(fmtDate(wi.date, { month: 'short', day: 'numeric' }))}` : ''}${S.settings.goal === 'cut' ? '. Higher on a cut to protect muscle' : ''}`
    : 'Log your weight and the target follows it.';
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
        ${trend.rate != null ? `<div><b>${trend.rate > 0 ? '+' : ''}${trend.rate} lb</b><span>vs the week before</span></div>` : ''}</div>` : ''}
      <div class="sh-hint">${esc(goalNote(trend))} <button class="linkbtn inline" data-a="go-goal">Change goal</button></div>
    </div>

    <div class="card">
      <label class="lbl">Protein</label>
      <div class="big-num">${b.protein}<small> / ${target} g</small></div>
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
function photoCard() {
  const ps = [...S.photos].sort((a, c) => c.date.localeCompare(a.date) || c.at - a.at);
  return `<h2>Progress photos</h2>
    <div class="card">
      ${ps.length ? `<div class="photos">${ps.slice(0, 9).map(p => `<button data-a="photo-open" data-id="${p.id}" aria-label="Photo from ${esc(fmtDate(p.date))}"><img src="${photoUrl(p)}" alt=""><span>${esc(fmtDate(p.date, { month: 'short', day: 'numeric' }))}</span></button>`).join('')}</div>` : ''}
      <button class="btn ${!ps.length || ps[0].date <= addDays(todayStr(), -85) ? 'pri' : ''} block" data-a="photo-add">${ps.length && ps[0].date <= addDays(todayStr(), -85) ? '+ Time for new photos' : '+ Add a photo'}</button>
      <div class="sh-hint">Same spot, same light, every 3 months. Photos stay on this phone and aren't in backups.</div>
    </div>`;
}
function photoSheetHTML() {
  const p = S.photos.find(x => x.id === S.sheet.id);
  if (!p) return '';
  const first = [...S.photos].sort((a, c) => a.date.localeCompare(c.date))[0];
  const cmp = S.sheet.compare && first && first.id !== p.id;
  return `<div class="sh-grip"></div>
    <div class="sh-title">${esc(fmtDate(p.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</div>
    <div class="photo-view ${cmp ? 'two' : ''}">
      ${cmp ? `<figure><img src="${photoUrl(first)}" alt="First photo"><figcaption>${esc(fmtDate(first.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</figcaption></figure>` : ''}
      <figure><img src="${photoUrl(p)}" alt="Progress photo">${cmp ? `<figcaption>${esc(fmtDate(p.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</figcaption>` : ''}</figure>
    </div>
    <div class="sheet-actions">
      ${first && first.id !== p.id && first.date !== p.date ? `<button class="btn block" data-a="photo-compare">${cmp ? 'Show just this one' : 'Compare with your first'}</button>` : ''}
      <button class="btn danger block" data-a="photo-del">Delete photo</button>
      <button class="btn ghost block" data-a="sheet-close">Close</button>
    </div>`;
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
    const rest = S.program.days[d].type === 'rest';
    const dd = addDays(ws, DAYS.indexOf(d)), did = doneNow.has(d) || S.workouts.some(x => x.date === dd && hasWork(x));
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
      if (!sets.length || /\(stack #\)/.test(e.name)) continue;
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
      <div class="rem-row" style="margin-top:14px">
        <div><b>Ask how hard it was</b><small>After the last set of each lift: could you have done one more rep? A no means it was all-out, so next time you match it before adding reps.</small></div>
        <button class="toggle ${S.settings.askRir !== false ? 'on' : ''}" data-a="ask-rir">${S.settings.askRir !== false ? 'On' : 'Off'}</button>
      </div>
      <div class="sh-hint">Pops up in the top corner after each set. Partway through a superset round it counts up instead. iPhone doesn't let web apps vibrate, so it beeps and flashes the screen. Keep the app open and your ringer on to hear it.</div>
    </div>

    ${proteinCard()}
    ${reminderCard()}

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
      <div class="sh-hint">${GOALS[g].name}: ${GOALS[g].aim}. The Body tab checks your 7-day average against it${g === 'cut' ? ', and protein goes up to at least 1 g per lb' : ''}.</div>
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
      <div class="sh-hint">${wi ? `Today's target is ${proteinTargetFor(today)} g, from your ${wi.weight} lb weigh-in.` : `Log your weight on the Body tab and the target follows it. Until then it's ${S.settings.proteinTarget} g.`} A common range for lifting is 0.7 to 1 g per pound.</div>`
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
const EX_DEFAULT = { name: '', sets: 3, min: 8, max: 12, inc: UP, kind: 'compound', body: 'upper', unit: 'reps', note: '' };
const exData = x => ({ name: x.name, sets: x.sets, min: x.min ?? '', max: x.max ?? '', inc: x.inc || UP, kind: x.kind, body: x.body, unit: x.unit || 'reps', note: x.note || '' });
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
    + ({ set: setSheetHTML, ex: exSheetHTML, act: actSheetHTML, other: otherSheetHTML, meas: measSheetHTML, photo: photoSheetHTML, past: pastSheetHTML, info: infoSheetHTML })[S.sheet.kind]();
}
// Swipe a sheet down to close it: from the top edge, or anywhere once it's scrolled to the top.
(function sheetSwipe() {
  const panel = document.getElementById('sheet-panel');
  if (!panel) return;
  let y0 = 0, t0 = 0, dy = 0, drag = false, armed = false;
  panel.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1) return;
    const t = ev.target, nearTop = ev.touches[0].clientY - panel.getBoundingClientRect().top < 56;
    armed = (panel.scrollTop <= 0 || nearTop) && !t.closest('input, textarea, select');
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
      setTimeout(() => { panel.style.transition = ''; panel.style.transform = ''; closeSheet(); }, 190);
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
  const rd = steps ? 5 : 1;
  return `<div class="sh-grip"></div>
    <div class="sh-title">${esc(e.name)}<span>Set ${sh.j + 1} of ${e.sets.length} · target ${esc(targetText(e.target))}</span></div>
    <label class="lbl">Weight (lb)</label>
    <div class="stepper">
      <button class="st-btn" data-a="ss-step" data-f="w" data-d="-5">−5</button>
      <button class="st-btn sm" data-a="ss-step" data-f="w" data-d="-2.5">−2.5</button>
      <input class="st-inp" inputmode="decimal" data-ssf="w" value="${esc(sh.w)}" placeholder="">
      <button class="st-btn sm" data-a="ss-step" data-f="w" data-d="2.5">+2.5</button>
      <button class="st-btn" data-a="ss-step" data-f="w" data-d="5">+5</button>
    </div>
    <button class="linkbtn" data-a="ss-bw">No weight (bodyweight)</button>
    ${sh.later ? `<div class="rem-row" style="margin-top:6px">
      <div><b>Same weight for the next ${sh.later === 1 ? 'set' : `${sh.later} sets`}</b><small>${sh.chain ? 'A new weight here carries forward.' : 'Only this set changes, so each set keeps its own weight.'}</small></div>
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
  let picks = sess || sh.g == null ? knownExercises(new Set(sess ? w.exercises.map(e => e.key) : [])) : [];
  if (ex) {
    // Swaps that work the same muscles come first.
    // A lift that bothers you lists gentler options (machines, curls, extensions) first.
    const mine = musclesOf(ex.name), gentle = careOf(ex.name) ? 1 : 0;
    const score = n => sum(Object.entries(musclesOf(n)).map(([m, f]) => Math.min(f, mine[m] || 0))) + (gentle && LOW_STRAIN.test(n) ? 1 : 0);
    picks = picks.map(p => ({ p, sc: score(p.name) })).sort((a, b) => b.sc - a.sc).map(x => x.p);
  }
  if (ex) { const near = picks.filter(p => sum(Object.entries(musclesOf(p.name)).map(([m, f]) => Math.min(f, musclesOf(ex.name)[m] || 0))) > 0); if (near.length >= 3) picks = near; }
  picks = picks.slice(0, ex ? 8 : 16);
  const sample = ex ? (+(ex.sets.find(s => s.w !== '') || {}).w || 0) : 0;
  return `<div class="sh-grip"></div>
    <div class="sh-title">${title}${sess ? `<span>${sh.i == null ? 'Just for today, unless you save it below' : 'Swap it, or change today\'s sets and reps'}</span>` : ''}</div>
    ${picks.length ? `<label class="lbl">${sh.i == null ? 'Pick one you know' : 'Swap for (one tap)'}</label>
      <div class="alt-row pick-row">${picks.map(p => `<button class="chip" data-a="${ex ? 'sx-swap' : 'sf-pick'}" data-n="${esc(p.name)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
    ${ex ? formLink(ex.name) : ''}
    ${ex || sh.g != null ? careSeg(ex ? ex.name : x.name) : ''}
    ${ex ? '<button class="btn danger block" style="margin-top:12px" data-a="sx-rm">Remove from today</button><label class="lbl" style="margin-top:20px">Or change it</label>' : ''}
    <label class="lbl">Name</label>
    <input class="inp" data-sf="name" value="${esc(x.name)}" placeholder="e.g. Goblet squat">
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
    <div class="alt-row pick-row">${Object.entries(ACT_TYPES).map(([t, n]) => btn(`data-t="${t}"`, n)).join('')}</div>
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
    ${S.pickDay && S.pickDay.date === todayStr() && S.pickDay.k !== dayKeyOf(todayStr()) ? `<button class="btn block" data-a="pick-day" data-k="${dayKeyOf(todayStr())}">Back to today's plan (${esc(S.program.days[dayKeyOf(todayStr())].label)})</button>` : ''}
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
  return { id: id || uid('e'), name: String(x.name).trim(), sets: +x.sets, min, max, inc: +x.inc, kind: x.kind, body: x.body, stepSet: true, unit: x.unit, note: String(x.note).trim() };
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
    e.name = item.name; e.key = keyOf(item.name);
    e.target = { sets: item.sets, min: item.min, max: item.max, inc: item.inc, kind: item.kind, body: item.body, stepSet: true, unit: item.unit, note: item.note };
    if (changed) fillSets(e, w);
    if (sh.toPlan && plan) {
      const at = e.pid && findPlanItem(plan, e.pid);
      if (at) at.g[at.k] = { ...item, id: e.pid };
      else { plan.groups = plan.groups || []; plan.groups.push([item]); e.pid = item.id; }
    }
    toast(sh.toPlan && plan ? 'Changed here and for next time' : 'Swapped for today');
  }
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
      const item = { id: uid('e'), name: e.name, sets: Math.max(t.sets, e.sets.length), min: t.min, max: t.max, inc: t.inc, kind: t.kind, body: t.body, stepSet: true, unit: t.unit, note: t.note };
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
    const at = S.sheet.i;
    w.exercises.splice(at, 1);
    persist(w); closeSheet(); render();
    toastUndo(`Removed ${e.name} for today`, () => { w.exercises.splice(at, 0, e); persist(w); render(); });
  },
  'sf-pick': d => {
    const known = knownExercises(new Set()).find(x => keyOf(x.name) === keyOf(d.n));
    S.sheet.data = known && known.sets ? exData(classify({ ...known })) : { ...S.sheet.data, name: d.n };
    renderSheet();
  },
  'sx-swap': d => { ACT['sf-pick'](d); saveSessExercise(); },
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
  'do-today': d => { S.pickDay = { date: todayStr(), k: d.k }; S.dayView = null; render(); scrollTo(0, 0); },
  'add-act': d => {
    const w = getW(d.wid);
    w.activities = w.activities || [];
    if (d.t === 'yoga') { ACT['add-yoga']({ wid: d.wid, id: recommendYoga(w.date).pick.id }); return; }
    w.activities.push({ type: d.t, dist: '', min: '', sec: '', notes: '', ...(d.style ? { style: d.style } : {}) });
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
  'photo-open': d => { S.sheet = { kind: 'photo', id: d.id }; renderSheet(); },
  'photo-compare': () => { S.sheet.compare = !S.sheet.compare; renderSheet(); },
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
    toastUndo(`Removed ${a.type === 'other' ? a.name || 'activity' : (ACT_TYPES[a.type] || 'activity')}`, () => { w.activities.splice(+d.i, 0, a); persist(w); render(); });
  },
  'checkin-open': () => { S.checkinOpen = true; render(); },
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
  'ask-rir': () => { S.settings.askRir = S.settings.askRir === false; saveSettings(); render(); },
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
    if (S.sheet.chain && +old !== nw) e.sets.forEach((x, k) => { if (k > S.sheet.j && !x.done) x.w = nw; });
    const wasDone = s.done, i = S.sheet.i, j = S.sheet.j;
    closeSheet();
    if (wasDone || (d && d.only)) { persist(w); render(); return; }
    const next = nextSet(w, i, j);
    keepInPlace(next ? setSel(w, ...next) : setSel(w, i, j), () => logSet(w, i, j));
    if (next) showAboveTimer(setSel(w, ...next));
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
    // The 3 biggest lifts, 2 sets each: about 20 minutes, and enough to keep your strength.
    const big = before.filter(e => targetOf(e).kind !== 'iso'), pick = (big.length >= 3 ? big : before).slice(0, 3);
    w.exercises = pick.map((e, k) => ({ ...e, group: k, sets: e.sets.slice(0, 2) }));
    w.short = true; persist(w); render();
    toastUndo('Short version: 3 lifts, 2 sets each.', () => { w.exercises = before; w.short = false; persist(w); render(); });
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
document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset.wb && el.dataset.wb !== 'date') {
    const w = getW(el.dataset.wid);
    if (w) {
      setPath(w, el.dataset.wb, el.value);
      const m = el.dataset.wb.match(/^activities\.(\d+)\.(\w+)/);
      if (m) actTimeSync(w, +m[1], m[2]);
      const src = el.dataset.wb === 'notes' ? 'w' : m && m[2] === 'notes' ? m[1] : null;
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
  } else if (el.id === 'photo-file' && el.files[0]) {
    const f = el.files[0];
    el.value = '';
    shrinkPhoto(f).then(blob => {
      const p = { id: uid('p'), date: S.bodyDate, at: Date.now(), blob };
      S.photos.push(p);
      return DB.put('photos', p).then(() => { render(); toast('Photo saved on this phone'); });
    }).catch(err => toast(`Couldn't save that photo: ${err.message}`));
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
    flushSaves();
    if (progTimer) { clearTimeout(progTimer); progTimer = null; saveProgram(); }
  } else if (S.program) {
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
