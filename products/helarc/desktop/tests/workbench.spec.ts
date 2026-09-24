import { test, expect, type Page } from "@playwright/test";
import type { PlanProjection } from "@agent-anything/agent-runtime/plan";
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
            title: "Bash command: echo hello",
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
          activity: { current: [], recent: [], omittedCurrent: 0, omittedRecent: 0 },
          tasks: [
            {
              runId: root,
              parentRunId: null,
              label: "Main task",
              objective: "Inspect workspace",
              status: terminal ? "completed" : "running",
              terminalCode: null,
              hasPlan: true,
              hasFinishedWork: true,
            },
            {
              runId: child,
              parentRunId: root,
              label: "Inspect dependencies",
              objective: "Review declared dependencies",
              status: childStreaming ? "running" : "completed",
              terminalCode: null,
              hasPlan: false,
              hasFinishedWork: false,
            },
          ],
          plan: {
            id: "plan-root",
            version: 1,
            status: "active",
            steps: [
              { step: "Inspect sources", status: "completed" },
              { step: "Report findings", status: "in_progress" },
            ],
          } satisfies PlanProjection,
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
            hasFinishedWork: false,
          },
          plan: null,
          artifactIds: [],
          problem: null,
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

async function installActivity(page: Page, expanded = true) {
  await page.evaluate(async () => {
    const w = window as any, api = w.helarc, original = api.readCurrentWork;
    const snapshot = await api.getSnapshot(), root = snapshot.run.harnessRunId;
    const common = { runId: root, attribution: null, state: "ongoing", startedAt: null, endedAt: null };
    const command = { ...common, id: "command:one", kind: "command", title: "dotnet build", status: "Running",
      startedAt: new Date(Date.now() - 18000).toISOString(), detail: { kind: "command", executionId: "exec-one" } };
    w.activityFixture = {
      current: [command,
        { ...common, id: "read:one", kind: "operation", title: "Read file: src/Program.cs", status: "Result pending",
          detail: { kind: "operation", itemId: "read-one" } },
        { ...common, id: "response:one", runId: "child-1", kind: "response", title: "Waiting for model response",
          attribution: "Inspect project configuration", status: "", detail: null }],
      recent: [], omittedCurrent: 0, omittedRecent: 0,
    };
    api.readCurrentWork = async (q: any) => {
      if (w.activityReadFailure) throw Error("offline");
      const page = await original(q);
      return { ...page, revision: (await api.getSnapshot()).activeThread.revision, activity: structuredClone(w.activityFixture) };
    };
    api.readCommandDetails = async (q: any) => ({ status: "page", live: true, command: {
      ...q, command: "dotnet build --no-restore", shell: "PowerShell", cwd: "D:/example", phase: "running",
    } });
    api.readCommandOutput = async (q: any) => {
      w.calls.push({ method: "output", query: q });
      const tick = Number(q.cursor ?? 0);
      return { status: "page", source: "live", settled: !!w.outputSettled, nextCursor: String(tick + 1), hasMore: false,
        stdout: { text: tick === 0 ? "Determining projects to restore...\n" : tick === 1 ? "Build continues...\n" : "",
          integrity: "exact", encoding: "utf-8", omittedBytes: 0, replacementCount: 0 },
        stderr: { text: "", integrity: "exact", encoding: "utf-8", omittedBytes: 0, replacementCount: 0 },
      };
    };
    api.readWorkbenchItem = async (q: any) => {
      w.calls.push({ method: "detail", query: q });
      return { status: "operation", itemId: q.itemId, detail: { title: "Read file", summary: "src/Program.cs",
        status: "Returned", child: null, facts: [], sections: [
          { id: "output", label: "Output", format: "text", text: 'Console.WriteLine("Hello");', nextOffset: null },
        ] } };
    };
    w.emitWorkbench("revision");
  });
  if (expanded) await page.getByRole("button", { name: "Expand activity", exact: true }).click();
}

