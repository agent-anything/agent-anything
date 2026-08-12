import { describe, expect, it } from "vitest";
import {
  EvaluationCampaignExecution,
  createEvaluationCampaign,
  type EvaluationCampaignAggregationPort,
  type EvaluationCampaignSnapshot,
} from "./campaign/index.js";
import {
  assembleEvaluationCapture,
  createEvaluationCapturePolicy,
  type EvaluationCapture,
  type EvaluationCapturePort,
  type EvaluationCapturePolicy,
} from "./capture/index.js";
import {
  createEvaluationFailure,
  type EvaluationFailure,
  type EvaluationRecordRef,
} from "./definition/index.js";
import type {
  EvaluationAppendResult,
  EvaluationExpectedRevisionStore,
  EvaluationImmutableRecordStore,
  EvaluationStoreResult,
  EvaluationVersionedSnapshot,
} from "./persistence/index.js";
import {
  EvaluationTrialExecution,
  createEvaluationTargetObservation,
  createEvaluationTrial,
  type EvaluationClock,
  type EvaluationDeadlinePort,
  type EvaluationEnvironmentPort,
  type EvaluationTargetObservation,
  type EvaluationTargetPort,
  type EvaluationTrial,
  type EvaluationTrialExecutionDependencies,
  type EvaluationTrialSnapshot,
} from "./trial/index.js";

const TIME = "2026-08-01T00:00:00.000Z";

describe("Evaluation Trial execution", () => {
  it("treats a returned failed Product outcome as completed measured behavior", async () => {
    const fixture = createTrialFixture({ targetOutcome: "failed" });
    const result = await fixture.execution.run(control());

    expect(result.status).toBe("completed");
    expect(result.failures).toEqual([]);
    expect(fixture.targetRecords.records[0].outcome).toMatchObject({
      status: "failed",
      owner: "provider",
      code: "provider_request_failed",
    });
    expect(fixture.cleanupCalls).toHaveLength(1);
  });

  it.each([
    ["invalid", "invalid"],
    ["environment_failed", "infrastructure_failed"],
    ["invocation_failed", "invocation_failed"],
    ["capture_failed", "capture_failed"],
    ["cleanup_partial", "partial"],
  ] as const)("settles %s through its exact Trial terminal state", async (scenario, expected) => {
    const fixture = createTrialFixture({ scenario });
    const result = await fixture.execution.run(control());

    expect(result.status).toBe(expected);
    if (scenario !== "invalid" && scenario !== "environment_failed") {
      expect(fixture.cleanupCalls).toHaveLength(1);
    }
  });

  it("cancels an active target, rejects its late result, and cleans once", async () => {
    let release!: (value: ReturnType<typeof observedResult>) => void;
    let targetStarted!: () => void;
    const started = new Promise<void>((resolve) => { targetStarted = resolve; });
    const late: string[] = [];
    const fixture = createTrialFixture({
      target: {
        async invoke(input) {
          targetStarted();
          return new Promise((resolve) => { release = resolve; });
        },
      },
      lateResult(result) {
        late.push(`${result.operation}:${result.result}`);
      },
    });
    const controller = new AbortController();
    const running = fixture.execution.run({ signal: controller.signal, deadlineAt: null });
    await started;
    controller.abort("user_cancelled");
    const terminal = await running;

    expect(terminal.status).toBe("cancelled");
    expect(fixture.cleanupCalls).toHaveLength(1);
    release(observedResult(fixture.trial));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fixture.execution.snapshot.status).toBe("cancelled");
    expect(late).toEqual(["target:settled"]);
  });

  it("settles timeout without accepting a later operation result", async () => {
    const fixture = createTrialFixture({ deadline: new ImmediateDeadline() });
    const result = await fixture.execution.run({
      signal: new AbortController().signal,
      deadlineAt: TIME,
    });

    expect(result.status).toBe("timed_out");
    expect(result.failures.map((item) => item.code)).toContain("evaluation_timed_out");
  });

  it("does not fabricate a state transition on persistence conflict and still cleans", async () => {
    const stateStore = new MemorySnapshotStore<EvaluationTrialSnapshot>();
    stateStore.conflictOnCommit = 2;
    const fixture = createTrialFixture({ stateStore });

    await expect(fixture.execution.run(control())).rejects.toMatchObject({
      name: "EvaluationPersistenceError",
    });
    expect(fixture.execution.snapshot.status).toBe("preparing");
    expect(fixture.cleanupCalls).toHaveLength(1);
  });

  it("rejects unsafe or non-terminal target observations at admission", () => {
    const trial = createTrial("unsafe-observation");
    const valid = observedResult(trial).observation;

    expect(() => createEvaluationTargetObservation({
      ...valid,
      childRuns: [{ runId: "active-run", status: "running" } as never],
    })).toThrow(/unsupported/);
    expect(() => createEvaluationTargetObservation({
      ...valid,
      outcome: { ...valid.outcome, data: { rootPath: "D:/private/workspace" } },
    })).toThrow(/rootPath/);
  });

  it("classifies an invalid Capture revision as capture infrastructure failure", async () => {
    const fixture = createTrialFixture({ captureRefRevision: "v2" });
    const result = await fixture.execution.run(control());

    expect(result.status).toBe("capture_failed");
    expect(result.failures.map((item) => item.code)).toEqual([
      "evaluation_capture_failed",
    ]);
    expect(fixture.captureRecords.records).toEqual([]);
    expect(fixture.cleanupCalls).toHaveLength(1);
  });
});

