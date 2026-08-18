import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createOperationResult } from "@agent-anything/operation-catalog/result";
import { describe, expect, it } from "vitest";
import type { ValidationAssessmentDraft } from "./ValidationExecutionAdapters.js";
import {
  ValidationExecution,
  ValidationExecutionError,
  type CheckDefinition,
  type CheckResult,
  type ValidationCheckInterpretation,
  type ValidationExecutionDependencies,
  type ValidationLowerCheckSettlement,
} from "./index.js";
import {
  createValidationFailure,
  type ValidationOwnerRef,
  type ValidationRequirement,
} from "../definition/index.js";
import type {
  ValidationCurrentSnapshotStorePort,
  ValidationPersistenceRecord,
  ValidationRecordStorePort,
} from "../persistence/index.js";
import type {
  ValidationSubjectCaptureResult,
  ValidationSubjectFreshnessOutcome,
  ValidationSubjectSnapshot,
} from "../subject/index.js";

const RUN = { id: "run-1" } as const;
const NOW = "2026-08-18T00:00:00.000Z";
const SOURCE = owner("workspace-state");
const ADAPTER = owner("subject-adapter");
const EVALUATOR = owner("pure-evaluator");
const INTERPRETER = owner("result-interpreter");
const ASSESSMENT_METHOD = owner("assessment-method");

