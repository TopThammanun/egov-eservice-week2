# แผน egov-eservice

เป้าหมาย: สร้างเว็บ e-Service กลางตามชุดโจทย์ใน /workspace/egov-brief ทำตาม REQUIREMENTS CONTRACT TEST-DATA DECISIONS ครบ รันด้วย docker compose คำสั่งเดียว รองรับ TEST_MODE=1 และ BUG_MODE ตาม BUGS.md และมีชุด Playwright ครบ 51 TC

รวม **128.3 นาที** · สายวิกฤต: B01 → B03 → B04 → B11 → B12 · max_agents 4
ตัวปรับเวลา k (จาก calib.json): {"yolo": 0.094, "image": 0.117, "cyolo": 0.129}

## บัญชี

| บัญชี | ที่มา | ใช้ไปแล้ว session/week % | slot | หมายเหตุ |
|---|---|---|---|---|
| yolo1 | โควตาจริง | 23 / 4 | 4 | as_of 2026-11-16T10:28:45 |
| yolo2 | โควตาจริง | 10 / 4 | 4 | as_of 2026-11-16T10:28:47 |
| cyolo1 | โควตาจริง | ? / 10 | 3 | as_of 2026-11-12T12:12:03 |
| cyolo2 | โควตาจริง | ? / 0 | 3 | as_of 2026-11-11T13:35:15 |

## บล็อก

| บล็อก | ชื่อ | สกิล | ขนาด | rank (M tok) | บัญชี (บทบาท) | เริ่ม–จบ (นาที) | นาที | โหมด |
|---|---|---|---|---|---|---|---|---|
| B01 🔶 | โครงโปรเจกต์+DB+hook | yolo | M | 12.00 | yolo2 (ทำ) | 0.0–1.2 | 1.2 | full |
| B09 | Playwright ชุด A | cyolo | L | 6.00 | cyolo1 (ทำ) | 0.0–4.8 | 4.8 | full |
| B10 | Playwright ชุด B | cyolo | L | 6.00 | cyolo2 (ทำ) | 0.0–4.8 | 4.8 | full |
| B02 | Auth+RBAC+ลงทะเบียน | yolo | M | 9.00 | yolo2 (ทำ) | 1.2–2.4 | 1.2 | full |
| B06 | เอกสารดิจิทัล+verify | yolo | M | 6.00 | yolo2 (ทำ) | 2.4–3.6 | 1.2 | full |
| B03 🔶 | ไลบรารีกฎธุรกิจ | review | L | 10.50 | yolo2 (ทำ), cyolo1 (ตรวจ) | 3.6–63.6 | 60.0 | full |
| B04 🔶 | ฝั่งประชาชน ยื่น+จ่าย | yolo | L | 7.50 | yolo2 (ทำ) | 63.6–65.9 | 2.3 | full |
| B05 | ฝั่งเจ้าหน้าที่/หัวหน้า | yolo | L | 7.50 | yolo2 (ทำ) | 63.6–65.9 | 2.3 | full |
| B07 | แจ้งเตือน+ยกเลิกอัตโนมัติ | yolo | M | 4.50 | yolo2 (ทำ) | 63.6–64.8 | 1.2 | full |
| B08 | Dashboard+Audit+Admin | review | L | 7.50 | yolo2 (ทำ), cyolo2 (ตรวจ) | 64.8–124.8 | 60.0 | full |
| B11 🔶 | UI responsive+a11y | yolo | M | 4.50 | yolo2 (ทำ) | 124.8–126.0 | 1.2 | full |
| B12 🔶 | รวม+รันเต็ม+BUG_MODE | yolo | L | 3.00 | yolo2 (ทำ) | 126.0–128.3 | 2.3 | full |

🔶 = อยู่บนสายวิกฤต · โหมด full = บัญชีเดียวปิดงานได้ · relay = โควตาไม่พอคนเดียวต้องส่งต่อ · best-effort/forced = ทีมว่างและไม่มีบัญชีใดพอ (เสี่ยงโควตา)

## เหตุผล KC-QUEST ของทุกบล็อก

### B01 · โครงโปรเจกต์+DB+hook (yolo)
- **ทำ** → yolo2: KC-QUEST 50.6 (urgency=0.564 fit=0.005 session=0.861 speed=1.0 load=0.0) · ประเมิน 1.50M tok ≈ 5ชม. 3.9% / สัปดาห์ 0.49% · อันดับ 2 yolo1 32.4