test("activity starts collapsed, follows new facts and keeps disclosure stable until new work", async ({ page }, info) => {
  await setup(page);
  await page.getByRole("button", { name: "Close work", exact: true }).click();
  await installActivity(page, false);
  const activity = page.getByRole("region", { name: "Current activity", exact: true });
  const expand = activity.getByRole("button", { name: "Expand activity", exact: true });
  const summary = activity.locator(".wb-activity-summary");
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(activity.locator(".wb-activity-row")).toHaveCount(1);
  await expect(activity.locator(".wb-activity-content")).toHaveCount(0);
  await expect(activity.locator(".wb-activity-progress-pulse")).toHaveCount(1);
  await expect(activity.locator(".wb-activity-progress-pulse")).toHaveCSS("animation-name", "wb-activity-text-pulse");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(activity.locator(".wb-activity-progress-pulse")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => ["output", "detail"].includes(c.method)))).toEqual([]);
  await page.evaluate(() => {
    const w = window as any;
    w.activityFixture.current[2].title = "Receiving model response";
    w.emitWorkbench("revision");
  });
  await expect(summary).toContainText("Receiving model response");
  await page.evaluate(() => (window as any).emitWorkbench("revision"));
  await expect(summary).toContainText("Receiving model response");
  expect(await expand.evaluate(button => {
    const body = button.previousElementSibling!.getBoundingClientRect();
    const control = button.getBoundingClientRect();
    return Math.abs(body.right - control.left) < 1 && Math.abs(body.height - control.height) < 1;
  })).toBe(true);
  expect((await activity.boundingBox())!.height).toBeLessThanOrEqual(44);
  await page.screenshot({ path: info.outputPath("activity-collapsed-wide.png") });
  await page.setViewportSize({ width: 480, height: 720 });
  await expect(expand).toBeVisible();
  expect(await activity.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("activity-collapsed-narrow.png") });
  await expand.click();
  const collapse = activity.getByRole("button", { name: "Collapse activity", exact: true });
  await expect(summary).toHaveCount(0);
  await expect(activity.locator(".wb-activity-row")).toHaveCount(3);
  await expect(activity.locator(".wb-activity-progress-pulse")).toHaveCount(0);
  await expect(activity).toContainText("Determining projects to restore...");
  await page.evaluate(() => (window as any).emitWorkbench("revision"));
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(activity.locator(".wb-activity-row")).toHaveCount(1);
  await expect(activity.locator(".wb-activity-progress-pulse")).toHaveCount(1);
  await expect(activity.locator(".wb-output")).toHaveCount(0);
  await expand.click();
  await page.evaluate(() => (window as any).emitWorkbench("revision", (s: any) => {
    s.run.productRunId = "next-work";
  }));
  await expect(expand).toHaveAttribute("aria-expanded", "false");
});

test("request duration is continuous while command duration starts displaying at five seconds", async ({ page }, info) => {
  await page.clock.install({ time: new Date("2026-09-24T08:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-24T08:00:01Z"));
  await setup(page);
  await installActivity(page);
  await page.evaluate(() => {
    const w = window as any;
    w.activityFixture.current[0].startedAt = new Date().toISOString();
    w.emitWorkbench("revision", (s: any) => {
      s.threadSummaries[0].latestRun = { runId: s.run.productRunId, status: "inactive",
        startedAt: new Date().toISOString(), completedAt: null };
    });
  });
  const total = page.getByLabel("Request elapsed time", { exact: true });
  const commandTime = page.getByRole("region", { name: "Current activity", exact: true })
    .locator(".wb-activity-item").first().locator(".wb-activity-state small");
  await expect(total).toHaveText("0s");
  await expect(commandTime).toHaveCount(0);
  await page.clock.runFor(4000);
  await expect(total).toHaveText("4s");
  await expect(commandTime).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect(total).toHaveText("5s");
  await expect(commandTime).toHaveText("5s");
  await page.evaluate(() => (window as any).emitWorkbench("revision", (s: any) => {
    s.run.display.status = "waiting_for_approval";
  }));
  await page.clock.runFor(2000);
  await expect(total).toHaveText("7s");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Additional guidance");
  await page.getByRole("button", { name: "Send guidance", exact: true }).click();
  await expect(total).toHaveText("7s");
  await page.evaluate(() => (window as any).emitWorkbench("revision", (s: any) => {
    s.run.display = { status: "completed", terminal: true, statusSource: "host" };
    s.run.host.terminal = { status: "completed", code: "completion_accepted", completedAt: new Date().toISOString() };
    s.threadSummaries[0].latestRun.completedAt = new Date().toISOString();
    const a = (window as any).activityFixture;
    a.recent = [{ ...a.current[0], state: "settled", status: "Exited with code 0", endedAt: new Date().toISOString() }];
    a.current = [];
  }));
  await page.clock.runFor(3000);
  await expect(total).toHaveText("7s");
  await expect(commandTime).toHaveText("7s");
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(total).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("request-duration.png") });
  await page.evaluate(() => (window as any).emitWorkbench("history", (s: any) => { s.run = null; }));
  await expect(total).toHaveText("7s");
  await page.evaluate(() => (window as any).emitWorkbench("history", (s: any) => {
    s.threadSummaries[0].latestRun.completedAt = null;
  }));
  await expect(total).toHaveCount(0);
  await expect(page.getByText("Duration unavailable", { exact: true })).toBeVisible();
});

