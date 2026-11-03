'use strict';
/* Lift Log: an offline workout tracker. Everything is stored on this device in IndexedDB. */

const APP_VERSION = '1.3';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const ACT_TYPES = { yoga: 'Yoga', walk: 'Walk', run: 'Run' };
const COACH_MARK = { up: '▲', down: '▼', reps: '↗', hold: '→', beat: '★' };
const DEFAULT_SETTINGS = {
  restSec: 90, sound: true, lastBackup: null,
  proteinMode: 'auto', proteinPerLb: 0.85, proteinTarget: 155,
  reminder: { on: false, time: '09:00', id: null },
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
const e1rm = (w, r) => r <= 1 ? w : w * (1 + r / 30);

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chart: '<path d="M4 19h16M6 15l4-4 3 3 5-6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  up: '<path d="M6 14l6-6 6 6"/>',
  down: '<path d="M6 10l6 6 6-6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  note: '<path d="M6 4h9l4 4v12H6z"/><path d="M9.5 12h6M9.5 16h4"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24">${ICONS[n]}</svg>`;

// ---------- database ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('liftlog', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('kv', { keyPath: 'k' });
        d.createObjectStore('workouts', { keyPath: 'id' });
        d.createObjectStore('body', { keyPath: 'date' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  run(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
    });
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
  return { id: uid('e'), name, sets, min, max, inc, unit: 'reps', note: '', ...extra };
}
function defaultProgram() {
  return {
    days: {
      mon: { label: 'Full body A', type: 'strength', groups: [
        [ex('Bench press', 3, 6, 8, UP)],
        [ex('Hip thrust', 3, 8, 10, LO)],
        [ex('Lat pulldown', 3, 8, 10, UP)],
        [ex('Cable fly', 2, 10, 12, UP)],
        [ex('Leg press', 2, 10, 10, LO, { note: 'Feet high' })],
        [ex('Bar curl', 3, 8, 12, UP), ex('Rope pushdown', 3, 8, 12, UP)],
        [ex('Lateral raise', 3, 12, 15, UP)],
      ] },
      tue: { label: 'Yoga + walk/run', type: 'cardio' },
      wed: { label: 'Full body B', type: 'strength', groups: [
        [ex('Incline DB press', 3, 8, 10, UP)],
        [ex('Romanian deadlift', 3, 8, 8, LO)],
        [ex('Row', 3, 8, 10, UP)],
        [ex('Hip abduction', 3, 12, 15, LO)],
        [ex('DB curl', 3, 10, 12, UP), ex('Overhead triceps extension', 3, 10, 12, UP)],
        [ex('Calf raise', 3, 10, 15, LO)],
        [ex('Abs', 2, null, null, UP)],
      ] },
      thu: { label: 'Yoga + easy walk/run', type: 'cardio' },
      fri: { label: 'Full body C', type: 'strength', groups: [
        [ex('Chest press or dips', 3, 8, 10, UP)],
        [ex('Bulgarian split squat', 3, 8, 8, LO, { note: 'Per leg' })],
        [ex('Pull-ups', 3, null, null, UP, { note: 'Max reps' })],
        [ex('Cable crossover', 2, 12, 12, UP)],
        [ex('Hamstring curl', 2, 10, 10, LO)],
        [ex('Hammer curl', 3, 10, 12, UP), ex('Pushdown', 3, 10, 12, UP)],
        [ex('Lateral raise', 2, 12, 15, UP), ex('Face pull', 2, 12, 15, UP)],
        [ex('Calf raise', 3, 10, 15, LO)],
        [ex("Farmer's carry", 3, 40, 40, UP, { unit: 'steps' })],
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
  draft: null,       // today's session before anything is logged
  histSeg: 'workouts',
  bodyDate: todayStr(),
  sheet: null,
  persisted: null,
};

async function loadState() {
  const kv = Object.fromEntries((await DB.all('kv')).map(r => [r.k, r.v]));
  S.program = kv.program || defaultProgram();
  S.settings = { ...DEFAULT_SETTINGS, ...(kv.settings || {}) };
  S.settings.reminder = { ...DEFAULT_SETTINGS.reminder, ...((kv.settings || {}).reminder || {}) };
  S.foods = kv.foods || [];
  if (!kv.program) await saveProgram();
  S.workouts = await DB.all('workouts');
  S.body = {};
  (await DB.all('body')).forEach(b => { S.body[b.date] = b; });
  S.draft = null;
}

const saveProgram = () => { S.draft = null; return DB.put('kv', { k: 'program', v: S.program }); };
const saveSettings = () => DB.put('kv', { k: 'settings', v: S.settings });
let progTimer;
const saveProgramSoon = () => { clearTimeout(progTimer); progTimer = setTimeout(saveProgram, 400); };

function adopt(w) {
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
const hasWork = w => w.type === 'strength'
  ? (w.exercises || []).some(e => doneSets(e).length)
  : w.type === 'cardio' ? (w.activities || []).length > 0 : false;
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
    if (e) out.push({ date: o.date, sets: doneSets(e) });
  }
  return out;
}
const lastPerf = (key, w) => recentPerf(key, w, 1)[0] || null;
const roundTo = (v, step) => Math.round(v / step) * step;

// Today's plan for an exercise, worked out from the last two sessions:
// top of the range on every set → more weight; inside the range → same weight, one more rep;
// short of the range → same weight again; short two sessions running → drop about 10%.
function coachPlan(t, recent) {
  const last = recent[0];
  if (!last) return null;
  const inc = t.inc || UP;
  const top = Math.max(...last.sets.map(s => +s.w || 0));
  const reps = last.sets.map(s => +s.r);
  const unit = t.unit === 'steps' ? 'steps' : 'reps';
  if (t.min == null && t.max == null) {
    return { kind: 'beat', w: top, from: top, reps, note: `Beat last time: ${sum(reps)} ${unit} in total. Go for one more.` };
  }
  const lo = t.min ?? t.max, hi = t.max ?? t.min;
  const short = p => p.sets.length < t.sets || p.sets.some(x => +x.r < lo);
  if (last.sets.length >= t.sets && reps.every(r => r >= hi)) {
    if (!top) return { kind: 'reps', w: 0, from: 0, reps: reps.map(r => r + 1), note: `You hit ${hi} on every set. Add a little weight or slow the reps down.` };
    const w = round2(top + inc);
    return { kind: 'up', w, from: top, reps: Array(t.sets).fill(lo), note: `You hit ${hi} on every set last time, so it's up to ${w} lb. Aim for ${lo} or more.` };
  }
  if (short(last)) {
    const prev = recent[1];
    const prevTop = prev ? Math.max(...prev.sets.map(s => +s.w || 0)) : 0;
    if (top && prev && short(prev) && prevTop >= top) {
      const step = inc >= 5 ? 5 : 2.5;
      const w = Math.max(step, Math.min(top - step, roundTo(top * 0.9, step)));
      return { kind: 'down', w, from: top, reps: Array(t.sets).fill(hi), note: `Two tough sessions in a row, so it's ${w} lb today. Build back up from here.` };
    }
    return { kind: 'hold', w: top, from: top, reps: reps.map(r => Math.max(r, lo)), note: `Stay at ${top ? `${top} lb` : 'bodyweight'} and get ${lo} on every set.` };
  }
  return {
    kind: 'reps', w: top, from: top,
    reps: Array.from({ length: t.sets }, (_, k) => Math.min(hi, (reps[k] ?? reps[reps.length - 1]) + 1)),
    note: `Same weight. Go for one more rep per set (top of the range is ${hi}).`,
  };
}

// Tailor the rest of today's sets to how this one went.
function adjustRest(e, j) {
  const t = e.target, s = e.sets[j];
  if (t.min == null && t.max == null) return '';
  const lo = t.min ?? t.max, hi = t.max ?? t.min, inc = t.inc || UP, w0 = +s.w;
  const rest = e.sets.filter((x, k) => k > j && !x.done && +x.w === w0);
  if (!rest.length || !w0) return '';
  if (+s.r >= hi + 2) {
    rest.forEach(x => { x.w = round2(w0 + inc); x.r = lo; });
    return `Strong set. Next set +${inc} lb.`;
  }
  if (+s.r < lo && w0 > inc) {
    rest.forEach(x => { x.w = round2(w0 - inc); x.r = lo; });
    return `Under ${lo}. Next set −${inc} lb to stay in range.`;
  }
  return '';
}

function buildSession(dayKey, date) {
  const day = S.program.days[dayKey];
  const w = { id: uid('w'), date, dayKey, type: day.type, label: day.label, notes: '', createdAt: Date.now() };
  if (day.type === 'strength') {
    w.exercises = [];
    (day.groups || []).forEach((g, gi) => g.forEach(x => {
      const e = {
        key: keyOf(x.name), name: x.name, group: gi,
        target: { sets: x.sets, min: x.min, max: x.max, inc: x.inc, unit: x.unit || 'reps', note: x.note || '' },
        sets: [],
      };
      const plan = coachPlan(e.target, recentPerf(e.key, w, 2));
      if (plan) e.coach = { kind: plan.kind, note: plan.note, from: plan.from, w: plan.w };
      for (let k = 0; k < x.sets; k++) {
        if (plan) e.sets.push({ w: plan.w, r: plan.reps[Math.min(k, plan.reps.length - 1)], done: false });
        else e.sets.push({ w: '', r: x.min ?? x.max ?? '', done: false });
      }
      w.exercises.push(e);
    }));
  } else if (day.type === 'cardio') {
    w.activities = [];
  }
  return w;
}

function todaySession() {
  const date = todayStr();
  const todays = sortedW().filter(w => w.date === date);
  const picked = S.pickDay && S.pickDay.date === date ? S.pickDay.k : null;
  const dayKey = picked || (todays.find(hasAny) || {}).dayKey || dayKeyOf(date);
  const found = todays.find(w => w.dayKey === dayKey);
  if (found) return found;
  if (!S.draft || S.draft.date !== date || S.draft.dayKey !== dayKey) S.draft = buildSession(dayKey, date);
  return S.draft;
}

function tick(w, i, j) {
  const s = w.exercises[i].sets[j];
  if (s.done) { s.done = false; persist(w); render(); return; }
  if (s.w === '' || s.r === '') { openSetSheet(w, i, j); return; }
  logSet(w, i, j);
}

function logSet(w, i, j) {
  const e = w.exercises[i], s = e.sets[j];
  s.done = true;
  s.at = Date.now();
  e.sets.forEach((x, k) => { if (k > j && !x.done && x.w === '') x.w = s.w; });
  const today = w.date === todayStr();
  const msgs = [];
  if (today) { const tip = adjustRest(e, j); if (tip) msgs.push(tip); }
  persist(w);
  haptic();
  // In a superset, rest only after the whole round is done.
  if (today) {
    const grp = w.exercises.filter(x => x.group === e.group);
    const roundDone = grp.every(x => !x.sets[j] || x.sets[j].done);
    if (roundDone) startTimer(S.settings.restSec);
    else msgs.push(`Next: ${grp.find(x => x.sets[j] && !x.sets[j].done).name}`);
  }
  if (msgs.length) toast(msgs.join(' · '));
  render();
}

// ---------- rest timer ----------
const T = { end: 0, total: 0, iv: null, doneAt: 0 };
function startTimer(sec) {
  T.total = sec;
  T.end = Date.now() + sec * 1000;
  T.doneAt = 0;
  clearInterval(T.iv);
  T.iv = setInterval(drawTimer, 250);
  $('#timer').hidden = false;
  $('#timer').classList.remove('done');
  document.body.classList.add('has-timer');
  drawTimer();
}
function stopTimer() {
  clearInterval(T.iv);
  T.iv = null;
  $('#timer').hidden = true;
  document.body.classList.remove('has-timer');
}
function drawTimer() {
  const left = Math.max(0, Math.ceil((T.end - Date.now()) / 1000));
  if (left === 0 && !T.doneAt) {
    T.doneAt = Date.now();
    timerDone();
  }
  if (T.doneAt && Date.now() - T.doneAt > 8000) { stopTimer(); return; }
  $('#tm-left').textContent = T.doneAt ? 'Go!' : fmtClock(left);
  $('#tm-label').textContent = T.doneAt ? 'Rest done' : 'Rest';
  $('#tm-fill').style.width = `${T.total ? (left / T.total) * 100 : 0}%`;
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
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), msg.length > 30 ? 3200 : 2200);
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
  if (S.view) html = ({ workout: viewWorkout, exercise: viewExercise, progDay: viewProgDay })[S.view.name]();
  else html = ({ today: viewToday, history: viewHistory, body: viewBody, stats: viewStats, more: viewMore })[S.tab]();
  $('#view').innerHTML = html;
  celebrateDay();
}

// ----- daily streak -----
// A day counts if you trained, weighed in, or hit your protein goal.
function dayCounts(date) {
  const b = S.body[date];
  if (b && (b.weight != null || (b.protein || 0) >= proteinTargetFor(date))) return true;
  return S.workouts.some(w => w.date === date && hasWork(w));
}
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
      <div class="sh-hint">${done ? 'Today counts. See you tomorrow.' : n ? 'Keep it going today: train, weigh in, or hit your protein.' : 'Train, weigh in, or hit your protein today to start one.'}</div>
      <div class="cal">${DAYS.map(d => `<span>${DAY_SHORT[d][0]}</span>`).join('')}${cells}</div>
    </div>`;
}

function weekDoneKeys(ws) {
  const end = addDays(ws, 6);
  const keys = new Set(S.workouts.filter(w => w.date >= ws && w.date <= end && hasWork(w)).map(w => w.dayKey));
  return plannedKeys().filter(k => keys.has(k));
}
const plannedKeys = () => DAYS.filter(d => S.program.days[d].type !== 'rest');

// ----- Today -----
function viewToday() {
  const date = todayStr();
  const w = todaySession();
  const realKey = dayKeyOf(date);
  const done = new Set(weekDoneKeys(weekStart(date)));
  const day = S.program.days[w.dayKey];
  const chips = DAYS.map(d => {
    const t = S.program.days[d].type;
    const cls = [d === w.dayKey ? 'on' : '', d === realKey ? 'today' : '', t === 'rest' ? 'rest' : ''].join(' ');
    return `<button class="chip ${cls}" data-a="pick-day" data-k="${d}">${DAY_SHORT[d]}${done.has(d) ? '<span class="dot"></span>' : ''}</button>`;
  }).join('');
  let body;
  if (w.type === 'strength') body = sessionStrength(w);
  else if (w.type === 'cardio') body = sessionCardio(w);
  else body = `<div class="card rest-card"><div class="big">Rest day</div><div class="muted">Recover, eat your protein, and sleep well. Missed a session this week? Pick its day above to do it today.</div></div>
    <button class="btn block" data-a="tab" data-t="body">Log bodyweight and protein</button>`;
  return `
    <header class="top">
      <div class="top-row">
        <div class="eyebrow">${esc(fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
        <button class="streak-pill ${dayCounts(date) ? 'on' : ''}" data-a="tab" data-t="stats" aria-label="Daily streak">🔥 ${dailyStreak()}</button>
      </div>
      <h1>${DAY_NAMES[w.dayKey]}<span class="sub">${esc(day.label)}</span></h1>
      ${w.dayKey !== realKey ? `<div class="note-line">Doing ${DAY_NAMES[w.dayKey]}'s session today.</div>` : ''}
    </header>
    <div class="chips">${chips}</div>
    ${body}`;
}

function sessionStrength(w) {
  if (!w.exercises.length) {
    return `<div class="card empty"><b>No exercises yet</b>Add some in More → Program.</div>`;
  }
  const groups = [];
  w.exercises.forEach((e, i) => {
    const g = groups.find(x => x.id === e.group);
    if (g) g.items.push(i); else groups.push({ id: e.group, items: [i] });
  });
  const cards = groups.map(g => {
    const multi = g.items.length > 1;
    const up = g.items.some(i => (w.exercises[i].coach || {}).kind === 'up');
    const inner = g.items.map((i, k) => exBlock(w, i, multi ? String.fromCharCode(65 + k) : '')).join('');
    return `<section class="card ${multi ? 'ss' : ''} ${up ? 'up' : ''}">
      ${multi ? '<div class="ss-tag">Superset <span>· alternate, rest after the round</span></div>' : ''}
      ${inner}
    </section>`;
  }).join('');
  const total = sum(w.exercises.map(e => e.sets.length));
  const logged = sum(w.exercises.map(e => e.sets.filter(s => s.done).length));
  return `${cards}
    ${notesCard(w)}
    <button class="btn block big ${w.finishedAt ? 'good' : 'pri'}" data-a="finish" data-wid="${w.id}">
      ${w.finishedAt ? `${ic('check')} Finished · ${logged} of ${total} sets` : `Finish workout · ${logged} of ${total} sets`}
    </button>`;
}

function exBlock(w, i, letter) {
  const e = w.exercises[i];
  const last = lastPerf(e.key, w);
  const c = e.coach;
  const unit = e.target.unit === 'steps' ? 'steps' : 'reps';
  const lastTxt = last
    ? `Last time (${esc(fmtDate(last.date, { month: 'short', day: 'numeric' }))}): <b>${last.sets.map(s => `${fmtW(s.w)}×${s.r}`).join(', ')}</b>`
    : 'First time logging this. Enter a weight to start.';
  const canKeep = c && (c.kind === 'up' || c.kind === 'down') && e.sets.some(s => !s.done && +s.w === c.w);
  const banner = c ? `<div class="coach coach-${c.kind}"><span>${COACH_MARK[c.kind] || '→'} ${esc(c.note)}</span>
      ${canKeep ? `<button data-a="keep-w" data-wid="${w.id}" data-ex="${i}">Keep ${c.from}</button>` : ''}</div>` : '';
  const rows = e.sets.map((s, j) => `
    <div class="set ${s.done ? 'done' : ''}">
      <span class="set-no">${j + 1}</span>
      <button class="set-val" data-a="edit-set" data-wid="${w.id}" data-ex="${i}" data-s="${j}" aria-label="Edit set ${j + 1}">
        <b>${fmtW(s.w)}</b>${s.w !== '' && +s.w !== 0 ? '<small>lb</small>' : ''}<span class="x">×</span><b>${s.r === '' ? '—' : s.r}</b><small>${unit}</small>
      </button>
      <button class="check" data-a="tick" data-wid="${w.id}" data-ex="${i}" data-s="${j}" aria-label="${s.done ? 'Undo set' : 'Log set'}">${ic('check')}</button>
    </div>`).join('');
  return `<div class="ex">
    <div class="ex-head">
      <div>
        <div class="ex-name">${letter ? `<span class="ss-letter">${letter}</span>` : ''}${esc(e.name)}</div>
        <div class="ex-target">${esc(targetText(e.target))}</div>
      </div>
      <button class="icon-btn" data-a="ex-chart" data-key="${esc(e.key)}" aria-label="Progress chart">${ic('chart')}</button>
    </div>
    <div class="ex-last">${lastTxt}</div>
    ${banner}
    <div class="sets">${rows}</div>
    <div class="ex-tools">
      <button data-a="add-set" data-wid="${w.id}" data-ex="${i}">+ Set</button>
      ${e.sets.length > 1 ? `<button data-a="rm-set" data-wid="${w.id}" data-ex="${i}">− Set</button>` : ''}
    </div>
  </div>`;
}

function notesCard(w) {
  return `<div class="card">
    <label class="lbl" for="notes-${w.id}">Notes</label>
    <textarea class="inp" id="notes-${w.id}" data-wid="${w.id}" data-wb="notes" placeholder="Pain, form cues, energy, how it felt…">${esc(w.notes)}</textarea>
  </div>`;
}

function sessionCardio(w) {
  const acts = w.activities.map((a, k) => `
    <div class="card">
      <div class="act-head"><b>${ACT_TYPES[a.type] || 'Activity'}</b>
        <button class="icon-btn" data-a="rm-act" data-wid="${w.id}" data-i="${k}" aria-label="Remove">${ic('x')}</button></div>
      <div class="grid2">
        <div><label class="lbl">Minutes</label><input class="inp" inputmode="numeric" data-wid="${w.id}" data-wb="activities.${k}.min" value="${esc(a.min)}" placeholder="0"></div>
        ${a.type !== 'yoga'
          ? `<div><label class="lbl">Miles</label><input class="inp" inputmode="decimal" data-wid="${w.id}" data-wb="activities.${k}.dist" value="${esc(a.dist)}" placeholder="0.0"></div>`
          : '<div></div>'}
      </div>
      <label class="lbl">Notes</label>
      <input class="inp" data-wid="${w.id}" data-wb="activities.${k}.notes" value="${esc(a.notes)}" placeholder="${a.type === 'yoga' ? 'Style, focus, how it felt' : 'Pace, route, how it felt'}">
    </div>`).join('');
  return `${acts || '<div class="card empty"><b>What did you do?</b>Add each part of today below.</div>'}
    <div class="add-row">
      ${Object.entries(ACT_TYPES).map(([t, n]) => `<button class="btn" data-a="add-act" data-wid="${w.id}" data-t="${t}">+ ${n}</button>`).join('')}
    </div>
    ${notesCard(w)}
    <button class="btn block big ${w.finishedAt ? 'good' : 'pri'}" data-a="finish" data-wid="${w.id}">${w.finishedAt ? `${ic('check')} Saved` : 'Save session'}</button>`;
}

// ----- History -----
function summaryOf(w) {
  if (w.type === 'strength') {
    const n = sum((w.exercises || []).map(e => doneSets(e).length));
    const exs = (w.exercises || []).filter(e => doneSets(e).length).length;
    return `${n} set${n === 1 ? '' : 's'} · ${exs} exercise${exs === 1 ? '' : 's'}`;
  }
  return (w.activities || []).map(a => {
    if (a.dist && a.min) return `${ACT_TYPES[a.type]} ${a.dist} mi in ${a.min} min`;
    if (a.dist) return `${ACT_TYPES[a.type]} ${a.dist} mi`;
    return a.min ? `${ACT_TYPES[a.type]} ${a.min} min` : ACT_TYPES[a.type];
  }).join(' · ') || 'Notes only';
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
        <span class="val">${x.best ? `${x.best}` : ''}</span>${ic('chev')}</button>`).join('')}</div>
      <div class="foot">Numbers on the right are your best estimated 1-rep max (lb).</div>`;
  }
  return `<header class="top"><h1>History</h1></header>${seg}${list}`;
}

function exHistory(key) {
  const out = [];
  for (const w of S.workouts) {
    for (const e of w.exercises || []) {
      if (e.key !== key) continue;
      const sets = doneSets(e);
      if (sets.length) out.push({ date: w.date, t: parseYmd(w.date).getTime(), name: e.name, unit: e.target && e.target.unit, sets, wid: w.id });
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
    const x = m.get(e.key) || { key: e.key, name: e.name, count: 0, last: w.date, best: 0, steps: e.target && e.target.unit === 'steps' };
    x.count++;
    if (w.date >= x.last) { x.last = w.date; x.name = e.name; }
    if (!x.steps) x.best = Math.max(x.best, Math.round(Math.max(...sets.map(s => e1rm(+s.w, +s.r)))));
    m.set(e.key, x);
  }
  return [...m.values()].sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name));
}

function viewExercise() {
  const hist = exHistory(S.view.key);
  const name = hist.length ? hist[hist.length - 1].name : S.view.key;
  const back = `<button class="backbtn" data-a="back">${ic('back')} Back</button>`;
  if (!hist.length) {
    return `${back}<header class="top"><h1>${esc(name)}</h1></header>
      <div class="card empty"><b>No sets logged yet</b>Your chart fills in after the first session.</div>`;
  }
  const stats = hist.map(h => ({ ...h, ...sessStats(h) }));
  const steps = hist.some(h => h.unit === 'steps');
  const bw = stats.every(s => !+s.top.w);
  let chart, kpis;
  if (bw) {
    chart = lineChart([{ name: 'Total reps', color: 'var(--acc)', pts: stats.map(s => [s.t, s.reps]) }]);
    kpis = [[Math.max(...stats.map(s => s.reps)), 'Best total reps'], [Math.max(...stats.map(s => +s.top.r)), 'Best set'], [stats.length, 'Sessions']];
  } else {
    const series = [{ name: 'Top set weight', color: 'var(--acc)', pts: stats.map(s => [s.t, +s.top.w]) }];
    if (!steps) series.push({ name: 'Estimated 1RM', color: '#7cc4ff', pts: stats.map(s => [s.t, s.e1]) });
    chart = lineChart(series);
    const bestTop = stats.reduce((a, s) => (+s.top.w > +a.top.w ? s : a), stats[0]);
    kpis = [[`${fmtW(bestTop.top.w)}×${bestTop.top.r}`, 'Best top set'], [steps ? stats.length : Math.max(...stats.map(s => s.e1)), steps ? 'Sessions' : 'Best est. 1RM'], [`${fmtW(stats[stats.length - 1].top.w)}×${stats[stats.length - 1].top.r}`, 'Last top set']];
  }
  const rows = [...stats].reverse().map(s => `<tr>
      <td>${esc(fmtDate(s.date, { month: 'short', day: 'numeric' }))}</td>
      <td>${s.sets.map(x => `${fmtW(x.w)}×${x.r}`).join(', ')}</td>
      <td>${bw || steps ? '' : s.e1}</td></tr>`).join('');
  return `${back}
    <header class="top"><h1>${esc(name)}</h1></header>
    <div class="kpis">${kpis.map(k => `<div class="kpi"><b>${esc(k[0])}</b><span>${k[1]}</span></div>`).join('')}</div>
    <div class="card">${chart}</div>
    <h2>Sessions</h2>
    <div class="card"><table class="sess-table">${rows}</table></div>
    ${bw || steps ? '' : '<div class="foot">Estimated 1RM uses the Epley formula: weight × (1 + reps ÷ 30).</div>'}`;
}

function viewWorkout() {
  const w = getW(S.view.id);
  if (!w) { S.view = null; return viewHistory(); }
  return `<button class="backbtn" data-a="back">${ic('back')} History</button>
    <header class="top">
      <div class="eyebrow">${esc(DAY_NAMES[w.dayKey])}'s session</div>
      <h1>${esc(fmtDate(w.date, { weekday: 'long', month: 'short', day: 'numeric' }))}<span class="sub">${esc(w.label)}</span></h1>
    </header>
    <div class="card"><label class="lbl">Date</label><input class="inp" type="date" data-wid="${w.id}" data-wb="date" value="${w.date}" max="${todayStr()}"></div>
    ${w.type === 'strength' ? sessionStrength(w) : sessionCardio(w)}
    <button class="btn danger block" style="margin-top:24px" data-a="del-w" data-id="${w.id}">Delete this workout</button>`;
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
  S.body[b.date] = b;
  DB.put('body', b);
}
function latestWeighIn(date) {
  return Object.values(S.body).filter(x => x.date <= date && x.weight != null).sort((a, c) => c.date.localeCompare(a.date))[0] || null;
}
function proteinTargetFor(date) {
  if (S.settings.proteinMode === 'auto') {
    const b = latestWeighIn(date);
    if (b) return Math.round(b.weight * S.settings.proteinPerLb);
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
function addFood(name, g) {
  const b = bodyEntry(S.bodyDate);
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
  const why = S.settings.proteinMode !== 'auto' ? 'Fixed target. You can change it in More.'
    : wi ? `${S.settings.proteinPerLb} g × ${wi.weight} lb bodyweight${wi.date !== date ? ` (weighed ${esc(fmtDate(wi.date, { month: 'short', day: 'numeric' }))})` : ''}`
    : 'Log your weight above and the target follows it.';

  const favs = S.foods.filter(f => f.fav).sort((a, c) => a.name.localeCompare(c.name));
  const recent = S.foods.filter(f => !f.fav).sort((a, c) => (c.last || 0) - (a.last || 0)).slice(0, 8);
  const foodBtn = f => `<div class="food">
      <button class="food-add" data-a="food-quick" data-n="${esc(f.name)}"><b>${esc(f.name)}</b><span>+${f.g} g</span></button>
      <button class="food-star ${f.fav ? 'on' : ''}" data-a="food-fav" data-n="${esc(f.name)}" aria-label="${f.fav ? 'Remove from favorites' : 'Add to favorites'}">${f.fav ? '★' : '☆'}</button>
    </div>`;
  const eaten = b.items.map((x, k) => `<div class="row">
      <div><b>${esc(x.name || 'Quick add')}</b></div><span class="val">${x.g} g</span>
      <button class="icon-btn" data-a="item-rm" data-i="${k}" aria-label="Remove">${ic('x')}</button></div>`).join('');

  const weights = Object.values(S.body).filter(x => x.weight != null).sort((a, c) => a.date.localeCompare(c.date)).slice(-120);
  const days14 = Array.from({ length: 14 }, (_, k) => addDays(today, k - 13));
  const hits = days14.slice(-7).filter(d => bodyEntry(d).protein >= proteinTargetFor(d)).length;

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
    </div>

    <div class="card">
      <label class="lbl">Protein</label>
      <div class="big-num">${b.protein}<small> / ${target} g</small></div>
      <div class="prog ${b.protein >= target ? 'hit' : ''}"><div style="width:${pct}%"></div></div>
      <div class="muted small" style="margin-top:-6px">${left > 0 ? `${left} g to go` : 'Target hit. Nice.'}</div>
      <div class="sh-hint">Target: ${why}</div>
    </div>

    <div class="card">
      <label class="lbl" for="food-name">Add what you ate</label>
      <div class="food-form">
        <input class="inp" id="food-name" placeholder="e.g. 3 eggs" autocomplete="off">
        <input class="inp" id="food-g" inputmode="numeric" placeholder="g">
      </div>
      <button class="btn pri block" style="margin-top:8px" data-a="food-form">Add protein</button>
      ${favs.length ? `<label class="lbl">Favorites</label>${favs.map(foodBtn).join('')}` : ''}
      ${recent.length ? `<label class="lbl">Recent</label>${recent.map(foodBtn).join('')}<div class="sh-hint">Tap ☆ to keep one as a favorite.</div>` : ''}
      <label class="lbl">Quick add</label>
      <div class="quick">${[10, 20, 25, 30, 40, 50].map(n => `<button data-a="p-add" data-n="${n}">+${n}</button>`).join('')}</div>
    </div>

    ${eaten ? `<h2>Eaten ${date === today ? 'today' : 'this day'}</h2><div class="card flush">${eaten}</div>` : ''}

    <h2>Protein · last 14 days</h2>
    <div class="card">
      ${barChart(days14.map(d => ({ label: parseYmd(d).getDate(), y: bodyEntry(d).protein, t: proteinTargetFor(d) })), proteinTargetFor(today))}
      <div class="muted small" style="margin-top:6px">Target hit on ${hits} of the last 7 days.</div>
    </div>

    <h2>Bodyweight trend</h2>
    <div class="card">${weights.length
      ? lineChart([{ name: 'Bodyweight', color: 'var(--acc)', pts: weights.map(x => [parseYmd(x.date).getTime(), x.weight]) }])
      : '<div class="empty" style="padding:16px">Log your weight a few mornings to see the trend.</div>'}</div>`;
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
    const cls = [doneNow.has(d) ? 'done' : '', rest ? 'rest' : '', d === dayKeyOf(today) ? 'today' : ''].join(' ');
    return `<div class="wd ${cls}"><i>${doneNow.has(d) ? ic('check') : ''}</i>${DAY_SHORT[d]}</div>`;
  }).join('');

  const worked = S.workouts.filter(hasWork);
  if (!worked.length) {
    return `<header class="top"><h1>Stats</h1></header>
      ${streakCard()}
      <div class="card"><b>This week</b><div class="week-dots">${dots}</div></div>
      <div class="card empty"><b>No sessions yet</b>Finish your first workout and your weekly numbers show up here.</div>`;
  }
  const firstWeek = weekStart(worked.map(w => w.date).sort()[0]);
  const weeks = [];
  for (let wk = firstWeek; wk <= ws; wk = addDays(wk, 7)) weeks.push({ wk, n: weekDoneKeys(wk).length });
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
  const consistency = past.length ? Math.round(sum(past.map(x => Math.min(x.n, need))) / (past.length * need) * 100) : null;

  const end = addDays(ws, 6);
  const thisWeek = S.workouts.filter(w => w.date >= ws && w.date <= end);
  const setsWeek = sum(thisWeek.map(w => sum((w.exercises || []).map(e => doneSets(e).length))));
  const cardioMin = sum(thisWeek.map(w => sum((w.activities || []).map(a => +a.min || 0))));
  const soFar = Array.from({ length: 7 }, (_, k) => addDays(ws, k)).filter(d => d <= today);
  const protHits = soFar.filter(d => bodyEntry(d).protein >= proteinTargetFor(d)).length;

  const rows = weeks.slice(-12).reverse().map(x => `
    <div class="wk ${full(x) ? 'full' : ''}">
      <span>${esc(fmtDate(x.wk, { month: 'short', day: 'numeric' }))}</span>
      <div class="wk-bar">${Array.from({ length: need }, (_, k) => `<i class="${k < x.n ? 'on' : ''}"></i>`).join('')}</div>
      <span>${x.n}/${need}</span>
    </div>`).join('');

  return `<header class="top"><h1>Stats</h1></header>
    ${streakCard()}
    <div class="card">
      <b>This week</b> <span class="muted">· ${doneNow.size} of ${need} planned sessions</span>
      <div class="week-dots">${dots}</div>
    </div>
    <div class="card streak">
      <div class="big-num">${streak}</div>
      <div><b>full week${streak === 1 ? '' : 's'} in a row</b><div class="muted small">with every planned session done · best ${best}</div></div>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${setsWeek}</b><span>sets this week</span></div>
      <div class="kpi"><b>${cardioMin}</b><span>cardio/yoga min</span></div>
      <div class="kpi"><b>${protHits}/${soFar.length}</b><span>protein goal days</span></div>
    </div>
    <h2>Weekly consistency${consistency != null ? ` · ${consistency}%` : ''}</h2>
    <div class="card">${rows}</div>
    <div class="foot">${worked.length} sessions logged in total. Weeks start on Monday.</div>`;
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
      <div class="sh-hint">Starts by itself after each set (after each round in a superset). iPhone doesn't let web apps vibrate, so it beeps and flashes the screen. Keep the app open and your ringer on to hear it.</div>
    </div>

    ${proteinCard()}
    ${reminderCard()}

    <h2>Backup</h2>
    <div class="card">
      <button class="btn pri block" data-a="export">Export backup (JSON)</button>
      <button class="btn block" data-a="import">Import backup</button>
      <div class="sh-hint">${lb ? `Last export: ${esc(new Date(lb).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}.` : 'No export yet.'} Everything lives only on this phone, so export now and then and save the file to iCloud Drive or Files.</div>
      <div class="sh-hint">${S.persisted === true ? 'Storage is marked as protected on this device.' : S.persisted === false ? 'Storage is not marked as protected yet. Installing to the Home Screen helps.' : ''}</div>
    </div>

    <h2>Start over</h2>
    <div class="card">
      <button class="btn danger block" data-a="prog-reset">Reset program to the original</button>
      <div class="sh-hint">Only resets the exercises and days. Your logged history stays.</div>
    </div>
    <div class="foot">Lift Log ${APP_VERSION} · works offline · no account</div>`;
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
    body = `<div class="muted small">Open Lift Log from your Home Screen icon to turn this on. iPhone only allows notifications for installed web apps.</div>`;
  } else if (!can) {
    body = `<div class="muted small">This browser can't show notifications. On iPhone you need iOS 16.4 or newer and the Home Screen app.</div>`;
  } else {
    body = `<label class="lbl" for="rem-time">Time</label>
      <input class="inp" type="time" id="rem-time" value="${r.time}" style="font-size:22px;font-weight:700">
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ${r.on ? '' : 'pri'}" data-a="${r.on ? 'rem-off' : 'rem-on'}">${r.on ? 'Turn off' : 'Turn on'}</button>
        ${r.on ? '<button class="btn" data-a="rem-test">Send a test</button>' : ''}
      </div>
      <div class="sh-hint">${r.on ? `On: every day at ${fmtTime(r.time)}. ` : ''}It skips days you've already logged your weight.</div>`;
  }
  return `<h2>Weigh-in reminder</h2><div class="card">${body}</div>`;
}