describe("Evaluation Campaign execution", () => {
  it("plans distinct repetitions and observes bounded concurrency", async () => {
    const campaign = createCampaign({ repetitions: 2, maximumConcurrency: 2 });
    const campaignStore = new MemorySnapshotStore<EvaluationCampaignSnapshot>();
    const trialRecords = new MemoryRecordStore<EvaluationTrial>();
    let active = 0;
    let maximumActive = 0;
    const waiting: (() => void)[] = [];
    const result = await new EvaluationCampaignExecution(campaign, {
      stateStore: campaignStore,
      trialStore: trialRecords,
      trialIdentity: {
        createTrialRef(input) {
          return ref(`${input.targetSnapshotRef.id}:${input.caseRef.id}:${input.repetitionOrdinal}`);
        },
      },
      createTrialExecution(trial) {
        return createTrialFixture({
          trial,
          target: {
            async invoke() {
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              await new Promise<void>((resolve) => {
                waiting.push(resolve);
                if (waiting.length === 2) {
                  waiting.splice(0).forEach((release) => release());
                }
              });
              active -= 1;
              return observedResult(trial);
            },
          },
        }).execution;
      },
      aggregation: successfulAggregation(),
      clock: fixedClock(),
      deadline: new NeverDeadline(),
    }).run(control());

    expect(result.status).toBe("completed");
    expect(result.trialRefs).toHaveLength(4);
    expect(new Set(result.trialRefs.map((item) => item.id)).size).toBe(4);
    expect(trialRecords.records).toHaveLength(4);
    expect(maximumActive).toBe(2);
    expect(result.gradeRefs.map((item) => item.id)).toEqual(["grade"]);
    expect(result.metricRefs.map((item) => item.id)).toEqual(["metric-result"]);
    expect(result.reportRefs.map((item) => item.id)).toEqual(["report"]);
  });

  it("prevents new Trial starts after Campaign cancellation", async () => {
    const campaign = createCampaign({ repetitions: 3, maximumConcurrency: 1 });
    const campaignStore = new MemorySnapshotStore<EvaluationCampaignSnapshot>();
    const trialRecords = new MemoryRecordStore<EvaluationTrial>();
    const controller = new AbortController();
    let starts = 0;
    let targetStarted!: () => void;
    const started = new Promise<void>((resolve) => { targetStarted = resolve; });
    const execution = new EvaluationCampaignExecution(campaign, {
      stateStore: campaignStore,
      trialStore: trialRecords,
      trialIdentity: {
        createTrialRef(input) {
          return ref(`${input.targetSnapshotRef.id}:trial-${input.repetitionOrdinal}`);
        },
      },
      createTrialExecution(trial) {
        return createTrialFixture({
          trial,
          target: {
            async invoke() {
              starts += 1;
              targetStarted();
              return new Promise(() => undefined);
            },
          },
        }).execution;
      },
      aggregation: successfulAggregation(),
      clock: fixedClock(),
      deadline: new NeverDeadline(),
    });
    const running = execution.run({ signal: controller.signal, deadlineAt: null });
    await started;
    controller.abort();
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(starts).toBe(1);
    expect(result.completedTrialRefs).toHaveLength(1);
  });

  it("uses the Campaign duration deadline and prevents later Trial starts", async () => {
    const campaign = createCampaign({ repetitions: 3, maximumConcurrency: 1 });
    let starts = 0;
    const result = await new EvaluationCampaignExecution(campaign, {
      stateStore: new MemorySnapshotStore<EvaluationCampaignSnapshot>(),
      trialStore: new MemoryRecordStore<EvaluationTrial>(),
      trialIdentity: {
        createTrialRef(input) {
          return ref(`${input.targetSnapshotRef.id}:timed-${input.repetitionOrdinal}`);
        },
      },
      createTrialExecution(trial) {
        starts += 1;
        return createTrialFixture({ trial }).execution;
      },
      aggregation: successfulAggregation(),
      clock: fixedClock(),
      deadline: new ImmediateDeadline(),
    }).run(control());

    expect(result.status).toBe("timed_out");
    expect(starts).toBeLessThanOrEqual(1);
  });

  it("fails closed when Campaign aggregation returns an invalid record set", async () => {
    const campaign = createCampaign({ repetitions: 1, maximumConcurrency: 1 });
    const result = await new EvaluationCampaignExecution(campaign, {
      stateStore: new MemorySnapshotStore<EvaluationCampaignSnapshot>(),
      trialStore: new MemoryRecordStore<EvaluationTrial>(),
      trialIdentity: {
        createTrialRef: (input) => ref(`${input.targetSnapshotRef.id}:aggregation-trial`),
      },
      createTrialExecution: (trial) => createTrialFixture({ trial }).execution,
      aggregation: {
        async aggregate() {
          return {
            status: "aggregated",
            gradeRefs: [],
            metricRefs: [],
            reportRefs: [],
            failures: [],
          };
        },
      },
      clock: fixedClock(),
      deadline: new NeverDeadline(),
    }).run(control());

    expect(result.status).toBe("failed");
    expect(result.failures.map((item) => item.code)).toEqual([
      "evaluation_report_failed",
    ]);
    expect(result.reportRefs).toEqual([]);
  });
});

