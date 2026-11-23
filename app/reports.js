'use strict';
// [B08] Dashboard + Audit Trail + ผู้ดูแลระบบ · โหลดผ่าน src/modules/reports.js (re-export ไฟล์นี้) · order 80
// ที่มา: FR-22..27 · BR-21 BR-24 BR-25 BR-26 BR-27 BR-28 · CONTRACT §2.9 §2.10 §2.11 §6.4 §6.5 §6.8 §7 · TEST-DATA §7 §10 · DECISIONS §12 §13 §18
// ตรวจเอง: `node reports.js` → seed ลง DB ชั่วคราวแล้วเทียบตัวเลข Dashboard กับ TEST-DATA §7 ทุกแถว (+ B10)
//
// หน้า:  /dashboard (executive) · /audit (auditor) · /admin/services /admin/holidays /admin/users (admin)
// API:   GET /api/dashboard?period=2026-11&service=ALL                    → {received,closed,onTime,ontimePct,backlog,overdue,workload}
//        GET /api/dashboard/export?format=xlsx|pdf&period=&service=        → ไฟล์ + Audit EXPORT `xlsx 2026-11 ALL`
//        GET /api/audit?actor=&event=&from=YYYY-MM-DD&to=YYYY-MM-DD        → {count,items} ใหม่ → เก่า
//        GET /api/audit/export.csv?...                                     → CSV + Audit EXPORT `audit-csv`
//        PUT/PATCH/DELETE/POST ที่ /api/audit และ /api/audit/:id             → 405 METHOD_NOT_ALLOWED ทุกบทบาท (append-only)
//        GET /api/admin/services · PUT /api/admin/services/:id             → fee 0–100,000 (INVALID_FEE) · sla 1–60 (INVALID_SLA)
//        GET/POST /api/admin/holidays · DELETE /api/admin/holidays/:date   → ซ้ำ 409 DUPLICATE_HOLIDAY
//        GET /api/admin/users · PUT /api/admin/users/:username             → ตัวเอง 409 SELF_ROLE_CHANGE · มีผลล็อกอินครั้งถัดไป
// นิยามตัวชี้วัด (BR-25 · DECISIONS ข้อ 12 + 18):
//   รับเรื่อง  = มีเลขคำขอ และ paid_at อยู่ในช่วง (รวม CANCELLED ที่เคยชำระ)
//   ปิดงาน    = COMPLETED + REJECTED ที่ closed_at อยู่ในช่วง (CANCELLED ไม่นับ)
//   ทัน       = ปิดงานที่ closed_at ≤ due_at (รวมวินาที 16:30:00 พอดี)
//   ทัน %     = ทัน ÷ ปิดงาน × 100 ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น (คิดด้วยจำนวนเต็ม) · ปิดงาน 0 → null / `–`
//               รายปี = รวมยอดทุกเดือนแล้วหาร (ไม่เฉลี่ย % รายเดือน) · BUG_MODE B10 → หารด้วย "รับเรื่อง"
//   คงค้าง    = SUBMITTED+IN_REVIEW+NEED_FIX+PENDING_APPROVAL+APPROVED ณ ตอนนี้ (ไม่ขึ้นกับช่วง · ขึ้นกับบริการ)
//   เกินกำหนด = คงค้างที่ไม่ใช่ NEED_FIX และ ตอนนี้ > due_at
//   งานในมือ   = IN_REVIEW ที่ owner = เจ้าหน้าที่ (role officer ทุกคน แม้ 0 · ไม่ขึ้นกับตัวกรอง)
//   ช่วงเวลาเทียบตามเวลาไทย (+07:00) เสมอ
// PDPA (BR-24): หน้า dashboard และไฟล์ส่งออกใช้เฉพาะตัวเลข + username/ชื่อแสดงของเจ้าหน้าที่ ไม่ดึงข้อมูลประชาชนเลย

const OFFSET_MS = 7 * 3600 * 1000;
const ACTIVE = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED'];
const CLOSED = ['COMPLETED', 'REJECTED'];
const SERVICES = ['SV-01', 'SV-02', 'SV-03'];
const SERVICE_FILTERS = ['ALL', ...SERVICES];
const FEE_MIN = 0; const FEE_MAX = 100000;
const SLA_MIN = 1; const SLA_MAX = 60;
const STAFF_ROLES = ['officer', 'head', 'executive', 'auditor', 'admin'];
const ALL_ROLES = ['citizen', ...STAFF_ROLES];
const DEPTS = ['registry', 'works'];
const EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];
const EVENT_TH = {
  STAFF_LOGIN: 'เข้าสู่ระบบ', CLAIM: 'รับเรื่อง', RETURN: 'ตีกลับ', FORWARD: 'ส่งต่อ', APPROVE: 'อนุมัติ', REJECT: 'ไม่อนุมัติ',
  ISSUE: 'ออกเอกสาร', UNMASK: 'แสดงเลขบัตรเต็ม', EXPORT: 'ส่งออก', ADMIN_CHANGE: 'ผู้ดูแลแก้ค่า',
};
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const KPI_LABELS = [['received', 'รับเรื่อง'], ['closed', 'ปิดงาน'], ['ontime', 'ทันกำหนด %'], ['backlog', 'งานคงค้าง'], ['overdue', 'เกินกำหนดคงค้าง']];
const PERIOD_RE = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// ───────────────────────── ฟังก์ชันล้วน (ไม่แตะ DB · ไม่อ่านนาฬิกา) ─────────────────────────

/** ISO ที่มี offset → 'YYYY-MM-DDTHH:mm:ss' ตามเวลาไทย (null ถ้าไม่ถูก) */
function thaiStamp(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + OFFSET_MS).toISOString().slice(0, 19);
}
/** iso อยู่ในช่วง 'YYYY-MM' หรือ 'YYYY' (เวลาไทย) */
function inPeriod(iso, period) { const s = thaiStamp(iso); return !!s && s.startsWith(period + '-'); }
/** ms ของ ISO (NaN ถ้าไม่ถูก) */
const msOf = (iso) => (iso ? Date.parse(iso) : NaN);

/** ทัน % ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น ด้วยจำนวนเต็ม (6/7 → 85.7 · 2/3 → 66.7 · 7/8 → 87.5) · ตัวหาร 0 → null */
function pct1(num, den) {
  if (!den) return null;
  return Math.floor((num * 2000 + den) / (2 * den)) / 10;
}
/** 85.7 → '85.7%' · 100 → '100.0%' · null → '–' (en dash U+2013) */
function pctText(p) { return p == null ? '–' : `${p.toFixed(1)}%`; }

/** ตรวจ period ('YYYY-MM' | 'YYYY') · ว่าง → เดือนของนาฬิกา · ผิดรูป → null */
function resolvePeriod(raw, nowISO) {
  const v = one(raw).trim();
  if (!v) return thaiStamp(nowISO).slice(0, 7);
  return PERIOD_RE.test(v) ? v : null;
}
function resolveService(raw) {
  const v = one(raw).trim().toUpperCase();
  if (!v) return 'ALL';
  return SERVICE_FILTERS.includes(v) ? v : null;
}

/**
 * คำนวณ Dashboard (BR-25 BR-26)
 * cases    = [{ caseNo, serviceId, status, paidAt, dueAt, closedAt, owner }] (เฉพาะที่มีเลขคำขอ)
 * officers = [{ username, name }] (role officer ทุกคน)
 */
