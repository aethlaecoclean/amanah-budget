// Tiny dependency-free SVG/HTML charts.
import { esc, money, moneyShort, fmtDate, parseISO } from './utils.js';

export const PALETTE = ['#0f766e', '#2563eb', '#d97706', '#9333ea', '#e11d48', '#0891b2', '#65a30d', '#db2777', '#4f46e5', '#ea580c', '#059669', '#7c3aed'];

export function donut(items, { size = 180, thickness = 26, center = '', sub = '' } = {}) {
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  const r = (size - thickness) / 2, c = size / 2, C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = total > 0 ? items.map((it, idx) => {
    const len = (Math.max(0, it.value) / total) * C;
    const color = it.color || PALETTE[idx % PALETTE.length];
    const seg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${c} ${c})"><title>${esc(it.label)}: ${money(it.value)}</title></circle>`;
    offset += len;
    return seg;
  }).join('') : '';
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${thickness}"/>
    ${arcs}
    <text x="${c}" y="${c - 2}" text-anchor="middle" class="donut-center">${esc(center)}</text>
    <text x="${c}" y="${c + 16}" text-anchor="middle" class="donut-sub">${esc(sub)}</text>
  </svg>`;
}

export function legend(items) {
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0) || 1;
  return `<ul class="legend">${items.map((it, idx) => `
    <li><span class="sw" style="background:${it.color || PALETTE[idx % PALETTE.length]}"></span>
    <span class="lg-label">${esc(it.label)}</span>
    <span class="lg-val">${money(it.value)} <small>${Math.round((Math.max(0, it.value) / total) * 100)}%</small></span></li>`).join('')}</ul>`;
}

// rows: [{label, planned, actual}]
export function plannedVsActual(rows) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.planned, r.actual]));
  return `<div class="pva">${rows.map((r) => `
    <div class="pva-row">
      <div class="pva-label"><span>${esc(r.label)}</span><small>${money(r.actual)} / ${money(r.planned)}</small></div>
      <div class="pva-bars">
        <div class="pva-bar planned" style="width:${(r.planned / max) * 100}%"></div>
        <div class="pva-bar actual ${r.actual > r.planned ? 'over' : ''}" style="width:${(r.actual / max) * 100}%"></div>
      </div>
    </div>`).join('')}
    <div class="pva-key"><span><i class="planned"></i>Planned</span><span><i class="actual"></i>Actual</span><span><i class="over"></i>Over plan</span></div>
  </div>`;
}

// series: [{name, color, points:[{x:'yyyy-mm-dd', y:cents}]}]
export function lineChart(series, { height = 220 } = {}) {
  const W = 640, H = height, P = { l: 56, r: 14, t: 14, b: 30 };
  const pts = series.flatMap((s) => s.points);
  if (new Set(pts.map((p) => p.x)).size < 2) return `<p class="empty">Not enough history yet — a snapshot is saved each day you use the app.</p>`;
  const xs = pts.map((p) => parseISO(p.x).getTime());
  const ys = pts.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 === x0) x1 = x0 + 86400000;
  let y0 = Math.min(0, ...ys), y1 = Math.max(...ys); if (y1 === y0) y1 = y0 + 100;
  const X = (t) => P.l + ((t - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = (v) => H - P.b - ((v - y0) / (y1 - y0)) * (H - P.t - P.b);
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4, y = Y(v);
    grid += `<line x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" class="grid"/><text x="${P.l - 6}" y="${y + 4}" text-anchor="end" class="axis">${moneyShort(v)}</text>`;
  }
  const paths = series.map((s) => {
    if (!s.points.length) return '';
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(parseISO(p.x).getTime()).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const first = new Date(x0), last = new Date(x1);
  const lbl = (d) => fmtDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, { day: 'numeric', month: 'short', year: '2-digit' });
  return `<svg class="linechart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
    ${grid}${paths}
    <text x="${P.l}" y="${H - 8}" class="axis">${lbl(first)}</text>
    <text x="${W - P.r}" y="${H - 8}" text-anchor="end" class="axis">${lbl(last)}</text>
  </svg>
  <div class="pva-key">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}
