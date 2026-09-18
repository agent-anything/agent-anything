import { test, expect, type Page } from "@playwright/test";
import { createWorkbenchTestRun } from "../src/shared/testing/HelarcWorkbenchTestFixture.js";

async function setup(page: Page, pending = false, terminal = false) {
  const run = createWorkbenchTestRun(terminal ? { status: "completed" } : {});
  await page.addInitScript(
    ({ run, pending, terminal }) => {
      const root = run.harnessRunId,
        child = "child-1";
      const rootNode = run.host.runTree.nodes[0]!;
      (run.host.runTree as any).nodes = [
        { ...rootNode, status: terminal ? "completed" : "running" },
        {
          ...rootNode,
          runId: child,
          parentRunId: root,
          depth: 1,
          status: "completed",
        },
      ];
      const request = (id: string, runId: string) => ({
        runId,
        family: "clarification",
        request: {
          id,
          protocol: { owner: "helarc", kind: "clarification", revision: "1" },
          requestVersion: 1,
          subject: { owner: "helarc", kind: "call", id, revision: "1" },
        },
        phase: "pending",
        disclosureClass: "internal",
        expiresAt: null,
        blockingScope: "branch",
        presentation: {
          questions: [
            {
              id: "question",
              prompt: `Question ${id}`,
              options: [],
              allowMultiple: false,
            },
          ],
        },
      });
      (run.host as any).pendingInteractions = pending
        ? [request("one", root), request("two", child)]
        : [];
      const finalText = "The recorded result is ready.";
      const source = {
        kind: "model_text",
        turnId: "turn",
        modelItemIds: ["answer"],
      };
      const snapshot: any = {
        status: terminal ? "completed" : "running",
        workspace: {
          id: "workspace",
          name: "Example project",
          path: "D:/example",
        },
        workspaceProfiles: [],
        acceptedTask: {
          id: "task",
          prompt: "Inspect the workspace and report findings.",
        },
        provider: {
          configured: true,
          activeProfile: {
            id: "provider",
            providerKind: "ollama",
            displayName: "Ollama",
            baseUrl: "http://localhost:11435",
            model: "gemma4:e4b",
            timeoutMs: 300000000,
            credentialStatus: "empty_allowed",
            qualificationPolicy: "allow_experimental",
            ollamaRuntime: {
              contextWindowTokens: 163840,
              maximumOutputTokens: 2048,
            },
          },
          profiles: [],
          error: null,
          nativeToolInteraction: { supported: true },
        },
        activeThread: {
          id: "thread",
          title: "Inspect the workspace",
          status: "open",
          workspace: {
            id: "workspace",
            name: "Example project",
            path: "D:/example",
          },
          revision: 1,
          messages: [
            {
              id: "user",
              sequence: 1,
              role: "user",
              content: "Inspect the workspace and report findings.",
              createdAt: "2026-09-18T08:00:00Z",
              relatedRunIds: [run.productRunId],
              relatedArtifactIds: [],
            },
            ...(terminal
              ? [
                  {
                    id: "final",
                    sequence: 2,
                    role: "assistant",
                    content: finalText,
                    createdAt: "2026-09-18T08:01:00Z",
                    relatedRunIds: [run.productRunId],
                    relatedArtifactIds: [],
                    outputSource: source,
                  },
                ]
              : []),
          ],
          artifacts: [],
        },
        threadSummaries: [],
        run,
        error: null,
      };
      const records = [
        {
          id: "call",
          runId: root,
          sequence: 1,
          revision: 1,
          observedAt: "2026-09-18T08:00:01Z",
          source: {
            owner: "runtime",
            kind: "run_item",
            id: "record1",
            sequence: 1,
          },
          content: {
            kind: "tool_call",
            callId: "call",
            turnId: "turn",
            name: "Bash",
            input: { command: "echo hello" },
            runActionId: "action",
            invocationId: "invocation",
            settlement: "completed",
            result: { stdout: "hello" },
          },
        },
        {
          id: "answer",
          runId: root,
          sequence: 2,
          revision: 2,
          observedAt: "2026-09-18T08:01:00Z",
          source: {
            owner: "runtime",
            kind: "run_item",
            id: "record2",
            sequence: 2,
          },
          content: {
            kind: "assistant_text",
            turnId: "turn",
            modelItemId: "answer",
            ordinal: 0,
            text:
              finalText +
              (terminal
                ? ""
                : "\n\n" +
                  "An ordinary paragraph with complete content.\n\n".repeat(
                    25,
                  )),
            omittedBytes: 0,
          },
        },
      ];
      let listener: (value: unknown) => void = () => {};
      (window as any).calls = [];
      (window as any).emitWorkbench = (mutate: string) => {
        if (mutate === "revision") {
          snapshot.run.product.presentationRevision++;
          snapshot.activeThread.revision++;
        }
        listener(structuredClone(snapshot));
      };
      (window as any).helarc = {
        getSnapshot: async () => structuredClone(snapshot),
        subscribeSnapshot: (fn: typeof listener) => {
          listener = fn;
          return () => {};
        },
        listThreadRuns: async () => ({
          status: "page",
          runs: [
            {
              productRunId: run.productRunId,
              harnessRunId: root,
              startedAt: run.host.startedAt,
              completedAt: null,
              status: terminal ? "completed" : "running",
              live: !terminal,
              objective: "Inspect the workspace",
            },
          ],
        }),
        readRunWorkbench: async (query: any) => ({
          status: "page",
          scope: query,
          live: !terminal,
          revision: 2,
          recordedAt: "2026-09-18T08:01:00Z",
          run,
          labels: [
            {
              runId: root,
              parentRunId: null,
              parentRunActionId: null,
              label: "Root",
              objective: "Inspect the workspace",
            },
            {
              runId: child,
              parentRunId: root,
              parentRunActionId: "delegate",
              label: "Inspect dependencies",
              objective: "Review declared dependencies",
            },
          ],
          plans: {
            [root]: {
              steps: [{ description: "Inspect sources", status: "completed" }],
            },
          },
          records: query.runId === root ? records : [],
          commands: [
            {
              runId: root,
              executionId: "exec-1",
              revision: 1,
              phase: terminal ? "settled" : "running",
              outcome: terminal ? "succeeded" : null,
              command: "echo hello",
              shell: "powershell",
              cwd: "D:/example",
              observedAt: "2026-09-18T08:00:00Z",
              startedAt: "2026-09-18T08:00:00Z",
              completedAt: null,
              capturedBytes: 6,
              omittedBytes: 0,
              outputPersistence: "complete",
              processId: 123,
            },
          ],
          activity: [],
          nextCursor: null,
          omittedRecords: 0,
          finalSource: source,
        }),
        readCommandOutput: async (query: any) => {
          (window as any).calls.push({ method: "output", query });
          const stream = (text: string) => ({
            text,
            encoding: "utf-8",
            integrity: "exact",
            omittedBytes: 0,
            replacementCount: 0,
          });
          return {
            status: "page",
            source: terminal ? "retained" : "live",
            stdout: stream(query.cursor ? "" : "hello\n"),
            stderr: stream(""),
            nextCursor: "next",
            hasMore: false,
            settled: terminal,
          };
        },
        steerRun: async (query: any) => {
          (window as any).calls.push({ method: "steer", query });
          return {
            snapshot,
            receipt: {
              status: "handled",
              kind: "run.steer",
              result: { status: "accepted_for_application" },
            },
          };
        },
        submitInteraction: async (query: any) => {
          (window as any).calls.push({ method: "submit", query });
          snapshot.run.host.pendingInteractions =
            snapshot.run.host.pendingInteractions.filter(
              (item: any) => item.request.id !== query.request.id,
            );
          return {
            snapshot: structuredClone(snapshot),
            receipt: {
              status: "handled",
              kind: "interaction.submit",
              result: { status: "accepted_for_resolution" },
            },
          };
        },
        openExternalLink: async () => ({ ok: true }),
      };
    },
    { run, pending, terminal },
  );
  await page.goto("/");
  await expect(page.locator(".wb-header")).toHaveCSS("display", "flex");
  await expect(page.locator(".wb-conversation-scroll")).toHaveCSS(
    "overflow-y",
    "auto",
  );
  await expect(
    page.getByText("The recorded result is ready.", { exact: true }),
  ).toBeVisible();
}

