'use strict';
// [B05] ไฟล์ผลของบล็อก B05 · โค้ดจริงอยู่ที่ src/modules/officer.js (loader ของ B01 โหลดจาก src/modules/ เท่านั้น)
// ครอบคลุม: /officer/queue · /officer/cases/:caseNo · /head/approvals · /api/officer/queue · /api/officer/cases/:no/claim|return|forward|issue|unmask
//           /api/cases/:no/approve|reject · หน้าคำขอแสดงไฟล์แนบตาม BR-29 (endpoint ไฟล์เป็นของ B04)
// FR-12..16 FR-21 FR-29 · BR-16 คิว · BR-17 รับเรื่อง 409 · BR-18 เพดาน 10 · BR-19 ตีกลับ ≤ 2 / เหตุผล ≥ 10 · BR-21 อำนาจ · BR-24 ปิดบัง+UNMASK · BR-29 ไฟล์แนบ
// BUG_MODE: B07 B08 B09 B11 B12
module.exports = require('./src/modules/officer');
