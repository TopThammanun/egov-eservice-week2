// [B12] ชุด C · TC-RBAC-01..03 (ไม่มีในชุด A/B) เขียนตาม TEST-PLAN §15 โดยตรง
import { test, expect, type Browser, type Page } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const PASS = 'Test@1234';
const OTP = '123456';
const SOMCHAI = '1101700123456';
const SOMYING = '3100600987659';
const url = (p: string) => new URL(p, BASE).toString();

async function reset(page: Page) {
  const r = await page.request.post(url('/api/test/reset'));
  expect(r.status()).toBe(200);
  expect((await r.json()).now).toBe('2026-12-01T09:00:00+07:00');
}
async function citizen(page: Page, idNo = SOMCHAI) {
  expect((await page.request.post(url('/api/auth/thaid/start'), { data: { idNo } })).status()).toBe(200);
  expect((await page.request.post(url('/api/auth/thaid/verify'), { data: { idNo, otp: OTP } })).status()).toBe(200);
}
async function staff(page: Page, username: string) {
  expect((await page.request.post(url('/api/auth/staff/login'), { data: { username, password: PASS } })).status()).toBe(200);
}
/** RESET แล้วเปิด context ใหม่ (cookie เก่าใช้ไม่ได้หลัง reset · TEST-PLAN §0) */
async function freshAs(browser: Browser, who: string | null) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await reset(page);
  if (who === 'citizen') await citizen(page);
  else if (who === 'somying') await citizen(page, SOMYING);
  else if (who) await staff(page, who);
  return { context, page };
}

test('TC-RBAC-01 ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ browser }) => {
  const { context, page } = await freshAs(browser, 'somying');
  try {
    const ui = await page.goto(url('/citizen/cases/EG-2569-000005'));
    expect(ui?.status()).toBe(404);
    await expect(page.getByTestId('not-found-msg')).toHaveText('ไม่พบคำขอ');
    await expect(page.getByTestId('case-no')).toHaveCount(0);
    await expect(page.getByTestId('case-status')).toHaveCount(0);
    expect(await page.content()).not.toContain('สมชาย');

    const other = await page.request.get(url('/api/cases/EG-2569-000005'));
    expect(other.status()).toBe(404);
    const otherText = await other.text();
    expect(JSON.parse(otherText)).toEqual({ code: 'NOT_FOUND', message: 'ไม่พบคำขอ' });
    const missing = await page.request.get(url('/api/cases/EG-2569-999999'));
    expect(missing.status()).toBe(404);
    expect(await missing.text()).toBe(otherText); // แยกไม่ออกว่าเลขมีอยู่

    expect((await page.request.get(url('/api/documents/DOC-2569-000001/pdf'))).status()).toBe(404);
    expect((await page.request.get(url('/api/drafts/DR-0001'))).status()).toBe(404);
    expect((await page.request.post(url('/api/cases/EG-2569-000030/cancel'))).status()).toBe(404);

    const own = await page.goto(url('/citizen/cases/EG-2569-000007'));
    expect(own?.status()).toBe(200);
    await expect(page.getByTestId('case-no')).toHaveText('EG-2569-000007');

    await citizen(page, SOMCHAI);
    expect((await page.request.get(url('/api/cases/EG-2569-000005'))).status()).toBe(200);
    // สมชายยังยกเลิก …000030 ได้ตามปกติ = หลักฐานว่าคำขอ 404 ด้านบนไม่ได้เปลี่ยนสถานะ
    expect((await (await page.request.get(url('/api/cases/EG-2569-000030'))).json()).status).toBe('SUBMITTED');
  } finally { await context.close(); }
});

test('TC-RBAC-02 เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (ตรวจที่ API)', async ({ browser }) => {
  const { context, page } = await freshAs(browser, 'off.reg2');
  try {
    const statusOf = async (no: string) => (await (await page.request.get(url(`/api/cases/${no}`))).json()).status;
    const r1 = await page.request.post(url('/api/cases/EG-2569-000014/approve'));
    expect(r1.status()).toBe(403); expect((await r1.json()).code).toBe('FORBIDDEN');
    expect(await statusOf('EG-2569-000014')).toBe('PENDING_APPROVAL');
    const r2 = await page.request.post(url('/api/cases/EG-2569-000013/approve'));
    expect(r2.status()).toBe(403);
    expect(await statusOf('EG-2569-000013')).toBe('IN_REVIEW');
    const r3 = await page.request.post(url('/api/cases/EG-2569-000014/reject'), { data: { reason: 'xxxxxxxxxx' } });
    expect(r3.status()).toBe(403);
    expect(await statusOf('EG-2569-000014')).toBe('PENDING_APPROVAL');
    for (const no of ['EG-2569-000013', 'EG-2569-000014']) {
      await page.goto(url(`/officer/cases/${no}`));
      await expect(page.getByTestId('case-status')).toBeVisible();
      await expect(page.getByTestId('approve-btn')).toHaveCount(0);
    }

    await staff(page, 'head1');
    expect((await page.request.post(url('/api/cases/EG-2569-000025/approve'))).status()).toBe(403);
    const ok = await page.request.post(url('/api/cases/EG-2569-000014/approve'));
    expect(ok.status()).toBe(200); expect((await ok.json()).status).toBe('APPROVED');

    await staff(page, 'audit1');
    await page.goto(url('/audit'));
    await page.getByTestId('audit-filter-event').selectOption('APPROVE');
    await page.getByTestId('audit-apply-btn').click();
    await expect(page.getByTestId('audit-count')).toHaveText('1');
    await expect(page.getByTestId('audit-row')).toHaveCount(1);
    await expect(page.getByTestId('audit-row')).toHaveAttribute('data-actor', 'head1');
    await expect(page.getByTestId('audit-row')).toHaveAttribute('data-case-no', 'EG-2569-000014');
  } finally { await context.close(); }
});