function viewProgDay() {
  const d = S.view.d, day = S.program.days[d];
  const types = [['strength', 'Lifting'], ['cardio', 'Cardio/yoga'], ['rest', 'Rest']];
  let body = '';
  if (day.type === 'strength') {
    const groups = day.groups || [];
    body = groups.map((g, gi) => `
      <div class="card flush ${g.length > 1 ? 'ss' : ''}">
        ${g.length > 1 ? '<div class="ss-tag" style="margin:12px 16px 0">Superset</div>' : ''}
        ${g.map((x, ei) => `<button class="row" data-a="edit-ex" data-g="${gi}" data-e="${ei}">
          <div><b>${esc(x.name)}</b><small>${esc(targetText(x))} · +${x.inc} lb jump</small></div>${ic('chev')}</button>`).join('')}
        <div class="ex-tools" style="padding:0 12px 12px;margin-top:0;flex-wrap:wrap">
          <button data-a="grp-move" data-g="${gi}" data-dir="-1" ${gi === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button data-a="grp-move" data-g="${gi}" data-dir="1" ${gi === groups.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          ${gi < groups.length - 1 ? `<button data-a="grp-link" data-g="${gi}">Superset with next</button>` : ''}
          ${g.length > 1 ? `<button data-a="grp-unlink" data-g="${gi}">Split superset</button>` : ''}
        </div>
      </div>`).join('') || '<div class="card empty"><b>No exercises</b>Add your first one below.</div>';
    body += `<button class="btn pri block" data-a="add-ex">+ Add exercise</button>`;
  } else if (day.type === 'cardio') {
    body = '<div class="card muted">On this day you log yoga, walks, and runs with minutes, miles, and notes.</div>';
  } else {
    body = '<div class="card muted">A rest day. It doesn\'t count toward your weekly sessions.</div>';
  }
  return `<button class="backbtn" data-a="back">${ic('back')} More</button>
    <header class="top"><h1>${DAY_NAMES[d]}</h1></header>
    <div class="card">
      <label class="lbl">Name</label>
      <input class="inp" data-pl="${d}" value="${esc(day.label)}">
      <label class="lbl">Type</label>
      <div class="seg">${types.map(([t, n]) => `<button class="${day.type === t ? 'on' : ''}" data-a="prog-type" data-v="${t}">${n}</button>`).join('')}</div>
    </div>
    ${body}
    <div class="foot">Changes apply to your next session. Renaming an exercise starts a fresh history under the new name.</div>`;
}