function createTrialFixture(options: {
  readonly trial?: EvaluationTrial;
  readonly scenario?:
    | "invalid"
    | "environment_failed"
    | "invocation_failed"
    | "capture_failed"
    | "cleanup_partial";
  readonly targetOutcome?: "succeeded" | "failed";
  readonly target?: EvaluationTargetPort;
  readonly deadline?: EvaluationDeadlinePort;
  readonly captureRefRevision?: string;
  readonly stateStore?: MemorySnapshotStore<EvaluationTrialSnapshot>;
  readonly lateResult?: (input: {
    readonly operation: "environment" | "target" | "capture";
    readonly result: "settled" | "failed";
  }) => void;
} = {}) {
  const trial = options.trial ?? createTrial("trial");
  const policy = createPolicy();
  const cleanupCalls: EvaluationRecordRef[] = [];
  const environment: EvaluationEnvironmentPort = {
    async prepare() {
      if (options.scenario === "invalid") {
        return {
          status: "invalid",
          failure: failure("evaluation_definition_invalid", "definition"),
        };
      }
      if (options.scenario === "environment_failed") {
        return {
          status: "failed",
          failure: failure("evaluation_environment_failed", "environment"),
        };
      }
      return {
        status: "prepared",
        lease: { ref: ref(`${trial.ref.id}:environment`), environmentFingerprint: "env-fingerprint", metadata: {} },
      };
    },
    async cleanup(input) {
      cleanupCalls.push(input.lease.ref);
      return options.scenario === "cleanup_partial"
        ? { status: "partial", failure: failure("evaluation_cleanup_failed", "cleanup") }
        : { status: "cleaned" };
    },
  };
  const target: EvaluationTargetPort = options.target ?? {
    async invoke() {
      if (options.scenario === "invocation_failed") {
        return { status: "failed", failure: failure("evaluation_invocation_failed", "invocation") };
      }
      return observedResult(trial, options.targetOutcome ?? "succeeded");
    },
  };
  const capture: EvaluationCapturePort = {
    async capture(request) {
      return assembleEvaluationCapture({
        ref: options.captureRefRevision === undefined
          ? request.captureRef
          : { ...request.captureRef, revision: options.captureRefRevision },
        trialRef: request.trialRef,
        targetSnapshotRef: request.targetSnapshotRef,
        caseRef: request.caseRef,
        policy,
        environmentRef: request.environmentRef,
        contributions: options.scenario === "capture_failed"
          ? []
          : [{
              slotId: "outcome",
              owner: "product",
              schemaRef: schema("product-outcome"),
              sensitivity: "internal",
              status: "captured",
              content: { kind: "inline", value: { observed: true } },
              reason: null,
            }],
        measurements: [],
        startedAt: TIME,
        completedAt: TIME,
        limitations: [],
        metadata: {},
      });
    },
  };
  const stateStore = options.stateStore ?? new MemorySnapshotStore<EvaluationTrialSnapshot>();
  const targetRecords = new MemoryRecordStore<EvaluationTargetObservation>();
  const captureRecords = new MemoryRecordStore<EvaluationCapture>();
  const dependencies: EvaluationTrialExecutionDependencies = {
    environment,
    target,
    capture,
    capturePolicy: policy,
    captureIdentity: {
      createCaptureRef: ({ trialRef }) => ({
        id: `${trialRef.id}:capture`,
        revision: trialRef.revision,
      }),
    },
    stateStore,
    targetObservationStore: targetRecords,
    captureStore: captureRecords,
    clock: fixedClock(),
    deadline: options.deadline ?? new NeverDeadline(),
    lateResultObserver: options.lateResult
      ? { observe: options.lateResult }
      : undefined,
  };
  return {
    trial,
    execution: new EvaluationTrialExecution(trial, dependencies),
    cleanupCalls,
    targetRecords,
    captureRecords,
  };
}

