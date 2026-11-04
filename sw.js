// Offline support: serve the saved copy right away, refresh it in the background when online.
// Bump CACHE when you change the app so old files are cleared.
const CACHE = 'liftlog-v25';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // Skip the browser's own cache so a new version never stores old files.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin || req.cache === 'no-store') return;
  const fresh = fetch(req, { cache: 'no-cache' }).then(async res => {
    if (res.ok) {
      const c = await caches.open(CACHE);
      await c.put(req, res.clone());
    }
    return res;
  }).catch(() => null);
  e.waitUntil(fresh);
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await caches.match('./index.html') : null);
    return hit || (await fresh) || new Response('Offline', { status: 503 });
  })());
});

// Reminders from the push server. Pushes carry no data, so this works out which reminder it is
// (whichever chosen time is closest to now) and reads the streak the app saved to word it.
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = t => { const [h, m] = String(t || '00:00').split(':').map(Number); return h * 60 + m; };

// Whether today's body entry has a weight.
function readBody(date) {
  return new Promise(res => {
    const r = indexedDB.open('liftlog');
    r.onupgradeneeded = () => r.transaction.abort();
    r.onerror = () => res(false);
    r.onsuccess = () => {
      try {
        const q = r.result.transaction('body', 'readonly').objectStore('body').get(date);
        q.onsuccess = () => res(!!(q.result && q.result.weight != null));
        q.onerror = () => res(false);
      } catch (e) { res(false); }
    };
  });
}

function readKv(keys) {
  return new Promise(res => {
    const out = {};
    const r = indexedDB.open('liftlog');
    r.onupgradeneeded = () => r.transaction.abort();
    r.onerror = () => res(out);
    r.onsuccess = () => {
      try {
        const db = r.result, t = db.transaction('kv', 'readonly'), st = t.objectStore('kv');
        keys.forEach(k => { const q = st.get(k); q.onsuccess = () => { if (q.result) out[k] = q.result.v; }; });
        t.oncomplete = () => { db.close(); res(out); };
        t.onerror = () => res(out);
      } catch (err) { res(out); }
    };
  });
}

// What this phone has already shown (weigh-in and streak by day, check-in by month), kept in its own
// small database so it never touches the app's data.
function swMeta(val) {
  return new Promise(res => {
    const r = indexedDB.open('liftlog-sw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('meta');
    r.onerror = () => res({});
    r.onsuccess = () => {
      try {
        const db = r.result, t = db.transaction('meta', val ? 'readwrite' : 'readonly'), st = t.objectStore('meta');
        let out = val || {};
        if (val) st.put(val, 'shown');
        else { const q = st.get('shown'); q.onsuccess = () => { out = q.result || {}; }; }
        t.oncomplete = () => { db.close(); res(out); };
        t.onerror = () => res(out);
      } catch (err) { res({}); }
    };
  });
}

async function reminderText() {
  const kv = await readKv(['settings', 'streak', 'program']);
  const today0 = ymd(new Date()), weighed = await readBody(today0);
  const r = (kv.settings && kv.settings.reminder) || {};
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const today = ymd(now), yesterday = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const month = today.slice(0, 7), first = now.getDate() === 1;
  // Pushes carry no data, so work out which one it is the way the server picks: the first reminder
  // whose hour has started and that hasn't gone out yet today (or this month, for check-in day).
  const shown = await swMeta();
  const due = t => { const m = toMin(t); return mins >= m && mins < m + 60; };
  let kind = r.on && due(r.time || '09:00') && !weighed && shown.weigh !== today ? 'weigh'
    : r.streakOn && due(r.streakTime || '14:00') && shown.streak !== today ? 'streak'
    : r.measureOn && first && due(r.measureTime || '10:00') && shown.measure !== month ? 'measure' : null;
  if (!kind) {
    // Clock drift: fall back to whichever enabled reminder's time is closest.
    const opts = [r.on && !weighed && ['weigh', r.time], r.streakOn && ['streak', r.streakTime], r.measureOn && first && ['measure', r.measureTime]].filter(Boolean);
    kind = (opts.sort((a, b) => Math.abs(mins - toMin(a[1])) - Math.abs(mins - toMin(b[1])))[0] || ['streak'])[0];
  }
  await swMeta({ ...shown, [kind === 'measure' ? 'measure' : kind]: kind === 'measure' ? month : today });
  if (kind === 'weigh') return { title: 'Time to weigh in', body: 'Step on the scale and log it in Lift Log.', url: './#body' };
  if (kind === 'measure') {
    // Photos every 3 months: January, April, July, and October.
    return now.getMonth() % 3 === 0
      ? { title: 'Check-in day 📏📸', body: 'Take your measurements and new progress photos. Same spot and light as last time.', url: './#body' }
      : { title: 'Check-in day 📏', body: 'Time for your monthly measurements: waist, chest, arms, and thighs.', url: './#body' };
  }
  const st = kv.streak || {};
  if (st.date === today && st.done) return { title: 'Today already counts 🔥', body: 'Nice work. See you tomorrow.', url: './' };
  // The streak at stake: what the app saw today, or yesterday's if that day counted.
  const n = st.date === today ? st.n : (st.date === yesterday && st.done ? st.n : 0);
  // Training days count when you move; rest days also count with a weigh-in or protein.
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
  const days = kv.program && kv.program.days;
  const todo = days && days[day] && days[day].type === 'rest' ? 'Move, weigh in, or hit your protein' : 'Lift, run, walk, or do yoga';
  return n > 0
    ? { title: `Keep your ${n}-day streak 🔥`, body: `Today doesn't count yet. ${todo} before midnight.`, url: './' }
    : { title: 'Start a streak today 🔥', body: `${todo} and today counts.`, url: './' };
}

self.addEventListener('push', e => {
  e.waitUntil(reminderText().then(m => self.registration.showNotification(m.title, {
    body: m.body,
    icon: 'icons/icon-192.png',
    tag: 'reminder',
    data: { url: m.url },
  })));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  const tab = url.includes('#body') ? 'body' : 'today';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => 'focus' in c);
    if (open) { open.postMessage({ open: tab }); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
