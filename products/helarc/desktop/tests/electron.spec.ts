import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ServerResponse } from "node:http";

test("real chunked Ollama response reaches Electron before settlement and commits once", async ({}, info) => {
  let response: ServerResponse | undefined;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(bytes).toString()));
    response = res;
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(
      JSON.stringify({
        model: "test-model",
        message: { role: "assistant", content: "Streaming before completion." },
        done: false,
      }) + "\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const userData = await mkdtemp(join(tmpdir(), "helarc-stream-ui-"));
  const env = {
    ...process.env,
    HELARC_SMOKE_USER_DATA: userData,
    HELARC_SMOKE_ENDPOINT: `http://127.0.0.1:${address.port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    args: [fileURLToPath(new URL("./electron-smoke.mjs", import.meta.url))],
    env,
  });
  try {
    app.process().stderr?.on("data", (chunk) => console.error(String(chunk)));
    const page = await test.step("open actual window", () => app.firstWindow());
    await page.locator("#task-input").fill("Reply with the recorded result.");
    await test.step("submit through preload", () =>
      page.getByRole("button", { name: "Send message", exact: true }).click());
    await test.step("preview before final frame", () =>
      expect(page.locator(".wb-preview")).toContainText(
        "Streaming before completion.",
      ));
    expect(requests).toHaveLength(1);
    expect(requests[0].stream).toBe(true);
    expect(requests[0].messages.some((m: any) => m.role === "system")).toBe(
      false,
    );
    expect(
      (await page.evaluate(() => window.helarc.getSnapshot())).run?.display
        .terminal,
    ).toBe(false);
    await page.screenshot({ path: info.outputPath("electron-streaming.png") });
    await page.reload();
    await expect(page.locator(".wb-preview")).toContainText(
      "Streaming before completion.",
    );
    expect(requests).toHaveLength(1);
    response!.end(
      JSON.stringify({
        model: "test-model",
        message: {
          role: "assistant",
          content: " The recorded result is ready.",
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 20,
        eval_count: 12,
      }) + "\n",
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.helarc.getSnapshot())).run?.display
            .status,
      )
      .toBe("completed");
    await expect(
      page
        .locator(".wb-conversation-scroll")
        .getByText(
          "Streaming before completion. The recorded result is ready.",
          { exact: true },
        ),
    ).toHaveCount(1);
    await expect(page.locator(".wb-preview")).toHaveCount(0);
    expect(requests).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Stop work" })).toHaveCount(
      0,
    );
    await expect
      .poll(async () => {
        const data = JSON.parse(
          await readFile(join(userData, "threads.json"), "utf8"),
        );
        return data.aggregates[0]?.record.runs[0]?.terminal?.host.status;
      })
      .toBe("completed");
    await page.reload();
    await expect(
      page
        .locator(".wb-conversation-scroll")
        .getByText(
          "Streaming before completion. The recorded result is ready.",
          { exact: true },
        ),
    ).toHaveCount(1);
    expect(requests).toHaveLength(1);
  } finally {
    response?.end();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
        window.helarc.readCurrentWork({
          threadId: "missing",
          productRunId: "missing",
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
