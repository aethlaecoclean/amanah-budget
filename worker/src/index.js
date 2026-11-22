// Amanah Budget — sync & push server for Cloudflare Workers (free plan).
//
// Privacy: budget records arrive already encrypted (AES-256-GCM) by the app with a key derived
// from your sync code. This server only ever stores opaque blobs and cannot read your finances.
// Reminder notifications are the one exception: their short title/body text is stored so the
// server can send them on time (you can switch names/amounts off in the app).

const enc = new TextEncoder();

export const b64u = (buf) => {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (str) => {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str); const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
};
const concat = (...arrs) => {
  const o = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0)); let off = 0;
  for (const a of arrs) { o.set(a, off); off += a.length; }
  return o;
};
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function sha256hex(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400'
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// The app sends a token derived from the sync code; the vault is named by its hash.
async function vaultFor(req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{40,64})$/);
  return m ? sha256hex('amanah-vault:' + m[1]) : null;
}
const hub = (env) => env.PUSH.get(env.PUSH.idFromName('global'));

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (env.ALLOWED_ORIGIN) {
      const o = req.headers.get('Origin');
      if (o && o !== env.ALLOWED_ORIGIN) return json({ error: 'origin not allowed' }, 403);
    }
    try {
      if (path === '/') return json({ ok: true, service: 'amanah-sync', version: 1 });
      if (path === '/v1/push/key') return await hub(env).fetch('https://hub/key');
      const vault = await vaultFor(req);
      if (!vault) return json({ error: 'unauthorized' }, 401);
      if ((path === '/v1/sync/push' && req.method === 'POST') || (path === '/v1/sync/pull' && req.method === 'GET')) {
        const stub = env.VAULT.get(env.VAULT.idFromName(vault));
        return await stub.fetch(new Request('https://vault/' + path.split('/').pop() + url.search, {
          method: req.method, body: req.method === 'POST' ? await req.text() : undefined, headers: { 'Content-Type': 'application/json' }
        }));
      }
      if (path.startsWith('/v1/push/') && req.method === 'POST') {
        return await hub(env).fetch(new Request('https://hub/' + path.slice(9), {
          method: 'POST', body: await req.text(), headers: { 'Content-Type': 'application/json', 'X-Vault': vault }
        }));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hub(env).fetch('https://hub/cron', { method: 'POST' }));
  }
};

// ---------------------------------------------------------------- Vault: one per sync code
export class Vault {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS rec (k TEXT PRIMARY KEY, seq INTEGER NOT NULL, blob TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS rec_seq ON rec(seq)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)');
  }
  head() {
    const r = this.sql.exec("SELECT v FROM meta WHERE k = 'seq'").toArray();
    return r.length ? r[0].v : 0;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/push') {
      const { changes } = await req.json();
      if (!Array.isArray(changes) || changes.length > 500) return json({ error: 'bad batch' }, 400);
      for (const c of changes) {
        if (typeof c.k !== 'string' || c.k.length > 64 || typeof c.b !== 'string' || c.b.length > 262144) return json({ error: 'bad change' }, 400);
      }
      let seq = this.head();
      for (const c of changes) {
        seq++;
        this.sql.exec('INSERT INTO rec (k, seq, blob) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET seq = excluded.seq, blob = excluded.blob', c.k, seq, c.b);
      }
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", seq);
      return json({ seq });
    }
    if (url.pathname === '/pull') {
      const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
      const rows = this.sql.exec('SELECT k, seq, blob FROM rec WHERE seq > ? ORDER BY seq LIMIT 501', since).toArray();
      const more = rows.length > 500; const out = rows.slice(0, 500);
      const head = this.head();
      return json({ changes: out.map((r) => ({ k: r.k, b: r.blob })), seq: out.length ? out[out.length - 1].seq : Math.min(since, head), head, more });
    }
    return json({ error: 'not found' }, 404);
  }
}

// ---------------------------------------------------------------- Web Push (RFC 8291 + VAPID RFC 8292)
export async function encryptPayload(plaintext, uaPublic, authSecret, opts = {}) {
  const kp = opts.asKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, kp.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPub, new Uint8Array([1])));
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub, ct);
}

async function vapidJWT(aud, vapid) {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:amanah-budget@users.noreply.github.com' })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims));
  return `${header}.${claims}.${b64u(sig)}`;
}

