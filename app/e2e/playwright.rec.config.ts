// อัดวิดีโอทุก browser context (รวม context ที่ test สร้างเองด้วย browser.newContext) → ใช้โดย record-gifs.js
//   REC_DIR=results/rec/TC-AUTH-01 npx playwright test -c playwright.rec.config.ts -g "TC-AUTH-01"
import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...base,
  reporter: [['line']],
  outputDir: 'results/rec-out',
  use: {
    ...base.use,
    contextOptions: { recordVideo: { dir: process.env.REC_DIR ?? 'results/rec', size: { width: 800, height: 450 } } },
  },
});
