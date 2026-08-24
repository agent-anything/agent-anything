import { describe, expect, it } from "vitest";
import type { PendingRunSubjectProjection } from "../run/index.js";
import {
  assertRunProgressLimits,
  createInitialRunProgressState,
  projectRunProgress,
  type RunProgressBasis,
  type RunProgressLimits,
  type RunProgressSemanticFact,
} from "./RunProgress.js";
import { assessRunProgress } from "./RunProgressAssessment.js";
import {
  createRunProgressBasis,
  createRunProgressSemanticFacts,
  type RunProgressCommittedFactInput,
} from "./RunProgressFingerprint.js";

const limits: RunProgressLimits = {
  checkpointWindowSize: 3,
  nonAdvancingCheckpointThreshold: 2,
  maxCorrectionRounds: 2,
};

describe("Run Progress assessment", () => {
  it("distinguishes advancement, repetition, and non-advancing activity", async () => {
    const basis = await createBasis();
    const strong = fact("operation_result", "strong", "fact-a");
    const first = assess(createInitialRunProgressState(), basis, [strong]);
    expect(first.assessment).toMatchObject({
      disposition: "advanced",
      reasonCode: "new_trusted_fact",
      consecutiveNonAdvancingCheckpoints: 0,
    });

    const repeated = assess(first.state, basis, [strong]);
    expect(repeated.assessment).toMatchObject({
      disposition: "repeated",
      reasonCode: "equivalent_fact_repeated",
      consecutiveNonAdvancingCheckpoints: 1,
    });

    const activity = assess(
      repeated.state,
      basis,
      [fact("run_action", "activity", "new-activity")],
    );
    expect(activity.assessment).toMatchObject({
      disposition: "unchanged",
      reasonCode: "activity_without_structural_change",
      consecutiveNonAdvancingCheckpoints: 2,
    });
  });

  it("does not let Plan churn establish structural advancement", async () => {
    const planFacts = await createRunProgressSemanticFacts({
      kind: "plan_update",
      result: { status: "applied", transition: "updated", planId: "volatile-plan", version: 91 },
    });
    const result = assess(createInitialRunProgressState(), await createBasis(), planFacts);
    expect(result.assessment).toMatchObject({
      disposition: "unchanged",
      reasonCode: "plan_declaration_only",
    });
  });

  it("defers required pending work without consuming the non-progress streak", async () => {
    const basis = await createBasis();
    const unchanged = assess(
      createInitialRunProgressState(),
      basis,
      [fact("run_action", "activity", "activity")],
    );
    const pending: PendingRunSubjectProjection = {
      kind: "interaction",
      branchId: "branch-1",
      required: true,
      owner: "interaction",
      subjectId: "request-1",
      revision: "1",
    };
    const deferred = assessRunProgress({
      runId: "run-1",
      previousState: unchanged.state,
      basis,
      committedFacts: [],
      requiredPending: [pending],
      limits,
    });
    expect(deferred.assessment).toMatchObject({
      disposition: "deferred",
      reasonCode: "required_work_pending",
      consecutiveNonAdvancingCheckpoints: 1,
    });
  });

  it("opens a new comparison episode on basis change without fabricating advancement", async () => {
    const original = await createBasis();
    const first = assess(
      createInitialRunProgressState(),
      original,
      [fact("run_action", "activity", "same")],
    );
    const changed = await createBasis({ steeringFingerprint: digest("2") });
    const next = assess(first.state, changed, [fact("run_action", "activity", "same")]);
    expect(next.assessment).toMatchObject({
      disposition: "unchanged",
      reasonCode: "progression_basis_changed",
      basisChanged: true,
    });
  });

  it("retains a bounded comparison window and freezes authoritative output", async () => {
    const basis = await createBasis();
    let state = createInitialRunProgressState();
    for (const value of ["a", "b", "c", "d"]) {
      state = assess(state, basis, [fact("operation_result", "strong", value)]).state;
    }
    expect(state.recentCheckpoints).toHaveLength(3);
    expect(state.recentCheckpoints[0]?.factFingerprints).toEqual(["b"]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.recentCheckpoints)).toBe(true);
  });

  it("projects only bounded safe assessment fields", async () => {
    const basis = await createBasis();
    const result = assess(
      createInitialRunProgressState(),
      basis,
      [fact("operation_result", "strong", "secret-fingerprint")],
    );
    const projection = projectRunProgress(result.state, result.assessment);
    expect(projection).toMatchObject({ disposition: "advanced", checkpointSequence: 1 });
    expect(projection).not.toHaveProperty("basisFingerprint");
    expect(projection).not.toHaveProperty("recentCheckpoints");
    expect(JSON.stringify(projection)).not.toContain("secret-fingerprint");
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("rejects incoherent progress limits", () => {
    expect(() => assertRunProgressLimits({
      checkpointWindowSize: 2,
      nonAdvancingCheckpointThreshold: 3,
      maxCorrectionRounds: 1,
    })).toThrow("cannot exceed checkpointWindowSize");
    expect(() => assertRunProgressLimits({
      checkpointWindowSize: 2,
      nonAdvancingCheckpointThreshold: 1,
      maxCorrectionRounds: 0,
    })).toThrow("positive safe integer");
  });
});

describe("Run Progress semantic fingerprints", () => {
  it("covers every accepted current committed-fact family", async () => {
    const cases: readonly RunProgressCommittedFactInput[] = [
      { kind: "controller_turn", status: "decided", decisionKind: "advance", failureOwner: null, failureCode: null },
      { kind: "run_action", actionKind: "operation", requestOrigin: "controller_protocol" },
      { kind: "plan_update", result: { status: "no_change", planId: "plan-1", version: 1 } },
      { kind: "active_agent", previousAgent: { id: "agent-a", revision: "1" }, activeAgent: { id: "agent-b", revision: "1" } },
      { kind: "steering", steering: steering() },
      { kind: "operation_result", result: operationResult(), toolResult: null, ownerOutcome: null },
      { kind: "operation_rejected", owner: "operation-catalog", code: "invalid" },
      { kind: "tool_rejected", code: "tool_not_found" },
      { kind: "interaction_settlement", owner: "interaction", status: "resolved", lowerRefs: [], toolResult: null },
      { kind: "descendant_settlement", status: "succeeded", failureOwner: null, failureCode: null, lowerRefs: [], toolResult: toolResult() },
      { kind: "validation_feedback", validation: validationProjection() },
      { kind: "evidence_ref", ref: "evidence-1" },
      { kind: "artifact_ref", ref: "artifact-1" },
      { kind: "required_pending", pending: { kind: "interaction", branchId: "b", required: true, owner: "interaction", subjectId: "s", revision: "1" } },
    ];
    const kinds = (await Promise.all(cases.map(createRunProgressSemanticFacts)))
      .flat()
      .map((item) => item.ref.kind);
    expect(kinds).toEqual([
      "controller_turn", "run_action", "plan_update", "active_agent", "steering",
      "operation_result", "operation_rejected", "tool_rejected",
      "interaction_settlement", "descendant_settlement", "validation_feedback",
      "completion_gate", "evidence_ref", "artifact_ref", "required_pending",
    ]);
  });

  it("ignores volatile identity, time, metadata, output, and message fields", async () => {
    const first = await createRunProgressSemanticFacts({
      kind: "operation_result",
      result: operationResult({
        refId: "result-one",
        invocationId: "invocation-one",
        startedAt: "2026-01-01T00:00:00.000Z",
        output: { content: "first unrestricted output" },
        message: "first message",
      }),
      toolResult: null,
      ownerOutcome: null,
    });
    const second = await createRunProgressSemanticFacts({
      kind: "operation_result",
      result: operationResult({
        refId: "result-two",
        invocationId: "invocation-two",
        startedAt: "2027-02-02T00:00:00.000Z",
        output: { content: "different unrestricted output" },
        message: "different message",
      }),
      toolResult: null,
      ownerOutcome: null,
    });
    expect(first[0]?.fingerprint).toBe(second[0]?.fingerprint);
  });

  it("does not classify bare successful execution as a strong signal", async () => {
    const [result] = await createRunProgressSemanticFacts({
      kind: "operation_result",
      result: operationResult({ status: "succeeded", lowerRevision: null }),
      toolResult: null,
      ownerOutcome: null,
    });
    expect(result?.strength).toBe("activity");
  });

  it("requires an explicit owner outcome before success can be strong", async () => {
    const [result] = await createRunProgressSemanticFacts({
      kind: "operation_result",
      result: operationResult({ status: "succeeded" }),
      toolResult: null,
      ownerOutcome: {
        owner: "workspace",
        subjectId: "file:hello.txt",
        revision: "2",
        disposition: "state_changed",
        fingerprint: digest("c"),
      },
    });
    expect(result).toMatchObject({
      strength: "strong",
      ref: { owner: "workspace", subjectId: "file:hello.txt", revision: "2" },
    });
  });

  it("fails closed for an unknown future committed-fact family", async () => {
    const [result] = await createRunProgressSemanticFacts({ kind: "future_fact" } as never);
    expect(result).toMatchObject({
      strength: "activity",
      ref: { kind: "unsupported_committed_fact", owner: "agent-runtime" },
    });
  });
});

function assess(
  previousState: ReturnType<typeof createInitialRunProgressState>,
  basis: RunProgressBasis,
  committedFacts: readonly RunProgressSemanticFact[],
) {
  return assessRunProgress({
    runId: "run-1",
    previousState,
    basis,
    committedFacts,
    requiredPending: [],
    limits,
  });
}

async function createBasis(
  overrides: Partial<RunProgressBasis["projection"]> = {},
): Promise<RunProgressBasis> {
  return createRunProgressBasis({
    runId: "run-1",
    taskId: "task-1",
    activeAgent: { id: "agent-1", revision: "1" },
    workspaceFingerprint: digest("a"),
    toolSelectionRevision: "tools-1",
    permissionFingerprint: digest("b"),
    steeringFingerprint: null,
    validationSnapshotRevision: 0,
    ...overrides,
  });
}

function fact(
  kind: RunProgressSemanticFact["ref"]["kind"],
  strength: RunProgressSemanticFact["strength"],
  value: string,
): RunProgressSemanticFact {
  return Object.freeze({
    ref: Object.freeze({ kind, owner: "test", subjectId: "subject", revision: "1" }),
    strength,
    fingerprint: value,
  });
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function operationResult(overrides: {
  readonly refId?: string;
  readonly invocationId?: string;
  readonly startedAt?: string;
  readonly output?: unknown;
  readonly message?: string;
  readonly status?: "succeeded" | "failed";
  readonly lowerRevision?: string | null;
} = {}) {
  const status = overrides.status ?? "failed";
  const startedAt = overrides.startedAt ?? "2026-01-01T00:00:00.000Z";
  const base = {
    ref: {
      invocation: {
        id: overrides.invocationId ?? "invocation-1",
        operation: { operation: { namespace: "test", name: "read" }, revision: "1" },
      },
      id: overrides.refId ?? "result-1",
    },
    binding: {
      operation: { operation: { namespace: "test", name: "read" }, revision: "1" },
      revision: "binding-1",
    },
    semanticOwner: "test-owner",
    startedAt,
    finishedAt: startedAt,
    lowerRefs: [{ owner: "test-owner", kind: "snapshot", id: overrides.refId ?? "lower-1", revision: overrides.lowerRevision === undefined ? "revision-1" : overrides.lowerRevision }],
    metadata: { volatile: overrides.refId ?? "one" },
  };
  return (status === "succeeded"
    ? { ...base, status, output: overrides.output ?? { ok: true }, failure: null }
    : {
        ...base,
        status,
        output: null,
        failure: { owner: "test-owner", code: "read_failed", message: overrides.message ?? "failed", retryable: false, metadata: { volatile: true } },
      }) as never;
}

function toolResult() {
  return {
    toolCall: { toolCallId: "call-1", toolRevision: "1" },
    settlement: { owner: "operation-catalog", kind: "operation", id: "settlement-1", revision: "1" },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    status: "succeeded",
    output: { hidden: true },
  } as const;
}

function steering() {
  return {
    command: {
      commandId: "command-1",
      expectedRunRevision: 1,
      instruction: "Do something different.",
      attribution: { origin: "user" as const, actorId: "user-1" },
      submittedAt: "2026-01-01T00:00:00.000Z",
      ref: { run: { id: "run-1" }, id: "steering-1", sequence: 1 },
      acceptedRunRevision: 1,
    },
    status: "applied" as const,
    appliedInRunRevision: 2,
    supersededByCommandId: null,
    reasonCode: null,
  };
}

function validationProjection() {
  return {
    snapshot: { runId: "run-1", revision: 1 },
    feedback: [],
    pendingAttempts: [],
    gate: { id: "gate-1", revision: "1" },
  };
}