describe("Run-scoped ValidationExecution", () => {
  it("keeps Check completion, Evidence admission, and Assessment as separate commits", async () => {
    const persisted: string[] = [];
    const rig = createRig({
      recordStore: recordingRecordStore(persisted),
      currentSnapshotStore: recordingSnapshotStore(persisted),
    });
    await bootstrap(rig);

    const result = await runCheck(rig);
    expect(result.status).toBe("completed");
    expect(result.coverage.ratio).toBe(1);
    expect((await rig.execution.readCurrentSnapshot()).requirementStates[0]?.status).toBe("unassessed");

    const beforeEvidence = await revision(rig);
    await rig.execution.admitEvidence({
      evidence: evidence(result, 1),
      expectedRevision: beforeEvidence,
    }, liveInterruption());
    expect((await rig.execution.readCurrentSnapshot()).requirementStates[0]?.status).toBe("unassessed");

    const beforeAssessment = await revision(rig);
    const assessment = await rig.execution.assessRequirement({
      requirement: ref("requirement"),
      subject: ref("subject"),
      evidenceRefs: [ref("evidence")],
      expectedRevision: beforeAssessment,
    }, liveInterruption());

    expect(assessment.verdict).toBe("satisfied");
    expect(assessment.coverage.ratio).toBe(1);
    expect((await rig.execution.readCurrentSnapshot()).requirementStates[0]?.status).toBe("satisfied");
    const contextProjection = await rig.execution.projectContext({ maxPayloadBytes: 4_096 });
    expect(contextProjection.contribution?.payload).toMatchObject({
      kind: "structured",
      value: {
        requirements: [{ id: "requirement", status: "satisfied", pendingAttemptCount: 0 }],
      },
    });
    expect(JSON.stringify(contextProjection)).not.toContain("The required check passed");
    expect((await rig.execution.readHistory()).map((record) => record.kind)).toEqual([
      "specification", "requirement", "subject", "check_definition", "check_attempt",
      "check_finding", "check_result", "evidence", "assessment",
    ]);
    expect(persisted).toEqual([
      "record:specification", "record:requirement", "snapshot:1",
      "record:subject", "snapshot:2", "record:check_definition", "snapshot:3",
      "record:check_attempt", "snapshot:4", "record:check_finding",
      "record:check_result", "snapshot:5", "record:evidence", "snapshot:6",
      "record:assessment", "snapshot:7",
    ]);
  });

  it("serializes competing subject commits through expected revision", async () => {
    const capture = deferred<ValidationSubjectCaptureResult>();
    const rig = createRig({ capture: async () => capture.promise });
    await admitSpecification(rig);
    const request = {
      requirement: ref("requirement"),
      adapter: ADAPTER,
      kind: "workspace_source",
      requestedSource: SOURCE,
      expectedRevision: 1,
    } as const;

    const first = rig.execution.captureSubject(request, liveInterruption());
    const second = rig.execution.captureSubject(request, liveInterruption());
    capture.resolve({ status: "captured", snapshot: subject() });
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      failure: { code: "validation_revision_conflict" },
      currentRevision: 2,
    });
  });

  it("requires explicit partial coverage and never lets Evidence enlarge it", async () => {
    const rig = createRig({
      requirement: requirement({ coverage: { kind: "minimum", minimumRatio: 0.5 } }),
      evaluate: async () => partialInterpretation(),
    });
    await bootstrap(rig);
    const result = await runCheck(rig);

    expect(result.status).toBe("partial");
    expect(result.coverage.ratio).toBe(0.5);
    await expect(rig.execution.admitEvidence({
      evidence: evidence(result, 0.75),
      expectedRevision: await revision(rig),
    }, liveInterruption())).rejects.toMatchObject({
      failure: { code: "validation_evidence_coverage_exceeds_result" },
    });
  });

  it("settles failed and malformed checks without leaving false pending state", async () => {
    const failedRig = createRig({ evaluate: async () => failedInterpretation() });
    await bootstrap(failedRig);
    expect((await runCheck(failedRig)).status).toBe("failed");
    expect((await failedRig.execution.readCurrentSnapshot()).requirementStates[0]).toMatchObject({
      status: "unassessed",
      pendingAttempts: [],
    });

    const malformedRig = createRig({
      evaluate: async () => ({
        ...partialInterpretation(),
        coverage: { ratio: 1, basis: "not partial" },
        limitations: [],
      }),
    });
    await bootstrap(malformedRig);
    const malformed = await runCheck(malformedRig);
    expect(malformed).toMatchObject({
      status: "failed",
      coverage: { ratio: 0 },
      failure: { code: "validation_check_interpretation_invalid" },
    });
    expect((await malformedRig.execution.readCurrentSnapshot()).requirementStates[0]?.status).toBe("unassessed");
  });

  it("preserves Assessment history while changing only current state to stale", async () => {
    let freshness: ValidationSubjectFreshnessOutcome = {
      status: "current",
      snapshot: ref("subject"),
    };
    const rig = createRig({ freshness: async () => freshness });
    await bootstrap(rig);
    const result = await runCheck(rig);
    await rig.execution.admitEvidence({
      evidence: evidence(result, 1),
      expectedRevision: await revision(rig),
    }, liveInterruption());
    const assessment = await rig.execution.assessRequirement({
      requirement: ref("requirement"),
      subject: ref("subject"),
      evidenceRefs: [ref("evidence")],
      expectedRevision: await revision(rig),
    }, liveInterruption());
    freshness = {
      status: "stale",
      snapshot: ref("subject"),
      current: { id: "subject", revision: "v2" },
      change: owner("workspace-change"),
    };

    const stale = await rig.execution.checkSubjectFreshness({
      requirement: ref("requirement"),
      snapshot: ref("subject"),
      expectedRevision: await revision(rig),
    }, liveInterruption());

    expect(stale.requirementStates[0]).toMatchObject({
      status: "stale",
      assessment: assessment.ref,
      pendingAttempts: [],
    });
    expect((await rig.execution.readHistory()).filter((record) => record.kind === "assessment")).toHaveLength(1);
    await expect(runCheck(rig)).rejects.toMatchObject({
      failure: { code: "validation_check_subject_stale" },
    });
  });

  it("creates a linear Retry chain only for unchanged replay-eligible work", async () => {
    let calls = 0;
    const rig = createRig({
      evaluate: async () => ++calls === 1 ? failedInterpretation() : completedInterpretation(),
    });
    await bootstrap(rig);
    const first = await runCheck(rig);
    const predecessor = attemptFor(rig, first);

    await expect(runCheck(rig, {
      predecessor,
      environment: owner("different-environment"),
    })).rejects.toMatchObject({ failure: { code: "validation_retry_basis_changed" } });

    const retried = await runCheck(rig, { predecessor });
    expect(retried.status).toBe("completed");
    const attempts = (await rig.execution.readHistory())
      .filter((record) => record.kind === "check_attempt")
      .map((record) => record.record);
    expect(attempts.map((attempt) => attempt.ref.ordinal)).toEqual([1, 2]);
    expect(attempts[1]?.predecessor).toEqual(predecessor);

    await expect(runCheck(rig, { predecessor })).rejects.toMatchObject({
      failure: { code: "validation_retry_already_created" },
    });
  });

  it("routes operation-backed checks through one correlated owner settlement", async () => {
    let operationCalls = 0;
    let pureCalls = 0;
    const settlement = lowerSettlement("none");
    const rig = createRig({
      evaluate: async () => {
        pureCalls += 1;
        return completedInterpretation();
      },
      requestSettlement: async () => {
        operationCalls += 1;
        return settlement;
      },
    });
    await bootstrap(rig, effectfulDefinition());

    const result = await runCheck(rig, {
      runAction: { run: RUN, id: "run-action-1", sequence: 1 },
    });

    expect(operationCalls).toBe(1);
    expect(pureCalls).toBe(0);
    expect(result.operationResult).toEqual(settlement.operationResult.ref);
    expect(result.actionSettlement).toEqual(settlement.actionSettlement);
  });

  it("does not let an interpreter rewrite an unsuccessful lower Operation as completed", async () => {
    const lower = lowerSettlement("none", "denied");
    const rig = createRig({
      requestSettlement: async () => lower,
      interpret: async () => completedInterpretation(),
    });
    await bootstrap(rig, effectfulDefinition());

    const result = await runCheck(rig, {
      runAction: { run: RUN, id: "run-action-1", sequence: 1 },
    });

    expect(result).toMatchObject({
      status: "denied",
      findings: [],
      coverage: { ratio: 0 },
      failure: { code: "validation_check_operation_denied" },
    });
  });

  it("blocks Retry when lower effect certainty is unknown", async () => {
    const rig = createRig({
      requestSettlement: async () => lowerSettlement("unknown"),
      interpret: async () => failedInterpretation(),
    });
    await bootstrap(rig, effectfulDefinition());
    const first = await runCheck(rig, {
      runAction: { run: RUN, id: "run-action-1", sequence: 1 },
    });

    await expect(runCheck(rig, {
      predecessor: attemptFor(rig, first),
      runAction: { run: RUN, id: "run-action-2", sequence: 2 },
    })).rejects.toMatchObject({ failure: { code: "validation_retry_effect_unknown" } });
  });

  it("gives cancellation precedence over an adapter result that arrives afterward", async () => {
    const resultGate = deferred<ValidationCheckInterpretation>();
    const controller = new AbortController();
    const interruption = cancellationInterruption(controller);
    const rig = createRig({ evaluate: async () => resultGate.promise });
    await bootstrap(rig);

    const pending = runCheck(rig, {}, interruption);
    await waitForState(rig, "pending");
    controller.abort();
    resultGate.resolve(completedInterpretation());
    const result = await pending;

    expect(result).toMatchObject({
      status: "cancelled",
      findings: [],
      coverage: { ratio: 0 },
      failure: { code: "validation_check_cancelled" },
    });
    expect((await rig.execution.readCurrentSnapshot()).requirementStates[0]).toMatchObject({
      status: "unassessed",
      pendingAttempts: [],
    });
  });

  it("classifies output beyond the exact deadline as timed out", async () => {
    const clock = { value: NOW };
    const rig = createRig({
      clock,
      evaluate: async () => {
        clock.value = "2026-08-18T00:00:31.000Z";
        return completedInterpretation();
      },
    });
    await bootstrap(rig);

    expect(await runCheck(rig)).toMatchObject({
      status: "timed_out",
      coverage: { ratio: 0 },
      failure: { code: "validation_check_timed_out" },
    });
  });

  it("binds the stricter cost limit and fails closed when a check exceeds it", async () => {
    const rig = createRig({
      evaluate: async () => ({ ...completedInterpretation(), costUnits: 6 }),
    });
    await bootstrap(rig, { ...pureDefinition(), maximumCostUnits: 5 });

    const result = await runCheck(rig);
    expect(result).toMatchObject({
      status: "failed",
      costUnits: 6,
      failure: { code: "validation_check_cost_exceeded" },
    });
    const attempt = (await rig.execution.readHistory())
      .find((record) => record.kind === "check_attempt");
    expect(attempt?.kind === "check_attempt" ? attempt.record.costLimitUnits : null).toBe(5);
  });

  it("keeps post-close output as history without reviving current pending state", async () => {
    const resultGate = deferred<ValidationCheckInterpretation>();
    const rig = createRig({ evaluate: async () => resultGate.promise });
    await bootstrap(rig);
    const pending = runCheck(rig);
    await waitForState(rig, "pending");

    await rig.execution.closeCurrentState({
      expectedRevision: await revision(rig),
      closedAt: "2026-08-18T00:01:00.000Z",
    });
    resultGate.resolve(completedInterpretation());
    expect((await pending).status).toBe("completed");

    const ledger = await rig.execution.readLedgerSnapshot();
    expect(ledger.acceptingCurrentChanges).toBe(false);
    expect(ledger.current.requirementStates[0]).toMatchObject({
      status: "unassessed",
      pendingAttempts: [],
      limitations: ["validation_execution_closed"],
    });
    expect(ledger.results).toHaveLength(1);
  });

  it("records persistence failure without changing in-memory truth", async () => {
    const rig = createRig({
      recordStore: {
        append: async () => { throw new Error("store unavailable"); },
        readAll: async () => [],
      },
      currentSnapshotStore: {
        commit: async () => { throw new Error("store unavailable"); },
        read: async () => null,
      },
    });

    const snapshot = await admitSpecification(rig);
    expect(snapshot.ref.revision).toBe(1);
    expect(snapshot.requirementStates[0]?.status).toBe("unassessed");
    expect((await rig.execution.readPersistenceFailures()).map((item) => item.recordKind)).toEqual([
      "specification", "requirement", "current_snapshot",
    ]);
  });
});

