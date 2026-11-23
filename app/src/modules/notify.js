'use strict';
// [B07] แจ้งเตือน SLA (กระดิ่ง) + ยกเลิกอัตโนมัติเมื่อเลยเวลาแก้ไข
// ที่มา: FR-11 FR-19 FR-20 · BR-14 BR-15 BR-20 · CONTRACT §0.7 §2.12 §6.3 · TEST-DATA §8 · DECISIONS 18 · A-21 A-30 A-31 A-46
//
// ทำงานทุก request (ยกเว้น /api/test/* · ผ่าน hooks.beforeRequest ของ core) ตามลำดับ:
//   1) autoCancelExpired(now): NEED_FIX ที่ now ≥ fix_deadline (rules.isFixExpired · 168:00 ยกเลิก, 167:59 ยังไม่)
//        → CANCELLED · cancelled_at = fix_deadline (เวลาครบ 168 ชม.) · cancel_reason 'fix-expired' · owner/dept = NULL
//        + case_events CANCEL (actor 'system') · ไม่ลง audit (CANCEL ไม่อยู่ใน 10 event ของ DECISIONS 13)
//   2) evaluate(now): คำขอที่มีเลขและสถานะ ACTIVE → rules.slaLevel (ระดับปัจจุบันเท่านั้น · ไม่ย้อนหลัง near เมื่อกระโดดไป overdue)
//        ระดับ near/overdue → rules.notifyRecipients (BR-15) → INSERT OR IGNORE (UNIQUE username,case_no,level)
//        = 1 ครั้งต่อระดับต่อคำขอต่อคน · ข้อความ rules.noticeText
//   memo: ข้ามการประเมินถ้า (เวลาปัจจุบัน, จำนวนการเขียน DB, BUG_MODE) เท่าเดิม (ผลจะเหมือนเดิมทุกประการ)
//
// หน้า: GET /notifications (officer · head · อื่น 403 · ไม่ล็อกอิน → /login) → noti-item (data-case-no data-level) / noti-empty
// API : GET /api/notifications (officer · head · ไม่ล็อกอิน 401 · อื่น 403) → {items:[{id,caseNo,level,text,createdAt}]} ของผู้ใช้นั้น
// provide: bellCount(user) · notificationsOf(username) · evaluateNotifications(nowISO?) · autoCancelExpired(nowISO?)

