#!/usr/bin/env node
// สร้าง gantt-actual.png และ compare.png ใหม่ให้รวมผลหลัง resume
//
// ทำไมต้องมี: `dag-planner report` ถูกสั่งหลังการรันรอบแรกเท่านั้น (B11 ล้ม · B12 ถูกบล็อก) และ state ของ run
// ใน container ไม่ได้ถูกเก็บออกมา จึงสั่ง report ซ้ำหลัง resume ไม่ได้ สคริปต์นี้อ่านข้อมูลจริงจาก
//   run.log · run-resume.log  (ลำดับเหตุการณ์ ▶ ✔ ✘ + เวลาที่ใช้ของแต่ละงาน + บัญชี + tokens)
//   PLAN.md                    (เวลาตามแผนและสายวิกฤต)
//   blocks.json                (สกิลของแต่ละบล็อก)
// แล้ววาดภาพในรูปแบบเดียวกับภาพเดิม · ไม่มีตัวเลขใดพิมพ์มือ
//
// เวลาเริ่มของแต่ละงานไม่มีใน log โดยตรง → คิดจากลำดับเหตุการณ์: งานเริ่ม (▶) ณ เวลาที่เหตุการณ์จบ (✔/✘) ก่อนหน้าเกิด
// ตรวจกับภาพเดิมของรอบแรก (gantt-actual-run1.png) แล้วตำแหน่งแท่งตรงกัน · คลาดเคลื่อนได้ราว 10 วินาทีต่อการส่งต่องาน
//
// ใช้: cd app/e2e && npm ci && npx playwright install chromium && cd ../.. && node tools/regen-actual-charts.js
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ───────────── อ่านแผน ─────────────
const blocks = JSON.parse(read('blocks.json')).blocks;
const skillOf = Object.fromEntries(blocks.map((b) => [b.id, b.skill]));
const titleOf = Object.fromEntries(blocks.map((b) => [b.id, b.title]));
const plan = {}; // B01 → { p0, p1, crit, accounts }
for (const line of read('PLAN.md').split('\n')) {
  const m = line.match(/^\| (B\d+)( 🔶)? \| [^|]+ \| \w+ \| \w+ \| [\d.]+ \| ([^|]+) \| ([\d.]+)–([\d.]+) \|/);
  if (m) plan[m[1]] = { crit: !!m[2], accounts: m[3].trim(), p0: Number(m[4]), p1: Number(m[5]) };
}
const ids = blocks.map((b) => b.id);
for (const id of ids) if (!plan[id]) throw new Error(`ไม่พบ ${id} ในตารางของ PLAN.md`);