interface RigOptions {
  readonly clock?: { value: string };
  readonly requirement?: ValidationRequirement;
  readonly capture?: () => Promise<ValidationSubjectCaptureResult>;
  readonly freshness?: () => Promise<ValidationSubjectFreshnessOutcome>;
  readonly evaluate?: () => Promise<ValidationCheckInterpretation>;
  readonly requestSettlement?: () => Promise<ValidationLowerCheckSettlement>;
  readonly interpret?: () => Promise<ValidationCheckInterpretation>;
  readonly assess?: () => Promise<ValidationAssessmentDraft>;
  readonly recordStore?: ValidationRecordStorePort;
  readonly currentSnapshotStore?: ValidationCurrentSnapshotStorePort;
}

interface Rig {
  readonly execution: ValidationExecution;
  readonly requirement: ValidationRequirement;
}

function createRig(options: RigOptions = {}): Rig {
  const counters = new Map<string, number>();
  const requirementRecord = options.requirement ?? requirement();
  const dependencies: ValidationExecutionDependencies = {
    clock: { now: () => options.clock?.value ?? NOW },
    identities: {
      nextId: (kind) => {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return `${kind}-${next}`;
      },
    },
    subjectAdapters: {
      resolve: (adapter) => adapter.id === ADAPTER.id ? {
        ref: ADAPTER,
        subjectKinds: ["workspace_source"],
        capture: async () => options.capture?.() ?? { status: "captured", snapshot: subject() },
        rehydrate: async () => ({ status: "captured", snapshot: subject() }),
      } : null,
    },
    subjectFreshness: {
      resolve: () => ({
        checkFreshness: async () => options.freshness?.() ?? {
          status: "current",
          snapshot: ref("subject"),
        },
      }),
    },
    pureChecks: {
      resolve: (evaluator) => evaluator.id === EVALUATOR.id ? {
        evaluate: async () => options.evaluate?.() ?? completedInterpretation(),
      } : null,
    },
    operationChecks: {
      resolve: () => ({
        requestSettlement: async () => options.requestSettlement?.() ?? lowerSettlement("none"),
      }),
    },
    interpreters: {
      resolve: (interpreter) => interpreter.id === INTERPRETER.id ? {
        interpret: async () => options.interpret?.() ?? completedInterpretation(),
      } : null,
    },
    assessmentMethods: {
      resolve: (method) => method.id === ASSESSMENT_METHOD.id ? {
        assess: async () => options.assess?.() ?? {
          verdict: "satisfied",
          basis: "Admitted Evidence satisfies the Requirement.",
          coverage: { ratio: 1, basis: "complete admitted evidence" },
          limitations: [],
        },
      } : null,
    },
    recordStore: options.recordStore,
    currentSnapshotStore: options.currentSnapshotStore,
  };
  return {
    execution: new ValidationExecution({ run: RUN }, dependencies),
    requirement: requirementRecord,
  };
}

