# สรุปส่งงาน LAB Week 2 · e-Service เทศบาลนครตัวอย่าง

## โครงไฟล์ (ตามที่ PROMPTS.md กำหนด)
| ขั้น | ไฟล์ |
|---|---|
| 1 วางแผน | `blocks.json` · `dag.png` · `gantt-plan.png` · `PLAN.md` (12 บล็อก, 4 บัญชี yolo1/yolo2/cyolo1/cyolo2, ประเมิน 128.3 นาที) |
| 3 รันทีม | `gantt-actual.png` · `compare.png` · `REPORT.md` · `run.log` · `run-resume.log` · `app/` |
| 4 TEST-PLAN | `test-report/index.html` · `test-report/report/results.json` · `test-report/report/gifs/` (43 GIF ของ TC ระดับ P1) · `test-report/results/matrix.log` |
| 5 BUG_MODE | `BUG-HUNT.md` |

## ผลลัพธ์
- ชุด Playwright 51 TC: **ผ่าน 51/51** เมื่อไม่เปิดบั๊ก (รันติดกัน 5 รอบ + รอบอัดวิดีโอ + รอบสุดท้ายหลังปิดบั๊ก)
- BUG_MODE B01–B12: **จับได้ 12/12** · บั๊กรวม `B03,B07` และ `B01,B05,B09` ล้มเท่ากับ union
- LAB 3: ทีมสร้างสำเร็จ 11 จาก 12 บล็อก ส่วน B12 (รวม+รันเต็ม) หมดเวลา 1500 วินาทีใน agent-team ผมทำขั้นรวม รันชุดเต็ม และ BUG_MODE matrix ด้วยตัวเอง

## test ที่แก้ (ทั้งหมดเป็น test ผิด ไม่ได้ปรับค่าที่คาดให้ตรงหน้าจอ)
| TC | แก้อะไร |
|---|---|
| TC-SLA-01 | เคยผ่านหลอกตอนเปิด B03 → ไล่ตามตารางแถว a–i ของการ์ด |
| TC-SLA-02 | เคยผ่านหลอกตอนเปิด B03 → เพิ่มสถานการณ์ส่วน 1/4/5 ตามการ์ด |
| TC-WORKFLOW-03 | race ใน test (`goto` ชนกับ reload) → ใช้ API claim และรอให้ `approve-btn` หายก่อนไปหน้าถัดไป |

## ข้อที่ต้องบอก TA / ยังไม่ปิด
1. **B03 ทำให้ TC-NOTI-02 ล้มเกิน** รายการใน BUGS.md — สาเหตุเป็นสมมติฐาน (ฟังก์ชันวันทำการตัวเดียวกับ SLA-03) ยังไม่พิสูจน์ · ไม่ได้แก้ test ให้ผ่าน
2. **SLA-02 ส่วนที่ 4:** ค่าที่คาดเปลี่ยนจาก `near` เป็น `normal` ตาม BR-14 (ตีกลับ 09:00 ส่งแก้ 15:00) — ขอให้ TA ยืนยัน
3. **TC-WORKFLOW-03:** ผ่านต่อเนื่องหลายรอบหลังแก้ แต่ยังไม่ใช่การพิสูจน์ว่า flake หายขาด
4. **`REPORT.md`, `gantt-actual.png`, `compare.png` สร้างจากการรันครั้งแรก** (B11 ล้มด้วย "claude native binary not installed") ยังไม่ได้สร้างใหม่หลัง resume — ผลหลัง resume อยู่ใน `run-resume.log` (B11 สำเร็จ, B12 timeout)
5. **สาเหตุที่ binary ของ claude หาย** ไม่ทราบ (แก้ด้วย `node install.cjs` ใน container)
6. เอเจนต์ที่ค้างจากการรันแรก 4 ตัวถูกหยุดโดยไม่ได้ตรวจการใช้โทเคน
7. GIF ของ TC ที่ใช้หลาย context เป็นภาพของ context ที่ใหญ่ที่สุดเท่านั้น และผมยังไม่ได้เปิดดูภาพในแต่ละ GIF ว่าตรงกับ TC
8. ไม่มี `FINAL-REPORT.md` จากบล็อก B12 (ไม่ได้ทำเสร็จใน agent-team)

## ก่อนส่ง
ผมไม่ได้ commit/push ให้ — โฟลเดอร์ `week2/egov-eservice/` พร้อมแล้ว (ประมาณ 14 MB ไม่รวม `node_modules`) ถ้าจะ push เข้า repo กลุ่ม บอกได้

## ข้อสังเกตด้านความปลอดภัย (ไม่ได้แก้ — คงโค้ดเดิมตามการตัดสินใจ)
ผลตรวจอัตโนมัติหลัง push พบ 2 ข้อ ผมเทียบกับ BR-24 และ CONTRACT แล้วไม่ขัดสเปก จึงไม่แก้ (แก้แล้วต้องรัน baseline + BUG_MODE ใหม่ทั้งชุด)
1. `app/src/modules/officer.js` (`POST /api/officer/cases/:caseNo/unmask`): ตรวจเฉพาะ role `officer`/`head` ไม่จำกัดตามแผนก — สเปก (BR-24, CONTRACT บรรทัด 397) ไม่ได้กำหนดให้จำกัดแผนก เป็นคำถามถึง TA ว่าต้องการหรือไม่
2. `app/src/core/session.js` (`load()`): role/แผนกของเจ้าหน้าที่อ่านจากตาราง `sessions` ไม่ใช่ `users` — ในแอปนี้ผมค้นด้วย grep ไม่พบเส้นทางเปลี่ยน role ระหว่างเซสชัน (ไม่ได้ไล่โค้ดทั้งหมด) จึงเป็นข้อเสนอเสริมความแข็งแรง ไม่ใช่ช่องโหว่ที่พิสูจน์แล้ว