test('TC-RBAC-03 ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser }) => {
  test.setTimeout(180_000);
  type Role = 'anon' | 'citizen' | 'officer' | 'head' | 'executive' | 'auditor' | 'admin';
  const roles: Role[] = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'];
  const login: Record<Role, string | null> = { anon: null, citizen: 'citizen', officer: 'off.reg1', head: 'head1', executive: 'exec1', auditor: 'audit1', admin: 'admin1' };
  // ส่วน A: ✓ = 200 · 403 = forbidden-msg · → = redirect /login
  const pages: [string, Partial<Record<Role, 'ok'>>][] = [
    ['/citizen', { citizen: 'ok' }],
    ['/officer/queue', { officer: 'ok', head: 'ok' }],
    ['/head/approvals', { head: 'ok' }],
    ['/dashboard', { executive: 'ok' }],
    ['/audit', { auditor: 'ok' }],
    ['/admin/services', { admin: 'ok' }], ['/admin/holidays', { admin: 'ok' }], ['/admin/users', { admin: 'ok' }],
    ['/notifications', { officer: 'ok', head: 'ok' }],
  ];
  // ส่วน B: API (ค่าใน map = status ที่คาด · ไม่ระบุ = 403 · anon = 401)
  const apis: [string, 'get' | 'post', string, unknown, Partial<Record<Role, number>>][] = [
    ['queue', 'get', '/api/officer/queue', undefined, { officer: 200, head: 200 }],
    ['notifications', 'get', '/api/notifications', undefined, { officer: 200, head: 200 }],
    ['dashboard', 'get', '/api/dashboard?period=2026-12&service=ALL', undefined, { executive: 200 }],
    ['audit', 'get', '/api/audit', undefined, { auditor: 200 }],
    ['admin', 'get', '/api/admin/services', undefined, { admin: 200 }],
    ['drafts', 'post', '/api/drafts', { serviceId: 'SV-01', qty: 1 }, { citizen: 201 }],
    ['case025', 'get', '/api/cases/EG-2569-000025', undefined, { citizen: 200, officer: 200, head: 200 }],
    ['claim', 'post', '/api/officer/cases/EG-2569-000028/claim', undefined, { officer: 200 }], // ต้องเป็นแถวสุดท้าย
  ];
  const nav = ['nav-my-cases', 'nav-queue', 'nav-approvals', 'nav-dashboard', 'nav-audit', 'nav-admin-services', 'nav-admin-holidays', 'nav-admin-users', 'nav-bell'];
  const navOf: Record<Exclude<Role, 'anon'>, string[]> = {
    citizen: ['nav-my-cases'], officer: ['nav-queue', 'nav-bell'], head: ['nav-queue', 'nav-approvals', 'nav-bell'],
    executive: ['nav-dashboard'], auditor: ['nav-audit'], admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
  };

  for (const role of roles) {
    const { context, page } = await freshAs(browser, login[role]);
    try {
      for (const [path, allow] of pages) {
        const res = await page.goto(url(path));
        const where = `${role} ${path}`;
        if (role === 'anon') { await expect(page, where).toHaveURL(/\/login$/); continue; }
        if (allow[role]) {
          expect(res?.status(), where).toBe(200);
          await expect(page, where).toHaveURL(new RegExp(`${path.replaceAll('/', '\\/')}$`));
          await expect(page.getByTestId('forbidden-msg'), where).toHaveCount(0);
        } else {
          expect(res?.status(), where).toBe(403);
          await expect(page.getByTestId('forbidden-msg'), where).toHaveText('ไม่มีสิทธิ์เข้าถึงหน้านี้');
        }
      }
      const v = await page.goto(url('/verify/K7M2Q9XA'));
      expect(v?.status(), `${role} /verify`).toBe(200);
      await expect(page.getByTestId('verify-result')).toHaveAttribute('data-result', 'VALID');

      if (role !== 'anon') {
        await page.goto(url('/'));
        for (const id of nav) await expect(page.getByTestId(id), `${role} ${id}`).toHaveCount(navOf[role].includes(id) ? 1 : 0);
      }

      for (const [name, method, path, data, allow] of apis) {
        if (role === 'citizen' && name === 'case025') await citizen(page, SOMYING); // สมหญิงเป็นประชาชนตัวแทนของแถวนี้
        const r = method === 'get' ? await page.request.get(url(path)) : await page.request.post(url(path), data === undefined ? {} : { data });
        const want = role === 'anon' ? 401 : (allow[role] ?? 403);
        expect(r.status(), `${role} ${method.toUpperCase()} ${path}`).toBe(want);
        if (role === 'officer' && name === 'claim') expect((await r.json()).owner).toBe('off.reg1');
      }
    } finally { await context.close(); }
  }

  // ส่วน C: ขอบเขตแผนก
  const { context, page } = await freshAs(browser, 'off.works1');
  try {
    expect((await page.request.post(url('/api/officer/cases/EG-2569-000028/claim'))).status()).toBe(403);
    const q = await (await page.request.get(url('/api/officer/queue?filter=all'))).json();
    expect(q.items.map((x: { caseNo: string }) => x.caseNo)).toEqual(['EG-2569-000010']);
    await staff(page, 'off.reg1');
    expect((await page.request.post(url('/api/officer/cases/EG-2569-000010/claim'))).status()).toBe(403);
  } finally { await context.close(); }
});