async function bootstrap(rig: Rig, definition: CheckDefinition = pureDefinition()): Promise<void> {
  await admitSpecification(rig);
  await rig.execution.captureSubject({
    requirement: rig.requirement.ref,
    adapter: ADAPTER,
    kind: "workspace_source",
    requestedSource: SOURCE,
    expectedRevision: 1,
  }, liveInterruption());
  await rig.execution.admitCheckDefinition({
    definition,
    expectedRevision: 2,
  }, liveInterruption());
}

async function admitSpecification(rig: Rig) {
  return rig.execution.admitSpecification({
    specification: {
      ref: ref("specification"),
      run: RUN,
      source: trustedSource(),
      requirementRefs: [rig.requirement.ref],
      supersedes: null,
      admittedBy: owner("validation-admission"),
      createdAt: NOW,
    },
    requirements: [rig.requirement],
    expectedRevision: 0,
  }, liveInterruption());
}

async function runCheck(
  rig: Rig,
  overrides: Partial<{
    predecessor: { readonly id: string; readonly ordinal: number } | null;
    environment: ValidationOwnerRef | null;
    runAction: { readonly run: typeof RUN; readonly id: string; readonly sequence: number } | null;
  }> = {},
  interruption = liveInterruption(),
) {
  return rig.execution.executeCheck({
    requirement: rig.requirement.ref,
    subject: ref("subject"),
    definition: overrides.runAction ? ref("effectful-definition") : ref("pure-definition"),
    origin: "trusted_automatic",
    runAction: overrides.runAction ?? null,
    predecessor: overrides.predecessor ?? null,
    environment: overrides.environment ?? null,
    configuration: null,
    coverageTarget: 1,
    expectedRevision: await revision(rig),
  }, interruption);
}