function createTrial(id: string): EvaluationTrial {
  return createEvaluationTrial({
    ref: ref(id),
    campaignRef: ref("campaign"),
    targetSnapshotRef: ref("target"),
    caseRef: ref("case"),
    repetitionOrdinal: 1,
    seed: "seed-1",
    pairingKey: "pair-1",
    environmentProtocolRef: ref("environment-protocol"),
    createdAt: TIME,
    metadata: {},
  });
}

function createCampaign(input: { repetitions: number; maximumConcurrency: number }) {
  return createEvaluationCampaign({
    ref: ref("campaign"),
    objectiveRef: ref("objective"),
    targetSnapshotRefs: [ref("target-b"), ref("target-a")],
    suiteRef: ref("suite"),
    caseRefs: [ref("case")],
    capturePolicyRef: ref("capture-policy"),
    graderDefinitionRefs: [ref("grader")],
    metricDefinitionRefs: [ref("metric")],
    environmentProtocolRef: ref("environment-protocol"),
    repetitions: input.repetitions,
    seedSchedule: Array.from({ length: input.repetitions }, (_, index) => `seed-${index + 1}`),
    pairing: {
      kind: "by_case",
      caseKeys: [{ caseRef: ref("case"), pairingKey: "pair-case" }],
    },
    budget: { maximumDurationMs: 60_000, maximumTrials: 20, maximumCost: null },
    maximumConcurrency: input.maximumConcurrency,
    intent: "baseline",
    createdAt: TIME,
    metadata: {},
  });
}

