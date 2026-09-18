import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", workers: 1, timeout: 30000,
  use: { viewport: { width: 1440, height: 900 }, baseURL: "http://127.0.0.1:5177" },
  webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5177 --strictPort", url: "http://127.0.0.1:5177", reuseExistingServer: false },
});
