import { test, expect, request, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const OTP = '123456';
const PASS = 'Test@1234';
const ids = {
  somchai: '1101700123456', somying: '3100600987659', mana: '5500400111221', piti: '1909900555015',
};

type Harness = { browser: Browser; context: BrowserContext; page: Page; api: APIRequestContext };

async function fresh(browser: Browser, old?: Harness): Promise<Harness> {
  if (old) await old.context.close();
  const resetApi = await request.newContext({ baseURL: BASE });
  const reset = await resetApi.post('/api/test/reset');
  expect(reset.status()).toBe(200);
  expect((await reset.json()).now).toBe('2026-12-01T09:00:00+07:00');
  await resetApi.dispose();
  const context = await browser.newContext({ baseURL: BASE });
  return { browser, context, page: await context.newPage(), api: context.request };
}

async function loginCitizen(h: Harness, idNo = ids.somchai) {
  const r = await h.api.post('/api/auth/thaid/start', { data: { idNo } });
  expect(r.status()).toBe(200);
  const v = await h.api.post('/api/auth/thaid/verify', { data: { idNo, otp: OTP } });
  expect(v.status()).toBe(200);
  return v.json();
}

async function loginStaff(h: Harness, username = 'off.reg1', password = PASS) {
  return h.api.post('/api/auth/staff/login', { data: { username, password } });
}

async function setClock(h: Harness, now: string) {
  const r = await h.api.put('/api/test/clock', { data: { now } });
  expect(r.status()).toBe(200);
}

async function uiCitizenLogin(page: Page, idNo = ids.somchai) {
  await page.goto('/login');
  await page.getByTestId('login-tab-citizen').click();
  await page.getByTestId('thaid-id-input').fill(idNo);
  await page.getByTestId('thaid-submit').click();
  await expect(page.getByTestId('otp-step')).toBeVisible();
  await page.getByTestId('otp-input').fill(OTP);
  await page.getByTestId('otp-submit').click();
}

async function uiStaffLogin(page: Page, username = 'off.reg1', password = PASS) {
  await page.goto('/login');
  await page.getByTestId('login-tab-staff').click();
  await page.getByTestId('staff-username').fill(username);
  await page.getByTestId('staff-password').fill(password);
  await page.getByTestId('staff-submit').click();
}

async function createDraft(h: Harness, serviceId: string, values: Record<string, unknown> = {}) {
  const r = await h.api.post('/api/drafts', { data: { serviceId, ...values } });
  expect(r.status()).toBe(201);
  return r.json();
}

function pdf(size = 1024): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  return Buffer.concat([head, Buffer.alloc(size - head.length - tail.length, 0x20), tail]);
}

function uploadFile(name: string, buffer = pdf(), mimeType = 'application/pdf') {
  return { name, mimeType, buffer };
}

async function attach(h: Harness, draftId: string, docKey: string, file: ReturnType<typeof uploadFile>) {
  return h.api.post(`/api/drafts/${draftId}/files`, { multipart: { docKey, file } });
}

async function newPaid(h: Harness, { citizen = ids.somchai, service = 'SV-01', qty = 1, areaSqm, amount }: {
  citizen?: string; service?: string; qty?: number; areaSqm?: number; amount?: number;
} = {}) {
  await loginCitizen(h, citizen);
  const draft = await createDraft(h, service, service === 'SV-01' ? { qty } : service === 'SV-03' ? { areaSqm } : {});
  const files: Array<[string, string]> = service === 'SV-03'
    ? [['id-card', 'id-card.pdf'], ['plan', 'plan.pdf'], ['deed', 'deed.pdf']]
    : service === 'SV-02' ? [['id-card', 'id-card.pdf'], ['map', 'map.pdf']]
      : [['id-card', 'id-card.pdf']];
  for (const [docKey, name] of files) expect((await attach(h, draft.draftId, docKey, uploadFile(name))).status()).toBe(201);
  const payment = await h.api.post(`/api/drafts/${draft.draftId}/payment`);
  expect(payment.status()).toBe(201);
  const p = await payment.json();
  const pay = await h.api.post(`/api/test/payments/${p.ref}/pay`, { data: { amount: amount ?? p.amount } });
  return { draft, payment: p, pay };
}

/** [เติมตามการ์ด] จำนวนแถว Audit ตามตัวกรอง (ล็อกอิน audit1 ใน context แยก · STAFF_LOGIN ที่เกิดไม่กระทบเหตุการณ์อื่น) */
async function auditCount(browser: Browser, query: string): Promise<number> {
  const ctx = await browser.newContext({ baseURL: BASE });
  try {
    expect((await ctx.request.post('/api/auth/staff/login', { data: { username: 'audit1', password: PASS } })).status()).toBe(200);
    const r = await ctx.request.get(`/api/audit?${query}`); expect(r.status()).toBe(200);
    return (await r.json()).count as number;
  } finally { await ctx.close(); }
}

async function expectApiError(response: Awaited<ReturnType<APIRequestContext['post']>>, status: number, code: string) {
  expect(response.status()).toBe(status);
  expect((await response.json()).code).toBe(code);
}

test('TC-AUTH-01 · Thai ID validation boundaries and checksum', async ({ browser }) => {
  const h = await fresh(browser);
  await h.page.goto('/login');
  await h.page.getByTestId('login-tab-citizen').click();
  for (const bad of ['110170012345', '11017001234567', '1101700123457', '11017001234ab']) {
    const r = await h.api.post('/api/auth/thaid/start', { data: { idNo: bad } });
    await expectApiError(r, 400, 'INVALID_ID');
    await h.page.getByTestId('thaid-id-input').fill(bad);
    await h.page.getByTestId('thaid-submit').click();
    await expect(h.page.getByTestId('thaid-error')).toHaveText('เลขบัตรประชาชนไม่ถูกต้อง');
    await expect(h.page.getByTestId('otp-step')).not.toBeVisible(); // [B12] แผน: 'ไม่แสดง' (ซ่อนได้ ไม่จำเป็นต้องไม่มีใน DOM)
  }
  for (const idNo of [ids.somchai, ids.somying, ids.mana, ids.piti]) {
    const r = await h.api.post('/api/auth/thaid/start', { data: { idNo } });
    expect(r.status()).toBe(200); expect(await r.json()).toEqual({ status: 'OTP_SENT' });
  }
  for (const idNo of [ids.somchai, ids.somying, ids.piti, ids.mana]) { // การ์ด: otp-step แสดงทุกค่า · ไม่มี thaid-error
    await h.page.goto('/login'); await h.page.getByTestId('login-tab-citizen').click();
    await h.page.getByTestId('thaid-id-input').fill(idNo);
    await h.page.getByTestId('thaid-submit').click();
    await expect(h.page.getByTestId('otp-step'), idNo).toBeVisible();
    await expect(h.page.getByTestId('thaid-error'), idNo).not.toBeVisible();
  }
  await h.context.close();
});

