// [B07] ไฟล์ผลของบล็อก B07 · โค้ดจริงอยู่ที่ src/modules/notify.js (loader ของ B01 โหลดจาก src/modules/ เท่านั้น)
// ครอบคลุม: hooks.beforeRequest → ยกเลิก NEED_FIX ที่ครบ 168 ชม. + ประเมินแจ้งเตือน near/overdue (BR-14 BR-15 BR-20 · A-30 A-31 A-46)
//           GET /notifications · GET /api/notifications (CONTRACT §2.12 §6.3) · provide bellCount/notificationsOf/evaluateNotifications/autoCancelExpired
module.exports = require('./src/modules/notify');