### B09 · Playwright ชุด A (cyolo)
- **ทำ** → cyolo1: KC-QUEST 20.8 (urgency=0.038 fit=0.011 session=0.922 speed=0.35 load=0.0) · ประเมิน 3.00M tok ≈ 5ชม. 7.8% / สัปดาห์ 0.98% · อันดับ 2 cyolo2 20.8

### B10 · Playwright ชุด B (cyolo)
- **ทำ** → cyolo2: KC-QUEST 20.8 (urgency=0.038 fit=0.01 session=0.922 speed=0.35 load=0.0) · ประเมิน 3.00M tok ≈ 5ชม. 7.8% / สัปดาห์ 0.98% · อันดับ 2 cyolo1 16.3

### B02 · Auth+RBAC+ลงทะเบียน (yolo)
- **ทำ** → yolo2: KC-QUEST 46.3 (urgency=0.564 fit=0.005 session=0.822 speed=0.75 load=0.0) · ประเมิน 1.50M tok ≈ 5ชม. 3.9% / สัปดาห์ 0.49% · อันดับ 2 yolo1 28.7

### B06 · เอกสารดิจิทัล+verify (yolo)
- **ทำ** → yolo2: KC-QUEST 41.9 (urgency=0.564 fit=0.005 session=0.783 speed=0.5 load=0.0) · ประเมิน 1.50M tok ≈ 5ชม. 3.9% / สัปดาห์ 0.49% · อันดับ 2 yolo1 24.9

### B03 · ไลบรารีกฎธุรกิจ (review)
- **ทำ** → yolo2: KC-QUEST 46.5 (urgency=0.564 fit=0.01 session=0.705 speed=0.875 load=0.0) · ประเมิน 3.00M tok ≈ 5ชม. 7.8% / สัปดาห์ 0.98% · อันดับ 2 yolo1 30.0
- **ตรวจ** → cyolo1: KC-QUEST 20.7 (urgency=0.038 fit=0.005 session=0.883 speed=0.612 load=0.333) · ประเมิน 1.50M tok ≈ 5ชม. 3.9% / สัปดาห์ 0.49% · อันดับ 2 cyolo2 20.7

### B04 · ฝั่งประชาชน ยื่น+จ่าย (yolo)
- **ทำ** → yolo2: KC-QUEST 41.6 (urgency=0.564 fit=0.01 session=0.627 speed=0.625 load=0.0) · ประเมิน 3.00M tok ≈ 5ชม. 7.8% / สัปดาห์ 0.98% · อันดับ 2 yolo1 26.3

### B05 · ฝั่งเจ้าหน้าที่/หัวหน้า (yolo)
- **ทำ** → yolo2: KC-QUEST 37.9 (urgency=0.564 fit=0.011 session=0.549 speed=0.625 load=0.25) · ประเมิน 3.00M tok ≈ 5ชม. 7.8% / สัปดาห์ 0.98% · อันดับ 2 yolo1 26.3

### B07 · แจ้งเตือน+ยกเลิกอัตโนมัติ (yolo)
- **ทำ** → yolo2: KC-QUEST 31.0 (urgency=0.564 fit=0.005 session=0.51 speed=0.375 load=0.5) · ประเมิน 1.50M tok ≈ 5ชม. 3.9% / สัปดาห์ 0.49% · อันดับ 2 yolo1 23.0

### B08 · Dashboard+Audit+Admin (review)
- **ทำ** → yolo2: KC-QUEST 33.6 (urgency=0.564 fit=0.011 session=0.432 speed=0.625 load=0.5) · ประเมิน 3.00M tok ≈ 5ชม. 7.8% / สัปดาห์ 0.98% · อันดับ 2 yolo1 26.3
- **ตรวจ** → cyolo2: KC-QUEST 21.4 (urgency=0.038 fit=0.005 session=0.883 speed=0.438 load=0.0) · ประเมิน 1.50M tok ≈ 5ชม. 3.9% / สัปดาห์ 0.49% · อันดับ 2 cyolo1 20.9

### B11 · UI responsive+a11y (yolo)
- **ทำ** → yolo2: KC-QUEST 34.2 (urgency=0.564 fit=0.005 session=0.393 speed=0.375 load=0.0) · ประเมิน 1.50M tok ≈ 5ชม. 3.9% / สัปดาห์ 0.49% · อันดับ 2 yolo1 23.0

### B12 · รวม+รันเต็ม+BUG_MODE (yolo)
- **ทำ** → yolo2: KC-QUEST 31.3 (urgency=0.564 fit=0.011 session=0.315 speed=0.25 load=0.0) · ประเมิน 3.00M tok ≈ 5ชม. 7.8% / สัปดาห์ 0.98% · อันดับ 2 yolo1 20.7
