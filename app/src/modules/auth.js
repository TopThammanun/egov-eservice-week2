'use strict';
// [B02] ยืนยันตัวตน + ลงทะเบียน + RBAC พื้นฐาน
// หน้า: GET /login (ThaiD จำลอง + SSO เจ้าหน้าที่จำลอง) · GET /register
// API (CONTRACT 6.1): POST /api/auth/thaid/start · /api/auth/thaid/verify · /api/auth/register
//                     POST /api/auth/staff/login · /api/auth/logout · GET /api/me
// กฎ: BR-01 checksum เลขบัตร · BR-02 OTP 123456 ผิดติดกัน 3 ครั้งล็อก 15 นาที (นาฬิกากลาง) · BR-03 ลงทะเบียน · BR-21 401/403 ผ่าน ctx.session.guard
// state: otp_state (ต่อ id_hash) + sessions · reset ล้างให้ (core) · โมดูลนี้ไม่มี state ในหน่วยความจำ
// ฟังก์ชันที่ provide ให้โมดูลอื่น: hooks.use('validThaiId')(idNo) → boolean

const OTP_CODE = '123456';
const MAX_FAILS = 3;
const LOCK_MS = 15 * 60 * 1000;
const MOCK_NAME = 'ผู้ใช้ ThaiD จำลอง'; // เลขบัตรถูกต้องแต่ไม่อยู่ใน seed → สร้างระเบียนใหม่ (ยังไม่ลงทะเบียน)

