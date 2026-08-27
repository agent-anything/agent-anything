import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "@agent-anything/observability/events";
import { describe, expect, it } from "vitest";
import { projectRuntimeEventForHost } from "./RuntimeEventHostProjection.js";

describe("Host RuntimeEvent projection", () => {
  it("keeps reusable Controller fields and excludes Product trace vocabulary", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-1",
      runId: "run-1",
      taskId: "task-1",
      lineage: Object.freeze({ kind: "root", root: Object.freeze({ id: "run-1" }), depth: 0 }),
      sequence: 1,
      name: "controller.finished",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: Object.freeze({
        turnId: "turn-1",
        iteration: 1,
        status: "decided",
        code: null,
        decisionKind: "advance",
        controllerAction: "call_tool",
        promptArchitectureVersion: "helarc-prompt-v1",
        controllerProtocol: "provider_native_tool_interaction",
        toolExposureVersion: "helarc-tool-exposure-v1",
        exposedToolNames: ["codeAgent.readFile"],
        requestedToolName: "codeAgent.readFile",
        patchOperation: "create",
        patchPath: "empty.txt",
        rawPrompt: "secret",
      }),
    }) as unknown as RuntimeEvent;

    const projected = projectRuntimeEventForHost(event);

    expect(projected.payload).toEqual({
      turnId: "turn-1",
      iteration: 1,
      status: "decided",
      code: null,
      decisionKind: "advance",
    });
    expect(projected.payload).not.toHaveProperty("controllerAction");
    expect(projected.payload).not.toHaveProperty("controllerProtocol");
    expect(projected.payload).not.toHaveProperty("promptArchitectureVersion");
    expect(projected.payload).not.toHaveProperty("toolExposureVersion");
    expect(projected.payload).not.toHaveProperty("requestedToolName");
    expect(projected.payload).not.toHaveProperty("patchOperation");
    expect(projected.payload).not.toHaveProperty("rawPrompt");
    expect(event.payload).toHaveProperty("controllerAction", "call_tool");
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.payload)).toBe(true);
  });

  it("projects bounded exposure lineage without omitted Tool definitions", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-exposure",
      runId: "run-1",
      taskId: "task-1",
      lineage: Object.freeze({ kind: "root", root: Object.freeze({ id: "run-1" }), depth: 0 }),
      sequence: 2,
      name: "controller.tool_exposure.resolved",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: Object.freeze({
        turnId: "turn-1",
        iteration: 1,
        controllerRequestId: "request-1",
        manifestId: "manifest-1",
        selectionRevision: "selection-1",
        contentRevision: "content-1",
        basisRevision: "basis-1",
        proofId: "proof-1",
        catalogRevision: "catalog-1",
        exposedToolCount: 2,
        omittedToolCount: 1,
        omissionReasons: ["resource_exhausted"],
        omittedTools: [{ name: "secret-tool" }],
      }),
    }) as unknown as RuntimeEvent;

    const projected = projectRuntimeEventForHost(event);

    expect(projected.payload).toMatchObject({
      proofId: "proof-1",
      manifestId: "manifest-1",
      exposedToolCount: 2,
      omittedToolCount: 1,
      omissionReasons: ["resource_exhausted"],
    });
    expect(projected.payload).not.toHaveProperty("omittedTools");
  });

  it("keeps the safe Context transition summary without Contribution payloads", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-2",
      runId: "run-1",
      taskId: "task-1",
      lineage: Object.freeze({ kind: "root", root: Object.freeze({ id: "run-1" }), depth: 0 }),
      sequence: 2,
      name: "context.transition.committed",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: Object.freeze({
        transitionId: "transition-1",
        activeContextId: "context-1",
        baseVersion: 0,
        committedVersion: 1,
        proposerOwner: "agent-core",
        proposerKind: "run_execution",
        causeKind: "run_initialization",
        causeId: "run-1",
        correlationId: "run-1",
        operationKinds: ["add"],
        contributionPayload: "must-not-escape",
      }),
    }) as unknown as RuntimeEvent;

    const projected = projectRuntimeEventForHost(event);

    expect(projected.payload).toEqual({
      transitionId: "transition-1",
      activeContextId: "context-1",
      baseVersion: 0,
      committedVersion: 1,
      proposerOwner: "agent-core",
      proposerKind: "run_execution",
      causeKind: "run_initialization",
      causeId: "run-1",
      correlationId: "run-1",
      operationKinds: ["add"],
    });
  });

  it("keeps aggregate Context projection diagnostics without Manifest records", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-3",
      runId: "run-1",
      taskId: "task-1",
      lineage: Object.freeze({ kind: "root", root: Object.freeze({ id: "run-1" }), depth: 0 }),
      sequence: 3,
      name: "context.projection.completed",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: Object.freeze({
        manifestId: "manifest-1",
        projectionId: "projection-1",
        requestId: "request-1",
        activeContextId: "context-1",
        activeContextVersion: 2,
        profileId: "profile-1",
        profileRevision: "1",
        policyId: "policy-1",
        policyRevision: "1",
        estimatorId: "estimator-1",
        estimatorRevision: "1",
        accountingUnit: "bytes",
        budgetMaximum: 1_024,
        consideredItemCount: 1,
        projectedItemCount: 1,
        projectedAmount: 128,
        includedCount: 1,
        transformedCount: 0,
        referencedCount: 0,
        omittedCount: 0,
        rejectedCount: 0,
        blockedCount: 0,
        outcome: "projected",
        code: null,
        records: [{ payload: "must-not-escape" }],
      }),
    }) as unknown as RuntimeEvent;

    const projected = projectRuntimeEventForHost(event);

    expect(projected.payload).toMatchObject({
      manifestId: "manifest-1",
      activeContextVersion: 2,
      consideredItemCount: 1,
      includedCount: 1,
      outcome: "projected",
      code: null,
    });
    expect(projected.payload).not.toHaveProperty("records");
  });

  it("keeps only safe Verification correlation and excludes detailed evidence", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-4",
      runId: "run-1",
      taskId: "task-1",
      lineage: Object.freeze({ kind: "root", root: Object.freeze({ id: "run-1" }), depth: 0 }),
      sequence: 4,
      name: "verification.check.finished",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: Object.freeze({
        snapshotRevision: 7,
        attemptId: "attempt-1",
        status: "completed",
        code: null,
        durationMs: 25,
        coverageRatio: 1,
        rawEvidence: { command: "secret command", output: "private output" },
        findings: [{ claim: "private finding" }],
      }),
    }) as unknown as RuntimeEvent;

    const projected = projectRuntimeEventForHost(event);

    expect(projected.payload).toEqual({
      snapshotRevision: 7,
      attemptId: "attempt-1",
      status: "completed",
      code: null,
      durationMs: 25,
      coverageRatio: 1,
    });
    expect(projected.payload).not.toHaveProperty("rawEvidence");
    expect(projected.payload).not.toHaveProperty("findings");
  });

  it("copies descendant lineage and only the bounded relation lifecycle fields", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-descendant-1",
      runId: "run-child",
      taskId: "task-child",
      lineage: Object.freeze({
        kind: "descendant" as const,
        root: Object.freeze({ id: "run-1" }),
        parent: Object.freeze({ id: "run-1" }),
        parentRunAction: Object.freeze({
          run: Object.freeze({ id: "run-1" }),
          id: "action-1",
          sequence: 1,
        }),
        relation: Object.freeze({ id: "relation-1" }),
        depth: 1,
      }),
      sequence: 5,
      name: "run.descendant.settled",
      occurredAt: "2026-08-03T00:00:00.000Z",
      payload: Object.freeze({
        relationId: "relation-2",
        parentRunActionId: "action-2",
        childRunId: "run-grandchild",
        childAgentId: "agent-child",
        childAgentRevision: "agent-child-v1",
        requestId: "request-2",
        requestRevision: "request-2-v1",
        predecessorResultId: "result-1",
        contextSourceCount: 2,
        authorityDerivationId: "authority-2",
        limitDerivationId: "limits-2",
        depth: 2,
        status: "succeeded",
        code: null,
        resultId: "result-2",
        resultRevision: "result-2-v1",
        expectationPresentCount: 3,
        expectationUnmetCount: 1,
        evidenceCount: 2,
        artifactCount: 1,
        verificationStatus: "satisfied",
        effectStatus: "known",
        uncertaintyCount: 0,
        controllerTurns: 4,
        actions: 2,
        modelUsageStatus: "unavailable",
        limitStatus: "within_limits",
        exhaustedLimit: null,
        treeRevision: 8,
        delegatedPrompt: "must-not-escape",
      }),
    }) as unknown as RuntimeEvent;

    const projected = projectRuntimeEventForHost(event);

    expect(projected.lineage).toEqual(event.lineage);
    expect(projected.payload).toEqual({
      relationId: "relation-2",
      parentRunActionId: "action-2",
      childRunId: "run-grandchild",
      childAgentId: "agent-child",
      childAgentRevision: "agent-child-v1",
      requestId: "request-2",
      requestRevision: "request-2-v1",
      predecessorResultId: "result-1",
      contextSourceCount: 2,
      authorityDerivationId: "authority-2",
      limitDerivationId: "limits-2",
      depth: 2,
      status: "succeeded",
      code: null,
      resultId: "result-2",
      resultRevision: "result-2-v1",
      expectationPresentCount: 3,
      expectationUnmetCount: 1,
      evidenceCount: 2,
      artifactCount: 1,
      verificationStatus: "satisfied",
      effectStatus: "known",
      uncertaintyCount: 0,
      controllerTurns: 4,
      actions: 2,
      modelUsageStatus: "unavailable",
      limitStatus: "within_limits",
      exhaustedLimit: null,
      treeRevision: 8,
    });
    expect(projected.payload).not.toHaveProperty("delegatedPrompt");
    expect(projected.lineage).not.toBe(event.lineage);
  });
});
