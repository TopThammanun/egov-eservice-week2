import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const staffPassword = 'Test@1234';
const citizenId = '1101700123456';
const otp = '123456';
const url = (path: string) => new URL(path, baseURL).toString();
const iso = (locator: ReturnType<Page['getByTestId']>, value: string) => expect(locator).toHaveAttribute('data-iso', value);

async function reset(request: APIRequestContext) {
  const r = await request.post(url('/api/test/reset'));
  expect(r.status()).toBe(200);
}
async function clock(request: APIRequestContext, now: string) {
  const r = await request.put(url('/api/test/clock'), { data: { now } });
  expect(r.status()).toBe(200);
}
async function staff(page: Page, username: string) {
  const r = await page.request.post(url('/api/auth/staff/login'), { data: { username, password: staffPassword } });
  expect(r.status()).toBe(200);
}
async function citizen(page: Page, id = citizenId) {
  const start = await page.request.post(url('/api/auth/thaid/start'), { data: { idNo: id } });
  expect(start.status()).toBe(200);
  const verify = await page.request.post(url('/api/auth/thaid/verify'), { data: { idNo: id, otp } }); // [B12] CONTRACT 6.1 ต้องส่ง idNo
  expect(verify.status()).toBe(200);
}
async function api(page: Page, method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string, data?: any) {
  const endpoint = url(path);
  if (method === 'get') return page.request.get(endpoint);
  if (method === 'post') return page.request.post(endpoint, data === undefined ? {} : { data });
  if (method === 'put') return page.request.put(endpoint, data === undefined ? {} : { data });
  if (method === 'patch') return page.request.patch(endpoint, data === undefined ? {} : { data });
  return page.request.delete(endpoint, data === undefined ? {} : { data });
}
async function json(response: Awaited<ReturnType<typeof api>>) { return response.json(); }
async function open(page: Page, path: string) { await page.goto(url(path)); }
async function status(page: Page, text: string, code: string) {
  await expect(page.getByTestId('case-status')).toHaveText(text);
  await expect(page.getByTestId('case-status')).toHaveAttribute('data-status', code);
}
async function clickAction(page: Page, testid: string, reason?: string) {
  if (reason !== undefined) {
    const field = page.getByTestId(testid === 'return-btn' ? 'return-reason' : 'reject-reason');
    await field.fill(reason);
  }
  await page.getByTestId(testid).click();
}

// [B12] helper เพิ่ม: NEW_PAID ตาม TEST-PLAN §0 · ใช้ page.request (cookie เดียวกับหน้า)
function pdfBuf(size = 1024): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(size - head.length - tail.length, 0x20), tail]);
}
async function newPaid(page: Page, { id = citizenId, service = 'SV-01', qty = 1, areaSqm, at }: { id?: string; service?: string; qty?: number; areaSqm?: number; at?: string } = {}) {
  if (at) await clock(page.request, at);
  await citizen(page, id);
  const body: Record<string, unknown> = { serviceId: service };
  if (service === 'SV-01') body.qty = qty; if (service === 'SV-03') body.areaSqm = areaSqm;
  const d = await api(page, 'post', '/api/drafts', body); expect(d.status()).toBe(201);
  const draft = await d.json();
  const files = service === 'SV-03' ? [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']] : service === 'SV-02' ? [['id-card', 'id-card.pdf'], ['map', 'map.pdf']] : [['id-card', 'id-card.pdf']];
  for (const [docKey, name] of files) {
    const r = await page.request.post(url(`/api/drafts/${draft.draftId}/files`), { multipart: { docKey, file: { name, mimeType: 'application/pdf', buffer: pdfBuf() } } });
    expect(r.status()).toBe(201);
  }
  const p = await api(page, 'post', `/api/drafts/${draft.draftId}/payment`); expect(p.status()).toBe(201);
  const pay = await p.json();
  const r = await api(page, 'post', `/api/test/payments/${pay.ref}/pay`, { amount: pay.amount }); expect(r.status()).toBe(200);
  return (await json(await api(page, 'get', `/api/payments/${pay.ref}`))).caseNo as string;
}
/** [เติมตามการ์ด] ตรวจข้อความที่ดึงออกมาว่าไม่มีข้อมูลส่วนบุคคล (BR-24 · DECISIONS 18) */
function noPii(text: string, what: string) {
  expect(text, what).not.toMatch(/\d{13}|0\d{9}/);
  for (const name of ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ']) expect(text, what).not.toContain(name);
}
/** [เติมตามการ์ด] ดึงข้อความที่ "พิมพ์" ใน PDF (ตัวดำเนินการ TJ · เว็บออก PDF แบบไม่บีบอัด) → 1 สมาชิกต่อ 1 บรรทัดข้อความ
 *  ใช้ตรวจบรรทัด ASCII ที่เครื่องอ่านได้ (CONTRACT 7) และตรวจ PII บนข้อความ ไม่ใช่ไบต์ดิบ (เลข offset ใน xref ไม่นับ) */
function pdfTextLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const m of buf.toString('latin1').matchAll(/\[((?:<[0-9a-fA-F]*>\s*-?[\d.]*\s*)+)\]\s*TJ/g)) {
    lines.push(Buffer.from([...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => x[1]).join(''), 'hex').toString('latin1'));
  }
  return lines;
}
const MASKED = /^X-XXXX-XXXXX-\d{2}-\d$/;
const levelText: Record<string, string> = { normal: 'ปกติ', near: 'ใกล้ครบกำหนด', overdue: 'เกินกำหนด', paused: 'หยุดนับ', closed: 'ปิดแล้ว' };
const statusText: Record<string, string> = { DRAFT: 'ร่าง', PENDING_PAYMENT: 'รอชำระเงิน', SUBMITTED: 'ส่งคำขอแล้ว', IN_REVIEW: 'กำลังตรวจสอบ', NEED_FIX: 'รอแก้ไขเอกสาร', PENDING_APPROVAL: 'รออนุมัติ', APPROVED: 'อนุมัติ', COMPLETED: 'เสร็จสิ้น', REJECTED: 'ไม่อนุมัติ', CANCELLED: 'ยกเลิก' };
async function notiPairs(page: Page, user: string) {
  await staff(page, user);
  const items = (await json(await api(page, 'get', '/api/notifications'))).items as { caseNo: string; level: string }[];
  return items.map(x => `${x.caseNo.slice(-6)}:${x.level}`).sort();
}