test('TC-AUTH-02 · three invalid OTPs lock only that identity for 15 minutes', async ({ browser }) => {
  let h = await fresh(browser);
  await h.page.goto('/login'); await h.page.getByTestId('thaid-id-input').fill(ids.piti); await h.page.getByTestId('thaid-submit').click();
  for (const left of ['เหลือ 2 ครั้ง', 'เหลือ 1 ครั้ง']) {
    await h.page.getByTestId('otp-input').fill('000000'); await h.page.getByTestId('otp-submit').click();
    await expect(h.page.getByTestId('otp-error')).toHaveText('รหัส OTP ไม่ถูกต้อง');
    await expect(h.page.getByTestId('otp-attempts-left')).toHaveText(left);
  }
  await h.page.getByTestId('otp-input').fill('000000'); await h.page.getByTestId('otp-submit').click();
  await expect(h.page.getByTestId('lock-message')).toHaveText('ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
  await expect(h.page.getByTestId('lock-until')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
  h = await fresh(browser, h);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
    const r = await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: '000000' } });
    if (attempt < 3) {
      await expectApiError(r, 401, 'OTP_INVALID');
      expect((await r.json()).attemptsLeft).toBe(3 - attempt);
    } else {
      await expectApiError(r, 423, 'LOCKED');
      expect((await r.json()).lockedUntil).toBe('2026-12-01T09:15:00+07:00');
    }
  }
  await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
  await expectApiError(await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: OTP } }), 423, 'LOCKED');
  await loginCitizen(h, ids.somchai);
  await setClock(h, '2026-12-01T09:14:59+07:00');
  await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
  await expectApiError(await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: OTP } }), 423, 'LOCKED');
  await setClock(h, '2026-12-01T09:15:00+07:00');
  await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
  const expiredLock = await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: '000000' } });
  await expectApiError(expiredLock, 401, 'OTP_INVALID');
  expect((await expiredLock.json()).attemptsLeft).toBe(2);
  await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
  expect((await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: OTP } })).status()).toBe(200);

  h = await fresh(browser, h);
  for (let i = 0; i < 2; i++) {
    await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
    await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: '000000' } });
  }
  await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
  expect((await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: OTP } })).status()).toBe(200);
  await h.api.post('/api/auth/logout');
  for (let i = 0; i < 2; i++) {
    await h.api.post('/api/auth/thaid/start', { data: { idNo: ids.piti } });
    const r = await h.api.post('/api/auth/thaid/verify', { data: { idNo: ids.piti, otp: '000000' } });
    await expectApiError(r, 401, 'OTP_INVALID');
    if (i === 1) expect((await r.json()).attemptsLeft).toBe(1);
  }
  await h.context.close();
});

test('TC-AUTH-03 · first citizen registration validates mobile and consent', async ({ browser }) => {
  const h = await fresh(browser);
  await h.page.goto('/login');
  await h.page.getByTestId('thaid-id-input').fill(ids.mana);
  await h.page.getByTestId('thaid-submit').click();
  await h.page.getByTestId('otp-input').fill(OTP); await h.page.getByTestId('otp-submit').click();
  await expect(h.page).toHaveURL(/\/register$/);
  const name = h.page.getByTestId('reg-name');
  await expect(name).toHaveValue('มานะ ตั้งใจ'); await expect(name).toHaveAttribute('readonly', '');
  for (const mobile of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await h.page.getByTestId('reg-mobile').fill(mobile); await h.page.getByTestId('reg-consent').check();
    await h.page.getByTestId('reg-submit').click();
    await expect(h.page.getByTestId('reg-error-mobile')).toHaveText('เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0');
    await expect(h.page).toHaveURL(/\/register$/);
    await h.page.getByTestId('reg-consent').uncheck();
  }
  await h.page.getByTestId('reg-mobile').fill('0845678901'); await h.page.getByTestId('reg-submit').click();
  await expect(h.page.getByTestId('reg-error-consent')).toHaveText('กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)');
  await h.page.getByTestId('reg-consent').check(); await h.page.getByTestId('reg-submit').click();
  await expect(h.page).toHaveURL(/\/citizen$/);
  await expect(h.page.getByTestId('citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
  await h.page.getByTestId('logout-btn').click(); await expect(h.page).toHaveURL(/\/login$/); // [B12] รอ logout เสร็จก่อน goto
  await uiCitizenLogin(h.page, ids.mana);
  await expect(h.page).toHaveURL(/\/citizen$/);
  await h.context.close();

  const api = await fresh(browser);
  await api.api.post('/api/auth/thaid/start', { data: { idNo: ids.mana } });
  const verify = await api.api.post('/api/auth/thaid/verify', { data: { idNo: ids.mana, otp: OTP } });
  expect((await verify.json()).registered).toBe(false);
  await expectApiError(await api.api.post('/api/auth/register', { data: { mobile: '081234567', consent: true } }), 400, 'INVALID_MOBILE');
  await expectApiError(await api.api.post('/api/auth/register', { data: { mobile: '0845678901', consent: false } }), 400, 'CONSENT_REQUIRED');
  await api.context.close();
});

test('TC-AUTH-04 · staff SSO lands on the page assigned to each role', async ({ browser }) => {
  const h = await fresh(browser);
  const accounts = [
    ['off.reg1', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 1', 'officer', 'registry'],
    ['off.reg2', '/officer/queue', 'เจ้าหน้าที่ทะเบียน 2', 'officer', 'registry'],
    ['off.works1', '/officer/queue', 'เจ้าหน้าที่โยธา 1', 'officer', 'works'],
    ['head1', '/head/approvals', 'หัวหน้าฝ่าย', 'head', ''], ['exec1', '/dashboard', 'ผู้บริหาร', 'executive', ''],
    ['audit1', '/audit', 'ผู้ตรวจสอบภายใน', 'auditor', ''], ['admin1', '/admin/services', 'ผู้ดูแลระบบ', 'admin', ''],
  ];
  const roleText: Record<string, string> = { officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย', executive: 'ผู้บริหาร', auditor: 'ผู้ตรวจสอบภายใน', admin: 'ผู้ดูแลระบบ' };
  await h.page.goto('/login'); await h.page.getByTestId('login-tab-staff').click();
  await expect(h.page.getByTestId('staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
  for (const [user, landing, name, role, dept] of accounts) {
    await uiStaffLogin(h.page, user);
    await expect(h.page).toHaveURL(new RegExp(`${landing.replaceAll('/', '\\/')}$`));
    await expect(h.page.getByTestId('user-name')).toHaveText(name);
    await expect(h.page.getByTestId('user-role')).toHaveAttribute('data-role', role);
    await expect(h.page.getByTestId('user-role')).toHaveText(roleText[role]);
    if (dept) await expect(h.page.getByTestId('user-role')).toHaveAttribute('data-dept', dept);
    await h.page.getByTestId('logout-btn').click(); await expect(h.page).toHaveURL(/\/login$/);
  }
  for (const [username, password] of [['off.reg1', 'wrong'], ['nobody', PASS], [ids.somchai, PASS]]) {
    await h.page.goto('/login'); await h.page.getByTestId('login-tab-staff').click();
    await h.page.getByTestId('staff-username').fill(username); await h.page.getByTestId('staff-password').fill(password);
    const responsePromise = h.page.waitForResponse(r => r.url().includes('/api/auth/staff/login'));
    await h.page.getByTestId('staff-submit').click();
    const response = await responsePromise;
    expect(response.status()).toBe(401); expect((await response.json()).code).toBe('INVALID_CREDENTIALS');
    await expect(h.page.getByTestId('staff-error')).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  await uiStaffLogin(h.page); await expect(h.page).toHaveURL(/\/officer\/queue$/); await h.page.getByTestId('logout-btn').click(); await expect(h.page).toHaveURL(/\/login$/); // [B12] รอ navigation
  await h.page.goto('/officer/queue');
  await expect(h.page).toHaveURL(/\/login$/);
  await h.context.close();
});

test('TC-FEE-01 · fee formulas and inclusive input boundaries', async ({ browser }) => {
  const h = await fresh(browser); await loginCitizen(h);
  await h.page.goto('/citizen/new/SV-03');
  const area = h.page.getByTestId('area-input');
  for (const [n, fee] of [[1, '฿1,000'], [100, '฿1,000'], [101, '฿1,010'], [102, '฿1,020'], [250, '฿2,500'], [300, '฿3,000'], [499, '฿4,990'], [500, '฿5,000']] as [number, string][]) {
    await area.fill(String(n)); await expect(h.page.getByTestId('fee-total')).toHaveText(fee);
    await expect(h.page.getByTestId('fee-error')).toHaveCount(0);
    const want = n <= 100 ? 1000 : 1000 + 10 * (n - 100); // BR-05: ฐาน 1,000 + 10 × (พื้นที่ − 100)
    expect((await (await h.api.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: n } })).json()).fee, `SV-03 ${n}`).toBe(want);
  }
  for (const [n, fee, error, code] of [[0, '–', 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', 'INVALID_AREA'], [-1, '–', 'กรุณาระบุพื้นที่ 1–500 ตร.ม.', 'INVALID_AREA'], [501, '–', 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน', 'AREA_TOO_LARGE']] as [number, string, string, string][]) {
    await area.fill(String(n)); await expect(h.page.getByTestId('fee-total')).toHaveText(fee);
    await expect(h.page.getByTestId('fee-error')).toHaveText(error); await expect(h.page.getByTestId('to-upload-btn')).toBeDisabled();
    await expectApiError(await h.api.post('/api/drafts', { data: { serviceId: 'SV-03', areaSqm: n } }), 400, code);
  }
  await h.page.goto('/citizen/new/SV-01');
  const qty = h.page.getByTestId('qty-input');
  await expect(qty).toHaveValue('1');
  for (const [n, fee] of [[1, '฿20'], [2, '฿40'], [3, '฿60'], [4, '฿80'], [5, '฿100']] as [number, string][]) {
    await qty.fill(String(n)); await expect(h.page.getByTestId('fee-total')).toHaveText(fee);
    expect((await (await h.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: n } })).json()).fee).toBe(n * 20);
  }
  for (const n of [0, 6]) {
    await qty.fill(String(n)); await expect(h.page.getByTestId('fee-error')).toHaveText('จำนวนฉบับต้อง 1–5 ฉบับ');
    await expect(h.page.getByTestId('to-upload-btn')).toBeDisabled();
    await expectApiError(await h.api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: n } }), 400, 'INVALID_QTY');
  }
  await h.page.goto('/citizen/new/SV-02'); await expect(h.page.getByTestId('fee-total')).toHaveText('฿500');
  await expect(h.page.getByTestId('qty-input')).toHaveCount(0); await expect(h.page.getByTestId('area-input')).toHaveCount(0);
  expect((await (await h.api.post('/api/drafts', { data: { serviceId: 'SV-02' } })).json()).fee).toBe(500);
  await h.context.close();
});