function createPolicy(): EvaluationCapturePolicy {
  return createEvaluationCapturePolicy({
    ref: ref("capture-policy"),
    slots: [{
      id: "outcome",
      owner: "product",
      schemaRef: schema("product-outcome"),
      required: true,
      maximumSensitivity: "internal",
      contentMode: "inline",
      retention: "report",
      maximumBytes: 2_048,
      optionalOmission: "complete",
      consumers: [{ kind: "grader", ref: ref("grader") }],
    }],
    createdAt: TIME,
    metadata: {},
    limitations: [],
  });
}

function observedResult(
  trial: EvaluationTrial,
  status: "succeeded" | "failed" = "succeeded",
) {
  return {
    status: "observed" as const,
    observation: createEvaluationTargetObservation({
      ref: ref(`${trial.ref.id}:observation`),
      trialRef: trial.ref,
      targetSnapshotRef: trial.targetSnapshotRef,
      caseRef: trial.caseRef,
      outcome: {
        status,
        owner: status === "failed" ? "provider" : "product",
        code: status === "failed" ? "provider_request_failed" : null,
        summary: status,
        data: {},
      },
      childRuns: [{ runId: `${trial.ref.id}:run`, status: status === "failed" ? "failed" : "succeeded" }],
      artifactRefs: [],
      observedAt: TIME,
      limitations: [],
      metadata: {},
    }),
  };
}

class MemorySnapshotStore<T extends EvaluationVersionedSnapshot>
  implements EvaluationExpectedRevisionStore<T> {
  readonly snapshots: T[] = [];
  conflictOnCommit: number | null = null;
  #commits = 0;

  async commit(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly snapshot: T;
  }): Promise<EvaluationStoreResult> {
    this.#commits += 1;
    const currentRevision = this.snapshots.at(-1)?.revision ?? 0;
    if (
      this.conflictOnCommit === this.#commits ||
      input.expectedRevision !== currentRevision
    ) {
      return {
        status: "conflict",
        currentRevision,
        failure: failure("evaluation_persistence_failed", "persistence"),
      };
    }
    this.snapshots.push(input.snapshot);
    return { status: "stored", persistedRevision: input.snapshot.revision };
  }
}

class MemoryRecordStore<T> implements EvaluationImmutableRecordStore<T> {
  readonly records: T[] = [];

  async append(record: T): Promise<EvaluationAppendResult> {
    this.records.push(record);
    return { status: "stored" };
  }
}

class NeverDeadline implements EvaluationDeadlinePort {
  waitUntil(_deadlineAt: string, signal: AbortSignal): Promise<void> {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("settled")), { once: true });
    });
  }
}

class ImmediateDeadline implements EvaluationDeadlinePort {
  async waitUntil(): Promise<void> {}
}

function fixedClock(): EvaluationClock {
  return { now: () => TIME };
}

function successfulAggregation(): EvaluationCampaignAggregationPort {
  return {
    async aggregate() {
      return {
        status: "aggregated",
        gradeRefs: [ref("grade")],
        metricRefs: [ref("metric-result")],
        reportRefs: [ref("report")],
        failures: [],
      };
    },
  };
}

function control() {
  return { signal: new AbortController().signal, deadlineAt: null };
}

function failure(
  code: EvaluationFailure["code"],
  stage: EvaluationFailure["stage"],
): EvaluationFailure {
  return createEvaluationFailure({
    code,
    stage,
    message: code,
    retryable: false,
    causeOwner: "test",
    details: {},
  });
}

function ref(id: string) {
  return { id, revision: "v1" };
}

function schema(schemaId: string) {
  return { schemaId, revision: "v1" };
}