test.describe('ชุด B · SLA / NOTI / WORKFLOW / DOC / PDPA / DASH / AUDIT / ADMIN / NFR', () => {
  test('TC-SLA-01 กำหนดเสร็จข้ามวันหยุดและวันหยุดยาว', async ({ page }) => {
    // [fix] ตามการ์ด TEST-PLAN TC-SLA-01: ตาราง 9 แถว NEW_PAID (a-i) ตรวจ dueAt จริงที่คิดตอนชำระ ไม่ใช่แค่ seed
    const rows: { r: string; service: string; qty?: number; areaSqm?: number; at: string; due: string; text?: string }[] = [
      { r: 'a', service: 'SV-01', at: '2026-12-01T09:00:00+07:00', due: '2026-12-04T16:30:00+07:00', text: '4 ธ.ค. 2569 16:30' },
      { r: 'b', service: 'SV-01', at: '2026-12-01T16:29:00+07:00', due: '2026-12-04T16:30:00+07:00' },
      { r: 'c', service: 'SV-01', at: '2026-12-01T16:30:00+07:00', due: '2026-12-08T16:30:00+07:00', text: '8 ธ.ค. 2569 16:30' },
      { r: 'd', service: 'SV-01', at: '2026-12-04T10:00:00+07:00', due: '2026-12-11T16:30:00+07:00', text: '11 ธ.ค. 2569 16:30' },
      { r: 'e', service: 'SV-01', at: '2026-12-05T10:00:00+07:00', due: '2026-12-14T16:30:00+07:00', text: '14 ธ.ค. 2569 16:30' },
      { r: 'f', service: 'SV-02', at: '2026-12-01T09:00:00+07:00', due: '2026-12-17T16:30:00+07:00' },
      { r: 'g', service: 'SV-03', areaSqm: 100, at: '2026-12-01T09:00:00+07:00', due: '2026-12-24T16:30:00+07:00' },
      { r: 'h', service: 'SV-01', at: '2026-12-29T10:00:00+07:00', due: '2027-01-05T16:30:00+07:00', text: '5 ม.ค. 2570 16:30' },
      { r: 'i', service: 'SV-01', at: '2026-12-31T23:59:00+07:00', due: '2027-01-07T16:30:00+07:00', text: '7 ม.ค. 2570 16:30' },
    ];
    for (const row of rows) {
      await reset(page.request);
      await citizen(page);
      const caseNo = await newPaid(page, { service: row.service, qty: row.qty, areaSqm: row.areaSqm, at: row.at });
      expect(caseNo, `แถว ${row.r}`).toBe('EG-2569-000031');
      const c = await json(await api(page, 'get', `/api/cases/${caseNo}`));
      expect(c.dueAt, `แถว ${row.r} dueAt`).toBe(row.due);
      await open(page, `/citizen/cases/${caseNo}`);
      await iso(page.getByTestId('sla-due'), row.due);
      if (row.text) await expect(page.getByTestId('sla-due')).toContainText(row.text);
    }
    // seed (คงการตรวจเดิม)
    const expected = [
      ['EG-2569-000020', '2026-11-30T16:30:00+07:00'],
      ['EG-2569-000022', '2026-12-01T16:30:00+07:00'],
      ['EG-2569-000025', '2026-12-03T16:30:00+07:00'],
      ['EG-2569-000010', '2026-12-03T16:30:00+07:00'],
      ['EG-2569-000012', '2026-12-11T16:30:00+07:00'],
    ];
    await reset(page.request);
    await staff(page, 'off.reg1');
    for (const [caseNo, dueAt] of expected) {
      const r = await api(page, 'get', `/api/cases/${caseNo}`);
      expect((await json(r)).dueAt).toBe(dueAt);
    }
  });

  test('TC-SLA-02 SLA หยุดนับระหว่าง NEED_FIX และกลับมาต่อหลังส่งแก้', async ({ page }) => {
    await reset(page.request); await clock(page.request, '2026-12-01T09:00:00+07:00'); await citizen(page);
    await open(page, '/citizen/cases/EG-2569-000017');
    await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', 'paused');
    await iso(page.getByTestId('sla-due'), '2026-11-27T16:30:00+07:00');
    const r = await api(page, 'post', '/api/cases/EG-2569-000017/resubmit');
    expect(r.status()).toBe(200);
    const c = await json(await api(page, 'get', '/api/cases/EG-2569-000017'));
    expect(c.status).toBe('IN_REVIEW'); expect(c.dueAt).toBe('2026-12-01T16:30:00+07:00');
    expect(c.owner).toBe('off.reg1'); expect(c.slaLevel).toBe('near'); // ส่วน 2: เหลือ 0 = ใกล้ครบกำหนด
    await open(page, '/citizen/cases/EG-2569-000017'); await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW');
    await expect(page.getByTestId('sla-level')).toHaveText('ใกล้ครบกำหนด');
    // ส่วน 3: ส่งแก้ ศ. 4 ธ.ค. 10:00 → หยุดนับ 5 วันทำการ (30 พ.ย., 1, 2, 3, 4 ธ.ค.)
    await reset(page.request); await clock(page.request, '2026-12-04T10:00:00+07:00'); await citizen(page);
    expect((await api(page, 'post', '/api/cases/EG-2569-000017/resubmit')).status()).toBe(200);
    const c3 = await json(await api(page, 'get', '/api/cases/EG-2569-000017'));
    expect(c3.dueAt, 'ส่วน 3').toBe('2026-12-04T16:30:00+07:00'); expect(c3.slaLevel, 'ส่วน 3').toBe('near');

    // [fix] ส่วน 1/4/5 ตามการ์ด TEST-PLAN TC-SLA-02: คำขอใหม่ที่ชำระ แล้วตีกลับ/ส่งแก้ (ใช้ dueAt ที่คิดตอนชำระจริง)
    const scenario = async (returnAt: string, fixAt: string, due: string, level: string, fixDeadline: string, dueText?: string) => {
      await reset(page.request); await citizen(page);
      const no = await newPaid(page, { at: '2026-12-01T09:00:00+07:00' });
      expect(no).toBe('EG-2569-000031');
      await clock(page.request, returnAt); await staff(page, 'off.reg1');
      expect((await api(page, 'post', `/api/officer/cases/${no}/claim`)).status()).toBe(200);
      expect((await api(page, 'post', `/api/officer/cases/${no}/return`, { reason: 'xxxxxxxxxx' })).status()).toBe(200);
      await clock(page.request, fixAt); await citizen(page);
      // ระหว่างรอแก้ไข: สถานะ NEED_FIX · ระดับ "หยุดนับ" · เส้นตายแก้ไข = เวลาตีกลับ + 168 ชม.
      const mid = await json(await api(page, 'get', `/api/cases/${no}`));
      expect(mid.status).toBe('NEED_FIX'); expect(mid.slaLevel).toBe('paused'); expect(mid.fixDeadline, `fixDeadline ${returnAt}`).toBe(fixDeadline);
      await open(page, `/citizen/cases/${no}`); await status(page, 'รอแก้ไขเอกสาร', 'NEED_FIX');
      await expect(page.getByTestId('sla-level')).toHaveText('หยุดนับ'); await expect(page.getByTestId('sla-level')).toHaveAttribute('data-level', 'paused');
      await iso(page.getByTestId('fix-deadline'), fixDeadline);
      expect((await api(page, 'post', `/api/cases/${no}/resubmit`)).status()).toBe(200);
      const cc = await json(await api(page, 'get', `/api/cases/${no}`));
      expect(cc.status).toBe('IN_REVIEW'); expect(cc.owner).toBe('off.reg1');
      expect(cc.dueAt, `${returnAt} -> ${fixAt}`).toBe(due); expect(cc.slaLevel).toBe(level);
      await open(page, `/citizen/cases/${no}`); await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW'); await iso(page.getByTestId('sla-due'), due);
      if (dueText) await expect(page.getByTestId('sla-due')).toContainText(dueText);
      await expect(page.getByTestId('sla-level')).toHaveText(levelText[level]);
    };
    await scenario('2026-12-02T11:00:00+07:00', '2026-12-03T10:00:00+07:00', '2026-12-08T16:30:00+07:00', 'normal', '2026-12-09T11:00:00+07:00', '8 ธ.ค. 2569 16:30'); // ส่วน 1
    await scenario('2026-12-02T09:00:00+07:00', '2026-12-02T15:00:00+07:00', '2026-12-04T16:30:00+07:00', 'normal', '2026-12-09T09:00:00+07:00'); // ส่วน 4 (หยุด 0 วัน) · BR-14: พ.2 เหลือ 2 วัน = ปกติ
    await scenario('2026-12-04T10:00:00+07:00', '2026-12-08T17:00:00+07:00', '2026-12-08T16:30:00+07:00', 'overdue', '2026-12-11T10:00:00+07:00'); // ส่วน 5
  });

  test('TC-SLA-03 ระดับเตือนรวมขอบเวลาและสถานะปิด/หยุดนับ', async ({ page }) => {
    // [B12] เขียนใหม่ตาม TEST-PLAN ส่วน A/B/C (ของเดิมใช้สมชายเปิดคำขอของสมหญิง → 404 และไม่มีส่วน A/B)
    const check = async (path: string, caseNo: string, level: string, viaApi = true) => {
      await open(page, path);
      await expect(page.getByTestId('sla-level'), `${caseNo} ${path}`).toHaveAttribute('data-level', level);
      await expect(page.getByTestId('sla-level')).toHaveText(levelText[level]);
      if (viaApi) expect((await json(await api(page, 'get', `/api/cases/${caseNo}`))).slaLevel, caseNo).toBe(level);
    };
    // ส่วน A: คำขอใหม่ …000031 กำหนด ศ. 4 ธ.ค. 16:30
    await reset(page.request);
    const no = await newPaid(page, { at: '2026-12-01T09:00:00+07:00' });
    expect(no).toBe('EG-2569-000031');
    expect((await json(await api(page, 'get', `/api/cases/${no}`))).dueAt).toBe('2026-12-04T16:30:00+07:00');
    for (const [t, level] of [['2026-12-01T09:00:00+07:00', 'normal'], ['2026-12-02T09:00:00+07:00', 'normal'], ['2026-12-03T09:00:00+07:00', 'near'],
      ['2026-12-04T16:30:00+07:00', 'near'], ['2026-12-04T16:30:01+07:00', 'overdue'], ['2026-12-04T16:31:00+07:00', 'overdue'], ['2026-12-05T10:00:00+07:00', 'overdue']]) {
      await clock(page.request, t); await check(`/citizen/cases/${no}`, no, level);
    }
    // ส่วน B: seed …000016 กำหนด อ. 8 ธ.ค. 16:30
    await reset(page.request); await staff(page, 'off.reg1');
    for (const [t, level] of [['2026-12-03T09:00:00+07:00', 'normal'], ['2026-12-04T09:00:00+07:00', 'near'], ['2026-12-08T16:30:00+07:00', 'near'], ['2026-12-08T16:31:00+07:00', 'overdue']]) {
      await clock(page.request, t); await check('/officer/cases/EG-2569-000016', 'EG-2569-000016', level);
    }
    // ส่วน C: seed ที่ 09:00 ผ่านคิวและหน้าเคส
    await reset(page.request); await staff(page, 'off.reg1'); await open(page, '/officer/queue');
    for (const [n, level] of [['000020', 'overdue'], ['000022', 'near'], ['000024', 'near'], ['000025', 'normal']]) {
      const row = page.locator(`[data-testid="queue-row"][data-case-no="EG-2569-${n}"]`);
      await expect(row).toHaveAttribute('data-sla-level', level);
      await expect(row.getByTestId('row-sla-level')).toHaveText(levelText[level]);
    }
    for (const [n, level] of [['000020', 'overdue'], ['000022', 'near'], ['000024', 'near'], ['000025', 'normal']]) await check(`/officer/cases/EG-2569-${n}`, `EG-2569-${n}`, level);
    await citizen(page); await check('/citizen/cases/EG-2569-000017', 'EG-2569-000017', 'paused');
    await citizen(page, '3100600987659'); await check('/citizen/cases/EG-2569-000001', 'EG-2569-000001', 'closed');
    await staff(page, 'off.reg1');
    await clock(page.request, '2026-12-01T16:30:00+07:00'); await check('/officer/cases/EG-2569-000022', 'EG-2569-000022', 'near');
    await clock(page.request, '2026-12-01T16:31:00+07:00'); await check('/officer/cases/EG-2569-000022', 'EG-2569-000022', 'overdue');
  });

  test('TC-NOTI-01 สร้างแจ้งเตือนให้ผู้รับตามระดับและแผนก', async ({ page }) => {
    await reset(page.request); await staff(page, 'off.reg1'); await open(page, '/notifications');
    const expected: Record<string, number> = { 'off.reg1': 3, 'off.reg2': 1, head1: 1, 'off.works1': 0 };
    for (const [user, count] of Object.entries(expected)) {
      // A new login replaces the current staff session; request evaluation is triggered by opening the list.
      await staff(page, user); await open(page, '/notifications');
      const result = await json(await api(page, 'get', '/api/notifications'));
      expect(result.items).toHaveLength(count);
      await expect(page.getByTestId('bell-count')).toHaveText(String(count));
      if (!count) await expect(page.getByTestId('noti-empty')).toHaveText('ไม่มีแจ้งเตือน');
    }
    await staff(page, 'off.reg1');
    const n = await json(await api(page, 'get', '/api/notifications'));
    expect(n.items.map((x: any) => [x.caseNo, x.level])).toEqual([
      ['EG-2569-000024', 'near'], ['EG-2569-000022', 'near'], ['EG-2569-000020', 'overdue'],
    ]);
    // [เติมตามการ์ด] ข้อความรายการ + data-level บนจอ · รายการของแต่ละคน
    await open(page, '/notifications'); await expect(page.getByTestId('noti-item')).toHaveCount(3);
    await expect(page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000024"][data-level="near"]')).toContainText('คำขอ EG-2569-000024 ใกล้ครบกำหนด');
    await expect(page.locator('[data-testid="noti-item"][data-case-no="EG-2569-000020"][data-level="overdue"]')).toContainText('คำขอ EG-2569-000020 เกินกำหนด');
    expect(await notiPairs(page, 'off.reg2')).toEqual(['000024:near']);
    expect(await notiPairs(page, 'head1')).toEqual(['000020:overdue']); // ใกล้ครบกำหนดไม่แจ้งหัวหน้า
    expect(await notiPairs(page, 'off.works1')).toEqual([]);
    // ต่อ: 16:31 แล้วมี request ใด ๆ → …000022 เกินกำหนด
    await clock(page.request, '2026-12-01T16:31:00+07:00'); await api(page, 'get', '/api/me');
    expect(await notiPairs(page, 'off.reg1')).toEqual(['000020:overdue', '000022:near', '000022:overdue', '000024:near']);
    expect(await notiPairs(page, 'head1')).toEqual(['000020:overdue', '000022:overdue']);
    expect(await notiPairs(page, 'off.reg2')).toEqual(['000024:near']);
  });

  test('TC-NOTI-02 ไม่แจ้งซ้ำและเพิ่มรายการเมื่อระดับเปลี่ยน', async ({ page }) => {
    // [B12] เขียนใหม่ตาม TEST-PLAN ส่วน A/B/C · ไม่ assert ลำดับรายการ (CONTRACT ไม่กำหนดลำดับ)
    // ส่วน A
    await reset(page.request); await staff(page, 'off.reg1');
    for (const u of ['off.reg1', 'off.reg2', 'head1', 'off.works1']) { await staff(page, u); await open(page, '/notifications'); }
    await clock(page.request, '2026-12-01T16:31:00+07:00'); await api(page, 'get', '/api/me');
    const reg1A = ['000020:overdue', '000022:near', '000022:overdue', '000024:near'];
    const headA = ['000020:overdue', '000022:overdue'];
    expect(await notiPairs(page, 'off.reg1')).toEqual(reg1A);
    expect(await notiPairs(page, 'head1')).toEqual(headA);
    expect(await notiPairs(page, 'off.reg2')).toEqual(['000024:near']);
    for (const u of ['off.reg1', 'head1']) {
      await staff(page, u);
      for (let i = 0; i < 3; i++) { await open(page, '/notifications'); await api(page, 'get', '/api/notifications'); }
      for (let i = 0; i < 2; i++) await open(page, '/officer/queue');
    }
    expect(await notiPairs(page, 'off.reg1')).toEqual(reg1A);
    await open(page, '/notifications'); await expect(page.getByTestId('bell-count')).toHaveText('4'); await expect(page.getByTestId('noti-item')).toHaveCount(4);
    expect(await notiPairs(page, 'head1')).toEqual(headA);
    await open(page, '/notifications'); await expect(page.getByTestId('bell-count')).toHaveText('2');
    // ส่วน B: request แรกที่ ส. 5 ธ.ค. 10:00 (TEST-DATA 8.1)
    await reset(page.request); await clock(page.request, '2026-12-05T10:00:00+07:00'); await staff(page, 'off.reg1');
    const od = (xs: string[]) => xs.map(x => `${x}:overdue`);
    const expectedB: Record<string, string[]> = {
      'off.reg1': od(['000020', '000022', '000023', '000024', '000028', '000029', '000030']),
      'off.reg2': [...od(['000013', '000015', '000024', '000025', '000026', '000027', '000028', '000029', '000030']), '000016:near'].sort(),
      'off.works1': od(['000010']),
      head1: [...od(['000010', '000013', '000014', '000015', '000020', '000022', '000023', '000024', '000025', '000026', '000027', '000028', '000029', '000030']), '000011:near'].sort(),
    };
    for (const [u, pairs] of Object.entries(expectedB)) {
      expect(await notiPairs(page, u), u).toEqual(pairs.sort());
      await open(page, '/notifications'); await expect(page.getByTestId('bell-count')).toHaveText(String(pairs.length));
    }
    // ส่วน C: ขั้นรออนุมัติ / รอออกเอกสาร (TEST-DATA 8.2)
    const of = (pairs: string[], n: string) => pairs.filter(p => p.startsWith(n));
    await reset(page.request); await clock(page.request, '2026-12-04T09:00:00+07:00'); await staff(page, 'head1');
    expect(of(await notiPairs(page, 'head1'), '000014')).toEqual(['000014:near']);
    expect(of(await notiPairs(page, 'off.reg1'), '000014')).toEqual([]); expect(of(await notiPairs(page, 'off.reg2'), '000014')).toEqual([]);
    await clock(page.request, '2026-12-04T16:31:00+07:00'); await api(page, 'get', '/api/me');
    expect(of(await notiPairs(page, 'head1'), '000014')).toEqual(['000014:near', '000014:overdue']);
    expect(of(await notiPairs(page, 'off.reg1'), '000014')).toEqual([]); expect(of(await notiPairs(page, 'off.reg2'), '000014')).toEqual([]);
    await clock(page.request, '2026-12-08T09:00:00+07:00'); await api(page, 'get', '/api/me');
    expect(of(await notiPairs(page, 'off.reg1'), '000019')).toEqual(['000019:near']);
    expect(of(await notiPairs(page, 'off.reg2'), '000019')).toEqual([]); expect(of(await notiPairs(page, 'head1'), '000019')).toEqual([]);
    await clock(page.request, '2026-12-09T16:31:00+07:00'); await api(page, 'get', '/api/me');
    expect(of(await notiPairs(page, 'off.reg1'), '000019')).toEqual(['000019:near', '000019:overdue']);
    expect(of(await notiPairs(page, 'head1'), '000019')).toEqual(['000019:overdue']);
  });

  test('TC-WORKFLOW-01 เจ้าหน้าที่ผู้ถืออนุมัติและออกเอกสารได้', async ({ page }) => {
    await reset(page.request); await staff(page, 'off.reg2'); await open(page, '/officer/cases/EG-2569-000025');
    await expect(page.getByTestId('case-fee')).toHaveText('฿60');
    for (const id of ['approve-btn', 'return-btn', 'reject-btn']) await expect(page.getByTestId(id)).toHaveCount(1);
    await expect(page.getByTestId('forward-btn')).toHaveCount(0); await expect(page.getByTestId('issue-btn')).toHaveCount(0);
    await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW');
    // ขั้น 2: off.reg1 ไม่ใช่ผู้ถือ …000026 → 403 FORBIDDEN
    await staff(page, 'off.reg1');
    const notOwner = await api(page, 'post', '/api/cases/EG-2569-000026/approve'); expect(notOwner.status()).toBe(403); expect((await json(notOwner)).code).toBe('FORBIDDEN');
    await staff(page, 'off.reg2'); await open(page, '/officer/cases/EG-2569-000025');
    await clickAction(page, 'approve-btn'); await status(page, 'อนุมัติ', 'APPROVED');
    await expect(page.getByTestId('issue-btn')).toHaveCount(1); await expect(page.getByTestId('approve-btn')).toHaveCount(0);
    await clickAction(page, 'issue-btn'); await status(page, 'เสร็จสิ้น', 'COMPLETED');
    await expect(page.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
    await iso(page.getByTestId('closed-at'), '2026-12-01T09:00:00+07:00');
    await expect(page.getByTestId('sla-level')).toHaveText('ปิดแล้ว');
    const verify = await page.getByTestId('verify-code').innerText();
    expect(verify).toMatch(/^[A-Z0-9]{8}$/);
    await citizen(page, '3100600987659'); await open(page, '/citizen/cases/EG-2569-000025');
    await status(page, 'เสร็จสิ้น', 'COMPLETED'); await expect(page.getByTestId('download-doc-btn')).toHaveCount(1);
    const download = page.waitForEvent('download'); await page.getByTestId('download-doc-btn').click();
    const file = await download; expect(file.suggestedFilename()).toBe('DOC-2569-000002.pdf');
    expect((await readFile((await file.path())!)).toString('latin1')).toContain('docNo=DOC-2569-000002 caseNo=EG-2569-000025');
    const pdf = await api(page, 'get', '/api/documents/DOC-2569-000002/pdf'); expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf'); expect(pdf.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
    // ขั้น 6: Dashboard ธ.ค. หลังปิด 1 เรื่อง (ปิด 1 ธ.ค. 09:00 ≤ 3 ธ.ค. 16:30 = ทัน)
    await staff(page, 'exec1');
    expect(await json(await api(page, 'get', '/api/dashboard?period=2026-12&service=ALL'))).toMatchObject({ closed: 1, onTime: 1, received: 3, backlog: 20 });
  });

  test('TC-WORKFLOW-02 SV-02 ส่งหัวหน้าอนุมัติ และหัวหน้าส่งออกเอกสารไม่ได้', async ({ page }) => {
    await reset(page.request); await staff(page, 'off.reg2'); await open(page, '/officer/cases/EG-2569-000013');
    await expect(page.getByTestId('approve-btn')).toHaveCount(0);
    await expect(page.getByTestId('forward-target')).toHaveCount(0); await expect(page.getByTestId('forward-btn')).toHaveCount(1);
    await clickAction(page, 'forward-btn'); await status(page, 'รออนุมัติ', 'PENDING_APPROVAL');
    // ขั้น 2: งานในมือ off.reg2 = 8 · …000013 หายจากคิวทะเบียน
    expect((await json(await api(page, 'get', '/api/officer/queue?filter=mine'))).items).toHaveLength(8);
    expect((await json(await api(page, 'get', '/api/officer/queue?filter=all'))).items.map((x: any) => x.caseNo)).not.toContain('EG-2569-000013');
    await open(page, '/officer/queue'); await expect(page.getByTestId('workload-count')).toHaveText('8');
    await expect(page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000013"]')).toHaveCount(0);
    await staff(page, 'head1'); await open(page, '/head/approvals');
    await expect(page.getByTestId('approval-row')).toHaveCount(3);
    expect(await page.getByTestId('approval-row').evaluateAll(es => es.map(e => e.getAttribute('data-case-no')))).toEqual(['EG-2569-000013', 'EG-2569-000014', 'EG-2569-000011']); // 4 ธ.ค. เรียงเลข แล้ว 8 ธ.ค.
    await page.locator('[data-testid="approval-row"][data-case-no="EG-2569-000013"] [data-testid="approval-open"]').click();
    await expect(page).toHaveURL(/\/officer\/cases\/EG-2569-000013$/);
    await expect(page.getByTestId('approve-btn')).toHaveCount(1); await expect(page.getByTestId('reject-btn')).toHaveCount(1); await expect(page.getByTestId('issue-btn')).toHaveCount(0);
    await clickAction(page, 'approve-btn'); await status(page, 'อนุมัติ', 'APPROVED');
    await expect(page.getByTestId('issue-btn')).toHaveCount(0);
    // ขั้น 6: off.reg1 ไม่ใช่ผู้รับเรื่องขั้นแรก → ไม่มี issue-btn และ API 403
    await staff(page, 'off.reg1'); await open(page, '/officer/cases/EG-2569-000013'); await status(page, 'อนุมัติ', 'APPROVED');
    await expect(page.getByTestId('issue-btn')).toHaveCount(0);
    const notIssuer = await api(page, 'post', '/api/officer/cases/EG-2569-000013/issue'); expect(notIssuer.status()).toBe(403); expect((await json(notIssuer)).code).toBe('FORBIDDEN');
    await staff(page, 'off.reg2'); await open(page, '/officer/cases/EG-2569-000013'); await clickAction(page, 'issue-btn');
    await status(page, 'เสร็จสิ้น', 'COMPLETED');
    await expect(page.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
    const code = (await page.getByTestId('verify-code').innerText()).trim(); expect(code).toMatch(/^[A-Z0-9]{8}$/);
    await page.context().clearCookies(); await open(page, `/verify/${code}`); // ไม่ล็อกอิน
    await expect(page.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
    // ขั้น 8: seed …000019 (APPROVED โดย head1 · ผู้ออกเอกสาร off.reg1)
    await reset(page.request); await staff(page, 'off.reg1'); await open(page, '/officer/cases/EG-2569-000019');
    await clickAction(page, 'issue-btn'); await status(page, 'เสร็จสิ้น', 'COMPLETED');
    await expect(page.getByTestId('doc-no')).toHaveText('DOC-2569-000002');
    const code19 = (await page.getByTestId('verify-code').innerText()).trim();
    await page.context().clearCookies(); await open(page, `/verify/${code19}`);
    await expect(page.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
  });

  test('TC-WORKFLOW-03 SV-03 route ทะเบียน → โยธา → หัวหน้า → ออกเอกสาร', async ({ page }) => {
    await reset(page.request); await staff(page, 'off.reg2'); await open(page, '/officer/cases/EG-2569-000012');
    await expect(page.getByTestId('case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
    await expect(page.getByTestId('case-fee')).toHaveText('฿1,010');
    await expect(page.getByTestId('forward-btn')).toHaveCount(1);
    await clickAction(page, 'forward-btn');
    await expect(page.getByTestId('case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
    await expect(page.getByTestId('case-owner')).toHaveText('ยังไม่มีผู้รับ');
    await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW'); // ยัง IN_REVIEW
    // ขั้น 2–3: งานในมือ off.reg2 = 8 · คิว off.reg2 เหลือ 16 ไม่มี …000012
    expect((await json(await api(page, 'get', '/api/officer/queue?filter=mine'))).items).toHaveLength(8);
    await open(page, '/officer/queue'); await expect(page.getByTestId('workload-count')).toHaveText('8');
    await expect(page.getByTestId('queue-row')).toHaveCount(16);
    await expect(page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000012"]')).toHaveCount(0);
    // ขั้น 5: off.reg1 (ทะเบียน) รับเรื่องที่อยู่ขั้นโยธาไม่ได้
    await staff(page, 'off.reg1');
    const cross = await api(page, 'post', '/api/officer/cases/EG-2569-000012/claim'); expect(cross.status()).toBe(403); expect((await json(cross)).code).toBe('FORBIDDEN');
    await staff(page, 'off.works1'); await open(page, '/officer/queue');
    // ขั้น 4: โยธาเห็น 2 แถว …000010 (3 ธ.ค.) → …000012 (11 ธ.ค.) · claim-btn 2 ปุ่ม
    expect(await page.getByTestId('queue-row').evaluateAll(es => es.map(e => e.getAttribute('data-case-no')))).toEqual(['EG-2569-000010', 'EG-2569-000012']);
    await expect(page.getByTestId('claim-btn')).toHaveCount(2);
    await expect(page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000012"]')).toHaveCount(1);
    // [fix] pre-existing race: ปุ่มรับเรื่องสั่ง fetch+reload ทำให้ goto ถัดไปชน (net::ERR_ABORTED) → ใช้ API claim (UI claim ถูกตรวจใน TC-QUEUE-*)
    expect((await api(page, 'post', '/api/officer/cases/EG-2569-000012/claim')).status()).toBe(200);
    await open(page, '/officer/cases/EG-2569-000012'); await expect(page.getByTestId('case-owner')).toHaveText('off.works1');
    await clickAction(page, 'forward-btn');
    await expect(page.getByTestId('case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย'); await status(page, 'รออนุมัติ', 'PENDING_APPROVAL');
    await staff(page, 'head1'); await open(page, '/head/approvals');
    await expect(page.getByTestId('approval-row')).toHaveCount(3); // …000014 · …000011 + …000012
    await page.locator('[data-testid="approval-row"][data-case-no="EG-2569-000012"] [data-testid="approval-open"]').click(); await clickAction(page, 'approve-btn');
    // [fix] รอให้ reload หลังอนุมัติจบก่อน goto ถัดไป (stack: open@302 ERR_ABORTED)
    await expect(page.getByTestId('approve-btn')).toHaveCount(0); await status(page, 'อนุมัติ', 'APPROVED');
    // ขั้น 8: โยธาออกเอกสารไม่ได้ · ทะเบียนขั้นแรก (off.reg2) เป็นผู้ออก
    await staff(page, 'off.works1'); await open(page, '/officer/cases/EG-2569-000012'); await status(page, 'อนุมัติ', 'APPROVED');
    await expect(page.getByTestId('issue-btn')).toHaveCount(0);
    await staff(page, 'off.reg2'); await open(page, '/officer/cases/EG-2569-000012'); await expect(page.getByTestId('issue-btn')).toHaveCount(1);
    await clickAction(page, 'issue-btn'); await status(page, 'เสร็จสิ้น', 'COMPLETED');
    const code = (await page.getByTestId('verify-code').innerText()).trim(); expect(code).toMatch(/^[A-Z0-9]{8}$/);
    await page.context().clearCookies(); await open(page, `/verify/${code}`);
    await expect(page.getByTestId('verify-signer')).toHaveText('หัวหน้าฝ่าย');
  });

  test('TC-WORKFLOW-04 จำกัดการตีกลับสองครั้ง', async ({ page }) => {
    // [B12] เขียนใหม่ตาม TEST-PLAN ส่วน A/B/C (ของเดิมเปิดหน้าเจ้าหน้าที่ด้วย session ประชาชน)
    const C = 'EG-2569-000020';
    await reset(page.request); await staff(page, 'off.reg1');
    await open(page, `/officer/cases/${C}`); await expect(page.getByTestId('return-count')).toHaveText('0');
    for (const n of [1, 2]) {
      await staff(page, 'off.reg1'); await open(page, `/officer/cases/${C}`);
      await clickAction(page, 'return-btn', 'xxxxxxxxxx');
      await status(page, 'รอแก้ไขเอกสาร', 'NEED_FIX'); await expect(page.getByTestId('return-count')).toHaveText(String(n));
      await citizen(page); expect((await api(page, 'post', `/api/cases/${C}/resubmit`)).status()).toBe(200);
      await open(page, `/citizen/cases/${C}`); await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW');
      expect((await json(await api(page, 'get', `/api/cases/${C}`))).owner).toBe('off.reg1');
    }
    await staff(page, 'off.reg1'); await open(page, `/officer/cases/${C}`);
    await expect(page.getByTestId('return-btn')).toHaveCount(0);
    const over = await api(page, 'post', `/api/officer/cases/${C}/return`, { reason: 'xxxxxxxxxx' });
    expect(over.status()).toBe(409); const overBody = await json(over); expect(overBody.code).toBe('RETURN_LIMIT'); expect(overBody.message).toBe('ตีกลับได้สูงสุด 2 ครั้ง');
    await open(page, `/officer/cases/${C}`); await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW'); await expect(page.getByTestId('return-count')).toHaveText('2');
    await expect(page.getByTestId('approve-btn')).toHaveCount(1); await expect(page.getByTestId('reject-btn')).toHaveCount(1);
    // ส่วน B: seed …000023 ตีกลับแล้ว 2 ครั้ง
    await reset(page.request); await staff(page, 'off.reg1'); await open(page, '/officer/cases/EG-2569-000023');
    await expect(page.getByTestId('return-count')).toHaveText('2'); await expect(page.getByTestId('return-btn')).toHaveCount(0);
    const b = await api(page, 'post', '/api/officer/cases/EG-2569-000023/return', { reason: 'xxxxxxxxxx' }); expect(b.status()).toBe(409); expect((await json(b)).code).toBe('RETURN_LIMIT');
    await open(page, '/officer/cases/EG-2569-000023'); await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW');
    await expect(page.getByTestId('approve-btn')).toHaveCount(1); await expect(page.getByTestId('reject-btn')).toHaveCount(1);
    // ส่วน C: SV-02 …000013 (off.reg2) หลังตีกลับครบ 2 ครั้ง
    const S = 'EG-2569-000013';
    await reset(page.request);
    for (let i = 0; i < 2; i++) {
      await staff(page, 'off.reg2'); expect((await api(page, 'post', `/api/officer/cases/${S}/return`, { reason: 'xxxxxxxxxx' })).status()).toBe(200);
      await citizen(page); expect((await api(page, 'post', `/api/cases/${S}/resubmit`)).status()).toBe(200);
    }
    await staff(page, 'off.reg2'); await open(page, `/officer/cases/${S}`);
    await expect(page.getByTestId('return-btn')).toHaveCount(0); await expect(page.getByTestId('approve-btn')).toHaveCount(0);
    await expect(page.getByTestId('reject-btn')).toHaveCount(0); await expect(page.getByTestId('forward-btn')).toHaveCount(1);
    expect((await api(page, 'post', `/api/cases/${S}/reject`, { reason: 'xxxxxxxxxx' })).status()).toBe(403);
    await page.getByTestId('forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา'); await page.getByTestId('forward-btn').click();
    await status(page, 'รออนุมัติ', 'PENDING_APPROVAL');
    await staff(page, 'audit1'); await open(page, '/audit');
    await page.getByTestId('audit-filter-event').selectOption('FORWARD'); await page.getByTestId('audit-apply-btn').click();
    const fwd = page.locator(`[data-testid="audit-row"][data-case-no="${S}"]`);
    await expect(fwd).toHaveCount(1); await expect(fwd.getByTestId('audit-detail')).toContainText('ส่งต่อให้หัวหน้าพิจารณา');
    await staff(page, 'head1'); await open(page, `/officer/cases/${S}`);
    await expect(page.getByTestId('reject-btn')).toHaveCount(1); await expect(page.getByTestId('approve-btn')).toHaveCount(1);
  });

  test('TC-WORKFLOW-05 เหตุผลตีกลับและไม่อนุมัติอย่างน้อยสิบตัว', async ({ page }) => {
    const short = 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร';
    const tooShort = async (path: string, reason: string) => { const x = await api(page, 'post', path, { reason }); expect(x.status(), JSON.stringify(reason)).toBe(400); expect((await json(x)).code).toBe('REASON_TOO_SHORT'); };
    // ส่วน A: ตีกลับ …000020 (off.reg1) · 9 ตัว ✗ · เว้นวรรค 10 ตัว ✗ · 10 ตัว ✓
    await reset(page.request); await staff(page, 'off.reg1');
    await tooShort('/api/officer/cases/EG-2569-000020/return', 'xxxxxxxxx');
    await tooShort('/api/officer/cases/EG-2569-000020/return', '          ');
    await open(page, '/officer/cases/EG-2569-000020');
    for (const reason of ['xxxxxxxxx', '          ']) {
      await clickAction(page, 'return-btn', reason);
      await expect(page.getByTestId('return-reason-error')).toHaveText(short);
      await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW');
    }
    await clickAction(page, 'return-btn', 'xxxxxxxxxx'); await status(page, 'รอแก้ไขเอกสาร', 'NEED_FIX');
    await citizen(page); await open(page, '/citizen/cases/EG-2569-000020');
    await expect(page.getByTestId('return-reason-display')).toHaveText('xxxxxxxxxx');
    // ส่วน B: ไม่อนุมัติ SV-01 …000026 (off.reg2 ผู้ถือ)
    await reset(page.request); await staff(page, 'off.reg2');
    await tooShort('/api/cases/EG-2569-000026/reject', 'xxxxxxxxx');
    await open(page, '/officer/cases/EG-2569-000026');
    await clickAction(page, 'reject-btn', 'xxxxxxxxx'); await expect(page.getByTestId('reject-reason-error')).toHaveText(short);
    await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW');
    await clickAction(page, 'reject-btn', 'xxxxxxxxxx'); await status(page, 'ไม่อนุมัติ', 'REJECTED');
    await iso(page.getByTestId('closed-at'), '2026-12-01T09:00:00+07:00'); await expect(page.getByTestId('sla-level')).toHaveText('ปิดแล้ว');
    const rejected = await json(await api(page, 'get', '/api/cases/EG-2569-000026'));
    expect(rejected.status).toBe('REJECTED'); expect(rejected.closedAt).toBe('2026-12-01T09:00:00+07:00');
    await citizen(page); await open(page, '/citizen/cases/EG-2569-000026'); // สมชาย (ผู้ยื่น)
    await expect(page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
    await staff(page, 'exec1'); // REJECTED นับเป็นปิดงาน และทันกำหนด (ปิดก่อน 3 ธ.ค. 16:30)
    expect(await json(await api(page, 'get', '/api/dashboard?period=2026-12&service=ALL'))).toMatchObject({ closed: 1, onTime: 1 });
    // ส่วน C: หัวหน้าไม่อนุมัติ …000011
    await reset(page.request); await staff(page, 'head1');
    await tooShort('/api/cases/EG-2569-000011/reject', 'xxxxxxxxx');
    const ok = await api(page, 'post', '/api/cases/EG-2569-000011/reject', { reason: 'xxxxxxxxxx' }); expect(ok.status()).toBe(200);
    expect((await json(ok)).status).toBe('REJECTED');
    expect((await json(await api(page, 'get', '/api/cases/EG-2569-000011'))).status).toBe('REJECTED');
  });

  test('TC-WORKFLOW-06 ยกเลิกอัตโนมัติเมื่อครบ 168 ชั่วโมง', async ({ page }) => {
    // หน้าตั้งต้น (ตีกลับครั้งที่ 2 เมื่อ 27 พ.ย. 14:00 → เส้นตาย +168 ชม. = 4 ธ.ค. 14:00)
    await reset(page.request); await citizen(page); await open(page, '/citizen/cases/EG-2569-000017');
    await status(page, 'รอแก้ไขเอกสาร', 'NEED_FIX');
    await expect(page.getByTestId('return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
    await expect(page.getByTestId('fix-deadline')).toContainText('4 ธ.ค. 2569 14:00'); await iso(page.getByTestId('fix-deadline'), '2026-12-04T14:00:00+07:00');
    await expect(page.getByTestId('submit-fix-btn')).toHaveCount(1);
    // รอบ A: 167:59 ยังส่งแก้ได้
    await reset(page.request); await clock(page.request, '2026-12-04T13:59:00+07:00'); await citizen(page);
    await open(page, '/citizen/cases/EG-2569-000017'); await expect(page.getByTestId('submit-fix-btn')).toBeEnabled();
    const okA = await api(page, 'post', '/api/cases/EG-2569-000017/resubmit'); expect(okA.status()).toBe(200); expect((await json(okA)).status).toBe('IN_REVIEW');
    await open(page, '/citizen/cases/EG-2569-000017'); await status(page, 'กำลังตรวจสอบ', 'IN_REVIEW');
    // รอบ B: 168:00 พอดี → ยกเลิกอัตโนมัติ
    await reset(page.request); await clock(page.request, '2026-12-04T14:00:00+07:00'); await citizen(page);
    const r = await api(page, 'post', '/api/cases/EG-2569-000017/resubmit'); expect(r.status()).toBe(409);
    const c = await json(await api(page, 'get', '/api/cases/EG-2569-000017'));
    expect(c.status).toBe('CANCELLED');
    await open(page, '/citizen/cases/EG-2569-000017'); await status(page, 'ยกเลิก', 'CANCELLED'); await expect(page.getByTestId('submit-fix-btn')).toHaveCount(0);
    await expect(page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
    await expect(page.getByTestId('case-timeline').locator('[data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]')).toHaveCount(1);
    await staff(page, 'exec1'); expect((await json(await api(page, 'get', '/api/dashboard?period=2026-12&service=ALL'))).backlog).toBe(20);
  });

  test('TC-DOC-01 ออก ตรวจสอบ และดาวน์โหลดเอกสารได้ตามข้อมูล', async ({ page }) => {
    await reset(page.request); await staff(page, 'off.reg2');
    await api(page, 'post', '/api/cases/EG-2569-000025/approve');
    const issued = await api(page, 'post', '/api/officer/cases/EG-2569-000025/issue'); expect(issued.status()).toBe(200);
    const body = await json(issued); expect(body.docNo).toBe('DOC-2569-000002'); expect(body.status).toBe('COMPLETED'); expect(body.verifyCode).toMatch(/^[A-Z0-9]{8}$/);
    await citizen(page, '3100600987659');
    const pdf = await api(page, 'get', '/api/documents/DOC-2569-000002/pdf'); expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf'); expect(pdf.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
    expect((await pdf.body()).toString()).toContain(`docNo=DOC-2569-000002 caseNo=EG-2569-000025 verify=${body.verifyCode} validUntil=2027-02-28`);
    await open(page, '/citizen/cases/EG-2569-000025'); // หน้าเคส: QR ชี้ไปหน้า verify ของรหัสนี้
    await expect(page.getByTestId('doc-qr')).toHaveAttribute('data-url', url(`/verify/${body.verifyCode}`));
    await open(page, `/verify/${body.verifyCode}`); await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'VALID');
    await expect(page.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');
    await expect(page.getByTestId('verify-doc-no')).toHaveText('DOC-2569-000002');
    await expect(page.getByTestId('verify-applicant')).toHaveText('สมหญิง ร***');
    await expect(page.getByTestId('verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await iso(page.getByTestId('verify-issued'), '2026-12-01T09:00:00+07:00');
    await iso(page.getByTestId('verify-expires'), '2027-02-28'); // ออก 1 ธ.ค. 69 + 90 วัน → ใช้ได้ถึง 28 ก.พ. 70
    await expect(page.getByTestId('verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 2');
    const v = await json(await api(page, 'get', `/api/verify/${body.verifyCode}`)); expect(v.validUntil).toBe('2027-02-28');
    expect(v.result).toBe('VALID'); expect(v.issuedAt).toBe('2026-12-01T09:00:00+07:00');
    await citizen(page); expect((await api(page, 'get', '/api/documents/DOC-2569-000002/pdf')).status()).toBe(404);
    // ออกซ้ำ → 409 INVALID_STATE · ไม่เกิดเอกสารที่ 2 (ใบถัดไปในระบบยังเป็น DOC-2569-000003)
    await staff(page, 'off.reg2');
    const again = await api(page, 'post', '/api/officer/cases/EG-2569-000025/issue'); expect(again.status()).toBe(409); expect((await json(again)).code).toBe('INVALID_STATE');
    await staff(page, 'off.reg1');
    const next = await api(page, 'post', '/api/officer/cases/EG-2569-000019/issue'); expect(next.status()).toBe(200); expect((await json(next)).docNo).toBe('DOC-2569-000003');
  });

  test('TC-DOC-02 หน้า verify เปิดได้โดยไม่ล็อกอินและไม่เผยข้อมูลส่วนบุคคล', async ({ page }) => {
    // [B12] ตาม TEST-PLAN · API VALID ใช้ toMatchObject เพราะ CONTRACT 6.4 กำหนดฟิลด์เพิ่ม (docNo serviceId issuedAt validUntil signer)
    await reset(page.request);
    const ok = await page.goto(url('/verify/K7M2Q9XA')); expect(ok?.status()).toBe(200); await expect(page).toHaveURL(/\/verify\/K7M2Q9XA$/);
    await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'VALID'); await expect(page.getByTestId('verify-result')).toHaveText('เอกสารถูกต้อง');
    await expect(page.getByTestId('verify-doc-no')).toHaveText('DOC-2569-000001');
    await expect(page.getByTestId('verify-applicant')).toHaveText('สมชาย ใ***');
    await expect(page.getByTestId('verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
    await iso(page.getByTestId('verify-issued'), '2026-11-05T10:00:00+07:00');
    await iso(page.getByTestId('verify-expires'), '2027-02-02');
    await expect(page.getByTestId('verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 1');
    await expect(page.locator('body')).not.toContainText('ใจดี'); await expect(page.locator('body')).not.toContainText(citizenId);
    const v = await api(page, 'get', '/api/verify/K7M2Q9XA'); expect(v.status()).toBe(200);
    expect(await v.json()).toMatchObject({ result: 'VALID', applicantMasked: 'สมชาย ใ***' });
    const nf = await page.goto(url('/verify/ZZZZZZZZ')); expect(nf?.status()).toBe(404);
    await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'NOT_FOUND'); await expect(page.getByTestId('verify-result')).toHaveText('ไม่พบเอกสาร');
    await expect(page.getByTestId('verify-applicant')).toHaveCount(0); await expect(page.getByTestId('verify-doc-no')).toHaveCount(0);
    const nfApi = await api(page, 'get', '/api/verify/ZZZZZZZZ'); expect(nfApi.status()).toBe(404); expect(await nfApi.json()).toEqual({ result: 'NOT_FOUND' });
  });

  test('TC-DOC-03 เอกสารหมดอายุและลายเซ็นผิดมีผลตามลำดับตรวจ', async ({ page }) => {
    await reset(page.request); await clock(page.request, '2027-02-02T23:59:00+07:00'); await open(page, '/verify/K7M2Q9XA');
    await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'VALID');
    await clock(page.request, '2027-02-03T00:00:00+07:00'); await open(page, '/verify/K7M2Q9XA');
    await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'EXPIRED');
    await reset(page.request);
    const tamper = await api(page, 'post', '/api/test/documents/DOC-2569-000001/tamper'); expect(tamper.status()).toBe(200);
    expect(await tamper.json()).toEqual({ ok: true });
    await open(page, '/verify/K7M2Q9XA'); await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'TAMPERED');
    await expect(page.getByTestId('verify-result')).toHaveText('ลายเซ็นไม่ถูกต้อง');
    await expect(page.getByTestId('verify-doc-no')).toHaveCount(0); await expect(page.getByTestId('verify-applicant')).toHaveCount(0);
    await clock(page.request, '2027-03-01T00:00:00+07:00'); await open(page, '/verify/K7M2Q9XA'); // หมดอายุด้วย → ยังเป็นลายเซ็นไม่ถูกต้อง (ลำดับตรวจ A-43)
    await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'TAMPERED');

    // [เติมตามการ์ด] ตัวช่วย: ออกเอกสารผ่าน API แล้วตรวจขอบวันหมดอายุบนหน้า /verify (ไม่ล็อกอิน)
    const issue = async (user: string, caseNo: string, approveFirst: boolean) => {
      await staff(page, user);
      if (approveFirst) expect((await api(page, 'post', `/api/cases/${caseNo}/approve`)).status()).toBe(200);
      const r = await api(page, 'post', `/api/officer/cases/${caseNo}/issue`); expect(r.status(), `issue ${caseNo}`).toBe(200);
      return (await json(r)) as { docNo: string; verifyCode: string };
    };
    const verifyAt = async (code: string, now: string, result: 'VALID' | 'EXPIRED', expires: string) => {
      await clock(page.request, now); await page.context().clearCookies();
      const res = await page.goto(url(`/verify/${code}`)); expect(res?.status(), `${code} ${now}`).toBe(200);
      await expect(page.getByTestId('verify-result'), `${code} ${now}`).toHaveAttribute('data-result', result);
      await expect(page.getByTestId('verify-result')).toHaveText(result === 'VALID' ? 'เอกสารถูกต้อง' : 'เอกสารหมดอายุ');
      await iso(page.getByTestId('verify-expires'), expires);
    };
    // ส่วน A: SV-01 ออก 1 ธ.ค. 69 · 90 วัน → ใช้ได้ถึง 28 ก.พ. 70
    await reset(page.request);
    const a = await issue('off.reg2', 'EG-2569-000025', true);
    await verifyAt(a.verifyCode, '2027-02-28T23:59:00+07:00', 'VALID', '2027-02-28');
    await verifyAt(a.verifyCode, '2027-03-01T00:00:00+07:00', 'EXPIRED', '2027-02-28');
    // ส่วน B: SV-02 ออก 1 ธ.ค. 69 · 1 ปี → ใช้ได้ถึง 30 พ.ย. 70
    await reset(page.request);
    const b = await issue('off.reg1', 'EG-2569-000019', false);
    await verifyAt(b.verifyCode, '2027-11-30T23:59:00+07:00', 'VALID', '2027-11-30');
    await verifyAt(b.verifyCode, '2027-12-01T00:00:00+07:00', 'EXPIRED', '2027-11-30');
    // ส่วน E: ออกวันที่ 29 ก.พ. 2571 (ปีอธิกสุรทิน) · เลขเอกสารปีใหม่เริ่ม 000001
    await reset(page.request); await clock(page.request, '2028-02-29T10:00:00+07:00');
    const e1 = await issue('off.reg2', 'EG-2569-000025', true); expect(e1.docNo).toBe('DOC-2571-000001');
    const e2 = await issue('off.reg1', 'EG-2569-000019', false); expect(e2.docNo).toBe('DOC-2571-000002');
    await verifyAt(e1.verifyCode, '2028-05-28T23:59:00+07:00', 'VALID', '2028-05-28');
    await verifyAt(e1.verifyCode, '2028-05-29T00:00:00+07:00', 'EXPIRED', '2028-05-28');
    await verifyAt(e2.verifyCode, '2029-02-27T23:59:00+07:00', 'VALID', '2029-02-27');
    await verifyAt(e2.verifyCode, '2029-02-28T00:00:00+07:00', 'EXPIRED', '2029-02-27');
  });

  test('TC-PDPA-01 แสดงเลขบัตรตามสิทธิ์และปิดบังในหน้าพนักงาน', async ({ page }) => {
    await reset(page.request); await staff(page, 'off.reg2'); await open(page, '/officer/queue');
    await expect(page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000025"] [data-testid="row-id-masked"]')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000026"] [data-testid="row-id-masked"]')).toHaveText('X-XXXX-XXXXX-45-6');
    const masked = await page.getByTestId('row-id-masked').allInnerTexts(); expect(masked.length).toBe(17);
    for (const t of masked) expect(t.trim()).toMatch(MASKED);
    await open(page, '/officer/cases/EG-2569-000025'); await expect(page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    await expect(page.locator('body')).not.toContainText('3100600987659'); await expect(page.locator('body')).not.toContainText('3-1006-00987-65-9');
    const html = await page.content(); expect(html).not.toContain('3100600987659'); expect(html).not.toContain('3-1006-00987-65-9'); // HTML ทั้งหน้า
    await staff(page, 'head1'); await open(page, '/officer/cases/EG-2569-000025'); // หัวหน้าปิดบังเหมือนกัน
    await expect(page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9');
    await citizen(page, '3100600987659'); await open(page, '/citizen/cases/EG-2569-000025');
    await expect(page.getByTestId('case-id-full')).toHaveText('3-1006-00987-65-9');
    await citizen(page); await open(page, '/citizen/cases/EG-2569-000020');
    await expect(page.getByTestId('case-id-full')).toHaveText('1-1017-00123-45-6');
  });

  test('TC-PDPA-02 API เจ้าหน้าที่ไม่ส่งเลขบัตรเต็มหรือ key idNo', async ({ page }) => {
    await reset(page.request);
    const paths = ['/api/officer/queue?filter=all', '/api/cases/EG-2569-000025', '/api/cases/EG-2569-000026', '/api/cases/EG-2569-000020', '/api/notifications', '/api/cases/EG-2569-000025/files'];
    for (const user of ['off.reg1', 'head1']) {
      await staff(page, user);
      for (const path of paths) {
        const r = await api(page, 'get', path); expect(r.status()).toBe(200); expect(r.headers()['content-type']).toContain('application/json');
        const value = await r.json(); const text = JSON.stringify(value);
        expect(text).not.toMatch(/\d{13}|\d-\d{4}-\d{5}-\d{2}-\d/);
        for (const sensitive of ['3100600987659', '1101700123456', '1909900555015']) expect(text).not.toContain(sensitive);
        const walk = (x: any): void => { if (!x || typeof x !== 'object') return; expect(Object.keys(x)).not.toContain('idNo'); Object.values(x).forEach(walk); }; walk(value);
        if (path.startsWith('/api/officer/queue')) { expect(value.items.length).toBeGreaterThan(0); for (const it of value.items) expect(it.idMasked, `${user} ${it.caseNo}`).toMatch(MASKED); }
        if (/^\/api\/cases\/EG-\d{4}-\d{6}$/.test(path)) expect(value.idMasked, `${user} ${path}`).toMatch(MASKED);
      }
    }
  });

  test('TC-PDPA-03 แสดงเลขเต็มต้องมีเหตุผลและบันทึก UNMASK', async ({ page }) => {
    await reset(page.request); await staff(page, 'off.reg2');
    for (const reason of ['', '   ']) { // ขั้น 1–2 ที่ API: เหตุผลว่าง/เว้นวรรคล้วน → 400 REASON_REQUIRED (และต้องไม่ถูกบันทึก Audit)
      const bad = await api(page, 'post', '/api/officer/cases/EG-2569-000025/unmask', { reason }); expect(bad.status()).toBe(400); expect((await json(bad)).code).toBe('REASON_REQUIRED');
    }
    await open(page, '/officer/cases/EG-2569-000025');
    await page.getByTestId('show-full-id-btn').click(); await page.getByTestId('unmask-submit').click();
    await expect(page.getByTestId('unmask-error')).toHaveText('กรุณากรอกเหตุผล'); await expect(page.getByTestId('full-id')).toHaveCount(0);
    await page.getByTestId('unmask-reason').fill('          '); await page.getByTestId('unmask-submit').click(); await expect(page.getByTestId('unmask-error')).toHaveText('กรุณากรอกเหตุผล');
    await page.getByTestId('unmask-reason').fill('ตรวจสอบตัวตนซ้ำ'); await page.getByTestId('unmask-submit').click();
    await expect(page.getByTestId('full-id')).toHaveText('3-1006-00987-65-9');
    await page.reload(); await expect(page.getByTestId('full-id')).toHaveCount(0);
    await expect(page.getByTestId('applicant-id')).toHaveText('X-XXXX-XXXXX-65-9'); // โหลดซ้ำแล้วปิดบังตามเดิม
    await staff(page, 'audit1'); await open(page, '/audit'); await page.getByTestId('audit-filter-event').selectOption('UNMASK');
    await expect(page.getByTestId('audit-count')).toHaveText('1');
    await expect(page.locator('[data-testid="audit-row"]').first()).toContainText('ตรวจสอบตัวตนซ้ำ');
    const row = page.getByTestId('audit-row'); await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-actor', 'off.reg2'); await expect(row).toHaveAttribute('data-case-no', 'EG-2569-000025');
    await expect(row.getByTestId('audit-role')).toHaveText('officer'); await expect(row.getByTestId('audit-event')).toHaveText('UNMASK');
    await expect(row.getByTestId('audit-case-no')).toHaveText('EG-2569-000025'); await expect(row.getByTestId('audit-detail')).toContainText('ตรวจสอบตัวตนซ้ำ');
    await iso(row.getByTestId('audit-time'), '2026-12-01T09:00:00+07:00');
    // ขั้น 6: ผู้บริหาร ผู้ตรวจสอบ และประชาชน เรียก unmask ไม่ได้
    const denied = async () => expect((await api(page, 'post', '/api/officer/cases/EG-2569-000025/unmask', { reason: 'x' })).status()).toBe(403);
    await denied(); // audit1
    await staff(page, 'exec1'); await denied();
    await citizen(page, '3100600987659'); await denied();
  });

  test('TC-DASH-01 Dashboard ค่าเริ่มต้นและข้อมูลส่วนบุคคลไม่ปรากฏ', async ({ page }) => {
    await reset(page.request); await staff(page, 'exec1'); await open(page, '/dashboard');
    const values: Record<string, string> = { 'kpi-received': '3', 'kpi-closed': '0', 'kpi-ontime-pct': '–', 'kpi-backlog': '21', 'kpi-overdue': '1' };
    for (const [id, value] of Object.entries(values)) await expect(page.getByTestId(id)).toHaveText(value);
    await expect(page.getByTestId('workload-row')).toHaveCount(3);
    const text = await page.locator('body').innerText(); expect(text).not.toMatch(/\d{13}|0\d{9}/); for (const name of ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ']) expect(text).not.toContain(name);
    const d = await json(await api(page, 'get', '/api/dashboard?period=2026-12&service=ALL'));
    expect(d).toMatchObject({ received: 3, closed: 0, ontimePct: null, backlog: 21, overdue: 1 });
    // [เติมตามการ์ด] ค่าเริ่มต้นของตัวกรอง · งานในมือรายคน · ตัวกรองบริการ
    await expect(page.getByTestId('period-select')).toHaveValue('2026-12'); await expect(page.getByTestId('service-select')).toHaveValue('ALL');
    const wl = await page.getByTestId('workload-row').evaluateAll(es => es.map(e => `${e.getAttribute('data-username')}=${(e.querySelector('[data-testid="workload-value"]')?.textContent ?? '').trim()}`));
    expect(wl.sort()).toEqual(['off.reg1=3', 'off.reg2=9', 'off.works1=0']);
    expect(d.workload.map((w: any) => `${w.username}=${w.count}`).sort()).toEqual(['off.reg1=3', 'off.reg2=9', 'off.works1=0']);
    const bySvc: [string, number, number, number][] = [['SV-01', 3, 11, 1], ['SV-02', 0, 7, 0], ['SV-03', 0, 3, 0]]; // รับเรื่อง · คงค้าง · เกินกำหนด
    for (const [svc, received, backlog, overdue] of bySvc) {
      await page.getByTestId('service-select').selectOption(svc);
      const want: Record<string, string> = { 'kpi-received': String(received), 'kpi-closed': '0', 'kpi-ontime-pct': '–', 'kpi-backlog': String(backlog), 'kpi-overdue': String(overdue) };
      for (const [id, value] of Object.entries(want)) await expect(page.getByTestId(id), `${svc} ${id}`).toHaveText(value);
      expect(await json(await api(page, 'get', `/api/dashboard?period=2026-12&service=${svc}`)), svc).toMatchObject({ received, closed: 0, ontimePct: null, backlog, overdue });
    }
  });

  test('TC-DASH-02 Dashboard ย้อนหลังคิดเปอร์เซ็นต์จากงานปิด', async ({ page }) => {
    await reset(page.request); await staff(page, 'exec1'); await open(page, '/dashboard');
    const rows = [['2026-10','ALL','1','1','100.0%'], ['2026-11','ALL','26','7','85.7%'], ['2026-11','SV-01','12','3','100.0%'], ['2026-11','SV-02','10','3','66.7%'], ['2026-11','SV-03','4','1','100.0%'], ['2026','ALL','30','8','87.5%'], ['2026','SV-01','16','4','100.0%'], ['2026','SV-02','10','3','66.7%'], ['2026','SV-03','4','1','100.0%']];
    for (const [period, service, received, closed, pct] of rows) {
      await page.getByTestId('period-select').selectOption(period); await page.getByTestId('service-select').selectOption(service);
      await expect(page.getByTestId('kpi-received')).toHaveText(received); await expect(page.getByTestId('kpi-closed')).toHaveText(closed); await expect(page.getByTestId('kpi-ontime-pct')).toHaveText(pct);
      const d = await json(await api(page, 'get', `/api/dashboard?period=${period}&service=${service}`)); expect(d.received).toBe(Number(received)); expect(d.closed).toBe(Number(closed)); expect(d.ontimePct).toBe(pct === '–' ? null : Number.parseFloat(pct));
      // งานคงค้าง/เกินกำหนด = ค่า "ณ ตอนนี้" ไม่ขึ้นกับช่วงเวลา แต่ขึ้นกับบริการ (A-41)
      const [backlog, overdue] = ({ ALL: [21, 1], 'SV-01': [11, 1], 'SV-02': [7, 0], 'SV-03': [3, 0] } as Record<string, number[]>)[service];
      await expect(page.getByTestId('kpi-backlog'), `${period} ${service}`).toHaveText(String(backlog)); await expect(page.getByTestId('kpi-overdue'), `${period} ${service}`).toHaveText(String(overdue));
      expect([d.backlog, d.overdue], `${period} ${service}`).toEqual([backlog, overdue]);
    }
  });

  test('TC-DASH-03 ส่งออก XLSX/PDF สะท้อนตัวเลขที่เลือกและ Audit', async ({ page }) => {
    await reset(page.request); await staff(page, 'exec1'); await open(page, '/dashboard');
    await page.getByTestId('period-select').selectOption('2026-11'); await page.getByTestId('service-select').selectOption('ALL');
    const labels = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
    const kpiIds = ['kpi-received', 'kpi-closed', 'kpi-ontime-pct', 'kpi-backlog', 'kpi-overdue'];
    /** กดปุ่มส่งออก xlsx แล้วอ่านชีตแรก → ต้องเท่าค่าที่คาด (คิดจาก seed) และเท่า 5 ช่อง kpi-* บนจอ */
    const exportXlsx = async (values: string[]) => {
      await expect(page.getByTestId('kpi-received')).toHaveText(values[0]);
      const onScreen = await Promise.all(kpiIds.map(async id => (await page.getByTestId(id).innerText()).trim()));
      const dl = page.waitForEvent('download'); await page.getByTestId('export-xlsx-btn').click(); const f = await dl;
      expect(f.suggestedFilename()).toMatch(/\.xlsx$/);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile((await f.path())!);
      const rows: string[][] = []; wb.worksheets[0].eachRow(r => rows.push([r.getCell(1).text.trim(), r.getCell(2).text.trim()]));
      expect(rows[0]).toEqual(['ตัวชี้วัด', 'ค่า']);
      expect(rows.slice(1, 6)).toEqual(labels.map((l, i) => [l, values[i]]));
      expect(rows.slice(1, 6).map(r => r[1])).toEqual(onScreen);
      const all: string[] = []; wb.eachSheet(ws => ws.eachRow(r => r.eachCell(c => all.push(c.text)))); noPii(all.join('\n'), 'xlsx');
    };
    await exportXlsx(['26', '7', '85.7%', '21', '1']); // พ.ย.
    const pdfDl = page.waitForEvent('download'); await page.getByTestId('export-pdf-btn').click(); const pdfFile = await pdfDl;
    expect(pdfFile.suggestedFilename()).toMatch(/\.pdf$/);
    const pdfBytes = await readFile((await pdfFile.path())!); expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfBytes.toString('latin1')).toContain('kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1');
    const pdfLines = pdfTextLines(pdfBytes); // ข้อความที่ดึงออกมา (ไม่ใช่ไบต์ดิบ)
    expect(pdfLines).toContain('kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1'); noPii(pdfLines.join(' | '), 'pdf');
    await page.getByTestId('period-select').selectOption('2026-12');
    await exportXlsx(['3', '0', '–', '21', '1']); // ธ.ค. (ปิดงาน 0 → –)
    expect((await api(page, 'get', '/api/audit?event=EXPORT')).status()).toBe(403); // ผู้บริหารอ่าน Audit ไม่ได้
    // Audit: EXPORT 3 แถว ของ exec1 (xlsx พ.ย. · pdf พ.ย. · xlsx ธ.ค.)
    await staff(page, 'audit1'); await open(page, '/audit');
    await page.getByTestId('audit-filter-event').selectOption('EXPORT'); await page.getByTestId('audit-apply-btn').click();
    await expect(page.getByTestId('audit-count')).toHaveText('3'); await expect(page.getByTestId('audit-row')).toHaveCount(3);
    for (const a of await page.getByTestId('audit-row').evaluateAll(es => es.map(e => e.getAttribute('data-actor')))) expect(a).toBe('exec1');
    for (const r of await page.getByTestId('audit-role').allInnerTexts()) expect(r.trim()).toBe('executive');
    const details = (await page.getByTestId('audit-detail').allInnerTexts()).map(t => t.trim()).sort();
    expect(details).toEqual(['pdf 2026-11 ALL', 'xlsx 2026-11 ALL', 'xlsx 2026-12 ALL']);
  });

  test('TC-DASH-04 นิยามทันกำหนดรวมเวลาปิดที่ 16:30:00', async ({ page, browser }) => {
    // [B12] ตาม TEST-PLAN: ล็อกอิน 3 บัญชีครั้งเดียว (context แยก) · ตรวจ dashboard หลังขั้น 2–4 · อ่าน closed_at ด้วยเจ้าหน้าที่ (exec อ่านคำขอไม่ได้ = 403)
    await reset(page.request); await clock(page.request, '2026-12-03T16:00:00+07:00');
    const ctx = await Promise.all([0, 1].map(() => browser.newContext()));
    try {
      const reg1 = await ctx[0].newPage(), reg2 = await ctx[1].newPage(), exec = page;
      await staff(reg1, 'off.reg1'); await staff(reg2, 'off.reg2'); await staff(exec, 'exec1');
      expect((await json(await api(reg2, 'post', '/api/cases/EG-2569-000025/approve'))).status).toBe('APPROVED');
      expect((await json(await api(reg1, 'post', '/api/cases/EG-2569-000023/approve'))).status).toBe('APPROVED');
      const dash = async (closed: number, onTime: number) => {
        const d = await json(await api(exec, 'get', '/api/dashboard?period=2026-12&service=ALL'));
        expect([d.closed, d.onTime]).toEqual([closed, onTime]);
        await open(exec, '/dashboard'); await expect(exec.getByTestId('kpi-closed')).toHaveText(String(closed));
        return d;
      };
      const closedAt = async (caseNo: string, iso_: string) => {
        expect((await json(await api(reg2, 'get', `/api/cases/${caseNo}`))).closedAt).toBe(iso_);
        await open(reg2, `/officer/cases/${caseNo}`); await iso(reg2.getByTestId('closed-at'), iso_);
      };
      await clock(page.request, '2026-12-03T16:29:59+07:00'); expect((await api(reg2, 'post', '/api/officer/cases/EG-2569-000025/issue')).status()).toBe(200);
      await closedAt('EG-2569-000025', '2026-12-03T16:29:59+07:00'); await dash(1, 1);
      await clock(page.request, '2026-12-03T16:30:00+07:00'); expect((await api(reg2, 'post', '/api/cases/EG-2569-000026/reject', { reason: 'xxxxxxxxxx' })).status()).toBe(200);
      await closedAt('EG-2569-000026', '2026-12-03T16:30:00+07:00'); await dash(2, 2);
      await clock(page.request, '2026-12-03T16:30:01+07:00'); expect((await api(reg1, 'post', '/api/officer/cases/EG-2569-000023/issue')).status()).toBe(200);
      await closedAt('EG-2569-000023', '2026-12-03T16:30:01+07:00');
      const d = await dash(3, 2); expect(d.backlog).toBe(18); await expect(exec.getByTestId('kpi-backlog')).toHaveText('18');
    } finally { await Promise.all(ctx.map(c => c.close())); }
  });

  test('TC-AUDIT-01 audit บันทึกเหตุการณ์ผู้กระทำและการเปลี่ยนสถานะ', async ({ page, browser }) => {
    await reset(page.request);
    const sessions = new Map<string, { context: Awaited<ReturnType<typeof browser.newContext>>; page: Page }>();
    const session = async (username: string) => {
      let s = sessions.get(username);
      if (!s) { const context = await browser.newContext(); s = { context, page: await context.newPage() }; sessions.set(username, s); await staff(s.page, username); }
      return s.page;
    };
    try {
      let p = await session('off.reg2'); await api(p, 'post', '/api/officer/cases/EG-2569-000028/claim');
      p = await session('off.reg1'); await api(p, 'post', '/api/officer/cases/EG-2569-000020/return', { reason: 'xxxxxxxxxx' });
      p = await session('off.reg2'); await api(p, 'post', '/api/officer/cases/EG-2569-000013/forward');
      p = await session('head1'); await api(p, 'post', '/api/cases/EG-2569-000013/approve');
      p = await session('off.reg2'); await api(p, 'post', '/api/cases/EG-2569-000025/approve'); await api(p, 'post', '/api/officer/cases/EG-2569-000025/issue');
      await api(p, 'post', '/api/cases/EG-2569-000026/reject', { reason: 'xxxxxxxxxx' });
      await api(p, 'post', '/api/officer/cases/EG-2569-000025/unmask', { reason: 'ตรวจสอบตัวตนซ้ำ' });
      p = await session('exec1'); await api(p, 'get', '/api/dashboard/export?format=xlsx&period=2026-12&service=ALL');
      p = await session('admin1'); await api(p, 'put', '/api/admin/services/SV-01', { fee: 25, sla: 3 });
      p = await session('audit1'); await open(p, '/audit');
      await expect(p.getByTestId('audit-count')).toHaveText('16');
      for (const [event, count] of Object.entries({ STAFF_LOGIN: 6, CLAIM: 1, RETURN: 1, FORWARD: 1, APPROVE: 2, ISSUE: 1, REJECT: 1, UNMASK: 1, EXPORT: 1, ADMIN_CHANGE: 1 })) {
        await p.getByTestId('audit-filter-event').selectOption(event); await expect(p.getByTestId('audit-count')).toHaveText(String(count));
      }
      await p.getByTestId('audit-filter-event').selectOption(''); await p.getByTestId('audit-apply-btn').click();
      await expect(p.getByTestId('audit-count')).toHaveText('16'); await expect(p.getByTestId('audit-row')).toHaveCount(16);
      // [เติมตามการ์ด] ฟิลด์ของแต่ละแถวตามตาราง TC-AUDIT-01
      const rows = await p.getByTestId('audit-row').evaluateAll(es => es.map(e => {
        const t = (id: string) => (e.querySelector(`[data-testid="${id}"]`)?.textContent ?? '').trim();
        return { id: Number(e.getAttribute('data-id')), event: e.getAttribute('data-event') ?? '', actor: e.getAttribute('data-actor') ?? '', caseAttr: e.getAttribute('data-case-no') ?? '',
          actorText: t('audit-actor'), role: t('audit-role'), eventText: t('audit-event'), caseNo: t('audit-case-no'), transition: t('audit-transition'), detail: t('audit-detail'),
          iso: e.querySelector('[data-testid="audit-time"]')?.getAttribute('data-iso') ?? '' };
      }));
      for (const r of rows) { expect(r.iso, `${r.event} ${r.actor}`).toBe('2026-12-01T09:00:00+07:00'); expect(r.eventText).toBe(r.event); expect(r.actorText).toBe(r.actor); }
      expect(rows.map(r => r.id), 'เรียงใหม่ → เก่า (เวลาเท่ากันเรียง data-id มาก → น้อย)').toEqual([...rows.map(r => r.id)].sort((x, y) => y - x));
      const want: [string, string, string, string, string, string][] = [ // event · actor · role · caseNo · transition · detail มี
        ['CLAIM', 'off.reg2', 'officer', 'EG-2569-000028', 'SUBMITTED → IN_REVIEW', ''],
        ['RETURN', 'off.reg1', 'officer', 'EG-2569-000020', 'IN_REVIEW → NEED_FIX', 'xxxxxxxxxx'],
        ['FORWARD', 'off.reg2', 'officer', 'EG-2569-000013', 'IN_REVIEW → PENDING_APPROVAL', ''],
        ['APPROVE', 'head1', 'head', 'EG-2569-000013', 'PENDING_APPROVAL → APPROVED', ''],
        ['APPROVE', 'off.reg2', 'officer', 'EG-2569-000025', 'IN_REVIEW → APPROVED', ''],
        ['ISSUE', 'off.reg2', 'officer', 'EG-2569-000025', 'APPROVED → COMPLETED', 'DOC-2569-000002'],
        ['REJECT', 'off.reg2', 'officer', 'EG-2569-000026', 'IN_REVIEW → REJECTED', 'xxxxxxxxxx'],
        ['UNMASK', 'off.reg2', 'officer', 'EG-2569-000025', '–', 'ตรวจสอบตัวตนซ้ำ'],
        ['EXPORT', 'exec1', 'executive', '', '–', 'xlsx 2026-12'],
        ['ADMIN_CHANGE', 'admin1', 'admin', '', '–', 'SV-01 fee 20 → 25'],
      ];
      for (const [event, actor, role, caseNo, transition, detail] of want) {
        const m = rows.filter(r => r.event === event && r.actor === actor); expect(m, `${event} ${actor}`).toHaveLength(1);
        expect(m[0].role, `${event} role`).toBe(role); expect(m[0].transition, `${event} transition`).toBe(transition);
        if (caseNo) { expect(m[0].caseNo, `${event} caseNo`).toBe(caseNo); expect(m[0].caseAttr).toBe(caseNo); }
        if (detail) expect(m[0].detail, `${event} detail`).toContain(detail);
      }
      const logins = rows.filter(r => r.event === 'STAFF_LOGIN');
      expect(logins.map(r => r.actor).sort()).toEqual(['admin1', 'audit1', 'exec1', 'head1', 'off.reg1', 'off.reg2']);
      for (const r of logins) expect(r.transition).toBe('–');
      // ตัวกรอง actor / event / ทั้งคู่
      const filter = async (actor: string, event: string, n: number) => {
        await p.getByTestId('audit-filter-actor').fill(actor); await p.getByTestId('audit-filter-event').selectOption(event); await p.getByTestId('audit-apply-btn').click();
        await expect(p.getByTestId('audit-count'), `actor=${actor} event=${event}`).toHaveText(String(n)); await expect(p.getByTestId('audit-row')).toHaveCount(n);
      };
      await filter('off.reg2', '', 7);
      expect((await p.getByTestId('audit-row').evaluateAll(es => es.map(e => e.getAttribute('data-event')))).sort()).toEqual(['APPROVE', 'CLAIM', 'FORWARD', 'ISSUE', 'REJECT', 'STAFF_LOGIN', 'UNMASK']);
      await filter('', 'APPROVE', 2); await filter('off.reg2', 'APPROVE', 1); await filter('', '', 16);
      // CSV: หัวตารางตาม CONTRACT 7 · แถวข้อมูล 16 (เท่าหน้าจอ) · หลังส่งออกมี EXPORT ของ audit1 เพิ่ม 1 (detail audit-csv)
      const csv = p.waitForEvent('download'); await p.getByTestId('audit-export-csv-btn').click(); const csvFile = await csv; expect(csvFile.suggestedFilename()).toContain('.csv');
      const lines = (await readFile((await csvFile.path())!, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.length > 0);
      expect(lines[0]).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail'); expect(lines.length - 1).toBe(16);
      await p.getByTestId('audit-apply-btn').click(); await expect(p.getByTestId('audit-count')).toHaveText('17');
      const last = p.getByTestId('audit-row').first(); await expect(last).toHaveAttribute('data-event', 'EXPORT'); await expect(last).toHaveAttribute('data-actor', 'audit1');
      await expect(last.getByTestId('audit-detail')).toContainText('audit-csv');
    } finally { await Promise.all([...sessions.values()].map(s => s.context.close())); }
  });

  test('TC-AUDIT-02 audit เป็น append-only และอ่านได้เฉพาะ auditor', async ({ page, browser }) => {
    await reset(page.request); await staff(page, 'audit1');
    const before = await json(await api(page, 'get', '/api/audit')); const id = before.items[0].id;
    expect(before.items.map((x: any) => [x.event, x.username])).toEqual([['STAFF_LOGIN', 'audit1']]);
    const actx = await browser.newContext(); const admin = await actx.newPage(); // admin1 คนละ context (ไม่ให้ audit1 ล็อกอินซ้ำจนเกิดแถวเกิน)
    try {
      await staff(admin, 'admin1');
      for (const [who, p] of [['admin1', admin], ['audit1', page]] as const) {
        for (const [method, path, data] of [['put', `/api/audit/${id}`, { detail: 'x' }], ['patch', `/api/audit/${id}`, {}], ['delete', `/api/audit/${id}`, undefined], ['put', '/api/audit', {}], ['delete', '/api/audit', undefined], ['delete', '/api/audit/999999', undefined]] as const) {
          const r = await api(p, method, path, data);
          expect(r.status(), `${who} ${method} ${path}`).toBe(405); expect((await json(r)).code, `${who} ${method} ${path}`).toBe('METHOD_NOT_ALLOWED');
        }
      }
      const after = await json(await api(page, 'get', '/api/audit')); expect(after.items).toEqual(expect.arrayContaining(before.items));
      const added = after.items.filter((x: any) => !before.items.some((b: any) => b.id === x.id)); // เพิ่มได้เฉพาะ STAFF_LOGIN ของ admin1
      expect(added.map((x: any) => [x.event, x.username])).toEqual([['STAFF_LOGIN', 'admin1']]); expect(after.count).toBe(2);
      await open(page, '/audit'); await expect(page.getByTestId('audit-row')).toHaveCount(2);
      await expect(page.getByTestId('audit-edit-btn')).toHaveCount(0); await expect(page.getByTestId('audit-delete-btn')).toHaveCount(0);
      expect((await api(admin, 'get', '/api/audit')).status()).toBe(403);
    } finally { await actx.close(); }
  });

  test('TC-AUDIT-03 audit กรองวันที่ตามเขตเวลาไทยแบบ inclusive', async ({ page }) => {
    // [B12] ตัดการล็อกอิน audit1 ซ้ำ (เกิดแถว L6 นอกแผน) · ใช้ audit-apply-btn ตาม CONTRACT · เพิ่มแถว actor และตรวจ API
    await reset(page.request);
    const logs = [['2026-11-30T23:59:59+07:00', 'off.reg1'], ['2026-12-01T00:00:00+07:00', 'off.reg2'], ['2026-12-01T23:59:59+07:00', 'off.works1'], ['2026-12-02T00:00:00+07:00', 'off.reg1'], ['2026-12-02T09:00:00+07:00', 'audit1']] as const;
    for (const [time, username] of logs) { await clock(page.request, time); await staff(page, username); }
    await open(page, '/audit');
    const rows: [string, string, string, string[]][] = [
      ['2026-12-01', '2026-12-01', '', ['L2', 'L3']], ['2026-11-30', '2026-11-30', '', ['L1']], ['2026-11-30', '2026-12-01', '', ['L1', 'L2', 'L3']],
      ['2026-12-02', '', '', ['L4', 'L5']], ['', '2026-11-30', '', ['L1']], ['2026-12-01', '2026-12-02', '', ['L2', 'L3', 'L4', 'L5']], ['2026-12-01', '2026-12-01', 'off.reg2', ['L2']],
    ];
    const isoOf = (l: string) => logs[Number(l.slice(1)) - 1][0];
    for (const [from, to, actor, want] of rows) {
      await page.getByTestId('audit-filter-from').fill(from); await page.getByTestId('audit-filter-to').fill(to); await page.getByTestId('audit-filter-actor').fill(actor);
      await page.getByTestId('audit-apply-btn').click(); await expect(page.getByTestId('audit-count')).toHaveText(String(want.length));
      const times = await page.getByTestId('audit-time').evaluateAll(es => es.map(e => e.getAttribute('data-iso')));
      expect(times.sort(), `${from}..${to} ${actor}`).toEqual(want.map(isoOf).sort());
      const r = await json(await api(page, 'get', `/api/audit?actor=${actor}&event=&from=${from}&to=${to}`)); expect(r.count).toBe(want.length);
    }
  });

  test('TC-RBAC-04 ผู้ดูแลแก้ค่าบริการ วันหยุดและบทบาท พร้อมยอดที่ล็อก', async ({ page, browser }) => {
    // [B12] เขียนใหม่ตาม TEST-PLAN 11 ขั้น (ของเดิมให้ admin อ่าน /api/cases ซึ่ง CONTRACT กำหนด 403 และไม่ได้สร้าง …000031)
    await reset(page.request);
    const actx = await browser.newContext(); const admin = await actx.newPage();
    const ectx = await browser.newContext(); const exec = await ectx.newPage();
    try {
      await staff(admin, 'admin1');
      await open(admin, '/admin/holidays'); await expect(admin.getByTestId('holiday-row')).toHaveCount(4);
      expect(await admin.getByTestId('holiday-row').evaluateAll(es => es.map(e => e.getAttribute('data-date')))).toEqual(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
      expect(await newPaid(page)).toBe('EG-2569-000031');
      expect((await json(await api(page, 'get', '/api/cases/EG-2569-000031'))).dueAt).toBe('2026-12-04T16:30:00+07:00');
      await open(admin, '/admin/services');
      await admin.getByTestId('svc-fee-SV-01').fill('25'); await admin.getByTestId('svc-save-SV-01').click(); await expect(admin.getByTestId('action-success')).toBeVisible();
      await open(admin, '/admin/services');
      await admin.getByTestId('svc-fee-SV-02').fill('600'); await admin.getByTestId('svc-save-SV-02').click(); await expect(admin.getByTestId('action-success')).toBeVisible();
      await open(page, '/citizen/new/SV-01');
      await page.getByTestId('qty-input').fill('5'); await expect(page.getByTestId('fee-total')).toHaveText('฿125');
      await page.getByTestId('qty-input').fill('1'); await expect(page.getByTestId('fee-total')).toHaveText('฿25');
      await open(page, '/citizen/new/SV-02'); await expect(page.getByTestId('fee-total')).toHaveText('฿600');
      await open(page, '/citizen/cases/EG-2569-000030'); await expect(page.getByTestId('case-fee')).toHaveText('฿20');
      await open(page, '/citizen/new/SV-02?draft=DR-0002'); await expect(page.getByTestId('payment-amount')).toHaveText('฿500');
      const bad = await api(page, 'post', '/api/test/payments/PP-0001/pay', { amount: 600 }); expect(bad.status()).toBe(422); expect((await json(bad)).code).toBe('AMOUNT_MISMATCH');
      const good = await api(page, 'post', '/api/test/payments/PP-0001/pay', { amount: 500 }); expect(good.status()).toBe(200);
      expect(await json(good)).toMatchObject({ status: 'PAID', caseNo: 'EG-2569-000032' });
      await open(admin, '/admin/holidays');
      await admin.getByTestId('holiday-date-input').fill('2026-12-02'); await admin.getByTestId('holiday-name-input').fill('วันหยุดทดสอบ'); await admin.getByTestId('holiday-add-btn').click();
      await expect(admin.getByTestId('holiday-row')).toHaveCount(5);
      expect((await json(await api(page, 'get', '/api/cases/EG-2569-000031'))).dueAt).toBe('2026-12-04T16:30:00+07:00');
      expect(await newPaid(page)).toBe('EG-2569-000033');
      const c33 = await json(await api(page, 'get', '/api/cases/EG-2569-000033')); expect(c33.fee).toBe(25); expect(c33.dueAt).toBe('2026-12-08T16:30:00+07:00');
      expect((await api(admin, 'put', '/api/admin/users/exec1', { role: 'auditor', dept: '' })).status()).toBe(200);
      await open(exec, '/login'); await exec.getByTestId('login-tab-staff').click();
      await exec.getByTestId('staff-username').fill('exec1'); await exec.getByTestId('staff-password').fill(staffPassword); await exec.getByTestId('staff-submit').click();
      await expect(exec).toHaveURL(/\/audit$/);
      const forbidden = await exec.goto(url('/dashboard')); expect(forbidden?.status()).toBe(403); await expect(exec.getByTestId('forbidden-msg')).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้');
      expect((await api(exec, 'get', '/api/dashboard?period=2026-12&service=ALL')).status()).toBe(403);
      const adminChanges = async (n: number, details: string[]) => {
        await open(exec, '/audit'); await exec.getByTestId('audit-filter-event').selectOption('ADMIN_CHANGE'); await exec.getByTestId('audit-apply-btn').click();
        await expect(exec.getByTestId('audit-count')).toHaveText(String(n));
        for (const a of await exec.getByTestId('audit-actor').allInnerTexts()) expect(a.trim()).toBe('admin1');
        for (const r of await exec.getByTestId('audit-role').allInnerTexts()) expect(r.trim()).toBe('admin');
        const all = (await exec.getByTestId('audit-detail').allInnerTexts()).join('\n');
        for (const d of details) expect(all).toContain(d);
      };
      const det = ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor'];
      await adminChanges(4, det);
      expect((await api(admin, 'post', '/api/drafts', { serviceId: 'SV-01', qty: 1 })).status()).toBe(403);
      await open(admin, '/admin/holidays');
      await admin.locator('[data-testid="holiday-delete-btn"][data-date="2026-12-02"], [data-testid="holiday-row"][data-date="2026-12-02"] [data-testid="holiday-delete-btn"]').first().click();
      await expect(admin.getByTestId('holiday-row')).toHaveCount(4);
      await adminChanges(5, [...det, 'holiday delete 2026-12-02']);
    } finally { await actx.close(); await ectx.close(); }
  });

  test('TC-RBAC-05 สิทธิ์อ่านและดาวน์โหลดไฟล์แนบแยกตามบทบาท/ขั้นตอน', async ({ page, browser }) => {
    const one = ['id-card.pdf'], three = ['deed.pdf', 'id-card.pdf', 'plan.pdf'];
    /** ผู้เรียกปัจจุบันต้องเห็นรายการไฟล์ครบตามชื่อ และดาวน์โหลดทุกไฟล์ได้ (%PDF · application/pdf) → คืน fileId ตัวแรก */
    const allowed = async (who: string, caseNo: string, names: string[]) => {
      const r = await api(page, 'get', `/api/cases/${caseNo}/files`); expect(r.status(), `${who} ${caseNo} files`).toBe(200);
      const items = (await json(r)).items as { fileId: string; name: string }[];
      expect(items.map(x => x.name).sort(), `${who} ${caseNo}`).toEqual(names);
      for (const it of items) {
        const f = await api(page, 'get', `/api/files/${it.fileId}`); expect(f.status(), `${who} ${caseNo} ${it.name}`).toBe(200);
        expect(f.headers()['content-type']).toContain('application/pdf'); expect((await f.body()).subarray(0, 4).toString()).toBe('%PDF');
      }
      return items[0].fileId;
    };
    const denied = async (who: string, caseNo: string, fileId: string, code: number) => {
      expect((await api(page, 'get', `/api/cases/${caseNo}/files`)).status(), `${who} ${caseNo} files`).toBe(code);
      expect((await api(page, 'get', `/api/files/${fileId}`)).status(), `${who} ${caseNo} file`).toBe(code);
    };
    await reset(page.request); await staff(page, 'off.reg1');
    const f25 = await allowed('off.reg1', 'EG-2569-000025', one);
    await allowed('off.reg1', 'EG-2569-000010', three); // เคยผ่านทะเบียนแล้ว
    expect((await api(page, 'get', '/api/files/99999999')).status(), 'fileId ที่ไม่มี').toBe(404);
    await open(page, '/officer/cases/EG-2569-000025'); // UI: รายการเอกสารแนบ + ลิงก์ดาวน์โหลด
    await expect(page.getByTestId('doc-item')).toHaveCount(1); await expect(page.getByTestId('doc-item')).toHaveAttribute('data-name', 'id-card.pdf');
    const href = await page.getByTestId('doc-item').getByTestId('doc-download-link').getAttribute('href'); expect(href).toBe(`/api/files/${f25}`);
    expect((await (await api(page, 'get', href!)).body()).length).toBeGreaterThan(0);
    await staff(page, 'off.reg2');
    const f12 = await allowed('off.reg2', 'EG-2569-000012', three); // SV-03 ขั้น 1/3 ที่ตัวเองถือ
    await open(page, '/officer/cases/EG-2569-000012'); await expect(page.getByTestId('doc-item')).toHaveCount(3);
    await staff(page, 'off.works1');
    await denied('off.works1', 'EG-2569-000025', f25, 403); // ไม่เคยผ่านโยธา
    await denied('off.works1', 'EG-2569-000012', f12, 403); // ยังไม่ถึงขั้นโยธา
    await allowed('off.works1', 'EG-2569-000010', three);   // อยู่ขั้นโยธา
    await allowed('off.works1', 'EG-2569-000011', three);   // ผ่านโยธาแล้ว รออนุมัติ
    await staff(page, 'head1');
    await allowed('head1', 'EG-2569-000025', one); await allowed('head1', 'EG-2569-000010', three); await allowed('head1', 'EG-2569-000012', three);
    await citizen(page, '3100600987659'); // สมหญิง (เจ้าของ)
    await allowed('สมหญิง', 'EG-2569-000025', one);
    await open(page, '/citizen/cases/EG-2569-000025'); await expect(page.getByTestId('doc-item')).toHaveCount(1);
    await citizen(page); await denied('สมชาย', 'EG-2569-000025', f25, 404); // ของคนอื่น → 404
    for (const u of ['exec1', 'audit1', 'admin1']) { await staff(page, u); await denied(u, 'EG-2569-000025', f25, 403); }
    const anon = await browser.newContext(); // ไม่ล็อกอิน
    try {
      expect((await anon.request.get(url('/api/cases/EG-2569-000025/files'))).status()).toBe(401);
      expect((await anon.request.get(url(`/api/files/${f25}`))).status()).toBe(401);
    } finally { await anon.close(); }
  });

  test('TC-RBAC-06 ผู้ดูแลตรวจช่วง fee/SLA และการเปลี่ยนค่าที่ขัดเงื่อนไข', async ({ page }) => {
    await reset(page.request); await staff(page, 'admin1'); await open(page, '/admin/services');
    // [เติมตามการ์ด] บนจอ: ค่านอกช่วง → action-error ตามตาราง 5 และค่าเดิมไม่เปลี่ยน
    const sv01 = async () => (await json(await api(page, 'get', '/api/admin/services'))).items.find((x: any) => x.id === 'SV-01');
    await page.getByTestId('svc-fee-SV-01').fill('-1'); await page.getByTestId('svc-save-SV-01').click();
    await expect(page.getByTestId('action-error')).toHaveText('ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท');
    expect(await sv01()).toMatchObject({ fee: 20, sla: 3 });
    await open(page, '/admin/services'); await page.getByTestId('svc-sla-SV-01').fill('0'); await page.getByTestId('svc-save-SV-01').click();
    await expect(page.getByTestId('action-error')).toHaveText('SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ');
    expect(await sv01()).toMatchObject({ fee: 20, sla: 3 });
    const cases = [
      [{ fee: -1 }, 400, 'INVALID_FEE'], [{ fee: 0 }, 200, ''], [{ fee: 100000 }, 200, ''], [{ fee: 100001 }, 400, 'INVALID_FEE'],
      [{ sla: 0 }, 400, 'INVALID_SLA'], [{ sla: 1 }, 200, ''], [{ sla: 60 }, 200, ''], [{ sla: 61 }, 400, 'INVALID_SLA'],
    ] as const;
    for (const [value, code, error] of cases) { const r = await api(page, 'put', '/api/admin/services/SV-01', value); expect(r.status(), JSON.stringify(value)).toBe(code); if (error) expect((await json(r)).code).toBe(error); }
    expect(await sv01()).toMatchObject({ fee: 100000, sla: 60 }); // ค่าที่ยอมรับล่าสุด · ค่านอกช่วงไม่ถูกบันทึก
    const duplicate = await api(page, 'post', '/api/admin/holidays', { date: '2026-12-07', name: 'ซ้ำ' }); expect(duplicate.status()).toBe(409);
    const dupBody = await json(duplicate); expect(dupBody.code).toBe('DUPLICATE_HOLIDAY'); expect(dupBody.message).toBe('มีวันหยุดนี้อยู่แล้ว');
    await open(page, '/admin/holidays'); await expect(page.getByTestId('holiday-row')).toHaveCount(4);
    expect((await api(page, 'post', '/api/admin/holidays', { date: '2026-12-05', name: 'วันเสาร์' })).status()).toBe(201);
    const self = await api(page, 'put', '/api/admin/users/admin1', { role: 'executive', dept: '' }); expect(self.status()).toBe(409); expect((await json(self)).code).toBe('SELF_ROLE_CHANGE');
    const me = await json(await api(page, 'get', '/api/me')); expect(me.role).toBe('admin');
    // Audit: ADMIN_CHANGE = 5 (fee 0 · fee 100000 · sla 1 · sla 60 · holiday add 2026-12-05) · คำขอที่ถูกปฏิเสธไม่ถูกบันทึก
    await staff(page, 'audit1');
    const log = await json(await api(page, 'get', '/api/audit?event=ADMIN_CHANGE')); expect(log.count).toBe(5);
    expect(log.items.map((x: any) => x.detail).join('\n')).toContain('holiday add 2026-12-05');
    for (const x of log.items) expect([x.username, x.role]).toEqual(['admin1', 'admin']);
  });

  test('TC-NFR-01 11 หน้าพอดีกับ viewport 375, 768 และ 1280', async ({ page }) => {
    const views = [ [375,812], [768,1024], [1280,800] ] as const;
    await reset(page.request); await open(page, '/login');
    for (const [width,height] of views) { await page.setViewportSize({ width, height }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy(); }
    const paths = [
      ['citizen','/citizen'], ['citizen','/citizen/new/SV-03'], ['citizen','/citizen/cases/EG-2569-000013'],
      ['off.reg1','/officer/queue'], ['off.reg1','/officer/cases/EG-2569-000020'], ['head1','/head/approvals'],
      ['exec1','/dashboard'], ['audit1','/audit'], ['admin1','/admin/services'],
    ] as const;
    for (const [user,path] of paths) {
      await reset(page.request); if (user === 'citizen') await citizen(page); else await staff(page, user);
      for (const [width,height] of views) { await page.setViewportSize({ width,height }); await open(page,path); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} at ${width}`).toBeTruthy(); }
    }
    await reset(page.request); await open(page, '/verify/K7M2Q9XA');
    for (const [width,height] of views) { await page.setViewportSize({ width,height }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy(); }
    // [B12] งานหลักที่ 375 px ตาม TEST-PLAN
    await reset(page.request); await page.setViewportSize({ width: 375, height: 812 });
    await open(page, '/login'); await page.getByTestId('login-tab-citizen').click(); await page.getByTestId('thaid-id-input').fill(citizenId); await page.getByTestId('thaid-submit').click();
    await page.getByTestId('otp-input').fill(otp); await page.getByTestId('otp-submit').click(); await expect(page).toHaveURL(/\/citizen$/);
    await page.getByTestId('start-service-SV-01').click(); await page.getByTestId('qty-input').fill('1'); await expect(page.getByTestId('fee-total')).toHaveText('฿20');
    await page.getByTestId('to-upload-btn').click();
    await page.getByTestId('upload-input-id-card').setInputFiles({ name: 'id-card.pdf', mimeType: 'application/pdf', buffer: pdfBuf() });
    await expect(page.getByTestId('to-payment-btn')).toBeEnabled(); await page.getByTestId('to-payment-btn').click();
    const qr = page.getByTestId('create-qr-btn'); await expect(qr).toBeVisible(); const box = (await qr.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });

  test('TC-NFR-02 axe, label, keyboard focus and text status semantics', async ({ page }) => {
    // [B12] ใส่ผู้ใช้ทุก route ตาม TEST-PLAN ส่วน A (ของเดิมไม่ล็อกอิน → axe ตรวจแต่หน้า /login)
    const routes: [string, string?][] = [['/login'], ['/register', 'mana'], ['/citizen', 'citizen'], ['/citizen/new/SV-01', 'citizen'], ['/citizen/cases/EG-2569-000017', 'citizen'], ['/officer/queue', 'off.reg1'], ['/officer/cases/EG-2569-000020', 'off.reg1'], ['/head/approvals', 'head1'], ['/dashboard', 'exec1'], ['/audit', 'audit1'], ['/admin/services', 'admin1'], ['/notifications', 'off.reg1'], ['/verify/K7M2Q9XA']];
    for (const [path,user] of routes) {
      await page.emulateMedia({ forcedColors: 'none' });
      await reset(page.request); if (user === 'citizen') await citizen(page); else if (user === 'mana') await citizen(page, '5500400111221'); else if (user) await staff(page,user);
      await open(page,path);
      if (user) await expect(page, `${path} ต้องไม่ถูกพาไป /login`).not.toHaveURL(/\/login$/);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
      expect(results.violations.filter(v => ['serious','critical'].includes(v.impact ?? '')).map(v => `${path} ${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
      const unlabeled = await page.locator('input:visible,select:visible,textarea:visible').evaluateAll(els => els.filter((e: any) => !(e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby'))).length);
      expect(unlabeled, path).toBe(0);
      for (const forced of ['none', 'active'] as const) {
        await page.emulateMedia({ forcedColors: forced });
        for (const id of ['case-status','row-status']) for (const item of await page.getByTestId(id).all()) {
          const code = await item.evaluate(e => e.getAttribute('data-status') ?? e.closest('[data-status]')?.getAttribute('data-status'));
          expect((await item.innerText()).trim(), `${path} ${id} ${code}`).toBe(statusText[code ?? '']);
        }
        for (const id of ['sla-level','row-sla-level']) for (const item of await page.getByTestId(id).all()) {
          const code = await item.evaluate(e => e.getAttribute('data-level') ?? e.closest('[data-sla-level]')?.getAttribute('data-sla-level'));
          expect((await item.innerText()).trim(), `${path} ${id} ${code}`).toBe(levelText[code ?? '']);
        }
      }
    }
    await page.emulateMedia({ forcedColors: 'none' });
    const tabTo = async (testid: string) => {
      for (let i = 0; i < 40; i++) {
        if (await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.testid) === testid) return;
        await page.keyboard.press('Tab');
      }
      throw new Error(`Keyboard focus did not reach ${testid}`);
    };
    const focusRing = async () => expect(await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement as HTMLElement);
      return s.outlineStyle !== 'none' || s.boxShadow !== 'none';
    })).toBeTruthy();
    await reset(page.request); await open(page,'/login');
    await tabTo('thaid-id-input'); await focusRing(); await page.keyboard.type(citizenId); await page.keyboard.press('Enter');
    await tabTo('otp-input'); await focusRing(); await page.keyboard.type(otp); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/citizen$/);
    await tabTo('start-service-SV-01'); await focusRing(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/citizen\/new\/SV-01$/);
    await tabTo('qty-input'); await focusRing(); await page.keyboard.press('Control+A'); await page.keyboard.type('1');
    await tabTo('to-upload-btn'); await focusRing(); await page.keyboard.press('Enter');
    await tabTo('upload-input-id-card'); await focusRing();
    await page.getByTestId('upload-input-id-card').setInputFiles({ name: 'id-card.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nkeyboard fixture') });
    await tabTo('to-payment-btn'); await focusRing(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('create-qr-btn')).toBeVisible();
  });

  test('TC-NFR-03 health, response time and reset reproducibility', async ({ page }) => {
    await reset(page.request);
    const health = await api(page, 'get', '/api/health'); expect(health.status()).toBe(200); expect(await health.text()).toBe('{"status":"ok"}');
    await open(page,'/login'); let start = Date.now(); await page.goto(url('/login'),{ waitUntil:'load' }); start = Date.now(); await page.goto(url('/login'),{ waitUntil:'load' }); expect(Date.now()-start).toBeLessThanOrEqual(3000);
    for (const [user,path] of [['citizen','/citizen'],['off.reg1','/officer/queue'],['exec1','/dashboard'],['audit1','/audit']] as const) {
      await staffOrCitizen(page,user); await open(page,path); await page.goto(url(path), { waitUntil: 'load' }); const startedAt = Date.now(); await page.goto(url(path),{ waitUntil:'load' }); expect(Date.now()-startedAt).toBeLessThanOrEqual(3000);
    }
    await reset(page.request); await staff(page,'off.reg1');
    const snapshot = async () => ({ clock: await json(await api(page,'get','/api/test/clock')), queue: await json(await api(page,'get','/api/officer/queue')), dashboard: await json(await api(page,'get','/api/dashboard?period=2026-12&service=ALL')) });
    const s1 = await snapshot(); expect(s1.clock.now).toBe('2026-12-01T09:00:00+07:00');
    // เปลี่ยนสถานะตามการ์ด: CLOCK · claim …000028 · pay ใหม่ 1 ใบ
    await clock(page.request,'2026-12-10T12:00:00+07:00'); expect((await api(page,'post','/api/officer/cases/EG-2569-000028/claim')).status()).toBe(200);
    expect(await newPaid(page)).toBe('EG-2569-000031');
    await reset(page.request); await staff(page,'off.reg1'); const s2 = await snapshot(); expect(s2).toEqual(s1);
    const invalid = await api(page,'put','/api/test/clock',{ now:'2026-12-01 09:00' }); expect(invalid.status()).toBe(400);
    expect((await invalid.json()).code).toBe('INVALID_TIME');
  });

  test('TC-NFR-04 ข้อมูล PII ในไฟล์ฐานข้อมูลไม่เป็นข้อความดิบ', async ({ page }) => {
    if (!process.env.DB_PATH) throw new Error('TC-NFR-04 ต้องกำหนด DB_PATH ให้ชี้ฐานข้อมูลสำหรับ inspection');
    await reset(page.request); await citizen(page, '5500400111221'); await open(page,'/register');
    await page.getByTestId('reg-mobile').fill('0845678901'); await page.getByTestId('reg-consent').check(); await page.getByTestId('reg-submit').click();
    // [B12] SQLite อาจเขียนลง -wal ก่อน checkpoint → ตรวจไฟล์ DB + -wal + -shm รวมกัน
    const parts = await Promise.all(['', '-wal', '-shm'].map(s => readFile(process.env.DB_PATH! + s).catch(() => Buffer.alloc(0))));
    expect(parts[0].length).toBeGreaterThan(0);
    const db = Buffer.concat(parts);
    const secrets = ['1101700123456','3100600987659','1909900555015','5500400111221','0812345678','0823456789','0834567890','0845678901','1-1017-00123-45-6','3-1006-00987-65-9','1-9099-00555-01-5','5-5004-00111-22-1'];
    for (const secret of secrets) expect(db.includes(Buffer.from(secret))).toBeFalsy();
    await citizen(page); const c = await json(await api(page,'get','/api/cases/EG-2569-000005')); expect(c.idNo).toBe(citizenId);
  });
});

async function staffOrCitizen(page: Page, user: string) {
  if (user === 'citizen') await citizen(page); else await staff(page,user);
}
