// Weigh-in reminder server for Lift Log. Deploy from this folder with: npx wrangler deploy
// It keeps only each phone's push address, reminder time, and time zone (no workout data),
// and every 15 minutes sends a reminder to anyone whose time has come and who hasn't weighed in yet.
// The pushes carry no data, so the notification text lives in the app's sw.js.

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
    if (req.method !== 'POST') return reply({ ok: true, service: 'liftlog-push' });

    const path = new URL(req.url).pathname.replace(/^\/+/, '');
    let body;
    try { body = await req.json(); } catch { return reply({ error: 'bad request' }, 400); }
    const id = String(body.id || '');
    if (!/^r_[a-z0-9]{6,30}$/.test(id)) return reply({ error: 'bad id' }, 400);
    const subs = await loadSubs(env);

    if (path === 'subscribe') {
      let host;
      try { host = new URL(body.sub.endpoint).hostname; } catch { return reply({ error: 'bad subscription' }, 400); }
      if (!PUSH_HOSTS.some(r => r.test(host))) return reply({ error: 'unknown push service' }, 400);
      if (!/^\d{2}:\d{2}$/.test(body.time || '')) return reply({ error: 'bad time' }, 400);
      try { localNow(body.tz); } catch { return reply({ error: 'bad time zone' }, 400); }
      if (!subs[id] && Object.keys(subs).length >= MAX_SUBS) return reply({ error: 'server is full' }, 503);
      const old = subs[id] || {};
      subs[id] = { endpoint: body.sub.endpoint, time: body.time, tz: body.tz, lastSent: old.lastSent || '', weighed: old.weighed || '' };
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
    if (path === 'weighed') {
      sub.weighed = localNow(sub.tz).date;
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
    let changed = false;
    for (const [id, s] of Object.entries(subs)) {
      const { date, minutes } = localNow(s.tz);
      const [h, m] = s.time.split(':').map(Number);
      const due = h * 60 + m;
      // Send in the first hour after the chosen time, once a day, unless they've already weighed in.
      if (minutes < due || minutes >= due + 60 || s.lastSent === date || s.weighed === date) continue;
      const res = await sendPush(env, s.endpoint);
      if (res.gone) delete subs[id];
      else if (res.ok) s.lastSent = date;
      changed = true;
    }
    if (changed) await saveSubs(env, subs);
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
