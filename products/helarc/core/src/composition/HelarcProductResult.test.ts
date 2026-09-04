import {
  createRunResult,
  type RunItem,
  type RunSettlementCauseRecord,
} from "@agent-anything/agent-runtime/run";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "@agent-anything/observability/events";
import { createOperationResult } from "@agent-anything/operation-catalog/result";
import { describe, expect, it } from "vitest";
import type { HelarcAgentOutput } from "../controller/HelarcController.js";
import { createHelarcTask } from "../task/index.js";
import {
  mapRuntimeEventToHelarcActivity,
  projectHelarcProductResult,
} from "./HelarcProductResult.js";

const STARTED_AT = "2026-08-13T00:00:00.000Z";
const COMPLETED_AT = "2026-08-13T00:00:01.000Z";

describe("HelarcProductResult", () => {
  it("uses the current Controller decision kind in activity details", () => {
    const event = Object.freeze({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "event-controller-finished-1",
      runId: "run-1",
      taskId: "task-1",
      lineage: Object.freeze({
        kind: "root" as const,
        root: Object.freeze({ id: "run-1" }),
        depth: 0 as const,
      }),
      sequence: 1,
      name: "controller.finished",
      occurredAt: STARTED_AT,
      payload: Object.freeze({
        turnId: "controller-turn-1",
        iteration: 1,
        status: "decided",
        code: null,
        decisionKind: "advance",
      }),
    }) as RuntimeEvent;

    expect(mapRuntimeEventToHelarcActivity(event, 1).detail).toBe("advance");
  });

  it("preserves failed lower truth, unresolved child work, and still-started Run Actions", () => {
    const task = createHelarcTask({ taskId: "task-1", prompt: "Change the file." });
    if (!task.ok) throw new Error(task.error.message);
    const failure = {
      owner: "helarc.file-operation",
      code: "file_effect_unknown",
      message: "The physical effect could not be reconciled.",
      retryable: false,
      metadata: {},
    } as const;
    const operationResult = createOperationResult({
      ref: {
        invocation: {
          id: "operation-invocation-1",
          operation: {
            operation: { namespace: "helarc.code-workspace", name: "update-file" },
            revision: "1",
          },
        },
        id: "operation-result-1",
      },
      binding: {
        operation: {
          operation: { namespace: "helarc.code-workspace", name: "update-file" },
          revision: "1",
        },
        revision: "binding-1",
      },
      semanticOwner: "helarc.file-operation",
      status: "unknown_effect",
      output: null,
      failure,
      startedAt: STARTED_AT,
      finishedAt: COMPLETED_AT,
      lowerRefs: [
        {
          owner: "canonical-action",
          kind: "action_settlement",
          id: "action-settlement-1",
          revision: "1",
        },
        {
          owner: "operation-composition",
          kind: "operation_result",
          id: "child-operation-result-1",
          revision: "1",
        },
      ],
      metadata: {
        effectCertainty: "unknown",
        completionExtent: "partial",
        compositeId: "composite-1",
        childCount: 2,
      },
    });
    const firstAction = runAction("run-action-1", 1, "operation-invocation-1");
    const secondAction = runAction("run-action-2", 2, "operation-invocation-2");
    const items: readonly RunItem<HelarcAgentOutput>[] = [
      {
        ref: { run: { id: "run-1" }, id: "run-item-1", sequence: 1 },
        committedInRevision: 1,
        createdAt: STARTED_AT,
        payload: { kind: "run_action", action: firstAction },
      },
      {
        ref: { run: { id: "run-1" }, id: "run-item-2", sequence: 2 },
        committedInRevision: 2,
        createdAt: COMPLETED_AT,
        payload: {
          kind: "observation",
          observation: {
            id: "observation-1",
            runId: "run-1",
            actionId: firstAction.ref.id,
            kind: "operation",
            createdAt: COMPLETED_AT,
            metadata: {},
            owner: "helarc.file-operation",
            runAction: firstAction.ref,
            lowerRefs: [{
              owner: "helarc.file-operation",
              kind: "operation_result",
              id: operationResult.ref.id,
              revision: null,
            }],
            payload: { kind: "operation", result: operationResult, toolResult: null },
          },
        },
      },
      {
        ref: { run: { id: "run-1" }, id: "run-item-3", sequence: 3 },
        committedInRevision: 3,
        createdAt: COMPLETED_AT,
        payload: { kind: "run_action", action: secondAction },
      },
    ];
    const cause = Object.freeze({
      ref: Object.freeze({
        run: Object.freeze({ id: "run-1" }),
        id: "run-1:settlement-cause:1",
        revision: "1",
      }),
      kind: "failure" as const,
      failure: Object.freeze({ kind: "operation" as const, failure }),
      source: Object.freeze({
        owner: "helarc.file-operation",
        kind: "operation_result",
        id: "operation-result-1",
        revision: null,
        run: Object.freeze({ id: "run-1" }),
      }),
      underlying: Object.freeze([]),
      omittedUnderlyingCount: 0,
      recordedAt: COMPLETED_AT,
    }) satisfies RunSettlementCauseRecord;
    const result = createRunResult<HelarcAgentOutput>({
      runId: "run-1",
      taskId: task.task.id,
      startingAgent: { id: "helarc-code-agent", revision: "1" },
      finalActiveAgent: { id: "helarc-code-agent", revision: "1" },
      startingInstructionBinding: testInstructionBinding("run-1"),
      finalInstructionBinding: testInstructionBinding("run-1"),
      startedAt: STARTED_AT,
      settlement: Object.freeze({
        status: "failed" as const,
        completedAt: COMPLETED_AT,
        cause: cause.ref,
      }),
      cause,
      settlementCauses: Object.freeze([cause]),
      items,
    });

    const projected = projectHelarcProductResult(
      task.task,
      {
        primary: {
          id: "workspace-1",
          name: "Workspace",
          rootRef: "D:/workspace",
          trustState: "trusted",
          source: "test",
          policyRefs: [],
          metadata: {},
        },
        additional: [],
      },
      result,
      "disabled",
      {
        snapshot: { runId: "run-1", revision: 7 },
        counts: [
          { state: "unassessed", count: 1 },
          { state: "violated", count: 1 },
        ],
        activeAttempts: [],
        gate: {
          ref: { id: "gate-1", revision: "1" },
          status: "blocked_violated",
          disposition: "continue",
          reasonCodes: ["mandatory_verification_violated"],
          affectedRequirements: [{ id: "requirement-1", revision: "1" }],
        },
        waiting: false,
        recoveryNeeded: true,
        safeReasons: ["mandatory_verification_violated"],
        updatedAt: COMPLETED_AT,
      },
      testQualification(),
    );

    expect(projected.status).toBe("failed");
    expect(projected.runResult).toMatchObject({
      status: "failed",
      code: "file_effect_unknown",
    });
    expect(projected.verification).toEqual({
      status: "attention_required",
      snapshotRevision: 7,
      counts: [
        { state: "unassessed", count: 1 },
        { state: "violated", count: 1 },
      ],
      activeChecks: 0,
      gateStatus: "blocked_violated",
      waiting: false,
      recoveryNeeded: true,
      safeReasons: ["mandatory_verification_violated"],
      updatedAt: COMPLETED_AT,
    });
    expect(projected.runActions).toEqual([
      expect.objectContaining({
        runActionId: "run-action-1",
        status: "unknown_effect",
        observationId: "observation-1",
      }),
      expect.objectContaining({ runActionId: "run-action-2", status: "started" }),
    ]);
    expect(projected.effects).toEqual([
      expect.objectContaining({
        operationResultId: "operation-result-1",
        status: "unknown_effect",
        effectCertainty: "unknown",
      }),
    ]);
    expect(projected.actions).toEqual([
      expect.objectContaining({
        actionSettlementId: "action-settlement-1",
        status: "unknown_effect",
      }),
    ]);
    expect(projected.composites).toEqual([
      expect.objectContaining({
        compositeId: "composite-1",
        childCount: 2,
        settledChildCount: 1,
        unresolvedChildCount: 1,
      }),
    ]);
    expect(projected.uncertainty).toContain(
      "At least one external effect has unknown settlement.",
    );
    expect(projected.incompleteWork).toEqual(expect.arrayContaining([
      "Run ended with status 'failed'.",
      "One or more Operation effects remain partial or unresolved.",
      "One or more Run Actions have no terminal Observation.",
      "One or more composite Operations have unresolved child work.",
    ]));
  });
});

