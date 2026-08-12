import {
  compareText,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
} from "../contract/EvaluationData.js";
import {
  assertArray,
  assertIsoTime,
  assertPositiveInteger,
  assertToken,
  createEvaluationFailure,
  createEvaluationRecordRef,
  evaluationRefKey,
  snapshotRefs,
  type EvaluationFailure,
  type EvaluationRecordRef,
} from "../contract/EvaluationPrimitives.js";
import {
  runControlledOperation,
  type EvaluationDeadlinePort,
  type EvaluationOperationControl,
} from "../contract/ControlledOperation.js";
import {
  EvaluationPersistenceError,
  appendEvaluationRecord,
  commitEvaluationSnapshot,
  type EvaluationExpectedRevisionStore,
  type EvaluationImmutableRecordStore,
} from "../persistence/EvaluationPersistence.js";
import {
  createEvaluationTrial,
  type EvaluationClock,
  type EvaluationTrial,
  type EvaluationTrialExecution,
  type EvaluationTrialSnapshot,
  type EvaluationTrialStatus,
} from "../trial/EvaluationTrial.js";

export type EvaluationCampaignIntent = "baseline" | "comparison" | "regression";

export type EvaluationCampaignStatus =
  | "registered"
  | "running"
  | "aggregating"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface EvaluationPairingRule {
  readonly kind: "none" | "by_case";
  readonly caseKeys: readonly {
    readonly caseRef: EvaluationRecordRef;
    readonly pairingKey: string;
  }[];
}

export interface EvaluationCampaignBudget {
  readonly maximumDurationMs: number;
  readonly maximumTrials: number;
  readonly maximumCost: number | null;
}

export interface EvaluationCampaign {
  readonly ref: EvaluationRecordRef;
  readonly objectiveRef: EvaluationRecordRef;
  readonly targetSnapshotRefs: readonly EvaluationRecordRef[];
  readonly suiteRef: EvaluationRecordRef;
  readonly caseRefs: readonly EvaluationRecordRef[];
  readonly capturePolicyRef: EvaluationRecordRef;
  readonly graderDefinitionRefs: readonly EvaluationRecordRef[];
  readonly metricDefinitionRefs: readonly EvaluationRecordRef[];
  readonly environmentProtocolRef: EvaluationRecordRef;
  readonly repetitions: number;
  readonly seedSchedule: readonly string[];
  readonly pairing: EvaluationPairingRule;
  readonly budget: EvaluationCampaignBudget;
  readonly maximumConcurrency: number;
  readonly intent: EvaluationCampaignIntent;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
}

export interface EvaluationCampaignTransition {
  readonly from: EvaluationCampaignStatus;
  readonly to: EvaluationCampaignStatus;
  readonly revision: number;
  readonly occurredAt: string;
  readonly failure: EvaluationFailure | null;
}

export interface EvaluationCampaignSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly campaign: EvaluationCampaign;
  readonly status: EvaluationCampaignStatus;
  readonly trialRefs: readonly EvaluationRecordRef[];
  readonly completedTrialRefs: readonly EvaluationRecordRef[];
  readonly gradeRefs: readonly EvaluationRecordRef[];
  readonly metricRefs: readonly EvaluationRecordRef[];
  readonly reportRefs: readonly EvaluationRecordRef[];
  readonly failures: readonly EvaluationFailure[];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastTransition: EvaluationCampaignTransition | null;
}

export interface EvaluationTrialIdentityPort {
  createTrialRef(input: {
    readonly campaignRef: EvaluationRecordRef;
    readonly targetSnapshotRef: EvaluationRecordRef;
    readonly caseRef: EvaluationRecordRef;
    readonly repetitionOrdinal: number;
    readonly seed: string;
  }): EvaluationRecordRef;
}

export interface EvaluationCampaignAggregationResult {
  readonly status: "aggregated" | "partial" | "failed";
  readonly gradeRefs: readonly EvaluationRecordRef[];
  readonly metricRefs: readonly EvaluationRecordRef[];
  readonly reportRefs: readonly EvaluationRecordRef[];
  readonly failures: readonly EvaluationFailure[];
}

