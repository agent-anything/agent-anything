import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rendererUrl = process.env.HELARC_RENDERER_DEV_SERVER_URL ?? "http://127.0.0.1:5173/";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const useShell = process.platform === "win32";
let shuttingDown = false;

const vite = spawn(
  pnpm,
  ["exec", "vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  {
    cwd: appRoot,
    stdio: "inherit",
    env: process.env,
    shell: useShell,
  },
);

vite.once("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`Vite dev server exited before Electron started. code=${code} signal=${signal}`);
    process.exit(code ?? 1);
  }
});

try {
  await waitForHttp(rendererUrl);
} catch (error) {
  shutdown();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const electron = spawn(
  pnpm,
  ["exec", "electron", "."],
  {
    cwd: appRoot,
    stdio: "inherit",
    shell: useShell,
    env: {
      ...process.env,
      HELARC_RENDERER_DEV_SERVER_URL: rendererUrl,
    },
  },
);

electron.once("exit", (code) => {
  shutdown();
  process.exit(code ?? 0);
});

process.once("SIGINT", () => {
  shutdown();
  process.exit(130);
});

process.once("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

async function waitForHttp(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(250);
    }
  }

  throw new Error(`Timed out waiting for Vite dev server at ${url}`);
}

function shutdown() {
  shuttingDown = true;
  if (!vite.killed) {
    vite.kill();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
