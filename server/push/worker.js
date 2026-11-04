// Weigh-in reminder server for Lift Log. Deploy from this folder with: npx wrangler deploy
// It keeps only each phone's push address, reminder times, time zone, and the last day it weighed in
// or did anything (no workout data). Every 15 minutes it sends:
//   - the weigh-in reminder, unless they've already weighed in that day
//   - the streak saver, unless they've already done something that day
//   - on the 1st of the month, the check-in day reminder (measurements, plus photos every 3 months)
// The pushes carry no data; the app's sw.js works out which one it is and what to say.

const ALLOWED_ORIGINS = ['https://adewyn.github.io', 'http://localhost:8790'];
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_SUBS = 50;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('origin') || '';
    const cors = {
      'access-control-allow-origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'origin',
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname.replace(/^\/+/, '');
    if (req.method !== 'POST') return reply({ ok: true, service: 'liftlog-push' });

    let body;
    try { body = await req.json(); } catch { return reply({ error: 'bad request' }, 400); }
    const id = String(body.id || '');
    if (!/^r_[a-z0-9]{6,30}$/.test(id)) return reply({ error: 'bad id' }, 400);
    const subs = await loadSubs(env);

    if (path === 'subscribe') {
      let host;
      try { host = new URL(body.sub.endpoint).hostname; } catch { return reply({ error: 'bad subscription' }, 400); }
      if (!PUSH_HOSTS.some(r => r.test(host))) return reply({ error: 'unknown push service' }, 400);
      const hhmm = /^\d{2}:\d{2}$/;
      if (!hhmm.test(body.time || '') || (body.streakTime && !hhmm.test(body.streakTime)) || (body.measureTime && !hhmm.test(body.measureTime))) return reply({ error: 'bad time' }, 400);
      try { localNow(body.tz); } catch { return reply({ error: 'bad time zone' }, 400); }
      if (!subs[id] && Object.keys(subs).length >= MAX_SUBS) return reply({ error: 'server is full' }, 503);
      const old = subs[id] || {};
      subs[id] = {
        endpoint: body.sub.endpoint, tz: body.tz,
        time: body.time, weighOn: body.weighOn !== false,
        streakTime: body.streakTime || '14:00', streakOn: !!body.streakOn,
        measureTime: body.measureTime || '10:00', measureOn: !!body.measureOn,
        lastSent: old.lastSent || '', lastStreak: old.lastStreak || '', lastMeasure: old.lastMeasure || '', weighed: old.weighed || '', active: old.active || '',
      };
      await saveSubs(env, subs);
      return reply({ ok: true });
    }

    const sub = subs[id];
    if (!sub) return reply({ error: 'reminder not found, turn it off and on again' }, 404);

    if (path === 'unsubscribe') {
      delete subs[id];
      await saveSubs(env, subs);
      return reply({ ok: true });
    }
    if (path === 'weighed' || path === 'active') {
      const today = localNow(sub.tz).date;
      if (path === 'weighed') sub.weighed = today;
      sub.active = today;
      await saveSubs(env, subs);
      return reply({ ok: true });
    }
    if (path === 'test') {
      // Wait a few seconds so there's time to leave the app and see it arrive.
      ctx.waitUntil(new Promise(r => setTimeout(r, 5000)).then(() => sendPush(env, sub.endpoint)));
      return reply({ ok: true });
    }
    return reply({ error: 'not found' }, 404);
  },

  async scheduled(event, env) {
    const subs = await loadSubs(env);
    // Collect what changed, then apply it to a fresh copy, so a weigh-in that lands meanwhile isn't lost.
    const sent = {}, gone = [];
    for (const [id, s] of Object.entries(subs)) {
      const { date, minutes } = localNow(s.tz);
      // Due in the first hour after the chosen time.
      const due = t => { const [h, m] = t.split(':').map(Number); return minutes >= h * 60 + m && minutes < h * 60 + m + 60; };
      let field = null;
      if (s.weighOn !== false && due(s.time) && s.lastSent !== date && s.weighed !== date) field = 'lastSent';
      else if (s.streakOn && due(s.streakTime || '14:00') && s.lastStreak !== date && s.active !== date) field = 'lastStreak';
      else if (s.measureOn && date.endsWith('-01') && due(s.measureTime || '10:00') && s.lastMeasure !== date.slice(0, 7)) field = 'lastMeasure';
      if (!field) continue;
      try {
        const res = await sendPush(env, s.endpoint);
        if (res.gone) gone.push(id);
        else if (res.ok) sent[id] = { [field]: field === 'lastMeasure' ? date.slice(0, 7) : date };
      } catch { /* try again next run */ }
    }
    if (!gone.length && !Object.keys(sent).length) return;
    const fresh = await loadSubs(env);
    gone.forEach(id => { delete fresh[id]; });
    Object.entries(sent).forEach(([id, f]) => { if (fresh[id]) Object.assign(fresh[id], f); });
    await saveSubs(env, fresh);
  },
};

async function loadSubs(env) {
  return (await env.SUBS.get('subs', 'json')) || {};
}
function saveSubs(env, subs) {
  return env.SUBS.put('subs', JSON.stringify(subs));
}

function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}

const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A push with no data only needs a signed VAPID token, no encryption.
async function sendPush(env, endpoint) {
  const enc = obj => b64u(new TextEncoder().encode(JSON.stringify(obj)));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT };
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc(claims)}`;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '3600',
      Urgency: 'high',
      Authorization: `vapid t=${unsigned}.${b64u(new Uint8Array(sig))}, k=${env.VAPID_PUBLIC}`,
      'Content-Length': '0',
    },
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
