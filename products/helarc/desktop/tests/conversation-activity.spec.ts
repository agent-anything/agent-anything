import { test, expect, _electron } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("actual commands and nested delegation retain their response owners", async ({}, info) => {
  test.setTimeout(60000);
  const requests: any[] = [];
  const errors: string[] = [];
  const counts = { root: 0, child: 0, leaf: 0 };
  let held: { response: ServerResponse; body: any } | undefined;
  const callable = (body: any, name: string) => {
    const result = body.tools.find(
      (t: any) =>
        t.function.name === name || t.function.name.startsWith(`${name}_`),
    );
    if (!result) throw Error(`Missing ${name}`);
    return result.function.name;
  };
  const call = (body: any, name: string, args: unknown) => ({
    function: { name: callable(body, name), arguments: args },
  });
  const reply = (
    response: ServerResponse,
    content: string,
    calls: unknown[],
  ) => {
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.end(
      JSON.stringify({
        model: "test-model",
        message: { role: "assistant", content, tool_calls: calls },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 20,
        eval_count: 10,
      }) + "\n",
    );
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const task =
        body.messages.find((m: any) => m.role === "user")?.content ?? "";
      const owner = task.includes("leaf-fixture")
        ? "leaf"
        : task.includes("child-fixture")
          ? "child"
          : "root";
      const turn = counts[owner]++;
      if (owner === "leaf")
        reply(response, "", [
          call(body, "final_result", {
            response: "Nested inspection finished.",
          }),
        ]);
      else if (owner === "child") {
        if (!turn)
          reply(response, "I will delegate the small check.", [
            call(body, "Agent", {
              prompt: "leaf-fixture: report the nested inspection result.",
              description: "Nested inspection",
            }),
          ]);
        else
          reply(response, "", [
            call(body, "final_result", {
              response: "Delegated inspection finished.",
            }),
          ]);
      } else if (!turn)
        reply(
          response,
          "I will start a background command and inspect paths.",
          [
            call(body, process.platform === "win32" ? "PowerShell" : "Bash", {
              command:
                process.platform === "win32"
                  ? "Write-Output 'begin'; Start-Sleep -Seconds 8; Write-Output 'end'"
                  : "printf 'begin\\n'; sleep 8; printf 'end\\n'",
              description: "Observe a background process",
              run_in_background: true,
              timeout_ms: 20000,
            }),
            call(body, "Glob", { pattern: "*" }),
          ],
        );
      else if (turn === 1)
        reply(
          response,
          "I am delegating the inspection while the command continues.",
          [
            call(body, "Agent", {
              prompt:
                "child-fixture: delegate a small check and report the result.",
              description: "Inspect delegated work",
            }),
          ],
        );
      else if (turn === 2) held = { response, body };
      else
        reply(response, "", [
          call(body, "final_result", {
            response: "The command and delegated work are recorded.",
          }),
        ]);
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const userData = await mkdtemp(
    join(tmpdir(), "helarc-conversation-activity-"),
  );
  const env = {
    ...process.env,
    HELARC_SMOKE_USER_DATA: userData,
    HELARC_SMOKE_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    HELARC_SMOKE_TIMEOUT_MS: "45000",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    args: [fileURLToPath(new URL("./electron-smoke.mjs", import.meta.url))],
    env,
  });
  try {
    const page = await app.firstWindow();
    const conversation = page.locator(".wb-conversation-scroll");
    await page
      .locator("#task-input")
      .fill("Observe a command and delegated work.");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(
        async () => {
          const snapshot = await page.evaluate(() =>
            window.helarc.getSnapshot(),
          );
          return snapshot.run?.host.pendingInteractions.length ?? 0;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect.poll(() => held !== undefined, { timeout: 15000 }).toBe(true);
    expect(errors).toEqual([]);
    expect(counts).toEqual({ root: 3, child: 2, leaf: 1 });
    expect(
      requests.every((r) => !r.messages.some((m: any) => m.role === "system")),
    ).toBe(true);

    const response = conversation
      .locator(".wb-response")
      .filter({ hasText: "I will start a background command" });
    await expect(
      response.getByRole("region", { name: "Response activity" }),
    ).toHaveCount(1);
    await response
      .getByRole("button", { name: "Expand activity", exact: true })
      .click();
    await expect(response.locator(".wb-activity-item")).toHaveCount(2);
    const command = response
      .locator(".wb-activity-item")
      .filter({
        hasText: process.platform === "win32" ? "Start-Sleep" : "sleep 8",
      });
    await command.getByRole("button").first().click();
    await expect(command.locator(".wb-output")).toContainText("begin");
    const second = conversation
      .locator(".wb-response")
      .filter({ hasText: "I am delegating the inspection" });
    await second
      .getByRole("button", { name: "Expand activity", exact: true })
      .click();
    await second.locator(".wb-activity-item > button").first().click();
    const child = second.getByRole("region", {
      name: "Subtask 1: Inspect delegated work",
      exact: true,
    });
    await expect(child).toContainText("Delegated inspection finished.");
    await child
      .getByRole("button", { name: "Expand activity", exact: true })
      .click();
    await child.locator(".wb-activity-item > button").first().click();
    await expect(
      child.getByRole("region", { name: "Subtask 1.1: Nested inspection", exact: true }),
    ).toContainText("Nested inspection finished.");
    await expect(page.locator("#task-input")).toHaveAttribute(
      "placeholder",
      "Add guidance...",
    );
    await page.screenshot({
      path: info.outputPath("response-owned-nested-work.png"),
    });

    const taskId = /"task_id"\s*:\s*"([^"]+)"/.exec(
      held!.body.messages.map((m: any) => m.content ?? "").join("\n"),
    )?.[1];
    expect(taskId).toBeTruthy();
    await expect(command).toContainText("Exited with code 0", {
      timeout: 15000,
    });
    await expect(command.locator(".wb-output")).toContainText("end");
    reply(held!.response, "I will read the retained command result.", [
      call(held!.body, "TaskOutput", { task_id: taskId, wait_ms: 15000 }),
    ]);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.helarc.getSnapshot())).run?.display
            .status,
        { timeout: 20000 },
      )
      .toBe("completed");
    await expect(command).toContainText("Exited with code 0");
    await expect(command.locator(".wb-output")).toContainText("end");
    await page.getByRole("button", { name: /Latest messages/ }).click();
    await expect(
      conversation.getByText("The command and delegated work are recorded.", {
        exact: true,
      }),
    ).toHaveCount(1);
    const totalRequests = requests.length;
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(userData, "threads.json"), "utf8"))
            .aggregates[0]?.record.runs[0]?.terminal?.host.status,
      )
      .toBe("completed");
    const stored = JSON.parse(
      await readFile(join(userData, "threads.json"), "utf8"),
    ).aggregates[0].record;
    const retained = stored.runs[0].terminal.finalProjection.product;
    expect(retained.commands).toHaveLength(1);
    expect(retained.commands[0].origin.turnId).toBeTruthy();
    expect(
      retained.presentation.labels
        .filter((label: any) => label.parentRunId)
        .every((label: any) => label.parentOrigin !== null),
    ).toBe(true);
    await page.reload();
    await expect(
      conversation.getByText("The command and delegated work are recorded.", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      conversation.getByText("Delegated inspection finished.", { exact: true }),
    ).toHaveCount(0);
    await response
      .getByRole("button", { name: "Expand activity", exact: true })
      .click();
    await expect(response).toContainText("Exited with code 0");
    expect(requests).toHaveLength(totalRequests);
  } finally {
    if (info.status !== info.expectedStatus) {
      const page = app.windows()[0];
      if (page)
        await info.attach("application-state", {
          body: JSON.stringify({
            errors,
            counts,
            text: await page.locator("body").innerText(),
            snapshot: await page.evaluate(() => window.helarc.getSnapshot()),
          }),
          contentType: "application/json",
        });
    }
    held?.response.end();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
