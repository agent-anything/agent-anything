import { describe, expect, it } from "vitest";
import type { HelarcMainSnapshot } from "./HelarcMainController.js";
import { projectHelarcDesktopSnapshot } from "./HelarcDesktopProjection.js";

const SECRET = "sentinel-desktop-private-value";

describe("Helarc Desktop IPC projection", () => {
  it("keeps only the Desktop-owned Run display contract", () => {
    const projected = projectHelarcDesktopSnapshot(snapshotWithRun({ approval: null }));

    expect(Object.keys(projected.run?.platform ?? {}).sort()).toEqual([
      "approval",
      "startedAt",
      "taskId",
      "terminal",
    ]);
    expect(Object.keys(projected.run?.product ?? {}).sort()).toEqual([
      "activity",
      "phase",
      "result",
    ]);
    expect(projected.provider.configured && projected.provider.activeProfile)
      .not.toHaveProperty("storedCredential");
    expect(projected.run?.product.activity[0]?.metadata).toEqual({
      status: "running",
      controllerAction: "call_tool",
      exposedToolNames: ["codeAgent.readFile"],
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });

  it("projects approval review content without trusted authority or review context", () => {
    const projected = projectHelarcDesktopSnapshot(snapshotWithRun({
      approval: {
        runId: "run-1",
        requestId: "approval-1",
        actionId: "action-1",
        category: "permissions",
        pendingVersion: 1,
        reviewer: "user",
        phase: "reviewing",
        requestedAt: "2026-07-19T00:00:00.000Z",
        review: {
          pendingVersion: 1,
          request: {
            id: "approval-1",
            runId: "run-1",
            actionId: "action-1",
            actionFingerprint: SECRET,
            category: "permissions",
            reason: "Additional write access is required.",
            subject: {
              runId: "run-1",
              actionId: "action-1",
              actionFingerprint: SECRET,
              environmentId: "environment-1",
              applicabilityKeyCount: 1,
            },
            payload: {
              permissions: { fileSystem: { write: ["workspace:marker.txt"] } },
              cwdDisplay: "workspace",
              environmentId: "environment-1",
            },
            decisionOptions: [{
              id: "grant",
              kind: "grantPermissions",
              scope: "run",
              label: "Grant for Run",
              description: null,
            }],
            createdAt: "2026-07-19T00:00:00.000Z",
            deadlineAt: "2026-07-19T00:01:00.000Z",
          },
          context: {
            workspaceTrustState: "trusted",
            ruleOutcome: "prompt",
            currentAuthority: {
              fileSystemRead: true,
              fileSystemWrite: false,
              network: false,
            },
            annotations: { privateReason: SECRET },
          },
        },
      },
    }));

    expect(projected.run?.platform.approval?.review?.request).toEqual({
      id: "approval-1",
      runId: "run-1",
      category: "permissions",
      reason: "Additional write access is required.",
      payload: {
        permissions: { fileSystem: { write: ["workspace:marker.txt"] } },
      },
      decisionOptions: [{
        id: "grant",
        kind: "grantPermissions",
        label: "Grant for Run",
        description: null,
      }],
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });
});

function snapshotWithRun(input: { approval: unknown }): HelarcMainSnapshot {
  const profile = {
    id: "provider-1",
    providerKind: "openai-compatible" as const,
    displayName: "Provider",
    endpointLabel: "provider.local",
    baseUrl: "https://provider.local/v1",
    baseUrlOrigin: "https://provider.local",
    model: "model-1",
    timeoutMs: 30_000,
    credentialStatus: "present" as const,
    isActive: true,
    storedCredential: SECRET,
  };
  const run = {
    runId: "run-1",
    display: { status: "running", terminal: false, statusSource: "platform" },
    platform: {
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-1",
      sequence: 1,
      status: "running",
      startedAt: "2026-07-19T00:00:00.000Z",
      plan: { privatePlanState: SECRET },
      approval: input.approval,
      retry: { privateRetryState: SECRET },
      cancellation: { privateCancellationState: SECRET },
      enforcement: { privateAttemptState: SECRET },
      terminal: null,
      rawRunResult: SECRET,
    },
    product: {
      runId: "run-1",
      sequence: 1,
      phase: { kind: "none" },
      activity: [{
        id: "activity-1",
        sequence: 1,
        timestamp: "2026-07-19T00:00:00.000Z",
        kind: "trace",
        title: "Controller action",
        detail: null,
        metadata: {
          status: "running",
          controllerAction: "call_tool",
          exposedToolNames: ["codeAgent.readFile"],
          privateTraceState: SECRET,
        },
      }],
      result: null,
      privateProductState: SECRET,
    },
  };

  return {
    status: "running",
    workspace: { id: "workspace-1", name: "Workspace", path: "D:/workspace" },
    workspaceProfiles: [],
    taskTemplates: [],
    provider: {
      configured: true,
      activeProfile: profile,
      profiles: [profile],
      error: null,
    },
    acceptedTask: { id: "task-1", prompt: "Inspect workspace" },
    activeThread: null,
    threadSummaries: [],
    run,
    error: null,
  } as unknown as HelarcMainSnapshot;
}
