// Offline support: serve the saved copy right away, refresh it in the background when online.
// Bump CACHE when you change the app so old files are cleared.
const CACHE = 'liftlog-v7';
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
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const fresh = fetch(req).then(async res => {
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

function readKv(keys) {
  return new Promise(res => {
    const out = {};
    const r = indexedDB.open('liftlog', 1);
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

async function reminderText() {
  const kv = await readKv(['settings', 'streak']);
  const r = (kv.settings && kv.settings.reminder) || {};
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const today = ymd(now), yesterday = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const streakPush = r.streakOn && (!r.on || Math.abs(mins - toMin(r.streakTime)) < Math.abs(mins - toMin(r.time)));
  if (!streakPush) return { title: 'Time to weigh in', body: 'Step on the scale and log it in Lift Log.', url: './#body' };
  const st = kv.streak || {};
  if (st.date === today && st.done) return { title: 'Today already counts 🔥', body: 'Nice work. See you tomorrow.', url: './' };
  // The streak at stake: what the app saw today, or yesterday's if that day counted.
  const n = st.date === today ? st.n : (st.date === yesterday && st.done ? st.n : 0);
  return n > 0
    ? { title: `Keep your ${n}-day streak 🔥`, body: "You haven't done anything yet today. Train, weigh in, or hit your protein before midnight.", url: './' }
    : { title: 'Start a streak today 🔥', body: 'Train, weigh in, or hit your protein and today counts.', url: './' };
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