// ───────────── อ่าน log → ช่วงเวลาจริงของแต่ละงาน ─────────────
function parseLog(file) {
  const segs = [], started = {}; let clock = 0, runId = null;
  for (const line of read(file).split('\n')) {
    const rid = line.match(/(?:run|resume) (\S+-\d{4}-\d{6})/); if (rid && !runId) runId = rid[1];
    const s = line.match(/^▶ (B\d+)(?:#(\w+))? → (\S+) \(([^)]*)\)/);
    if (s) { started[s[1] + '#' + (s[2] || '')] = { start: clock, model: s[4] }; continue; }
    const e = line.match(/^([✔✘]) (B\d+)(?:#(\w+))? ← (\S+) ([\d.]+)s in=(\d+) out=(\d+)\s*(?:\((.*)\))?/);
    if (!e) continue;
    const st = started[e[2] + '#' + (e[3] || '')]; if (!st) throw new Error(`${file}: จบงาน ${e[2]} โดยไม่มีบรรทัดเริ่ม`);
    const dur = Number(e[5]), end = st.start + dur;
    if (end < clock - 1e-6) throw new Error(`${file}: ลำดับเวลาไม่สอดคล้องที่ ${e[2]} (จบ ${end} ก่อนเหตุการณ์ก่อนหน้า ${clock})`);
    segs.push({ block: e[2], role: /^r\d+$/.test(e[3] || '') ? 'reviewer' : 'worker', account: e[4], model: st.model, start: st.start, end, dur,
      tin: Number(e[6]), tout: Number(e[7]), ok: e[1] === '✔', note: e[8] || '' });
    clock = end;
  }
  return { segs, total: clock, runId };
}
const run1 = parseLog('run.log'), run2 = parseLog('run-resume.log');
const T1 = run1.total / 60, T2 = run2.total / 60; // นาทีของรอบแรก / resume
const hms = (run1.runId || '').match(/-(\d{2})(\d{2})(\d{2})$/); // run id ลงท้ายด้วยเวลาเริ่ม HHMMSS
const t0sec = hms ? Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) : null;
const clockStr = (sec) => { const s = Math.round(sec); const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; };
// เวลาเริ่ม resume: log บอกว่าใช้ผลตรวจความพร้อมจาก cache "@15:52:5x" → resume เริ่มหลังเวลานั้นทันที (ประมาณ)
const cache = [...read('run-resume.log').matchAll(/@(\d{2}):(\d{2}):(\d{2})/g)].map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
const r0sec = cache.length ? Math.max(...cache) : null;
const gapMin = t0sec != null && r0sec != null ? (r0sec - (t0sec + run1.total)) / 60 : null;

// แท่งทั้งหมด: นาทีของรอบแรก และนาทีนับจากเริ่ม resume
const bars = [
  ...run1.segs.map((s) => ({ ...s, run: 1, m0: s.start / 60, m1: s.end / 60 })),
  ...run2.segs.map((s) => ({ ...s, run: 2, m0: s.start / 60, m1: s.end / 60 })),
];
// ตารางสรุปต่อบล็อก (สถานะสุดท้ายหลัง resume)
const table = ids.map((id) => {
  const all = bars.filter((b) => b.block === id), last = Math.max(0, ...all.map((b) => b.run));
  const fin = all.filter((b) => b.run === last);
  const status = !all.length ? 'not-run' : fin.every((b) => b.ok) ? 'ok' : 'failed';
  const a0 = fin.length ? Math.min(...fin.map((b) => b.m0)) : null, a1 = fin.length ? Math.max(...fin.map((b) => b.m1)) : null;
  return { id, title: titleOf[id], skill: skillOf[id], planAcc: plan[id].accounts, planMin: +(plan[id].p1 - plan[id].p0).toFixed(1),
    realAcc: [...new Set(all.map((b) => b.account + (b.ok ? '' : b.run === last && status === 'failed' ? ' (หมดเวลา)' : ' (ล้ม)')))].join(', '),
    realMin: a0 == null ? null : +(a1 - a0).toFixed(2), run: last, status, tin: all.reduce((n, b) => n + b.tin, 0), tout: all.reduce((n, b) => n + b.tout, 0),
    note: fin.filter((b) => !b.ok).map((b) => b.note).join('; ') };
});

// ───────────── วาด SVG ─────────────
const COL = { yolo: '#3d6db5', cyolo: '#2f9e5b', review: '#1a968f', image: '#8e5bbf', debate: '#c2417a', best_of: '#a67c00' };
const ORANGE = '#f08000', RED = '#c92a2a', GRAY = '#9aa5b1';
const FONT = "Sarabun, 'Noto Sans Thai', 'Leelawadee UI', Tahoma, 'Segoe UI', sans-serif";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const txt = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 13}" fill="${o.fill || '#333'}"${o.bold ? ' font-weight="700"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(s)}</text>`;
const openSvg = (W, H, title, sub) => [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
  `<rect width="${W}" height="${H}" fill="#fff"/>`, txt(30, 34, title, { size: 22, bold: true, fill: '#1a1a1a' }), txt(30, 56, sub, { size: 13, fill: '#555' })];
const runLabel = (n) => (n === 1 ? `รอบแรก · เริ่ม ${t0sec != null ? clockStr(t0sec) : '?'} · ${T1.toFixed(1)} นาที` : `resume · เริ่ม ≈ ${r0sec != null ? clockStr(Math.round(r0sec / 60) * 60).slice(0, 5) : '?'} · ${T2.toFixed(1)} นาที`);
const gapLabel = gapMin != null ? `หยุด ≈ ${Math.floor(gapMin / 60)} ชม. ${Math.round(gapMin % 60)} นาที` : 'หยุดระหว่างรอบ';
const runId = run1.runId || 'egov-eservice';
const nOk = table.filter((t) => t.status === 'ok').length, failed = table.filter((t) => t.status !== 'ok');
const footer = `run ${runId} · สถานะหลัง resume: ok=${nOk}, failed=${failed.length}${failed.length ? ` (${failed.map((t) => `${t.id} ${t.note.replace(/^timeout: /, '')}`).join(', ')})` : ''}`;
const provenance = 'สร้างใหม่จาก run.log + run-resume.log ด้วย tools/regen-actual-charts.js (ไม่ใช่ผลของ dag-planner report) · ภาพเดิมของรอบแรก: *-run1.png';

function gantt() {
  const W = 1180, X0 = 120, XR = 40, GAP = 96, Y0 = 96, LANE = 38;
  const sc = (W - X0 - XR - GAP) / (T1 + T2);
  const xOf = (b, m) => X0 + (b.run === 1 ? m * sc : T1 * sc + GAP + m * sc);
  const accounts = ['yolo1', 'yolo2', 'cyolo1', 'cyolo2'].filter((a) => bars.some((b) => b.account === a));
  // แตกเลนของแต่ละบัญชีเมื่อเวลาทับกัน
  const rows = []; // { account, lanes: [[bar…]] }
  for (const a of accounts) {
    const lanes = [];
    for (const b of bars.filter((x) => x.account === a).sort((p, q) => xOf(p, p.m0) - xOf(q, q.m0) || p.block.localeCompare(q.block))) {
      let lane = lanes.find((l) => xOf(l[l.length - 1], l[l.length - 1].m1) <= xOf(b, b.m0) + 0.5);
      if (!lane) { lane = []; lanes.push(lane); }
      lane.push(b);
    }
    rows.push({ account: a, lanes });
  }
  const nl = rows.reduce((n, r) => n + r.lanes.length, 0), plotH = nl * LANE + rows.length * 12;
  const H = Y0 + plotH + 190;
  const S = openSvg(W, H, 'egov-eservice · Gantt จริง (รวม resume)', 'เวลาเริ่ม–จบคิดจากลำดับเหตุการณ์และเวลาที่ใช้ใน run.log + run-resume.log · บัญชีจริง · แกนเวลาตัดช่วงหยุดระหว่างรอบออก');
  // หัวของแต่ละช่วง + เส้นเวลา
  const xGap = X0 + T1 * sc;
  S.push(txt(X0, Y0 - 24, runLabel(1), { size: 13, bold: true, fill: '#1e3a5f' }), txt(xGap + GAP, Y0 - 24, runLabel(2), { size: 13, bold: true, fill: '#1e3a5f' }));
  for (let m = 0; m <= T1; m += 5) S.push(`<line x1="${X0 + m * sc}" y1="${Y0 - 6}" x2="${X0 + m * sc}" y2="${Y0 + plotH}" stroke="#e6e8eb"/>`, txt(X0 + m * sc, Y0 - 9, m, { size: 11, fill: '#667', anchor: 'middle' }));
  for (let m = 0; m <= T2; m += 5) S.push(`<line x1="${xGap + GAP + m * sc}" y1="${Y0 - 6}" x2="${xGap + GAP + m * sc}" y2="${Y0 + plotH}" stroke="#e6e8eb"/>`, txt(xGap + GAP + m * sc, Y0 - 9, `+${m}`, { size: 11, fill: '#667', anchor: 'middle' }));
  // แถบช่วงหยุด
  S.push(`<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#f1f3f5"/><line x1="0" y1="0" x2="0" y2="8" stroke="#ced4da" stroke-width="3"/></pattern></defs>`,
    `<rect x="${xGap + 8}" y="${Y0 - 6}" width="${GAP - 16}" height="${plotH + 6}" fill="url(#hatch)"/>`,
    `<text transform="translate(${xGap + GAP / 2 + 5},${Y0 + plotH / 2}) rotate(-90)" font-size="13" fill="#495057" font-weight="700" text-anchor="middle">${esc(gapLabel)}</text>`);
  // แถวบัญชี + แท่ง
  let y = Y0; const pos = [];
  rows.forEach((r, k) => {
    const h = r.lanes.length * LANE + 12;
    S.push(`<rect x="30" y="${y}" width="${X0 - 34}" height="${h}" fill="${k % 2 ? '#fff' : '#f7f8fa'}"/>`, `<rect x="${X0}" y="${y}" width="${T1 * sc}" height="${h}" fill="${k % 2 ? '#fff' : '#f7f8fa'}" fill-opacity="0.6"/>`,
      `<rect x="${xGap + GAP}" y="${y}" width="${T2 * sc}" height="${h}" fill="${k % 2 ? '#fff' : '#f7f8fa'}" fill-opacity="0.6"/>`,
      txt(40, y + h / 2 + (r.lanes.length > 1 ? -2 : 5), r.account, { size: 15, bold: true, fill: '#1a1a1a' }));
    if (r.lanes.length > 1) S.push(txt(40, y + h / 2 + 13, `พร้อมกัน ${r.lanes.length} เลน`, { size: 10, fill: '#667' }));
    r.lanes.forEach((lane, li) => lane.forEach((b) => {
      const x = xOf(b, b.m0), w = Math.max(6, (b.m1 - b.m0) * sc - 2), by = y + 6 + li * LANE + 4, bh = LANE - 8;
      const crit = plan[b.block].crit, zero = b.dur < 1;
      const stroke = !b.ok ? `stroke="${RED}" stroke-width="2.5" stroke-dasharray="5 3"` : crit ? `stroke="${ORANGE}" stroke-width="3"` : 'stroke="none"';
      S.push(`<rect x="${x}" y="${by}" width="${w}" height="${bh}" rx="5" fill="${zero ? '#fff' : COL[skillOf[b.block]]}" ${stroke}/>`);
      const lab = zero && !b.ok ? `${b.block} ล้ม` : `${b.block}${b.role === 'reviewer' ? ' ตรวจ' : ' ทำ'}${b.ok ? '' : ' · หมดเวลา 1500s'}`;
      if (w > lab.length * 8) S.push(txt(x + 8, by + bh / 2 + 4, lab, { size: 12, bold: true, fill: '#fff' }));
      else if (w > 44 && b.ok) S.push(txt(x + 6, by + bh / 2 + 4, b.block, { size: 12, bold: true, fill: '#fff' }));
      else S.push(txt(x + w + 5, by + bh / 2 + 4, lab, { size: 11, fill: b.ok ? '#333' : RED }));
      pos.push({ b, x, w, cy: by + bh / 2 });
    }));
    y += h;
  });
  // เส้นประเชื่อมบล็อกเดียวกันที่ใช้หลายบัญชี (ผู้ทำ → ผู้ตรวจ)
  for (const id of ids) {
    const w = pos.find((p) => p.b.block === id && p.b.role === 'worker' && p.b.ok), r = pos.find((p) => p.b.block === id && p.b.role === 'reviewer');
    if (w && r) S.push(`<line x1="${r.x}" y1="${Math.min(w.cy, r.cy)}" x2="${r.x}" y2="${Math.max(w.cy, r.cy)}" stroke="#222" stroke-width="1.6" stroke-dasharray="2 4"/>`);
  }
  // คำอธิบาย
  let ly = Y0 + plotH + 34, lx = 30;
  const item = (draw, label, wd) => { S.push(draw(lx, ly), txt(lx + 34, ly + 4, label, { size: 12 })); lx += wd; };
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="16" rx="4" fill="${COL.yolo}"/>`, 'yolo · Claude เขียนโค้ด/เอกสาร', 270);
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="16" rx="4" fill="${COL.cyolo}"/>`, 'cyolo · Codex เขียนโค้ด/ข้อมูล', 270);
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="16" rx="4" fill="${COL.review}"/>`, 'review · ผู้ทำ + ผู้ตรวจ คนละ CLI', 290);
  lx = 30; ly += 26;
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="16" rx="4" fill="#fff" stroke="${ORANGE}" stroke-width="3"/>`, 'กรอบส้ม = สายวิกฤตตามแผน', 270);
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="16" rx="4" fill="#fff" stroke="${RED}" stroke-width="2.5" stroke-dasharray="5 3"/>`, 'กรอบแดงประ = ล้ม/หมดเวลา', 270);
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="16" fill="url(#hatch)"/>`, 'แถบลาย = ช่วงหยุดระหว่างรอบแรกกับ resume (ตัดออกจากแกน)', 400);
  lx = 30; ly += 26;
  item((x, yy) => `<line x1="${x}" y1="${yy - 1}" x2="${x + 24}" y2="${yy - 1}" stroke="#222" stroke-width="1.6" stroke-dasharray="2 4"/>`, 'เส้นประแนวตั้ง = บล็อกใช้หลายบัญชี (ผู้ทำ → ผู้ตรวจ)', 400);
  S.push(txt(30, ly + 34, footer, { size: 12, fill: '#444' }), txt(30, ly + 54, provenance, { size: 11, fill: '#777' }), '</svg>');
  return { svg: S.join('\n'), W, H };
}