function testQualification() {
  return Object.freeze({
    providerKind: "openai-compatible",
    modelId: "test-model",
    modelIdentityStrength: "unknown" as const,
    status: "experimental" as const,
    policy: "allow_experimental" as const,
    experimentalUseSelected: true,
    scopes: Object.freeze([Object.freeze({
      scope: "agent_loop" as const,
      applicability: "absent" as const,
      outcome: null,
      decidedAt: null,
      limitations: Object.freeze([]),
    })]),
    reasons: Object.freeze(["scope_absent:agent_loop"]),
    toolGuidance: Object.freeze({
      releaseId: "test-guidance",
      releaseRevision: `sha256:${"0".repeat(64)}`,
      profileRevision: "test-profile.v1",
    }),
  });
}

function testInstructionBinding(runId: string) {
  return Object.freeze({
    id: `${runId}:agent-instruction-binding:0`,
    revision: `sha256:${"0".repeat(64)}`,
  });
}

function runAction(id: string, sequence: number, invocationId: string) {
  return {
    ref: { run: { id: "run-1" }, id, sequence },
    provenance: {
      kind: "automatic" as const,
      trigger: { owner: "helarc", operationId: invocationId },
    },
    subject: {
      kind: "operation" as const,
      invocationId,
      requestOrigin: "composite" as const,
    },
    basis: {
      runRevision: sequence - 1,
      activeAgentId: "helarc-code-agent",
      controllerProjectionRevision: null,
    },
    materializedAt: STARTED_AT,
  };
}