test("request duration starts during submission and binds to the accepted work", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-24T08:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-24T08:00:01Z"));
  await setup(page, false, true);
  await page.evaluate(() => {
    const w = window as any;
    w.helarc.startRun = () => new Promise(resolve => {
      const startedAt = new Date().toISOString();
      w.acceptSubmission = async () => {
        w.emitWorkbench("revision", (s: any) => {
          s.run.productRunId = "new-work"; s.run.host.terminal = null;
          s.run.display = { status: "running", terminal: false, statusSource: "host" };
          s.threadSummaries[0].latestRun = { runId: "new-work", status: "inactive", startedAt, completedAt: null };
        });
        resolve({ status: "handled", result: { ok: true, snapshot: await w.helarc.getSnapshot() } });
      };
    });
  });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Next task");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const total = page.getByLabel("Request elapsed time", { exact: true });
  await expect(total).toHaveText("0s");
  await page.clock.runFor(2000);
  await expect(total).toHaveText("2s");
  await page.evaluate(() => (window as any).acceptSubmission());
  await expect(total).toHaveText("2s");
  await page.clock.runFor(1000);
  await expect(total).toHaveText("3s");
});

test("conversation activity shows concrete parallel work and live output independently of the right panel", async ({ page }, info) => {
  await setup(page);
  await page.getByRole("button", { name: "Close work", exact: true }).click();
  await installActivity(page);
  const activity = page.getByRole("region", { name: "Current activity", exact: true });
  await expect(activity.locator(".wb-activity-body")).toHaveCSS("overflow-y", "auto");
  await expect(activity.locator(".wb-activity-row").first()).toHaveCSS("display", "flex");
  await expect(activity.locator(".lucide-loader-circle")).toHaveCount(0);
  await expect(activity.locator(".wb-activity-progress-text").first()).toHaveCSS("font-weight", "500");
  await expect(activity.locator(".wb-activity-progress-text").first()).toHaveCSS("animation-name", "none");
  async function checkAlignment() {
    const positions = await activity.locator(".wb-activity-row").evaluateAll(rows => rows.map(row => ({
      title: row.querySelector(".wb-activity-description")!.getBoundingClientRect().left,
      status: row.querySelector(".wb-activity-state")!.getBoundingClientRect().right,
    })));
    expect(positions.length).toBeGreaterThan(1);
    expect(Math.max(...positions.map(p => p.title)) - Math.min(...positions.map(p => p.title))).toBeLessThan(1);
    expect(Math.max(...positions.map(p => p.status)) - Math.min(...positions.map(p => p.status))).toBeLessThan(1);
  }
  await checkAlignment();
  await expect(activity).toContainText("dotnet build");
  await expect(activity).toContainText("Inspect project configuration");
  await expect(activity).toContainText("Determining projects to restore...");
  await expect(activity).toContainText("Build continues...");
  await page.screenshot({ path: info.outputPath("conversation-activity-default.png") });
  await activity.getByRole("button", { name: /Read file: src\/Program.cs/ }).click();
  await expect(activity).toContainText('Console.WriteLine("Hello");');
  await expect(page.getByRole("complementary", { name: "Current work" })).not.toBeVisible();
  await activity.getByText("Command and working directory", { exact: true }).click();
  await expect(activity).toContainText("dotnet build --no-restore");
  await expect(activity).toContainText("D:/example");
  await activity.getByRole("button", { name: "Expand output" }).click();
  await expect(activity.locator(".wb-output")).toHaveClass(/is-expanded/);
  const collapse = activity.getByRole("button", { name: "Collapse activity", exact: true });
  const toggleBeforeScroll = await collapse.boundingBox();
  await activity.locator(".wb-activity-body").evaluate(body => { body.scrollTop = body.scrollHeight; });
  expect(await collapse.boundingBox()).toEqual(toggleBeforeScroll);
  await page.screenshot({ path: info.outputPath("conversation-activity-wide.png") });
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(activity).toBeVisible();
  await checkAlignment();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(activity.locator(".wb-activity-progress-text").first()).toHaveCSS("animation-name", "none");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("conversation-activity-narrow.png") });
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => ["steer", "submit", "cancel"].includes(c.method)))).toEqual([]);
});

test("conversation activity keeps opened results readable through settlement and handles read errors locally", async ({ page }) => {
  await setup(page);
  await installActivity(page);
  const activity = page.getByRole("region", { name: "Current activity", exact: true });
  await activity.getByRole("button", { name: /Read file: src\/Program.cs/ }).click();
  await expect(activity).toContainText('Console.WriteLine("Hello");');
  await page.evaluate(() => {
    const w = window as any, a = w.activityFixture;
    a.recent = a.current.slice(0, 2).map((item: any) => ({ ...item, state: "settled",
      status: item.kind === "command" ? "Exited with code 0" : "Returned", endedAt: new Date().toISOString() }));
    a.current = [];
    w.outputSettled = true;
    w.emitWorkbench("revision");
  });
  await expect(activity).toContainText("Exited with code 0");
  await expect(activity).toContainText("Returned");
  await expect(activity.locator(".wb-activity-progress-text")).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.activityFixture.recent = [];
    w.emitWorkbench("revision");
  });
  await expect(activity).toContainText("Retained detail");
  await expect(activity).toContainText('Console.WriteLine("Hello");');
  await page.evaluate(() => { (window as any).activityReadFailure = true; (window as any).emitWorkbench("revision"); });
  await expect(activity).toContainText("Activity could not be updated.");
  await page.evaluate(() => { (window as any).activityReadFailure = false; });
  await activity.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(activity).not.toContainText("Activity could not be updated.");
  await activity.getByRole("button", { name: /Read file: src\/Program.cs/ }).click();
  await expect(activity).toHaveCount(0);
});

