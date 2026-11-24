import { _electron, expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("a large provider catalog stays bounded and filtering does not edit the configured model", async ({}, info) => {
  const root = info.outputPath("app-data");
  await mkdir(root, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: root, LOCALAPPDATA: root };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HELARC_RENDERER_DEV_SERVER_URL;
  const models = Array.from({ length: 4000 }, (_, i) => ({ name: "test-model-" + String(i).padStart(4, "0") }));
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.method + " " + req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test endpoint");
    app = await _electron.launch({ cwd: fileURLToPath(new URL("..", import.meta.url)),
      args: [`--user-data-dir=${join(root, "profile")}`, "."], env });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "New configuration" }).click();
    const model = page.getByLabel("Model", { exact: true });
    await page.getByLabel("API base URL").fill(`http://127.0.0.1:${address.port}`);
    await model.fill("manual-id");
    await page.getByRole("button", { name: "Save configuration" }).click();
    await page.getByRole("button", { name: "Query models" }).click();
    const list = page.getByRole("listbox", { name: "Available models" });
    await expect(page.getByText("4000 models", { exact: true })).toBeVisible();
    expect(await list.evaluate(el => el.clientHeight < 210 && el.scrollHeight > el.clientHeight)).toBe(true);
    const filter = page.getByRole("searchbox", { name: "Filter models" });
    await filter.fill("not-present");
    await expect(page.getByRole("status").filter({hasText: "0 of 4000 models"})).toBeVisible();
    await expect(model).toHaveValue("manual-id");
    await filter.fill("MODEL-399");
    await expect(page.getByText("10 of 4000 models")).toBeVisible();
    await list.focus();
    await list.press("End");
    await expect(model).toHaveValue("test-model-3999");
    await page.getByText("4000 models", { exact: true }).click();
    await expect(list).toBeHidden();
    await model.fill("another-manual-id");
    await expect(model).toHaveValue("another-manual-id");
    expect(calls).toEqual(["GET /api/tags"]);
  } finally {
    try { await app?.close(); } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