function attemptFor(rig: Rig, result: CheckResult) {
  return result.attempt;
}

async function revision(rig: Rig): Promise<number> {
  return (await rig.execution.readCurrentSnapshot()).ref.revision;
}

async function waitForState(
  rig: Rig,
  expected: "pending",
): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    if ((await rig.execution.readCurrentSnapshot()).requirementStates[0]?.status === expected) return;
    await Promise.resolve();
  }
  throw new Error(`Validation state did not become ${expected}.`);
}

function requirement(
  overrides: Partial<Pick<ValidationRequirement, "coverage">> = {},
): ValidationRequirement {
  return {
    ref: ref("requirement"),
    specification: ref("specification"),
    source: trustedSource(),
    kind: "test",
    claim: "The workspace satisfies the required validation.",
    purpose: "Protect successful completion.",
    necessity: "mandatory",
    subjectKinds: ["workspace_source"],
    checkFamilies: ["command_validation"],
    assessmentMethod: ASSESSMENT_METHOD,
    freshness: { required: true, maximumAgeMs: 60_000 },
    coverage: overrides.coverage ?? { kind: "complete", minimumRatio: 1 },
    evidence: {
      minimumAdmittedCount: 1,
      acceptedSourceKinds: ["check_result"],
      conflictingEvidence: "inconclusive",
    },
    limits: { maximumAttempts: 2, maximumDurationMs: 60_000, maximumCostUnits: null },
    disclosure: { sensitivity: "internal", audiences: ["runner", "host"] },
    completionHandling: {
      unassessed: "continue",
      pending: "wait",
      violated: "block",
      inconclusive: "block",
      stale: "continue",
    },
    createdAt: NOW,
  };
}

function subject(): ValidationSubjectSnapshot {
  return {
    ref: ref("subject"),
    run: RUN,
    owner: "workspace",
    kind: "workspace_source",
    stateRefs: [SOURCE],
    capturedAt: NOW,
    environment: null,
    scope: [{ key: "workspace", value: "workspace-1" }],
    coverage: { kind: "complete", ratio: 1 },
    fingerprint: { algorithm: "sha256", value: "abc123", basis: "workspace revision" },
    sensitivity: "internal",
    audiences: ["validation"],
    adapter: ADAPTER,
  };
}

function pureDefinition(): CheckDefinition {
  return {
    ref: ref("pure-definition"),
    owner: "validation",
    family: "command_validation",
    requirementKinds: ["test"],
    subjectKinds: ["workspace_source"],
    acceptedOrigins: ["trusted_automatic"],
    effect: { kind: "pure", evaluator: EVALUATOR, operationBinding: null },
    resultInterpreter: INTERPRETER,
    environmentNeeds: [],
    maximumDurationMs: 30_000,
    maximumAttempts: 2,
    maximumCostUnits: null,
    retryPolicy: "safe",
    evidencePolicyRevision: "evidence-v1",
  };
}

function effectfulDefinition(): CheckDefinition {
  return {
    ...pureDefinition(),
    ref: ref("effectful-definition"),
    effect: {
      kind: "effectful",
      evaluator: null,
      operationBinding: {
        operation: {
          operation: { namespace: "validation", name: "run-check" },
          revision: "v1",
        },
        revision: "binding-v1",
      },
    },
  };
}

