// End-to-end encrypted sync + push notifications.
// Each record is encrypted on this device (AES-256-GCM) with a key derived from the sync code.
// The server only sees random-looking keys and blobs. The sync code never leaves the device.
import * as DB from './db.js';

const te = new TextEncoder(), td = new TextDecoder();
const LS = {
  get: (k) => { try { return JSON.parse(localStorage.getItem('amanah-sync-' + k)); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem('amanah-sync-' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
};
const b64u = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (str) => { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };

let cfg = LS.get('cfg');            // { url, code, seq, last, deviceId }
let outbox = LS.get('outbox') || {}; // "store|id" -> change counter
let keys = null, timer = null, running = null, hooks = {};

export const isOn = () => !!(cfg && cfg.url && cfg.code);
export const config = () => cfg;
export const pending = () => Object.keys(outbox).length;
export const notifyOn = () => !!LS.get('notify');
export const lastUrl = () => LS.get('lastUrl') || '';
const saveCfg = () => LS.set('cfg', cfg);
const saveOutbox = () => LS.set('outbox', outbox);

export function init(h) {
  hooks = h;
  DB.setOnChange((store, ids) => {
    if (!isOn()) return;
    for (const id of ids) { const e = `${store}|${id}`; outbox[e] = (outbox[e] || 0) + 1; }
    saveOutbox(); schedule();
  });
}
function schedule(ms = 2500) { clearTimeout(timer); timer = setTimeout(() => syncNow().catch(() => {}), ms); }

// ---------- keys ----------
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const fmtCode = (c) => normCode(c).match(/.{1,5}/g)?.join('-') || '';
export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(25)); let s = '';
  for (const x of r) s += ALPHA[x & 31];
  return fmtCode(s); // 25 chars × 5 bits = 125 bits
}
async function deriveKeys(code) {
  const base = await crypto.subtle.importKey('raw', te.encode('amanah-sync-v1:' + normCode(code)), 'HKDF', false, ['deriveBits']);
  const bits = async (info) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) }, base, 256));
  return {
    enc: await crypto.subtle.importKey('raw', await bits('enc'), 'AES-GCM', false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.importKey('raw', await bits('mac'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    token: b64u(await bits('auth'))
  };
}
async function ensureKeys() { if (!keys) keys = await deriveKeys(cfg.code); return keys; }
async function recKey(e) { return b64u(await crypto.subtle.sign('HMAC', keys.mac, te.encode(e))).slice(0, 32); }
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.enc, te.encode(JSON.stringify(obj)));
  return b64u(iv) + '.' + b64u(ct);
}
async function open(blob, k = keys) {
  const [iv, ct] = blob.split('.');
  return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, k.enc, unb64u(ct))));
}