export interface EvaluationCampaignAggregationPort {
  aggregate(input: {
    readonly campaign: EvaluationCampaign;
    readonly trials: readonly EvaluationTrialSnapshot[];
    readonly signal: AbortSignal;
    readonly deadlineAt: string;
  }): Promise<EvaluationCampaignAggregationResult>;
}

export interface EvaluationCampaignExecutionDependencies {
  readonly stateStore: EvaluationExpectedRevisionStore<EvaluationCampaignSnapshot>;
  readonly trialStore: EvaluationImmutableRecordStore<EvaluationTrial>;
  readonly trialIdentity: EvaluationTrialIdentityPort;
  readonly createTrialExecution: (trial: EvaluationTrial) => EvaluationTrialExecution;
  readonly aggregation: EvaluationCampaignAggregationPort;
  readonly clock: EvaluationClock;
  readonly deadline: EvaluationDeadlinePort;
}

const TRANSITIONS: Readonly<Record<EvaluationCampaignStatus, readonly EvaluationCampaignStatus[]>> =
  Object.freeze({
    registered: campaignStatuses("running"),
    running: campaignStatuses("aggregating"),
    aggregating: campaignStatuses(
      "completed",
      "partial",
      "failed",
      "cancelled",
      "timed_out",
    ),
    completed: campaignStatuses(),
    partial: campaignStatuses(),
    failed: campaignStatuses(),
    cancelled: campaignStatuses(),
    timed_out: campaignStatuses(),
  });

export function createEvaluationCampaign(
  input: EvaluationCampaign,
): EvaluationCampaign {
  const targetSnapshotRefs = sortedRequiredRefs(
    input?.targetSnapshotRefs,
    "EvaluationCampaign.targetSnapshotRefs",
  );
  const caseRefs = sortedRequiredRefs(input.caseRefs, "EvaluationCampaign.caseRefs");
  assertPositiveInteger(input.repetitions, "EvaluationCampaign.repetitions");
  assertArray(input.seedSchedule, "EvaluationCampaign.seedSchedule");
  if (input.seedSchedule.length !== input.repetitions) {
    throw new TypeError("EvaluationCampaign.seedSchedule must match repetitions.");
  }
  const seeds = input.seedSchedule.map((seed, index) => {
    assertToken(seed, `EvaluationCampaign.seedSchedule[${index}]`);
    return seed;
  });
  if (new Set(seeds).size !== seeds.length) {
    throw new TypeError("EvaluationCampaign.seedSchedule must contain unique seeds.");
  }
  const pairing = snapshotPairing(input.pairing, caseRefs);
  const budget = snapshotBudget(input.budget);
  const plannedTrials = targetSnapshotRefs.length * caseRefs.length * input.repetitions;
  if (plannedTrials > budget.maximumTrials) {
    throw new TypeError("EvaluationCampaign matrix exceeds its Trial budget.");
  }
  assertPositiveInteger(input.maximumConcurrency, "EvaluationCampaign.maximumConcurrency");
  if (input.maximumConcurrency > budget.maximumTrials) {
    throw new TypeError("EvaluationCampaign.maximumConcurrency exceeds its Trial budget.");
  }
  if (!(["baseline", "comparison", "regression"] as const).includes(input.intent)) {
    throw new TypeError("EvaluationCampaign.intent is unsupported.");
  }
  assertIsoTime(input.createdAt, "EvaluationCampaign.createdAt");
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationCampaign.ref"),
    objectiveRef: createEvaluationRecordRef(
      input.objectiveRef,
      "EvaluationCampaign.objectiveRef",
    ),
    targetSnapshotRefs,
    suiteRef: createEvaluationRecordRef(input.suiteRef, "EvaluationCampaign.suiteRef"),
    caseRefs,
    capturePolicyRef: createEvaluationRecordRef(
      input.capturePolicyRef,
      "EvaluationCampaign.capturePolicyRef",
    ),
    graderDefinitionRefs: sortedRequiredRefs(
      input.graderDefinitionRefs,
      "EvaluationCampaign.graderDefinitionRefs",
    ),
    metricDefinitionRefs: sortedRequiredRefs(
      input.metricDefinitionRefs,
      "EvaluationCampaign.metricDefinitionRefs",
    ),
    environmentProtocolRef: createEvaluationRecordRef(
      input.environmentProtocolRef,
      "EvaluationCampaign.environmentProtocolRef",
    ),
    repetitions: input.repetitions,
    seedSchedule: Object.freeze(seeds),
    pairing,
    budget,
    maximumConcurrency: input.maximumConcurrency,
    intent: input.intent,
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationCampaign.metadata"),
  });
}