test("conversation activity isolates concurrent command output and discards detail selection on new work", async ({ page }) => {
  await setup(page);
  await installActivity(page);
  await page.evaluate(() => {
    const w = window as any, a = w.activityFixture;
    a.current.push({ ...a.current[0], id: "command:two", runId: "child-1", title: "echo child-output",
      attribution: "Inspect dependencies", detail: { kind: "command", executionId: "exec-two" } });
    const original = w.helarc.readCommandOutput;
    w.helarc.readCommandOutput = async (q: any) => {
      const result = await original(q);
      return q.executionId === "exec-two" ? { ...result, stdout: { ...result.stdout, text: q.cursor ? "" : "CHILD ONLY\n" } } : result;
    };
    w.emitWorkbench("revision");
  });
  const activity = page.getByRole("region", { name: "Current activity", exact: true });
  await activity.getByRole("button", { name: "1 more activities" }).click();
  await activity.getByRole("button", { name: /echo child-output/ }).click();
  const commands = activity.locator(".wb-activity-item").filter({ has: page.locator(".wb-output") });
  await expect(commands).toHaveCount(2);
  await expect(commands.nth(0)).not.toContainText("CHILD ONLY");
  await expect(commands.nth(1)).toContainText("CHILD ONLY");
  await page.evaluate(() => (window as any).emitWorkbench("revision", (s: any) => {
    s.run.productRunId = "next-work";
    (window as any).activityFixture = { current: [], recent: [], omittedCurrent: 0, omittedRecent: 0 };
  }));
  await expect(activity).toHaveCount(0);
});

test("operation details show delegated work and replies instead of protocol records", async ({ page }, info) => {
  await setup(page);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const original = api.readCurrentWork;
    api.readCurrentWork = async (q: any) => {
      const value = await original(q);
      return { ...value, activeCalls: [{ id: "delegation", runId: value.rootRunId, revision: 2,
        content: { kind: "tool_call", name: "Agent_6e06f4afa928", title: "Delegated task: Inspect dependencies",
          input: { description: "Inspect dependencies" }, invocationId: null, settlement: null } }] };
    };
    api.readWorkbenchItem = async (q: any) => {
      (window as any).calls.push({ method: "work-detail", query: q });
      return { status: "operation", itemId: q.itemId, detail: {
        title: "Delegated task", summary: "Inspect dependencies", status: "Returned",
        child: { runId: "child-1", label: "Inspect dependencies", status: "completed" },
        facts: [{ label: "Reported effects", value: "none" }],
        sections: [{ id: "reply", label: "Subtask findings", format: "markdown",
          text: q.section ? "Remaining findings." : "## Findings\n\nNo edits were made. Dependencies were reviewed.",
          nextOffset: q.section ? null : 50 }],
      } };
    };
    (window as any).emitWorkbench("revision");
  });
  const work = page.getByRole("complementary", { name: "Current work" });
  await work.getByRole("button", { name: /Delegated task: Inspect dependencies/ }).click();
  await expect(work.getByRole("heading", { name: "Delegated task", exact: true })).toBeVisible();
  await expect(work.getByRole("region", { name: "Task instructions" })).toHaveCount(0);
  await expect(work.getByRole("region", { name: "Subtask findings" })).toContainText("No edits were made.");
  await expect(work).not.toContainText("Agent_6e06f4afa928");
  await expect(work).not.toContainText('"runId"');
  await work.getByRole("button", { name: "Next content page" }).click();
  await expect(work.getByRole("region", { name: "Subtask findings" })).toContainText("Remaining findings.");
  await work.getByRole("button", { name: "Back to beginning" }).click();
  await page.screenshot({ path: info.outputPath("delegated-operation.png") });
  await page.setViewportSize({ width: 800, height: 750 });
  await expect(work.getByRole("heading", { name: "Delegated task", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("delegated-operation-compact.png") });
  await work.getByRole("button", { name: "Inspect dependencies completed", exact: true }).click();
  await expect(work.getByRole("heading", { name: "Inspect dependencies", exact: true })).toBeVisible();
});

