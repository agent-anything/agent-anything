import { test, expect, _electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual isolated Electron preload reaches Main read services", async () => {
  const userData = await mkdtemp(join(tmpdir(), "helarc-workbench-smoke-"));
  const env = { ...process.env, HELARC_SMOKE_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    args: [fileURLToPath(new URL("./electron-smoke.mjs", import.meta.url))],
    env,
  });
  try {
    const window = await application.firstWindow();
    expect(
      await window.evaluate(() => window.helarc.getSnapshot()),
    ).toMatchObject({ status: "idle" });
    expect(
      await window.evaluate(() =>
        window.helarc.listThreadRuns({ threadId: "missing" }),
      ),
    ).toMatchObject({ status: "rejected", code: "not_found" });
    expect(
      await window.evaluate(() =>
        window.helarc.readRunWorkbench({
          threadId: "missing",
          productRunId: "missing",
          runId: "missing",
          includeDescendants: false,
          cursor: null,
        }),
      ),
    ).toMatchObject({ code: "not_found" });
    expect(
      await window.evaluate(() =>
        window.helarc.openExternalLink({ url: "file:///private" }),
      ),
    ).toEqual({ ok: false });
    await expect(
      window.getByRole("button", { name: "Open settings" }),
    ).toBeVisible();
    await expect(window.locator(".wb-header")).toHaveCSS("display", "flex");
  } finally {
    await application.close();
  }
});
