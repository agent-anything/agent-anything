import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ServerResponse } from "node:http";

for (const providerKind of ["ollama", "openai-compatible"] as const) {
test(`real ${providerKind} final control reaches Electron before settlement and commits once`, async ({}, info) => {
  let response: ServerResponse | undefined;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(bytes).toString()));
    response = res;
    if (providerKind === "ollama") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
      JSON.stringify({
        model: "test-model",
        message: { role: "assistant", content: "I have prepared the response.", tool_calls: [{function: {
          name: "final_result", arguments: {response: "Streaming before completion. The recorded result is ready."},
        }}] },
        done: false,
      }) + "\n",
      );
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({id:"response",choices:[{index:0,delta:{role:"assistant",content:"I have prepared the response.",
        tool_calls:[{index:0,id:"final-call",type:"function",function:{name:"final_result",arguments:'{"response":"Streaming before completion.'}}]},finish_reason:null}]})}\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const userData = await mkdtemp(join(tmpdir(), "helarc-stream-ui-"));
  const env = {
    ...process.env,
    HELARC_SMOKE_USER_DATA: userData,
    HELARC_SMOKE_ENDPOINT: `http://127.0.0.1:${address.port}${providerKind === "ollama" ? "" : "/v1"}`,
    HELARC_SMOKE_PROVIDER_KIND: providerKind,
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
      expect(page.locator(".wb-preview").filter({hasText:"Streaming before completion."})).toContainText(
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
    await expect(page.locator(".wb-preview").filter({hasText:"Streaming before completion."})).toContainText(
      "Streaming before completion.",
    );
    expect(requests).toHaveLength(1);
    if (providerKind === "ollama") response!.end(
      JSON.stringify({
        model: "test-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{function: {name:"update_plan",arguments:{plan:[{step:"Prepare result",status:"completed"}]}}}],
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 20,
        eval_count: 12,
      }) + "\n",
    );
    else response!.end(
      `data: ${JSON.stringify({id:"response",choices:[{index:0,delta:{tool_calls:[
        {index:0,function:{arguments:' The recorded result is ready."}'}},
        {index:1,id:"plan-call",type:"function",function:{name:"update_plan",arguments:JSON.stringify({plan:[{step:"Prepare result",status:"completed"}]})}},
      ]},finish_reason:"tool_calls"}]})}\n\ndata: [DONE]\n\n`,
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
    await expect(page.locator(".wb-conversation-scroll").getByText("I have prepared the response.", {exact:true})).toHaveCount(1);
    const snapshot = await page.evaluate(() => window.helarc.getSnapshot());
    const work = await page.evaluate(s => window.helarc.readCurrentWork(s), {
      threadId:snapshot.activeThread!.id, productRunId:snapshot.run!.productRunId,
    });
    expect(work).toMatchObject({status:"page",plan:{status:"completed",steps:[{step:"Prepare result",status:"completed"}]}});
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
}

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
