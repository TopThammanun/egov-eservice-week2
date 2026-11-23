| BUG_MODE | TC ที่ต้องล้ม (อาจล้มด้วย) | TC ที่ล้มจริง | ล้มเกินที่คาด | ควรล้มแต่ผ่าน | ผล |
|---|---|---|---|---|---|
| (ปกติ) | – | – | – | – | 51/51 passed ✅ |
| B01 | TC-FEE-01 | TC-FEE-01 | – | – | 50/51 passed ✅ |
| B02 | TC-UPLOAD-01 | TC-UPLOAD-01 | – | – | 50/51 passed ✅ |
| B03 | TC-SLA-01 · TC-SLA-02 (TC-SLA-03 · TC-RBAC-04) | TC-RBAC-04 · TC-SLA-01 · TC-SLA-02 | – | – | 48/51 passed ✅ |
| B04 | TC-SLA-02 | TC-SLA-02 | – | – | 50/51 passed ✅ |
| B05 | TC-PAY-01 | TC-PAY-01 | – | – | 50/51 passed ✅ |
| B06 | TC-RBAC-01 | TC-RBAC-01 | – | – | 50/51 passed ✅ |
| B07 | TC-RBAC-02 (TC-WORKFLOW-01) | TC-RBAC-02 | – | – | 50/51 passed ✅ |
| B08 | TC-QUEUE-02 | TC-QUEUE-02 | – | – | 50/51 passed ✅ |
| B09 | TC-PDPA-02 | TC-PDPA-02 | – | – | 50/51 passed ✅ |
| B10 | TC-DASH-02 (TC-DASH-01 · TC-DASH-03) | TC-DASH-01 · TC-DASH-02 · TC-DASH-03 | – | – | 48/51 passed ✅ |
| B11 | TC-PDPA-03 · TC-AUDIT-01 | TC-AUDIT-01 · TC-PDPA-03 | – | – | 49/51 passed ✅ |
| B12 | TC-WORKFLOW-04 | TC-WORKFLOW-04 | – | – | 50/51 passed ✅ |
| B03,B07 | TC-SLA-01 · TC-SLA-02 · TC-RBAC-02 (TC-SLA-03 · TC-RBAC-04 · TC-WORKFLOW-01) | TC-RBAC-02 · TC-RBAC-04 · TC-SLA-01 · TC-SLA-02 | – | – | 47/51 passed ✅ |
| B01,B05,B09 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | TC-FEE-01 · TC-PAY-01 · TC-PDPA-02 | – | – | 48/51 passed ✅ |

<details><summary>ข้อความ assert ที่ล้ม</summary>

- **B01** TC-FEE-01: Error: expect(locator).toHaveText(expected) failed Locator:  getByTestId('fee-total') Expected: "฿1,010" Received: "฿1,000"
- **B02** TC-UPLOAD-01: Error: expect(received).toBe(expected) // Object.is equality Expected: 201 Received: 400
- **B03** TC-RBAC-04: Error: expect(received).toBe(expected) // Object.is equality Expected: "2026-12-08T16:30:00+07:00" Received: "2026-12-04T16:30:00+07:00"
- **B03** TC-SLA-01: Error: แถว c dueAt expect(received).toBe(expected) // Object.is equality Expected: "2026-12-08T16:30:00+07:00" Received: "2026-12-07T16:30:00+07:00"
- **B03** TC-SLA-02: Error: 2026-12-02T11:00:00+07:00 -> 2026-12-03T10:00:00+07:00 expect(received).toBe(expected) // Object.is equality Expected: "2026-12-08T16:30:00+07:00" Received: "2026-12-07T16:30:00+07:00"
- **B04** TC-SLA-02: Error: expect(received).toBe(expected) // Object.is equality Expected: "2026-12-01T16:30:00+07:00" Received: "2026-11-27T16:30:00+07:00"
- **B05** TC-PAY-01: Error: expect(received).toBe(expected) // Object.is equality Expected: 410 Received: 200
- **B06** TC-RBAC-01: Error: expect(received).toBe(expected) // Object.is equality Expected: 404 Received: 200
- **B07** TC-RBAC-02: Error: expect(received).toBe(expected) // Object.is equality Expected: 403 Received: 200
- **B08** TC-QUEUE-02: Error: expect(received).toEqual(expected) // deep equality - Expected  - 1 + Received  + 1   Array [
- **B09** TC-PDPA-02: Error: expect(received).not.toMatch(expected) Expected pattern: not /\d{13}\|\d-\d{4}-\d{5}-\d{2}-\d/ Received string:      "{\"filter\":\"all\",\"items\":[{\"caseNo\":\"EG-2569-000020\",\"serviceId\":\"SV-01\",\"service
- **B10** TC-DASH-01: Error: expect(locator).toHaveText(expected) failed Locator:  getByTestId('kpi-ontime-pct') Expected: "–" Received: "0.0%"
- **B10** TC-DASH-02: Error: expect(locator).toHaveText(expected) failed Locator:  getByTestId('kpi-ontime-pct') Expected: "85.7%" Received: "23.1%"
- **B10** TC-DASH-03: Error: expect(received).toEqual(expected) // deep equality - Expected  - 1 + Received  + 1 @@ -7,11 +7,11 @@
- **B11** TC-AUDIT-01: Error: expect(locator).toHaveText(expected) failed Locator:  getByTestId('audit-count') Expected: "16" Received: "15"
- **B11** TC-PDPA-03: Error: expect(locator).toHaveText(expected) failed Locator:  getByTestId('audit-count') Expected: "1" Received: "0"
- **B12** TC-WORKFLOW-04: Error: expect(locator).toHaveCount(expected) failed Locator:  getByTestId('return-btn') Expected: 0 Received: 1
- **B03_B07** TC-RBAC-02: Error: expect(received).toBe(expected) // Object.is equality Expected: 403 Received: 200
- **B03_B07** TC-RBAC-04: Error: expect(received).toBe(expected) // Object.is equality Expected: "2026-12-08T16:30:00+07:00" Received: "2026-12-04T16:30:00+07:00"
- **B03_B07** TC-SLA-01: Error: แถว c dueAt expect(received).toBe(expected) // Object.is equality Expected: "2026-12-08T16:30:00+07:00" Received: "2026-12-07T16:30:00+07:00"
- **B03_B07** TC-SLA-02: Error: 2026-12-02T11:00:00+07:00 -> 2026-12-03T10:00:00+07:00 expect(received).toBe(expected) // Object.is equality Expected: "2026-12-08T16:30:00+07:00" Received: "2026-12-07T16:30:00+07:00"
- **B01_B05_B09** TC-FEE-01: Error: expect(locator).toHaveText(expected) failed Locator:  getByTestId('fee-total') Expected: "฿1,010" Received: "฿1,000"
- **B01_B05_B09** TC-PAY-01: Error: expect(received).toBe(expected) // Object.is equality Expected: 410 Received: 200
- **B01_B05_B09** TC-PDPA-02: Error: expect(received).not.toMatch(expected) Expected pattern: not /\d{13}\|\d-\d{4}-\d{5}-\d{2}-\d/ Received string:      "{\"filter\":\"all\",\"items\":[{\"caseNo\":\"EG-2569-000020\",\"serviceId\":\"SV-01\",\"service

</details>

สรุป: จับบั๊กได้ตรงตาราง 12/12 · รอบไม่เปิดบั๊ก 3 รอบ ผ่านครบ 51/51 · ผ่านเกณฑ์ BUGS.md §3
