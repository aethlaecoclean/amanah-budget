// Shared helpers: DOM, money (stored as integer cents), dates (ISO yyyy-mm-dd), Hijri.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// crypto.randomUUID only exists in secure contexts (https/localhost), so fall back on plain http.
export const uid = () =>
  (self.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
export const money = (c) => AUD.format((c || 0) / 100);
export const moneyShort = (c) => {
  const v = (c || 0) / 100;
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'm';
  if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  return '$' + Math.round(v);
};

export function toCents(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  let s = String(v ?? '').replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = parseFloat(s);
  if (isNaN(n)) return 0;
  return Math.round((neg ? -n : n) * 100);
}
export const centsInput = (c) => (c ? (c / 100).toFixed(2) : '');

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ---------- Dates ----------
export const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const today = () => iso(new Date());
export const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
export const addMonths = (s, n) => {
  const d = parseISO(s); const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return iso(d);
};
export const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
export const fmtDate = (s, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  s ? parseISO(s).toLocaleDateString('en-AU', opts) : '';

// ---------- Hijri (offline) ----------
// Prefer the browser's built-in Umm al-Qura calendar; fall back to the tabular (Kuwaiti) algorithm.
const HIJRI_MONTHS = ['Muharram', 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani", 'Jumada al-Ula', 'Jumada al-Akhirah',
  'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qa'dah", 'Dhu al-Hijjah'];
let hijriFmt = null;
try {
  const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' });
  if (f.resolvedOptions().calendar.startsWith('islamic')) hijriFmt = f;
} catch (e) { /* not supported */ }

function tabularHijri(d) {
  const jd = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) + 2440588;
  let l = jd - 1948440 + 10632;
  const n = Math.floor((l - 1) / 10631);
  l = l - 10631 * n + 354;
  const j = Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) + Math.floor(l / 5670) * Math.floor((43 * l) / 15238);
  l = l - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29;
  const m = Math.floor((24 * l) / 709);
  const day = l - Math.floor((709 * m) / 24);
  const y = 30 * n + j - 30;
  return { y, m, d: day };
}

export function hijri(s) {
  if (!s) return '';
  const d = parseISO(s);
  if (hijriFmt) return hijriFmt.format(d).replace(/\s*AH$/i, '') + ' AH';
  const h = tabularHijri(d);
  return `${h.d} ${HIJRI_MONTHS[h.m - 1]} ${h.y} AH`;
}

// ---------- Misc ----------
export function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const clone = (o) => JSON.parse(JSON.stringify(o));
