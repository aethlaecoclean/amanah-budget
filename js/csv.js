// CSV parsing + Australian bank statement detection, merchant normalisation and rule keys.
import { pad } from './utils.js';

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ''));
}

// Returns signed cents or null. Handles $, commas, (brackets), trailing CR/DR, leading +.
export function parseAmount(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let sign = 1;
  if (/\bDR$/i.test(s)) { sign = -1; s = s.replace(/\s*DR$/i, ''); }
  else if (/\bCR$/i.test(s)) { s = s.replace(/\s*CR$/i, ''); }
  if (/^\(.*\)$/.test(s)) { sign *= -1; s = s.slice(1, -1); }
  s = s.replace(/[$,\s+]/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n * 100) * sign;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const yr = (y) => { y = +y; return y < 100 ? 2000 + y : y; };
function mk(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900)) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// fmt: 'DMY' (Australian default) | 'MDY' | 'YMD'. Month-name and ISO dates are always detected.
export function parseDate(raw, fmt = 'DMY') {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return mk(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[\s\-/]([A-Za-z]{3,})[\s\-/,]*(\d{2,4})/))) {
    const mo = MON[m[2].slice(0, 3).toLowerCase()]; return mo ? mk(yr(m[3]), mo, +m[1]) : null;
  }
  if ((m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})/))) {
    const mo = MON[m[1].slice(0, 3).toLowerCase()]; return mo ? mk(yr(m[3]), mo, +m[2]) : null;
  }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
    const a = +m[1], b = +m[2], y = yr(m[3]);
    if (fmt === 'YMD') return null;
    return fmt === 'MDY' ? mk(y, a, b) : mk(y, b, a);
  }
  return null;
}

export const BANK_PRESETS = {
  CommBank: { hasHeader: false, date: 0, amount: 1, desc: 2, mode: 'single', dateFormat: 'DMY' },
  ANZ: { hasHeader: false, date: 0, amount: 1, desc: 2, mode: 'single', dateFormat: 'DMY' },
  NAB: { hasHeader: true, date: 0, amount: 1, desc: 5, mode: 'single', dateFormat: 'DMY' },
  Westpac: { hasHeader: true, date: 1, desc: 2, debit: 3, credit: 4, mode: 'split', dateFormat: 'DMY' }
};

const isNum = (v) => parseAmount(v) !== null;
const isDate = (v) => !!parseDate(v);

export function detectMapping(rows) {
  const first = rows[0] || [];
  const hasHeader = !first.some(isDate) && first.some((v) => /[a-z]/i.test(v));
  const ncol = Math.max(0, ...rows.map((r) => r.length));
  const m = { hasHeader, date: -1, desc: -1, amount: -1, debit: -1, credit: -1, mode: 'single', dateFormat: 'DMY', flip: false, bank: 'Custom' };

  if (hasHeader) {
    const h = first.map((x) => x.toLowerCase().trim());
    const findAny = (patterns) => { for (const p of patterns) { const i = h.findIndex((x) => p.test(x)); if (i >= 0) return i; } return -1; };
    m.date = findAny([/^date$/, /^transaction date$/, /date/]);
    m.debit = h.findIndex((x) => /debit/.test(x));
    m.credit = h.findIndex((x) => /credit/.test(x));
    m.amount = findAny([/^amount$/, /^amount\b/, /amount/].map((r) => ({ test: (x) => r.test(x) && !/debit|credit/.test(x) })));
    m.desc = findAny([/transaction details/, /narrative/, /description/, /details/, /merchant/, /payee/, /memo/, /reference/]);
    if (m.amount < 0 && m.debit >= 0 && m.credit >= 0) m.mode = 'split';
    if (h.some((x) => /narrative/.test(x)) && m.mode === 'split') m.bank = 'Westpac';
    else if (h.some((x) => /transaction details/.test(x))) m.bank = 'NAB';
  }

  const sample = rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 30);
  const stat = (i) => {
    const vals = sample.map((r) => r[i] ?? '').filter((v) => v !== '');
    const n = vals.length || 1;
    return {
      date: vals.filter(isDate).length / n,
      num: vals.filter(isNum).length / n,
      text: vals.filter((v) => !isNum(v) && !isDate(v)).reduce((s, v) => s + v.length, 0) / n
    };
  };
  const stats = Array.from({ length: ncol }, (_, i) => stat(i));
  if (m.date < 0) m.date = stats.findIndex((s) => s.date >= 0.6);
  if (m.mode === 'single' && m.amount < 0) m.amount = stats.findIndex((s, i) => i !== m.date && s.num >= 0.6);
  if (m.desc < 0) {
    let best = -1, bestLen = 0;
    stats.forEach((s, i) => { if (i !== m.date && i !== m.amount && s.text > bestLen) { best = i; bestLen = s.text; } });
    m.desc = best;
  }
  if (!hasHeader && m.date === 0 && m.amount === 1 && m.desc === 2) m.bank = ncol >= 4 ? 'CommBank' : 'ANZ';

  // Date order: if any first number > 12 it's DMY; if any second number > 12 it's MDY.
  for (const r of sample) {
    const mm = String(r[m.date] ?? '').match(/^(\d{1,2})[-/.](\d{1,2})[-/.]/);
    if (!mm) continue;
    if (+mm[1] > 12) { m.dateFormat = 'DMY'; break; }
    if (+mm[2] > 12) { m.dateFormat = 'MDY'; break; }
  }
  return m;
}

export const cleanDesc = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Lower-case key with card/terminal noise removed — used for duplicate checks and merchant rules.
export function normKey(s) {
  return cleanDesc(s).toLowerCase()
    .replace(/value date:?\s*\S+/g, ' ')
    .replace(/\b(visa|eftpos|debit|credit|purchase|card|pos|authorisation|authorization|tap and pay|contactless|apple pay|google pay|osko|payment|xx\d+|aus|au|nsw|vic|qld|wa|sa|tas|act|nt|pty|ltd)\b/g, ' ')
    .replace(/[^a-z& ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ruleKeyFrom(s) {
  const words = normKey(s).split(' ').filter((w) => w.length > 1);
  return words.slice(0, 2).join(' ');
}
