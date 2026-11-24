import { _electron, expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("production window opens Responses settings without a provider configuration", async ({}, info) => {
  const root = info.outputPath("app-data");
  await mkdir(root, { recursive: true });
  const env = { ...process.env, APPDATA: root, LOCALAPPDATA: root };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HELARC_RENDERER_DEV_SERVER_URL;
  const desktop = fileURLToPath(new URL("..", import.meta.url));
  const app = await _electron.launch({ cwd: desktop, args: [`--user-data-dir=${join(root, "profile")}`, "."], env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("button", { name: "Open settings" }).click();
    expect(new URL(page.url()).protocol).toBe("file:");
    await page.getByLabel("Model Interaction Protocol").selectOption("openai.responses");
    await page.getByRole("button", { name: "New configuration" }).click();
    await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Credential source")).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
