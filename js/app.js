// Amanah Budget — zero-based budgeting + Zakat tracking. All data in IndexedDB on this device.
import * as DB from './db.js';
import {
  $, $$, uid, money, toCents, centsInput, esc, iso, parseISO, today, addDays, addMonths,
  daysBetween, fmtDate, hijri, debounce, download, clone
} from './utils.js';
import * as CSV from './csv.js';
import * as Charts from './charts.js';

const APP_VERSION = '1.1.0';
const HAWL_DAYS = 354;
const GOLD_GRAMS = 85;
const SILVER_GRAMS = 595;
const PERIODS_PER_YEAR = { monthly: 12, fortnightly: 26, weekly: 52 };

// ====================================================================
// State
// ====================================================================
const S = {
  settings: {}, groups: [], categories: [], budgets: new Map(), transactions: [],
  accounts: [], rules: [], zakatPayments: [], goals: [], snapshots: [], schedules: [], debts: [],
  tab: 'budget', anchor: today(),
  filters: { q: '', cat: '', type: '', from: '', to: '' }
};
let catMap = new Map(), groupMap = new Map();

function mostRecentMonday() {
  const d = new Date(); const diff = (d.getDay() + 6) % 7; d.setDate(d.getDate() - diff); return iso(d);
}
const defaultSettings = () => ({
  theme: 'system', periodType: 'monthly', fortnightAnchor: mostRecentMonday(), weekStart: 1,
  nisabBasis: 'silver', goldPricePerGram: 0, silverPricePerGram: 0, goldNisab: 0, silverNisab: 0, nisabUpdated: '',
  hawlStart: '', hawlHistory: [], lockedDue: null, zakatFundCategoryId: '', sadaqahCategoryId: '', givingCategoryId: ''
});

function reindex() {
  S.groups.sort((a, b) => a.order - b.order);
  S.categories.sort((a, b) => a.order - b.order);
  catMap = new Map(S.categories.map((c) => [c.id, c]));
  groupMap = new Map(S.groups.map((g) => [g.id, g]));
}

const saveSettings = () => DB.put('settings', { key: 'app', value: S.settings });
async function saveRec(store, rec) {
  const arr = S[store]; const i = arr.findIndex((x) => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  await DB.put(store, rec);
  if (store === 'categories' || store === 'groups') reindex();
}
async function delRec(store, id) {
  S[store] = S[store].filter((x) => x.id !== id);
  await DB.del(store, id);
  if (store === 'categories' || store === 'groups') reindex();
}

// ====================================================================
// Seed data
// ====================================================================
const SEED = [
  ['Income', true, [['Salary'], ['Other Income']]],
  ['Giving (Zakat & Sadaqah)', false, [['Zakat Sinking Fund', { rollover: true, role: 'zakat' }], ['Sadaqah', { role: 'sadaqah' }]]],
  ['Savings & House Deposit', false, [['Emergency Fund', { rollover: true, zakatable: true }], ['House Deposit', { rollover: true, zakatable: true, role: 'house' }], ['Halal Shares / ETFs', { rollover: true, zakatable: true }]]],
  ['Housing & Utilities', false, [['Rent'], ['Electricity & Gas'], ['Water'], ['Internet & Phone']]],
  ['Food & Groceries', false, [['Groceries'], ['Household Items'], ['Eating Out']]],
  ['Transport & Fuel', false, [['Fuel'], ['Car Rego & Insurance', { rollover: true }], ['Car Maintenance', { rollover: true }], ['Public Transport']]],
  ['Personal & Health', false, [['Health & Medical'], ['Clothing'], ['Personal Care'], ['Subscriptions']]],
  ['Debt / Obligations', false, [['Credit Card'], ['Loan Repayments']]]
];

async function seed() {
  S.settings = defaultSettings();
  const groups = [], cats = [];
  let house = null;
  SEED.forEach(([name, isIncome, list], gi) => {
    const g = { id: uid(), name, order: gi, isIncome };
    groups.push(g);
    list.forEach(([cname, opts = {}], ci) => {
      const c = { id: uid(), groupId: g.id, name: cname, order: ci, rollover: !!opts.rollover, zakatable: !!opts.zakatable, opening: 0, openingDate: '' };
      cats.push(c);
      if (opts.role === 'zakat') S.settings.zakatFundCategoryId = c.id;
      if (opts.role === 'sadaqah') S.settings.sadaqahCategoryId = c.id;
      if (opts.role === 'house') house = c;
    });
  });
  const accounts = [
    { id: uid(), name: 'Cash on hand', type: 'asset', balance: 0, zakatable: true, deductible: false, notes: '' },
    { id: uid(), name: 'Gold & silver (market value)', type: 'asset', balance: 0, zakatable: true, deductible: false, notes: 'Update with current melt value' },
    { id: uid(), name: 'Car (personal use)', type: 'asset', balance: 0, zakatable: false, deductible: false, notes: 'Personal-use items are exempt' },
    { id: uid(), name: 'Bills due now (short-term debt)', type: 'liability', balance: 0, zakatable: false, deductible: true, notes: 'Immediately due debts can be deducted' }
  ];
  const goals = [{ id: uid(), name: 'House Deposit', target: 6000000, targetDate: addMonths(today(), 36), categoryId: house?.id || '', manualCurrent: 0 }];
  await DB.bulkPut('groups', groups);
  await DB.bulkPut('categories', cats);
  await DB.bulkPut('accounts', accounts);
  await DB.bulkPut('goals', goals);
  await saveSettings();
  Object.assign(S, { groups, categories: cats, accounts, goals });
}

async function loadAll() {
  const all = await DB.dumpAll();
  const st = all.settings.find((s) => s.key === 'app');
  if (!st) { await seed(); }
  else {
    S.settings = { ...defaultSettings(), ...st.value };
    S.groups = all.groups; S.categories = all.categories; S.accounts = all.accounts; S.goals = all.goals;
  }
  S.budgets = new Map(all.budgets.map((b) => [b.id, b]));
  S.transactions = all.transactions; S.rules = all.rules; S.zakatPayments = all.zakatPayments;
  S.schedules = all.schedules || []; S.debts = all.debts || [];
  S.snapshots = all.snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));
  reindex();
}

// ====================================================================
// Periods (monthly / fortnightly / weekly)
// ====================================================================
function periodFor(type, dateStr) {
  const d = parseISO(dateStr);
  let start, end, key, label;
  if (type === 'monthly') {
    start = iso(new Date(d.getFullYear(), d.getMonth(), 1));
    end = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    key = 'M-' + start.slice(0, 7);
    label = d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  } else if (type === 'weekly') {
    const ws = Number(S.settings.weekStart ?? 1);
    const diff = (d.getDay() - ws + 7) % 7;
    start = addDays(dateStr, -diff); end = addDays(start, 6); key = 'W-' + start;
  } else {
    const anchor = S.settings.fortnightAnchor || mostRecentMonday();
    const n = Math.floor(daysBetween(anchor, dateStr) / 14);
    start = addDays(anchor, n * 14); end = addDays(start, 13); key = 'F-' + start;
  }
  if (!label) label = `${fmtDate(start, { day: 'numeric', month: 'short' })} – ${fmtDate(end)}`;
  return { type, start, end, key, label };
}
const curPeriod = () => periodFor(S.settings.periodType, S.anchor);
const shiftPeriod = (p, dir) => periodFor(p.type, dir > 0 ? addDays(p.end, 1) : addDays(p.start, -1));

// ====================================================================
// Budget calculations
// ====================================================================
const planned = (p, catId) => S.budgets.get(`${p.key}|${catId}`)?.planned || 0;
const isIncomeCat = (c) => !!groupMap.get(c?.groupId)?.isIncome;

async function setPlanned(p, catId, cents) {
  const id = `${p.key}|${catId}`;
  const existing = S.budgets.get(id);
  if (!existing && !cents) return;
  const rec = { id, key: p.key, type: p.type, start: p.start, categoryId: catId, planned: cents };
  S.budgets.set(id, rec);
  await DB.put('budgets', rec);
}

// Map catId -> {spent, income} for a date range
function sumsInRange(from, to) {
  const m = new Map();
  for (const t of S.transactions) {
    if (t.date < from || t.date > to) continue;
    for (const sp of t.splits) {
      const e = m.get(sp.categoryId) || { spent: 0, income: 0 };
      if (t.type === 'income') e.income += sp.amount; else e.spent += sp.amount;
      m.set(sp.categoryId, e);
    }
  }
  return m;
}

// Rollover (sinking fund) balance as at the end of period p:
// opening balance + everything planned up to and including p − net spending since the fund started.
function fundBalance(cat, p) {
  let pl = 0, earliest = null;
  for (const b of S.budgets.values()) {
    if (b.categoryId !== cat.id || b.type !== p.type) continue;
    if (b.start <= p.start) pl += b.planned;
    if (!earliest || b.start < earliest) earliest = b.start;
  }
  const from = cat.openingDate || earliest || p.start;
  let net = 0;
  for (const t of S.transactions) {
    if (t.date < from || t.date > p.end) continue;
    for (const sp of t.splits) if (sp.categoryId === cat.id) net += t.type === 'income' ? -sp.amount : sp.amount;
  }
  return (cat.opening || 0) + pl - net;
}

function catState(c, p, sums) {
  const e = sums.get(c.id) || { spent: 0, income: 0 };
  const pl = planned(p, c.id);
  if (isIncomeCat(c)) { const actual = e.income - e.spent; return { inc: true, pl, actual, carry: 0, avail: pl, remaining: pl - actual }; }
  const actual = e.spent - e.income;
  if (c.rollover) { const bal = fundBalance(c, p); return { pl, actual, carry: bal - pl + actual, avail: bal + actual, remaining: bal, fund: true }; }
  return { pl, actual, carry: 0, avail: pl, remaining: pl - actual };
}

function budgetTotals(p, sums) {
  let plIncome = 0, plOut = 0, actIncome = 0, actOut = 0;
  for (const c of S.categories) {
    const e = sums.get(c.id) || { spent: 0, income: 0 };
    if (isIncomeCat(c)) { plIncome += planned(p, c.id); actIncome += e.income - e.spent; }
    else { plOut += planned(p, c.id); actOut += e.spent - e.income; }
  }
  // Uncategorised activity
  const u = sums.get('') || { spent: 0, income: 0 };
  actOut += u.spent; actIncome += u.income;
  return { plIncome, plOut, left: plIncome - plOut, actIncome, actOut };
}

const catName = (id) => (id && catMap.get(id)?.name) || 'Uncategorised';

// ====================================================================
// Zakat calculations
// ====================================================================
function zakatCalc() {
  const p = periodFor(S.settings.periodType, today());
  const items = [];
  for (const c of S.categories) {
    if (!c.zakatable || isIncomeCat(c)) continue;
    const v = c.rollover ? fundBalance(c, p) : (c.opening || 0);
    items.push({ kind: 'fund', id: c.id, name: c.name, value: Math.max(0, v) });
  }
  for (const a of S.accounts) if (a.type === 'asset' && a.zakatable) items.push({ kind: 'acct', id: a.id, name: a.name, value: Math.max(0, a.balance) });
  const deductions = S.accounts.filter((a) => a.type === 'liability' && a.deductible).map((a) => ({ id: a.id, name: a.name, value: Math.max(0, a.balance) }));
  const gross = items.reduce((s, i) => s + i.value, 0);
  const ded = deductions.reduce((s, i) => s + i.value, 0);
  const net = Math.max(0, gross - ded);
  const st = S.settings;
  const nisab = st.nisabBasis === 'gold' ? st.goldNisab : st.silverNisab;
  const above = nisab > 0 && net >= nisab;
  return { items, deductions, gross, ded, net, nisab, above, due: above ? Math.round(net * 0.025) : 0, potential: Math.round(net * 0.025) };
}

function hawlInfo() {
  const start = S.settings.hawlStart;
  if (!start) return { start: '', cycle: 'none' };
  const due = addDays(start, HAWL_DAYS);
  const daysLeft = daysBetween(today(), due);
  const elapsed = Math.min(HAWL_DAYS, Math.max(0, daysBetween(start, today())));
  return { start, due, daysLeft, elapsed, pct: (elapsed / HAWL_DAYS) * 100, cycle: start };
}

function zakatOwed() {
  const z = zakatCalc(); const h = hawlInfo();
  const locked = S.settings.lockedDue && S.settings.lockedDue.cycle === h.cycle ? S.settings.lockedDue : null;
  const due = locked ? locked.amount : z.due;
  const paid = S.zakatPayments.filter((x) => x.kind === 'zakat' && x.cycle === h.cycle).reduce((s, x) => s + x.amount, 0);
  return { z, h, locked, due, paid, remaining: Math.max(0, due - paid) };
}

// ====================================================================
// Net worth snapshots (one per day)
// ====================================================================
const snapshot = debounce(async () => {
  const p = periodFor(S.settings.periodType, today());
  const assets = S.accounts.filter((a) => a.type === 'asset').reduce((s, a) => s + a.balance, 0);
  const liab = S.accounts.filter((a) => a.type === 'liability').reduce((s, a) => s + a.balance, 0);
  const savings = S.categories.filter((c) => c.rollover && !isIncomeCat(c)).reduce((s, c) => s + Math.max(0, fundBalance(c, p)), 0);
  const rec = { date: today(), netWorth: assets - liab, savings, zakatable: zakatCalc().net };
  const i = S.snapshots.findIndex((s) => s.date === rec.date);
  if (i >= 0) S.snapshots[i] = rec; else S.snapshots.push(rec);
  await DB.put('snapshots', rec);
}, 800);

// ====================================================================
// UI helpers
// ====================================================================
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

function openModal(html, { wide = false, onMount } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  root.classList.add('open');
  document.body.style.overflow = 'hidden';
  const m = $('.modal', root);
  $('.modal-backdrop', root).addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closeModal(); });
  $$('[data-close]', m).forEach((b) => b.addEventListener('click', closeModal));
  onMount?.(m);
  const f = $('input:not([type=checkbox]):not([type=file]), select', m);
  if (f && matchMedia('(pointer:fine)').matches) f.focus();
  return m;
}
function closeModal() {
  const root = $('#modal-root'); root.classList.remove('open'); root.innerHTML = ''; document.body.style.overflow = '';
}
const modalHead = (title) => `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>`;

