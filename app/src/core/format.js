'use strict';
// [B01] รูปแบบข้อความบนจอ (CONTRACT 0.2–0.4 · ตาราง 4) · ใช้ร่วมทุกโมดูล
const clock = require('./clock');

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

const STATUS_TH = {
  DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก',
};
const LEVEL_TH = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
const ROLE_TH = { citizen: 'ประชาชน', officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย', executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ' };
const DEPT_TH = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };
const LANDING = { citizen: '/citizen', officer: '/officer/queue', head: '/head/approvals', executive: '/dashboard', auditor: '/audit', admin: '/admin/services' };
const SERVICE_NAME = { 'SV-01': 'ขอหนังสือรับรอง', 'SV-02': 'ขออนุญาตประกอบกิจการ', 'SV-03': 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร' };

/** '2026-12-04T16:30:00+07:00' → '4 ธ.ค. 2569 16:30' · 'YYYY-MM-DD' → '4 ธ.ค. 2569' */
function thaiDate(iso, { time = true } = {}) {
  if (!iso) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const p = clock.parts(iso);
  const d = `${p.d} ${MONTHS[p.m - 1]} ${p.y + 543}`;
  return dateOnly || !time ? d : `${d} ${clock.pad(p.hh)}:${clock.pad(p.mm)}`;
}
/** 1010 → '฿1,010' */
function money(n) { return '฿' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
/** '3100600987659' → '3-1006-00987-65-9' */
function formatId(id) { const s = String(id || ''); return s.length === 13 ? `${s[0]}-${s.slice(1, 5)}-${s.slice(5, 10)}-${s.slice(10, 12)}-${s[12]}` : s; }
/** '3100600987659' หรือ 3 หลักท้าย '659' → 'X-XXXX-XXXXX-65-9' */
function maskId(idOrLast3) { const s = String(idOrLast3 || ''); const t = s.slice(-3); return `X-XXXX-XXXXX-${t.slice(0, 2)}-${t[2] || ''}`; }
/** 'สมชาย ใจดี' → 'สมชาย ใ***' (A-54) */
function maskName(name) {
  const [first, ...rest] = String(name || '').trim().split(/\s+/);
  const last = rest.join(' ');
  return last ? `${first} ${Array.from(last)[0]}***` : first;
}
/** HTML escape */
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
/** <time data-testid data-iso> (CONTRACT 0.3) */
function timeEl(iso, testid = '', opts) {
  if (!iso) return `<span${testid ? ` data-testid="${testid}"` : ''}>–</span>`;
  return `<time${testid ? ` data-testid="${testid}"` : ''} data-iso="${esc(iso)}" datetime="${esc(iso)}">${esc(thaiDate(iso, opts))}</time>`;
}
/** ป้ายสถานะ (ข้อความ + สี · ไม่ใช้สีอย่างเดียว) */
function statusEl(status, testid = 'case-status') { return `<span class="badge st-${esc(status)}" data-testid="${testid}" data-status="${esc(status)}">${esc(STATUS_TH[status] || status)}</span>`; }
function levelEl(level, testid = 'sla-level') { return `<span class="badge lv-${esc(level)}" data-testid="${testid}" data-level="${esc(level)}">${esc(LEVEL_TH[level] || level)}</span>`; }

module.exports = { MONTHS, STATUS_TH, LEVEL_TH, ROLE_TH, DEPT_TH, LANDING, SERVICE_NAME, thaiDate, money, formatId, maskId, maskName, esc, timeEl, statusEl, levelEl };
