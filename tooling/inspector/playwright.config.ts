import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "tests", testMatch: "**/*.pw.ts", workers: 1, timeout: 45_000, use: { browserName: "chromium", headless: true, viewport: { width: 1440, height: 960 } }, reporter: "list" });
