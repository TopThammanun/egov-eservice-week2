'use strict';
// [B01] ข้อผิดพลาดมาตรฐาน {"code","message"} (CONTRACT 0.6 · ตาราง 5)
// ใช้: throw new HttpError(409, 'ALREADY_CLAIMED')            → ข้อความดึงจาก MESSAGES อัตโนมัติ
//      throw new HttpError(401, 'OTP_INVALID', null, { attemptsLeft: 2 }) → ฟิลด์เพิ่มใน JSON
//      app.post('/x', wrap(async (req, res) => {...}))         → error ใน handler ส่งเป็น JSON ให้เอง
const MESSAGES = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  MISSING_DOCS: 'ยังขาดเอกสาร', // ใช้ missingDocs(names) เพื่อได้ 'ยังขาดเอกสาร: แบบแปลน, โฉนด'
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม',
  NOT_FOUND: 'ไม่พบคำขอ',
  CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
  INVALID_TIME: 'รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น ISO 8601 พร้อม offset)',
  BAD_REQUEST: 'คำขอไม่ถูกต้อง',
  INTERNAL: 'เกิดข้อผิดพลาดภายในระบบ',
};

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || MESSAGES[code] || code);
    this.status = status; this.code = code; this.extra = extra || null;
  }
}

function send(res, status, code, message, extra) {
  return res.status(status).json({ code, message: message || MESSAGES[code] || code, ...(extra || {}) });
}

/** ห่อ handler (sync/async) ให้ error ไปที่ error middleware */
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); } };

const missingDocs = (names) => new HttpError(409, 'MISSING_DOCS', `ยังขาดเอกสาร: ${names.join(', ')}`, { missing: names });

module.exports = { MESSAGES, HttpError, send, wrap, missingDocs };