test("task details present attributed work without internal instructions or diagnostics", async ({ page }, info) => {
  await setup(page, false, false, true);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const detail = api.readTaskDetails;
    api.readTaskDetails = async (q: any) => {
      const result = await detail(q);
      return { ...result,
        task: { ...result.task, objective: null, status: (window as any).detailFailed ? "failed" : "running" },
        problem: (window as any).detailFailed ? { message: "The model request timed out.", code: "provider_timeout" } : null,
        plan: { steps: [{ step: "Check the dependency list", status: "in_progress" }] },
      };
    };
    const history = api.readWorkHistory;
    api.readWorkHistory = async (q: any) => {
      const value = await history(q);
      if (q.runId !== "child-1") return value;
      if (q.collection === "operations") return { ...value, records: [{ id: "child-read", runId: q.runId,
        content: { kind: "tool_call", title: "Read file: package.json", settlement: "succeeded" } }] };
      if (q.collection !== "assistant") return value;
      return { ...value, records: [{ id: "child-findings", runId: q.runId,
        content: { kind: "assistant_text", text: "The dependency list is available; compatibility is not yet checked.", omittedBytes: 0 } }] };
    };
    (window as any).emitWorkbench("revision");
  });
  const work = page.getByRole("complementary", { name: "Current work" });
  await work.getByRole("button", { name: /Inspect dependencies.*Working/ }).click();
  const detail = work.locator(".wb-task-detail");
  await expect(detail.getByRole("heading", { name: "Inspect dependencies", exact: true })).toBeVisible();
  await expect(detail).toContainText("Check the dependency list");
  const findings = detail.getByRole("region", { name: "Subtask findings and updates" });
  await expect(findings).toContainText("compatibility is not yet checked");
  await expect(findings).toContainText("Checking delegated dependencies.");
  await expect(detail.getByText("Technical details", { exact: true })).toHaveCount(0);
  await expect(detail.getByText("Earlier commands", { exact: true })).toHaveCount(0);
  await expect(detail.getByText("Request", { exact: true })).toHaveCount(0);
  await expect(detail).not.toContainText("child-1");
  await expect(detail).not.toContainText("experimental");
  await expect(page.locator(".wb-conversation")).not.toContainText("compatibility is not yet checked");
  const earlier = detail.locator("details").filter({ has: page.locator("summary", { hasText: "Earlier operations" }) });
  await expect(earlier).not.toHaveAttribute("open", "");
  await earlier.locator("summary").click();
  await expect(earlier.getByRole("button", { name: /Read file/ })).toBeVisible();
  await earlier.locator("summary").click();
  await page.screenshot({ path: info.outputPath("task-work-detail.png") });

  await page.evaluate(() => { (window as any).detailFailed = true; (window as any).emitWorkbench("revision"); });
  await expect(detail.getByRole("region", { name: "Problem" })).toContainText("The model request timed out.");
  await expect(findings).toContainText("compatibility is not yet checked");
  await detail.getByText("Reference code", { exact: true }).click();
  await expect(detail).toContainText("provider_timeout");
  await page.setViewportSize({ width: 800, height: 750 });
  await page.screenshot({ path: info.outputPath("task-work-detail-compact.png") });
});

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

