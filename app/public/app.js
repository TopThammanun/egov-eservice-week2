// [B01] ตัวช่วยฝั่งเบราว์เซอร์ร่วม (ทุกหน้าโหลดผ่าน html.page)
// api(method, url, body?) → { ok, status, data } · body เป็น FormData ได้ (อัปโหลด)
async function api(method, url, body) {
  const opt = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  let data = null;
  try { data = res.status === 204 ? null : await res.json(); } catch (_) { data = null; }
  return { ok: res.ok, status: res.status, data };
}
// แสดงข้อความในองค์ประกอบ data-testid (role="alert") · ข้อความว่าง = ซ่อน
function showMsg(testid, text) {
  const el = document.querySelector(`[data-testid="${testid}"]`);
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}
function showError(text, testid = 'action-error') { showMsg(testid, text); }
function toast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 4000);
}
async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
  location.href = '/login';
}