test("conversation and final answer use one source; wide layout stays bounded", async ({
  page,
}, info) => {
  await setup(page, false, true);
  await expect(
    page
      .locator(".wb-conversation-scroll")
      .getByText("The recorded result is ready.", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Templates" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("wide.png") });
});
test("Child inspection does not retarget steering", async ({ page }) => {
  await setup(page);
  await page.locator(".wb-tree > summary").click();
  await page
    .getByRole("button", { name: /Inspect dependencies.*completed/ })
    .click();
  await page.locator("#task-input").fill("Keep investigating");
  await page
    .getByRole("button", { name: "Send guidance", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.find((call: any) => call.method === "steer").query
          .runId,
    ),
  ).toBe("harness-run-1");
});
test("request drafts survive drawer closing and sibling submission", async ({
  page,
}) => {
  await setup(page, true);
  await page.getByRole("button", { name: "Requests 2" }).click();
  await page
    .getByRole("textbox", { name: "Free-text answer for Question two" })
    .fill("Second answer");
  await page.getByRole("button", { name: "Close requests" }).click();
  await page.getByRole("button", { name: "Requests 2" }).click();
  await expect(
    page.getByRole("textbox", { name: "Free-text answer for Question two" }),
  ).toHaveValue("Second answer");
  await page
    .getByRole("textbox", { name: "Free-text answer for Question one" })
    .fill("First answer");
  await page
    .getByRole("button", { name: "Submit", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("textbox", { name: "Free-text answer for Question two" }),
  ).toHaveValue("Second answer");
});
test("command reads stop when their view closes and remain observational", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page.getByRole("button", { name: /powershell.*running/ }).click();
  await expect(page.locator(".wb-output pre").first()).toHaveText("hello");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const count = await page.evaluate(() => (window as any).calls.length);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as any).calls.length)).toBe(count);
});
test("retained commands disclose source and do not show live controls", async ({
  page,
}, info) => {
  await setup(page, false, true);
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page.getByRole("button", { name: /powershell.*succeeded/ }).click();
  await expect(page.locator(".wb-output-toolbar")).toContainText("retained");
  await page.screenshot({ path: info.outputPath("commands.png") });
});
test("narrow layout and Settings preserve the composer draft", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await setup(page);
  await page.getByRole("button", { name: "Close execution" }).click();
  await page.locator("#task-input").fill("Preserved draft");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("#task-input")).toHaveValue("Preserved draft");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("narrow.png") });
  await page.setViewportSize({ width: 480, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("compact.png") });
});
