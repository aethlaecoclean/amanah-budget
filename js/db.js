// Minimal promise wrapper around native IndexedDB. All data stays on this device.
const DB_NAME = 'amanah-budget';
const DB_VERSION = 1;

export const STORES = [
  'settings', 'groups', 'categories', 'budgets', 'transactions',
  'accounts', 'rules', 'zakatPayments', 'goals', 'snapshots'
];
const KEY_PATHS = { settings: 'key', snapshots: 'date' };

let db = null;

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
export const put = (name, value) => wrap(store(name, 'readwrite').put(value));
export const del = (name, key) => wrap(store(name, 'readwrite').delete(key));

export function bulkPut(name, values) {
  const t = db.transaction(name, 'readwrite');
  const os = t.objectStore(name);
  values.forEach((v) => os.put(v));
  return done(t);
}

export function bulkDel(name, keys) {
  const t = db.transaction(name, 'readwrite');
  const os = t.objectStore(name);
  keys.forEach((k) => os.delete(k));
  return done(t);
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
