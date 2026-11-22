// Minimal promise wrapper around native IndexedDB. All data stays on this device.
const DB_NAME = 'amanah-budget';
const DB_VERSION = 2;

export const STORES = [
  'settings', 'groups', 'categories', 'budgets', 'transactions',
  'accounts', 'rules', 'zakatPayments', 'goals', 'snapshots', 'schedules', 'debts'
];
const KEY_PATHS = { settings: 'key', snapshots: 'date' };

let db = null;

// Change hook (used by sync). Writes with { silent: true } don't trigger it.
let onChange = null;
export const setOnChange = (fn) => { onChange = fn; };
export const keyOf = (name, value) => value[KEY_PATHS[name] || 'id'];
const notify = (name, keys, deleted, opts) => { if (onChange && !(opts && opts.silent)) onChange(name, keys, deleted); };

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) {
        if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: KEY_PATHS[s] || 'id' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const store = (name, mode) => db.transaction(name, mode).objectStore(name);
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export const getAll = (name) => wrap(store(name, 'readonly').getAll());
export const get = (name, key) => wrap(store(name, 'readonly').get(key));
export const put = (name, value, opts) => wrap(store(name, 'readwrite').put(value)).then((r) => { notify(name, [keyOf(name, value)], false, opts); return r; });
export const del = (name, key, opts) => wrap(store(name, 'readwrite').delete(key)).then((r) => { notify(name, [key], true, opts); return r; });

export async function bulkPut(name, values, opts) {
  const t = db.transaction(name, 'readwrite');
  const os = t.objectStore(name);
  values.forEach((v) => os.put(v));
  await done(t);
  notify(name, values.map((v) => keyOf(name, v)), false, opts);
}

export async function bulkDel(name, keys, opts) {
  const t = db.transaction(name, 'readwrite');
  const os = t.objectStore(name);
  keys.forEach((k) => os.delete(k));
  await done(t);
  notify(name, keys, true, opts);
}

export async function dumpAll() {
  const out = {};
  for (const s of STORES) out[s] = await getAll(s);
  return out;
}

// Replace every store's contents in one atomic transaction (used by Restore & Reset).
export function replaceAll(data) {
  const t = db.transaction(STORES, 'readwrite');
  for (const s of STORES) {
    const os = t.objectStore(s);
    os.clear();
    (data[s] || []).forEach((v) => os.put(v));
  }
  return done(t);
}