test("Project splitter resizes, retains width and preserves the compact drawer", async ({ page }, info) => {
  await setup(page);
  const sidebar = page.locator(".project-sidebar");
  const splitter = page.getByRole("separator", { name: "Resize projects panel" });
  await page.locator("#task-input").fill("Keep this draft");
  const bounds = (await splitter.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + 180, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(300);
  await splitter.focus();
  const draggedWidth = (await sidebar.boundingBox())!.width;
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(draggedWidth);
  const width = (await sidebar.boundingBox())!.width;
  await page.getByRole("button", { name: "Toggle projects" }).click();
  await expect(splitter).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle projects" }).click();
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - width)).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("projects-resized.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(splitter).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle projects" }).click();
  await expect(page.getByRole("dialog", { name: "Projects", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close projects", exact: true }).click();
  await expect(page.locator("#task-input")).toHaveValue("Keep this draft");
  await expect(page.getByRole("status", { name: "Conversation status" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("conversation-header-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - width)).toBeLessThan(2);
  await page.reload();
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - width)).toBeLessThan(2);
  await page.setViewportSize({ width: 1100, height: 900 });
  expect((await page.locator(".wb-conversation").boundingBox())!.width).toBeGreaterThanOrEqual(519);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - 230)).toBeLessThan(2);
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
  await expect(page.getByRole("status", { name: "Conversation status" })).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: "New conversation", exact: true })).toHaveCount(0);
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
test("ongoing work uses the conversation spinner instead of generic Working headings", async ({
  page,
}, info) => {
  await setup(page);
  const work = page.getByRole("complementary", { name: "Current work", exact: true });
  const conversationStatus = page.getByRole("status", { name: "Conversation status" });
  const conversation = page.getByRole("navigation", { name: "Projects and conversations" })
    .getByRole("button", { name: "Inspect the workspace", exact: true });
  const spinner = conversation.locator(".project-conversation-spinner");
  await expect(conversation).toHaveAttribute("aria-busy", "true");
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveCSS("animation-name", "project-conversation-spin");
  await expect(conversationStatus).toHaveCount(0);
  await expect(page.locator(".wb-composer .wb-status")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle work" }).click();
  await expect(spinner).toBeVisible();
  await page.getByRole("button", { name: "Toggle work" }).click();
  const status = work.locator(".wb-work-heading .wb-status");
  await expect(status).toHaveCount(0);
  await expect(work.getByRole("heading", { name: "Now", exact: true })).toHaveCount(0);
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
  await expect(spinner).toBeVisible();
  await page.screenshot({ path: info.outputPath("work-status-wide.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(spinner).toHaveCSS("animation-name", "none");
  await page.setViewportSize({ width: 480, height: 720 });
  await expect(status).toHaveCount(0);
  expect(await work.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("work-status-narrow.png") });
  await work.locator(".wb-finished > summary").click();
  await work.getByRole("button", { name: /Inspect dependencies.*Completed/ }).click();
  await expect(status).toHaveCount(0);
  await expect(work.getByRole("heading", { name: "Inspect dependencies" })).toBeVisible();
});

test("conversation spinner follows live work, not retained history or waits", async ({ page }) => {
  await setup(page);
  const spinner = page.locator(".project-conversation-spinner");
  const status = page.getByRole("status", { name: "Conversation status" });
  await page.evaluate(() => (window as any).emitWorkbench("revision", (snapshot: any) => {
    snapshot.threadSummaries.push({ ...snapshot.threadSummaries[0], id: "other-thread", title: "Other conversation" });
  }));
  await expect(spinner).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Other conversation", exact: true })).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => (window as any).emitWorkbench("revision", (snapshot: any) => {
    snapshot.run.display.status = "waiting_for_approval";
  }));
  await expect(spinner).toHaveCount(0);
  await expect(status).toHaveText("Approval needed");
  await page.evaluate(() => (window as any).emitWorkbench("revision", (snapshot: any) => {
    snapshot.run.display.status = "running";
  }));
  await expect(spinner).toHaveCount(1);
  await expect(status).toHaveCount(0);
  await page.evaluate(() => (window as any).emitWorkbench("revision", (snapshot: any) => {
    snapshot.run.display.status = "completed";
    snapshot.run.display.terminal = true;
  }));
  await expect(spinner).toHaveCount(0);
  await expect(status).toHaveText("Completed");
});
test("Child inspection does not retarget steering", async ({ page }) => {
  await setup(page);
  await page.locator(".wb-finished > summary").click();
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
test("answered questions remain in the conversation without execution rows", async ({ page }, info) => {
  await setup(page, true);
  const attention = page.getByRole("region", { name: "Needs your input" });
  await expect(attention.getByRole("textbox", { name: "Free-text answer for Question one" })).toBeVisible();
  await expect(page.locator(".wb-conversation-activity")).toHaveCount(0);
  await attention.getByRole("textbox", { name: "Free-text answer for Question one" }).fill("Include spaces <and tabs>");
  await attention.getByRole("button", { name: "Submit", exact: true }).first().click();
  await expect(page.locator(".wb-interaction-text")).toHaveCount(0);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readConversation;
    api.readConversation = async (query: any) => {
      const value = await read(query);
      return { ...value, entries: [...value.entries, {
        id: "interaction:question-one", title: "Question", revision: 3, position: [1, 501],
        role: "product", kind: "interaction", content: "From: Main task\n\nQuestion one\nYour answer:\nInclude spaces <and tabs>",
        omittedBytes: 0, productRunId: "product-run-1", runId: "harness-run-1", sourceId: "question-one",
        modelItemIds: [], detail: null, artifactIds: [], disposition: "Answered",
      }] };
    };
    (window as any).emitWorkbench("revision");
  });
  const exchange = page.locator(".wb-message").filter({ has: page.locator(".wb-interaction-text") });
  await expect(exchange).toContainText("Answered");
  await expect(exchange).toContainText("Include spaces <and tabs>");
  await expect(exchange).toHaveCount(1);
  await expect(exchange.locator("and")).toHaveCount(0);
  await expect(attention.getByRole("textbox", { name: "Free-text answer for Question two" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("question-conversation-wide.png") });
  await page.setViewportSize({ width: 480, height: 720 });
  await page.getByRole("button", { name: "Close work" }).click();
  await exchange.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("question-conversation-narrow.png") });
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
  await page.locator(".wb-finished > summary").click();
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
  await expect(plan.locator(".wb-plan-summary")).toContainText("1/2");
  await plan.getByRole("button", { name: "Expand Plan", exact: true }).click();
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
  await page.getByRole("button", { name: "New conversation in Example project", exact: true }).click();
  await expect(plan).toHaveCount(0);
});

