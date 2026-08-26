import { describe, expect, it } from "vitest";
import type { HelarcMainSnapshot } from "./HelarcMainController.js";
import { projectHelarcDesktopSnapshot } from "./HelarcDesktopProjection.js";

const SECRET = "sentinel-desktop-private-value";

describe("Helarc Desktop IPC projection", () => {
  it("keeps only the Desktop-owned Run display contract", () => {
    const projected = projectHelarcDesktopSnapshot(snapshotWithRun([]));

    expect(Object.keys(projected.run?.host ?? {}).sort()).toEqual([
      "activeDelegations",
      "instructionBinding",
      "pendingInteractions",
      "progress",
      "runRevision",
      "runTree",
      "startedAt",
      "taskId",
      "terminal",
      "verification",
    ]);
    expect(Object.keys(projected.run?.product ?? {}).sort()).toEqual([
      "activity",
      "continuation",
      "phase",
      "result",
    ]);
    expect(projected.run?.product.continuation).toEqual({
      branchId: "product-run-1:main",
      requestId: "request-1",
      kind: "reused",
      reason: null,
      occurredAt: "2026-07-19T00:00:00.000Z",
    });
    expect(projected.run?.host.verification).toEqual({
      snapshotRevision: 3,
      counts: [{ state: "pending", count: 1 }],
      activeChecks: 1,
      gateStatus: null,
      waiting: true,
      recoveryNeeded: true,
      safeReasons: ["verification_pending"],
      updatedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(projected.run?.host.progress).toEqual({
      checkpointSequence: 3,
      disposition: "repeated",
      reasonCode: "equivalent_fact_repeated",
      consecutiveNonAdvancingCheckpoints: 2,
      correctionRounds: 1,
      activeCorrectionRound: 1,
    });
    expect(projected.run?.host.instructionBinding).toMatchObject({
      agent: { id: "helarc", revision: "agent-revision-1" },
      release: { id: "helarc.production", revision: "1" },
      model: { providerId: "provider-1", modelId: "model-1" },
      blockCount: 7,
    });
    expect(projected.provider.configured && projected.provider.activeProfile)
      .not.toHaveProperty("storedCredential");
    expect(projected.run?.product.activity[0]?.metadata).toEqual({
      status: "running",
      controllerAction: "tool_call",
      exposedToolNames: ["Read", "Glob", "Grep", "Edit", "Write"],
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });

  it("projects approval presentation without authority or owner-private state", () => {
    const projected = projectHelarcDesktopSnapshot(snapshotWithRun([{
      request: {
        id: "approval-1",
        protocol: { owner: "permission", kind: "approval", revision: "1" },
        requestVersion: 1,
        subject: {
          owner: "permission",
          kind: "approval",
          id: "action-1",
          revision: "action-fingerprint-1",
        },
      },
      presentation: {
        id: "approval-1",
        runId: "run-1",
        category: "permissions",
        reason: "Additional write access is required.",
        payload: {
          permissions: { fileSystem: { write: ["workspace:marker.txt"] } },
          privateAuthority: SECRET,
        },
        decisionOptions: [{
          id: "grant",
          kind: "grantPermissions",
          scope: "run",
          label: "Grant for Run",
          description: null,
        }],
        privateContext: SECRET,
      },
      disclosureClass: "sensitive",
      expiresAt: "2026-07-19T00:01:00.000Z",
      blockingScope: "run",
      phase: "pending",
    }]));

    const approval = projected.run?.host.pendingInteractions[0];
    expect(approval?.family).toBe("approval");
    expect(approval?.presentation).toEqual({
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

  it("projects clarification questions without protocol-private fields", () => {
    const projected = projectHelarcDesktopSnapshot(snapshotWithRun([{
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
      presentation: {
        questions: [{
          id: "scope",
          prompt: "Which scope should be updated?",
          options: [
            { label: "Runtime", description: "Update the runtime package." },
            { label: "Product", description: "Update the product package." },
          ],
          allow_multiple: false,
          privateQuestionState: SECRET,
        }],
        privateProtocolState: SECRET,
      },
      disclosureClass: "internal",
      expiresAt: null,
      blockingScope: "run",
      phase: "pending",
    }]));

    expect(projected.run?.host.pendingInteractions[0]).toMatchObject({
      family: "clarification",
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
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });
});

function snapshotWithRun(pendingInteractions: readonly unknown[]): HelarcMainSnapshot {
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
    productRunId: "product-run-1",
    harnessRunId: "harness-run-1",
    display: { status: "running", terminal: false, statusSource: "host" },
    host: {
      sessionId: "session-1",
      taskId: "task-1",
      runId: "harness-run-1",
      sequence: 1,
      runOperationSequence: 0,
      runRevision: 0,
      status: "running",
      startedAt: "2026-07-19T00:00:00.000Z",
      instructionBinding: {
        ref: {
          id: "harness-run-1:agent-instruction-binding:0",
          revision: `sha256:${"a".repeat(64)}`,
        },
        agent: { id: "helarc", revision: "agent-revision-1" },
        instructions: {
          id: "helarc.instructions",
          revision: `sha256:${"b".repeat(64)}`,
        },
        release: { id: "helarc.production", revision: "1" },
        model: { providerId: "provider-1", modelId: "model-1" },
        resolverRevision: "resolver-1",
        contentDigest: { algorithm: "sha256", value: "b".repeat(64) },
        blockCount: 7,
        effectiveFromRunRevision: 0,
        supersedes: null,
      },
      runTree: {
        rootRunId: "harness-run-1",
        revision: 1,
        deadlineAt: "2026-07-19T00:01:00.000Z",
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
          startedAt: "2026-07-19T00:00:00.000Z",
          completedAt: null,
        }],
      },
      activeDelegations: [],
      progress: {
        checkpointSequence: 3,
        disposition: "repeated",
        reasonCode: "equivalent_fact_repeated",
        consecutiveNonAdvancingCheckpoints: 2,
        correctionRounds: 1,
        activeCorrectionRound: 1,
        factRefs: [{
          kind: "tool_observation",
          owner: "tool",
          subjectId: "tool-call-1",
          revision: "observation-1",
          privateFactState: SECRET,
        }],
        latestAssessment: SECRET,
        latestAdvancement: SECRET,
      },
      plan: { privatePlanState: SECRET },
      pendingInteractions,
      retry: { privateRetryState: SECRET },
      verification: {
        snapshot: { runId: "harness-run-1", revision: 3 },
        counts: [{ state: "pending", count: 1 }],
        activeAttempts: [{ id: "verification-attempt-1", ordinal: 1 }],
        gate: null,
        waiting: true,
        recoveryNeeded: true,
        safeReasons: ["verification_pending"],
        updatedAt: "2026-07-19T00:00:00.000Z",
        privateVerificationState: SECRET,
      },
      cancellation: { privateCancellationState: SECRET },
      enforcement: { privateAttemptState: SECRET },
      terminal: null,
      rawRunResult: SECRET,
    },
    product: {
      runId: "product-run-1",
      sequence: 1,
      phase: { kind: "none" },
      activity: [{
        id: "activity-1",
        sequence: 1,
        source: {
          runId: "harness-run-1",
          eventSequence: 1,
          lineage: {
            kind: "root",
            root: { id: "harness-run-1" },
            depth: 0,
          },
        },
        timestamp: "2026-07-19T00:00:00.000Z",
        kind: "trace",
        title: "Controller action",
        detail: null,
        metadata: {
          status: "running",
          controllerAction: "tool_call",
          exposedToolNames: ["Read", "Glob", "Grep", "Edit", "Write"],
          privateTraceState: SECRET,
        },
      }],
      continuation: {
        branchId: "product-run-1:main",
        requestId: "request-1",
        kind: "reused",
        reason: null,
        occurredAt: "2026-07-19T00:00:00.000Z",
        opaqueState: SECRET,
      },
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
