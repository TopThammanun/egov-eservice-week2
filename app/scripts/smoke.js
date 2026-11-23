#!/usr/bin/env node
'use strict';
// [B01] smoke test ของโครง: BASE_URL=http://127.0.0.1:3000 npm run smoke  (ต้องรันเว็บด้วย TEST_MODE=1)
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
let fail = 0;
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) { /* */ }
  return { status: r.status, data };
}
function check(name, cond, got) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  got=' + JSON.stringify(got)}`); if (!cond) fail++; }
(async () => {
  let r = await call('GET', '/api/health');
  check('health 200 {"status":"ok"}', r.status === 200 && JSON.stringify(r.data) === '{"status":"ok"}', r);
  r = await call('POST', '/api/test/reset');
  check('reset', r.status === 200 && r.data.ok === true && r.data.now === '2026-12-01T09:00:00+07:00', r);
  r = await call('GET', '/api/test/clock');
  check('clock get', r.data && r.data.now === '2026-12-01T09:00:00+07:00', r);
  r = await call('PUT', '/api/test/clock', { now: '2026-12-01T16:30:00' });
  check('clock no offset → 400 INVALID_TIME', r.status === 400 && r.data.code === 'INVALID_TIME', r);
  r = await call('PUT', '/api/test/clock', { now: '2026-12-01T09:10:00+07:00' });
  check('clock put', r.status === 200 && r.data.now === '2026-12-01T09:10:00+07:00', r);
  r = await call('POST', '/api/test/payments/PP-0001/pay', { amount: 500 });
  check('PP-0001 age 15:00 → 410 QR_EXPIRED', r.status === 410 && r.data.code === 'QR_EXPIRED', r);
  await call('PUT', '/api/test/clock', { now: '2026-12-01T09:09:59+07:00' });
  r = await call('POST', '/api/test/payments/PP-0001/pay', { amount: 499 });
  check('amount 499 → 422', r.status === 422 && r.data.code === 'AMOUNT_MISMATCH', r);
  r = await call('POST', '/api/test/payments/PP-0001/pay', { amount: 500 });
  check('pay → EG-2569-000031', r.status === 200 && r.data.caseNo === 'EG-2569-000031' && r.data.receiptNo === 'RC-2569-000031' && r.data.duplicate === false, r);
  r = await call('POST', '/api/test/payments/PP-0001/pay', { amount: 500 });
  check('pay again → duplicate', r.status === 200 && r.data.duplicate === true && r.data.caseNo === 'EG-2569-000031', r);
  r = await call('POST', '/api/test/payments/PP-9999/pay', { amount: 1 });
  check('unknown ref → 404', r.status === 404, r);
  r = await call('POST', '/api/test/documents/DOC-2569-000001/tamper');
  check('tamper', r.status === 200 && r.data.ok === true, r);
  r = await call('POST', '/api/test/documents/DOC-0/tamper');
  check('tamper unknown → 404', r.status === 404, r);
  r = await call('POST', '/api/test/reset');
  check('reset again', r.status === 200, r);
  console.log(fail ? `${fail} FAILED` : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
