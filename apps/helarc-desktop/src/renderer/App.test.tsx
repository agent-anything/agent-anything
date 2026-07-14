import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  App,
  ConversationPanel,
  PermissionPromptPanel,
  RunTerminalPanel,
  RunTimelinePanel,
  ThreadPanel,
} from "./App.js";

describe("Helarc workbench shell", () => {
  it("renders the primary workbench surfaces", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Helarc");
    expect(html).toContain("No workspace selected");
    expect(html).toContain("No active session");
    expect(html).toContain("No pending review");
    expect(html).toContain("Workbench");
    expect(html).toContain("Threads");
    expect(html).toContain("Settings");
    expect(html).toContain("Templates");
  });

  it("renders permission prompt decision actions", () => {
    const html = renderToStaticMarkup(
      <PermissionPromptPanel
        prompt={{
          requestId: "permission-1",
          taskId: "task-1",
          toolName: "codeAgent.runCommand",
          reason: "Create a governed marker file.",
          command: "node",
          args: ["-e", "..."],
          cwd: ".",
          rootName: "workspace",
        }}
        isBusy={false}
        onCancel={() => undefined}
        onResolve={() => undefined}
      />,
    );

    expect(html).toContain("codeAgent.runCommand");
    expect(html).toContain("Create a governed marker file.");
    expect(html).toContain("node -e ...");
    expect(html).toContain("Cancel");
    expect(html).toContain("Deny");
    expect(html).toContain("Approve");
  });

  it("disables permission controls while a decision is in flight", () => {
    const html = renderToStaticMarkup(
      <PermissionPromptPanel
        prompt={{
          requestId: "permission-1",
          taskId: "task-1",
          toolName: "codeAgent.runCommand",
          reason: "Create a governed marker file.",
          command: "node",
          args: ["-e", "..."],
          cwd: ".",
          rootName: "workspace",
        }}
        isBusy={true}
        onCancel={() => undefined}
        onResolve={() => undefined}
      />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it("renders the active run timeline from safe run events", () => {
    const html = renderToStaticMarkup(
      <RunTimelinePanel
        activeRun={{
          runId: "run-1",
          status: "running",
          task: {
            text: "Inspect code",
            templateId: null,
          },
          workspace: null,
          provider: null,
          events: [
            event("event-1", "planning.started", "Planning started", "info"),
            event("event-2", "tool.completed", "Tool completed", "warning"),
          ],
          pendingPermission: null,
          cancellation: null,
          terminal: null,
          startedAt: "2026-07-05T01:00:00.000Z",
          metadata: {},
        }}
        acceptedTask={{ id: "task-1", prompt: "Inspect code" }}
      />,
    );

    expect(html).toContain("Inspect code");
    expect(html).toContain("Running");
    expect(html).toContain("Planning started");
    expect(html).toContain("Tool completed");
    expect(html).toContain("severity-warning");
  });

  it("renders compact planner trace details in the run timeline", () => {
    const html = renderToStaticMarkup(
      <RunTimelinePanel
        activeRun={{
          runId: "run-1",
          status: "running",
          task: {
            text: "Inspect code",
            templateId: null,
          },
          workspace: null,
          provider: null,
          events: [
            event("event-1", "tool.proposed", "Tool call proposed", "info", {
              controllerAction: "call_tool",
              requestedToolName: "codeAgent.readFile",
              promptArchitectureVersion: "helarc-prompt-v1",
              actionContractVersion: "helarc-action-v1",
              toolCatalogVersion: "helarc-tool-catalog-v1",
              exposedToolNames: [
                "codeAgent.listFiles",
                "codeAgent.readFile",
                "codeAgent.searchFiles",
              ],
            }),
          ],
          pendingPermission: null,
          cancellation: null,
          terminal: null,
          startedAt: "2026-07-05T01:00:00.000Z",
          metadata: {},
        }}
        acceptedTask={{ id: "task-1", prompt: "Inspect code" }}
      />,
    );

    expect(html).toContain("action call_tool");
    expect(html).toContain("tool codeAgent.readFile");
    expect(html).toContain("versions helarc-prompt-v1, helarc-action-v1, helarc-tool-catalog-v1");
    expect(html).toContain("tools codeAgent.listFiles, codeAgent.readFile, codeAgent.searchFiles");
  });

  it("renders active thread conversation messages", () => {
    const html = renderToStaticMarkup(
      <ConversationPanel
        activeThread={{
          id: "thread-1",
          title: "Update docs",
          status: "open",
          workspace: {
            id: "workspace",
            name: "agent-anything",
            path: "D:/projects/agent-anything",
          },
          activeConversationId: "conversation-1",
          messages: [
            {
              id: "message-1",
              role: "user",
              content: "Update docs",
              createdAt: "2026-07-05T01:00:00.000Z",
              relatedRunIds: ["run-1"],
              relatedArtifactIds: [],
            },
            {
              id: "message-2",
              role: "assistant",
              content: "No changes needed.",
              createdAt: "2026-07-05T01:00:01.000Z",
              relatedRunIds: ["run-1"],
              relatedArtifactIds: [],
            },
          ],
          artifacts: [
            {
              id: "artifact-1",
              kind: "final-output",
              title: "Final output",
              summary: "No changes needed.",
              createdAt: "2026-07-05T01:00:01.000Z",
              runId: "run-1",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Update docs");
    expect(html).toContain("2 messages");
    expect(html).toContain("User");
    expect(html).toContain("Assistant");
    expect(html).toContain("No changes needed.");
    expect(html).toContain("Final output");
    expect(html).not.toContain("rawProvider");
    expect(html).not.toContain("secret");
  });

  it("renders thread summaries as the work history surface", () => {
    const html = renderToStaticMarkup(
      <ThreadPanel
        threads={[
          {
            id: "thread-1",
            title: "Update docs",
            status: "open",
            workspace: {
              id: "workspace",
              name: "agent-anything",
              path: "D:/projects/agent-anything",
            },
            createdAt: "2026-07-05T01:00:00.000Z",
            updatedAt: "2026-07-05T01:00:01.000Z",
            latestRun: {
              runId: "run-1",
              status: "completed",
              startedAt: "2026-07-05T01:00:00.000Z",
              completedAt: "2026-07-05T01:00:01.000Z",
            },
          },
        ]}
        selectedThread={{
          id: "thread-1",
          title: "Update docs",
          status: "open",
          workspace: {
            id: "workspace",
            name: "agent-anything",
            path: "D:/projects/agent-anything",
          },
          createdAt: "2026-07-05T01:00:00.000Z",
          updatedAt: "2026-07-05T01:00:01.000Z",
          latestRun: {
            runId: "run-1",
            status: "completed",
            startedAt: "2026-07-05T01:00:00.000Z",
            completedAt: "2026-07-05T01:00:01.000Z",
          },
        }}
        selectedThreadId="thread-1"
        onSelectThread={() => undefined}
      />,
    );

    expect(html).toContain("Threads");
    expect(html).toContain("Update docs");
    expect(html).toContain("completed - agent-anything");
    expect(html).toContain("Latest run");
    expect(html).not.toContain("rawProvider");
    expect(html).not.toContain("secret");
  });

  it.each([
    ["completed", "Run completed", "succeeded"],
    ["failed", "Run failed", "failed"],
    ["denied", "Run denied", "blocked"],
    ["cancelled", "Run cancelled", "cancelled"],
  ] as const)("renders terminal %s output", (status, title, runtimeStatus) => {
    const html = renderToStaticMarkup(
      <RunTerminalPanel
        title={title}
        terminal={{
          status,
          runtimeStatus,
          runtimeCode: status === "completed" ? null : `${status}_code`,
          cancellation: status === "cancelled"
            ? {
                requestId: "run-1:cancellation",
                origin: "user",
                reasonCode: "user_requested",
                requestedAt: "2026-07-05T01:00:00.500Z",
              }
            : null,
          safeOutput: {
            taskId: "task-1",
            workspaceId: "workspace",
            agentSummary: "Terminal summary",
            runtimeStatus,
            patchStatus: null,
            appliedPath: null,
            safeErrors: status === "completed" ? [] : [{ code: `${status}_code`, message: "Terminal error" }],
          },
          errorSummary: status === "completed" ? [] : [{ code: `${status}_code`, message: "Terminal error" }],
          startedAt: "2026-07-05T01:00:00.000Z",
          completedAt: "2026-07-05T01:00:01.000Z",
          eventCount: 1,
        }}
        events={[event("event-1", "run.completed", "Run event", "info")]}
      />,
    );

    expect(html).toContain(title);
    expect(html).toContain(status);
    expect(html).toContain(runtimeStatus);
    expect(html).toContain("Terminal summary");
    expect(html).toContain("Event summary");
  });
});

function event(
  id: string,
  kind: "planning.started" | "tool.proposed" | "tool.completed" | "run.completed",
  title: string,
  severity: "info" | "warning" | "error",
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    sequence: Number(id.replace("event-", "")),
    timestamp: "2026-07-05T01:00:00.000Z",
    kind,
    title,
    detail: null,
    severity,
    metadata,
  };
}
