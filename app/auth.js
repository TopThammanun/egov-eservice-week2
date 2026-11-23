'use strict';
// [B02] ไฟล์ผลของบล็อก B02 · โค้ดจริงอยู่ที่ src/modules/auth.js (loader ของ B01 โหลดจาก src/modules/ เท่านั้น)
// ครอบคลุม: /login /register /api/auth/thaid/start|verify /api/auth/register /api/auth/staff/login /api/auth/logout /api/me
// BR-01 checksum · BR-02 OTP ล็อก 3 ครั้ง/15 นาที · BR-03 ลงทะเบียน · BR-21 401/403 ผ่าน ctx.session.guard
module.exports = require('./src/modules/auth');
