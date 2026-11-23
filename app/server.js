'use strict';
// [B01] จุดเริ่ม: node server.js · env: PORT DB_PATH TEST_MODE BUG_MODE (ดู SCAFFOLD.md)
const ctx = require('./src/core');
const { createApp } = require('./src/app');

const app = createApp(); // โหลดโมดูลก่อน (extendSchema ต้องลงทะเบียนก่อน reset)
const { config, db, bugs } = ctx;

if (config.TEST_MODE || db.isEmpty()) ctx.testHooks.reset(); // TEST_MODE: เริ่มด้วยข้อมูล seed สะอาดทุกครั้ง

const server = app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`[egov] http://0.0.0.0:${config.PORT} · TEST_MODE=${config.TEST_MODE ? 1 : 0} · BUG_MODE=${bugs.list().join(',') || '-'} · DB_PATH=${config.DB_PATH}`);
  console.log(`[egov] modules: ${app.locals.modules.join(', ') || '(none)'} · clock=${ctx.clock.nowISO()}`);
});
server.requestTimeout = 60000;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.raw.close(); } catch (_) { /* */ } process.exit(0); });