function computeDashboard({ cases, officers, period, service, nowISO, divideByReceived = false }) {
  const nowMs = msOf(nowISO);
  const svcOk = (c) => service === 'ALL' || c.serviceId === service;
  let received = 0; let closed = 0; let onTime = 0; let backlog = 0; let overdue = 0;
  for (const c of cases) {
    if (!c.caseNo || !svcOk(c)) continue;
    if (c.paidAt && inPeriod(c.paidAt, period)) received++;
    if (CLOSED.includes(c.status) && c.closedAt && inPeriod(c.closedAt, period)) {
      closed++;
      const due = msOf(c.dueAt);
      if (!Number.isNaN(due) && msOf(c.closedAt) <= due) onTime++; // ≤ : 16:30:00 พอดีถือว่าทัน
    }
    if (ACTIVE.includes(c.status)) {
      backlog++;
      const due = msOf(c.dueAt);
      if (c.status !== 'NEED_FIX' && !Number.isNaN(due) && nowMs > due) overdue++;
    }
  }
  const ontimePct = pct1(onTime, divideByReceived ? received : closed); // B10: ÷ รับเรื่อง (ผิด)
  const workload = officers.map((o) => ({
    username: o.username, name: o.name,
    count: cases.filter((c) => c.status === 'IN_REVIEW' && c.owner === o.username).length,
  }));
  return { period, service, received, closed, onTime, ontimePct, ontimeText: pctText(ontimePct), backlog, overdue, workload, asOf: nowISO };
}

/** 5 แถวตามจอ/ไฟล์ส่งออก (CONTRACT §7) → [[ป้าย, ข้อความ]] */
function kpiRows(d) {
  const v = { received: String(d.received), closed: String(d.closed), ontime: d.ontimeText, backlog: String(d.backlog), overdue: String(d.overdue) };
  return KPI_LABELS.map(([k, label]) => [label, v[k]]);
}
/** บรรทัด ASCII ใน PDF (CONTRACT §7) · ปิดงาน 0 → ontime=- */
function kpiAscii(d) {
  return `kpi received=${d.received} closed=${d.closed} ontime=${d.ontimePct == null ? '-' : pctText(d.ontimePct)} backlog=${d.backlog} overdue=${d.overdue}`;
}