test("conversation Plan expands and updates independently of selected task details", async ({ page }, info) => {
  await setup(page);
  const plan = page.locator(".wb-conversation > .wb-conversation-plan");
  const summary = plan.locator(".wb-plan-summary");
  const toggle = plan.getByRole("button");
  const work = page.getByRole("complementary", { name: "Current work", exact: true });
  await expect(summary).toContainText("Plan");
  await expect(summary).toContainText("1/2");
  await expect(summary).toContainText("Report findings");
  await expect(plan).toHaveCSS("background-color", "rgb(245, 247, 248)");
  const summaryBox = await summary.boundingBox();
  const headingBox = await plan.locator(".wb-plan-heading").boundingBox();
  const currentBox = await plan.locator(".wb-plan-current").boundingBox();
  expect(Math.abs(
    headingBox!.x + headingBox!.width / 2 - summaryBox!.x - summaryBox!.width / 2,
  )).toBeLessThan(1);
  expect(currentBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(plan.locator(".wb-plan-steps")).not.toBeVisible();
  await expect(work.locator(".wb-plan")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("plan-collapsed.png") });
  await toggle.click();
  await expect(plan.locator("li")).toHaveCount(2);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (q: any) => ({
      ...(await read(q)),
      plan: { steps: [
        { step: "Inspect sources", status: "completed" },
        { step: "Check recorded findings", status: "in_progress" },
      ] },
    });
    const detail = api.readTaskDetails;
    api.readTaskDetails = async (q: any) => ({
      ...(await detail(q)),
      plan: { steps: [{ step: "Child investigation", status: "in_progress" }] },
    });
    (window as any).emitWorkbench("host", (snapshot: any) => snapshot.run.host.runRevision++);
  });
  await expect(summary).toContainText("Check recorded findings");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await work.locator(".wb-finished > summary").click();
  await page.getByRole("button", { name: /Inspect dependencies.*Completed/ }).click();
  await expect(work.locator(".wb-plan")).toContainText("Child investigation");
  await expect(plan).not.toContainText("Child investigation");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Close work" }).click();
  await expect(plan).toBeVisible();
});

test("Plan and activity use aligned independent disclosure columns", async ({ page }, info) => {
  await setup(page);
  await page.getByRole("button", { name: "Close work", exact: true }).click();
  await installActivity(page, false);
  const plan = page.getByRole("region", { name: "Plan", exact: true });
  const activity = page.getByRole("region", { name: "Current activity", exact: true });
  const planToggle = plan.getByRole("button");
  const activityToggle = activity.locator(":scope > .wb-conversation-disclosure");
  for (const width of [1440, 480]) {
    await page.setViewportSize({ width, height: 900 });
    for (const expanded of [false, true]) {
      if (expanded) {
        await planToggle.focus();
        await page.keyboard.press("Enter");
        await activityToggle.click();
      }
      await expect(planToggle).toHaveAttribute("aria-expanded", String(expanded));
      await expect(activityToggle).toHaveAttribute("aria-expanded", String(expanded));
      const planBounds = (await planToggle.boundingBox())!;
      const activityBounds = (await activityToggle.boundingBox())!;
      expect(Math.abs(planBounds.x - activityBounds.x)).toBeLessThan(1);
      expect(planBounds.width).toBe(activityBounds.width);
      expect(await planToggle.evaluate(button => {
        const body = button.previousElementSibling!.getBoundingClientRect();
        const control = button.getBoundingClientRect();
        return Math.abs(body.right - control.left) < 1 && Math.abs(body.height - control.height) < 1;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`disclosure-${width}-${expanded ? "expanded" : "collapsed"}.png`) });
    }
    await planToggle.click();
    await expect(activityToggle).toHaveAttribute("aria-expanded", "true");
    await activityToggle.click();
  }
});

test("conversation Plan clears on absent plans and resets expansion for new work", async ({ page }) => {
  await setup(page);
  const plan = page.locator(".wb-conversation-plan");
  await plan.getByRole("button", { name: "Expand Plan", exact: true }).click();
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (q: any) => ({
      ...(await read(q)),
      plan: q.productRunId.endsWith("-empty") ? null : {
        steps: [{ step: "New task step", status: "pending" }],
      },
    });
    (window as any).emitWorkbench("revision", (snapshot: any) => {
      snapshot.run.productRunId += "-next";
      snapshot.run.harnessRunId += "-next";
      snapshot.run.host.runId = snapshot.run.harnessRunId;
    });
  });
  await expect(plan).toContainText("New task step");
  await expect(plan.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(plan.locator(".wb-plan-summary")).toContainText("0/1");
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
        step: `${i + 1}. ${"Long plan step text ".repeat(8)}`,
        status: i === 0 ? "in_progress" : "pending",
      })) },
    });
    (window as any).emitWorkbench("revision");
  });
  const plan = page.locator(".wb-conversation-plan");
  await expect(plan.locator(".wb-plan-summary")).toContainText("0/20");
  await plan.getByRole("button", { name: "Expand Plan", exact: true }).click();
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

