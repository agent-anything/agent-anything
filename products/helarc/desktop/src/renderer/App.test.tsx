import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HelarcMainSnapshot } from "../shared/HelarcDesktopApi.js";
import {
  App,
  ApprovalPromptPanel,
  ClarificationPromptPanel,
  ThreadTimeline,
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
        approval={pendingApproval("pending")}
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

  it("renders bounded clarification questions and answer controls", () => {
    const html = renderToStaticMarkup(
      <ClarificationPromptPanel
        clarification={{
          family: "clarification",
          phase: "pending",
          request: {
            id: "clarification-1",
            protocol: { owner: "helarc", kind: "clarification", revision: "1" },
            requestVersion: 1,
            subject: {
              owner: "helarc",
              kind: "clarification_tool_call",
              id: "tool-call-1",
              revision: "1",
            },
          },
          disclosureClass: "internal",
          expiresAt: null,
          blockingScope: "run",
          presentation: {
            questions: [{
              id: "scope",
              prompt: "Which scope should be updated?",
              options: [
                { label: "Runtime", description: "Update the runtime package." },
                { label: "Product", description: "Update the product package." },
              ],
              allowMultiple: false,
            }],
          },
        }}
        submissionError={null}
        isBusy={false}
        onSubmit={() => undefined}
      />,
    );

    expect(html).toContain("Which scope should be updated?");
    expect(html).toContain("Runtime");
    expect(html).toContain("Product");
    expect(html).toContain("Update the runtime package.");
    expect(html).toContain("Submit");
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
    expect(html).toContain("Root run | event 1");
  });

  it("renders the bounded descendant hierarchy from the Host Run Tree projection", () => {
    const root = rootRunTree();
    const html = renderToStaticMarkup(
      <RunTimelinePanel
        run={runProjection({
          runTree: {
            ...root,
            revision: 4,
            totalDescendantRuns: 2,
            activeDescendantRuns: 1,
            nodes: [...root.nodes, {
              runId: "harness-run-2",
              parentRunId: "harness-run-1",
              relationId: "relation-1",
              parentRunActionId: "action-1",
              depth: 1,
              status: "cancelling",
              resultCode: null,
              startedAt: "2026-07-05T01:00:01.000Z",
              completedAt: null,
            }, {
              runId: "harness-run-3",
              parentRunId: "harness-run-2",
              relationId: "relation-2",
              parentRunActionId: "action-2",
              depth: 2,
              status: "failed",
              resultCode: "controller_failed",
              startedAt: "2026-07-05T01:00:01.000Z",
              completedAt: "2026-07-05T01:00:02.000Z",
            }],
          },
          activity: [event("event-1", "run.completed", "Run completed", "info")],
        })}
        acceptedTask={{ id: "task-1", prompt: "Inspect code" }}
      />,
    );

    expect(html).toContain("Run hierarchy");
    expect(html).toContain("1 active / 2 descendants");
    expect(html).toContain("Descendant depth 1");
    expect(html).toContain("Descendant depth 2");
    expect(html).toContain("Created by action-1");
    expect(html).toContain("cancelling");
    expect(html).toContain("controller_failed");
    expect(html).not.toContain("delegatedPrompt");
  });

  it("renders compact planner trace details in the run timeline", () => {
    const html = renderToStaticMarkup(
      <RunTimelinePanel
        run={runProjection({
          activity: [
            event("event-1", "tool.proposed", "Tool call proposed", "info", {
              controllerAction: "tool_call",
              requestedToolName: "Read",
              promptArchitectureVersion: "helarc-prompt-v4",
              actionContractVersion: "helarc-model-decision-v1",
              toolExposureVersion: "trusted-tool-exposure-v1",
              exposedToolNames: [
                "Read",
                "Glob",
                "Grep",
                "Edit",
                "Write",
              ],
            }),
          ],
        })}
        acceptedTask={{ id: "task-1", prompt: "Inspect code" }}
      />,
    );

    expect(html).toContain("action tool_call");
    expect(html).toContain("tool Read");
    expect(html).toContain("versions helarc-prompt-v4, helarc-model-decision-v1, trusted-tool-exposure-v1");
    expect(html).toContain("tools Read, Glob, Grep, Edit, Write");
  });

  it("renders active Thread messages", () => {
    const html = renderToStaticMarkup(
      <ThreadTimeline
        activeThread={{
          id: "thread-1",
          title: "Update docs",
          status: "open",
          workspace: {
            id: "workspace",
            name: "agent-anything",
            path: "D:/projects/agent-anything",
          },
          revision: 1,
          messages: [
            {
              id: "message-1",
              sequence: 1,
              role: "user",
              content: "Update docs",
              createdAt: "2026-07-05T01:00:00.000Z",
              relatedRunIds: ["run-1"],
              relatedArtifactIds: [],
            },
            {
              id: "message-2",
              sequence: 2,
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
    expect(html).toContain("Validation");
    expect(html).toContain("Not required");
    expect(html).toContain("Event summary");
  });
});

function pendingApproval(
  phase: "pending" | "submitted_for_resolution",
): NonNullable<Parameters<typeof ApprovalPromptPanel>[0]["approval"]> {
  return {
    family: "approval",
    phase,
    request: {
      id: "approval-1",
      protocol: { owner: "permission", kind: "approval", revision: "1" },
      requestVersion: 1,
      subject: {
        owner: "permission",
        kind: "approval",
        id: "action-1",
        revision: "fingerprint-1",
      },
    },
    disclosureClass: "sensitive",
    expiresAt: "2026-07-05T01:01:00.000Z",
    blockingScope: "run",
    presentation: {
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
  runTree?: NonNullable<HelarcMainSnapshot["run"]>["host"]["runTree"];
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
    productRunId: "product-run-1",
    harnessRunId: "harness-run-1",
    display: { status, terminal, statusSource: "host" },
    host: {
      taskId: "task-1",
      startedAt: "2026-07-05T01:00:00.000Z",
      runRevision: 0,
      runTree: input.runTree ?? rootRunTree(),
      validation: null,
      pendingInteractions: [],
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
      continuation: null,
      result: terminal
        ? {
            status: status === "completed" ? "completed" : status,
            validation: {
              status: "not_required",
              snapshotRevision: 1,
              counts: [],
              activeChecks: 0,
              gateStatus: "completion_eligible",
              safeReasons: [],
              updatedAt: "2026-07-05T01:00:01.000Z",
            },
            output: {
              taskId: "task-1",
              workspace: {
                primaryId: "workspace",
                additionalIds: [],
              },
              agentSummary: "Terminal summary",
              runtimeStatus,
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
    source: {
      runId: "harness-run-1",
      eventSequence: Number(id.replace("event-", "")),
      lineage: { kind: "root" as const, rootRunId: "harness-run-1", depth: 0 as const },
    },
    timestamp: "2026-07-05T01:00:00.000Z",
    kind,
    title,
    detail: null,
    severity,
    metadata,
  };
}

function rootRunTree(): NonNullable<HelarcMainSnapshot["run"]>["host"]["runTree"] {
  return {
    rootRunId: "harness-run-1",
    revision: 1,
    deadlineAt: "2026-07-05T01:01:00.000Z",
    limits: {
      maxDescendantDepth: 2,
      maxTotalDescendantRuns: 4,
      maxActiveDescendantRuns: 2,
    },
    totalDescendantRuns: 0,
    activeDescendantRuns: 0,
    nodes: [{
      runId: "harness-run-1",
      parentRunId: null,
      relationId: null,
      parentRunActionId: null,
      depth: 0,
      status: "running",
      resultCode: null,
      startedAt: "2026-07-05T01:00:00.000Z",
      completedAt: null,
    }],
  };
}