/** ป้ายช่วง: '2026-11' → 'พ.ย. 2569' · '2026' → 'ทั้งปี 2569' */
function periodLabel(period) {
  const m = PERIOD_RE.exec(period);
  if (!m) return period;
  const be = Number(m[1]) + 543;
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${be}` : `ทั้งปี ${be}`;
}
/** ตัวเลือก period-select: 12 เดือนล่าสุด (ใหม่ → เก่า) + ทั้งปีปัจจุบันและปีก่อน */
function periodOptions(nowISO) {
  const s = thaiStamp(nowISO);
  let y = Number(s.slice(0, 4)); let m = Number(s.slice(5, 7));
  const months = [];
  for (let i = 0; i < 12; i++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  const y0 = Number(s.slice(0, 4));
  return { months, years: [String(y0), String(y0 - 1)] };
}

/** CSV: เซลล์ (RFC 4180 + กันสูตร Excel ที่ขึ้นต้น = + - @) */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_HEADER = 'time,username,role,event,caseNo,fromStatus,toStatus,detail';
/** items (รูปแบบ API) → CSV UTF-8 ไม่มี BOM · คั่นบรรทัด \n · ไม่มีบรรทัดว่างท้ายไฟล์ */
function auditCsv(items) {
  const lines = [CSV_HEADER];
  for (const it of items) lines.push([it.time, it.username, it.role, it.event, it.caseNo, it.fromStatus, it.toStatus, it.detail].map(csvCell).join(','));
  return lines.join('\n');
}

/** จำนวนเต็มในช่วง [min,max] · รับ number หรือสตริงตัวเลข · อื่น ๆ → null */
function intIn(v, min, max) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) n = Number(v);
  if (n == null || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
/** ค่าแรกของ query (กัน ?a=1&a=2) เป็นสตริง */
function one(v) { if (Array.isArray(v)) v = v[0]; return v == null ? '' : String(v); }
/** 'YYYY-MM-DD' ที่มีจริง */
function validYmd(s) {
  if (!YMD_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const nextYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
/** ช่วงวันที่ของ Audit แบบรวมวันเริ่มและวันจบ ตามเวลาไทย → [fromMs, toMsExclusive] */
function dayRangeMs(from, to) {
  return [
    from ? Date.parse(`${from}T00:00:00+07:00`) : -Infinity,
    to ? Date.parse(`${nextYmd(to)}T00:00:00+07:00`) : Infinity,
  ];
}

// ───────────────────────── สคริปต์ฝั่งเบราว์เซอร์ (ใช้ api() showError() toast() จาก /app.js) ─────────────────────────

const CLIENT_COMMON = `
const TH_MONTHS=${JSON.stringify(MONTHS)};
function thaiDT(iso){const m=/^(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2}))?/.exec(iso||'');if(!m)return '';const d=Number(m[3])+' '+TH_MONTHS[Number(m[2])-1]+' '+(Number(m[1])+543);return m[4]?d+' '+m[4]+':'+m[5]:d;}
function el(tag,attrs,text){const e=document.createElement(tag);for(const k in (attrs||{}))e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e;}
function download(url,name){const a=document.createElement('a');a.href=url;a.download=name||'';a.hidden=true;document.body.appendChild(a);a.click();setTimeout(()=>{a.remove();if(url.startsWith('blob:'))URL.revokeObjectURL(url);},2000);}
function errMsg(r,fallback){return (r&&r.data&&r.data.message)||fallback||'ทำรายการไม่สำเร็จ';}
`;

const PAGE_CSS = `<style>
.b08-filters{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:flex-end;margin:.5rem 0 1rem}
.b08-filters>div{min-width:0;max-width:100%}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin:1rem 0}
.kpi{background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:.75rem}
.kpi .kpi-label{display:block;color:#374151;font-size:.95rem}
.kpi strong{display:block;font-size:1.8rem;line-height:1.2}
.kpi small{color:#4b5563}
.b08-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}
.b08-note{color:#4b5563;font-size:.95rem}
.b08-inline{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.b08-inline label{margin:0}
td input[type=number]{width:9rem}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
</style>`;

// ───────────────────────── โมดูล ─────────────────────────

module.exports = {
  order: 80,
  // ฟังก์ชันล้วนสำหรับผู้ตรวจ/ทดสอบ
  ACTIVE, CLOSED, EVENTS, thaiStamp, inPeriod, pct1, pctText, resolvePeriod, resolveService, computeDashboard,
  kpiRows, kpiAscii, periodLabel, periodOptions, csvCell, auditCsv, intIn, validYmd, dayRangeMs,

  register(app, ctx) {
    const { db, clock, bugs, audit, html, format, hooks } = ctx;
    const { HttpError, wrap, send } = ctx.errors;
    const { guard } = ctx.session;
    const { esc } = format;
    const SERVICE_NAME = format.SERVICE_NAME || {};
    const ROLE_TH = format.ROLE_TH || {};
    const DEPT_TH = format.DEPT_TH || { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };
    const page = (req, res, title, body, scripts = '') => html.send(req, res, { title, body, head: PAGE_CSS, scripts });
    const bad = (msg) => new HttpError(400, 'BAD_REQUEST', msg);

    // ══════════════════════ Dashboard (FR-22 FR-23 · BR-24 BR-25 BR-26) ══════════════════════

    function dashboard(query) {
      const nowISO = clock.nowISO();
      const period = resolvePeriod(query.period, nowISO);
      if (!period) throw bad('ช่วงเวลาต้องเป็น YYYY-MM หรือ YYYY');
      const service = resolveService(query.service);
      if (!service) throw bad('บริการต้องเป็น ALL, SV-01, SV-02 หรือ SV-03');
      const cases = db.all(`SELECT case_no AS caseNo, service_id AS serviceId, status, paid_at AS paidAt, due_at AS dueAt,
        closed_at AS closedAt, owner FROM cases WHERE case_no IS NOT NULL`);
      const officers = db.all("SELECT username, name FROM users WHERE role = 'officer' ORDER BY username");
      return computeDashboard({ cases, officers, period, service, nowISO, divideByReceived: bugs.on('B10') });
    }
    hooks.provide('dashboardStats', (query = {}) => dashboard(query));

    app.get('/api/dashboard', guard.api('executive'), wrap((req, res) => res.json(dashboard(req.query))));

    app.get('/api/dashboard/export', guard.api('executive'), wrap(async (req, res) => {
      const fmt = one(req.query.format).trim().toLowerCase();
      if (fmt !== 'xlsx' && fmt !== 'pdf') throw bad('รูปแบบไฟล์ต้องเป็น xlsx หรือ pdf');
      const d = dashboard(req.query);
      const buf = fmt === 'xlsx' ? await buildXlsx(d) : await buildPdf(d);
      audit.log(req.user, 'EXPORT', { detail: `${fmt} ${d.period} ${d.service}` }); // CONTRACT §6.8 · บันทึกเมื่อสร้างไฟล์สำเร็จ
      res.set('Content-Type', fmt === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="dashboard-${d.period}-${d.service}.${fmt}"`);
      res.set('Content-Length', String(buf.length));
      res.end(buf);
    }));

    async function buildXlsx(d) {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      wb.creator = 'e-Service เทศบาลนครตัวอย่าง';
      wb.created = new Date(clock.now()); wb.modified = wb.created;
      // ชีตแรกตาม CONTRACT §7: แถว 1 หัวตาราง · แถว 2–6 ป้าย/ค่าเป็นข้อความเท่าจอ
      const ws = wb.addWorksheet('Dashboard');
      ws.columns = [{ width: 22 }, { width: 14 }];
      ws.addRow(['ตัวชี้วัด', 'ค่า']);
      for (const row of kpiRows(d)) ws.addRow(row);
      ws.getRow(1).font = { bold: true };
      // ชีตที่ 2: บริบท (ไม่มีข้อมูลส่วนบุคคล)
      const info = wb.addWorksheet('รายละเอียด');
      info.columns = [{ width: 34 }, { width: 28 }];
      info.addRow(['ช่วง', d.period]);
      info.addRow(['ช่วง (แสดง)', periodLabel(d.period)]);
      info.addRow(['บริการ', d.service]);
      info.addRow(['ทัน (จำนวน)', String(d.onTime)]);
      info.addRow(['ณ เวลา', format.thaiDate(d.asOf)]);
      info.addRow([]);
      info.addRow(['งานในมือรายเจ้าหน้าที่ (username)', 'งานในมือ']);
      for (const w of d.workload) info.addRow([w.username, String(w.count)]);
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    function buildPdf(d) {
      const PDFDocument = require('pdfkit');
      const ascii = kpiAscii(d);
      return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({
          size: 'A4', margin: 56, compress: false,
          info: { Title: `Dashboard ${d.period} ${d.service}`, Subject: ascii, Author: 'e-Service', Creator: 'e-Service' },
        });
        const chunks = [];
        pdf.on('data', (b) => chunks.push(b));
        pdf.on('end', () => resolve(Buffer.concat(chunks)));
        pdf.on('error', reject);
        let thai = !!ctx.config.THAI_FONT;
        if (thai) { try { pdf.registerFont('thai', ctx.config.THAI_FONT); } catch (_) { thai = false; } }
        const body = () => pdf.font(thai ? 'thai' : 'Helvetica');
        const T = (th, en) => (thai ? th : en);
        const svc = d.service === 'ALL' ? T('ทุกบริการ', 'All services') : (thai ? `${d.service} ${SERVICE_NAME[d.service] || ''}` : d.service);
        body().fontSize(18).text(T('รายงาน Dashboard ผลการดำเนินงาน', 'Dashboard report'), { align: 'center' });
        pdf.moveDown(0.3).fontSize(12).text(`${T('ช่วง', 'Period')}: ${thai ? periodLabel(d.period) : d.period} · ${T('บริการ', 'Service')}: ${svc}`, { align: 'center' });
        pdf.fontSize(10).text(`${T('ข้อมูล ณ', 'As of')} ${thai ? format.thaiDate(d.asOf) : d.asOf}`, { align: 'center' });
        pdf.moveDown(1).fontSize(13);
        const en = { 'รับเรื่อง': 'Received', 'ปิดงาน': 'Closed', 'ทันกำหนด %': 'On-time %', 'งานคงค้าง': 'Backlog', 'เกินกำหนดคงค้าง': 'Overdue backlog' };
        for (const [label, value] of kpiRows(d)) pdf.text(`${T(label, en[label])}: ${thai || value !== '–' ? value : '-'}`);
        pdf.moveDown(0.5).fontSize(10).text(T('งานคงค้างและเกินกำหนดคงค้างเป็นค่า ณ เวลาที่ส่งออก', 'Backlog and overdue are as of export time'));
        pdf.moveDown(0.8).fontSize(13).text(T('งานในมือรายเจ้าหน้าที่', 'Workload per officer'));
        pdf.fontSize(11);
        for (const w of d.workload) pdf.text(`${thai ? `${w.name} (${w.username})` : w.username}: ${w.count}`);
        // บรรทัด ASCII ที่เครื่องอ่านได้ (CONTRACT §7) · Courier ไม่มี kerning → ดึงข้อความได้ตรงตัว
        pdf.moveDown(1).font('Courier').fontSize(10).text(ascii, { lineBreak: false });
        pdf.moveDown(0.2).text(`period=${d.period} service=${d.service}`, pdf.page.margins.left, pdf.y + 14, { lineBreak: false });
        pdf.end();
      });
    }

    app.get('/dashboard', guard.page('executive'), wrap((req, res) => {
      const d = dashboard({});
      const opts = periodOptions(d.asOf);
      const opt = (v, label) => `<option value="${esc(v)}"${v === d.period ? ' selected' : ''}>${esc(label)}</option>`;
      const svcLabel = (s) => (s === 'ALL' ? 'ทุกบริการ' : `${s} ${SERVICE_NAME[s] || ''}`.trim());
      const kpi = (id, label, value, extra = '') => `<div class="kpi"><span class="kpi-label" id="lbl-${id}">${label}</span><strong data-testid="${id}" aria-describedby="lbl-${id}">${esc(value)}</strong>${extra}</div>`;
      const wl = d.workload.map((w) => `<tr data-testid="workload-row" data-username="${esc(w.username)}"><td>${esc(w.name)}</td><td>${esc(w.username)}</td><td data-testid="workload-value">${w.count}</td></tr>`).join('');
      const body = `
<h1>Dashboard ผลการดำเนินงาน</h1>
<div class="b08-filters">
  <div><label for="period-select">ช่วงเวลา</label>
  <select id="period-select" data-testid="period-select">
    <optgroup label="รายเดือน">${opts.months.map((m) => opt(m, periodLabel(m))).join('')}</optgroup>
    <optgroup label="รายปี">${opts.years.map((y) => opt(y, periodLabel(y))).join('')}</optgroup>
  </select></div>
  <div><label for="service-select">บริการ</label>
  <select id="service-select" data-testid="service-select">${SERVICE_FILTERS.map((s) => `<option value="${s}"${s === d.service ? ' selected' : ''}>${esc(svcLabel(s))}</option>`).join('')}</select></div>
</div>
<p data-testid="action-error" role="alert" hidden></p>
<section class="kpis" aria-label="ตัวชี้วัด" aria-live="polite">
  ${kpi('kpi-received', 'รับเรื่อง', String(d.received))}
  ${kpi('kpi-closed', 'ปิดงาน', String(d.closed))}
  ${kpi('kpi-ontime-pct', 'ทันกำหนด %', d.ontimeText, `<small id="kpi-ontime-sub">ทัน ${d.onTime} จากปิดงาน ${d.closed}</small>`)}
  ${kpi('kpi-backlog', 'งานคงค้าง', String(d.backlog))}
  ${kpi('kpi-overdue', 'เกินกำหนดคงค้าง', String(d.overdue))}
</section>
<p class="b08-note">ช่วงที่แสดง: <span id="period-label">${esc(periodLabel(d.period))}</span> · งานคงค้างและเกินกำหนดคงค้างเป็นค่า ณ <span id="as-of">${esc(format.thaiDate(d.asOf))}</span> (ไม่ขึ้นกับช่วงเวลา)</p>
<h2>งานในมือรายเจ้าหน้าที่</h2>
<div class="table-wrap"><table>
  <caption class="sr-only">จำนวนคำขอที่กำลังตรวจสอบซึ่งเจ้าหน้าที่แต่ละคนรับไว้</caption>
  <thead><tr><th scope="col">เจ้าหน้าที่</th><th scope="col">ชื่อผู้ใช้</th><th scope="col">งานในมือ</th></tr></thead>
  <tbody id="workload-body">${wl}</tbody>
</table></div>
<div class="b08-actions">
  <button type="button" data-testid="export-xlsx-btn" onclick="exportDash('xlsx')">ส่งออก Excel</button>
  <button type="button" data-testid="export-pdf-btn" onclick="exportDash('pdf')">ส่งออก PDF</button>
</div>`;
      const script = `<script>${CLIENT_COMMON}
const pSel=document.getElementById('period-select'),sSel=document.getElementById('service-select');
let dashSeq=0;
function q(){return 'period='+encodeURIComponent(pSel.value)+'&service='+encodeURIComponent(sSel.value);}
function set(id,v){const e=document.querySelector('[data-testid="'+id+'"]');if(e)e.textContent=v;}
async function refreshDash(){
  const my=++dashSeq;const r=await api('GET','/api/dashboard?'+q());
  if(my!==dashSeq)return;
  if(!r.ok){showError(errMsg(r,'โหลดข้อมูลไม่สำเร็จ'));return;}
  showError('');const d=r.data;
  set('kpi-received',String(d.received));set('kpi-closed',String(d.closed));set('kpi-ontime-pct',d.ontimeText);
  set('kpi-backlog',String(d.backlog));set('kpi-overdue',String(d.overdue));
  document.getElementById('kpi-ontime-sub').textContent='ทัน '+d.onTime+' จากปิดงาน '+d.closed;
  document.getElementById('period-label').textContent=pSel.options[pSel.selectedIndex].text;
  document.getElementById('as-of').textContent=thaiDT(d.asOf);
  for(const w of d.workload){const row=document.querySelector('[data-testid="workload-row"][data-username="'+CSS.escape(w.username)+'"] [data-testid="workload-value"]');if(row)row.textContent=String(w.count);}
}
pSel.addEventListener('change',refreshDash);sSel.addEventListener('change',refreshDash);
function exportDash(fmt){download('/api/dashboard/export?format='+fmt+'&'+q(),'dashboard-'+pSel.value+'-'+sSel.value+'.'+fmt);}
</script>`;
      page(req, res, 'Dashboard', body, script);
    }));

    // ══════════════════════ Audit Trail (FR-24 · BR-27) ══════════════════════

    // append-only: เมธอดแก้/ลบ/เพิ่มที่ /api/audit* → 405 ก่อนตรวจสิทธิ์ (ทุกบทบาทรวม admin · แม้ :id ไม่มีจริง)
    const methodNotAllowed = (req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      res.set('Allow', 'GET, HEAD');
      return send(res, 405, 'METHOD_NOT_ALLOWED');
    };
    app.all(['/api/audit', '/api/audit/*', '/api/admin/audit', '/api/admin/audit/*'], methodNotAllowed);

    function auditQuery(q) {
      const actor = one(q.actor).trim();
      const event = one(q.event).trim().toUpperCase();
      const from = one(q.from).trim();
      const to = one(q.to).trim();
      if (event && !EVENTS.includes(event)) throw bad('เหตุการณ์ไม่ถูกต้อง');
      if (from && !validYmd(from)) throw bad('วันที่เริ่มต้องเป็น YYYY-MM-DD');
      if (to && !validYmd(to)) throw bad('วันที่สิ้นสุดต้องเป็น YYYY-MM-DD');
      let sql = 'SELECT * FROM audit WHERE 1 = 1';
      const p = [];
      if (actor) { sql += ' AND lower(username) = lower(?)'; p.push(actor); }
      if (event) { sql += ' AND event = ?'; p.push(event); }
      const [lo, hi] = dayRangeMs(from, to);
      return db.all(sql, ...p)
        .map((r) => ({ r, ms: Date.parse(r.time) }))
        .filter(({ ms }) => ms >= lo && ms < hi)                       // รวมวันเริ่ม/วันจบ ตามเวลาไทย
        .sort((a, b) => b.ms - a.ms || b.r.id - a.r.id)                 // ใหม่ → เก่า · เวลาเท่ากัน id มาก → น้อย
        .map(({ r }) => ({
          id: r.id, time: r.time, username: r.username, role: r.role, event: r.event,
          caseNo: r.case_no || null, fromStatus: r.from_status || null, toStatus: r.to_status || null, detail: r.detail || '',
        }));
    }

    app.get('/api/audit', guard.api('auditor'), wrap((req, res) => {
      const items = auditQuery(req.query);
      res.json({ count: items.length, items });
    }));

    app.get('/api/audit/export.csv', guard.api('auditor'), wrap((req, res) => {
      const csv = auditCsv(auditQuery(req.query)); // สร้างก่อนบันทึก → ไฟล์เท่าจอ (ไม่รวมแถว EXPORT ของครั้งนี้)
      audit.log(req.user, 'EXPORT', { detail: 'audit-csv' }); // A-36
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="audit-${clock.today()}.csv"`);
      res.send(csv);
    }));

    const transition = (from, to) => (from || to ? `${from || '–'} → ${to || '–'}` : '–');
    function auditRowHtml(it) {
      return `<tr data-testid="audit-row" data-id="${it.id}" data-event="${esc(it.event)}" data-actor="${esc(it.username)}" data-case-no="${esc(it.caseNo || '')}">`
        + `<td>${format.timeEl(it.time, 'audit-time')}</td>`
        + `<td data-testid="audit-actor">${esc(it.username)}</td>`
        + `<td data-testid="audit-role">${esc(it.role)}</td>`
        + `<td data-testid="audit-event">${esc(it.event)}</td>`
        + `<td data-testid="audit-case-no">${esc(it.caseNo || '–')}</td>`
        + `<td data-testid="audit-transition">${esc(transition(it.fromStatus, it.toStatus))}</td>`
        + `<td data-testid="audit-detail">${esc(it.detail)}</td></tr>`;
    }

    app.get('/audit', guard.page('auditor'), wrap((req, res) => {
      const items = auditQuery({});
      const body = `
<h1>Audit Trail</h1>
<p class="b08-note">บันทึกเพิ่มได้อย่างเดียว · แก้ไขหรือลบไม่ได้</p>
<form class="b08-filters" id="audit-form" onsubmit="event.preventDefault();loadAudit();">
  <div><label for="f-actor">ผู้ทำรายการ (username)</label><input id="f-actor" data-testid="audit-filter-actor" type="text" autocomplete="off"></div>
  <div><label for="f-event">เหตุการณ์</label><select id="f-event" data-testid="audit-filter-event"><option value="">ทั้งหมด</option>${EVENTS.map((e) => `<option value="${e}">${e} · ${esc(EVENT_TH[e])}</option>`).join('')}</select></div>
  <div><label for="f-from">ตั้งแต่วันที่</label><input id="f-from" data-testid="audit-filter-from" type="date"></div>
  <div><label for="f-to">ถึงวันที่</label><input id="f-to" data-testid="audit-filter-to" type="date"></div>
  <div><span data-testid="audit-filter-apply"><button type="submit" data-testid="audit-apply-btn">ค้นหา</button></span></div>
</form>
<p data-testid="action-error" role="alert" hidden></p>
<p>จำนวนรายการ: <strong data-testid="audit-count" aria-live="polite">${items.length}</strong></p>
<div class="b08-actions"><button type="button" data-testid="audit-export-csv-btn" onclick="exportAudit()">ส่งออก CSV</button></div>
<div class="table-wrap"><table>
  <caption class="sr-only">รายการ Audit เรียงจากใหม่ไปเก่า</caption>
  <thead><tr><th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th><th scope="col">เลขคำขอ</th><th scope="col">สถานะก่อน → หลัง</th><th scope="col">รายละเอียด</th></tr></thead>
  <tbody id="audit-body">${items.map(auditRowHtml).join('')}</tbody>
</table></div>`;
      const script = `<script>${CLIENT_COMMON}
const F={actor:document.getElementById('f-actor'),event:document.getElementById('f-event'),from:document.getElementById('f-from'),to:document.getElementById('f-to')};
let auditSeq=0;
function aq(){const p=new URLSearchParams();for(const k in F)if(F[k].value.trim())p.set(k,F[k].value.trim());return p.toString();}
function tr(f,t){return f||t?(f||'–')+' → '+(t||'–'):'–';}
function renderAudit(d){
  document.querySelector('[data-testid="audit-count"]').textContent=String(d.count);
  const tb=document.getElementById('audit-body');const rows=[];
  for(const it of d.items){
    const r=el('tr',{'data-testid':'audit-row','data-id':String(it.id),'data-event':it.event,'data-actor':it.username,'data-case-no':it.caseNo||''});
    const tc=el('td');tc.appendChild(el('time',{'data-testid':'audit-time','data-iso':it.time,datetime:it.time},thaiDT(it.time)));r.appendChild(tc);
    r.appendChild(el('td',{'data-testid':'audit-actor'},it.username));r.appendChild(el('td',{'data-testid':'audit-role'},it.role));
    r.appendChild(el('td',{'data-testid':'audit-event'},it.event));r.appendChild(el('td',{'data-testid':'audit-case-no'},it.caseNo||'–'));
    r.appendChild(el('td',{'data-testid':'audit-transition'},tr(it.fromStatus,it.toStatus)));r.appendChild(el('td',{'data-testid':'audit-detail'},it.detail||''));
    rows.push(r);
  }
  tb.replaceChildren(...rows);
}
async function loadAudit(){
  const my=++auditSeq;const r=await api('GET','/api/audit'+(aq()?'?'+aq():''));
  if(my!==auditSeq)return;
  if(!r.ok){showError(errMsg(r,'โหลดข้อมูลไม่สำเร็จ'));return;}
  showError('');renderAudit(r.data);
}
for(const k of ['event','from','to'])F[k].addEventListener('change',loadAudit);
F.actor.addEventListener('change',loadAudit);
async function exportAudit(){
  const res=await fetch('/api/audit/export.csv'+(aq()?'?'+aq():''),{credentials:'same-origin'});
  if(!res.ok){let m='ส่งออกไม่สำเร็จ';try{m=(await res.json()).message||m;}catch(_){}showError(m);return;}
  const blob=await res.blob();download(URL.createObjectURL(blob),'audit-'+new Date().toISOString().slice(0,10)+'.csv');
  loadAudit(); // แถว EXPORT ของการส่งออกครั้งนี้ปรากฏทันที
}
</script>`;
      page(req, res, 'Audit Trail', body, script);
    }));

    // ══════════════════════ ผู้ดูแลระบบ (FR-25 FR-26 FR-27 · BR-28) ══════════════════════

    const serviceJson = (s) => ({
      id: s.id, name: s.name, fee: s.fee, sla: s.sla,
      feePerSqm: s.fee_per_sqm == null ? null : s.fee_per_sqm,
      ...(s.id === 'SV-03' ? { feeBase: s.fee } : {}),
    });
    const listServices = () => db.all('SELECT * FROM services ORDER BY id').map(serviceJson);
    const listHolidays = () => db.all('SELECT date, name FROM holidays ORDER BY date');
    const listUsers = () => db.all('SELECT username, name, role, dept FROM users ORDER BY username').map((u) => ({ ...u, dept: u.dept || '' }));

    app.get('/admin', guard.page('admin'), (req, res) => res.redirect('/admin/services'));

    app.get('/api/admin/services', guard.api('admin'), wrap((req, res) => res.json({ items: listServices() })));

    function updateService(req, res) {
      const id = String(req.params.id || '').toUpperCase();
      const svc = db.get('SELECT * FROM services WHERE id = ?', id);
      if (!svc) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบบริการ');
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
      // SV-03: feeBase (หรือ fee) + feePerSqm · อื่น ๆ: fee · ทุกบริการ: sla
      const feeKey = id === 'SV-03' && has('feeBase') ? 'feeBase' : 'fee';
      const next = { fee: svc.fee, fee_per_sqm: svc.fee_per_sqm, sla: svc.sla };
      if (has(feeKey)) { const v = intIn(b[feeKey], FEE_MIN, FEE_MAX); if (v == null) throw new HttpError(400, 'INVALID_FEE'); next.fee = v; }
      if (id === 'SV-03' && has('feePerSqm')) { const v = intIn(b.feePerSqm, FEE_MIN, FEE_MAX); if (v == null) throw new HttpError(400, 'INVALID_FEE'); next.fee_per_sqm = v; }
      if (has('sla')) { const v = intIn(b.sla, SLA_MIN, SLA_MAX); if (v == null) throw new HttpError(400, 'INVALID_SLA'); next.sla = v; }
      const changes = [];
      if (next.fee !== svc.fee) changes.push(`${id} fee ${svc.fee} → ${next.fee}`);
      if (next.fee_per_sqm !== svc.fee_per_sqm) changes.push(`${id} feePerSqm ${svc.fee_per_sqm} → ${next.fee_per_sqm}`);
      if (next.sla !== svc.sla) changes.push(`${id} sla ${svc.sla} → ${next.sla}`);
      if (changes.length) {
        db.tx(() => {
          db.run('UPDATE services SET fee = ?, fee_per_sqm = ?, sla = ? WHERE id = ?', next.fee, next.fee_per_sqm, next.sla, id);
          audit.log(req.user, 'ADMIN_CHANGE', { detail: changes.join(', ') }); // ไม่เปลี่ยนค่า = ไม่บันทึก
        });
      }
      res.json({ ...serviceJson(db.get('SELECT * FROM services WHERE id = ?', id)), changed: changes.length > 0 });
    }
    app.put('/api/admin/services/:id', guard.api('admin'), wrap(updateService));
    app.patch('/api/admin/services/:id', guard.api('admin'), wrap(updateService));

    app.get('/api/admin/holidays', guard.api('admin'), wrap((req, res) => res.json({ items: listHolidays() })));

    app.post('/api/admin/holidays', guard.api('admin'), wrap((req, res) => {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const date = one(b.date).trim();
      if (!validYmd(date)) throw bad('วันที่ต้องเป็น YYYY-MM-DD (ค.ศ.)');
      const name = one(b.name).trim().slice(0, 100) || 'วันหยุด';
      const created = db.tx(() => {
        if (db.get('SELECT 1 AS x FROM holidays WHERE date = ?', date)) return false;
        db.run('INSERT INTO holidays(date, name) VALUES (?, ?)', date, name);
        audit.log(req.user, 'ADMIN_CHANGE', { detail: `holiday add ${date}` });
        return true;
      });
      if (!created) throw new HttpError(409, 'DUPLICATE_HOLIDAY');
      res.status(201).json({ date, name });
    }));

    app.delete('/api/admin/holidays/:date', guard.api('admin'), wrap((req, res) => {
      const date = String(req.params.date || '').trim();
      const removed = db.tx(() => {
        if (!db.get('SELECT 1 AS x FROM holidays WHERE date = ?', date)) return false;
        db.run('DELETE FROM holidays WHERE date = ?', date);
        audit.log(req.user, 'ADMIN_CHANGE', { detail: `holiday delete ${date}` });
        return true;
      });
      if (!removed) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบวันหยุด');
      res.json({ ok: true, date });
    }));

    app.get('/api/admin/users', guard.api('admin'), wrap((req, res) => res.json({ items: listUsers() })));

    function updateUser(req, res) {
      const username = String(req.params.username || '');
      const u = db.get('SELECT username, name, role, dept FROM users WHERE username = ?', username);
      if (!u) throw new HttpError(404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
      const cur = { role: u.role, dept: u.dept || '' };
      const role = has('role') ? one(b.role).trim() : cur.role;
      let dept = has('dept') ? one(b.dept).trim() : cur.dept;
      if (username === req.user.username && (role !== cur.role || dept !== cur.dept)) throw new HttpError(409, 'SELF_ROLE_CHANGE'); // A-57
      if (!ALL_ROLES.includes(role)) throw bad('บทบาทไม่ถูกต้อง');
      if (role === 'citizen') throw bad('บัญชีเจ้าหน้าที่เปลี่ยนเป็นประชาชนไม่ได้');
      if (role === 'officer') { if (!DEPTS.includes(dept)) throw bad('เจ้าหน้าที่ต้องเลือกแผนก registry หรือ works'); } else dept = '';
      const changes = [];
      if (role !== cur.role) changes.push(`${username} role ${cur.role} → ${role}`);
      if (dept !== cur.dept) changes.push(`${username} dept ${cur.dept || '-'} → ${dept || '-'}`);
      if (changes.length) {
        db.tx(() => {
          db.run('UPDATE users SET role = ?, dept = ? WHERE username = ?', role, dept, username); // มีผลกับล็อกอินครั้งถัดไป (session เก็บบทบาท ณ ตอนล็อกอิน)
          audit.log(req.user, 'ADMIN_CHANGE', { detail: changes.join(', ') });
        });
      }
      res.json({ username, name: u.name, role, dept, changed: changes.length > 0 });
    }
    app.put('/api/admin/users/:username', guard.api('admin'), wrap(updateUser));
    app.patch('/api/admin/users/:username', guard.api('admin'), wrap(updateUser));

    // ---------- หน้า /admin/services ----------
    app.get('/admin/services', guard.page('admin'), wrap((req, res) => {
      const rows = listServices().map((s) => {
        const feeHint = { 'SV-01': 'บาทต่อฉบับ', 'SV-02': 'บาท (คงที่)', 'SV-03': 'บาท ฐานพื้นที่ 1–100 ตร.ม.' }[s.id] || 'บาท';
        const per = s.id === 'SV-03'
          ? `<label for="svc-fee-per-sqm-SV-03">บาทต่อ ตร.ม. ส่วนเกิน 100</label><input id="svc-fee-per-sqm-SV-03" data-testid="svc-fee-per-sqm-SV-03" type="number" min="0" max="100000" step="1" inputmode="numeric" value="${esc(s.feePerSqm)}">`
          : '';
        return `<tr data-testid="service-row" data-service-id="${esc(s.id)}">
  <th scope="row">${esc(s.id)}<br><span class="b08-note">${esc(s.name)}</span></th>
  <td><label for="svc-fee-${esc(s.id)}">ค่าธรรมเนียม (${feeHint})</label><input id="svc-fee-${esc(s.id)}" data-testid="svc-fee-${esc(s.id)}" type="number" min="0" max="100000" step="1" inputmode="numeric" value="${esc(s.fee)}">${per}</td>
  <td><label for="svc-sla-${esc(s.id)}">SLA (วันทำการ)</label><input id="svc-sla-${esc(s.id)}" data-testid="svc-sla-${esc(s.id)}" type="number" min="1" max="60" step="1" inputmode="numeric" value="${esc(s.sla)}"></td>
  <td><button type="button" data-testid="svc-save-${esc(s.id)}" onclick="saveSvc('${esc(s.id)}')">บันทึก ${esc(s.id)}</button></td>
</tr>`;
      }).join('');
      const body = `
<h1>จัดการบริการ</h1>
<p class="b08-note">ค่าธรรมเนียมเป็นจำนวนเต็ม 0–100,000 บาท · SLA เป็นจำนวนเต็ม 1–60 วันทำการ · ค่าใหม่มีผลกับคำขอที่เข้าขั้นรอชำระหลังแก้ (ยอดเดิมถูกล็อกแล้ว)</p>
<p data-testid="action-error" role="alert" hidden></p>
<div class="table-wrap"><table>
  <caption class="sr-only">ค่าธรรมเนียมและ SLA ของแต่ละบริการ</caption>
  <thead><tr><th scope="col">บริการ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">SLA</th><th scope="col">บันทึก</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
      const script = `<script>${CLIENT_COMMON}
function numOf(id){const e=document.getElementById(id);const v=(e&&e.value||'').trim();if(v==='')return null;const n=Number(v);return Number.isFinite(n)?n:v;}
async function saveSvc(id){
  const body={sla:numOf('svc-sla-'+id)};
  if(id==='SV-03'){body.feeBase=numOf('svc-fee-SV-03');body.feePerSqm=numOf('svc-fee-per-sqm-SV-03');}else body.fee=numOf('svc-fee-'+id);
  const r=await api('PUT','/api/admin/services/'+encodeURIComponent(id),body);
  if(!r.ok){showError(errMsg(r,'บันทึกไม่สำเร็จ'));return;}
  showError('');const s=r.data;
  document.getElementById('svc-fee-'+id).value=s.fee;document.getElementById('svc-sla-'+id).value=s.sla;
  if(id==='SV-03')document.getElementById('svc-fee-per-sqm-SV-03').value=s.feePerSqm;
  toast('บันทึก '+id+' แล้ว');
}
</script>`;
      page(req, res, 'จัดการบริการ', body, script);
    }));

    // ---------- หน้า /admin/holidays ----------
    const holidayRowHtml = (h) => `<tr data-testid="holiday-row" data-date="${esc(h.date)}"><td>${format.timeEl(h.date, '', { time: false })}</td><td>${esc(h.date)}</td><td>${esc(h.name)}</td>`
      + `<td><button type="button" data-testid="holiday-delete-btn" data-date="${esc(h.date)}" onclick="delHoliday(this.dataset.date)" aria-label="ลบ วันหยุด ${esc(h.date)}">ลบ</button></td></tr>`;
    app.get('/admin/holidays', guard.page('admin'), wrap((req, res) => {
      const body = `
<h1>จัดการวันหยุด</h1>
<p class="b08-note">วันทำการ = จันทร์–ศุกร์ ที่ไม่อยู่ในตารางนี้ · เพิ่ม/ลบวันหยุดไม่คำนวณกำหนดเสร็จของคำขอที่ชำระแล้วใหม่</p>
<form class="b08-filters" onsubmit="event.preventDefault();addHoliday();">
  <div><label for="holiday-date">วันที่ (ค.ศ.)</label><input id="holiday-date" data-testid="holiday-date-input" type="date" required></div>
  <div><label for="holiday-name">ชื่อวันหยุด</label><input id="holiday-name" data-testid="holiday-name-input" type="text" maxlength="100"></div>
  <div><button type="submit" data-testid="holiday-add-btn">เพิ่มวันหยุด</button></div>
</form>
<p data-testid="action-error" role="alert" hidden></p>
<div class="table-wrap"><table>
  <caption class="sr-only">รายการวันหยุด</caption>
  <thead><tr><th scope="col">วันที่</th><th scope="col">ค.ศ.</th><th scope="col">ชื่อ</th><th scope="col">ลบ</th></tr></thead>
  <tbody id="holiday-body">${listHolidays().map(holidayRowHtml).join('')}</tbody>
</table></div>`;
      const script = `<script>${CLIENT_COMMON}
function renderHolidays(items){
  const rows=items.map((h)=>{const r=el('tr',{'data-testid':'holiday-row','data-date':h.date});
    const t=el('td');t.appendChild(el('time',{'data-iso':h.date,datetime:h.date},thaiDT(h.date)));r.appendChild(t);
    r.appendChild(el('td',null,h.date));r.appendChild(el('td',null,h.name));
    const c=el('td');const b=el('button',{type:'button','data-testid':'holiday-delete-btn','data-date':h.date,'aria-label':'ลบ วันหยุด '+h.date},'ลบ');
    b.addEventListener('click',()=>delHoliday(h.date));c.appendChild(b);r.appendChild(c);return r;});
  document.getElementById('holiday-body').replaceChildren(...rows);
}
async function reloadHolidays(){const r=await api('GET','/api/admin/holidays');if(r.ok)renderHolidays(r.data.items);}
async function addHoliday(){
  const d=document.getElementById('holiday-date').value.trim(),n=document.getElementById('holiday-name').value.trim();
  const r=await api('POST','/api/admin/holidays',{date:d,name:n});
  if(!r.ok){showError(errMsg(r,'เพิ่มวันหยุดไม่สำเร็จ'));return;}
  showError('');await reloadHolidays();document.getElementById('holiday-date').value='';document.getElementById('holiday-name').value='';
  toast('เพิ่มวันหยุด '+r.data.date+' แล้ว');
}
async function delHoliday(d){
  const r=await api('DELETE','/api/admin/holidays/'+encodeURIComponent(d));
  if(!r.ok){showError(errMsg(r,'ลบวันหยุดไม่สำเร็จ'));return;}
  showError('');await reloadHolidays();toast('ลบวันหยุด '+d+' แล้ว');
}
</script>`;
      page(req, res, 'จัดการวันหยุด', body, script);
    }));

    // ---------- หน้า /admin/users ----------
    app.get('/admin/users', guard.page('admin'), wrap((req, res) => {
      const rows = listUsers().map((u) => {
        const id = esc(u.username);
        const roleOpts = ALL_ROLES.map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}${r === 'citizen' ? ' disabled' : ''}>${r} · ${esc(ROLE_TH[r] || r)}</option>`).join('');
        const deptOpts = [['', 'ไม่มี'], ...DEPTS.map((d) => [d, `${d} · ${DEPT_TH[d] || d}`])].map(([v, l]) => `<option value="${v}"${v === u.dept ? ' selected' : ''}>${esc(l)}</option>`).join('');
        const self = u.username === req.user.username ? ' <span class="b08-note">(บัญชีของคุณ)</span>' : '';
        return `<tr data-testid="user-row" data-username="${id}">
  <th scope="row">${esc(u.name)}<br><span class="b08-note">${id}</span>${self}</th>
  <td><label class="sr-only" for="role-${id}">บทบาทของ ${id}</label><select id="role-${id}" data-testid="user-role-select">${roleOpts}</select></td>
  <td><label class="sr-only" for="dept-${id}">แผนกของ ${id}</label><select id="dept-${id}" data-testid="user-dept-select">${deptOpts}</select></td>
  <td><button type="button" data-testid="user-save-btn" data-username="${id}" onclick="saveUser(this.dataset.username)">บันทึก</button></td>
</tr>`;
      }).join('');
      const body = `
<h1>จัดการผู้ใช้และบทบาท</h1>
<p class="b08-note">การเปลี่ยนบทบาทมีผลเมื่อผู้ใช้เข้าสู่ระบบครั้งถัดไป · เปลี่ยนบทบาทของตัวเองไม่ได้ · เจ้าหน้าที่ (officer) ต้องมีแผนก</p>
<p data-testid="action-error" role="alert" hidden></p>
<div class="table-wrap"><table>
  <caption class="sr-only">ผู้ใช้เจ้าหน้าที่และบทบาท</caption>
  <thead><tr><th scope="col">ผู้ใช้</th><th scope="col">บทบาท</th><th scope="col">แผนก</th><th scope="col">บันทึก</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
      const script = `<script>${CLIENT_COMMON}
async function saveUser(u){
  const role=document.getElementById('role-'+u).value,dept=document.getElementById('dept-'+u).value;
  const r=await api('PUT','/api/admin/users/'+encodeURIComponent(u),{role,dept});
  if(!r.ok){showError(errMsg(r,'บันทึกไม่สำเร็จ'));return;}
  showError('');document.getElementById('dept-'+u).value=r.data.dept;
  toast('บันทึก '+u+' แล้ว (มีผลเมื่อเข้าสู่ระบบครั้งถัดไป)');
}
</script>`;
      page(req, res, 'จัดการผู้ใช้', body, script);
    }));
  },
};