module.exports = {
  order: 70,
  register(app, ctx) {
    const { db, clock, bugs, hooks, html, format, payments, session: { guard } } = ctx;
    const { wrap } = ctx.errors;
    const { esc, timeEl } = format;
    const rules = ctx.rules;

    const ACTIVE = rules.ACTIVE_STATUSES || ['SUBMITTED', 'IN_REVIEW', 'PENDING_APPROVAL', 'APPROVED'];
    const ACTIVE_SQL = ACTIVE.map(() => '?').join(',');
    const CANCEL_TEXT = 'ระบบยกเลิกอัตโนมัติ: ไม่ส่งเอกสารแก้ไขภายใน 7 วัน (168 ชั่วโมง)';

    // ---------- 1) ยกเลิกอัตโนมัติ (BR-20 · A-46) ----------
    function autoCancelExpired(nowISO = clock.nowISO()) {
      const rows = db.all("SELECT id, case_no, fix_deadline FROM cases WHERE status = 'NEED_FIX' AND fix_deadline IS NOT NULL");
      let n = 0;
      for (const c of rows) {
        if (!rules.isFixExpired(c.fix_deadline, nowISO)) continue;
        const at = clock.normalize(c.fix_deadline) || nowISO; // เวลายกเลิก = ครบ 168 ชม. พอดี
        db.tx(() => {
          const r = db.run(`UPDATE cases SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = 'fix-expired', owner = NULL, dept = NULL
                            WHERE id = ? AND status = 'NEED_FIX'`, at, c.id);
          if (r.changes) {
            db.run('INSERT INTO case_events(case_id, time, event, actor, text) VALUES (?,?,?,?,?)', c.id, at, 'CANCEL', 'system', CANCEL_TEXT);
            n++;
          }
        });
      }
      return n;
    }

    // ---------- 2) ประเมินแจ้งเตือน (BR-14 BR-15 · A-30 A-31) ----------
    function evaluate(nowISO = clock.nowISO()) {
      const cases = db.all(
        `SELECT id, case_no, status, owner, dept, issuer, due_at FROM cases
          WHERE case_no IS NOT NULL AND due_at IS NOT NULL AND status IN (${ACTIVE_SQL}) ORDER BY case_no DESC`, ...ACTIVE);
      if (!cases.length) return 0;
      const holidays = payments.holidaySet();
      const staff = db.all("SELECT username, role, dept FROM users WHERE role IN ('officer','head')");
      let added = 0;
      db.tx(() => {
        for (const c of cases) {
          const level = rules.slaLevel(c, nowISO, holidays);
          if (level !== 'near' && level !== 'overdue') continue;
          const text = rules.noticeText(c.case_no, level);
          for (const username of rules.notifyRecipients(c, level, staff)) {
            added += db.run('INSERT OR IGNORE INTO notifications(username, case_no, level, text, created_at) VALUES (?,?,?,?,?)',
              username, c.case_no, level, text, nowISO).changes;
          }
        }
      });
      return added;
    }

    let memo = null;
    hooks.afterReset(() => { memo = null; });
    hooks.beforeRequest(() => {
      const nowISO = clock.nowISO();
      const key = `${nowISO}|${db.get('SELECT total_changes() AS n').n}|${bugs.list().join(',')}`;
      if (key === memo) return;
      autoCancelExpired(nowISO);
      evaluate(nowISO);
      memo = `${nowISO}|${db.get('SELECT total_changes() AS n').n}|${bugs.list().join(',')}`;
    });

    // ---------- อ่านรายการ ----------
    const notificationsOf = (username) => db.all(
      'SELECT id, case_no, level, text, created_at FROM notifications WHERE username = ? ORDER BY created_at DESC, id ASC', username);
    const bellCount = (user) => (user && user.username
      ? db.get('SELECT COUNT(*) AS n FROM notifications WHERE username = ?', user.username).n : 0);

    hooks.provide('bellCount', bellCount);
    hooks.provide('notificationsOf', notificationsOf);
    hooks.provide('evaluateNotifications', (nowISO) => evaluate(nowISO || clock.nowISO()));
    hooks.provide('autoCancelExpired', (nowISO) => autoCancelExpired(nowISO || clock.nowISO()));

    // ---------- API (CONTRACT 6.3) ----------
    app.get('/api/notifications', guard.api('officer', 'head'), wrap((req, res) => {
      res.json({
        items: notificationsOf(req.user.username).map((r) => ({
          id: r.id, caseNo: r.case_no, level: r.level, text: r.text, createdAt: r.created_at,
        })),
      });
    }));

    // ---------- หน้า /notifications (CONTRACT 2.12) ----------
    app.get('/notifications', guard.page('officer', 'head'), (req, res) => {
      const rows = notificationsOf(req.user.username);
      const list = rows.length
        ? `<ul class="noti-list" aria-label="รายการแจ้งเตือน">${rows.map((r) => `
  <li class="noti-item lv-${esc(r.level)}" data-testid="noti-item" data-case-no="${esc(r.case_no)}" data-level="${esc(r.level)}">
    <span class="badge lv-${esc(r.level)}" aria-hidden="true">${r.level === 'overdue' ? '⚠' : '⏰'}</span>
    <a class="noti-text" href="/officer/cases/${encodeURIComponent(r.case_no)}">${esc(r.text)}</a>
    <small class="noti-time">${timeEl(r.created_at)}</small>
  </li>`).join('')}
</ul>`
        : '<p data-testid="noti-empty" class="noti-empty">ไม่มีแจ้งเตือน</p>';
      const body = `
<h1>แจ้งเตือน</h1>
<p class="muted">แจ้งเมื่อคำขอใกล้ครบกำหนด (เหลือไม่เกิน 1 วันทำการ) หรือเกินกำหนด · ทั้งหมด ${rows.length} รายการ</p>
${list}
<p data-testid="action-error" role="alert" hidden></p>`;
      const head = `<style>
.noti-list{list-style:none;padding:0;margin:1rem 0;max-width:760px}
.noti-item{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;padding:.75rem 1rem;border:1px solid #d1d5db;border-left-width:6px;border-radius:6px;margin-bottom:.5rem;background:#fff}
.noti-item.lv-near{border-left-color:#b45309}.noti-item.lv-overdue{border-left-color:#b91c1c}
.noti-text{font-weight:600;overflow-wrap:anywhere}.noti-time{color:#4b5563;margin-left:auto}
.noti-empty{color:#374151}
</style>`;
      html.send(req, res, { title: 'แจ้งเตือน', body, head });
    });
  },
};