test('TC-SUBMIT-01 · submit an SV-01 request from data entry through receipt and queue', async ({ browser }) => {
  const h = await fresh(browser); await loginCitizen(h); await h.page.goto('/citizen');
  await h.page.getByTestId('start-service-SV-01').click();
  await expect(h.page.getByTestId('wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await h.page.getByTestId('qty-input').fill('2'); await expect(h.page.getByTestId('fee-total')).toHaveText('฿40');
  await h.page.getByTestId('to-upload-btn').click(); await expect(h.page.getByTestId('wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await expect(h.page.getByTestId('to-payment-btn')).toBeDisabled();
  await h.page.getByTestId('upload-input-id-card').setInputFiles(uploadFile('id-card.pdf'));
  await expect(h.page.getByTestId('file-item')).toHaveCount(1);
  await expect(h.page.getByTestId('file-item')).toHaveAttribute('data-doc-key', 'id-card');
  await h.page.getByTestId('to-payment-btn').click(); await expect(h.page.getByTestId('wizard-step')).toHaveText('3/3 ชำระเงิน');
  await expect(h.page.getByTestId('payment-amount')).toHaveText('฿40'); await h.page.getByTestId('create-qr-btn').click();
  await expect(h.page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(h.page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
  await expect(h.page.getByTestId('payment-status')).toHaveText('รอชำระ');
  const paid = await h.api.post('/api/test/payments/PP-0002/pay', { data: { amount: 40 } });
  expect(paid.status()).toBe(200);
  expect(await paid.json()).toEqual({ status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', duplicate: false });
  await h.page.getByTestId('refresh-payment-btn').click();
  await expect(h.page.getByTestId('payment-status')).toHaveText('ชำระแล้ว');
  await expect(h.page.getByTestId('submitted-case-no')).toHaveText('EG-2569-000031');
  await expect(h.page.getByTestId('receipt-no')).toHaveText('RC-2569-000031');
  await expect(h.page.getByTestId('receipt-amount')).toHaveText('฿40');
  await expect(h.page.getByTestId('receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await h.page.getByTestId('go-case-btn').click();
  await expect(h.page).toHaveURL(/\/citizen\/cases\/EG-2569-000031$/);
  await expect(h.page.getByTestId('case-status')).toHaveAttribute('data-status', 'SUBMITTED');
  await expect(h.page.getByTestId('case-status')).toHaveText('ส่งคำขอแล้ว');
  await expect(h.page.getByTestId('case-fee')).toHaveText('฿40');
  await expect(h.page.getByTestId('sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
  await expect(h.page.getByTestId('sla-due')).toContainText('4 ธ.ค. 2569 16:30');
  await expect(h.page.getByTestId('sla-level')).toHaveText('ปกติ');
  await expect(h.page.getByTestId('cancel-case-btn')).toHaveCount(1); await expect(h.page.getByTestId('case-step')).toHaveCount(0);
  await h.context.close();
  const staffContext = await browser.newContext({ baseURL: BASE });
  const staff: Harness = { browser, context: staffContext, page: await staffContext.newPage(), api: staffContext.request };
  await loginStaff(staff);
  const queue = await staff.api.get('/api/officer/queue?filter=all');
  const items = (await queue.json()).items;
  const row = items.find((x: { caseNo: string }) => x.caseNo === 'EG-2569-000031');
  expect(row).toBeTruthy(); expect(row.owner).toBeFalsy();
  const order = items.map((x: { caseNo: string }) => x.caseNo.slice(-6)); // การ์ด: ท้ายกลุ่มกำหนด 4 ธ.ค. หลัง …000030
  expect(order.indexOf('000031')).toBe(order.indexOf('000030') + 1);
  expect(order[order.indexOf('000031') + 1]).toBe('000016');
  await staff.page.goto('/officer/queue');
  await expect(staff.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000031"]')).toHaveAttribute('data-owner', '');
  await expect(staff.page.getByTestId('queue-row').filter({ has: staff.page.getByText('EG-2569-000031') }).getByTestId('claim-btn')).toHaveCount(1);
  await staff.context.close();
});

test('TC-SUBMIT-02 · required documents gate payment for SV-02 and SV-03', async ({ browser }) => {
  const h = await fresh(browser); await loginCitizen(h);
  await h.page.goto('/citizen/new/SV-02'); await h.page.getByTestId('to-upload-btn').click();
  await h.page.getByTestId('upload-input-id-card').setInputFiles(uploadFile('id-card.pdf'));
  await expect(h.page.getByTestId('to-payment-btn')).toBeDisabled(); await expect(h.page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  await h.page.getByTestId('upload-input-map').setInputFiles(uploadFile('map.pdf'));
  await expect(h.page.getByTestId('to-payment-btn')).toBeEnabled(); await expect(h.page.getByTestId('missing-docs')).toHaveCount(0);
  await h.page.getByTestId('file-item').filter({ hasText: 'map.pdf' }).getByTestId('file-remove-btn').click();
  await expect(h.page.getByTestId('to-payment-btn')).toBeDisabled();
  await expect(h.page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  await h.page.goto('/citizen/new/SV-03'); await h.page.getByTestId('area-input').fill('100'); await h.page.getByTestId('to-upload-btn').click();
  await h.page.getByTestId('upload-input-id-card').setInputFiles(uploadFile('id-card.pdf'));
  await expect(h.page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');
  await expect(h.page.getByTestId('to-payment-btn')).toBeDisabled();
  await h.page.getByTestId('upload-input-deed').setInputFiles(uploadFile('deed.pdf'));
  await expect(h.page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');
  await h.page.getByTestId('upload-input-plan').setInputFiles(uploadFile('plan-as-jpg.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'));
  await expect(h.page.getByTestId('upload-error')).toHaveText('แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น');
  await expect(h.page.getByTestId('file-item')).toHaveCount(2); // id-card + deed · ไฟล์ที่ถูกปฏิเสธไม่เพิ่ม
  await expect(h.page.getByTestId('to-payment-btn')).toBeDisabled();
  await expect(h.page.getByTestId('missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');
  await h.page.getByTestId('upload-input-plan').setInputFiles(uploadFile('plan.pdf'));
  await expect(h.page.getByTestId('to-payment-btn')).toBeEnabled(); await expect(h.page.getByTestId('missing-docs')).toHaveCount(0);
  const draft = await createDraft(h, 'SV-03', { areaSqm: 100 });
  await attach(h, draft.draftId, 'id-card', uploadFile('id-card.pdf'));
  await attach(h, draft.draftId, 'deed', uploadFile('deed.pdf'));
  const missing = await h.api.post(`/api/drafts/${draft.draftId}/payment`);
  await expectApiError(missing, 409, 'MISSING_DOCS'); expect((await missing.json()).missing).toEqual(['แบบแปลน']);
  expect((await attach(h, draft.draftId, 'plan', uploadFile('plan.pdf'))).status()).toBe(201);
  expect((await h.api.post(`/api/drafts/${draft.draftId}/payment`)).status()).toBe(201); // หลังแนบครบ → 201
  await h.context.close();
});

test('TC-SUBMIT-03 · saved drafts, cancellation, deletion, and cancel/claim race', async ({ browser }) => {
  let h = await fresh(browser); await loginCitizen(h);
  await h.page.goto('/citizen');
  await expect(h.page.getByTestId('my-case-row')).toHaveCount(10);
  await expect(h.page.getByTestId('my-draft-row')).toHaveCount(2);
  const draftRows = h.page.getByTestId('my-draft-row');
  const draft1 = h.page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0001"]');
  const draft2 = h.page.locator('[data-testid="my-draft-row"][data-draft-id="DR-0002"]');
  await expect(draft1).toHaveAttribute('data-status', 'DRAFT');
  await expect(draft2).toHaveAttribute('data-status', 'PENDING_PAYMENT');
  for (const t of await draftRows.allInnerTexts()) expect(t).not.toContain('EG-'); // ร่างยังไม่มีเลขคำขอ
  await draft1.getByTestId('open-draft-btn').click();
  await expect(h.page.getByTestId('qty-input')).toHaveValue('2'); await expect(h.page.getByTestId('fee-total')).toHaveText('฿40');
  await h.page.goto('/citizen/new/SV-01'); await h.page.getByTestId('qty-input').fill('3'); await h.page.getByTestId('save-draft-btn').click();
  await expect(h.page.getByTestId('draft-id')).toHaveText('DR-0003');
  await h.page.goto('/citizen'); await expect(h.page.getByTestId('my-case-row')).toHaveCount(10); await expect(h.page.getByTestId('my-draft-row')).toHaveCount(3);
  expect((await (await h.api.get('/api/cases')).json()).items).toHaveLength(10);
  expect((await (await h.api.get('/api/drafts')).json()).items).toHaveLength(3);
  await h.context.close();

  h = await fresh(browser); await loginCitizen(h); await h.page.goto('/citizen/cases/EG-2569-000030');
  await h.page.getByTestId('cancel-case-btn').click();
  await expect(h.page.getByTestId('cancel-confirm-text')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await h.page.getByTestId('confirm-cancel-btn').click();
  await expect(h.page.getByTestId('case-status')).toHaveAttribute('data-status', 'CANCELLED');
  await expect(h.page.getByTestId('case-status')).toHaveText('ยกเลิก');
  await expect(h.page.getByTestId('no-refund-note')).toHaveText('ค่าธรรมเนียมที่ชำระแล้วไม่คืน');
  await expect(h.page.getByTestId('cancel-case-btn')).toHaveCount(0);
  { // การ์ดส่วน B: คิว off.reg1 เหลือ 16 ไม่มี …000030 · Dashboard backlog 20 · รับเรื่อง ธ.ค. ยัง 3
    const sc = await browser.newContext({ baseURL: BASE });
    expect((await sc.request.post('/api/auth/staff/login', { data: { username: 'off.reg1', password: PASS } })).status()).toBe(200);
    const q = (await (await sc.request.get('/api/officer/queue?filter=all')).json()).items.map((x: { caseNo: string }) => x.caseNo);
    expect(q).toHaveLength(16); expect(q).not.toContain('EG-2569-000030');
    expect((await sc.request.post('/api/auth/staff/login', { data: { username: 'exec1', password: PASS } })).status()).toBe(200);
    expect(await (await sc.request.get('/api/dashboard?period=2026-12&service=ALL')).json()).toMatchObject({ backlog: 20, received: 3 });
    await sc.close();
  }
  await h.context.close();

  h = await fresh(browser); await loginStaff(h); await h.api.post('/api/officer/cases/EG-2569-000030/claim');
  await loginCitizen(h); await h.page.goto('/citizen/cases/EG-2569-000030');
  await expect(h.page.getByTestId('case-status')).toHaveAttribute('data-status', 'IN_REVIEW');
  await expect(h.page.getByTestId('cancel-case-btn')).toHaveCount(0);
  await expect(h.page.getByTestId('case-status')).toHaveText('กำลังตรวจสอบ');
  const denied = await h.api.post('/api/cases/EG-2569-000030/cancel'); await expectApiError(denied, 409, 'CANNOT_CANCEL');
  expect((await denied.json()).message).toBe('ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว');
  await expectApiError(await h.api.post('/api/cases/EG-2569-000013/cancel'), 409, 'CANNOT_CANCEL');
  await h.context.close();

  h = await fresh(browser); await loginCitizen(h);
  expect((await h.api.delete('/api/drafts/DR-0001')).status()).toBe(204);
  expect((await h.api.get('/api/drafts/DR-0001')).status()).toBe(404);
  expect((await (await h.api.get('/api/drafts')).json()).items).toHaveLength(1);
  await h.page.goto('/citizen'); await expect(h.page.getByTestId('my-draft-row')).toHaveCount(1);
  await expect(h.page.getByTestId('my-draft-row')).toHaveAttribute('data-draft-id', 'DR-0002');
  expect((await h.api.delete('/api/drafts/DR-0002')).status()).toBe(204);
  expect((await h.api.get('/api/payments/PP-0001')).status()).toBe(404);
  expect((await h.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } })).status()).toBe(404);
  await h.context.close();

  h = await fresh(browser); await loginCitizen(h);
  const staffContext = await browser.newContext({ baseURL: BASE });
  const staffApi = staffContext.request;
  expect((await staffApi.post('/api/auth/staff/login', { data: { username: 'off.reg1', password: PASS } })).status()).toBe(200);
  const [cancel, claim] = await Promise.all([
    h.api.post('/api/cases/EG-2569-000030/cancel'), staffApi.post('/api/officer/cases/EG-2569-000030/claim'),
  ]);
  expect([cancel.status(), claim.status()].filter(x => x === 200)).toHaveLength(1);
  expect([cancel.status(), claim.status()].filter(x => x === 409)).toHaveLength(1);
  const final = await h.api.get('/api/cases/EG-2569-000030');
  const finalData = await final.json();
  const mine = (await (await staffApi.get('/api/officer/queue?filter=mine')).json()).items.length; // งานในมือ off.reg1 (seed = 3)
  if (cancel.status() === 200) { expect(finalData.status).toBe('CANCELLED'); expect(finalData.owner).toBeFalsy(); await expectApiError(claim, 409, 'INVALID_STATE'); expect(mine).toBe(3); }
  else { expect(finalData.status).toBe('IN_REVIEW'); expect(finalData.owner).toBe('off.reg1'); await expectApiError(cancel, 409, 'CANNOT_CANCEL'); expect(mine).toBe(4); }
  await staffContext.close(); await h.context.close();
});

test('TC-UPLOAD-01 · byte size and five-file limit', async ({ browser }) => {
  const h = await fresh(browser); await loginCitizen(h); const d = await createDraft(h, 'SV-01', { qty: 1 });
  for (const n of [5242879, 5242880]) {
    const r = await attach(h, d.draftId, 'id-card', uploadFile(`size-${n}.pdf`, pdf(n)));
    expect(r.status()).toBe(201); expect((await r.json()).size).toBe(n);
    await h.api.delete(`/api/drafts/${d.draftId}`);
    const nd = await createDraft(h, 'SV-01', { qty: 1 }); d.draftId = nd.draftId;
  }
  const oversized = await attach(h, d.draftId, 'id-card', uploadFile('size-5242881.pdf', pdf(5242881)));
  await expectApiError(oversized, 400, 'FILE_TOO_LARGE');
  expect((await (await h.api.get(`/api/drafts/${d.draftId}`)).json()).files).toHaveLength(0);
  await h.page.goto('/citizen/new/SV-01'); await h.page.getByTestId('to-upload-btn').click();
  await h.page.getByTestId('upload-input-id-card').setInputFiles(uploadFile('size-5242881.pdf', pdf(5242881)));
  await expect(h.page.getByTestId('upload-error')).toHaveText('ไฟล์ใหญ่เกิน 5 MB');
  await expect(h.page.getByTestId('file-item')).toHaveCount(0);
  // การ์ด: ขอบ ≤ 5 MB บนจอ · รับ → file-item 1 และไม่มี upload-error
  await h.page.goto('/citizen/new/SV-01'); await h.page.getByTestId('to-upload-btn').click();
  await h.page.getByTestId('upload-input-id-card').setInputFiles(uploadFile('size-5242880.pdf', pdf(5242880)));
  await expect(h.page.getByTestId('file-item')).toHaveCount(1);
  await expect(h.page.getByTestId('file-item')).toHaveAttribute('data-name', 'size-5242880.pdf');
  await expect(h.page.getByTestId('upload-error')).not.toBeVisible();

  const many = await createDraft(h, 'SV-01', { qty: 1 });
  for (const [key, name] of [['id-card', 'id-card.pdf'], ['extra', 'multi-1.pdf'], ['extra', 'multi-2.pdf'], ['extra', 'multi-3.pdf'], ['extra', 'multi-4.pdf']]) {
    expect((await attach(h, many.draftId, key, uploadFile(name))).status()).toBe(201);
  }
  const sixth = await attach(h, many.draftId, 'extra', uploadFile('multi-5.pdf'));
  await expectApiError(sixth, 400, 'FILE_COUNT');
  expect((await (await h.api.get(`/api/drafts/${many.draftId}`)).json()).files).toHaveLength(5);
  await h.page.goto(`/citizen/new/SV-01?draft=${many.draftId}`);
  await h.page.getByTestId('to-upload-btn').click();
  await expect(h.page.getByTestId('file-item')).toHaveCount(5);
  await h.page.getByTestId('upload-input-extra').setInputFiles(uploadFile('multi-5.pdf')); // ไฟล์ที่ 6 บนจอ
  await expect(h.page.getByTestId('upload-error')).toHaveText('แนบได้สูงสุด 5 ไฟล์ต่อคำขอ');
  await expect(h.page.getByTestId('file-item')).toHaveCount(5);
  await h.page.getByTestId('file-item').filter({ hasText: 'multi-4.pdf' }).getByTestId('file-remove-btn').click();
  await expect(h.page.getByTestId('file-item')).toHaveCount(4);
  await h.page.getByTestId('upload-input-extra').setInputFiles(uploadFile('multi-5.pdf'));
  await expect(h.page.getByTestId('file-item')).toHaveCount(5);
  await expect(h.page.getByTestId('file-item').filter({ hasText: 'multi-5.pdf' })).toHaveCount(1);
  await h.context.close();
});

test('TC-UPLOAD-02 · classify uploads from file contents, not extension or MIME header', async ({ browser }) => {
  const h = await fresh(browser); await loginCitizen(h); let d = await createDraft(h, 'SV-01', { qty: 1 });
  const good = [uploadFile('ok-id.pdf'), uploadFile('real.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'),
    uploadFile('real.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png')];
  for (const file of good) {
    expect((await attach(h, d.draftId, 'id-card', file)).status()).toBe(201);
    d = await createDraft(h, 'SV-01', { qty: 1 });
  }
  const bad = [
    uploadFile('fake-text.pdf', Buffer.from('hello')), uploadFile('fake-text.jpg', Buffer.from('hello'), 'image/jpeg'),
    uploadFile('exe-as.png', Buffer.from('MZ' + '\0'.repeat(1022)), 'image/png'), uploadFile('notes.txt', Buffer.from('hello'), 'text/plain'),
    uploadFile('fake-text.pdf', Buffer.from('hello'), 'application/pdf'),
  ];
  for (const file of bad) {
    const before = (await (await h.api.get(`/api/drafts/${d.draftId}`)).json()).files.length;
    await expectApiError(await attach(h, d.draftId, 'id-card', file), 400, 'FILE_TYPE');
    expect((await (await h.api.get(`/api/drafts/${d.draftId}`)).json()).files).toHaveLength(before);
  }
  await h.page.goto('/citizen/new/SV-01'); await h.page.getByTestId('to-upload-btn').click();
  await h.page.getByTestId('upload-input-id-card').setInputFiles(uploadFile('fake-text.pdf', Buffer.from('hello')));
  await expect(h.page.getByTestId('upload-error')).toHaveText('รองรับเฉพาะไฟล์ PDF, JPG, PNG');
  await expect(h.page.getByTestId('file-item')).toHaveCount(0);
  await h.context.close();
});

test('TC-PAY-01 · QR expires at exactly fifteen minutes and can be renewed', async ({ browser }) => {
  let h = await fresh(browser); await loginCitizen(h);
  expect((await (await h.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } })).json()).caseNo).toBe('EG-2569-000031');
  h = await fresh(browser, h); await setClock(h, '2026-12-01T09:09:59+07:00'); await loginCitizen(h);
  expect((await (await h.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } })).json()).caseNo).toBe('EG-2569-000031');
  h = await fresh(browser, h); await setClock(h, '2026-12-01T09:10:00+07:00'); await loginCitizen(h);
  await expectApiError(await h.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } }), 410, 'QR_EXPIRED');
  expect((await (await h.api.get('/api/payments/PP-0001')).json()).status).toBe('EXPIRED');
  expect((await (await h.api.get('/api/cases')).json()).items).toHaveLength(10);
  await h.page.goto('/citizen/new/SV-02?draft=DR-0002');
  await expect(h.page.getByTestId('qr-expired-msg')).toHaveText('QR หมดอายุ กรุณาสร้าง QR ใหม่');
  await expect(h.page.getByTestId('payment-status')).toHaveAttribute('data-status', 'EXPIRED');
  await expect(h.page.getByTestId('payment-status')).toHaveText('QR หมดอายุ');
  await h.page.getByTestId('regenerate-qr-btn').click();
  await expect(h.page.getByTestId('qr-ref')).toHaveText('PP-0002');
  await expect(h.page.getByTestId('qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');
  const renewed = await h.api.post('/api/test/payments/PP-0002/pay', { data: { amount: 500 } });
  expect(renewed.status()).toBe(200); expect(await renewed.json()).toMatchObject({ status: 'PAID', caseNo: 'EG-2569-000031' });
  h = await fresh(browser, h); await setClock(h, '2026-12-01T09:10:01+07:00'); await loginCitizen(h);
  await expectApiError(await h.api.post('/api/test/payments/PP-0001/pay', { data: { amount: 500 } }), 410, 'QR_EXPIRED');
  await h.context.close();
});

test('TC-PAY-02 · exact amount, callback idempotency, and contiguous numbers', async ({ browser }) => {
  const h = await fresh(browser); await loginCitizen(h);
  const d = await createDraft(h, 'SV-01', { qty: 1 });
  await attach(h, d.draftId, 'id-card', uploadFile('id-card.pdf'));
  await h.api.post(`/api/drafts/${d.draftId}/payment`);
  for (const amount of [19, 21]) {
    await expectApiError(await h.api.post('/api/test/payments/PP-0002/pay', { data: { amount } }), 422, 'AMOUNT_MISMATCH');
    expect((await (await h.api.get('/api/payments/PP-0002')).json()).status).toBe('PENDING');
    expect((await (await h.api.get('/api/cases')).json()).items).toHaveLength(10);
  }
  const first = await h.api.post('/api/test/payments/PP-0002/pay', { data: { amount: 20 } });
  expect(first.status()).toBe(200); expect(await first.json()).toMatchObject({ status: 'PAID', caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031' });
  const duplicate = await h.api.post('/api/test/payments/PP-0002/pay', { data: { amount: 20 } });
  expect(duplicate.status()).toBe(200); expect(await duplicate.json()).toMatchObject({ duplicate: true, caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031' });
  expect((await (await h.api.get('/api/cases')).json()).items).toHaveLength(11);
  const next = await newPaid(h);
  expect(await next.pay.json()).toMatchObject({ status: 'PAID', caseNo: 'EG-2569-000032', receiptNo: 'RC-2569-000032', duplicate: false });
  await h.context.close();
});

test('TC-PAY-03 · simultaneous payments allocate unique case and receipt numbers', async ({ browser }) => {
  const h = await fresh(browser);
  const contexts = [h.context, await browser.newContext({ baseURL: BASE }), await browser.newContext({ baseURL: BASE }),
    await browser.newContext({ baseURL: BASE }), await browser.newContext({ baseURL: BASE }), await browser.newContext({ baseURL: BASE })];
  const refs: string[] = [];
  for (let i = 0; i < contexts.length; i++) {
    const api = contexts[i].request; const who = i < 3 ? ids.somchai : ids.somying;
    await api.post('/api/auth/thaid/start', { data: { idNo: who } }); await api.post('/api/auth/thaid/verify', { data: { idNo: who, otp: OTP } });
    const d = await (await api.post('/api/drafts', { data: { serviceId: 'SV-01', qty: 1 } })).json();
    expect((await api.post(`/api/drafts/${d.draftId}/files`, { multipart: { docKey: 'id-card', file: uploadFile('id-card.pdf') } })).status()).toBe(201);
    refs.push((await (await api.post(`/api/drafts/${d.draftId}/payment`)).json()).ref);
  }
  expect(refs).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);
  const results = await Promise.all(contexts.map((c, i) => c.request.post(`/api/test/payments/${refs[i]}/pay`, { data: { amount: 20 } })));
  for (const r of results) expect(r.status()).toBe(200);
  const bodies = await Promise.all(results.map(r => r.json()));
  expect(new Set(bodies.map(x => x.caseNo))).toEqual(new Set(Array.from({ length: 6 }, (_, i) => `EG-2569-${String(31 + i).padStart(6, '0')}`)));
  expect(new Set(bodies.map(x => x.receiptNo))).toEqual(new Set(Array.from({ length: 6 }, (_, i) => `RC-2569-${String(31 + i).padStart(6, '0')}`)));
  for (const i of [0, 3]) {
    const r = await contexts[i].request.get('/api/cases');
    expect((await r.json()).items.filter((x: { caseNo: string }) => x.caseNo >= 'EG-2569-000031')).toHaveLength(3);
  }
  const next = await newPaid(h); expect((await next.pay.json()).caseNo).toBe('EG-2569-000037');
  for (const c of contexts) await c.close();
});

test('TC-PAY-04 · case and receipt numbering rolls over at the Buddhist year boundary', async ({ browser }) => {
  const h = await fresh(browser); await loginCitizen(h);
  await setClock(h, '2026-12-31T23:58:00+07:00');
  const firstDraft = await createDraft(h, 'SV-01', { qty: 1 }); await attach(h, firstDraft.draftId, 'id-card', uploadFile('id-card.pdf'));
  await h.api.post(`/api/drafts/${firstDraft.draftId}/payment`);
  await setClock(h, '2026-12-31T23:59:00+07:00');
  const first = await h.api.post('/api/test/payments/PP-0002/pay', { data: { amount: 20 } });
  expect(await first.json()).toMatchObject({ caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031' });
  const paidCase = await h.api.get('/api/cases/EG-2569-000031');
  expect((await paidCase.json()).paidAt).toBe('2026-12-31T23:59:00+07:00');
  await setClock(h, '2027-01-01T00:00:00+07:00');
  const second = await newPaid(h); expect(await second.pay.json()).toMatchObject({ caseNo: 'EG-2570-000001', receiptNo: 'RC-2570-000001' });
  const third = await newPaid(h); expect(await third.pay.json()).toMatchObject({ caseNo: 'EG-2570-000002', receiptNo: 'RC-2570-000002' });
  expect((await (await h.api.get('/api/cases/EG-2569-000031')).json()).caseNo).toBe('EG-2569-000031');
  await h.context.close();
});

test('TC-QUEUE-01 · queue order, filters, department boundaries, and head read-only view', async ({ browser }) => {
  const h = await fresh(browser); await loginStaff(h, 'off.reg1'); await h.page.goto('/officer/queue');
  const expected = ['000020','000022','000024','000023','000025','000026','000013','000015','000027','000028','000029','000030','000016','000018','000019','000012','000021'];
  const all = await h.api.get('/api/officer/queue?filter=all');
  expect((await all.json()).items.map((x: { caseNo: string }) => x.caseNo.slice(-6))).toEqual(expected);
  await expect(h.page.getByTestId('queue-row')).toHaveCount(17);
  await expect(h.page.getByTestId('queue-filter')).toHaveValue('all');
  expect(await h.page.getByTestId('queue-row').evaluateAll(es => es.map(e => (e.getAttribute('data-case-no') ?? '').slice(-6)))).toEqual(expected); // ลำดับบนจอ = BR-16
  for (const t of await h.page.getByTestId('row-id-masked').allInnerTexts()) expect(t.trim()).toMatch(/^X-XXXX-XXXXX-\d{2}-\d$/);
  for (const n of ['000017', '000011', '000014']) expect(expected).not.toContain(n); // NEED_FIX / PENDING_APPROVAL ไม่อยู่ในคิว
  await expect(h.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000019"]').getByTestId('claim-btn')).toHaveCount(0);
  await expect(h.page.getByTestId('row-sla-level').nth(0)).toHaveText('เกินกำหนด');
  await expect(h.page.getByTestId('row-sla-level').nth(1)).toHaveText('ใกล้ครบกำหนด');
  await expect(h.page.getByTestId('row-sla-level').nth(2)).toHaveText('ใกล้ครบกำหนด');
  const claimRows = h.page.getByTestId('queue-row').filter({ has: h.page.getByTestId('claim-btn') });
  expect(await claimRows.count()).toBe(4);
  for (const n of ['000024','000028','000029','000030']) await expect(claimRows.filter({ hasText: n })).toHaveCount(1);
  const shown = () => h.page.getByTestId('queue-row').evaluateAll(es => es.map(e => (e.getAttribute('data-case-no') ?? '').slice(-6)));
  await h.page.getByTestId('queue-filter').selectOption('unclaimed'); await expect(h.page.getByTestId('queue-row')).toHaveCount(4);
  expect(await shown()).toEqual(['000024', '000028', '000029', '000030']);
  await h.page.getByTestId('queue-filter').selectOption('mine'); await expect(h.page.getByTestId('queue-row')).toHaveCount(3);
  expect(await shown()).toEqual(['000020', '000022', '000023']);
  await expect(h.page.getByTestId('workload-count')).toHaveText('3'); await h.context.close();

  const reg2 = await fresh(browser); await loginStaff(reg2, 'off.reg2'); await reg2.page.goto('/officer/queue');
  await reg2.page.getByTestId('queue-filter').selectOption('mine'); await expect(reg2.page.getByTestId('queue-row')).toHaveCount(9);
  expect(await reg2.page.getByTestId('queue-row').evaluateAll(es => es.map(e => (e.getAttribute('data-case-no') ?? '').slice(-6))))
    .toEqual(['000025', '000026', '000013', '000015', '000027', '000016', '000018', '000012', '000021']);
  await expect(reg2.page.getByTestId('workload-count')).toHaveText('9'); await reg2.context.close();
  const works = await fresh(browser); await loginStaff(works, 'off.works1');
  expect((await (await works.api.get('/api/officer/queue?filter=all')).json()).items.map((x: { caseNo: string }) => x.caseNo.slice(-6))).toEqual(['000010']);
  await works.context.close();
  const head = await fresh(browser); await loginStaff(head, 'head1'); await head.page.goto('/officer/queue');
  await expect(head.page.getByTestId('queue-row')).toHaveCount(18); await expect(head.page.getByTestId('claim-btn')).toHaveCount(0);
  const headOrder = await head.page.getByTestId('queue-row').evaluateAll(es => es.map(e => (e.getAttribute('data-case-no') ?? '').slice(-6)));
  const at = headOrder.indexOf('000010'); expect(headOrder.slice(at, at + 4)).toEqual(['000010', '000023', '000025', '000026']); // กลุ่ม 3 ธ.ค.
  await head.context.close();
});

test('TC-QUEUE-02 · only one officer can claim a case, including concurrent requests', async ({ browser }) => {
  const h = await fresh(browser); const c2 = await browser.newContext({ baseURL: BASE });
  await loginStaff(h, 'off.reg1'); await loginStaff({ ...h, api: c2.request }, 'off.reg2');
  const r1 = await h.api.post('/api/officer/cases/EG-2569-000028/claim');
  const r2 = await c2.request.post('/api/officer/cases/EG-2569-000028/claim');
  expect([r1.status(), r2.status()].sort()).toEqual([200, 409]);
  const loser = r1.status() === 409 ? r1 : r2; await expectApiError(loser, 409, 'ALREADY_CLAIMED');
  const owner = r1.status() === 200 ? 'off.reg1' : 'off.reg2';
  expect((await (await h.api.get('/api/cases/EG-2569-000028')).json())).toMatchObject({ owner, status: 'IN_REVIEW' });
  await h.context.close(); await c2.close();

  const race = await fresh(browser); const ctxs = await Promise.all(Array.from({ length: 10 }, () => browser.newContext({ baseURL: BASE })));
  for (let i = 0; i < 10; i++) await loginStaff({ ...race, api: ctxs[i].request }, i % 2 ? 'off.reg2' : 'off.reg1');
  const results = await Promise.all(ctxs.map(c => c.request.post('/api/officer/cases/EG-2569-000029/claim')));
  expect(results.filter(r => r.status() === 200)).toHaveLength(1);
  expect(results.filter(r => r.status() === 409)).toHaveLength(9);
  const winner = await results.find(r => r.status() === 200)!.json();
  expect((await (await ctxs[0].request.get('/api/cases/EG-2569-000029')).json()).owner).toBe(winner.owner); // [B12] race.api ไม่ได้ล็อกอิน
  for (const r of results.filter(r => r.status() === 409)) expect((await r.json()).code).toBe('ALREADY_CLAIMED');
  expect(await auditCount(browser, 'event=CLAIM'), 'ส่วน 2: CLAIM ใน Audit').toBe(1);
  await race.context.close(); for (const c of ctxs) await c.close();

  const sequential = await fresh(browser); await loginStaff(sequential, 'off.reg1');
  expect((await sequential.api.post('/api/officer/cases/EG-2569-000029/claim')).status()).toBe(200);
  const second = await browser.newContext({ baseURL: BASE }); await loginStaff({ ...sequential, api: second.request }, 'off.reg2');
  const denied = await second.request.post('/api/officer/cases/EG-2569-000029/claim'); await expectApiError(denied, 409, 'ALREADY_CLAIMED');
  expect((await denied.json()).message).toBe('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
  expect((await (await sequential.api.get('/api/cases/EG-2569-000029')).json()).owner).toBe('off.reg1');
  expect((await (await second.request.get('/api/me')).json()).username).toBe('off.reg2');
  expect((await second.request.post('/api/officer/cases/EG-2569-000029/claim')).status()).toBe(409);
  expect((await (await second.request.get('/api/officer/queue?filter=mine')).json()).items, 'งานในมือ off.reg2 ยัง 9').toHaveLength(9);
  await expectApiError(await sequential.api.post('/api/officer/cases/EG-2569-000029/claim'), 409, 'ALREADY_CLAIMED'); // off.reg1 claim ซ้ำเอง
  expect(await auditCount(browser, 'event=CLAIM'), 'ส่วน 3: CLAIM ใน Audit').toBe(1);
  await sequential.context.close(); await second.close();

  // ส่วน 1 ตามการ์ด (UI): สอง context กด claim-btn ของแถว …000028 พร้อมกัน
  const ui = await fresh(browser); const ctxB = await browser.newContext({ baseURL: BASE }); const pageB = await ctxB.newPage();
  await loginStaff(ui, 'off.reg1'); expect((await ctxB.request.post('/api/auth/staff/login', { data: { username: 'off.reg2', password: PASS } })).status()).toBe(200);
  await ui.page.goto('/officer/queue'); await pageB.goto('/officer/queue');
  const rowSel = '[data-testid="queue-row"][data-case-no="EG-2569-000028"]';
  await expect(ui.page.locator(rowSel).getByTestId('claim-btn')).toHaveCount(1); await expect(pageB.locator(rowSel).getByTestId('claim-btn')).toHaveCount(1);
  await Promise.all([ui.page.locator(rowSel).getByTestId('claim-btn').click(), pageB.locator(rowSel).getByTestId('claim-btn').click()]);
  await expect.poll(async () => (await (await ui.api.get('/api/cases/EG-2569-000028')).json()).owner).toMatch(/^off\.reg[12]$/);
  const c28 = await (await ui.api.get('/api/cases/EG-2569-000028')).json(); expect(c28.status).toBe('IN_REVIEW');
  const [winnerPage, loserPage] = c28.owner === 'off.reg1' ? [ui.page, pageB] : [pageB, ui.page];
  await expect(loserPage.getByTestId('action-error')).toHaveText('มีเจ้าหน้าที่รับเรื่องนี้แล้ว');
  await expect(winnerPage.locator(rowSel)).toHaveAttribute('data-owner', c28.owner);
  await expect(winnerPage.locator(rowSel).getByTestId('row-owner')).toHaveText(c28.owner);
  await expect(winnerPage.getByTestId('action-error')).not.toBeVisible();
  expect(await auditCount(browser, 'event=CLAIM'), 'ส่วน 1: CLAIM ใน Audit').toBe(1);
  await ui.context.close(); await ctxB.close();
});

test('TC-QUEUE-03 · workload cap applies to claims, not a returned case resuming', async ({ browser }) => {
  let h = await fresh(browser); await loginStaff(h, 'off.reg2');
  expect((await (await h.api.get('/api/me')).json()).username).toBe('off.reg2');
  expect((await (await h.api.get('/api/officer/queue?filter=mine')).json()).items).toHaveLength(9);
  await h.page.goto('/officer/queue'); await expect(h.page.getByTestId('workload-count')).toHaveText('9');
  await h.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000028"]').getByTestId('claim-btn').click(); // ครั้งที่ 10 บนจอ
  await expect(h.page.getByTestId('workload-count')).toHaveText('10');
  await h.page.locator('[data-testid="queue-row"][data-case-no="EG-2569-000029"]').getByTestId('claim-btn').click(); // ครั้งที่ 11
  await expect(h.page.getByTestId('action-error')).toHaveText('รับงานได้สูงสุด 10 เรื่อง');
  await expect(h.page.getByTestId('workload-count')).toHaveText('10');
  const over = await h.api.post('/api/officer/cases/EG-2569-000029/claim');
  await expectApiError(over, 409, 'WORKLOAD_LIMIT'); expect((await over.json()).message).toBe('รับงานได้สูงสุด 10 เรื่อง');
  expect((await (await h.api.get('/api/cases/EG-2569-000029')).json())).toMatchObject({ status: 'SUBMITTED', owner: null });
  expect((await (await h.api.get('/api/officer/queue?filter=mine')).json()).items).toHaveLength(10);
  expect((await h.api.post('/api/cases/EG-2569-000025/approve')).status()).toBe(200);
  expect((await (await h.api.get('/api/officer/queue?filter=mine')).json()).items).toHaveLength(9); // APPROVED ไม่นับเป็นงานในมือ
  expect((await h.api.post('/api/officer/cases/EG-2569-000029/claim')).status()).toBe(200);
  await h.page.goto('/officer/queue'); await expect(h.page.getByTestId('workload-count')).toHaveText('10');
  const reg1 = await browser.newContext({ baseURL: BASE }); await loginStaff({ ...h, api: reg1.request }, 'off.reg1');
  expect((await reg1.request.post('/api/officer/cases/EG-2569-000030/claim')).status()).toBe(200);
  await h.context.close(); await reg1.close();

  h = await fresh(browser); await loginStaff(h, 'off.reg2');
  expect((await h.api.post('/api/officer/cases/EG-2569-000025/return', { data: { reason: 'xxxxxxxxxx' } })).status()).toBe(200);
  expect((await (await h.api.get('/api/cases/EG-2569-000025')).json()).status).toBe('NEED_FIX');
  expect((await (await h.api.get('/api/officer/queue?filter=mine')).json()).items).toHaveLength(8);
  await h.page.goto('/officer/queue'); await expect(h.page.getByTestId('workload-count')).toHaveText('8');
  expect((await h.api.post('/api/officer/cases/EG-2569-000028/claim')).status()).toBe(200);
  expect((await h.api.post('/api/officer/cases/EG-2569-000029/claim')).status()).toBe(200);
  await h.context.close();
  // [B12] แผนข้อ 9 ไม่มี RESET → ใช้ context ใหม่โดยไม่ reset
  const cctx = await browser.newContext({ baseURL: BASE }); const citizen: Harness = { browser, context: cctx, page: await cctx.newPage(), api: cctx.request }; await loginCitizen(citizen, ids.somying);
  expect((await citizen.api.post('/api/cases/EG-2569-000025/resubmit')).status()).toBe(200);
  const active = await browser.newContext({ baseURL: BASE }); await loginStaff({ ...citizen, api: active.request }, 'off.reg2');
  expect((await (await active.request.get('/api/cases/EG-2569-000025')).json())).toMatchObject({ status: 'IN_REVIEW', owner: 'off.reg2' });
  expect((await (await active.request.get('/api/officer/queue?filter=mine')).json()).items).toHaveLength(11);
  const last = await active.request.post('/api/officer/cases/EG-2569-000030/claim');
  await expectApiError(last, 409, 'WORKLOAD_LIMIT'); expect((await last.json()).message).toBe('รับงานได้สูงสุด 10 เรื่อง');
  expect((await (await active.request.get('/api/officer/queue?filter=mine')).json()).items).toHaveLength(11);
  const ap = await active.newPage(); await ap.goto('/officer/queue'); await expect(ap.getByTestId('workload-count')).toHaveText('11');
  await active.close(); await citizen.context.close();
});