// ───────────────────────── self-test: node reports.js ─────────────────────────
// seed ลง DB ชั่วคราว แล้วเทียบกับ TEST-DATA §7.1 §7.2 §7.3 + ค่าผิดของ B10 (BUGS.md) + การปัดเศษ
if (require.main === module) {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const assert = require('assert');
  const dbFile = path.join(os.tmpdir(), `egov-b08-selftest-${process.pid}.db`);
  Object.assign(process.env, { TEST_MODE: '1', BUG_MODE: '', DB_PATH: dbFile });
  const ctx = require('./src/core');
  ctx.testHooks.reset();
  const cases = ctx.db.all(`SELECT case_no AS caseNo, service_id AS serviceId, status, paid_at AS paidAt, due_at AS dueAt,
    closed_at AS closedAt, owner FROM cases WHERE case_no IS NOT NULL`);
  const officers = ctx.db.all("SELECT username, name FROM users WHERE role = 'officer' ORDER BY username");
  const nowISO = ctx.clock.nowISO();
  const run = (period, service, bug = false) => computeDashboard({ cases, officers, period, service, nowISO, divideByReceived: bug });
  let n = 0;
  const check = (label, got, want) => { assert.deepStrictEqual(got, want, `${label}: ได้ ${JSON.stringify(got)} ต้องการ ${JSON.stringify(want)}`); n++; };
  const pick = (d) => [d.received, d.closed, d.onTime, d.ontimeText, d.backlog, d.overdue];
  try {
    check('now', nowISO, '2026-12-01T09:00:00+07:00');
    // §7.1 / §7.2 (ธ.ค. ตามบริการ)
    check('2026-12 ALL', pick(run('2026-12', 'ALL')), [3, 0, 0, '–', 21, 1]);
    check('2026-12 SV-01', pick(run('2026-12', 'SV-01')), [3, 0, 0, '–', 11, 1]);
    check('2026-12 SV-02', pick(run('2026-12', 'SV-02')), [0, 0, 0, '–', 7, 0]);
    check('2026-12 SV-03', pick(run('2026-12', 'SV-03')), [0, 0, 0, '–', 3, 0]);
    check('ontimePct null', run('2026-12', 'ALL').ontimePct, null);
    check('workload', run('2026-12', 'ALL').workload.map((w) => [w.username, w.count]), [['off.reg1', 3], ['off.reg2', 9], ['off.works1', 0]]);
    // §7.3 ย้อนหลัง (คงค้าง/เกินกำหนดไม่ขึ้นกับช่วง)
    const back = [
      ['2026-10', 'ALL', 1, 1, 1, '100.0%', 21, 1], ['2026-11', 'ALL', 26, 7, 6, '85.7%', 21, 1],
      ['2026-11', 'SV-01', 12, 3, 3, '100.0%', 11, 1], ['2026-11', 'SV-02', 10, 3, 2, '66.7%', 7, 0],
      ['2026-11', 'SV-03', 4, 1, 1, '100.0%', 3, 0], ['2026', 'ALL', 30, 8, 7, '87.5%', 21, 1],
      ['2026', 'SV-01', 16, 4, 4, '100.0%', 11, 1], ['2026', 'SV-02', 10, 3, 2, '66.7%', 7, 0], ['2026', 'SV-03', 4, 1, 1, '100.0%', 3, 0],
    ];
    for (const [p, s, ...want] of back) check(`${p} ${s}`, pick(run(p, s)), want);
    check('2026-11 ontimePct number', run('2026-11', 'ALL').ontimePct, 85.7);
    check('xlsx rows 2026-11', kpiRows(run('2026-11', 'ALL')), [['รับเรื่อง', '26'], ['ปิดงาน', '7'], ['ทันกำหนด %', '85.7%'], ['งานคงค้าง', '21'], ['เกินกำหนดคงค้าง', '1']]);
    check('pdf ascii 2026-11', kpiAscii(run('2026-11', 'ALL')), 'kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1');
    check('pdf ascii 2026-12', kpiAscii(run('2026-12', 'ALL')), 'kpi received=3 closed=0 ontime=- backlog=21 overdue=1');
    // B10 (BUGS.md): พ.ย. 23.1% · ปี 23.3% · ธ.ค. 0.0% · ต.ค. 100.0%
    check('B10 2026-11', run('2026-11', 'ALL', true).ontimeText, '23.1%');
    check('B10 2026', run('2026', 'ALL', true).ontimeText, '23.3%');
    check('B10 2026-12', run('2026-12', 'ALL', true).ontimeText, '0.0%');
    check('B10 2026-10', run('2026-10', 'ALL', true).ontimeText, '100.0%');
    // ขอบ "ทัน" (TC-DASH-04): due 3 ธ.ค. 16:30 · ปิด 16:29:59 / 16:30:00 ทัน · 16:30:01 ไม่ทัน
    const due = '2026-12-03T16:30:00+07:00';
    const edge = ['16:29:59', '16:30:00', '16:30:01'].map((t, i) => ({ caseNo: `X${i}`, serviceId: 'SV-01', status: i === 1 ? 'REJECTED' : 'COMPLETED', paidAt: '2026-11-30T10:00:00+07:00', dueAt: due, closedAt: `2026-12-03T${t}+07:00`, owner: null }));
    const e = computeDashboard({ cases: edge, officers: [], period: '2026-12', service: 'ALL', nowISO });
    check('edge closed/onTime', [e.closed, e.onTime, e.ontimeText], [3, 2, '66.7%']);
    check('edge Z input', inPeriod('2026-11-30T17:00:00Z', '2026-12'), true);
    // ปัดครึ่งขึ้น
    check('pct1', [pct1(6, 7), pct1(2, 3), pct1(7, 8), pct1(1, 1), pct1(1, 8), pct1(0, 3), pct1(1, 0)], [85.7, 66.7, 87.5, 100, 12.5, 0, null]);
    check('pct1 half-up', [pct1(1, 16), pct1(3, 16)], [6.3, 18.8]); // 6.25 → 6.3 · 18.75 → 18.8
    // ช่วงวันที่ Audit ตามเวลาไทย (TC-AUDIT-03)
    const [lo, hi] = dayRangeMs('2026-12-01', '2026-12-01');
    const inDay = (iso) => { const t = Date.parse(iso); return t >= lo && t < hi; };
    check('audit day range', ['2026-11-30T23:59:59+07:00', '2026-12-01T00:00:00+07:00', '2026-12-01T23:59:59+07:00', '2026-12-02T00:00:00+07:00'].map(inDay), [false, true, true, false]);
    check('intIn', [intIn(-1, 0, 100000), intIn(0, 0, 100000), intIn(100000, 0, 100000), intIn(100001, 0, 100000), intIn(2.5, 0, 9), intIn('25', 0, 99), intIn(null, 0, 9)], [null, 0, 100000, null, null, 25, null]);
    check('csv', auditCsv([{ time: 't', username: 'u', role: 'r', event: 'RETURN', caseNo: null, fromStatus: null, toStatus: null, detail: 'a,"b"' }]), `${CSV_HEADER}\nt,u,r,RETURN,,,,"a,""b"""`);
    console.log(`[B08 self-test] ผ่าน ${n} ข้อ`);
  } finally {
    try { ctx.db.raw.close(); } catch (_) { /* ignore */ }
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } }
  }
}
