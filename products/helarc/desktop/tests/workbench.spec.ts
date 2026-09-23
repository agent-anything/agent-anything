import { test, expect, type Page } from "@playwright/test";
import { createWorkbenchTestRun } from "../src/shared/testing/HelarcWorkbenchTestFixture.js";

async function setup(
  page: Page,
  pending: boolean | "approval" = false,
  terminal = false,
  childStreaming = false,
  withResult = false,
) {
  const run = createWorkbenchTestRun(terminal ? { status: "completed" } : {});
  await page.addInitScript(
    ({ run, pending, terminal, childStreaming, withResult }) => {
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
          status: childStreaming ? "running" : "completed",
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
      if (pending === "approval") {
        (run.host as any).pendingInteractions = [
          {
            ...request("permission-one", child),
            family: "approval",
            presentation: {
              runId: child,
              category: "commandExecution",
              reason: "Allow this command?",
              payload: {
                commandDisplay: "echo hello",
                additionalPermissions: null,
              },
              decisionOptions: [
                {
                  id: "accept",
                  kind: "accept",
                  label: "Allow once",
                  description: null,
                },
                {
                  id: "decline",
                  kind: "decline",
                  label: "Decline",
                  description: null,
                },
              ],
            },
          },
        ];
      }
      const finalText = "The recorded result is ready.";
      const source = {
        kind: "model_text",
        turnId: "turn",
        modelItemIds: ["answer"],
      };
      const snapshot: any = {
        projects: [{ id: "project", revision: 1, name: "Example project", primaryProfileId: "workspace", additionalProfileIds: [], createdAt: "2026-09-18T08:00:00.000Z", updatedAt: "2026-09-18T08:00:00.000Z" }],
        selectedProjectId: "project",
        status: terminal ? "completed" : "running",
        workspace: {
          id: "workspace",
          name: "Example project",
          path: "D:/example",
        },
        workspaceProfiles: [{ id: "workspace", displayName: "Example project", path: "D:/example", trustState: "trusted", lastOpenedAt: "2026-09-18T08:00:00.000Z" }],
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
          projectId: "project",
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
          artifacts: withResult
            ? [
                {
                  id: "result",
                  title: "Recorded findings",
                  kind: "report",
                  summary: "Workspace findings",
                },
              ]
            : [],
        },
        threadSummaries: [{ id: "thread", projectId: "project", title: "Inspect the workspace", status: "open", workspace: { id: "workspace", name: "Example project", path: "D:/example" }, latestRun: null, createdAt: "2026-09-18T08:00:00.000Z", updatedAt: "2026-09-18T08:00:00.000Z" }],
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
      const command = {
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
      };
      let listener: (value: unknown) => void = () => {};
      (window as any).calls = [];
      (window as any).emitWorkbench = (mutate: string, update?: (value: any) => void) => {
        update?.(snapshot);
        if (mutate === "revision") {
          snapshot.run.product.presentationRevision++;
          snapshot.activeThread.revision++;
        }
        listener(structuredClone(snapshot));
      };
      (window as any).helarc = {
        chooseProjectFolder: async () => {
          const profile = { id: "extra", displayName: "Documentation", path: "D:/docs", trustState: "trusted", lastOpenedAt: "2026-09-18T08:00:00.000Z" };
          if (!snapshot.workspaceProfiles.some((item: any) => item.id === profile.id)) snapshot.workspaceProfiles.push(profile);
          return { status: "handled", result: { profile, snapshot: structuredClone(snapshot), error: null } };
        },
        saveProject: async (query: any) => {
          (window as any).calls.push({ method: "saveProject", query });
          const existing = snapshot.projects.find((item: any) => item.id === query.id);
          const updated = { id: query.id ?? "created-project", revision: (existing?.revision ?? 0) + 1, name: query.name, primaryProfileId: query.primaryProfileId, additionalProfileIds: query.additionalProfileIds, createdAt: "2026-09-18T08:00:00.000Z", updatedAt: "2026-09-18T08:00:00.000Z" };
          snapshot.projects = existing ? snapshot.projects.map((item: any) => item.id === query.id ? updated : item) : [...snapshot.projects, updated];
          return { status: "handled", result: { ok: true, error: null, snapshot: structuredClone(snapshot) } };
        },
        selectProject: async (query: any) => {
          (window as any).calls.push({ method: "selectProject", query });
          snapshot.selectedProjectId = query.projectId;
          const project = snapshot.projects.find((item: any) => item.id === query.projectId);
          const primary = snapshot.workspaceProfiles.find((item: any) => item.id === project.primaryProfileId);
          snapshot.workspace = { id: primary.id, name: primary.displayName, path: primary.path };
          snapshot.activeThread = null; snapshot.run = null; snapshot.acceptedTask = null; snapshot.status = "workspace_selected";
          return { status: "handled", result: structuredClone(snapshot) };
        },
        openThread: async () => ({ status: "handled", result: { ok: true, snapshot: structuredClone(snapshot) } }),
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
        readConversation: async (q: any) => ({
          status: "page",
          threadId: "thread",
          revision: snapshot.activeThread.revision,
          previousCursor: q.position.kind === "latest" ? "older" : null,
          omittedRecords: 0,
          latestPosition: [240, 0],
          entries:
            q.position.kind === "before"
              ? [
                  {
                    id: "older",
                    revision: 1,
                    position: [1, 0],
                    role: "user",
                    kind: "message",
                    content: "Earlier exchange",
                    omittedBytes: 0,
                    sourceId: "older",
                    modelItemIds: [],
                    detail: null,
                    artifactIds: [],
                    productRunId: null,
                    runId: null,
                    disposition: null,
                  },
                ]
              : [
                  {
                    id: "user",
                    revision: 1,
                    position: [239, 0],
                    role: "user",
                    kind: "message",
                    content: snapshot.activeThread.messages[0].content,
                    omittedBytes: 0,
                    sourceId: "user",
                    modelItemIds: [],
                    detail: null,
                    artifactIds: [],
                    productRunId: run.productRunId,
                    runId: root,
                    disposition: null,
                  },
                  {
                    id: "final",
                    revision: 1,
                    position: [240, 0],
                    role: "assistant",
                    kind: "message",
                    content: records[1].content.text,
                    omittedBytes: 0,
                    sourceId: "final",
                    modelItemIds: ["answer"],
                    detail: null,
                    artifactIds: withResult ? ["result"] : [],
                    productRunId: run.productRunId,
                    runId: root,
                    disposition: null,
                  },
                ],
        }),
        readCurrentWork: async (q: any) => ({
          status: "page",
          scope: q,
          live: !terminal,
          revision: 2,
          rootRunId: root,
          workStatus: terminal ? "completed" : "running",
          tasks: [
            {
              runId: root,
              parentRunId: null,
              label: "Main task",
              objective: "Inspect workspace",
              status: terminal ? "completed" : "running",
              terminalCode: null,
              hasPlan: true,
            },
            {
              runId: child,
              parentRunId: root,
              label: "Inspect dependencies",
              objective: "Review declared dependencies",
              status: childStreaming ? "running" : "completed",
              terminalCode: null,
              hasPlan: false,
            },
          ],
          plan: {
            steps: [
              { description: "Inspect sources", status: "completed" },
              { description: "Report findings", status: "in_progress" },
            ],
          },
          activeCalls: [],
          commands: terminal ? [] : [command],
          attention: snapshot.run.host.pendingInteractions.map((r: any) => ({
            runId: r.runId,
            request: r.request,
            phase: r.phase,
          })),
          context: {
            model: "gemma4:e4b",
            provider: "Ollama",
            permissionPreset: "ask_for_approval",
            enforcement: "disabled",
            source: "bound_run",
            effectiveGrants: "not_projected",
          },
          omitted: { tasks: 0, calls: 0, commands: 0 },
          nextCursors: { tasks: null, calls: null, commands: null },
          retainedFinishedCount: 1,
          artifactIds: [],
        }),
        readTaskDetails: async (q: any) => ({
          status: "page",
          scope: q,
          live: !terminal,
          task: {
            runId: q.runId,
            parentRunId: q.runId === root ? null : root,
            label: q.runId === root ? "Main task" : "Inspect dependencies",
            objective: "Review declared dependencies",
            status: childStreaming ? "running" : "completed",
            terminalCode: null,
            hasPlan: false,
          },
          plan: null,
          retries: null,
          artifactIds: [],
          diagnostics: { qualification: "experimental" },
        }),
        readWorkHistory: async (q: any) => ({
          status: "page",
          scope: q,
          collection: q.collection,
          commands:
            q.collection === "commands" && terminal && q.runId === root
              ? [command]
              : [],
          records: q.collection === "operations" ? [records[0]] : [],
          previousCursor: null,
          omittedRecords: 0,
        }),
        readCommandDetails: async () => ({
          status: "page",
          command,
          live: !terminal,
        }),
        readArtifactContent: async (query: any) => {
          (window as any).calls.push({ method: "artifact", query });
          return {
            status: "page",
            text: "# Findings\n\nThe saved result is readable.",
            mediaType: "text/markdown",
            completeness: "complete",
            integrity: {},
            limitations: [],
            projected: false,
            nextCursor: null,
          };
        },
        readResponsePreview: async (q: any) => ({
          status: "page",
          scope: q,
          live: !terminal,
          revision: 0,
          attempts:
            q.runId === child && childStreaming
              ? [
                  {
                    runId: child,
                    requestId: "q",
                    controllerRequestId: "c",
                    invocationId: "child-attempt",
                    revision: 1,
                    state: "receiving",
                    code: null,
                    parts: [
                      {
                        id: "child-part",
                        kind: "text",
                        name: null,
                        text: "Checking delegated dependencies.",
                        offset: 0,
                        nextOffset: null,
                        receivedLength: 32,
                        omittedBytes: 0,
                        modelItemId: null,
                        turnId: null,
                        committedRecordId: null,
                      },
                    ],
                  },
                ]
              : [],
          omittedAttempts: 0,
          nextCursor: null,
        }),
        subscribeResponseProgress: async () => ({
          status: "subscribed",
          dispose: () => {},
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
    { run, pending, terminal, childStreaming, withResult },
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

test("Project navigation and folder editing preserve active work", async ({ page }, info) => {
  await setup(page);
  const navigation = page.getByRole("navigation", { name: "Projects and conversations" });
  await expect(navigation).toBeVisible();
  await expect(navigation).toHaveCSS("display", "flex");
  await expect(page.locator(".project-sidebar")).toHaveCSS("width", "230px");
  await expect(navigation.getByRole("button", { name: "Inspect the workspace", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("button", { name: "New conversation in Example project", exact: true })).toBeDisabled();
  await navigation.getByRole("button", { name: "Edit Example project", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Project settings" });
  await expect(editor).toHaveCSS("border-radius", "8px");
  await expect(editor.locator(".project-folder").first().getByRole("button")).toBeDisabled();
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Application");
  await editor.getByRole("button", { name: "Add folder", exact: true }).click();
  await editor.getByRole("radio", { name: "Primary folder: Documentation", exact: true }).check();
  await expect(editor.locator(".project-folder").first().getByRole("button")).toBeEnabled();
  await expect(editor).toContainText("Current work keeps its folders.");
  await page.screenshot({ path: info.outputPath("project-editor.png") });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(navigation.getByRole("button", { name: "Application", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).calls.find((call: any) => call.method === "saveProject").query)).toMatchObject({ id: "project", expectedRevision: 1, name: "Application", primaryProfileId: "extra", additionalProfileIds: ["workspace"] });
  await expect(page.locator(".wb-workspace")).toHaveAttribute("title", "Current work: D:/example");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle projects" }).click();
  await expect(navigation).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Current work", exact: true })).not.toBeVisible();
  await page.screenshot({ path: info.outputPath("project-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a new Project starts an empty conversation in its selected folder", async ({ page }) => {
  await setup(page, false, true);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New project" });
  await editor.getByRole("button", { name: "Add folder", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Documentation");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator(".wb-title strong")).toHaveText("New conversation");
  await expect(page.locator(".wb-workspace")).toHaveAttribute("title", "Next work: D:/docs");
  await expect.poll(() => page.evaluate(() => (window as any).calls.some((call: any) => call.method === "selectProject" && call.query.projectId === "created-project"))).toBe(true);
  await expect(page.locator(".wb-conversation-scroll").getByText("The recorded result is ready.", { exact: true })).toHaveCount(0);
});

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
test("current work updates automatically and offers Retry only after a read failure", async ({
  page,
}) => {
  await setup(page);
  const work = page.getByRole("complementary", {
    name: "Current work",
    exact: true,
  });
  await expect(work.getByRole("button", { name: "Refresh work" })).toHaveCount(0);
  await expect(
    work.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    (window as any).workReadCount = 0;
    api.readCurrentWork = async (query: any) => {
      (window as any).workReadCount++;
      if ((window as any).failNextWorkRead) {
        (window as any).failNextWorkRead = false;
        throw new Error("Read unavailable");
      }
      const value = await read(query);
      return {
        ...value,
        commands: value.commands.map((command: any) => ({
          ...command,
          command: "echo updated",
        })),
      };
    };
    (window as any).emitWorkbench("revision");
  });
  await expect(work.getByRole("button", { name: /echo updated/ })).toBeVisible();
  await page.evaluate(() => {
    (window as any).failNextWorkRead = true;
    (window as any).emitWorkbench("revision");
  });
  const error = work.getByRole("alert");
  await expect(error).toContainText("Content could not be read.");
  await expect(work.getByRole("button", { name: /echo updated/ })).toBeVisible();
  const reads = await page.evaluate(() => (window as any).workReadCount);
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(error).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).workReadCount)).toBe(
    reads + 1,
  );
  await expect(
    work.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
});
test("overall work status stays in the header rather than the operation list", async ({
  page,
}, info) => {
  await setup(page);
  const work = page.getByRole("complementary", { name: "Current work", exact: true });
  const status = work.locator(".wb-work-heading .wb-status");
  await expect(status).toHaveText("Working");
  await expect(work.getByRole("heading", { name: "Now", exact: true })).toBeVisible();
  await expect(work.getByRole("button", { name: /echo hello/ })).toBeVisible();
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (query: any) => ({
      ...(await read(query)),
      commands: [],
    });
    (window as any).emitWorkbench("revision");
  });
  await expect(work.getByRole("heading", { name: "Now", exact: true })).toHaveCount(0);
  await expect(status).toHaveText("Working");
  await page.screenshot({ path: info.outputPath("work-status-wide.png") });
  await page.setViewportSize({ width: 480, height: 720 });
  await expect(status).toBeVisible();
  expect(await work.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("work-status-narrow.png") });
  await work.getByRole("button", { name: /Inspect dependencies.*Completed/ }).click();
  await expect(status).toHaveCount(0);
  await expect(work.getByRole("heading", { name: "Inspect dependencies" })).toBeVisible();
});
test("Child inspection does not retarget steering", async ({ page }) => {
  await setup(page);
  await page
    .getByRole("button", { name: /Inspect dependencies.*Completed/ })
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
test("request drafts survive collapse and sibling submission", async ({
  page,
}) => {
  await setup(page, true);
  await page.getByRole("button", { name: /Question 2:/ }).click();
  await page
    .getByRole("textbox", { name: "Free-text answer for Question two" })
    .fill("Second answer");
  await page.getByRole("button", { name: "Collapse" }).click();
  await page
    .getByRole("button", { name: "Review / answer", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Free-text answer for Question two" }),
  ).toHaveValue("Second answer");
  await page.getByRole("button", { name: /Question 1:/ }).click();
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

test("Child approval is immediately actionable above the composer", async ({
  page,
}, info) => {
  await setup(page, "approval");
  const attention = page.getByRole("region", { name: "Needs your input" });
  await expect(
    attention.getByRole("button", { name: "Allow once" }),
  ).toBeVisible();
  await expect(
    attention.getByText("echo hello", { exact: true }),
  ).toBeVisible();
  const bounds = await attention.boundingBox();
  const composer = await page.locator(".wb-composer").boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(composer!.y + 1);
  await page.screenshot({ path: info.outputPath("approval.png") });
  await attention.getByRole("button", { name: "Allow once" }).click();
  await expect(attention).toHaveCount(0);
  const submitted = await page.evaluate(
    () => (window as any).calls.find((c: any) => c.method === "submit").query,
  );
  expect(submitted.runId).toBe("harness-run-1");
  expect(submitted.payload).toMatchObject({
    runId: "child-1",
    requestId: "permission-one",
    optionId: "accept",
    pendingVersion: 1,
  });
});

test("reading position and work detail survive refresh, Settings and viewport changes", async ({
  page,
}, info) => {
  await setup(page);
  const scroll = page.locator(".wb-conversation-scroll");
  await expect
    .poll(() =>
      scroll.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight),
    )
    .toBeLessThan(3);
  await scroll.evaluate((e) => (e.scrollTop = 0));
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(
    page.getByText("Earlier exchange", { exact: true }),
  ).toBeVisible();
  const top = await scroll.evaluate((e) => e.scrollTop);
  await page.evaluate(() => (window as any).emitWorkbench("revision"));
  await expect(
    page.getByRole("button", { name: /Latest messages.*new content/ }),
  ).toBeVisible();
  expect(
    Math.abs((await scroll.evaluate((e) => e.scrollTop)) - top),
  ).toBeLessThan(3);
  await page
    .getByRole("button", { name: /Inspect dependencies.*Completed/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Inspect dependencies" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Inspect dependencies" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 900, height: 720 });
  await expect(
    page.getByRole("dialog", { name: "Current work" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Inspect dependencies" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("task-drawer.png") });
  await page.getByRole("button", { name: "Close work" }).click();
  await page.getByRole("button", { name: /Latest messages/ }).click();
  await expect
    .poll(() =>
      scroll.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight),
    )
    .toBeLessThan(3);
  await expect(page.getByText("Earlier exchange", { exact: true })).toHaveCount(
    0,
  );
});
test("command reads stop when their view closes and remain observational", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: /echo hello.*Working/ }).click();
  await expect(page.locator(".wb-output pre").first()).toHaveText("hello");
  await page.getByRole("button", { name: "Back to work", exact: true }).click();
  const count = await page.evaluate(() => (window as any).calls.length);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as any).calls.length)).toBe(count);
});
test("retained commands disclose source and do not show live controls", async ({
  page,
}, info) => {
  await setup(page, false, true);
  await expect(page.getByRole("button", { name: "Stop work" })).toHaveCount(0);
  await page.locator(".wb-finished > summary").click();
  await page.getByRole("button", { name: /echo hello.*succeeded/ }).click();
  await expect(page.locator(".wb-output-toolbar")).toContainText("retained");
  await page.screenshot({ path: info.outputPath("commands.png") });
});
test("narrow layout and Settings preserve the composer draft", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await setup(page);

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

test("Child response previews stay in task detail, not root conversation", async ({
  page,
}) => {
  await setup(page, false, false, true);
  await expect(
    page
      .locator(".wb-conversation")
      .getByText("Checking delegated dependencies."),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: /Inspect dependencies.*Working/ })
    .click();
  await expect(
    page
      .locator(".wb-task-detail")
      .getByText("Checking delegated dependencies.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".wb-conversation")
      .getByText("Checking delegated dependencies."),
  ).toHaveCount(0);
});

test("finished replies expose retained results without inventing Plan completion", async ({
  page,
}) => {
  await setup(page, false, true, false, true);
  const result = page.locator(".wb-message-assistant .wb-results");
  await result.getByText("Recorded findings", { exact: true }).click();
  await result
    .getByRole("button", { name: "View result", exact: true })
    .click();
  await expect(
    result.getByRole("heading", { name: "Findings", exact: true }),
  ).toBeVisible();
  const plan = page.locator(".wb-conversation-plan");
  await expect(plan.locator("summary")).toContainText("1/2");
  await plan.locator("summary").click();
  await expect(
    plan.locator("li.in_progress").filter({ hasText: "Report findings" }),
  ).toBeVisible();
  await expect(page.locator(".wb-finished")).not.toHaveAttribute("open");
  expect(await page.evaluate(() => (window as any).calls)).toEqual([
    {
      method: "artifact",
      query: { threadId: "thread", artifactId: "result", cursor: null },
    },
  ]);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(plan).toHaveCount(0);
});

test("conversation Plan expands and updates independently of selected task details", async ({ page }, info) => {
  await setup(page);
  const plan = page.locator(".wb-conversation > .wb-conversation-plan");
  const summary = plan.locator("summary");
  const work = page.getByRole("complementary", { name: "Current work", exact: true });
  await expect(summary).toContainText("Plan");
  await expect(summary).toContainText("1/2");
  await expect(summary).toContainText("Report findings");
  await expect(plan).not.toHaveAttribute("open");
  await expect(work.locator(".wb-plan")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("plan-collapsed.png") });
  await summary.click();
  await expect(plan.locator("li")).toHaveCount(2);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (q: any) => ({
      ...(await read(q)),
      plan: { steps: [
        { description: "Inspect sources", status: "completed" },
        { description: "Check recorded findings", status: "in_progress" },
      ] },
    });
    const detail = api.readTaskDetails;
    api.readTaskDetails = async (q: any) => ({
      ...(await detail(q)),
      plan: { steps: [{ description: "Child investigation", status: "in_progress" }] },
    });
    (window as any).emitWorkbench("host", (snapshot: any) => snapshot.run.host.runRevision++);
  });
  await expect(summary).toContainText("Check recorded findings");
  await expect(plan).toHaveAttribute("open", "");
  await page.getByRole("button", { name: /Inspect dependencies.*Completed/ }).click();
  await expect(work.locator(".wb-plan")).toContainText("Child investigation");
  await expect(plan).not.toContainText("Child investigation");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(plan).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Close work" }).click();
  await expect(plan).toBeVisible();
});

test("conversation Plan clears on absent plans and resets expansion for new work", async ({ page }) => {
  await setup(page);
  const plan = page.locator(".wb-conversation-plan");
  await plan.locator("summary").click();
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (q: any) => ({
      ...(await read(q)),
      plan: q.productRunId.endsWith("-empty") ? null : {
        steps: [{ description: "New task step", status: "pending" }],
      },
    });
    (window as any).emitWorkbench("revision", (snapshot: any) => {
      snapshot.run.productRunId += "-next";
      snapshot.run.harnessRunId += "-next";
      snapshot.run.host.runId = snapshot.run.harnessRunId;
    });
  });
  await expect(plan).toContainText("New task step");
  await expect(plan).not.toHaveAttribute("open");
  await expect(plan.locator("summary")).toContainText("0/1");
  await page.evaluate(() => {
    (window as any).emitWorkbench("revision", (snapshot: any) => {
      snapshot.run.productRunId += "-empty";
      snapshot.run.harnessRunId += "-empty";
      snapshot.run.host.runId = snapshot.run.harnessRunId;
    });
  });
  await expect(plan).toHaveCount(0);
});

test("expanded Plan stays bounded with approvals on wide and narrow layouts", async ({ page }, info) => {
  await setup(page, "approval");
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (q: any) => ({
      ...(await read(q)),
      plan: { steps: Array.from({ length: 20 }, (_, i) => ({
        description: `${i + 1}. ${"Long plan step text ".repeat(8)}`,
        status: i === 0 ? "in_progress" : "pending",
      })) },
    });
    (window as any).emitWorkbench("revision");
  });
  const plan = page.locator(".wb-conversation-plan");
  await expect(plan.locator("summary")).toContainText("0/20");
  await plan.locator("summary").click();
  await expect(plan.locator("li")).toHaveCount(20);
  await expect(plan.locator(".wb-plan-steps")).toHaveCSS("overflow-y", "auto");
  for (const [width, height] of [[1440, 900], [480, 720]]) {
    await page.setViewportSize({ width: width!, height: height! });
    if (width === 480) await page.getByRole("button", { name: "Close work" }).click();
    await expect(plan).toBeVisible();
    const bounds = await plan.boundingBox();
    const attention = await page.getByRole("region", { name: "Needs your input" }).boundingBox();
    const composer = await page.locator(".wb-composer").boundingBox();
    const latest = await page.locator(".wb-latest").boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(220);
    expect(latest!.y + latest!.height).toBeLessThanOrEqual(bounds!.y);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(attention!.y + 1);
    expect(attention!.y + attention!.height).toBeLessThanOrEqual(composer!.y + 1);
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(height! + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`plan-expanded-${width}.png`) });
  }
});

test("nested delegated tasks retain ancestry without changing root controls", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (query: any) => {
      const work = await read(query);
      return {
        ...work,
        tasks: [
          ...work.tasks,
          {
            ...work.tasks[1],
            runId: "grandchild",
            parentRunId: "child-1",
            label: "Check package metadata",
          },
        ],
      };
    };
    (window as any).emitWorkbench("revision");
  });
  const branch = page.locator(".wb-task-branches").first();
  await expect(
    branch.getByRole("button", { name: /Check package metadata/ }),
  ).toBeVisible();
  await branch.getByRole("button", { name: /Check package metadata/ }).click();
  await page.locator("#task-input").fill("Continue the main objective");
  await page
    .getByRole("button", { name: "Send guidance", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        (window as any).calls.find((c: any) => c.method === "steer").query
          .runId,
    ),
  ).toBe("harness-run-1");
});
