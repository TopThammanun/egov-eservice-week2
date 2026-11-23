// รันชุดเต็มพร้อมรายงาน: report/results.json + report/html (คัดลอกไป ../../test-report/) · GIF ทำแยกด้วย record-gifs.js
//   DB_PATH=$PWD/.data/egov.db BASE_URL=http://127.0.0.1:3912 npx playwright test -c playwright.report.config.ts
import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...base,
  reporter: [['list'], ['json', { outputFile: 'report/results.json' }], ['html', { outputFolder: 'report/html', open: 'never' }]],
  outputDir: 'report/out',
});