// ---------- sheets ----------
function openSetSheet(w, i, j) {
  const s = w.exercises[i].sets[j];
  S.sheet = { kind: 'set', wid: w.id, i, j, w: s.w === '' ? '' : String(s.w), r: s.r === '' ? '' : String(s.r) };
  renderSheet();
}
function openExSheet(g, e) {
  const day = S.program.days[S.view.d];
  const x = g == null ? { name: '', sets: 3, min: 8, max: 12, inc: UP, unit: 'reps', note: '' } : day.groups[g][e];
  S.sheet = {
    kind: 'ex', g, e,
    data: { name: x.name, sets: x.sets, min: x.min ?? '', max: x.max ?? '', inc: x.inc, unit: x.unit || 'reps', note: x.note || '' },
  };
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
  $('#sheet-panel').innerHTML = S.sheet.kind === 'set' ? setSheetHTML() : exSheetHTML();
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
      <input class="st-inp" inputmode="decimal" data-ssf="w" value="${esc(sh.w)}" placeholder="0">
      <button class="st-btn sm" data-a="ss-step" data-f="w" data-d="2.5">+2.5</button>
      <button class="st-btn" data-a="ss-step" data-f="w" data-d="5">+5</button>
    </div>
    <button class="linkbtn" data-a="ss-bw">Bodyweight only (0 lb)</button>
    <label class="lbl">${steps ? 'Steps' : 'Reps'}</label>
    <div class="stepper three">
      <button class="st-btn" data-a="ss-step" data-f="r" data-d="-${rd}">−${rd}</button>
      <input class="st-inp" inputmode="numeric" data-ssf="r" value="${esc(sh.r)}" placeholder="0">
      <button class="st-btn" data-a="ss-step" data-f="r" data-d="${rd}">+${rd}</button>
    </div>
    <div class="sheet-actions">
      <button class="btn pri block big" data-a="ss-save">${s.done ? 'Save changes' : 'Log set'}</button>
      <button class="btn ghost block" data-a="sheet-close">Cancel</button>
    </div>`;
}

function exSheetHTML() {
  const sh = S.sheet, x = sh.data;
  const segBtn = (f, v, n) => `<button class="${String(x[f]) === String(v) ? 'on' : ''}" data-a="sf-set" data-f="${f}" data-v="${v}">${n}</button>`;
  return `<div class="sh-grip"></div>
    <div class="sh-title">${sh.g == null ? 'New exercise' : 'Edit exercise'}</div>
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
    <div class="sh-hint">Use the same number twice for a fixed target (like 3 × 8). Leave both blank for max reps or no target.</div>
    <label class="lbl">Count</label>
    <div class="seg">${segBtn('unit', 'reps', 'Reps')}${segBtn('unit', 'steps', 'Steps')}</div>
    <label class="lbl">Weight jump when you hit the top</label>
    <div class="seg">${segBtn('inc', 2.5, '+2.5')}${segBtn('inc', 5, '+5 upper')}${segBtn('inc', 10, '+10 lower')}</div>
    <label class="lbl">Note</label>
    <input class="inp" data-sf="note" value="${esc(x.note)}" placeholder="e.g. per leg, feet high">
    <div class="sheet-actions">
      <button class="btn pri block big" data-a="sf-save">Save</button>
      ${sh.g != null ? '<button class="btn danger block" data-a="sf-del">Delete exercise</button>' : ''}
      <button class="btn ghost block" data-a="sheet-close">Cancel</button>
    </div>`;
}

// ---------- weigh-in reminder ----------
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const b64uBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), ch => ch.charCodeAt(0));

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
  await pushApi('subscribe', { id: r.id, sub: sub.toJSON(), time: r.time, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
}
async function reminderOn() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are off for Lift Log. Turn them on in iPhone Settings → Notifications.'); return; }
    await reminderSync();
    S.settings.reminder.on = true;
    saveSettings(); render();
    toast(`Reminder set for ${fmtTime(S.settings.reminder.time)} every day`);
  } catch (err) {
    toast(`Couldn't turn it on: ${err.message}`);
  }
}
async function reminderOff() {
  const r = S.settings.reminder;
  r.on = false;
  saveSettings(); render();
  toast('Reminder off');
  try { if (r.id) await pushApi('unsubscribe', { id: r.id }); } catch (err) { /* offline: the server drops it once pushes start failing */ }
  try { const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (err) { /* ignore */ }
}
function reminderWeighed() {
  const r = S.settings.reminder;
  if (r.on && r.id) pushApi('weighed', { id: r.id }).catch(() => {});
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
  if (!data || data.app !== 'liftlog' || !Array.isArray(data.workouts)) { toast("That file isn't a Lift Log backup."); return; }
  const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString() : 'an unknown date';
  if (!confirm(`Replace everything on this phone with the backup from ${when}? It has ${data.workouts.length} workouts.`)) return;
  await Promise.all(['kv', 'workouts', 'body'].map(DB.clear));
  await DB.put('kv', { k: 'program', v: data.program || defaultProgram() });
  await DB.put('kv', { k: 'settings', v: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } });
  await DB.putMany('workouts', data.workouts);
  await DB.putMany('body', data.body || []);
  await DB.put('kv', { k: 'foods', v: data.foods || [] });
  await loadState();
  S.view = null;
  S.pickDay = null;
  render();
  toast('Backup restored');
}

