import { test, expect, _electron } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("parallel Child text stays with its work without reordering or stealing reading", async ({}, info) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  const counts = {root: 0, first: 0, second: 0, later: 0};
  const held = new Map<string, {response: ServerResponse; body: any}>();
  function call(body: any, name: string, args: unknown) {
    const callable = body.tools.find((t: any) => t.function.name === name || t.function.name.startsWith(`${name}_`));
    if (!callable) throw Error(`Missing ${name}`);
    return {function: {name: callable.function.name, arguments: args}};
  }
  function chunk(response: ServerResponse, content: string, calls: unknown[] = [], done = false, thinking?: string) {
    if (!response.headersSent) response.writeHead(200, {"Content-Type": "application/x-ndjson"});
    response.write(JSON.stringify({model: "test-model", message: {role: "assistant", content, tool_calls: calls, ...(thinking ? {thinking} : {})},
      done, ...(done ? {done_reason: "stop", prompt_eval_count: 20, eval_count: 10} : {})}) + "\n");
    if (done) response.end();
  }
  const server = createServer(async (request, response) => {
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(buffers).toString());
      const task = body.messages.find((m: any) => m.role === "user")?.content ?? "";
      const owner = task.includes("first-child-fixture") ? "first"
        : task.includes("second-child-fixture") ? "second"
        : task.includes("later-child-fixture") ? "later" : "root";
      const turn = counts[owner]++;
      if (owner === "root" && turn === 0) {
        chunk(response, "I will compare two independent findings.", [
          call(body, "Agent", {prompt: "first-child-fixture: inspect files only", description: "Inspect the first input"}),
          call(body, "Agent", {prompt: "second-child-fixture: inspect files only", description: "Inspect the second input"}),
        ], true, "I can compare these independently.");
      } else if (owner === "root" && turn === 1) {
        expect(body.messages.find((message: any) => message.role === "assistant").thinking).toBe("I can compare these independently.");
        chunk(response, "Both findings have returned. Now a separate follow-up.", [
          call(body, "Agent", {prompt: "later-child-fixture: report the follow-up", description: "Follow-up inspection"}),
        ], true);
      } else if (owner !== "root" && turn === 0) held.set(owner, {response, body});
      else chunk(response, "", [call(body, "final_result", {response: `${owner} finished.`})], true);
    } catch (error) {
      errors.push(String(error));
      response.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = {...process.env, HELARC_SMOKE_USER_DATA: await mkdtemp(join(tmpdir(), "helarc-child-reading-")),
    HELARC_SMOKE_ENDPOINT: `http://127.0.0.1:${(server.address() as {port: number}).port}`, HELARC_SMOKE_TIMEOUT_MS: "80000"};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({args: [fileURLToPath(new URL("./electron-smoke.mjs", import.meta.url))], env});
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.locator("#task-input").fill("Compare independent findings and then perform a follow-up.");
    await page.getByRole("button", {name: "Send message", exact: true}).click();
    await expect.poll(() => held.has("first") && held.has("second"), {timeout: 20000}).toBe(true);
    const group = page.getByRole("region", {name: "Parallel subtasks", exact: true});
    const first = group.getByRole("region", {name: "Subtask 1", exact: true});
    const second = group.getByRole("region", {name: "Subtask 2", exact: true});
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await expect(group.getByRole("tab")).toHaveCount(0);
    await expect(page.locator(".wb-reasoning").first()).toContainText("Thinking");
    await page.locator(".wb-reasoning").first().locator("summary").click();
    await expect(page.locator(".wb-reasoning").first()).toContainText("I can compare these independently.");
    await page.locator(".wb-reasoning").first().locator("summary").click();
    await expect(group.locator(".wb-delegated-conversation")).toHaveCount(0);
    const longText = Array.from({length: 45}, (_, i) => `Second finding ${i + 1}: This response remains attributed to the second subtask.\n\n`).join("");
    chunk(held.get("second")!.response, longText);
    await expect(second.locator(".wb-child-text-preview")).toContainText("Second finding 45", {timeout: 10000});
    expect((await second.locator(".wb-child-text-preview").innerText()).length).toBeLessThanOrEqual(512);
    chunk(held.get("first")!.response, "First subtask has a new finding.");
    await expect(first.locator(".wb-child-text-preview")).toContainText("First subtask has a new finding.", {timeout: 10000});
    for (const branch of [first, second]) {
      expect(await branch.evaluate(e => e.getBoundingClientRect().height)).toBeLessThanOrEqual(100);
      await expect(branch.locator(".wb-child-activity-preview")).toContainText("Receiving model response");
      await expect(branch).toBeInViewport();
    }
    expect(await group.locator(".wb-child-navigation > strong").allTextContents()).toEqual(["Subtask 1", "Subtask 2"]);
    await page.screenshot({path: info.outputPath("parallel-child-compact.png")});
    await page.setViewportSize({width: 800, height: 850});
    await page.getByRole("button", {name: "Close work", exact: true}).click();
    expect(await group.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.screenshot({path: info.outputPath("parallel-child-compact-narrow.png")});
    await page.setViewportSize({width: 1440, height: 900});
    await second.getByRole("button", {name: "Expand Subtask 2", exact: true}).click();
    chunk(held.get("second")!.response, "", [], false, "I am considering the second input.");
    await expect(second.locator(".wb-reasoning")).toHaveCount(1);
    await second.locator(".wb-reasoning summary").click();
    await expect(second.locator(".wb-reasoning")).toContainText("I am considering the second input.");
    await second.locator(".wb-reasoning summary").click();
    await expect(second.locator(".wb-received-input")).toContainText("second-child-fixture: inspect files only");
    await expect(first.locator(".wb-received-input")).toHaveCount(0);
    const viewport = page.locator(".wb-conversation-scroll");
    await expect(group.locator(".wb-child-viewport")).toHaveCount(0);
    await expect(group.getByRole("button", {name: "Show full response", exact: true})).toBeVisible();
    expect(await group.locator(".wb-excerpt-preview").evaluate(e => e.clientHeight)).toBeLessThanOrEqual(240);
    await group.getByRole("button", {name: "Show full response", exact: true}).click();
    await expect(group.getByRole("button", {name: "Show less response", exact: true})).toHaveCount(1);
    await viewport.evaluate(e => {e.scrollTop = 120;});
    await expect.poll(() => viewport.evaluate(e => e.scrollTop)).toBe(120);
    chunk(held.get("first")!.response, " Another finding while you read.");
    await expect(first.locator(".wb-child-text-preview")).toContainText("Another finding while you read.", {timeout: 10000});
    await expect.poll(() => viewport.evaluate(e => e.scrollTop)).toBe(120);
    await first.getByRole("button", {name: "Expand Subtask 1", exact: true}).click();
    await expect(group).toContainText("First subtask has a new finding.");
    await expect(group.locator(".wb-child-branch.is-expanded")).toHaveCount(2);
    await second.getByRole("button", {name: "Collapse Subtask 2", exact: true}).click();
    await second.getByRole("button", {name: "Expand Subtask 2", exact: true}).click();
    await expect(second.getByRole("button", {name: "Show less response", exact: true})).toHaveCount(1);
    expect(await group.evaluate(root => [...root.querySelectorAll<HTMLElement>("*")].filter(e =>
      /^(auto|scroll)$/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1
    ).map(e => e.className))).toEqual([]);
    await group.getByRole("button", {name: "Show less response", exact: true}).click();
    await page.screenshot({path: info.outputPath("parallel-child-reading.png")});
    for (const name of ["second", "first"]) {
      const pending = held.get(name)!;
      chunk(pending.response, `\nI will check the available files for ${name}.`, [call(pending.body, "Glob", {pattern: "*"})], true);
    }
    await expect.poll(() => held.has("later"), {timeout: 15000}).toBe(true);
    await page.getByRole("button", {name: /Latest messages/}).click();
    await expect(group).toContainText("second finished.");
    const secondConversation = group.getByRole("region", {name: "Subtask 2: Inspect the second input", exact: true});
    await expect(secondConversation.getByRole("region", {name: "Response activity"})).toHaveCount(1);
    await secondConversation.getByRole("button", {name: "Read retained text"}).click();
    await expect(secondConversation).toContainText("I will check the available files for second.");
    const later = page.getByRole("region", {name: "Subtask 3", exact: true});
    await expect(later).toBeVisible();
    expect(await group.locator(".wb-child-branch").count()).toBe(2);
    chunk(held.get("later")!.response, "", [call(held.get("later")!.body, "final_result", {response: "Follow-up complete."})], true);
    await expect.poll(async () => (await page.evaluate(() => window.helarc.getSnapshot())).run?.display.status,
      {timeout: 15000}).toBe("completed");
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(counts).toEqual({root: 3, first: 2, second: 2, later: 1});
  } finally {
    await app.close();
    for (const pending of held.values()) if (!pending.response.writableEnded) pending.response.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