function completedInterpretation(): ValidationCheckInterpretation {
  return {
    status: "completed",
    findings: [{
      owner: "validation",
      claim: "The required check passed.",
      polarity: "supports",
      severity: "info",
      sourceRefs: [owner("check-output")],
      limitations: [],
    }],
    coverage: { ratio: 1, basis: "complete check" },
    costUnits: null,
    limitations: [],
    failure: null,
  };
}

function partialInterpretation(): ValidationCheckInterpretation {
  return {
    status: "partial",
    findings: [{
      owner: "validation",
      claim: "Only part of the required check completed.",
      polarity: "limits",
      severity: "warning",
      sourceRefs: [owner("partial-check-output")],
      limitations: ["coverage_incomplete"],
    }],
    coverage: { ratio: 0.5, basis: "partial check" },
    costUnits: null,
    limitations: ["coverage_incomplete"],
    failure: null,
  };
}

function failedInterpretation(): ValidationCheckInterpretation {
  return {
    status: "failed",
    findings: [],
    coverage: { ratio: 0, basis: "check failed" },
    costUnits: null,
    limitations: [],
    failure: createValidationFailure({
      code: "validation_check_failed",
      stage: "check",
      message: "The check failed.",
      retryable: true,
      cause: owner("check-owner-failure"),
    }),
  };
}

function lowerSettlement(
  effectCertainty: ValidationLowerCheckSettlement["effectCertainty"],
  status: "succeeded" | "denied" = "succeeded",
): ValidationLowerCheckSettlement {
  const operationInvocation = {
    id: "operation-invocation-1",
    operation: {
      operation: { namespace: "validation", name: "run-check" },
      revision: "v1",
    },
  } as const;
  return {
    operationInvocation,
    operationResult: createOperationResult({
      ref: { invocation: operationInvocation, id: "operation-result-1" },
      binding: { operation: operationInvocation.operation, revision: "binding-v1" },
      semanticOwner: "validation",
      status,
      output: status === "succeeded" ? { passed: true } : null,
      failure: status === "succeeded"
        ? null
        : {
            owner: "permission",
            code: "permission_denied",
            message: "Permission denied the Operation.",
            retryable: false,
            metadata: {},
          },
      startedAt: NOW,
      finishedAt: NOW,
      lowerRefs: [],
      metadata: {},
    }),
    actionSettlement: { action: { id: "canonical-action-1" }, id: "action-settlement-1" },
    effectCertainty,
    costUnits: 1,
  };
}

function evidence(result: CheckResult, ratio: number) {
  return {
    ref: ref("evidence"),
    requirement: ref("requirement"),
    subject: ref("subject"),
    source: { kind: "check_result" as const, result: result.ref },
    admission: { status: "admitted" as const, failure: null },
    coverage: { ratio, basis: "admitted Check Result coverage" },
    sensitivity: "internal" as const,
    audiences: ["validation"],
    limitations: ratio < 1 ? ["coverage_incomplete"] : [],
    createdAt: NOW,
  };
}

function liveInterruption(): InvocationInterruptionContext {
  return { signal: new AbortController().signal, interruption: null };
}

function cancellationInterruption(controller: AbortController): InvocationInterruptionContext {
  return {
    signal: controller.signal,
    interruption: {
      kind: "run_cancellation",
      cancellation: { runId: RUN.id, requestId: "cancel-1" },
    },
  };
}

function ref(id: string) {
  return { id, revision: "v1" };
}

function owner(id: string): ValidationOwnerRef {
  return { owner: "validation", kind: "record", id, revision: "v1" };
}

function trustedSource() {
  return { ...owner("trusted-source"), sourceKind: "task_contract" as const };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function recordingRecordStore(log: string[]): ValidationRecordStorePort {
  let sequence = 0;
  return {
    append: async (record: ValidationPersistenceRecord) => {
      log.push(`record:${record.kind}`);
      return {
        storeOwner: "validation-store",
        recordKind: record.kind,
        recordId: `record-${++sequence}`,
        sequence,
        storedAt: NOW,
      };
    },
    readAll: async () => [],
  };
}

function recordingSnapshotStore(log: string[]): ValidationCurrentSnapshotStorePort {
  let sequence = 100;
  return {
    commit: async (snapshot) => {
      log.push(`snapshot:${snapshot.ref.revision}`);
      return {
        storeOwner: "validation-store",
        recordKind: "current_snapshot",
        recordId: `snapshot-${snapshot.ref.revision}`,
        sequence: ++sequence,
        storedAt: NOW,
      };
    },
    read: async () => null,
  };
}