function catOptions(selected = '', { includeIncome = true, includeNone = true, incomeFirst = false } = {}) {
  let groups = S.groups.filter((g) => includeIncome || !g.isIncome);
  if (incomeFirst) groups = [...groups.filter((g) => g.isIncome), ...groups.filter((g) => !g.isIncome)];
  return (includeNone ? `<option value="">Uncategorised</option>` : '') + groups.map((g) =>
    `<optgroup label="${esc(g.name)}">${S.categories.filter((c) => c.groupId === g.id).map((c) =>
      `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
}

const switchHtml = (attrs, checked) => `<label class="switch"><input type="checkbox" ${attrs} ${checked ? 'checked' : ''}><span></span></label>`;

function applyTheme() {
  let t = S.settings.theme || 'system';
  try { localStorage.setItem('amanah-theme', t); } catch (e) { /* ignore */ }
  if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  $('meta[name=theme-color]').setAttribute('content', t === 'dark' ? '#0f1513' : '#0f766e');
}

// ====================================================================
// Render dispatcher
// ====================================================================
const VIEWS = {};
function render() {
  const fn = VIEWS[S.tab] || VIEWS.budget;
  const y = window.scrollY;
  $('#view').innerHTML = fn();
  VIEWS[S.tab + 'Mount']?.();
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  $('#fab').classList.toggle('hidden', !['budget', 'transactions'].includes(S.tab));
  if (render._keepScroll) window.scrollTo(0, y);
  render._keepScroll = false;
}
const rerender = () => { render._keepScroll = true; render(); };
function go(tab) { S.tab = tab; render(); window.scrollTo(0, 0); }

// ====================================================================
// BUDGET VIEW
// ====================================================================
function periodBar(p) {
  const t = S.settings.periodType;
  return `
  <div class="period-tools">
    <div class="seg" role="tablist">
      ${['monthly', 'fortnightly', 'weekly'].map((x) => `<button data-act="ptype" data-v="${x}" class="${t === x ? 'active' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}
    </div>
    <div class="row"><button class="btn sm ghost" data-act="plan-recurring" title="Plan from bills &amp; recurring">↻ From bills</button><button class="btn sm ghost" data-act="copy-prev">⧉ Copy previous</button></div>
  </div>
  <div class="periodbar">
    <button class="icon-btn" data-act="period" data-dir="-1" aria-label="Previous period">‹</button>
    <div class="p-label"><b>${esc(p.label)}</b><small>${fmtDate(p.start)} → ${fmtDate(p.end)}</small></div>
    <button class="icon-btn" data-act="period" data-dir="1" aria-label="Next period">›</button>
  </div>`;
}

function ltbHtml(t) {
  const cls = t.left === 0 && t.plIncome > 0 ? 'zero' : t.left < 0 ? 'over' : 'left';
  const label = cls === 'zero' ? '🎉 Zero-based budget — every dollar has a job!' : cls === 'over' ? 'Over budget by' : 'Left to budget';
  return `<div class="card ltb ${cls}" id="ltb">
    <div class="ltb-label">${label}</div>
    <div class="ltb-amt">${money(Math.abs(t.left))}</div>
    <div class="ltb-eq">${money(t.plIncome)} planned income − ${money(t.plOut)} planned expenses &amp; savings</div>
  </div>`;
}

function catParts(c, s) {
  let pct, cls, left, right;
  if (s.inc) {
    pct = s.pl > 0 ? Math.min(100, (s.actual / s.pl) * 100) : (s.actual > 0 ? 100 : 0); cls = 'info';
    left = `Received ${money(s.actual)}`;
    right = s.remaining > 0 ? `<span class="rem info">${money(s.remaining)} to come</span>` : s.remaining < 0 ? `<span class="rem ok">+${money(-s.remaining)} extra</span>` : `<span class="rem ok">All received</span>`;
  } else {
    pct = s.avail > 0 ? Math.min(100, (s.actual / s.avail) * 100) : (s.actual > 0 ? 100 : 0);
    cls = s.remaining < 0 ? 'over' : pct >= 90 && s.actual > 0 ? 'warn' : 'ok';
    left = (s.fund && s.carry ? `Carried ${money(s.carry)} · ` : '') + `Spent ${money(s.actual)}`;
    right = s.remaining < 0 ? `<span class="rem over">${money(-s.remaining)} over</span>`
      : `<span class="rem ok">${money(s.remaining)} ${s.fund ? 'available' : 'left'}</span>`;
  }
  return {
    bar: `<div class="bar"><span class="${cls}" style="width:${Math.max(0, pct).toFixed(1)}%"></span></div>`,
    sub: `<div class="cat-sub"><span>${left}</span>${right}</div>`
  };
}

function catRow(c, p, sums) {
  const s = catState(c, p, sums); const parts = catParts(c, s);
  return `<div class="cat-row" data-cat="${c.id}">
    <div class="cat-main">
      <button class="cat-name" data-act="edit-cat" data-id="${c.id}"><span class="nm">${esc(c.name)}</span>${c.rollover ? '<span class="tag">↻ Fund</span>' : ''}${c.zakatable ? '<span class="tag z">Zakatable</span>' : ''}</button>
      <input class="amt" inputmode="decimal" placeholder="0.00" value="${centsInput(s.pl)}" data-input="planned" data-id="${c.id}" aria-label="Planned for ${esc(c.name)}">
    </div>
    ${parts.bar}${parts.sub}
  </div>`;
}

VIEWS.budget = () => {
  const p = curPeriod(); const sums = sumsInRange(p.start, p.end); const t = budgetTotals(p, sums);
  let html = periodBar(p) + ltbHtml(t) + `
  <div class="grid3" style="margin-bottom:12px">
    <div class="stat"><div class="lbl">Income received</div><div class="val">${money(t.actIncome)}</div></div>
    <div class="stat"><div class="lbl">Spent</div><div class="val">${money(t.actOut)}</div></div>
    <div class="stat"><div class="lbl">Cash left</div><div class="val" style="color:${t.actIncome - t.actOut < 0 ? 'var(--over)' : 'inherit'}">${money(t.actIncome - t.actOut)}</div></div>
  </div>` + remindersHtml();
  for (const g of S.groups) {
    const cats = S.categories.filter((c) => c.groupId === g.id);
    const gPl = cats.reduce((s, c) => s + planned(p, c.id), 0);
    html += `<section class="card group" data-group="${g.id}">
      <div class="group-head"><h3>${esc(g.name)}</h3><span class="gtot" data-gtot="${g.id}">${money(gPl)}</span>
        <button class="icon-btn" data-act="edit-group" data-id="${g.id}" aria-label="Group options">⋯</button></div>
      ${cats.map((c) => catRow(c, p, sums)).join('') || '<p class="empty">No categories yet.</p>'}
      <button class="link-btn" data-act="add-cat" data-group="${g.id}">+ Add category</button>
    </section>`;
  }
  html += `<button class="btn ghost block" data-act="add-group">+ Add category group</button>
  <p class="hint" style="text-align:center">Each pay-cycle view (monthly / fortnightly / weekly) keeps its own plan. Tap a category name to rename, reorder or make it a sinking fund.</p>`;
  return html;
};

// Live update while typing planned amounts (no full re-render, so focus is kept).
const savePlanned = debounce((p, id, cents) => { setPlanned(p, id, cents).then(snapshot); }, 300);
function onPlannedInput(el) {
  const p = curPeriod(); const id = el.dataset.id; const cents = toCents(el.value);
  const rid = `${p.key}|${id}`;
  S.budgets.set(rid, { id: rid, key: p.key, type: p.type, start: p.start, categoryId: id, planned: cents });
  savePlanned(p, id, cents);
  const sums = sumsInRange(p.start, p.end);
  $('#ltb').outerHTML = ltbHtml(budgetTotals(p, sums));
  const c = catMap.get(id); const row = el.closest('.cat-row');
  const parts = catParts(c, catState(c, p, sums));
  $('.bar', row).outerHTML = parts.bar; $('.cat-sub', row).outerHTML = parts.sub;
  const g = c.groupId; const gt = $(`[data-gtot="${g}"]`);
  if (gt) gt.textContent = money(S.categories.filter((x) => x.groupId === g).reduce((s, x) => s + planned(p, x.id), 0));
}

async function copyPrevious() {
  const p = curPeriod(); const prev = shiftPeriod(p, -1);
  const hasAny = S.categories.some((c) => planned(p, c.id));
  const prevAny = S.categories.some((c) => planned(prev, c.id));
  if (!prevAny) return toast(`Nothing planned in ${prev.label}`);
  if (hasAny && !confirm(`Replace this period's plan with ${prev.label}'s amounts?`)) return;
  for (const c of S.categories) await setPlanned(p, c.id, planned(prev, c.id));
  toast(`Copied plan from ${prev.label}`); rerender();
}

function groupModal(g) {
  const isNew = !g;
  g = g ? clone(g) : { id: uid(), name: '', order: S.groups.length, isIncome: false };
  const count = S.categories.filter((c) => c.groupId === g.id).length;
  openModal(`${modalHead(isNew ? 'New group' : 'Edit group')}
    <label class="field"><span>Group name</span><input id="g-name" value="${esc(g.name)}" placeholder="e.g. Kids & Education"></label>
    ${isNew ? '' : `<div class="row" style="margin-bottom:10px"><button class="btn sm ghost" id="g-up">↑ Move up</button><button class="btn sm ghost" id="g-down">↓ Move down</button></div>`}
    <div class="modal-actions">
      ${isNew || g.isIncome ? '' : `<button class="btn danger" id="g-del">Delete${count ? ` (+${count} categories)` : ''}</button>`}
      <button class="btn" id="g-save">Save</button>
    </div>`, {
    onMount(m) {
      $('#g-save', m).onclick = async () => {
        const name = $('#g-name', m).value.trim(); if (!name) return toast('Enter a name');
        g.name = name; await saveRec('groups', g); closeModal(); rerender();
      };
      const move = async (dir) => {
        const i = S.groups.findIndex((x) => x.id === g.id); const j = i + dir;
        if (j < 0 || j >= S.groups.length) return;
        S.groups.forEach((x, k) => (x.order = k));
        [S.groups[i].order, S.groups[j].order] = [j, i];
        await DB.bulkPut('groups', S.groups); reindex(); closeModal(); rerender();
      };
      $('#g-up', m) && ($('#g-up', m).onclick = () => move(-1));
      $('#g-down', m) && ($('#g-down', m).onclick = () => move(1));
      $('#g-del', m) && ($('#g-del', m).onclick = async () => {
        if (!confirm(`Delete "${g.name}"${count ? ` and its ${count} categories? Their transactions become Uncategorised` : ''}?`)) return;
        for (const c of S.categories.filter((c) => c.groupId === g.id)) await deleteCategory(c.id);
        await delRec('groups', g.id); closeModal(); rerender();
      });
    }
  });
}

async function deleteCategory(id) {
  const changed = [];
  for (const t of S.transactions) {
    let hit = false;
    t.splits.forEach((s) => { if (s.categoryId === id) { s.categoryId = ''; hit = true; } });
    if (hit) changed.push(t);
  }
  if (changed.length) await DB.bulkPut('transactions', changed);
  const bks = [...S.budgets.values()].filter((b) => b.categoryId === id).map((b) => b.id);
  bks.forEach((k) => S.budgets.delete(k));
  if (bks.length) await DB.bulkDel('budgets', bks);
  S.rules.filter((r) => r.categoryId === id).forEach((r) => delRec('rules', r.id));
  S.goals.filter((g) => g.categoryId === id).forEach((g) => { g.categoryId = ''; saveRec('goals', g); });
  await delRec('categories', id);
}

function catModal(c, groupId) {
  const isNew = !c;
  c = c ? clone(c) : { id: uid(), groupId, name: '', order: S.categories.filter((x) => x.groupId === groupId).length, rollover: false, zakatable: false, opening: 0, openingDate: '' };
  const inc = !!groupMap.get(c.groupId)?.isIncome;
  const txCount = S.transactions.filter((t) => t.splits.some((s) => s.categoryId === c.id)).length;
  openModal(`${modalHead(isNew ? 'New category' : 'Edit category')}
    <label class="field"><span>Name</span><input id="c-name" value="${esc(c.name)}" placeholder="e.g. Kids' Madrasa fees"></label>
    <label class="field"><span>Group</span><select id="c-group">${S.groups.map((g) => `<option value="${g.id}" ${g.id === c.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <div id="c-flags" ${inc ? 'hidden' : ''}>
      <div class="toggle"><div class="t-text"><b>Sinking fund / rollover</b><small>Unspent money carries forward to the next period (e.g. Zakat, House Deposit, Car Rego).</small></div>${switchHtml('id="c-roll"', c.rollover)}</div>
      <div class="toggle"><div class="t-text"><b>Zakatable asset</b><small>Include this fund's balance in your Zakat calculation (cash, halal savings, gold, shares).</small></div>${switchHtml('id="c-zak"', c.zakatable)}</div>
      <div id="c-open" ${c.rollover ? '' : 'hidden'}>
        <div class="grid2" style="margin-top:10px">
          <label class="field"><span>Starting balance</span><input id="c-ob" inputmode="decimal" value="${centsInput(c.opening)}" placeholder="0.00"></label>
          <label class="field"><span>As at date</span><input id="c-od" type="date" value="${c.openingDate || ''}"></label>
        </div>
        <p class="hint" style="margin-top:-4px">Money already saved in this fund before you started using the app.</p>
      </div>
    </div>
    ${isNew ? '' : `<div class="row" style="margin-top:12px"><button class="btn sm ghost" id="c-up">↑ Move up</button><button class="btn sm ghost" id="c-down">↓ Move down</button></div>`}
    <div class="modal-actions">
      ${isNew ? '' : `<button class="btn danger" id="c-del">Delete</button>`}
      <button class="btn" id="c-save">Save</button>
    </div>`, {
    onMount(m) {
      $('#c-roll', m).onchange = (e) => { $('#c-open', m).hidden = !e.target.checked; };
      $('#c-group', m).onchange = (e) => { $('#c-flags', m).hidden = !!groupMap.get(e.target.value)?.isIncome; };
      $('#c-save', m).onclick = async () => {
        const name = $('#c-name', m).value.trim(); if (!name) return toast('Enter a name');
        const newGroup = $('#c-group', m).value;
        if (newGroup !== c.groupId) { c.order = S.categories.filter((x) => x.groupId === newGroup).length; c.groupId = newGroup; }
        const incomeGroup = !!groupMap.get(newGroup)?.isIncome;
        Object.assign(c, {
          name, rollover: !incomeGroup && $('#c-roll', m).checked, zakatable: !incomeGroup && $('#c-zak', m).checked,
          opening: toCents($('#c-ob', m).value), openingDate: $('#c-od', m).value
        });
        await saveRec('categories', c); closeModal(); rerender(); snapshot();
      };
      const move = async (dir) => {
        const list = S.categories.filter((x) => x.groupId === c.groupId);
        const i = list.findIndex((x) => x.id === c.id); const j = i + dir;
        if (j < 0 || j >= list.length) return;
        list.forEach((x, k) => (x.order = k));
        [list[i].order, list[j].order] = [j, i];
        await DB.bulkPut('categories', list); reindex(); closeModal(); rerender();
      };
      $('#c-up', m) && ($('#c-up', m).onclick = () => move(-1));
      $('#c-down', m) && ($('#c-down', m).onclick = () => move(1));
      $('#c-del', m) && ($('#c-del', m).onclick = async () => {
        if (!confirm(`Delete "${c.name}"?${txCount ? ` ${txCount} transaction(s) will become Uncategorised.` : ''}`)) return;
        await deleteCategory(c.id); closeModal(); rerender();
      });
    }
  });
}

// ====================================================================
// TRANSACTIONS VIEW
// ====================================================================
function filteredTx() {
  const f = S.filters; const q = f.q.trim().toLowerCase();
  return S.transactions.filter((t) => {
    if (f.type && t.type !== f.type) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.cat && !t.splits.some((s) => s.categoryId === (f.cat === '__none' ? '' : f.cat))) return false;
    if (q) {
      const hay = [t.merchant, t.notes, (t.amount / 100).toFixed(2), ...t.splits.map((s) => catName(s.categoryId))].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (a.date === b.date ? (b.created || 0) - (a.created || 0) : a.date < b.date ? 1 : -1));
}

function txListHtml() {
  const list = filteredTx();
  if (!list.length) return `<p class="empty">${S.transactions.length ? 'No transactions match your filters.' : 'No transactions yet. Tap + to add one, or import a bank CSV.'}</p>`;
  const inc = list.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const out = list.filter((t) => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  let html = `<div class="tx-total"><span>${list.length} transaction${list.length === 1 ? '' : 's'}</span><span>In ${money(inc)} · Out ${money(out)}</span></div>`;
  let day = '';
  for (const t of list.slice(0, 600)) {
    if (t.date !== day) { day = t.date; html += `<div class="tx-day">${fmtDate(t.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>`; }
    const cats = t.splits.length > 1 ? `Split · ${t.splits.map((s) => catName(s.categoryId)).join(', ')}` : catName(t.splits[0]?.categoryId);
    html += `<button class="tx" data-act="edit-tx" data-id="${t.id}">
      <div class="tx-main"><div class="tx-merchant">${esc(t.merchant || '(no description)')}</div><div class="tx-cat">${esc(cats)}${t.notes ? ' · ' + esc(t.notes) : ''}</div></div>
      <div class="tx-amt ${t.type === 'income' ? 'in' : ''}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</div>
    </button>`;
  }
  if (list.length > 600) html += `<p class="hint" style="text-align:center">Showing latest 600 — narrow with filters.</p>`;
  return html;
}

VIEWS.transactions = () => {
  const f = S.filters;
  return `
  <div class="row between" style="margin-bottom:10px"><h2>Transactions</h2>
    <div class="row"><button class="btn sm ghost" data-act="go-bills">↻ Recurring</button><button class="btn sm soft" data-act="import-csv">⇪ Import CSV</button></div></div>
  <div class="card filters">
    <input type="search" class="full" placeholder="Search merchant, notes, category, amount…" value="${esc(f.q)}" data-input="tx-q">
    <select data-change="tx-filter" data-k="cat"><option value="">All categories</option><option value="__none" ${f.cat === '__none' ? 'selected' : ''}>Uncategorised</option>${catOptions(f.cat, { includeNone: false })}</select>
    <select data-change="tx-filter" data-k="type"><option value="">Income &amp; expenses</option><option value="expense" ${f.type === 'expense' ? 'selected' : ''}>Expenses</option><option value="income" ${f.type === 'income' ? 'selected' : ''}>Income</option></select>
    <label class="field" style="margin:0"><span>From</span><input type="date" value="${f.from}" data-change="tx-filter" data-k="from"></label>
    <label class="field" style="margin:0"><span>To</span><input type="date" value="${f.to}" data-change="tx-filter" data-k="to"></label>
    <div class="full row wrap">
      <button class="btn sm ghost" data-act="tx-this-period">This period</button>
      <button class="btn sm ghost" data-act="tx-clear">Clear filters</button>
    </div>
  </div>
  <div id="txlist">${txListHtml()}</div>`;
};

function txModal(tx, preset = {}, onSaved = null) {
  const isNew = !tx;
  tx = tx ? clone(tx) : { id: uid(), date: today(), type: 'expense', amount: 0, merchant: '', notes: '', splits: [{ categoryId: '', amount: 0 }], created: Date.now(), ...preset };
  let split = tx.splits.length > 1;
  const merchants = [...new Set(S.transactions.slice(-400).map((t) => t.merchant).filter(Boolean))].slice(0, 200);
  const linkedPayment = S.zakatPayments.find((z) => z.txId === tx.id);

  openModal(`${modalHead(isNew ? 'Add transaction' : 'Edit transaction')}
    <div class="seg full" style="margin-bottom:12px">
      <button data-type="expense" class="${tx.type !== 'income' ? 'active' : ''}">Expense</button>
      <button data-type="income" class="${tx.type === 'income' ? 'active' : ''}">Income</button>
    </div>
    <div class="grid2">
      <label class="field"><span>Amount (AUD)</span><input id="t-amt" inputmode="decimal" value="${centsInput(tx.amount)}" placeholder="0.00"></label>
      <label class="field"><span>Date</span><input id="t-date" type="date" value="${tx.date}"></label>
    </div>
    <label class="field"><span>Merchant / payee</span><input id="t-merch" list="t-merchants" value="${esc(tx.merchant)}" placeholder="e.g. Woolworths" autocomplete="off"><datalist id="t-merchants">${merchants.map((m) => `<option value="${esc(m)}">`).join('')}</datalist></label>
    <div id="t-single" ${split ? 'hidden' : ''}><label class="field"><span>Category</span><select id="t-cat">${catOptions(tx.splits[0]?.categoryId, { incomeFirst: tx.type === 'income' })}</select></label></div>
    <div id="t-splits" ${split ? '' : 'hidden'}></div>
    <button class="link-btn" id="t-split-toggle" style="padding-top:0">${split ? '✕ Remove split' : '⑂ Split across categories'}</button>
    <label class="field" style="margin-top:8px"><span>Notes</span><input id="t-notes" value="${esc(tx.notes)}" placeholder="Optional"></label>
    ${linkedPayment ? `<p class="hint">Linked to a ${linkedPayment.kind === 'zakat' ? 'Zakat' : 'Sadaqah'} payment log entry.</p>` : ''}
    <div class="modal-actions">
      ${isNew ? '' : `<button class="btn danger" id="t-del">Delete</button>`}
      <button class="btn" id="t-save">Save</button>
    </div>`, {
    onMount(m) {
      const amtEl = $('#t-amt', m);
      const renderSplits = () => {
        const total = toCents(amtEl.value);
        const sum = tx.splits.reduce((s, x) => s + (x.amount || 0), 0);
        const diff = total - sum;
        $('#t-splits', m).innerHTML = tx.splits.map((s, i) => `
          <div class="split-row" data-i="${i}">
            <select data-k="cat">${catOptions(s.categoryId)}</select>
            <input data-k="amt" inputmode="decimal" value="${centsInput(s.amount)}" placeholder="0.00">
            <button class="icon-btn" data-k="rm" aria-label="Remove split">✕</button>
          </div>`).join('') + `
          <div class="split-status ${diff === 0 ? 'ok' : 'bad'}">${diff === 0 ? '✓ Fully assigned' : diff > 0 ? `${money(diff)} left to assign` : `${money(-diff)} over the total`}</div>
          <button class="btn sm ghost" data-k="add">+ Add split line</button>`;
      };
      const updateStatus = () => {
        const total = toCents(amtEl.value); const diff = total - tx.splits.reduce((s, x) => s + (x.amount || 0), 0);
        const el = $('.split-status', m); if (!el) return;
        el.className = `split-status ${diff === 0 ? 'ok' : 'bad'}`;
        el.textContent = diff === 0 ? '✓ Fully assigned' : diff > 0 ? `${money(diff)} left to assign` : `${money(-diff)} over the total`;
      };
      $('#t-splits', m).addEventListener('input', (e) => {
        const row = e.target.closest('.split-row'); if (!row) return;
        if (e.target.dataset.k === 'amt') { tx.splits[+row.dataset.i].amount = toCents(e.target.value); updateStatus(); }
      });
      $('#t-splits', m).addEventListener('change', (e) => {
        const row = e.target.closest('.split-row'); if (!row) return;
        if (e.target.dataset.k === 'cat') tx.splits[+row.dataset.i].categoryId = e.target.value;
      });
      $('#t-splits', m).addEventListener('click', (e) => {
        const k = e.target.closest('[data-k]')?.dataset.k;
        if (k === 'add') {
          const total = toCents(amtEl.value); const sum = tx.splits.reduce((s, x) => s + (x.amount || 0), 0);
          tx.splits.push({ categoryId: '', amount: Math.max(0, total - sum) }); renderSplits();
        } else if (k === 'rm') {
          if (tx.splits.length <= 2) return toast('A split needs at least 2 lines');
          tx.splits.splice(+e.target.closest('.split-row').dataset.i, 1); renderSplits();
        }
      });
      amtEl.addEventListener('input', () => split && updateStatus());
      $('#t-split-toggle', m).onclick = () => {
        split = !split;
        const total = toCents(amtEl.value);
        if (split) {
          const first = $('#t-cat', m).value;
          tx.splits = [{ categoryId: first, amount: total }, { categoryId: '', amount: 0 }];
          renderSplits();
        } else tx.splits = [{ categoryId: tx.splits[0]?.categoryId || '', amount: total }];
        $('#t-single', m).hidden = split; $('#t-splits', m).hidden = !split;
        if (!split) $('#t-cat', m).value = tx.splits[0].categoryId;
        $('#t-split-toggle', m).textContent = split ? '✕ Remove split' : '⑂ Split across categories';
      };
      $$('.seg button', m).forEach((b) => (b.onclick = () => {
        tx.type = b.dataset.type; $$('.seg button', m).forEach((x) => x.classList.toggle('active', x === b));
        const sel = $('#t-cat', m); const cur = sel.value; sel.innerHTML = catOptions(cur, { incomeFirst: tx.type === 'income' });
      }));
      // Auto-pick category from merchant rules
      $('#t-merch', m).addEventListener('change', (e) => {
        if (split || $('#t-cat', m).value) return;
        const r = matchRule(e.target.value); if (r) $('#t-cat', m).value = r.categoryId;
        else {
          const prev = [...S.transactions].reverse().find((t) => t.merchant.toLowerCase() === e.target.value.toLowerCase() && t.splits.length === 1);
          if (prev) $('#t-cat', m).value = prev.splits[0].categoryId;
        }
      });
      if (split) renderSplits();
      $('#t-save', m).onclick = async () => {
        const total = toCents(amtEl.value);
        if (total <= 0) return toast('Enter an amount greater than $0');
        tx.amount = total; tx.date = $('#t-date', m).value || today();
        tx.merchant = $('#t-merch', m).value.trim(); tx.notes = $('#t-notes', m).value.trim();
        if (split) {
          tx.splits = tx.splits.filter((s) => s.amount > 0);
          const sum = tx.splits.reduce((s, x) => s + x.amount, 0);
          if (sum !== total) return toast(`Splits add up to ${money(sum)}, not ${money(total)}`);
        } else tx.splits = [{ categoryId: $('#t-cat', m).value, amount: total }];
        await saveRec('transactions', tx);
        if (onSaved) await onSaved(tx);
        closeModal(); toast(isNew ? 'Transaction added' : 'Saved'); rerender(); snapshot();
      };
      $('#t-del', m) && ($('#t-del', m).onclick = async () => {
        if (!confirm('Delete this transaction?')) return;
        await delRec('transactions', tx.id);
        if (linkedPayment) { linkedPayment.txId = ''; await saveRec('zakatPayments', linkedPayment); }
        closeModal(); toast('Deleted'); rerender(); snapshot();
      });
    }
  });
}

function matchRule(desc) {
  const k = CSV.normKey(desc); if (!k) return null;
  let best = null;
  for (const r of S.rules) if (r.pattern && k.includes(r.pattern) && (!best || r.pattern.length > best.pattern.length)) best = r;
  return best && catMap.has(best.categoryId) ? best : null;
}

// ====================================================================
// CSV IMPORT
// ====================================================================
function importModal() {
  const imp = { rows: [], map: null, items: [], fileName: '' };
  const colOpts = (sel) => {
    const n = Math.max(0, ...imp.rows.slice(0, 5).map((r) => r.length));
    const hdr = imp.map?.hasHeader ? imp.rows[0] : null;
    const sample = imp.rows[imp.map?.hasHeader ? 1 : 0] || [];
    return `<option value="-1">— none —</option>` + Array.from({ length: n }, (_, i) =>
      `<option value="${i}" ${i === sel ? 'selected' : ''}>Col ${i + 1}: ${esc((hdr ? hdr[i] : sample[i]) || '').slice(0, 28)}</option>`).join('');
  };

  const step1 = () => {
    const m = imp.map;
    $('#imp-body').innerHTML = !imp.rows.length ? `
      <p>Download a CSV statement from your bank's website (CommBank, NAB, ANZ, Westpac and most others), then choose it here. Nothing leaves your device.</p>
      <input type="file" id="imp-file" accept=".csv,text/csv,text/plain">` : `
      <div class="notice ok">Loaded <b>${esc(imp.fileName)}</b> · ${imp.rows.length} rows · detected format: <b>${esc(m.bank)}</b></div>
      <div class="grid2">
        <label class="field"><span>Bank preset</span><select id="imp-bank">${['Custom', 'CommBank', 'NAB', 'ANZ', 'Westpac'].map((b) => `<option ${b === m.bank ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
        <label class="field"><span>Date format</span><select id="imp-df">
          <option value="DMY" ${m.dateFormat === 'DMY' ? 'selected' : ''}>DD/MM/YYYY (Australian)</option>
          <option value="MDY" ${m.dateFormat === 'MDY' ? 'selected' : ''}>MM/DD/YYYY</option>
          <option value="YMD" ${m.dateFormat === 'YMD' ? 'selected' : ''}>YYYY-MM-DD</option></select></label>
        <label class="field"><span>Date column</span><select id="imp-date">${colOpts(m.date)}</select></label>
        <label class="field"><span>Description column</span><select id="imp-desc">${colOpts(m.desc)}</select></label>
      </div>
      <div class="toggle"><div class="t-text"><b>First row is a header</b></div>${switchHtml('id="imp-hdr"', m.hasHeader)}</div>
      <div class="toggle"><div class="t-text"><b>Separate Debit &amp; Credit columns</b><small>e.g. Westpac exports</small></div>${switchHtml('id="imp-split"', m.mode === 'split')}</div>
      <div class="grid2" style="margin-top:10px">
        ${m.mode === 'split' ? `
          <label class="field"><span>Debit (money out) column</span><select id="imp-debit">${colOpts(m.debit)}</select></label>
          <label class="field"><span>Credit (money in) column</span><select id="imp-credit">${colOpts(m.credit)}</select></label>` : `
          <label class="field"><span>Amount column</span><select id="imp-amount">${colOpts(m.amount)}</select></label>
          <div class="toggle" style="border:0"><div class="t-text"><b>Flip signs</b><small>Use if purchases show as positive</small></div>${switchHtml('id="imp-flip"', m.flip)}</div>`}
      </div>
      <h3 style="margin:8px 0">Preview</h3>
      <div class="table-wrap"><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>
        ${parseItems().slice(0, 6).map((it) => `<tr><td>${it.date ? fmtDate(it.date) : '<span class="pill dup">bad date</span>'}</td><td class="desc">${esc(it.desc)}</td><td class="num">${it.amount === null ? '<span class="pill dup">?</span>' : money(it.amount)}</td></tr>`).join('')}
      </table></div>
      <p class="hint">Bank formats change occasionally — check the preview looks right (expenses negative, income positive).</p>
      <div class="modal-actions"><button class="btn ghost" id="imp-reset">Choose another file</button><button class="btn" id="imp-next">Review transactions →</button></div>`;
    bind1();
  };

  const parseItems = () => {
    const m = imp.map; const out = [];
    imp.rows.slice(m.hasHeader ? 1 : 0).forEach((r) => {
      const date = CSV.parseDate(r[m.date], m.dateFormat);
      let amount;
      if (m.mode === 'split') {
        const d = CSV.parseAmount(r[m.debit]); const c = CSV.parseAmount(r[m.credit]);
        amount = d === null && c === null ? null : Math.abs(c || 0) - Math.abs(d || 0);
      } else { amount = CSV.parseAmount(r[m.amount]); if (amount !== null && m.flip) amount = -amount; }
      const desc = CSV.cleanDesc(m.desc >= 0 ? r[m.desc] : '');
      out.push({ date, amount, desc });
    });
    return out;
  };

  const bind1 = () => {
    const f = $('#imp-file');
    if (f) f.onchange = async () => {
      const file = f.files[0]; if (!file) return;
      const text = await file.text();
      imp.rows = CSV.parseCSV(text); imp.fileName = file.name;
      if (!imp.rows.length) return toast('That file looks empty');
      imp.map = CSV.detectMapping(imp.rows); step1();
    };
    if (!imp.rows.length) return;
    const m = imp.map; const v = (id) => +$(id).value;
    $('#imp-bank').onchange = (e) => { const pr = CSV.BANK_PRESETS[e.target.value]; Object.assign(m, pr || {}, { bank: e.target.value }); step1(); };
    $('#imp-df').onchange = (e) => { m.dateFormat = e.target.value; step1(); };
    $('#imp-date').onchange = () => { m.date = v('#imp-date'); step1(); };
    $('#imp-desc').onchange = () => { m.desc = v('#imp-desc'); step1(); };
    $('#imp-hdr').onchange = (e) => { m.hasHeader = e.target.checked; step1(); };
    $('#imp-split').onchange = (e) => { m.mode = e.target.checked ? 'split' : 'single'; step1(); };
    $('#imp-amount') && ($('#imp-amount').onchange = () => { m.amount = v('#imp-amount'); step1(); });
    $('#imp-flip') && ($('#imp-flip').onchange = (e) => { m.flip = e.target.checked; step1(); });
    $('#imp-debit') && ($('#imp-debit').onchange = () => { m.debit = v('#imp-debit'); step1(); });
    $('#imp-credit') && ($('#imp-credit').onchange = () => { m.credit = v('#imp-credit'); step1(); });
    $('#imp-reset').onclick = () => { imp.rows = []; imp.map = null; step1(); };
    $('#imp-next').onclick = step2;
  };

  const step2 = () => {
    const parsed = parseItems();
    const existing = new Set(S.transactions.map((t) => t.importHash).filter(Boolean));
    const soft = new Set(S.transactions.map((t) => `${t.date}|${t.type === 'income' ? t.amount : -t.amount}`));
    const seen = new Map();
    imp.items = parsed.filter((it) => it.date && it.amount !== null && it.amount !== 0).map((it) => {
      const base = `${it.date}|${it.amount}|${CSV.normKey(it.desc)}`;
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      const hash = `${base}#${n}`;
      const dup = existing.has(hash);
      const maybe = !dup && soft.has(`${it.date}|${it.amount}`);
      const rule = matchRule(it.desc);
      return { ...it, hash, dup, maybe, include: !dup && !maybe, categoryId: rule?.categoryId || '' };
    });
    const bad = parsed.length - imp.items.length;
    const nDup = imp.items.filter((i) => i.dup).length, nMaybe = imp.items.filter((i) => i.maybe).length;
    $('#imp-body').innerHTML = `
      <div class="grid3" style="margin-bottom:10px">
        <div class="stat"><div class="lbl">New</div><div class="val">${imp.items.length - nDup - nMaybe}</div></div>
        <div class="stat"><div class="lbl">Duplicates skipped</div><div class="val">${nDup}</div></div>
        <div class="stat"><div class="lbl">Possible dupes</div><div class="val">${nMaybe}</div></div>
      </div>
      ${bad ? `<p class="hint">${bad} row(s) skipped (no valid date/amount, or $0).</p>` : ''}
      <div class="table-wrap" style="max-height:50vh;overflow:auto"><table>
        <tr><th><input type="checkbox" id="imp-all" checked aria-label="Select all"></th><th>Date</th><th>Description</th><th>Amount</th><th>Category</th><th></th></tr>
        ${imp.items.map((it, i) => `<tr class="${it.dup ? 'dup' : ''}" data-i="${i}">
          <td><input type="checkbox" data-k="inc" ${it.include ? 'checked' : ''}></td>
          <td>${fmtDate(it.date, { day: 'numeric', month: 'short', year: '2-digit' })}</td>
          <td class="desc">${esc(it.desc)}</td>
          <td class="num" style="color:${it.amount > 0 ? 'var(--ok)' : 'inherit'}">${it.amount > 0 ? '+' : '−'}${money(Math.abs(it.amount))}</td>
          <td><select data-k="cat">${catOptions(it.categoryId, { incomeFirst: it.amount > 0 })}</select></td>
          <td>${it.dup ? '<span class="pill dup">Duplicate</span>' : it.maybe ? '<span class="pill maybe">Possible dup</span>' : it.categoryId ? '<span class="pill new">Rule</span>' : ''}</td>
        </tr>`).join('')}
      </table></div>
      <div class="toggle"><div class="t-text"><b>Remember merchant → category rules</b><small>Future imports will auto-categorise these merchants.</small></div>${switchHtml('id="imp-rules"', true)}</div>
      <div class="modal-actions"><button class="btn ghost" id="imp-back">← Back</button><button class="btn" id="imp-go">Import selected</button></div>`;
    const body = $('#imp-body');
    body.addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (e.target.id === 'imp-all') { $$('tr[data-i]', body).forEach((r) => { const it = imp.items[+r.dataset.i]; if (!it.dup) { it.include = e.target.checked; $('[data-k=inc]', r).checked = e.target.checked; } }); return; }
      if (!tr) return;
      const it = imp.items[+tr.dataset.i];
      if (e.target.dataset.k === 'inc') it.include = e.target.checked;
      if (e.target.dataset.k === 'cat') {
        it.categoryId = e.target.value; it.touched = true;
        // apply same category to other uncategorised rows from the same merchant
        const key = CSV.ruleKeyFrom(it.desc);
        imp.items.forEach((o, j) => {
          if (j !== +tr.dataset.i && !o.categoryId && key && CSV.ruleKeyFrom(o.desc) === key) {
            o.categoryId = it.categoryId; const sel = $(`tr[data-i="${j}"] [data-k=cat]`, body); if (sel) sel.value = it.categoryId;
          }
        });
      }
    });
    $('#imp-back').onclick = step1;
    $('#imp-go').onclick = async () => {
      const chosen = imp.items.filter((i) => i.include);
      if (!chosen.length) return toast('Nothing selected');
      const now = Date.now();
      const txs = chosen.map((it, k) => ({
        id: uid(), date: it.date, type: it.amount > 0 ? 'income' : 'expense', amount: Math.abs(it.amount),
        merchant: it.desc, notes: '', splits: [{ categoryId: it.categoryId, amount: Math.abs(it.amount) }],
        importHash: it.hash, created: now + k
      }));
      await DB.bulkPut('transactions', txs); S.transactions.push(...txs);
      let nRules = 0;
      if ($('#imp-rules').checked) {
        for (const it of chosen) {
          if (!it.categoryId) continue;
          const key = CSV.ruleKeyFrom(it.desc); if (!key) continue;
          const ex = S.rules.find((r) => r.pattern === key);
          if (!ex) { await saveRec('rules', { id: uid(), pattern: key, categoryId: it.categoryId }); nRules++; }
          else if (ex.categoryId !== it.categoryId && it.touched) { ex.categoryId = it.categoryId; await saveRec('rules', ex); nRules++; }
        }
      }
      closeModal(); toast(`Imported ${txs.length} transaction(s)${nRules ? ` · ${nRules} rule(s) saved` : ''}`); rerender(); snapshot();
    };
  };

  openModal(`${modalHead('Import bank statement (CSV)')}<div id="imp-body"></div>`, { wide: true, onMount: step1 });
}

// ====================================================================
// ZAKAT VIEW
// ====================================================================
VIEWS.zakat = () => {
  const st = S.settings; const o = zakatOwed(); const { z, h } = o;
  const per = st.periodType; const nPer = PERIODS_PER_YEAR[per];
  const annual = o.due || z.potential;
  const perAmt = Math.ceil(annual / nPer);
  const fundCat = catMap.get(st.zakatFundCategoryId);
  const sadaqahYear = new Date().getFullYear();
  const sadaqah = S.zakatPayments.filter((x) => x.kind === 'sadaqah' && x.date.startsWith(String(sadaqahYear))).reduce((s, x) => s + x.amount, 0);
  const pays = [...S.zakatPayments].sort((a, b) => (a.date < b.date ? 1 : -1));
  const zPays = pays.filter((x) => x.kind === 'zakat'); const sPays = pays.filter((x) => x.kind === 'sadaqah');
  const paidPct = o.due > 0 ? Math.min(100, (o.paid / o.due) * 100) : 0;
  const cycleLabel = (c) => c === 'none' ? 'No Hawl set' : `Hawl from ${fmtDate(c)}`;

  return `
  <h2 style="margin-bottom:10px">Zakat</h2>
  <div class="card zk-hero">
    <div class="row between wrap"><span class="muted">Net zakatable wealth</span>
      ${z.nisab ? `<span class="badge ${z.above ? 'above' : 'below'}">${z.above ? '✓ Above Nisab' : 'Below Nisab'}</span>` : `<span class="badge below">Set Nisab ↓</span>`}</div>
    <div class="big">${money(z.net)}</div>
    <div class="grid2" style="margin-top:10px">
      <div class="stat"><div class="lbl">Nisab (${st.nisabBasis})</div><div class="val">${z.nisab ? money(z.nisab) : '—'}</div></div>
      <div class="stat"><div class="lbl">Zakat due (2.5%)</div><div class="val" style="color:var(--gold)">${money(z.due)}</div></div>
    </div>
    ${!z.above && z.nisab ? `<p class="hint">${money(z.nisab - z.net)} below the Nisab — no Zakat is due on this wealth right now.</p>` : ''}
  </div>

  <div class="wide-2col">
  <div class="card">
    <div class="card-head"><h3>This Hawl's Zakat</h3><small>${esc(cycleLabel(h.cycle))}</small></div>
    <div class="grid3">
      <div class="stat"><div class="lbl">Total due</div><div class="val">${money(o.due)}</div></div>
      <div class="stat"><div class="lbl">Paid so far</div><div class="val" style="color:var(--ok)">${money(o.paid)}</div></div>
      <div class="stat"><div class="lbl">Remaining</div><div class="val" style="color:${o.remaining ? 'var(--over)' : 'var(--ok)'}">${money(o.remaining)}</div></div>
    </div>
    <div class="bar" style="height:10px;margin-top:12px"><span class="ok" style="width:${paidPct}%"></span></div>
    <p class="hint">${o.locked ? `🔒 Due amount locked on ${fmtDate(o.locked.date)} — it won't change as your balances move.` : 'The due amount follows your live balances. Lock it when your Hawl completes so paying Zakat doesn\'t shrink the figure.'}</p>
    <div class="row wrap" style="margin-top:10px">
      <button class="btn sm" data-act="add-payment" data-kind="zakat">+ Record Zakat paid</button>
      <button class="btn sm ghost" data-act="lock-due">${o.locked ? 'Unlock amount' : '🔒 Lock due amount'}</button>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>Hawl tracker (354-day lunar year)</h3></div>
    ${h.start ? `
      <div class="hawl-ring">
        ${Charts.donut([{ label: 'Elapsed', value: h.elapsed, color: 'var(--gold)' }, { label: 'Remaining', value: HAWL_DAYS - h.elapsed, color: 'transparent' }], { size: 110, thickness: 12, center: `${Math.round(h.pct)}%`, sub: 'of Hawl' })}
        <div><div class="hawl-days">${h.daysLeft > 0 ? h.daysLeft : 0}</div><div class="muted">${h.daysLeft > 0 ? 'days until Zakat is due' : h.daysLeft === 0 ? 'Zakat is due today' : `Hawl completed ${-h.daysLeft} day(s) ago`}</div>
        ${h.daysLeft <= 0 ? '<span class="badge due" style="margin-top:6px">Zakat due</span>' : ''}</div>
      </div>
      <div class="dates2">
        <div class="stat"><div class="lbl">Wealth crossed Nisab</div><div class="val">${fmtDate(h.start)}</div><small>${hijri(h.start)}</small></div>
        <div class="stat"><div class="lbl">Zakat due date</div><div class="val">${fmtDate(h.due)}</div><small>≈ ${hijri(h.due)}</small></div>
      </div>` : '<p class="muted">Record the date your zakatable wealth first reached the Nisab to start the 354-day countdown.</p>'}
    <label class="field" style="margin-top:12px"><span>Date wealth first reached Nisab</span><input type="date" value="${h.start}" data-change="hawl-start"></label>
    ${h.start && h.daysLeft <= 0 ? `<button class="btn sm gold" data-act="next-hawl">Start next Hawl from ${fmtDate(h.due)}</button>` : ''}
    <p class="hint">Hijri dates use your device's Umm al-Qura calendar and may differ by a day from local moon sighting.</p>
  </div>
  </div>

  <div class="card">
    <div class="card-head"><h3>Fund ${per === 'monthly' ? 'monthly' : per} Zakat</h3></div>
    <p style="margin-top:0">Estimated annual Zakat <b>${money(annual)}</b> ÷ ${nPer} ${per === 'monthly' ? 'months' : per === 'fortnightly' ? 'fortnights' : 'weeks'} = <b>${money(perAmt)}</b> per period.</p>
    <label class="field"><span>Zakat sinking fund category</span><select data-change="zakat-fund-cat">${catOptions(st.zakatFundCategoryId, { includeIncome: false, includeNone: false })}</select></label>
    <button class="btn block gold" data-act="fund-zakat" ${annual && fundCat ? '' : 'disabled'}>Fund ${money(perAmt)} into ${esc(fundCat?.name || 'Zakat fund')} for ${esc(curPeriod().label)}</button>
    ${fundCat ? `<p class="hint">Current ${esc(fundCat.name)} balance: <b>${money(fundBalance(fundCat, curPeriod()))}</b>${fundCat.rollover ? '' : ' — tip: turn on "Sinking fund" for this category so it rolls over.'}</p>` : ''}
  </div>

  <div class="card">
    <div class="card-head"><h3>Nisab threshold (AUD)</h3><small>${st.nisabUpdated ? 'Updated ' + fmtDate(st.nisabUpdated) : 'Not set'}</small></div>
    <div class="seg full" style="margin-bottom:12px">
      <button data-act="nisab-basis" data-v="silver" class="${st.nisabBasis === 'silver' ? 'active' : ''}">Silver basis (${SILVER_GRAMS} g)</button>
      <button data-act="nisab-basis" data-v="gold" class="${st.nisabBasis === 'gold' ? 'active' : ''}">Gold basis (${GOLD_GRAMS} g)</button>
    </div>
    <div class="grid2">
      <label class="field"><span>Gold price per gram</span><input inputmode="decimal" value="${centsInput(st.goldPricePerGram)}" placeholder="e.g. 130.00" data-change="nisab" data-k="goldPricePerGram"></label>
      <label class="field"><span>Gold Nisab (${GOLD_GRAMS} g)</span><input inputmode="decimal" value="${centsInput(st.goldNisab)}" placeholder="0.00" data-change="nisab" data-k="goldNisab"></label>
      <label class="field"><span>Silver price per gram</span><input inputmode="decimal" value="${centsInput(st.silverPricePerGram)}" placeholder="e.g. 1.60" data-change="nisab" data-k="silverPricePerGram"></label>
      <label class="field"><span>Silver Nisab (${SILVER_GRAMS} g)</span><input inputmode="decimal" value="${centsInput(st.silverNisab)}" placeholder="0.00" data-change="nisab" data-k="silverNisab"></label>
    </div>
    <p class="hint">Enter today's price per gram and the Nisab is worked out for you, or type the threshold directly (e.g. from your local Zakat organisation). Both are saved, so it works fully offline.</p>
  </div>

  <div class="card">
    <div class="card-head"><h3>What's counted</h3></div>
    ${z.items.map((i) => `<div class="zk-line"><span>${esc(i.name)} <small>${i.kind === 'fund' ? '· fund' : '· asset'}</small></span><span>${money(i.value)}</span></div>`).join('') || '<p class="muted">Nothing tagged as zakatable yet.</p>'}
    ${z.deductions.map((i) => `<div class="zk-line"><span>− ${esc(i.name)} <small>· deductible debt</small></span><span class="neg">−${money(i.value)}</span></div>`).join('')}
    <div class="zk-line total"><span>Net zakatable wealth</span><span>${money(z.net)}</span></div>
    <div class="divider"></div>
    <h3 style="margin-bottom:4px">Zakatable savings funds</h3>
    ${S.categories.filter((c) => !isIncomeCat(c) && c.rollover).map((c) => `
      <div class="toggle"><div class="t-text"><b>${esc(c.name)}</b><small>Balance ${money(fundBalance(c, periodFor(st.periodType, today())))}</small></div>${switchHtml(`data-change="cat-zakatable" data-id="${c.id}"`, c.zakatable)}</div>`).join('') || '<p class="muted">No sinking funds yet.</p>'}
    <p class="hint">Avoid double counting: if a fund's money sits in a bank account you also list below, tag only one of them. The Zakat fund itself is money already owed, so leave it un-tagged.</p>
  </div>

  <div class="card">
    <div class="card-head"><h3>Assets &amp; liabilities</h3><button class="btn sm soft" data-act="add-account">+ Add</button></div>
    ${S.accounts.map((a) => `<button class="pay-item" data-act="edit-account" data-id="${a.id}">
      <span><b>${esc(a.name)}</b><small>${a.type === 'asset' ? (a.zakatable ? 'Zakatable asset' : 'Exempt / personal use') : (a.deductible ? 'Liability · deducted from Zakat' : 'Liability · not deducted')}</small></span>
      <span class="num" style="font-weight:700;color:${a.type === 'liability' ? 'var(--over)' : 'inherit'}">${a.type === 'liability' && a.balance ? '−' : ''}${money(a.balance)}</span></button>`).join('') || '<p class="muted">No accounts yet.</p>'}
  </div>

  <div class="wide-2col">
  <div class="card">
    <div class="card-head"><h3>Zakat payment log</h3></div>
    ${zPays.map((x) => `<button class="pay-item" data-act="edit-payment" data-id="${x.id}"><span><b>${esc(x.recipient || 'Zakat')}</b><small>${fmtDate(x.date)} · ${esc(cycleLabel(x.cycle))}${x.notes ? ' · ' + esc(x.notes) : ''}</small></span><span class="num" style="font-weight:700">${money(x.amount)}</span></button>`).join('') || '<p class="muted">No Zakat payments recorded.</p>'}
  </div>
  <div class="card">
    <div class="card-head"><h3>Sadaqah (voluntary)</h3><button class="btn sm soft" data-act="add-payment" data-kind="sadaqah">+ Add</button></div>
    <div class="stat" style="margin-bottom:8px"><div class="lbl">Sadaqah given in ${sadaqahYear}</div><div class="val">${money(sadaqah)}</div></div>
    ${sPays.slice(0, 30).map((x) => `<button class="pay-item" data-act="edit-payment" data-id="${x.id}"><span><b>${esc(x.recipient || 'Sadaqah')}</b><small>${fmtDate(x.date)}${x.notes ? ' · ' + esc(x.notes) : ''}</small></span><span class="num" style="font-weight:700">${money(x.amount)}</span></button>`).join('') || '<p class="muted">Kept separate from Zakat so the two never mix.</p>'}
  </div>
  </div>
  <p class="disclaimer">This tool does the arithmetic (2.5% of net zakatable wealth held for one lunar year above the Nisab). Rulings on specific assets — shares, super, debts, jewellery — differ between scholars, so check with a scholar or your local Zakat organisation if unsure.</p>`;
};

function paymentModal(pay, kind = 'zakat') {
  const isNew = !pay; const h = hawlInfo(); const st = S.settings;
  pay = pay ? clone(pay) : { id: uid(), kind, date: today(), recipient: '', amount: 0, notes: '', cycle: h.cycle, txId: '' };
  const defCat = pay.kind === 'zakat' ? st.zakatFundCategoryId : st.sadaqahCategoryId;
  const linkedTx = S.transactions.find((t) => t.id === pay.txId);
  openModal(`${modalHead(`${isNew ? 'Record' : 'Edit'} ${pay.kind === 'zakat' ? 'Zakat' : 'Sadaqah'} payment`)}
    <div class="grid2">
      <label class="field"><span>Amount (AUD)</span><input id="p-amt" inputmode="decimal" value="${centsInput(pay.amount)}" placeholder="0.00"></label>
      <label class="field"><span>Date</span><input id="p-date" type="date" value="${pay.date}"></label>
    </div>
    <label class="field"><span>Recipient / charity</span><input id="p-rec" value="${esc(pay.recipient)}" placeholder="e.g. National Zakat Foundation"></label>
    <label class="field"><span>Notes</span><input id="p-notes" value="${esc(pay.notes)}" placeholder="Optional"></label>
    <div class="toggle"><div class="t-text"><b>Also record as a budget expense</b><small>Deducts the payment from the chosen category so your budget stays accurate.</small></div>${switchHtml('id="p-link"', isNew || !!linkedTx)}</div>
    <label class="field" style="margin-top:8px"><span>Expense category</span><select id="p-cat">${catOptions(linkedTx?.splits[0]?.categoryId || defCat, { includeIncome: false })}</select></label>
    <div class="modal-actions">${isNew ? '' : '<button class="btn danger" id="p-del">Delete</button>'}<button class="btn" id="p-save">Save</button></div>`, {
    onMount(m) {
      $('#p-save', m).onclick = async () => {
        const amt = toCents($('#p-amt', m).value); if (amt <= 0) return toast('Enter an amount');
        Object.assign(pay, { amount: amt, date: $('#p-date', m).value || today(), recipient: $('#p-rec', m).value.trim(), notes: $('#p-notes', m).value.trim() });
        if ($('#p-link', m).checked) {
          const cat = $('#p-cat', m).value;
          const t = linkedTx ? clone(linkedTx) : { id: uid(), type: 'expense', created: Date.now() };
          Object.assign(t, { date: pay.date, amount: amt, merchant: pay.recipient || (pay.kind === 'zakat' ? 'Zakat payment' : 'Sadaqah'), notes: pay.kind === 'zakat' ? 'Zakat' : 'Sadaqah', splits: [{ categoryId: cat, amount: amt }] });
          await saveRec('transactions', t); pay.txId = t.id;
        } else if (linkedTx) { await delRec('transactions', linkedTx.id); pay.txId = ''; }
        await saveRec('zakatPayments', pay); closeModal(); toast('Payment saved'); rerender(); snapshot();
      };
      $('#p-del', m) && ($('#p-del', m).onclick = async () => {
        if (!confirm('Delete this payment' + (linkedTx ? ' and its linked budget transaction?' : '?'))) return;
        if (linkedTx) await delRec('transactions', linkedTx.id);
        await delRec('zakatPayments', pay.id); closeModal(); rerender(); snapshot();
      });
    }
  });
}

function accountModal(a) {
  const isNew = !a;
  a = a ? clone(a) : { id: uid(), name: '', type: 'asset', balance: 0, zakatable: true, deductible: false, notes: '' };
  openModal(`${modalHead(isNew ? 'Add asset or liability' : 'Edit')}
    <div class="seg full" style="margin-bottom:12px"><button data-type="asset" class="${a.type === 'asset' ? 'active' : ''}">Asset</button><button data-type="liability" class="${a.type === 'liability' ? 'active' : ''}">Liability</button></div>
    <label class="field"><span>Name</span><input id="a-name" value="${esc(a.name)}" placeholder="e.g. Halal savings account, Gold bangles, Halal ETF"></label>
    <label class="field"><span>Current value (AUD)</span><input id="a-bal" inputmode="decimal" value="${centsInput(a.balance)}" placeholder="0.00"></label>
    <div class="toggle" id="a-z-wrap" ${a.type === 'asset' ? '' : 'hidden'}><div class="t-text"><b>Zakatable asset</b><small>Cash, savings, gold/silver, trade goods, halal shares/ETFs. Turn off for personal-use items (home, car, furniture).</small></div>${switchHtml('id="a-z"', a.zakatable)}</div>
    <div class="toggle" id="a-d-wrap" ${a.type === 'liability' ? '' : 'hidden'}><div class="t-text"><b>Deduct from Zakat</b><small>For short-term debts due now (bills, amounts owed this year). Long-term debt such as a full mortgage is usually not deducted in full.</small></div>${switchHtml('id="a-d"', a.deductible)}</div>
    <label class="field" style="margin-top:8px"><span>Notes</span><input id="a-notes" value="${esc(a.notes)}"></label>
    <div class="modal-actions">${isNew ? '' : '<button class="btn danger" id="a-del">Delete</button>'}<button class="btn" id="a-save">Save</button></div>`, {
    onMount(m) {
      $$('.seg button', m).forEach((b) => (b.onclick = () => {
        a.type = b.dataset.type; $$('.seg button', m).forEach((x) => x.classList.toggle('active', x === b));
        $('#a-z-wrap', m).hidden = a.type !== 'asset'; $('#a-d-wrap', m).hidden = a.type !== 'liability';
      }));
      $('#a-save', m).onclick = async () => {
        const name = $('#a-name', m).value.trim(); if (!name) return toast('Enter a name');
        Object.assign(a, { name, balance: Math.abs(toCents($('#a-bal', m).value)), zakatable: a.type === 'asset' && $('#a-z', m).checked, deductible: a.type === 'liability' && $('#a-d', m).checked, notes: $('#a-notes', m).value.trim(), updated: today() });
        await saveRec('accounts', a); closeModal(); rerender(); snapshot();
      };
      $('#a-del', m) && ($('#a-del', m).onclick = async () => { if (!confirm(`Delete "${a.name}"?`)) return; await delRec('accounts', a.id); closeModal(); rerender(); snapshot(); });
    }
  });
}

// ====================================================================
// GOALS VIEW
// ====================================================================
function goalStats(g) {
  const cat = catMap.get(g.categoryId);
  const current = cat ? Math.max(0, fundBalance(cat, periodFor(S.settings.periodType, today()))) : (g.manualCurrent || 0);
  const remaining = Math.max(0, g.target - current);
  const days = g.targetDate ? daysBetween(today(), g.targetDate) : 0;
  const months = days / 30.4375;
  return {
    cat, current, remaining, days, pct: g.target ? Math.min(100, (current / g.target) * 100) : 0,
    perMonth: months > 0 ? Math.ceil(remaining / months) : remaining,
    perFortnight: days > 0 ? Math.ceil(remaining / (days / 14)) : remaining,
    perWeek: days > 0 ? Math.ceil(remaining / (days / 7)) : remaining
  };
}

const goalsHtml = () => `
  <div class="row between" style="margin-bottom:10px"><h2>Savings goals</h2><button class="btn sm soft" data-act="add-goal">+ New goal</button></div>
  ${S.goals.map((g) => {
    const s = goalStats(g);
    return `<div class="card goal">
      <div class="card-head"><h3>${esc(g.name)}</h3><button class="icon-btn" data-act="edit-goal" data-id="${g.id}" aria-label="Edit goal">✎</button></div>
      <div class="row between"><span class="g-amt">${money(s.current)}</span><span class="muted">of ${money(g.target)}</span></div>
      <div class="bar"><span class="${s.pct >= 100 ? 'ok' : 'info'}" style="width:${s.pct}%"></span></div>
      <div class="row between muted" style="font-size:.82rem"><span>${Math.round(s.pct)}% · ${money(s.remaining)} to go</span><span>${g.targetDate ? 'by ' + fmtDate(g.targetDate) : 'no date'}</span></div>
      ${s.remaining > 0 && g.targetDate ? (s.days > 0 ? `
      <div class="grid3" style="margin-top:12px">
        <div class="stat"><div class="lbl">Per month</div><div class="val">${money(s.perMonth)}</div></div>
        <div class="stat"><div class="lbl">Per fortnight</div><div class="val">${money(s.perFortnight)}</div></div>
        <div class="stat"><div class="lbl">Per week</div><div class="val">${money(s.perWeek)}</div></div>
      </div>` : '<p class="hint" style="color:var(--over)">Target date has passed — pick a new date.</p>') : s.remaining <= 0 ? '<p class="hint" style="color:var(--ok)">🎉 Goal reached — alhamdulillah!</p>' : ''}
      <div class="divider"></div>
      <div class="row wrap" style="gap:6px"><span class="muted" style="font-size:.85rem">If I save</span>
        <input style="width:110px" inputmode="decimal" placeholder="1000" data-input="goal-calc" data-id="${g.id}">
        <span class="muted" style="font-size:.85rem">per month →</span><b id="gc-${g.id}" style="font-size:.9rem">…</b></div>
      <p class="hint">${s.cat ? `Linked to the <b>${esc(s.cat.name)}</b> sinking fund — progress updates as you budget into it.` : 'Manual balance — edit the goal to update it, or link it to a sinking fund.'}</p>
    </div>`;
  }).join('') || '<div class="card"><p class="empty">No goals yet. Add one — like a $40,000–$80,000 house deposit.</p></div>'}`;
VIEWS.goals = () => goalsHtml() + debtHtml();

function goalCalc(el) {
  const g = S.goals.find((x) => x.id === el.dataset.id); const s = goalStats(g);
  const amt = toCents(el.value); const out = $('#gc-' + g.id);
  if (amt <= 0) { out.textContent = '…'; return; }
  const months = Math.ceil(s.remaining / amt);
  out.textContent = s.remaining <= 0 ? 'already reached' : `reach it by ${fmtDate(addMonths(today(), months), { month: 'short', year: 'numeric' })} (${months} mo)`;
}

function goalModal(g) {
  const isNew = !g;
  g = g ? clone(g) : { id: uid(), name: '', target: 0, targetDate: addMonths(today(), 24), categoryId: '', manualCurrent: 0 };
  const funds = S.categories.filter((c) => c.rollover && !isIncomeCat(c));
  openModal(`${modalHead(isNew ? 'New goal' : 'Edit goal')}
    <label class="field"><span>Goal name</span><input id="gl-name" value="${esc(g.name)}" placeholder="e.g. House Deposit, Hajj, Emergency Fund"></label>
    <div class="grid2">
      <label class="field"><span>Target amount</span><input id="gl-target" inputmode="decimal" value="${centsInput(g.target)}" placeholder="60000.00"></label>
      <label class="field"><span>Target date</span><input id="gl-date" type="date" value="${g.targetDate}"></label>
    </div>
    <label class="field"><span>Track progress from</span><select id="gl-cat"><option value="">Manual balance</option>${funds.map((c) => `<option value="${c.id}" ${c.id === g.categoryId ? 'selected' : ''}>Sinking fund: ${esc(c.name)}</option>`).join('')}</select></label>
    <label class="field" id="gl-man-wrap" ${g.categoryId ? 'hidden' : ''}><span>Amount saved so far</span><input id="gl-man" inputmode="decimal" value="${centsInput(g.manualCurrent)}" placeholder="0.00"></label>
    <div class="modal-actions">${isNew ? '' : '<button class="btn danger" id="gl-del">Delete</button>'}<button class="btn" id="gl-save">Save</button></div>`, {
    onMount(m) {
      $('#gl-cat', m).onchange = (e) => { $('#gl-man-wrap', m).hidden = !!e.target.value; };
      $('#gl-save', m).onclick = async () => {
        const name = $('#gl-name', m).value.trim(); const target = toCents($('#gl-target', m).value);
        if (!name || target <= 0) return toast('Enter a name and target');
        Object.assign(g, { name, target, targetDate: $('#gl-date', m).value, categoryId: $('#gl-cat', m).value, manualCurrent: toCents($('#gl-man', m).value) });
        await saveRec('goals', g); closeModal(); rerender();
      };
      $('#gl-del', m) && ($('#gl-del', m).onclick = async () => { if (!confirm('Delete this goal?')) return; await delRec('goals', g.id); closeModal(); rerender(); });
    }
  });
}

// ====================================================================
// REPORTS VIEW
// ====================================================================
VIEWS.reports = () => {
  const p = curPeriod(); const sums = sumsInRange(p.start, p.end);
  const spend = S.categories.filter((c) => !isIncomeCat(c)).map((c) => {
    const e = sums.get(c.id) || { spent: 0, income: 0 }; return { label: c.name, value: e.spent - e.income };
  });
  const un = sums.get('');
  if (un && un.spent) spend.push({ label: 'Uncategorised', value: un.spent, color: '#94a3b8' });
  const items = spend.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const top = items.slice(0, 9);
  if (items.length > 9) top.push({ label: 'Other', value: items.slice(9).reduce((s, x) => s + x.value, 0), color: '#94a3b8' });
  const totalSpent = items.reduce((s, x) => s + x.value, 0);

  const pva = S.groups.filter((g) => !g.isIncome).map((g) => {
    const cats = S.categories.filter((c) => c.groupId === g.id);
    return { label: g.name, planned: cats.reduce((s, c) => s + planned(p, c.id), 0), actual: cats.reduce((s, c) => { const e = sums.get(c.id) || { spent: 0, income: 0 }; return s + e.spent - e.income; }, 0) };
  }).filter((r) => r.planned || r.actual);

  const o = zakatOwed();
  const snaps = S.snapshots.slice(-180);

  return `
  <div class="periodbar">
    <button class="icon-btn" data-act="period" data-dir="-1" aria-label="Previous period">‹</button>
    <div class="p-label"><b>${esc(p.label)}</b><small>${S.settings.periodType} report</small></div>
    <button class="icon-btn" data-act="period" data-dir="1" aria-label="Next period">›</button>
  </div>
  <div class="card"><div class="card-head"><h3>Spending by category</h3></div>
    ${top.length ? `<div class="chart-wrap">${Charts.donut(top, { center: money(totalSpent).replace(/\.\d\d$/, ''), sub: 'spent' })}${Charts.legend(top)}</div>` : '<p class="empty">No spending recorded this period.</p>'}
  </div>
  <div class="card"><div class="card-head"><h3>Planned vs actual</h3></div>
    ${pva.length ? Charts.plannedVsActual(pva) : '<p class="empty">Plan your budget to see this chart.</p>'}
  </div>
  <div class="wide-2col">
    <div class="card"><div class="card-head"><h3>Zakat paid vs remaining</h3></div>
      ${o.due > 0 ? `<div class="chart-wrap">${Charts.donut([{ label: 'Paid', value: Math.min(o.paid, o.due), color: 'var(--ok)' }, { label: 'Remaining', value: o.remaining, color: 'var(--gold)' }], { size: 150, thickness: 22, center: `${Math.round((Math.min(o.paid, o.due) / o.due) * 100)}%`, sub: 'paid' })}
        ${Charts.legend([{ label: 'Paid', value: Math.min(o.paid, o.due), color: 'var(--ok)' }, { label: 'Remaining', value: o.remaining, color: 'var(--gold)' }])}</div>` : '<p class="empty">No Zakat due right now.</p>'}
    </div>
    <div class="card"><div class="card-head"><h3>This period at a glance</h3></div>
      ${(() => { const t = budgetTotals(p, sums); return `
        <div class="zk-line"><span>Planned income</span><span>${money(t.plIncome)}</span></div>
        <div class="zk-line"><span>Income received</span><span>${money(t.actIncome)}</span></div>
        <div class="zk-line"><span>Planned spending &amp; saving</span><span>${money(t.plOut)}</span></div>
        <div class="zk-line"><span>Actual spending</span><span>${money(t.actOut)}</span></div>
        <div class="zk-line total"><span>Savings rate</span><span>${t.actIncome > 0 ? Math.round(((t.actIncome - t.actOut) / t.actIncome) * 100) + '%' : '—'}</span></div>`; })()}
    </div>
  </div>
  <div class="card"><div class="card-head"><h3>Net worth &amp; savings over time</h3></div>
    ${Charts.lineChart([
      { name: 'Net worth (assets − liabilities)', color: 'var(--primary)', points: snaps.map((s) => ({ x: s.date, y: s.netWorth })) },
      { name: 'Sinking funds total', color: 'var(--gold)', points: snaps.map((s) => ({ x: s.date, y: s.savings })) },
      { name: 'Zakatable wealth', color: '#6366f1', points: snaps.map((s) => ({ x: s.date, y: s.zakatable || 0 })) }
    ])}
    <p class="hint">Net worth comes from Assets &amp; Liabilities on the Zakat tab. A snapshot is stored once per day.</p>
  </div>`;
};

// ====================================================================
// SETTINGS VIEW
// ====================================================================
VIEWS.settings = () => {
  const st = S.settings;
  const secure = window.isSecureContext;
  return `
  <h2 style="margin-bottom:10px">Settings</h2>
  ${secure ? '' : `<div class="notice">⚠️ Offline mode and "install" need a secure connection (HTTPS or localhost). The app works here, but it won't load without your computer running. See README → "Full offline on your phone".</div>`}
  <div class="card">
    <div class="card-head"><h3>Appearance</h3></div>
    <div class="seg full">${['light', 'dark', 'system'].map((t) => `<button data-act="theme" data-v="${t}" class="${st.theme === t ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
  </div>
  <div class="card">
    <div class="card-head"><h3>Pay cycle</h3></div>
    <label class="field"><span>Default budget view</span><select data-change="setting" data-k="periodType">${['monthly', 'fortnightly', 'weekly'].map((x) => `<option value="${x}" ${st.periodType === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select></label>
    <label class="field"><span>Fortnight starts on (any payday)</span><input type="date" value="${st.fortnightAnchor}" data-change="setting" data-k="fortnightAnchor"></label>
    <label class="field"><span>Week starts on</span><select data-change="setting" data-k="weekStart">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => `<option value="${i}" ${+st.weekStart === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
    <p class="hint">Changing the fortnight start date re-aligns fortnightly periods; amounts already planned stay with their original dates.</p>
  </div>
  <div class="card">
    <div class="card-head"><h3>Backup &amp; data</h3></div>
    <div class="stack">
      <button class="btn block" data-act="backup-enc">🔒 Encrypted backup to iCloud / Google Drive</button>
      <button class="btn block ghost" data-act="export-json">⬇ Export full backup (JSON)</button>
      <label class="btn block ghost" style="cursor:pointer">⬆ Restore from backup (JSON)<input type="file" accept=".json,application/json" data-change="restore-json" hidden></label>
      <button class="btn block ghost" data-act="export-csv">⬇ Export transactions (CSV)</button>
      <button class="btn block soft" data-act="import-csv">⇪ Import bank statement (CSV)</button>
      <button class="btn block soft" data-act="export-ics">📅 Add bills &amp; Zakat date to Calendar</button>
    </div>
    <p class="hint">Last backup: <b>${st.lastBackup ? fmtDate(st.lastBackup) : 'never'}</b></p>
    <p class="hint">Your data lives only in this browser on this device (${S.transactions.length} transactions). Export a backup regularly — clearing browser data or uninstalling deletes it. Restore the file on another device to move your budget.</p>
    <p class="hint" id="persist-status"></p>
  </div>
  <div class="card">
    <div class="card-head"><h3>Merchant rules</h3><small>${S.rules.length}</small></div>
    ${S.rules.length ? S.rules.slice().sort((a, b) => a.pattern.localeCompare(b.pattern)).map((r) => `
      <div class="split-row" style="grid-template-columns:1fr 1fr 36px">
        <input value="${esc(r.pattern)}" data-change="rule-pattern" data-id="${r.id}" aria-label="Pattern">
        <select data-change="rule-cat" data-id="${r.id}">${catOptions(r.categoryId, { includeNone: false })}</select>
        <button class="icon-btn" data-act="del-rule" data-id="${r.id}" aria-label="Delete rule">✕</button>
      </div>`).join('') : '<p class="muted">Rules are created when you categorise transactions during a CSV import.</p>'}
    <p class="hint">If a transaction description contains the pattern text, it gets that category on import.</p>
  </div>
  <div class="card">
    <div class="card-head"><h3>Danger zone</h3></div>
    <button class="btn danger block" data-act="reset-all">Erase all data &amp; start fresh</button>
  </div>
  <p class="disclaimer" style="text-align:center">Amanah Budget v${APP_VERSION} · 100% offline · no accounts, no tracking, no fees.</p>`;
};
VIEWS.settingsMount = async () => {
  const el = $('#persist-status'); if (!el || !navigator.storage?.persisted) return;
  const p = await navigator.storage.persisted();
  el.textContent = p ? '✓ Storage is marked persistent — the browser won\'t clear it automatically.' : 'Storage is not yet marked persistent. Installing the app to your home screen helps protect it.';
};

async function exportJSON() {
  const data = await DB.dumpAll();
  const payload = { app: 'amanah-budget', version: 1, appVersion: APP_VERSION, exported: new Date().toISOString(), data };
  download(`amanah-budget-backup-${today()}.json`, JSON.stringify(payload, null, 1));
  S.settings.lastBackup = today(); saveSettings();
  toast('Backup downloaded');
}

async function restoreJSON(file) {
  try {
    let payload = JSON.parse(await file.text());
    if (payload.app === 'amanah-budget' && payload.encrypted) {
      const pass = prompt('This backup is encrypted. Enter its passphrase:');
      if (!pass) return;
      try { payload = await decryptBackup(payload, pass); } catch (e) { throw new Error('Wrong passphrase, or the file is damaged'); }
    }
    if (payload.app !== 'amanah-budget' || !payload.data) throw new Error('Not an Amanah Budget backup');
    const n = payload.data.transactions?.length || 0;
    if (!confirm(`Restore backup from ${payload.exported?.slice(0, 10) || 'unknown date'} (${n} transactions)? This REPLACES everything currently in the app.`)) return;
    await DB.replaceAll(payload.data);
    await loadAll(); applyTheme(); toast('Backup restored'); go('budget');
  } catch (e) { alert('Could not restore: ' + e.message); }
}

function exportCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Type', 'Merchant', 'Category', 'Group', 'Amount', 'Notes', 'Transaction ID'].join(',')];
  for (const t of [...S.transactions].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    for (const s of t.splits) {
      const c = catMap.get(s.categoryId);
      lines.push([t.date, t.type, q(t.merchant), q(catName(s.categoryId)), q(groupMap.get(c?.groupId)?.name || ''),
        ((t.type === 'income' ? 1 : -1) * s.amount / 100).toFixed(2), q(t.notes), t.id].join(','));
    }
  }
  download(`amanah-transactions-${today()}.csv`, lines.join('\n'), 'text/csv');
  toast('CSV exported');
}

// ====================================================================
// Event delegation
// ====================================================================
const ACTIONS = {
  period: (el) => { const p = curPeriod(); S.anchor = shiftPeriod(p, +el.dataset.dir).start; render(); },
  ptype: async (el) => { S.settings.periodType = el.dataset.v; S.anchor = today(); await saveSettings(); render(); },
  'copy-prev': copyPrevious,
  'edit-cat': (el) => catModal(catMap.get(el.dataset.id)),
  'add-cat': (el) => catModal(null, el.dataset.group),
  'edit-group': (el) => groupModal(groupMap.get(el.dataset.id)),
  'add-group': () => groupModal(null),
  'edit-tx': (el) => txModal(S.transactions.find((t) => t.id === el.dataset.id)),
  'import-csv': importModal,
  'tx-clear': () => { S.filters = { q: '', cat: '', type: '', from: '', to: '' }; render(); },
  'tx-this-period': () => { const p = curPeriod(); S.filters.from = p.start; S.filters.to = p.end; render(); },
  'add-payment': (el) => paymentModal(null, el.dataset.kind),
  'edit-payment': (el) => paymentModal(S.zakatPayments.find((x) => x.id === el.dataset.id)),
  'add-account': () => accountModal(null),
  'edit-account': (el) => accountModal(S.accounts.find((x) => x.id === el.dataset.id)),
  'lock-due': async () => {
    const o = zakatOwed();
    if (o.locked) S.settings.lockedDue = null;
    else { if (!o.z.due && !confirm('Your wealth is currently below the Nisab (Zakat due $0). Lock $0 anyway?')) return; S.settings.lockedDue = { cycle: o.h.cycle, amount: o.z.due, date: today() }; }
    await saveSettings(); rerender();
  },
  'next-hawl': async () => {
    const o = zakatOwed();
    if (!confirm(`Start a new Hawl from ${fmtDate(o.h.due)}? This Hawl's record (due ${money(o.due)}, paid ${money(o.paid)}) is kept in history.`)) return;
    S.settings.hawlHistory = [...(S.settings.hawlHistory || []), { start: o.h.start, due: o.h.due, dueAmount: o.due, paid: o.paid }];
    S.settings.hawlStart = o.h.due; S.settings.lockedDue = null; await saveSettings(); rerender();
  },
  'fund-zakat': async () => {
    const o = zakatOwed(); const st = S.settings; const annual = o.due || o.z.potential;
    const perAmt = Math.ceil(annual / PERIODS_PER_YEAR[st.periodType]); const p = curPeriod();
    const cat = catMap.get(st.zakatFundCategoryId); if (!cat) return;
    const cur = planned(p, cat.id);
    if (cur && cur !== perAmt && !confirm(`${cat.name} already has ${money(cur)} planned for ${p.label}. Replace with ${money(perAmt)}?`)) return;
    await setPlanned(p, cat.id, perAmt);
    toast(`${money(perAmt)} planned into ${cat.name} for ${p.label}`); rerender(); snapshot();
  },
  'nisab-basis': async (el) => { S.settings.nisabBasis = el.dataset.v; await saveSettings(); rerender(); },
  'add-goal': () => goalModal(null),
  'edit-goal': (el) => goalModal(S.goals.find((g) => g.id === el.dataset.id)),
  theme: async (el) => { S.settings.theme = el.dataset.v; await saveSettings(); applyTheme(); rerender(); },
  'export-json': exportJSON,
  'export-csv': exportCSV,
  'del-rule': async (el) => { await delRec('rules', el.dataset.id); rerender(); },
  'reset-all': async () => {
    if (!confirm('Erase ALL budget data on this device? Export a backup first if you might need it.')) return;
    if (prompt('Type ERASE to confirm') !== 'ERASE') return;
    await DB.replaceAll({}); await loadAll(); applyTheme(); toast('All data erased'); go('budget');
  }
};

const CHANGES = {
  'tx-filter': (el) => { S.filters[el.dataset.k] = el.value; $('#txlist').innerHTML = txListHtml(); },
  'hawl-start': async (el) => { S.settings.hawlStart = el.value; S.settings.lockedDue = null; await saveSettings(); rerender(); },
  'zakat-fund-cat': async (el) => { S.settings.zakatFundCategoryId = el.value; await saveSettings(); rerender(); },
  nisab: async (el) => {
    const st = S.settings; const v = toCents(el.value); st[el.dataset.k] = v;
    if (el.dataset.k === 'goldPricePerGram') st.goldNisab = v * GOLD_GRAMS;
    if (el.dataset.k === 'silverPricePerGram') st.silverNisab = v * SILVER_GRAMS;
    st.nisabUpdated = today(); await saveSettings(); rerender(); snapshot();
  },
  'cat-zakatable': async (el) => { const c = catMap.get(el.dataset.id); c.zakatable = el.checked; await saveRec('categories', c); rerender(); snapshot(); },
  setting: async (el) => {
    const k = el.dataset.k; S.settings[k] = k === 'weekStart' ? +el.value : el.value;
    if (k === 'periodType') S.anchor = today();
    await saveSettings(); toast('Saved');
  },
  'restore-json': (el) => { if (el.files[0]) restoreJSON(el.files[0]); el.value = ''; },
  'rule-pattern': async (el) => { const r = S.rules.find((x) => x.id === el.dataset.id); r.pattern = CSV.normKey(el.value) || r.pattern; el.value = r.pattern; await saveRec('rules', r); },
  'rule-cat': async (el) => { const r = S.rules.find((x) => x.id === el.dataset.id); r.categoryId = el.value; await saveRec('rules', r); }
};

const INPUTS = {
  planned: onPlannedInput,
  'tx-q': debounce((el) => { S.filters.q = el.value; $('#txlist').innerHTML = txListHtml(); }, 150),
  'goal-calc': goalCalc
};

// ====================================================================
// v1.1 — Bills & recurring, Calendar export, Debt planner, Encrypted backup
// ====================================================================
const FREQS = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
const PER_MONTH = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };

function occurrence(s, n) {
  switch (s.freq) {
    case 'weekly': return addDays(s.startDate, 7 * n);
    case 'fortnightly': return addDays(s.startDate, 14 * n);
    case 'quarterly': return addMonths(s.startDate, 3 * n);
    case 'yearly': return addMonths(s.startDate, 12 * n);
    default: return addMonths(s.startDate, n);
  }
}
const nextDue = (s) => occurrence(s, s.count || 0);
const isEnded = (s) => !!s.endDate && nextDue(s) > s.endDate;

function schedTx(s, date, amount = s.amount) {
  return { id: uid(), date, type: s.type, amount, merchant: s.name, notes: s.notes || '', splits: [{ categoryId: s.categoryId, amount }], scheduleId: s.id, created: Date.now() };
}

// Auto-add any recurring transactions that have come due (runs at start-up and when the app is reopened).
async function processSchedules() {
  const t = today(); const newTx = []; const changed = [];
  for (const s of S.schedules) {
    if (!s.active || !s.autoPost) continue;
    let n = 0;
    while (nextDue(s) <= t && !isEnded(s) && n < 500) { newTx.push(schedTx(s, nextDue(s))); s.count = (s.count || 0) + 1; n++; }
    if (n) changed.push(s);
  }
  if (newTx.length) {
    await DB.bulkPut('transactions', newTx); S.transactions.push(...newTx);
    await DB.bulkPut('schedules', changed); snapshot();
  }
  return newTx.length;
}

function dueSoon(days = 7) {
  const lim = addDays(today(), days);
  return S.schedules.filter((s) => s.active && !isEnded(s) && nextDue(s) <= lim)
    .map((s) => ({ s, date: nextDue(s), days: daysBetween(today(), nextDue(s)) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
const dueLabel = (d) => d < 0 ? `Overdue ${-d} day${d === -1 ? '' : 's'}` : d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `In ${d} days`;
const dueCls = (d) => d < 0 ? 'dup' : d <= 2 ? 'maybe' : 'new';

function remindersHtml() {
  const lines = [];
  for (const { s, date, days } of dueSoon(7)) {
    lines.push(`<div class="due-item">
      <span><b>${esc(s.name)}</b><small><span class="pill ${dueCls(days)}">${dueLabel(days)}</span> ${fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}${s.autoPost ? ' · auto-adds' : ''}</small></span>
      <span class="row"><span class="num" style="font-weight:700;${s.type === 'income' ? 'color:var(--ok)' : ''}">${s.type === 'income' ? '+' : ''}${money(s.amount)}</span>
      ${s.autoPost ? '' : `<button class="btn sm soft" data-act="pay-sched" data-id="${s.id}">${s.type === 'income' ? 'Got it' : 'Paid'}</button>`}</span></div>`);
  }
  const h = hawlInfo();
  if (h.start && h.daysLeft <= 30) {
    lines.push(`<div class="due-item"><span><b>🌙 Zakat due</b><small><span class="pill ${h.daysLeft < 0 ? 'dup' : 'maybe'}">${dueLabel(h.daysLeft)}</span> ${fmtDate(h.due)} · ${esc(hijri(h.due))}</small></span><button class="btn sm gold" data-act="go-zakat">View</button></div>`);
  }
  const lb = S.settings.lastBackup; const since = lb ? daysBetween(lb, today()) : null;
  if (S.transactions.length >= 20 && (since === null || since > 30)) {
    lines.push(`<div class="due-item"><span><b>💾 Back up your budget</b><small>${since === null ? 'No backup yet' : `Last backup ${since} days ago`}</small></span><button class="btn sm soft" data-act="backup-enc">Back up</button></div>`);
  }
  const empty = S.schedules.length
    ? '<p class="muted" style="margin:0">Nothing due in the next 7 days.</p>'
    : '<p class="muted" style="margin:0">Add your bills, rent, salary and subscriptions to get reminders and auto-entries.</p>';
  return `<div class="card"><div class="card-head"><h3>🔔 Coming up</h3><button class="link-btn" style="padding:0" data-act="go-bills">Bills &amp; recurring ›</button></div>${lines.join('') || empty}</div>`;
}

VIEWS.bills = () => {
  const act = S.schedules.filter((s) => s.active && !isEnded(s));
  const monthlyOut = act.filter((s) => s.type !== 'income').reduce((t, s) => t + s.amount * PER_MONTH[s.freq], 0);
  const monthlyIn = act.filter((s) => s.type === 'income').reduce((t, s) => t + s.amount * PER_MONTH[s.freq], 0);
  const list = [...S.schedules].sort((a, b) => {
    const ea = !a.active || isEnded(a), eb = !b.active || isEnded(b);
    if (ea !== eb) return ea ? 1 : -1;
    return nextDue(a) < nextDue(b) ? -1 : 1;
  });
  return `
  <div class="row between" style="margin-bottom:10px">
    <div class="row"><button class="icon-btn" data-act="go-budget" aria-label="Back">‹</button><h2>Bills &amp; recurring</h2></div>
    <button class="btn sm soft" data-act="add-sched">+ Add</button>
  </div>
  <div class="grid2" style="margin-bottom:12px">
    <div class="stat"><div class="lbl">Recurring out / month</div><div class="val">${money(Math.round(monthlyOut))}</div></div>
    <div class="stat"><div class="lbl">Recurring in / month</div><div class="val" style="color:var(--ok)">${money(Math.round(monthlyIn))}</div></div>
  </div>
  <div class="row wrap" style="margin-bottom:12px">
    <button class="btn sm ghost" data-act="export-ics">📅 Add to Calendar</button>
    <button class="btn sm ghost" data-act="plan-recurring">↻ Plan ${esc(curPeriod().label)} from these</button>
  </div>
  ${list.map((s) => {
    const ended = isEnded(s); const d = daysBetween(today(), nextDue(s));
    return `<div class="card" style="padding:12px;${!s.active || ended ? 'opacity:.55' : ''}">
      <div class="row between"><button class="cat-name" data-act="edit-sched" data-id="${s.id}" style="padding:0"><span class="nm">${esc(s.name)}</span>${s.autoPost ? '<span class="tag">Auto</span>' : '<span class="tag z">Bill</span>'}</button>
        <span class="num" style="font-weight:800;${s.type === 'income' ? 'color:var(--ok)' : ''}">${s.type === 'income' ? '+' : ''}${money(s.amount)}</span></div>
      <div class="cat-sub" style="margin-top:4px"><span>${FREQS[s.freq]} · ${esc(catName(s.categoryId))}</span>
        <span>${!s.active ? 'Paused' : ended ? 'Ended' : `<span class="pill ${dueCls(d)}">${dueLabel(d)}</span> ${fmtDate(nextDue(s), { day: 'numeric', month: 'short' })}`}</span></div>
      ${s.active && !ended && !s.autoPost ? `<div class="row" style="margin-top:10px"><button class="btn sm soft" data-act="pay-sched" data-id="${s.id}">${s.type === 'income' ? '✓ Received' : '✓ Mark paid'}</button><button class="btn sm ghost" data-act="skip-sched" data-id="${s.id}">Skip this one</button></div>` : ''}
    </div>`;
  }).join('') || '<div class="card"><p class="empty">No bills or recurring items yet. Add rent, salary, phone, insurance, subscriptions…</p></div>'}
  <p class="hint"><b>Bill</b> = reminds you, then you tap "Mark paid" (good for amounts that vary, like electricity). <b>Auto</b> = added to your transactions automatically on the due date (good for fixed amounts like salary or rent).</p>`;
};

function schedModal(s) {
  const isNew = !s;
  s = s ? clone(s) : { id: uid(), name: '', type: 'expense', amount: 0, categoryId: '', freq: 'monthly', startDate: today(), count: 0, autoPost: false, remindDays: 1, endDate: '', notes: '', active: true };
  openModal(`${modalHead(isNew ? 'New bill / recurring item' : 'Edit recurring item')}
    <div class="seg full" style="margin-bottom:12px"><button data-type="expense" class="${s.type !== 'income' ? 'active' : ''}">Bill / expense</button><button data-type="income" class="${s.type === 'income' ? 'active' : ''}">Income</button></div>
    <label class="field"><span>Name</span><input id="s-name" value="${esc(s.name)}" placeholder="e.g. Rent, Salary, Optus, Car insurance"></label>
    <div class="grid2">
      <label class="field"><span>Amount</span><input id="s-amt" inputmode="decimal" value="${centsInput(s.amount)}" placeholder="0.00"></label>
      <label class="field"><span>How often</span><select id="s-freq">${Object.entries(FREQS).map(([k, v]) => `<option value="${k}" ${s.freq === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Next due date</span><input id="s-next" type="date" value="${nextDue(s)}"></label>
      <label class="field"><span>Ends (optional)</span><input id="s-end" type="date" value="${s.endDate || ''}"></label>
    </div>
    <label class="field"><span>Category</span><select id="s-cat">${catOptions(s.categoryId, { incomeFirst: s.type === 'income' })}</select></label>
    <div class="toggle"><div class="t-text"><b>Add automatically</b><small>On the due date, the transaction is added for you. Leave off to get a reminder and tap "Mark paid" instead.</small></div>${switchHtml('id="s-auto"', s.autoPost)}</div>
    <label class="field" style="margin-top:8px"><span>Calendar reminder</span><select id="s-remind">${[[0, 'On the day (9am)'], [1, '1 day before'], [2, '2 days before'], [3, '3 days before'], [7, '1 week before']].map(([v, l]) => `<option value="${v}" ${+s.remindDays === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${isNew ? '' : `<div class="toggle"><div class="t-text"><b>Active</b><small>Turn off to pause without deleting.</small></div>${switchHtml('id="s-active"', s.active)}</div>`}
    <div class="modal-actions">${isNew ? '' : '<button class="btn danger" id="s-del">Delete</button>'}<button class="btn" id="s-save">Save</button></div>`, {
    onMount(m) {
      $$('.seg button', m).forEach((b) => (b.onclick = () => {
        s.type = b.dataset.type; $$('.seg button', m).forEach((x) => x.classList.toggle('active', x === b));
        const sel = $('#s-cat', m); sel.innerHTML = catOptions(sel.value, { incomeFirst: s.type === 'income' });
      }));
      $('#s-save', m).onclick = async () => {
        const name = $('#s-name', m).value.trim(); const amount = toCents($('#s-amt', m).value);
        if (!name || amount <= 0) return toast('Enter a name and amount');
        const next = $('#s-next', m).value || today();
        const freq = $('#s-freq', m).value;
        if (next !== nextDue(s) || freq !== s.freq) { s.startDate = next; s.count = 0; }
        Object.assign(s, { name, amount, freq, categoryId: $('#s-cat', m).value, endDate: $('#s-end', m).value, autoPost: $('#s-auto', m).checked, remindDays: +$('#s-remind', m).value, active: $('#s-active', m) ? $('#s-active', m).checked : true });
        await saveRec('schedules', s);
        const posted = await processSchedules();
        closeModal(); toast(posted ? `Saved · ${posted} past-due entr${posted === 1 ? 'y' : 'ies'} added` : 'Saved'); rerender();
      };
      $('#s-del', m) && ($('#s-del', m).onclick = async () => {
        if (!confirm(`Delete "${s.name}"? Transactions already recorded are kept.`)) return;
        await delRec('schedules', s.id); closeModal(); rerender();
      });
    }
  });
}

function paySchedule(s) {
  const amt = s.amount;
  txModal(null, { date: today(), type: s.type, amount: amt, merchant: s.name, notes: s.notes || '', splits: [{ categoryId: s.categoryId, amount: amt }], scheduleId: s.id },
    async () => { s.count = (s.count || 0) + 1; await saveRec('schedules', s); });
}

async function planFromRecurring() {
  const p = curPeriod(); const per = new Map();
  for (const s of S.schedules) {
    if (!s.active) continue;
    for (let n = 0; n < 3000; n++) {
      const d = occurrence(s, n);
      if (d > p.end || (s.endDate && d > s.endDate)) break;
      if (d >= p.start) per.set(s.categoryId, (per.get(s.categoryId) || 0) + s.amount);
    }
  }
  per.delete('');
  if (!per.size) return toast(`No bills or recurring items fall in ${p.label}`);
  const conflicts = [...per].filter(([c, v]) => planned(p, c) && planned(p, c) !== v);
  if (conflicts.length && !confirm(`${conflicts.length} categor${conflicts.length === 1 ? 'y already has' : 'ies already have'} a different planned amount. Replace with the recurring totals?`)) return;
  for (const [c, v] of per) await setPlanned(p, c, v);
  toast(`Planned ${per.size} categor${per.size === 1 ? 'y' : 'ies'} from recurring items`); go('budget');
}

// ---------- Calendar (.ics) ----------
function buildICS() {
  const esc2 = (t) => String(t).replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const d = (x) => x.replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const alarm = (days, text) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc2(text)}`,
    `TRIGGER:${days === 0 ? 'PT9H' : `-PT${days * 24 - 9}H`}`, 'END:VALARM'];
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Amanah Budget//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Amanah Budget'];
  for (const s of S.schedules) {
    if (!s.active || isEnded(s)) continue;
    const start = nextDue(s); const day = +start.slice(8);
    let rule = { weekly: 'FREQ=WEEKLY', fortnightly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY', quarterly: 'FREQ=MONTHLY;INTERVAL=3', yearly: 'FREQ=YEARLY' }[s.freq];
    if ((s.freq === 'monthly' || s.freq === 'quarterly') && day > 28) rule += ';BYMONTHDAY=-1';
    if (s.endDate) rule += `;UNTIL=${d(s.endDate)}`;
    const title = `${s.type === 'income' ? '💰' : '🧾'} ${s.name} – ${money(s.amount)}`;
    L.push('BEGIN:VEVENT', `UID:sched-${s.id}@amanah-budget`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d(start)}`, `DTEND;VALUE=DATE:${d(addDays(start, 1))}`,
      `RRULE:${rule}`, `SUMMARY:${esc2(title)}`, `DESCRIPTION:${esc2(`${catName(s.categoryId)} · open Amanah Budget to mark it ${s.type === 'income' ? 'received' : 'paid'}`)}`,
      'TRANSP:TRANSPARENT', ...alarm(+s.remindDays || 0, title), 'END:VEVENT');
  }
  const h = hawlInfo();
  if (h.start) {
    const o = zakatOwed();
    const title = `🌙 Zakat due – Hawl complete${o.due ? ` (≈ ${money(o.due)})` : ''}`;
    L.push('BEGIN:VEVENT', `UID:zakat-${h.start}@amanah-budget`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d(h.due)}`, `DTEND;VALUE=DATE:${d(addDays(h.due, 1))}`,
      `SUMMARY:${esc2(title)}`, `DESCRIPTION:${esc2(`Hawl started ${fmtDate(h.start)}. ${hijri(h.due)}.`)}`, 'TRANSP:TRANSPARENT',
      ...alarm(7, title), ...alarm(0, title), 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

function exportICS() {
  const count = S.schedules.filter((s) => s.active && !isEnded(s)).length + (S.settings.hawlStart ? 1 : 0);
  if (!count) return toast('Add bills or set your Hawl date first');
  const ics = buildICS();
  const file = new File([ics], 'amanah-reminders.ics', { type: 'text/calendar' });
  openModal(`${modalHead('Add reminders to Calendar')}
    <p style="margin-top:0">${count} reminder${count === 1 ? '' : 's'} ready: your bills and recurring items${S.settings.hawlStart ? ', plus your Zakat due date' : ''}. Your phone's Calendar will alert you, even with no internet.</p>
    <div class="stack">
      <button class="btn block" id="ics-dl">📅 Open in Calendar</button>
      ${navigator.canShare && navigator.canShare({ files: [file] }) ? '<button class="btn block ghost" id="ics-share">Share file…</button>' : ''}
    </div>
    <p class="hint">iPhone: if "Open in Calendar" doesn't offer "Add All", use Share file → Save to Files, then tap the file in the Files app. After changing bills, export again — events update rather than duplicate in most calendars.</p>`, {
    onMount(m) {
      $('#ics-dl', m).onclick = () => { download('amanah-reminders.ics', ics, 'text/calendar'); };
      $('#ics-share', m) && ($('#ics-share', m).onclick = () => navigator.share({ files: [file], title: 'Amanah Budget reminders' }).catch(() => {}));
    }
  });
}

// ---------- Debt payoff planner ----------
function debtCurrent(d) {
  if (!d.categoryId) return d.balance;
  let paid = 0;
  for (const t of S.transactions) {
    if (t.type === 'income' || t.date < (d.asOf || '0000')) continue;
    for (const sp of t.splits) if (sp.categoryId === d.categoryId) paid += sp.amount;
  }
  return Math.max(0, d.balance - paid);
}

function simulateDebts(strategy, extra) {
  const ds = S.debts.map((d) => ({ id: d.id, name: d.name, bal: debtCurrent(d), min: d.minPayment || 0, rate: (d.rate || 0) / 1200, month: null })).filter((d) => d.bal > 0);
  if (!ds.length) return null;
  const order = [...ds].sort(strategy === 'avalanche' ? (a, b) => b.rate - a.rate || a.bal - b.bal : (a, b) => a.bal - b.bal);
  const budget = ds.reduce((s, d) => s + d.min, 0) + extra;
  let m = 0, interest = 0;
  while (ds.some((d) => d.bal > 0) && m < 600) {
    m++;
    for (const d of ds) if (d.bal > 0) { const i = Math.round(d.bal * d.rate); d.bal += i; interest += i; }
    let pool = budget;
    for (const d of order) if (d.bal > 0) { const pay = Math.min(d.min, d.bal, pool); d.bal -= pay; pool -= pay; }
    for (const d of order) if (d.bal > 0 && pool > 0) { const pay = Math.min(d.bal, pool); d.bal -= pay; pool -= pay; }
    for (const d of ds) if (d.bal <= 0 && d.month === null) d.month = m;
  }
  return { stuck: m >= 600, months: m, interest, order, date: addMonths(today(), m) };
}

function debtHtml() {
  const st = S.settings; const strategy = st.debtStrategy || 'snowball'; const extra = st.debtExtra || 0;
  const total = S.debts.reduce((s, d) => s + debtCurrent(d), 0);
  const plan = simulateDebts(strategy, extra);
  const base = extra ? simulateDebts(strategy, 0) : null;
  return `
  <div class="row between" style="margin:22px 0 10px"><h2>Debt payoff</h2><button class="btn sm soft" data-act="add-debt">+ Add debt</button></div>
  <div class="card">
    ${S.debts.length ? S.debts.map((d) => `<button class="pay-item" data-act="edit-debt" data-id="${d.id}">
      <span><b>${esc(d.name)}</b><small>Min ${money(d.minPayment)}/mo · ${d.rate ? d.rate + '% p.a.' : 'interest-free'}${d.categoryId ? ' · tracks ' + esc(catName(d.categoryId)) : ''}</small></span>
      <span class="num" style="font-weight:700;color:var(--over)">${money(debtCurrent(d))}</span></button>`).join('') + `<div class="zk-line total"><span>Total owed</span><span>${money(total)}</span></div>`
      : '<p class="empty">No debts added. Add credit cards, car loans, family loans or any other money you owe to plan your way to debt-free.</p>'}
  </div>
  ${plan ? `<div class="card">
    <div class="seg full" style="margin-bottom:12px">
      <button data-act="debt-strategy" data-v="snowball" class="${strategy === 'snowball' ? 'active' : ''}">Snowball (smallest first)</button>
      <button data-act="debt-strategy" data-v="avalanche" class="${strategy === 'avalanche' ? 'active' : ''}">Avalanche (highest rate first)</button>
    </div>
    <label class="field"><span>Extra I can pay each month (on top of minimums)</span><input inputmode="decimal" value="${centsInput(extra)}" placeholder="0.00" data-change="debt-extra"></label>
    ${plan.stuck ? '<p class="hint" style="color:var(--over)">At these payments the debts never get paid off (interest grows faster). Increase the minimums or the extra amount.</p>' : `
    <div class="grid3">
      <div class="stat"><div class="lbl">Debt-free by</div><div class="val">${fmtDate(plan.date, { month: 'short', year: 'numeric' })}</div></div>
      <div class="stat"><div class="lbl">Months</div><div class="val">${plan.months}</div></div>
      <div class="stat"><div class="lbl">Interest paid</div><div class="val">${money(plan.interest)}</div></div>
    </div>
    ${base && !base.stuck ? `<p class="hint">With the extra ${money(extra)}/month you're debt-free <b>${base.months - plan.months} months sooner</b>${base.interest - plan.interest > 0 ? ` and save <b>${money(base.interest - plan.interest)}</b> in interest` : ''}.</p>` : ''}
    <h3 style="margin:12px 0 4px">Payoff order</h3>
    ${plan.order.map((d, i) => `<div class="zk-line"><span>${i + 1}. ${esc(d.name)}</span><span>${fmtDate(addMonths(today(), d.month), { month: 'short', year: 'numeric' })}</span></div>`).join('')}`}
    <p class="hint">Once a debt is cleared, its payment rolls onto the next one. That's the snowball. Link a debt to a budget category and payments you record there reduce its balance automatically.</p>
  </div>` : ''}`;
}

function debtModal(d) {
  const isNew = !d;
  d = d ? clone(d) : { id: uid(), name: '', balance: 0, asOf: today(), minPayment: 0, rate: 0, categoryId: '' };
  const debtGroup = S.groups.find((g) => /debt/i.test(g.name));
  openModal(`${modalHead(isNew ? 'Add a debt' : 'Edit debt')}
    <label class="field"><span>Name</span><input id="d-name" value="${esc(d.name)}" placeholder="e.g. Credit card, Car loan, Loan from brother"></label>
    <div class="grid2">
      <label class="field"><span>Balance owed</span><input id="d-bal" inputmode="decimal" value="${centsInput(d.balance)}" placeholder="0.00"></label>
      <label class="field"><span>As at</span><input id="d-asof" type="date" value="${d.asOf || today()}"></label>
      <label class="field"><span>Minimum monthly payment</span><input id="d-min" inputmode="decimal" value="${centsInput(d.minPayment)}" placeholder="0.00"></label>
      <label class="field"><span>Interest % p.a. (0 if interest-free)</span><input id="d-rate" inputmode="decimal" value="${d.rate || ''}" placeholder="0"></label>
    </div>
    <label class="field"><span>Payments are budgeted in (optional)</span><select id="d-cat"><option value="">Not linked — I'll update the balance myself</option>${catOptions(d.categoryId || (isNew ? '' : ''), { includeIncome: false, includeNone: false })}</select></label>
    ${debtGroup && isNew ? `<p class="hint" style="margin-top:-4px">Tip: add a category for this debt in "${esc(debtGroup.name)}" and link it here.</p>` : ''}
    <div class="modal-actions">${isNew ? '' : '<button class="btn danger" id="d-del">Delete</button>'}<button class="btn" id="d-save">Save</button></div>`, {
    onMount(m) {
      if (!d.categoryId) $('#d-cat', m).value = '';
      $('#d-save', m).onclick = async () => {
        const name = $('#d-name', m).value.trim(); const bal = Math.abs(toCents($('#d-bal', m).value));
        if (!name) return toast('Enter a name');
        Object.assign(d, { name, balance: bal, asOf: $('#d-asof', m).value || today(), minPayment: Math.abs(toCents($('#d-min', m).value)), rate: Math.max(0, parseFloat($('#d-rate', m).value) || 0), categoryId: $('#d-cat', m).value });
        await saveRec('debts', d); closeModal(); rerender();
      };
      $('#d-del', m) && ($('#d-del', m).onclick = async () => { if (!confirm(`Delete "${d.name}"?`)) return; await delRec('debts', d.id); closeModal(); rerender(); });
    }
  });
}

// ---------- Encrypted backup (AES-256-GCM, key from passphrase via PBKDF2) ----------
const PBKDF2_ITER = 310000;
function b64enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function b64dec(str) { const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptBackup(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, PBKDF2_ITER);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { app: 'amanah-budget', encrypted: true, v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, cipher: 'AES-256-GCM', exported: new Date().toISOString(), salt: b64enc(salt), iv: b64enc(iv), data: b64enc(new Uint8Array(ct)) };
}
async function decryptBackup(p, pass) {
  const key = await deriveKey(pass, b64dec(p.salt), p.iter || PBKDF2_ITER);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(p.iv) }, key, b64dec(p.data));
  return JSON.parse(new TextDecoder().decode(pt));
}

function encBackupModal() {
  if (!(self.crypto && crypto.subtle)) return alert('Encrypted backup needs a secure (https) connection. Open the app from its https address.');
  openModal(`${modalHead('Encrypted backup')}
    <p style="margin-top:0">Your budget is locked with a passphrase on this phone <b>before</b> it's saved, so the file is unreadable in iCloud Drive, Google Drive or email without it.</p>
    <label class="field"><span>Passphrase (at least 8 characters)</span><input id="e-p1" type="password" autocomplete="new-password"></label>
    <label class="field"><span>Repeat passphrase</span><input id="e-p2" type="password" autocomplete="new-password"></label>
    <p class="hint" style="margin-top:-4px">⚠️ Write it down somewhere safe. If it's forgotten, the backup can't be opened by anyone, including you.</p>
    <div id="e-out"></div>
    <div class="modal-actions" id="e-act"><button class="btn" id="e-go">🔒 Encrypt backup</button></div>`, {
    onMount(m) {
      $('#e-go', m).onclick = async () => {
        const p1 = $('#e-p1', m).value, p2 = $('#e-p2', m).value;
        if (p1.length < 8) return toast('Use at least 8 characters');
        if (p1 !== p2) return toast("Passphrases don't match");
        $('#e-go', m).disabled = true; $('#e-go', m).textContent = 'Encrypting…';
        const data = await DB.dumpAll();
        const enc = await encryptBackup({ app: 'amanah-budget', version: 1, appVersion: APP_VERSION, exported: new Date().toISOString(), data }, p1);
        const text = JSON.stringify(enc); const name = `amanah-backup-${today()}.amanah.json`;
        const file = new File([text], name, { type: 'application/json' });
        S.settings.lastBackup = today(); await saveSettings();
        $('#e-act', m).innerHTML = '';
        const canShare = navigator.canShare && navigator.canShare({ files: [file] });
        $('#e-out', m).innerHTML = `<div class="notice ok">✓ Encrypted (${Math.round(text.length / 1024)} KB). Now save it:</div>
          <div class="stack">${canShare ? '<button class="btn block" id="e-share">Save to iCloud Drive / Google Drive…</button>' : ''}
          <button class="btn block ${canShare ? 'ghost' : ''}" id="e-dl">⬇ Download file</button></div>
          <p class="hint">In the share sheet choose <b>Save to Files → iCloud Drive</b> (iPhone) or <b>Drive</b> (Android). To restore: Settings → Restore from backup, pick the file and enter the passphrase.</p>`;
        $('#e-share', m) && ($('#e-share', m).onclick = () => navigator.share({ files: [file], title: 'Amanah Budget backup' }).then(() => toast('Backup saved')).catch(() => {}));
        $('#e-dl', m).onclick = () => { download(name, text); toast('Backup downloaded'); };
        rerender();
      };
    }
  });
}

Object.assign(ACTIONS, {
  'go-bills': () => go('bills'),
  'go-budget': () => go('budget'),
  'go-zakat': () => go('zakat'),
  'add-sched': () => schedModal(null),
  'edit-sched': (el) => schedModal(S.schedules.find((s) => s.id === el.dataset.id)),
  'pay-sched': (el) => paySchedule(S.schedules.find((s) => s.id === el.dataset.id)),
  'skip-sched': async (el) => {
    const s = S.schedules.find((x) => x.id === el.dataset.id);
    if (!confirm(`Skip the ${fmtDate(nextDue(s))} "${s.name}"? Nothing will be recorded for it.`)) return;
    s.count = (s.count || 0) + 1; await saveRec('schedules', s); rerender();
  },
  'plan-recurring': planFromRecurring,
  'export-ics': exportICS,
  'add-debt': () => debtModal(null),
  'edit-debt': (el) => debtModal(S.debts.find((d) => d.id === el.dataset.id)),
  'debt-strategy': async (el) => { S.settings.debtStrategy = el.dataset.v; await saveSettings(); rerender(); },
  'backup-enc': encBackupModal
});
Object.assign(CHANGES, {
  'debt-extra': async (el) => { S.settings.debtExtra = Math.abs(toCents(el.value)); await saveSettings(); rerender(); }
});

function bindGlobal() {
  const view = $('#view');
  view.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const fn = ACTIONS[el.dataset.act]; if (fn) { e.preventDefault(); fn(el, e); }
  });
  view.addEventListener('change', (e) => { const fn = CHANGES[e.target.dataset.change]; if (fn) fn(e.target, e); });
  view.addEventListener('input', (e) => { const fn = INPUTS[e.target.dataset.input]; if (fn) fn(e.target, e); });
  view.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input.amt')) e.target.blur(); });
  // Select amount text on focus for quick editing
  view.addEventListener('focusin', (e) => { if (e.target.matches('input.amt')) setTimeout(() => e.target.select(), 0); });
  view.addEventListener('focusout', (e) => {
    if (e.target.matches('input.amt')) { const c = toCents(e.target.value); e.target.value = centsInput(c); }
  });
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  $('#settingsBtn').onclick = () => go('settings');
  $('#themeBtn').onclick = async () => {
    const curDark = document.documentElement.dataset.theme === 'dark';
    S.settings.theme = curDark ? 'light' : 'dark'; await saveSettings(); applyTheme(); if (S.tab === 'settings') rerender();
  };
  $('#fab').onclick = () => txModal(null);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => S.settings.theme === 'system' && applyTheme());
}

// ====================================================================
// Boot
// ====================================================================
async function main() {
  try {
    await DB.openDB();
    await loadAll();
  } catch (e) {
    $('#view').innerHTML = `<div class="card"><h3>Storage unavailable</h3><p>This browser blocked local storage (private browsing mode can do this). ${esc(e.message || e)}</p></div>`;
    return;
  }
  applyTheme();
  bindGlobal();
  const posted = await processSchedules();
  render();
  if (posted) toast(`${posted} recurring transaction${posted === 1 ? '' : 's'} added`);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && await processSchedules()) rerender();
  });
  snapshot();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  }
}
main();

// Expose for debugging in the console
window.__amanah = { S, periodFor, zakatCalc, fundBalance, simulateDebts, buildICS, encryptBackup, decryptBackup };