export function createInitialEvaluationCampaignSnapshot(
  campaign: EvaluationCampaign,
): EvaluationCampaignSnapshot {
  const admitted = createEvaluationCampaign(campaign);
  return Object.freeze({
    id: admitted.ref.id,
    revision: 0,
    campaign: admitted,
    status: "registered",
    trialRefs: Object.freeze([]),
    completedTrialRefs: Object.freeze([]),
    gradeRefs: Object.freeze([]),
    metricRefs: Object.freeze([]),
    reportRefs: Object.freeze([]),
    failures: Object.freeze([]),
    startedAt: null,
    completedAt: null,
    lastTransition: null,
  });
}

export function planEvaluationTrials(
  campaign: EvaluationCampaign,
  identity: EvaluationTrialIdentityPort,
): readonly EvaluationTrial[] {
  const trials: EvaluationTrial[] = [];
  const ids = new Set<string>();
  for (const targetSnapshotRef of campaign.targetSnapshotRefs) {
    for (const caseRef of campaign.caseRefs) {
      for (let repetitionOrdinal = 1; repetitionOrdinal <= campaign.repetitions; repetitionOrdinal += 1) {
        const seed = campaign.seedSchedule[repetitionOrdinal - 1];
        const trialRef = createEvaluationRecordRef(identity.createTrialRef({
          campaignRef: campaign.ref,
          targetSnapshotRef,
          caseRef,
          repetitionOrdinal,
          seed,
        }), "EvaluationTrialIdentityPort.createTrialRef");
        const key = evaluationRefKey(trialRef);
        if (ids.has(key)) throw new TypeError(`Evaluation Trial ref '${key}' is duplicated.`);
        ids.add(key);
        trials.push(createEvaluationTrial({
          ref: trialRef,
          campaignRef: campaign.ref,
          targetSnapshotRef,
          caseRef,
          repetitionOrdinal,
          seed,
          pairingKey: pairingKeyFor(campaign.pairing, caseRef),
          environmentProtocolRef: campaign.environmentProtocolRef,
          createdAt: campaign.createdAt,
          metadata: {},
        }));
      }
    }
  }
  return Object.freeze(trials);
}

export class EvaluationCampaignExecution {
  readonly #dependencies: EvaluationCampaignExecutionDependencies;
  #snapshot: EvaluationCampaignSnapshot;

  constructor(
    campaign: EvaluationCampaign,
    dependencies: EvaluationCampaignExecutionDependencies,
  ) {
    this.#snapshot = createInitialEvaluationCampaignSnapshot(campaign);
    this.#dependencies = dependencies;
  }

  get snapshot(): EvaluationCampaignSnapshot {
    return this.#snapshot;
  }

  async run(control: EvaluationOperationControl): Promise<EvaluationCampaignSnapshot> {
    if (this.#snapshot.status !== "registered") {
      throw new TypeError("Evaluation Campaign can be run only from registered state.");
    }
    const startedAt = this.#now();
    const budgetDeadlineAt = addMilliseconds(
      startedAt,
      this.#snapshot.campaign.budget.maximumDurationMs,
    );
    const deadlineAt = earlierIsoTime(control.deadlineAt, budgetDeadlineAt);
    const campaignControl = Object.freeze({ signal: control.signal, deadlineAt });
    const trials = planEvaluationTrials(this.#snapshot.campaign, this.#dependencies.trialIdentity);
    await this.#transition("running", null, {
      trialRefs: trials.map((trial) => trial.ref),
      startedAt,
    });