// ---------- actions ----------
function findSheetSet() {
  const w = getW(S.sheet.wid);
  return { w, e: w.exercises[S.sheet.i], s: w.exercises[S.sheet.i].sets[S.sheet.j] };
}
function progDay() { return S.program.days[S.view.d]; }

const ACT = {
  tab: d => { S.tab = d.t; S.view = null; closeSheet(); render(); scrollTo(0, 0); },
  back: () => { S.view = S.view && S.view.back; render(); scrollTo(0, 0); },
  'pick-day': d => { S.pickDay = { date: todayStr(), k: d.k }; render(); },
  seg: d => { S.histSeg = d.v; render(); },

  tick: d => tick(getW(d.wid), +d.ex, +d.s),
  'edit-set': d => openSetSheet(getW(d.wid), +d.ex, +d.s),
  'keep-w': d => {
    const w = getW(d.wid), e = w.exercises[+d.ex], c = e.coach;
    e.sets.forEach(s => { if (!s.done && +s.w === c.w) s.w = c.from; });
    persist(w); render(); toast(`Keeping ${c.from} lb`);
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
  finish: d => {
    const w = getW(d.wid);
    w.finishedAt = Date.now();
    flushSaves(); persist(w); stopTimer(); render();
    toast(w.type === 'strength' ? 'Workout saved. Nice work.' : 'Session saved.');
  },
  'add-act': d => { const w = getW(d.wid); w.activities.push({ type: d.t, min: '', dist: '', notes: '' }); persist(w); render(); },
  'rm-act': d => { const w = getW(d.wid); w.activities.splice(+d.i, 1); persist(w); render(); },
  'open-w': d => { S.view = { name: 'workout', id: d.id, back: S.view }; render(); scrollTo(0, 0); },
  'del-w': d => {
    if (!confirm('Delete this workout? This can\'t be undone.')) return;
    S.workouts = S.workouts.filter(w => w.id !== d.id);
    DB.del('workouts', d.id);
    S.view = S.view && S.view.back;
    render(); toast('Workout deleted');
  },

  'tm-add': d => { T.end += +d.d * 1000; T.total = Math.max(T.total + +d.d, 1); if (T.doneAt) { T.doneAt = 0; $('#timer').classList.remove('done'); } drawTimer(); },
  'tm-stop': () => stopTimer(),
  'test-timer': () => startTimer(5),

  'sheet-close': () => closeSheet(),
  'ss-step': d => {
    const v = (num(S.sheet[d.f]) || 0) + +d.d;
    S.sheet[d.f] = String(Math.max(0, round2(v)));
    renderSheet();
  },
  'ss-bw': () => { S.sheet.w = '0'; renderSheet(); },
  'ss-save': () => {
    const { w, e, s } = findSheetSet();
    const nw = num(S.sheet.w), nr = num(S.sheet.r);
    if (nw == null) { toast('Enter a weight (0 for bodyweight)'); return; }
    if (nr == null) { toast('Enter how many you did'); return; }
    const old = s.w;
    s.w = nw; s.r = nr;
    if (old !== nw) e.sets.forEach((x, k) => { if (k > S.sheet.j && !x.done && (x.w === old || x.w === '')) x.w = nw; });
    const wasDone = s.done, i = S.sheet.i, j = S.sheet.j;
    closeSheet();
    if (wasDone) { persist(w); render(); } else logSet(w, i, j);
  },

  'sf-step': d => { S.sheet.data[d.f] = Math.max(1, Math.min(10, (+S.sheet.data[d.f] || 0) + +d.d)); renderSheet(); },
  'sf-set': d => { S.sheet.data[d.f] = d.f === 'inc' ? +d.v : d.v; renderSheet(); },
  'sf-save': () => {
    const x = S.sheet.data;
    if (!String(x.name).trim()) { toast('Give it a name'); return; }
    let min = num(x.min), max = num(x.max);
    if (min != null && max != null && min > max) [min, max] = [max, min];
    const day = progDay();
    day.groups = day.groups || [];
    const prev = S.sheet.g == null ? null : day.groups[S.sheet.g][S.sheet.e];
    const item = { id: prev ? prev.id : uid('e'), name: String(x.name).trim(), sets: +x.sets, min, max, inc: +x.inc, unit: x.unit, note: String(x.note).trim() };
    if (prev) day.groups[S.sheet.g][S.sheet.e] = item; else day.groups.push([item]);
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
  'p-add': d => addFood('', +d.n),
  'food-form': () => {
    const name = $('#food-name').value.trim(), g = num($('#food-g').value);
    if (!g || g <= 0) { toast('Enter the grams of protein'); $('#food-g').focus(); return; }
    addFood(name, Math.round(g));
    toast(name ? `Added ${name}` : `Added ${Math.round(g)} g`);
  },
  'food-quick': d => { const f = findFood(d.n); if (f) { addFood(f.name, f.g); toast(`Added ${f.name}`); } },
  'food-fav': d => { const f = findFood(d.n); if (f) { f.fav = !f.fav; saveFoods(); render(); } },
  'item-rm': d => {
    const b = bodyEntry(S.bodyDate);
    b.items.splice(+d.i, 1);
    saveBody(b); render();
  },

  'set-rest': d => { S.settings.restSec = Math.max(15, Math.min(600, S.settings.restSec + +d.d)); saveSettings(); render(); },
  'prot-mode': d => { S.settings.proteinMode = d.v; saveSettings(); render(); },
  'set-perlb': d => { S.settings.proteinPerLb = Math.max(0.5, Math.min(1.5, round2(S.settings.proteinPerLb + +d.d))); saveSettings(); render(); },
  'rem-on': () => reminderOn(),
  'rem-off': () => reminderOff(),
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
document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset.wb && el.dataset.wb !== 'date') {
    const w = getW(el.dataset.wid);
    if (w) { setPath(w, el.dataset.wb, el.value); saveSoon(w); }
  } else if (el.dataset.ssf) {
    S.sheet[el.dataset.ssf] = el.value;
  } else if (el.dataset.sf) {
    S.sheet.data[el.dataset.sf] = el.value;
  } else if (el.dataset.pl) {
    S.program.days[el.dataset.pl].label = el.value;
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
    render();
  } else if (el.id === 'rem-time' && el.value) {
    const r = S.settings.reminder;
    r.time = el.value;
    saveSettings();
    if (r.on) reminderSync().then(() => toast(`Reminder moved to ${fmtTime(r.time)}`)).catch(err => toast(`Couldn't update: ${err.message}`));
    else render();
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSaves();
  else {
    if (T.iv) drawTimer();
    if (S.bodyDate > todayStr()) S.bodyDate = todayStr();
    if (!S.sheet) render();
  }
});

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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data && ev.data.open) { S.tab = ev.data.open; S.view = null; S.bodyDate = todayStr(); closeSheet(); render(); scrollTo(0, 0); }
    });
  }
  if (S.settings.reminder.on && navigator.onLine) reminderSync().catch(() => {});
  if (navigator.storage && navigator.storage.persist) {
    try { S.persisted = await navigator.storage.persisted() || await navigator.storage.persist(); } catch (e) { /* ignore */ }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
