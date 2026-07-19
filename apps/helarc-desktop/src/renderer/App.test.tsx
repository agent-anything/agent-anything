import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HelarcMainSnapshot } from "../shared/HelarcDesktopApi.js";
import {
  App,
  ApprovalPromptPanel,
  ConversationPanel,
  RunTerminalPanel,
  RunTimelinePanel,
  ThreadPanel,
} from "./App.js";

describe("Helarc workbench shell", () => {
  it("renders the primary workbench surfaces", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Helarc");
    expect(html).toContain("No workspace selected");
    expect(html).toContain("No active run");
    expect(html).toContain("No pending review");
    expect(html).toContain("Workbench");
    expect(html).toContain("Threads");
    expect(html).toContain("Settings");
    expect(html).toContain("Templates");
  });

  it("renders offered approval decision actions", () => {
    const html = renderToStaticMarkup(
      <ApprovalPromptPanel
        approval={pendingApproval("reviewing")}
        submissionError={null}
        isBusy={false}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Additional permissions");
    expect(html).toContain("Create a governed marker file.");
    expect(html).toContain("1 write target(s)");
    expect(html).toContain("Cancel");
    expect(html).toContain("Decline");
    expect(html).toContain("Grant for run");
  });

  it("disables approval controls after submission is accepted", () => {
    const html = renderToStaticMarkup(
      <ApprovalPromptPanel
        approval={pendingApproval("submitted_for_resolution")}
        submissionError={null}
        isBusy={false}
        onSubmit={() => undefined}
      />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("Submitted for resolution");
  });

  it("renders the active run timeline from safe run events", () => {
    const html = renderToStaticMarkup(
      <RunTimelinePanel
        run={runProjection({
          activity: [
            event("event-1", "planning.started", "Planning started", "info"),
            event("event-2", "retry.cancelled", "Retry cancelled", "warning"),
          ],
        })}
        acceptedTask={{ id: "task-1", prompt: "Inspect code" }}
      />,
    );

    expect(html).toContain("Inspect code");
    expect(html).toContain("Running");
    expect(html).toContain("Planning started");
    expect(html).toContain("Retry cancelled");
    expect(html).toContain("severity-warning");
  });

  it("renders compact planner trace details in the run timeline", () => {
    const html = renderToStaticMarkup(
      <RunTimelinePanel
        run={runProjection({
          activity: [
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
        })}
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
    ["blocked", "Run blocked", "blocked"],
    ["cancelled", "Run cancelled", "cancelled"],
  ] as const)("renders terminal %s output", (status, title, runtimeStatus) => {
    const html = renderToStaticMarkup(
      <RunTerminalPanel
        title={title}
        run={runProjection({
          status,
          runtimeStatus,
          activity: [event("event-1", "run.completed", "Run event", "info")],
        })}
      />,
    );

    expect(html).toContain(title);
    expect(html).toContain(status);
    expect(html).toContain(runtimeStatus);
    expect(html).toContain("Terminal summary");
    expect(html).toContain("Unisolated");
    expect(html).toContain("Event summary");
  });
});

function pendingApproval(
  phase: "reviewing" | "submitted_for_resolution",
): NonNullable<Parameters<typeof ApprovalPromptPanel>[0]["approval"]> {
  return {
    phase,
    pendingVersion: 1,
    request: {
      id: "approval-1",
      runId: "run-1",
      category: "permissions",
      reason: "Create a governed marker file.",
      payload: {
        permissions: { fileSystem: { write: ["D:\\workspace\\marker.txt"] } },
      },
      decisionOptions: [
        {
          id: "grant-run",
          kind: "grantPermissions",
          label: "Grant for run",
          description: "Grant the requested permissions for this run.",
        },
        {
          id: "decline",
          kind: "decline",
          label: "Decline",
          description: null,
        },
        {
          id: "cancel",
          kind: "cancel",
          label: "Cancel",
          description: null,
        },
      ],
    },
  };
}

function runProjection(input: {
  status?: "running" | "completed" | "blocked" | "failed" | "cancelled";
  runtimeStatus?: "succeeded" | "blocked" | "failed" | "cancelled";
  activity?: ReturnType<typeof event>[];
} = {}): NonNullable<HelarcMainSnapshot["run"]> {
  const status = input.status ?? "running";
  const runtimeStatus = input.runtimeStatus ?? "succeeded";
  const activity = input.activity ?? [];
  const terminal = status !== "running";
  const code = status === "completed"
    ? null
    : status === "blocked"
      ? "runtime_no_safe_path" as const
      : status === "cancelled"
        ? "runtime_cancelled" as const
        : "runtime_limit_exceeded" as const;
  return {
    runId: "run-1",
    display: { status, terminal, statusSource: "platform" },
    platform: {
      taskId: "task-1",
      startedAt: "2026-07-05T01:00:00.000Z",
      approval: null,
      terminal: terminal
        ? {
            status,
            code,
            completedAt: "2026-07-05T01:00:01.000Z",
          }
        : null,
    },
    product: {
      phase: { kind: "none" },
      activity,
      result: terminal
        ? {
            status: status === "completed" ? "completed" : status,
            output: {
              taskId: "task-1",
              workspaceId: "workspace",
              agentSummary: "Terminal summary",
              runtimeStatus,
              patchStatus: null,
              appliedPath: null,
              enforcement: {
                selected: "disabled",
                status: "unisolated",
                code: null,
              },
              safeErrors: status === "completed"
                ? []
                : [{ code: code ?? "run_failed", message: "Terminal error" }],
            },
          }
        : null,
    },
  };
}

function event(
  id: string,
  kind: "planning.started" | "tool.proposed" | "tool.completed" | "run.completed" | "retry.cancelled",
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