/** BR-01: ตัวเลข 13 หลักพอดี + หลักที่ 13 = (11 − Σ dᵢ×(13−i) mod 11) mod 10 */
function validThaiId(idNo) {
  if (typeof idNo !== 'string' || !/^\d{13}$/.test(idNo)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(idNo[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(idNo[12]);
}

/** BR-03: 10 หลักขึ้นต้น 0 */
const validMobile = (m) => typeof m === 'string' && /^0\d{9}$/.test(m);

module.exports = {
  order: 10,
  validThaiId,
  validMobile,
  register(app, ctx) {
    const { db, clock, crypto, audit, html, hooks, session, format } = ctx;
    const { HttpError, wrap } = ctx.errors;
    const { esc, LANDING } = format;

    hooks.provide('validThaiId', validThaiId);

    // ---------- OTP state (BR-02) ----------
    // fails = จำนวนผิดติดกันในรอบปัจจุบัน · locked_until = เวลาปลดล็อก (ครั้งที่ 3 + 15:00) · ถึงเวลาแล้ว = ปลดและนับใหม่จาก 0
    function otpState(idHash) {
      const row = db.get('SELECT fails, locked_until FROM otp_state WHERE id_hash = ?', idHash);
      if (!row) return { fails: 0, lockedUntil: null };
      if (row.locked_until) {
        if (clock.now() < clock.parse(row.locked_until)) return { fails: row.fails, lockedUntil: row.locked_until };
        db.run('UPDATE otp_state SET fails = 0, locked_until = NULL WHERE id_hash = ?', idHash); // ปลดล็อก → ตัวนับเริ่ม 0
        return { fails: 0, lockedUntil: null };
      }
      return { fails: row.fails, lockedUntil: null };
    }
    function saveOtp(idHash, fails, lockedUntil) {
      db.run(`INSERT INTO otp_state(id_hash, fails, locked_until) VALUES (?,?,?)
              ON CONFLICT(id_hash) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`,
      idHash, fails, lockedUntil || null);
    }
    const lockedError = (until) => new HttpError(423, 'LOCKED', null, { lockedUntil: until });

    function readIdNo(body) {
      const idNo = body && typeof body.idNo === 'string' ? body.idNo.trim() : body && body.idNo;
      if (!validThaiId(idNo)) throw new HttpError(400, 'INVALID_ID');
      return idNo;
    }

    /** หา/สร้างระเบียนประชาชนจาก ThaiD จำลอง */
    function citizenFor(idNo, idHash) {
      let c = db.get('SELECT id, name, registered FROM citizens WHERE id_hash = ?', idHash);
      if (!c) {
        const id = db.run('INSERT INTO citizens(id_hash, id_enc, id_last3, name, registered) VALUES (?,?,?,?,0)',
          idHash, crypto.encrypt(idNo), idNo.slice(-3), MOCK_NAME).lastInsertRowid;
        c = { id, name: MOCK_NAME, registered: 0 };
      }
      return c;
    }

    // ---------- API ----------
    app.post('/api/auth/thaid/start', wrap((req, res) => {
      const idNo = readIdNo(req.body);
      const st = otpState(crypto.lookupHash(idNo));
      if (st.lockedUntil) throw lockedError(st.lockedUntil);
      res.json({ status: 'OTP_SENT' });
    }));

    app.post('/api/auth/thaid/verify', wrap((req, res) => {
      const idNo = readIdNo(req.body);
      const otp = req.body && req.body.otp != null ? String(req.body.otp).trim() : '';
      const idHash = crypto.lookupHash(idNo);
      const result = db.tx(() => {
        const st = otpState(idHash);
        if (st.lockedUntil) return { err: lockedError(st.lockedUntil) }; // ล็อกอยู่ แม้ OTP ถูก
        if (otp !== OTP_CODE) {
          const fails = st.fails + 1;
          if (fails >= MAX_FAILS) {
            const until = clock.toISO(clock.now() + LOCK_MS);
            saveOtp(idHash, fails, until);
            return { err: lockedError(until) };
          }
          saveOtp(idHash, fails, null);
          return { err: new HttpError(401, 'OTP_INVALID', null, { attemptsLeft: MAX_FAILS - fails }) };
        }
        saveOtp(idHash, 0, null); // OTP ถูก → รีเซ็ตตัวนับ
        return { c: citizenFor(idNo, idHash) };
      });
      if (result.err) throw result.err;
      const { c } = result;
      if (req.user) session.destroy(req, res);
      const registered = !!c.registered;
      session.create(res, { kind: registered ? 'citizen' : 'register', role: 'citizen', citizenId: c.id });
      res.json({ registered, landing: registered ? LANDING.citizen : '/register' });
    }));

    app.post('/api/auth/register', wrap((req, res) => {
      const u = req.user;
      if (!u || u.role !== 'citizen') throw new HttpError(401, 'UNAUTHENTICATED');
      const c = db.get('SELECT id, registered FROM citizens WHERE id = ?', u.citizenId);
      if (!c) throw new HttpError(401, 'UNAUTHENTICATED');
      if (c.registered || u.kind !== 'register') throw new HttpError(409, 'ALREADY_REGISTERED', 'ลงทะเบียนแล้ว');
      const b = req.body || {};
      const mobile = typeof b.mobile === 'string' ? b.mobile.trim() : b.mobile;
      if (!validMobile(mobile)) throw new HttpError(400, 'INVALID_MOBILE');
      if (b.consent !== true && b.consent !== 'true' && b.consent !== 'on') throw new HttpError(400, 'CONSENT_REQUIRED');
      const email = typeof b.email === 'string' ? b.email.trim().slice(0, 254) : '';
      const now = clock.nowISO();
      db.run('UPDATE citizens SET mobile_enc = ?, email = ?, registered = 1, consent_at = ?, registered_at = ? WHERE id = ?',
        crypto.encrypt(mobile), email, now, now, c.id);
      session.upgrade(req, 'citizen');
      res.status(201).json({ registered: true, landing: LANDING.citizen });
    }));

    app.post('/api/auth/staff/login', wrap((req, res) => {
      const b = req.body || {};
      const username = typeof b.username === 'string' ? b.username.trim() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      const user = username ? db.get('SELECT username, password_hash, role, dept FROM users WHERE username = ?', username) : null;
      if (!user || !crypto.verifyPassword(password, user.password_hash)) throw new HttpError(401, 'INVALID_CREDENTIALS');
      if (req.user) session.destroy(req, res);
      session.create(res, { kind: 'staff', username: user.username, role: user.role, dept: user.dept || '' });
      audit.log({ username: user.username, role: user.role }, 'STAFF_LOGIN', {});
      res.json({ role: user.role, dept: user.dept || '', landing: LANDING[user.role] || '/' });
    }));

    app.post('/api/auth/logout', wrap((req, res) => {
      session.destroy(req, res);
      res.status(204).end();
    }));

    app.get('/api/me', session.guard.api(), wrap((req, res) => {
      const u = req.user;
      res.json({ username: u.username, name: u.name, role: u.role, dept: u.dept || '' });
    }));

    // ---------- หน้า /login ----------
    app.get('/login', (req, res) => {
      const staffTab = req.query.tab === 'staff';
      const tab = (key, label, on) => `<button type="button" role="tab" id="tab-${key}" data-testid="login-tab-${key}" aria-controls="panel-${key}" aria-selected="${on}" tabindex="${on ? 0 : -1}" class="tab${on ? ' active' : ''}">${label}</button>`;
      const body = `
<h1>เข้าสู่ระบบ</h1>
<div class="login-box">
  <div role="tablist" aria-label="ประเภทผู้ใช้" class="tabs">
    ${tab('citizen', 'ประชาชน', !staffTab)}
    ${tab('staff', 'เจ้าหน้าที่', staffTab)}
  </div>

  <section id="panel-citizen" role="tabpanel" aria-labelledby="tab-citizen"${staffTab ? ' hidden' : ''}>
    <form id="thaid-form" novalidate>
      <label for="thaid-id">เลขบัตรประชาชน 13 หลัก</label>
      <input id="thaid-id" name="idNo" data-testid="thaid-id-input" inputmode="numeric" autocomplete="off" aria-describedby="thaid-error">
      <p id="thaid-error" data-testid="thaid-error" role="alert" hidden></p>
      <button type="submit" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
    </form>
    <form id="otp-form" data-testid="otp-step" novalidate hidden>
      <p>ส่งรหัส OTP แล้ว (โหมดทดสอบใช้ <code>123456</code>)</p>
      <label for="otp">รหัส OTP</label>
      <input id="otp" name="otp" data-testid="otp-input" inputmode="numeric" autocomplete="one-time-code" aria-describedby="otp-error otp-left">
      <p id="otp-error" data-testid="otp-error" role="alert" hidden></p>
      <p id="otp-left" data-testid="otp-attempts-left" hidden></p>
      <button type="submit" data-testid="otp-submit">ยืนยัน OTP</button>
    </form>
    <div id="lock-box" role="alert" hidden>
      <p data-testid="lock-message">ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที</p>
      <p>ปลดล็อกเวลา <time data-testid="lock-until" data-iso=""></time></p>
    </div>
  </section>

  <section id="panel-staff" role="tabpanel" aria-labelledby="tab-staff"${staffTab ? '' : ' hidden'}>
    <form id="staff-form" novalidate>
      <label for="staff-username">ชื่อผู้ใช้</label>
      <input id="staff-username" name="username" data-testid="staff-username" autocomplete="username">
      <label for="staff-password">รหัสผ่าน</label>
      <input id="staff-password" name="password" type="password" data-testid="staff-password" autocomplete="current-password">
      <p id="staff-error" data-testid="staff-error" role="alert" hidden></p>
      <button type="submit" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
    </form>
  </section>
  <p data-testid="action-error" role="alert" hidden></p>
</div>`;
      const head = `<style>
.login-box{max-width:480px}
.tabs{display:flex;gap:.25rem;margin-bottom:1rem}
.tabs .tab{background:#fff;color:#0f3d6e}
.tabs .tab.active,.tabs .tab[aria-selected=true]{background:#0f3d6e;color:#fff}
.login-box input{width:100%}
.login-box form{margin-bottom:1rem}
.login-box button[type=submit]{margin-top:.75rem}
</style>`;
      const scripts = `<script>
(function(){
  var MONTHS=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function thaiDate(iso){var m=/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/.exec(iso||'');return m?(+m[3])+' '+MONTHS[+m[2]-1]+' '+(+m[1]+543)+' '+m[4]+':'+m[5]:(iso||'');}
  function $(t){return document.querySelector('[data-testid="'+t+'"]');}
  // แท็บ (คลิก + ลูกศรซ้าย/ขวา)
  var tabs=[$('login-tab-citizen'),$('login-tab-staff')];
  function select(i,focus){tabs.forEach(function(t,j){var on=i===j;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;t.classList.toggle('active',on);document.getElementById(t.getAttribute('aria-controls')).hidden=!on;});if(focus)tabs[i].focus();}
  tabs.forEach(function(t,i){t.addEventListener('click',function(){select(i);});t.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();select(1-i,true);}});});

  var idInput=$('thaid-id-input'), otpForm=$('otp-step'), lockBox=document.getElementById('lock-box'), currentId='';
  function showLock(until){showMsg('otp-error','');showMsg('otp-attempts-left','');var t=$('lock-until');t.setAttribute('data-iso',until||'');t.setAttribute('datetime',until||'');t.textContent=thaiDate(until);lockBox.hidden=false;}
  function hideLock(){lockBox.hidden=true;}
  document.getElementById('thaid-form').addEventListener('submit',async function(e){
    e.preventDefault();
    var idNo=idInput.value.trim();
    showMsg('thaid-error','');hideLock();
    var r=await api('POST','/api/auth/thaid/start',{idNo:idNo});
    if(r.ok){currentId=idNo;otpForm.hidden=false;showMsg('otp-error','');showMsg('otp-attempts-left','');$('otp-input').value='';$('otp-input').focus();return;}
    otpForm.hidden=true;
    if(r.status===423&&r.data){showLock(r.data.lockedUntil);return;}
    showMsg('thaid-error',(r.data&&r.data.message)||'เลขบัตรประชาชนไม่ถูกต้อง');
  });
  otpForm.addEventListener('submit',async function(e){
    e.preventDefault();
    var r=await api('POST','/api/auth/thaid/verify',{idNo:currentId||idInput.value.trim(),otp:$('otp-input').value.trim()});
    if(r.ok){location.href=r.data&&r.data.registered?'/citizen':'/register';return;}
    if(r.status===423&&r.data){showLock(r.data.lockedUntil);return;}
    hideLock();
    if(r.status===401&&r.data&&r.data.code==='OTP_INVALID'){showMsg('otp-error',r.data.message);showMsg('otp-attempts-left','เหลือ '+r.data.attemptsLeft+' ครั้ง');$('otp-input').select();return;}
    if(r.status===400&&r.data){showMsg('thaid-error',r.data.message);return;}
    showMsg('otp-error',(r.data&&r.data.message)||'เกิดข้อผิดพลาด');
  });
  document.getElementById('staff-form').addEventListener('submit',async function(e){
    e.preventDefault();
    showMsg('staff-error','');
    var r=await api('POST','/api/auth/staff/login',{username:$('staff-username').value.trim(),password:$('staff-password').value});
    if(r.ok){location.href=(r.data&&r.data.landing)||'/';return;}
    showMsg('staff-error',(r.data&&r.data.message)||'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  });
})();
</script>`;
      html.send(req, res, { title: 'เข้าสู่ระบบ', body, head, scripts });
    });

    // ---------- หน้า /register ----------
    app.get('/register', (req, res) => {
      const u = req.user;
      if (!u) return res.redirect('/login');
      if (u.kind !== 'register') return res.redirect(LANDING[u.role] || '/'); // ลงทะเบียนแล้ว/เจ้าหน้าที่ → หน้าตั้งต้น
      const body = `
<h1>ลงทะเบียนใช้งานครั้งแรก</h1>
<form id="reg-form" class="reg-box" novalidate>
  <label for="reg-name">ชื่อ-สกุล (จาก ThaiD)</label>
  <input id="reg-name" data-testid="reg-name" value="${esc(u.name)}" readonly aria-readonly="true">
  <label for="reg-mobile">เบอร์มือถือ (บังคับ)</label>
  <input id="reg-mobile" name="mobile" data-testid="reg-mobile" type="tel" inputmode="numeric" autocomplete="tel" required aria-required="true" aria-describedby="reg-mobile-hint reg-error-mobile">
  <small id="reg-mobile-hint">ตัวเลข 10 หลัก ขึ้นต้นด้วย 0</small>
  <p id="reg-error-mobile" data-testid="reg-error-mobile" role="alert" hidden></p>
  <label for="reg-email">อีเมล (ไม่บังคับ)</label>
  <input id="reg-email" name="email" data-testid="reg-email" type="email" autocomplete="email">
  <div class="consent">
    <input id="reg-consent" name="consent" data-testid="reg-consent" type="checkbox" aria-describedby="reg-error-consent">
    <label for="reg-consent">ข้าพเจ้ายินยอมให้เทศบาลนครตัวอย่างเก็บ ใช้ และประมวลผลข้อมูลส่วนบุคคลเพื่อให้บริการ e-Service ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล (PDPA)</label>
  </div>
  <p id="reg-error-consent" data-testid="reg-error-consent" role="alert" hidden></p>
  <p data-testid="action-error" role="alert" hidden></p>
  <button type="submit" data-testid="reg-submit">ลงทะเบียน</button>
</form>`;
      const head = `<style>.reg-box{max-width:520px}.reg-box input:not([type=checkbox]){width:100%}.reg-box .consent{display:flex;gap:.5rem;align-items:flex-start;margin-top:1rem}.reg-box .consent label{font-weight:400;margin:0}.reg-box .consent input{width:1.25rem;height:1.25rem;margin-top:.2rem}.reg-box button{margin-top:1rem}</style>`;
      const scripts = `<script>
(function(){
  var MSG_MOBILE='เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0', MSG_CONSENT='กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)';
  function $(t){return document.querySelector('[data-testid="'+t+'"]');}
  $('reg-name').addEventListener('keydown',function(e){if(e.key.length===1)e.preventDefault();});
  document.getElementById('reg-form').addEventListener('submit',async function(e){
    e.preventDefault();
    var mobile=$('reg-mobile').value.trim(), consent=$('reg-consent').checked, bad=false;
    showMsg('reg-error-mobile','');showMsg('reg-error-consent','');showError('');
    if(!/^0\\d{9}$/.test(mobile)){showMsg('reg-error-mobile',MSG_MOBILE);bad=true;}
    if(!consent){showMsg('reg-error-consent',MSG_CONSENT);bad=true;}
    if(bad)return;
    var r=await api('POST','/api/auth/register',{mobile:mobile,email:$('reg-email').value.trim(),consent:consent});
    if(r.ok){location.href=(r.data&&r.data.landing)||'/citizen';return;}
    var d=r.data||{};
    if(d.code==='INVALID_MOBILE')showMsg('reg-error-mobile',d.message);
    else if(d.code==='CONSENT_REQUIRED')showMsg('reg-error-consent',d.message);
    else if(r.status===401)location.href='/login';
    else if(r.status===409)location.href='/citizen';
    else showError(d.message||'เกิดข้อผิดพลาด');
  });
})();
</script>`;
      html.send(req, res, { title: 'ลงทะเบียน', body, head, scripts });
    });
  },
};