async function api(method, path, body, url = cfg.url, token = keys.token) {
  const res = await fetch(url + path, {
    method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

// ---------- push & pull ----------
async function pushOutbox() {
  const entries = Object.entries(outbox); let n = 0;
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200); const changes = [];
    for (const [e] of batch) {
      const cut = e.indexOf('|'); const store = e.slice(0, cut); const id = e.slice(cut + 1);
      const val = DB.STORES.includes(store) ? await DB.get(store, id) : undefined;
      changes.push({ k: await recKey(e), b: await seal(val === undefined ? { s: store, id, del: 1, dev: cfg.deviceId } : { s: store, id, v: val, dev: cfg.deviceId }) });
    }
    await api('POST', '/v1/sync/push', { changes });
    for (const [e, ver] of batch) if (outbox[e] === ver) delete outbox[e]; // keep if edited again meanwhile
    saveOutbox(); n += batch.length;
  }
  return n;
}

async function pull({ includeOwn = false } = {}) {
  let applied = 0, more = true;
  while (more) {
    const r = await api('GET', `/v1/sync/pull?since=${cfg.seq || 0}`);
    const byStore = {};
    for (const c of r.changes) {
      let p; try { p = await open(c.b); } catch (e) { continue; }
      if (!includeOwn && p.dev === cfg.deviceId) continue; // already have it
      if (outbox[`${p.s}|${p.id}`]) continue;               // local unsynced edit wins
      (byStore[p.s] ||= []).push(p);
    }
    for (const [s, list] of Object.entries(byStore)) {
      if (!DB.STORES.includes(s)) continue;
      const puts = list.filter((x) => !x.del).map((x) => x.v);
      const dels = list.filter((x) => x.del).map((x) => x.id);
      if (puts.length) await DB.bulkPut(s, puts, { silent: true });
      if (dels.length) await DB.bulkDel(s, dels, { silent: true });
      applied += list.length;
    }
    cfg.seq = r.seq; saveCfg(); more = r.more;
  }
  return applied;
}

export function syncNow() {
  if (!isOn()) return Promise.resolve(null);
  if (running) return running;
  running = (async () => {
    hooks.status?.('syncing');
    try {
      await ensureKeys();
      const pushed = await pushOutbox();
      const pulled = await pull();
      cfg.last = Date.now(); saveCfg();
      hooks.status?.('ok');
      if (pulled) await hooks.reload?.();
      await hooks.afterSync?.({ pushed, pulled });
      return { pushed, pulled };
    } catch (e) {
      hooks.status?.(navigator.onLine === false ? 'offline' : 'error', e.message);
      throw e;
    } finally { running = null; }
  })();
  return running;
}

// ---------- setup ----------
function cleanUrl(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error('The server address must start with https://');
  return url;
}
async function ping(url) {
  const r = await fetch(url + '/').then((x) => x.json()).catch(() => null);
  if (!r || r.service !== 'amanah-sync') throw new Error("Couldn't reach your sync server. Check the address and that it's deployed.");
}

export async function create(url, code) {
  url = cleanUrl(url); await ping(url);
  const k = await deriveKeys(code);
  cfg = { url, code: fmtCode(code), seq: 0, last: 0, deviceId: b64u(crypto.getRandomValues(new Uint8Array(9))) };
  keys = k; saveCfg(); LS.set('lastUrl', url);
  const all = await DB.dumpAll(); outbox = {};
  for (const s of DB.STORES) for (const v of all[s]) outbox[`${s}|${DB.keyOf(s, v)}`] = 1;
  saveOutbox();
  return syncNow();
}

export async function join(url, code) {
  url = cleanUrl(url); await ping(url);
  if (normCode(code).length !== 25) throw new Error('A sync code has 25 letters and numbers.');
  const k = await deriveKeys(code);
  const probe = await api('GET', '/v1/sync/pull?since=0', null, url, k.token);
  if (!probe.changes.length) throw new Error('No budget found for this sync code. Check the code, or start syncing on your main device first.');
  try { await open(probe.changes[0].b, k); } catch (e) { throw new Error('That sync code doesn\'t match the data on the server.'); }
  cfg = { url, code: fmtCode(code), seq: 0, last: 0, deviceId: b64u(crypto.getRandomValues(new Uint8Array(9))) };
  keys = k; saveCfg(); LS.set('lastUrl', url);
  outbox = {}; saveOutbox();
  await DB.replaceAll({});
  await pull({ includeOwn: true });
  cfg.last = Date.now(); saveCfg();
  await hooks.reload?.();
  return true;
}

export function disconnect() {
  cfg = null; keys = null; outbox = {}; saveCfg(); saveOutbox(); clearTimeout(timer);
}

// After a restore/erase: queue every key that existed before or exists now, so all devices match.
export async function markAll(oldKeys = []) {
  if (!isOn()) return;
  const all = await DB.dumpAll();
  for (const e of oldKeys) outbox[e] = (outbox[e] || 0) + 1;
  for (const s of DB.STORES) for (const v of all[s]) { const e = `${s}|${DB.keyOf(s, v)}`; outbox[e] = (outbox[e] || 0) + 1; }
  saveOutbox(); schedule(500);
}
export async function currentKeys() {
  const all = await DB.dumpAll(); const out = [];
  for (const s of DB.STORES) for (const v of all[s]) out.push(`${s}|${DB.keyOf(s, v)}`);
  return out;
}

// ---------- notifications ----------
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function enableNotifications() {
  if (!pushSupported()) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    throw new Error(ios ? 'On iPhone, add the app to your Home Screen first (iOS 16.4 or later), then open it from the icon and try again.' : 'This browser does not support notifications.');
  }
  const perm = await Notification.requestPermission(); // must run first, inside the tap
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for Amanah in your phone\'s Settings → Notifications.');
  await ensureKeys();
  const reg = await navigator.serviceWorker.ready;
  const { key } = await fetch(cfg.url + '/v1/push/key').then((r) => r.json());
  let sub = await reg.pushManager.getSubscription();
  if (sub && b64u(sub.options.applicationServerKey || new ArrayBuffer(0)) !== key) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) });
  await api('POST', '/v1/push/subscribe', { subscription: sub.toJSON() });
  LS.set('notify', true);
}

export async function disableNotifications() {
  LS.set('notify', false);
  try {
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) { await ensureKeys(); await api('POST', '/v1/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  } catch (e) { /* ignore */ }
}

export async function testNotification() { await ensureKeys(); return api('POST', '/v1/push/test', {}); }

export async function uploadReminders(list) {
  const sig = JSON.stringify(list);
  if (LS.get('remsig') === sig && LS.get('remday') === new Date().toDateString()) return false;
  await ensureKeys();
  await api('POST', '/v1/push/reminders', { reminders: list });
  LS.set('remsig', sig); LS.set('remday', new Date().toDateString());
  return true;
}
