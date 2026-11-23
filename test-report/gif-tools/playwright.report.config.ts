import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({ ...base,
  reporter: [["list"], ["json", { outputFile: "report/results.json" }], ["html", { outputFolder: "report/html", open: "never" }]],
  use: { ...base.use, video: { mode: "on", size: { width: 800, height: 450 } } },
  outputDir: "report/videos" });