function compare() {
  const W = 1180, X0 = 110, XR = 40, Y0 = 92, RH = 46;
  const act = (b) => (b.run === 1 ? [b.m0, b.m1] : [T1 + b.m0, T1 + b.m1]); // เวลาจริงสะสม (ตัดช่วงหยุดออก)
  const span = Math.max(...ids.map((i) => plan[i].p1), T1 + T2), top = Math.ceil(span / 10) * 10, sc = (W - X0 - XR) / top;
  const H = Y0 + ids.length * RH + 150;
  const S = openSvg(W, H, 'egov-eservice · แผน vs จริง (รวม resume)', 'แท่งบน = แผน · แท่งล่าง = จริง (นาที) · เวลาจริงหลัง resume ต่อท้ายรอบแรกโดยตัดช่วงหยุดระหว่างรอบออก');
  for (let m = 0; m <= top; m += 10) S.push(`<line x1="${X0 + m * sc}" y1="${Y0 - 4}" x2="${X0 + m * sc}" y2="${Y0 + ids.length * RH}" stroke="#e6e8eb"/>`, txt(X0 + m * sc, Y0 - 9, m, { size: 11, fill: '#667', anchor: 'middle' }));
  const xr = X0 + T1 * sc; // จุดเริ่ม resume บนแกนสะสม
  ids.forEach((id, k) => {
    const y = Y0 + k * RH, p = plan[id], col = COL[skillOf[id]];
    S.push(`<rect x="30" y="${y}" width="${W - 60}" height="${RH}" fill="${k % 2 ? '#fff' : '#f7f8fa'}"/>`, txt(40, y + 20, id, { size: 14, bold: true, fill: '#1a1a1a' }), txt(40, y + 35, skillOf[id], { size: 11, fill: '#556' }));
    S.push(`<rect x="${X0 + p.p0 * sc}" y="${y + 6}" width="${Math.max(6, (p.p1 - p.p0) * sc)}" height="13" rx="4" fill="${GRAY}" ${p.crit ? `stroke="${ORANGE}" stroke-width="2.5"` : ''}/>`);
    const mine = bars.filter((b) => b.block === id);
    for (const b of mine) {
      const [a0, a1] = act(b), w = Math.max(5, (a1 - a0) * sc), zero = b.dur < 1;
      S.push(`<rect x="${X0 + a0 * sc - (zero ? 9 : 0)}" y="${y + 25}" width="${zero ? 6 : w}" height="14" rx="${zero ? 2 : 4}" fill="${zero ? '#fff' : col}" ${b.ok ? '' : `stroke="${RED}" stroke-width="2.2" stroke-dasharray="${zero ? '3 2' : '5 3'}"`}/>`);
    }
    const lastEnd = mine.length ? Math.max(...mine.map((b) => act(b)[1])) : null, row = table.find((t) => t.id === id);
    const note = !mine.length ? 'ไม่ได้รัน' : `${row.realMin.toFixed(1)} นาที${row.status === 'ok' ? (row.run === 2 ? ' (ok หลัง resume)' : '') : ' · ' + row.note.replace(/^timeout: /, '')}`;
    S.push(txt(X0 + (lastEnd ?? 0) * sc + 8, y + 37, note, { size: 11, fill: row.status === 'ok' ? '#555' : RED }));
  });
  S.push(`<line x1="${xr}" y1="${Y0 - 4}" x2="${xr}" y2="${Y0 + ids.length * RH + 4}" stroke="#495057" stroke-width="1.4" stroke-dasharray="6 4"/>`,
    txt(xr + 6, Y0 + ids.length * RH + 18, `← รอบแรกจบที่ ${T1.toFixed(1)} นาที · ${gapLabel} · resume เริ่มที่เส้นประนี้ →`, { size: 11, fill: '#495057' }));
  let ly = Y0 + ids.length * RH + 52, lx = 30;
  const item = (draw, label, wd) => { S.push(draw(lx, ly), txt(lx + 34, ly + 4, label, { size: 12 })); lx += wd; };
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="14" rx="4" fill="${GRAY}"/>`, 'แท่งบน = แผน (KC-QUEST)', 250);
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="14" rx="4" fill="${COL.yolo}"/>`, 'แท่งล่าง = จริง (สีตามสกิล)', 250);
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="14" rx="4" fill="#fff" stroke="${ORANGE}" stroke-width="2.5"/>`, 'กรอบส้ม = สายวิกฤตของแผน', 250);
  item((x, yy) => `<rect x="${x}" y="${yy - 9}" width="24" height="14" rx="4" fill="#fff" stroke="${RED}" stroke-width="2.2" stroke-dasharray="5 3"/>`, 'กรอบแดงประ = ล้ม/หมดเวลา', 250);
  S.push(txt(30, ly + 36, footer, { size: 12, fill: '#444' }), txt(30, ly + 56, provenance, { size: 11, fill: '#777' }), '</svg>');
  return { svg: S.join('\n'), W, H };
}

// ───────────── SVG → PNG ด้วย Chromium ของ Playwright (ชุดเดียวกับที่ใช้รัน test) ─────────────
(async () => {
  const { chromium } = require(require.resolve('playwright', { paths: [path.join(ROOT, 'app', 'e2e')] }));
  const browser = await chromium.launch();
  for (const [name, { svg, W, H }] of [['gantt-actual', gantt()], ['compare', compare()]]) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>${svg}`);
    await page.screenshot({ path: path.join(ROOT, `${name}.png`), clip: { x: 0, y: 0, width: W, height: H } });
    await page.close();
    console.log(`เขียน ${name}.png (${W}×${H})`);
  }
  await browser.close();
  // ข้อมูลที่ใช้เขียน REPORT.md
  const moved = read('run.log').match(/\| B11 \| yolo2 \| yolo1 \|[^|]*\| (\d{2}:\d{2}:\d{2}) \|/); // เวลานาฬิกาตอนย้ายงาน B11 (เกิดก่อน B04 จบเล็กน้อย)
  const b04 = run1.segs.find((s) => s.block === 'B04');
  console.log(JSON.stringify({ runId, firstRun: { start: t0sec != null ? clockStr(t0sec) : null, minutes: +T1.toFixed(2), end: t0sec != null ? clockStr(t0sec + run1.total) : null },
    resume: { startApprox: r0sec != null ? clockStr(r0sec) : null, minutes: +T2.toFixed(2), endApprox: r0sec != null ? clockStr(r0sec + run2.total) : null }, gapMinutes: gapMin != null ? +gapMin.toFixed(1) : null,
    check: moved && t0sec != null && b04 ? { reassignLoggedAt: moved[1], b04EndReconstructed: clockStr(t0sec + b04.end) } : null,
    tokens: { input: table.reduce((n, t) => n + t.tin, 0), output: table.reduce((n, t) => n + t.tout, 0) }, table }, null, 1));
})();
