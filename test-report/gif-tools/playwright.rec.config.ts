import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({ ...base, testMatch: ["rec-*.spec.ts"], reporter: [["list"]], outputDir: "report/rec-out" });
