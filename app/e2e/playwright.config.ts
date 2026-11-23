// [B12] รัน: cd e2e && npm ci && DB_PATH=<ไฟล์ฐานข้อมูลของเว็บ> BASE_URL=http://127.0.0.1:3000 npx playwright test
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['tests-*.spec.ts'],
  fullyParallel: false,
  workers: 1,               // ทุก TC reset ฐานข้อมูลกลาง → ต้องรันทีละตัว
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['json', { outputFile: 'results/last.json' }]],
  use: { baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000', trace: 'off', screenshot: 'off', locale: 'th-TH', timezoneId: 'Asia/Bangkok' },
});
