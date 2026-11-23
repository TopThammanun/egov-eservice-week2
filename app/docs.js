// [B06] ไฟล์ผลของบล็อก B06 · โค้ดจริงอยู่ที่ src/modules/docs.js (loader ของ B01 โหลดจาก src/modules/ เท่านั้น)
// ครอบคลุม: /verify/:code · GET /api/verify/:code · GET /api/documents/:docNo/pdf · hooks.provide('issueDocument', ...) ฯลฯ
// FR-17 FR-18 BR-23 · DOC-<พ.ศ.>-###### · HMAC-SHA256 (ctx.sign) · อายุ SV-01 ออก+89 วัน / SV-02,03 ครบรอบปี−1 (29 ก.พ. → 28 ก.พ.)
module.exports = require('./src/modules/docs');