test("main work owns its detail entry before and after completion without a detached Details link", async ({ page }, info) => {
  await setup(page, false, false, true);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    const detail = api.readTaskDetails;
    api.readCurrentWork = async (query: any) => {
      const work = await read(query);
      return { ...work, commands: [], tasks: [{ ...work.tasks[0],
        label: "Inspect the workspace", hasFinishedWork: false,
        status: (window as any).mainFinished ? "completed" : "running",
      }] };
    };
    api.readTaskDetails = async (query: any) => {
      (window as any).lastTaskDetail = query;
      const result = await detail(query);
      return { ...result, task: { ...result.task, label: "Inspect the workspace" } };
    };
    (window as any).emitWorkbench("revision");
  });
  const work = page.getByRole("complementary", { name: "Current work", exact: true });
  const ongoing = work.getByRole("region", { name: "Ongoing work" });
  const finished = work.locator(".wb-finished");
  await expect(work.getByRole("button", { name: "Details", exact: true })).toHaveCount(0);
  await expect(ongoing.getByRole("button", { name: /Inspect the workspace.*Main task.*Working/ })).toBeVisible();
  await expect(work.getByText("Subtasks", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("main-task-current.png") });
  await ongoing.getByRole("button", { name: /Inspect the workspace/ }).click();
  await expect(work.getByRole("heading", { name: "Inspect the workspace" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).lastTaskDetail.runId)).toBe("harness-run-1");
  await work.getByRole("button", { name: "Back to work", exact: true }).click();
  await page.evaluate(() => {
    (window as any).mainFinished = true;
    (window as any).emitWorkbench("revision");
  });
  await expect(ongoing).toHaveCount(0);
  await expect(finished).not.toHaveAttribute("open");
  await finished.locator(":scope > summary").click();
  await expect(finished.getByRole("button", { name: /Inspect the workspace.*Main task.*Completed/ })).toBeVisible();
  await page.setViewportSize({ width: 480, height: 720 });
  expect(await work.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("main-task-finished-narrow.png") });
  await finished.getByRole("button", { name: /Inspect the workspace/ }).click();
  await expect(work.getByRole("heading", { name: "Inspect the workspace" })).toBeVisible();
});

test("work is split into ongoing and finished groups without losing task ancestry", async ({ page }, info) => {
  await setup(page, false, false, true);
  await page.evaluate(() => {
    const api = (window as any).helarc;
    const read = api.readCurrentWork;
    api.readCurrentWork = async (query: any) => {
      const work = await read(query);
      return { ...work, tasks: [work.tasks[0],
        { ...work.tasks[1], status: (window as any).childFinished ? "completed" : "suspended" },
        { ...work.tasks[1], runId: "failed-child", parentRunId: "child-1", label: "Dependency check", status: "failed" },
        { ...work.tasks[1], runId: "cancelled-child", label: "Optional check", status: "cancelled" },
      ] };
    };
    (window as any).emitWorkbench("revision");
  });
  const work = page.getByRole("complementary", { name: "Current work", exact: true });
  const ongoing = work.getByRole("region", { name: "Ongoing work" });
  const finished = work.locator(".wb-finished");
  await expect(work.getByRole("heading", { name: /^(Now|Delegated tasks)$/ })).toHaveCount(0);
  await expect(ongoing.getByRole("button", { name: /Inspect dependencies.*Suspended/ })).toBeVisible();
  await expect(ongoing).not.toContainText("Dependency check");
  await expect(ongoing).not.toContainText("Optional check");
  await expect(finished).not.toHaveAttribute("open");
  await finished.locator(":scope > summary").click();
  await expect(finished.getByRole("button", { name: /Dependency check.*Failed/ })).toBeVisible();
  await expect(finished.getByRole("button", { name: /Optional check.*Stopped/ })).toBeVisible();
  await expect(finished.getByRole("button", { name: /Inspect dependencies.*Parent task.*Suspended/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("work-groups-wide.png") });
  await page.evaluate(() => {
    (window as any).childFinished = true;
    (window as any).emitWorkbench("revision");
  });
  await expect(ongoing).not.toContainText("Inspect dependencies");
  await expect(finished.getByRole("button", { name: /Inspect dependencies.*Completed/ })).toBeVisible();
  await page.setViewportSize({ width: 480, height: 720 });
  expect(await work.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("work-groups-narrow.png") });
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
  await page.locator(".wb-finished > summary").click();
  const branch = page.locator(".wb-finished .wb-task-branches").first();
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
