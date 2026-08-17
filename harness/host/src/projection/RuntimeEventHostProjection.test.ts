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
        actionContractVersion: "helarc-action-v1",
        toolCatalogVersion: "helarc-tool-catalog-v1",
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
    expect(projected.payload).not.toHaveProperty("promptArchitectureVersion");
    expect(projected.payload).not.toHaveProperty("requestedToolName");
    expect(projected.payload).not.toHaveProperty("patchOperation");
    expect(projected.payload).not.toHaveProperty("rawPrompt");
    expect(event.payload).toHaveProperty("controllerAction", "call_tool");
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.payload)).toBe(true);
  });

  it("keeps the safe Context transition summary without Contribution payloads", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-2",
      runId: "run-1",
      taskId: "task-1",
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
});