    for (const trial of trials) {
      await appendEvaluationRecord(this.#dependencies.trialStore, trial);
    }

    const deadlineController = new AbortController();
    let timedOut = false;
    const deadlineWatch = this.#dependencies.deadline.waitUntil(
      deadlineAt,
      deadlineController.signal,
    ).then(
      () => { timedOut = true; },
      () => undefined,
    );
    const outcomes: EvaluationTrialSnapshot[] = [];
    const failures: EvaluationFailure[] = [];
    let nextIndex = 0;
    const worker = async () => {
      while (!control.signal.aborted && !timedOut) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= trials.length) return;
        const trial = trials[index];
        try {
          outcomes.push(await this.#dependencies.createTrialExecution(trial).run(campaignControl));
        } catch (error) {
          if (!(error instanceof EvaluationPersistenceError)) throw error;
          failures.push(createEvaluationFailure(error.failure));
        }
      }
    };
    try {
      await Promise.all(Array.from(
        { length: Math.min(this.#snapshot.campaign.maximumConcurrency, trials.length) },
        () => worker(),
      ));
      const ordered = outcomes.sort((left, right) =>
        compareText(evaluationRefKey(left.trial.ref), evaluationRefKey(right.trial.ref)));
      await this.#transition("aggregating", failures[0] ?? null, {
        completedTrialRefs: ordered.map((item) => item.trial.ref),
        additionalFailures: failures.slice(1),
      });

      let aggregation: EvaluationCampaignAggregationResult | null = null;
      if (!control.signal.aborted && !timedOut) {
        const operation = await runControlledOperation(
          (signal) => this.#dependencies.aggregation.aggregate({
            campaign: this.#snapshot.campaign,
            trials: Object.freeze(ordered),
            signal,
            deadlineAt,
          }),
          campaignControl,
          this.#dependencies.deadline,
        );
        if (operation.status === "timed_out") {
          timedOut = true;
        } else if (operation.status === "settled") {
          try {
            aggregation = snapshotCampaignAggregationResult(operation.value);
          } catch {
            aggregation = failedCampaignAggregation(
              "Evaluation Campaign aggregation returned an invalid result.",
            );
          }
        } else if (operation.status === "failed") {
          aggregation = failedCampaignAggregation(
            "Evaluation Campaign aggregation adapter threw an exception.",
          );
        }
      }

      const status = campaignTerminalStatus(
        ordered.map((item) => item.status),
        trials.length,
        control.signal.aborted,
        timedOut,
        failures.length > 0,
        aggregation?.status ?? null,
      );
      return this.#transition(status, aggregation?.failures[0] ?? null, {
        gradeRefs: aggregation?.gradeRefs ?? [],
        metricRefs: aggregation?.metricRefs ?? [],
        reportRefs: aggregation?.reportRefs ?? [],
        additionalFailures: aggregation?.failures.slice(1) ?? [],
        completedAt: this.#now(),
      });
    } finally {
      deadlineController.abort("campaign_settled");
      await deadlineWatch;
    }
  }

  async #transition(
    to: EvaluationCampaignStatus,
    failure: EvaluationFailure | null,
    changes: {
      readonly trialRefs?: readonly EvaluationRecordRef[];
      readonly completedTrialRefs?: readonly EvaluationRecordRef[];
      readonly gradeRefs?: readonly EvaluationRecordRef[];
      readonly metricRefs?: readonly EvaluationRecordRef[];
      readonly reportRefs?: readonly EvaluationRecordRef[];
      readonly additionalFailures?: readonly EvaluationFailure[];
      readonly startedAt?: string;
      readonly completedAt?: string;
    } = {},
  ): Promise<EvaluationCampaignSnapshot> {
    const from = this.#snapshot.status;
    if (!TRANSITIONS[from].includes(to)) {
      throw new TypeError(`Evaluation Campaign transition '${from}' -> '${to}' is not allowed.`);
    }
    const revision = this.#snapshot.revision + 1;
    const occurredAt = this.#now();
    const transitionFailure = failure === null ? null : createEvaluationFailure(failure);
    const failures = [
      ...this.#snapshot.failures,
      ...(transitionFailure === null ? [] : [transitionFailure]),
      ...(changes.additionalFailures ?? []).map(createEvaluationFailure),
    ];
    const next = Object.freeze({
      ...this.#snapshot,
      revision,
      status: to,
      trialRefs: Object.freeze(changes.trialRefs ?? this.#snapshot.trialRefs),
      completedTrialRefs: Object.freeze(
        changes.completedTrialRefs ?? this.#snapshot.completedTrialRefs,
      ),
      gradeRefs: Object.freeze(changes.gradeRefs ?? this.#snapshot.gradeRefs),
      metricRefs: Object.freeze(changes.metricRefs ?? this.#snapshot.metricRefs),
      reportRefs: Object.freeze(changes.reportRefs ?? this.#snapshot.reportRefs),
      failures: Object.freeze(failures),
      startedAt: changes.startedAt ?? this.#snapshot.startedAt,
      completedAt: changes.completedAt ?? this.#snapshot.completedAt,
      lastTransition: Object.freeze({
        from,
        to,
        revision,
        occurredAt,
        failure: transitionFailure,
      }),
    }) satisfies EvaluationCampaignSnapshot;
    await commitEvaluationSnapshot(this.#dependencies.stateStore, next, this.#snapshot.revision);
    this.#snapshot = next;
    return next;
  }

  #now(): string {
    const value = this.#dependencies.clock.now();
    assertIsoTime(value, "EvaluationClock.now");
    return value;
  }
}

function snapshotPairing(
  input: EvaluationPairingRule,
  caseRefs: readonly EvaluationRecordRef[],
): EvaluationPairingRule {
  if (input?.kind !== "none" && input?.kind !== "by_case") {
    throw new TypeError("EvaluationPairingRule.kind is unsupported.");
  }
  assertArray(input.caseKeys, "EvaluationPairingRule.caseKeys");
  if (input.kind === "none" && input.caseKeys.length > 0) {
    throw new TypeError("Unpaired Campaign must not declare case pairing keys.");
  }
  const admitted = new Set(caseRefs.map(evaluationRefKey));
  const seen = new Set<string>();
  const caseKeys = input.caseKeys.map((entry, index) => {
    const caseRef = createEvaluationRecordRef(
      entry.caseRef,
      `EvaluationPairingRule.caseKeys[${index}].caseRef`,
    );
    const key = evaluationRefKey(caseRef);
    if (!admitted.has(key) || seen.has(key)) {
      throw new TypeError(`EvaluationPairingRule Case ref '${key}' is invalid or duplicated.`);
    }
    seen.add(key);
    assertToken(entry.pairingKey, `EvaluationPairingRule.caseKeys[${index}].pairingKey`);
    return Object.freeze({ caseRef, pairingKey: entry.pairingKey });
  });
  if (input.kind === "by_case" && seen.size !== caseRefs.length) {
    throw new TypeError("Paired Campaign must define one key for every Case.");
  }
  return Object.freeze({
    kind: input.kind,
    caseKeys: Object.freeze(caseKeys.sort((left, right) =>
      compareText(evaluationRefKey(left.caseRef), evaluationRefKey(right.caseRef)))),
  });
}

function snapshotBudget(input: EvaluationCampaignBudget): EvaluationCampaignBudget {
  assertPositiveInteger(input?.maximumDurationMs, "EvaluationCampaignBudget.maximumDurationMs");
  assertPositiveInteger(input.maximumTrials, "EvaluationCampaignBudget.maximumTrials");
  if (input.maximumCost !== null && (!Number.isFinite(input.maximumCost) || input.maximumCost < 0)) {
    throw new TypeError("EvaluationCampaignBudget.maximumCost must be non-negative or null.");
  }
  return Object.freeze({ ...input });
}

function sortedRequiredRefs(
  input: readonly EvaluationRecordRef[],
  path: string,
): readonly EvaluationRecordRef[] {
  const refs = snapshotRefs(input, path);
  if (refs.length === 0) throw new TypeError(`${path} must not be empty.`);
  return Object.freeze([...refs].sort((left, right) =>
    compareText(evaluationRefKey(left), evaluationRefKey(right))));
}

function pairingKeyFor(
  pairing: EvaluationPairingRule,
  caseRef: EvaluationRecordRef,
): string | null {
  return pairing.kind === "none"
    ? null
    : pairing.caseKeys.find((item) => evaluationRefKey(item.caseRef) === evaluationRefKey(caseRef))
      ?.pairingKey ?? null;
}

function campaignTerminalStatus(
  statuses: readonly EvaluationTrialStatus[],
  plannedCount: number,
  cancelled: boolean,
  timedOut: boolean,
  executionFailure: boolean,
  aggregationStatus: EvaluationCampaignAggregationResult["status"] | null,
): EvaluationCampaignStatus {
  if (cancelled) return "cancelled";
  if (timedOut) return "timed_out";
  if (aggregationStatus === "failed" || aggregationStatus === null) return "failed";
  if (aggregationStatus === "partial") return "partial";
  if (statuses.length < plannedCount || executionFailure) {
    return statuses.some((status) => status === "completed" || status === "partial")
      ? "partial"
      : "failed";
  }
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.every((status) => status === "timed_out")) return "timed_out";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.some((status) => status === "completed" || status === "partial")) {
    return "partial";
  }
  return "failed";
}

function snapshotCampaignAggregationResult(
  input: EvaluationCampaignAggregationResult,
): EvaluationCampaignAggregationResult {
  if (!(input?.status === "aggregated" || input?.status === "partial" || input?.status === "failed")) {
    throw new TypeError("Evaluation Campaign aggregation status is unsupported.");
  }
  const gradeRefs = sortedRefs(input.gradeRefs, "EvaluationCampaignAggregation.gradeRefs");
  const metricRefs = sortedRefs(input.metricRefs, "EvaluationCampaignAggregation.metricRefs");
  const reportRefs = sortedRefs(input.reportRefs, "EvaluationCampaignAggregation.reportRefs");
  assertArray(input.failures, "EvaluationCampaignAggregation.failures");
  const failures = Object.freeze(input.failures.map(createEvaluationFailure));
  if (failures.some((failure) => !AGGREGATION_FAILURE_STAGES.has(failure.stage))) {
    throw new TypeError("Evaluation Campaign aggregation carries a failure from another stage.");
  }
  if (
    input.status === "aggregated" &&
    (metricRefs.length === 0 || reportRefs.length === 0 || failures.length > 0)
  ) {
    throw new TypeError("Aggregated Evaluation Campaign result requires Metrics, a Report, and no failure.");
  }
  if (input.status !== "aggregated" && failures.length === 0) {
    throw new TypeError("Non-aggregated Evaluation Campaign result requires a failure.");
  }
  return Object.freeze({ status: input.status, gradeRefs, metricRefs, reportRefs, failures });
}

const AGGREGATION_FAILURE_STAGES = new Set<EvaluationFailure["stage"]>([
  "grading",
  "metric",
  "report",
  "persistence",
  "cancellation",
  "timeout",
]);

function failedCampaignAggregation(message: string): EvaluationCampaignAggregationResult {
  return Object.freeze({
    status: "failed",
    gradeRefs: Object.freeze([]),
    metricRefs: Object.freeze([]),
    reportRefs: Object.freeze([]),
    failures: Object.freeze([createEvaluationFailure({
      code: "evaluation_report_failed",
      stage: "report",
      message,
      retryable: false,
      causeOwner: "evaluation.campaign-aggregation",
      details: {},
    })]),
  });
}

function sortedRefs(
  input: readonly EvaluationRecordRef[],
  path: string,
): readonly EvaluationRecordRef[] {
  return Object.freeze([...snapshotRefs(input, path)].sort((left, right) =>
    compareText(evaluationRefKey(left), evaluationRefKey(right))));
}

function addMilliseconds(value: string, durationMs: number): string {
  const timestamp = Date.parse(value) + durationMs;
  const result = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(result.getTime())) {
    throw new TypeError("Evaluation Campaign duration produces an invalid deadline.");
  }
  return result.toISOString();
}

function earlierIsoTime(left: string | null, right: string): string {
  if (left === null) return right;
  assertIsoTime(left, "EvaluationOperationControl.deadlineAt");
  return left < right ? left : right;
}

function campaignStatuses(
  ...statuses: EvaluationCampaignStatus[]
): readonly EvaluationCampaignStatus[] {
  return Object.freeze(statuses);
}
