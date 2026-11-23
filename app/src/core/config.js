'use strict';
// [B01] ค่าตั้งจากตัวแปรสภาพแวดล้อม (อ่านครั้งเดียวตอนเริ่ม)
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_MODE = process.env.TEST_MODE === '1';

function firstExisting(list) {
  for (const p of list) { try { if (p && fs.existsSync(p)) return p; } catch (_) { /* ignore */ } }
  return null;
}

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT || 3000),
  DB_PATH: path.resolve(process.env.DB_PATH || path.join(ROOT, 'data', 'egov.db')),
  TEST_MODE,
  BUG_MODE_RAW: process.env.BUG_MODE || '',
  // คีย์ทดสอบ (ตัวจำลองทั้งหมด ไม่ใช่คีย์จริง) · ตั้งทับได้ด้วย env
  DATA_KEY: process.env.DATA_KEY || 'egov-test-data-key-AES-256-GCM-not-for-production',
  DOC_SIGN_KEY: process.env.DOC_SIGN_KEY || 'egov-test-doc-hmac-key-not-for-production',
  LOOKUP_KEY: process.env.LOOKUP_KEY || 'egov-test-lookup-hmac-key',
  DEFAULT_NOW: '2026-12-01T09:00:00+07:00',
  OTP_CODE: '123456',
  SESSION_COOKIE: 'sid',
  // ฟอนต์ไทยสำหรับ PDF (ติดตั้งใน Docker ด้วย fonts-tlwg-garuda-ttf) · null = ไม่มี
  THAI_FONT: firstExisting([
    process.env.THAI_FONT,
    '/usr/share/fonts/truetype/tlwg/Garuda.ttf',
    '/usr/share/fonts/truetype/tlwg/Loma.ttf',
    '/usr/share/fonts/truetype/tlwg/Sarabun.ttf',
  ]),
};