export async function sendPush(sub, message, vapid, fetchImpl = fetch) {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), unb64u(sub.p256dh), unb64u(sub.auth));
  const jwt = await vapidJWT(new URL(sub.endpoint).origin, vapid);
  return fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: `vapid t=${jwt}, k=${vapid.pub}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body
  });
}

// ---------------------------------------------------------------- PushHub: subscriptions + reminder queue
export class PushHub {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, vault TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rem (vault TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, title TEXT, body TEXT, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vault, id))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS rem_at ON rem(sent, at)');
    this.fetchImpl = (...a) => fetch(...a);
  }
  async vapid() {
    const r = this.sql.exec("SELECT v FROM kv WHERE k = 'vapid'").toArray();
    if (r.length) return JSON.parse(r[0].v);
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const v = { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('vapid', ?)", JSON.stringify(v));
    return v;
  }
  async sendToVault(vault, message) {
    const subs = this.sql.exec('SELECT endpoint, p256dh, auth FROM subs WHERE vault = ?', vault).toArray();
    const vapid = await this.vapid(); let sent = 0, failed = 0;
    for (const s of subs) {
      try {
        const res = await sendPush(s, message, vapid, this.fetchImpl);
        if (res.status === 404 || res.status === 410) { this.sql.exec('DELETE FROM subs WHERE endpoint = ?', s.endpoint); failed++; }
        else if (res.ok) sent++; else failed++;
      } catch (e) { failed++; }
    }
    return { sent, failed, devices: subs.length };
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const vault = req.headers.get('X-Vault');
    if (path === '/key') return json({ key: (await this.vapid()).pub });
    if (path === '/cron') {
      const now = Date.now();
      const due = this.sql.exec('SELECT vault, id, title, body FROM rem WHERE sent = 0 AND at <= ? AND at > ? ORDER BY at LIMIT 200', now, now - 48 * 3600e3).toArray();
      for (const r of due) {
        this.sql.exec('UPDATE rem SET sent = 1 WHERE vault = ? AND id = ?', r.vault, r.id);
        await this.sendToVault(r.vault, { title: r.title, body: r.body, tag: r.id, url: './' });
      }
      this.sql.exec('DELETE FROM rem WHERE at < ?', now - 30 * 86400e3);
      return json({ sent: due.length });
    }
    if (!vault) return json({ error: 'unauthorized' }, 401);
    const body = await req.json().catch(() => ({}));
    if (path === '/subscribe') {
      const s = body.subscription || {};
      if (!/^https:\/\//.test(s.endpoint || '') || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: 'bad subscription' }, 400);
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM subs WHERE vault = ?', vault).one().n;
      if (n >= 20) return json({ error: 'too many devices' }, 400);
      this.sql.exec('INSERT INTO subs (endpoint, vault, p256dh, auth, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET vault = excluded.vault, p256dh = excluded.p256dh, auth = excluded.auth',
        s.endpoint, vault, s.keys.p256dh, s.keys.auth, Date.now());
      return json({ ok: true });
    }
    if (path === '/unsubscribe') {
      this.sql.exec('DELETE FROM subs WHERE endpoint = ? AND vault = ?', String(body.endpoint || ''), vault);
      return json({ ok: true });
    }
    if (path === '/reminders') {
      const list = Array.isArray(body.reminders) ? body.reminders.slice(0, 500) : [];
      const now = Date.now();
      this.sql.exec('DELETE FROM rem WHERE vault = ? AND sent = 0', vault);
      let n = 0;
      for (const r of list) {
        if (typeof r.id !== 'string' || !Number.isFinite(r.at) || r.at < now - 3600e3 || r.at > now + 400 * 86400e3) continue;
        this.sql.exec('INSERT INTO rem (vault, id, at, title, body, sent) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(vault, id) DO NOTHING',
          vault, r.id.slice(0, 80), Math.round(r.at), String(r.title || 'Amanah Budget').slice(0, 120), String(r.body || '').slice(0, 240));
        n++;
      }
      return json({ ok: true, stored: n });
    }
    if (path === '/test') return json(await this.sendToVault(vault, { title: 'Amanah Budget', body: 'Notifications are working ✓', tag: 'test', url: './' }));
    return json({ error: 'not found' }, 404);
  }
}
