export const runTreeResourceDimensions = [
  "controllerTurns",
  "actions",
  "modelInputTokens",
  "modelOutputTokens",
  "costUnits",
  "contextBytes",
  "resultBytes",
] as const;

export type RunTreeResourceDimension = typeof runTreeResourceDimensions[number];

export interface RunTreeResourceLimit {
  readonly maximum: number;
  readonly enforcement: "hard" | "observational";
}

export type RunTreeResourceEnvelope = Readonly<
  Record<RunTreeResourceDimension, RunTreeResourceLimit>
>;

export type RunTreeResourceAmounts = Readonly<
  Record<RunTreeResourceDimension, number>
>;

export type RunTreeResourceMeasurement =
  | { readonly status: "measured"; readonly value: number }
  | { readonly status: "unavailable" }
  | { readonly status: "not_applicable" }
  | { readonly status: "unknown" };

export type RunTreeResourceUsage = Readonly<
  Record<RunTreeResourceDimension, RunTreeResourceMeasurement>
>;

export interface RunTreeResourceDimensionSnapshot {
  readonly capacity: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly released: number;
  readonly measurementStatus: RunTreeResourceMeasurement["status"];
  readonly enforcement: RunTreeResourceLimit["enforcement"];
}

export type RunTreeResourceSnapshot = Readonly<
  Record<RunTreeResourceDimension, RunTreeResourceDimensionSnapshot>
>;

export interface RunTreeNodeResourceSnapshot {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly allocation: RunTreeResourceAmounts;
  readonly remaining: RunTreeResourceAmounts;
  readonly usage: RunTreeResourceUsage;
  readonly settled: boolean;
  readonly revision: number;
}

export type RunTreeResourceReservation =
  | { readonly status: "accepted" }
  | {
      readonly status: "rejected";
      readonly code: "descendant_run_resource_limit_exceeded";
      readonly dimension: RunTreeResourceDimension;
    };

export type RunTreeResourceRecordResult =
  | { readonly status: "recorded" }
  | {
      readonly status: "limit_exceeded";
      readonly dimension: RunTreeResourceDimension;
    }
  | {
      readonly status: "measurement_unavailable";
      readonly dimension: RunTreeResourceDimension;
    };

export interface RunTreeResourceSettlement {
  readonly status: "settled" | "limit_exceeded" | "measurement_unavailable";
  readonly usage: RunTreeResourceUsage;
  readonly released: RunTreeResourceAmounts;
}

interface MutableNodeAccount {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly allocation: MutableAmounts;
  readonly remaining: MutableAmounts;
  readonly measured: MutableAmounts;
  readonly measurementStatus: MutableMeasurementStatus;
  settled: boolean;
  limitExceeded: boolean;
  revision: number;
  settlement: RunTreeResourceSettlement | null;
}

type MutableAmounts = Record<RunTreeResourceDimension, number>;
type MutableMeasurementStatus = Record<
  RunTreeResourceDimension,
  RunTreeResourceMeasurement["status"]
>;

export class RunTreeResourceAccount {
  private readonly envelope: RunTreeResourceEnvelope;
  private readonly nodes = new Map<string, MutableNodeAccount>();
  private readonly consumed = zeroAmounts();
  private readonly released = zeroAmounts();

  constructor(rootRunId: string, envelope: RunTreeResourceEnvelope) {
    token(rootRunId, "rootRunId");
    this.envelope = snapshotRunTreeResourceEnvelope(envelope);
    const allocation = envelopeAmounts(this.envelope);
    this.nodes.set(rootRunId, createNode(rootRunId, null, allocation));
  }

  reserve(
    parentRunId: string,
    childRunId: string,
    allocationInput: RunTreeResourceAmounts,
  ): RunTreeResourceReservation {
    const parent = this.requireActiveNode(parentRunId);
    token(childRunId, "childRunId");
    if (this.nodes.has(childRunId)) {
      throw new TypeError("Run Tree resources already contain the child Run.");
    }
    const requestedAllocation = snapshotRunTreeResourceAmounts(allocationInput);
    const exceeded = runTreeResourceDimensions.find(
      (dimension) => requestedAllocation[dimension] > 0 && parent.remaining[dimension] === 0,
    );
    if (exceeded !== undefined) {
      return Object.freeze({
        status: "rejected" as const,
        code: "descendant_run_resource_limit_exceeded" as const,
        dimension: exceeded,
      });
    }
    const allocation = Object.fromEntries(
      runTreeResourceDimensions.map((dimension) => [
        dimension,
        Math.min(requestedAllocation[dimension], parent.remaining[dimension]),
      ]),
    ) as MutableAmounts;
    for (const dimension of runTreeResourceDimensions) {
      parent.remaining[dimension] -= allocation[dimension];
    }
    parent.revision += 1;
    this.nodes.set(childRunId, createNode(childRunId, parentRunId, allocation));
    return Object.freeze({ status: "accepted" as const });
  }

  record(
    runId: string,
    usage: Partial<Record<RunTreeResourceDimension, RunTreeResourceMeasurement>>,
  ): RunTreeResourceRecordResult {
    const node = this.requireActiveNode(runId);
    let result: RunTreeResourceRecordResult = Object.freeze({ status: "recorded" as const });
    for (const dimension of runTreeResourceDimensions) {
      const measurement = usage[dimension];
      if (measurement === undefined) continue;
      assertMeasurement(measurement, dimension);
      if (measurement.status === "measured") {
        const previousRemaining = node.remaining[dimension];
        node.measured[dimension] = safeSum(
          node.measured[dimension],
          measurement.value,
          `${dimension} Run usage`,
        );
        this.consumed[dimension] = safeSum(
          this.consumed[dimension],
          measurement.value,
          `${dimension} tree usage`,
        );
        node.remaining[dimension] = Math.max(
          0,
          previousRemaining - measurement.value,
        );
        if (
          measurement.value > previousRemaining &&
          this.envelope[dimension].enforcement === "hard"
        ) {
          node.limitExceeded = true;
          result = Object.freeze({
            status: "limit_exceeded" as const,
            dimension,
          });
        }
        node.measurementStatus[dimension] = mergeStatus(
          node.measurementStatus[dimension],
          "measured",
        );
        continue;
      }
      node.measurementStatus[dimension] = mergeStatus(
        node.measurementStatus[dimension],
        measurement.status,
      );
      if (
        (measurement.status === "unavailable" || measurement.status === "unknown") &&
        this.envelope[dimension].enforcement === "hard"
      ) {
        result = Object.freeze({
          status: "measurement_unavailable" as const,
          dimension,
        });
      }
    }
    node.revision += 1;
    return result;
  }

  settle(runId: string): RunTreeResourceSettlement {
    const node = this.requireActiveNode(runId);
    if ([...this.nodes.values()].some(
      (candidate) => candidate.parentRunId === runId && !candidate.settled,
    )) {
      throw new TypeError("Run Tree resources cannot settle before child allocations.");
    }
    const released = zeroAmounts();
    let measurementUnavailable = false;
    for (const dimension of runTreeResourceDimensions) {
      const status = node.measurementStatus[dimension];
      const uncertain = status === "unavailable" || status === "unknown";
      if (uncertain) {
        const retained = node.remaining[dimension];
        this.consumed[dimension] = safeSum(
          this.consumed[dimension],
          retained,
          `${dimension} conservatively retained usage`,
        );
        node.remaining[dimension] = 0;
        measurementUnavailable ||= this.envelope[dimension].enforcement === "hard";
        continue;
      }
      released[dimension] = node.remaining[dimension];
      this.released[dimension] = safeSum(
        this.released[dimension],
        released[dimension],
        `${dimension} released capacity`,
      );
      if (node.parentRunId !== null) {
        const parent = this.requireActiveNode(node.parentRunId);
        parent.remaining[dimension] = safeSum(
          parent.remaining[dimension],
          released[dimension],
          `${dimension} parent remaining capacity`,
        );
        parent.revision += 1;
      }
      node.remaining[dimension] = 0;
    }
    node.settled = true;
    node.revision += 1;
    const settlement = Object.freeze({
      status: node.limitExceeded
        ? "limit_exceeded" as const
        : measurementUnavailable
          ? "measurement_unavailable" as const
          : "settled" as const,
      usage: this.nodeUsage(node),
      released: freezeAmounts(released),
    });
    node.settlement = settlement;
    return settlement;
  }

  getSettlement(runId: string): RunTreeResourceSettlement | null {
    return this.requireNode(runId).settlement;
  }

  getNodeSnapshot(runId: string): RunTreeNodeResourceSnapshot {
    const node = this.requireNode(runId);
    return Object.freeze({
      runId: node.runId,
      parentRunId: node.parentRunId,
      allocation: freezeAmounts(node.allocation),
      remaining: freezeAmounts(node.remaining),
      usage: this.nodeUsage(node),
      settled: node.settled,
      revision: node.revision,
    });
  }

  getSnapshot(rootRunId: string): RunTreeResourceSnapshot {
    const root = this.requireNode(rootRunId);
    const snapshot = {} as Record<RunTreeResourceDimension, RunTreeResourceDimensionSnapshot>;
    for (const dimension of runTreeResourceDimensions) {
      const reserved = [...this.nodes.values()]
        .filter((node) => node.runId !== rootRunId && !node.settled)
        .reduce((total, node) => safeSum(
          total,
          node.remaining[dimension],
          `${dimension} reserved projection`,
        ), 0);
      snapshot[dimension] = Object.freeze({
        capacity: this.envelope[dimension].maximum,
        consumed: this.consumed[dimension],
        reserved,
        remaining: root.remaining[dimension],
        released: this.released[dimension],
        measurementStatus: aggregateStatus(
          [...this.nodes.values()].map((node) => node.measurementStatus[dimension]),
        ),
        enforcement: this.envelope[dimension].enforcement,
      });
    }
    return Object.freeze(snapshot);
  }

  private nodeUsage(node: MutableNodeAccount): RunTreeResourceUsage {
    const usage = {} as Record<RunTreeResourceDimension, RunTreeResourceMeasurement>;
    for (const dimension of runTreeResourceDimensions) {
      const status = node.measurementStatus[dimension];
      usage[dimension] = status === "measured"
        ? Object.freeze({ status, value: node.measured[dimension] })
        : Object.freeze({ status });
    }
    return Object.freeze(usage);
  }

  private requireActiveNode(runId: string): MutableNodeAccount {
    const node = this.requireNode(runId);
    if (node.settled) {
      throw new TypeError("Run Tree resources are already settled for this Run.");
    }
    return node;
  }

  private requireNode(runId: string): MutableNodeAccount {
    const node = this.nodes.get(runId);
    if (node === undefined) {
      throw new TypeError(`Run '${runId}' has no Run Tree resource account.`);
    }
    return node;
  }
}

export function snapshotRunTreeResourceEnvelope(
  input: RunTreeResourceEnvelope,
): RunTreeResourceEnvelope {
  const result = {} as Record<RunTreeResourceDimension, RunTreeResourceLimit>;
  for (const dimension of runTreeResourceDimensions) {
    const limit = input?.[dimension];
    if (limit === null || typeof limit !== "object") {
      throw new TypeError(`RunTreeResourceEnvelope.${dimension} must be an object.`);
    }
    result[dimension] = Object.freeze({
      maximum: nonNegativeInteger(limit.maximum, `${dimension}.maximum`),
      enforcement: enforcement(limit.enforcement, `${dimension}.enforcement`),
    });
  }
  for (const dimension of ["controllerTurns", "actions", "contextBytes", "resultBytes"] as const) {
    if (result[dimension].enforcement !== "hard") {
      throw new TypeError(`${dimension} must use hard Run Tree enforcement.`);
    }
  }
  return Object.freeze(result);
}

export function snapshotRunTreeResourceAmounts(
  input: RunTreeResourceAmounts,
): RunTreeResourceAmounts {
  const result = {} as MutableAmounts;
  for (const dimension of runTreeResourceDimensions) {
    result[dimension] = nonNegativeInteger(input?.[dimension], dimension);
  }
  return freezeAmounts(result);
}

function createNode(
  runId: string,
  parentRunId: string | null,
  allocation: RunTreeResourceAmounts,
): MutableNodeAccount {
  return {
    runId,
    parentRunId,
    allocation: { ...allocation },
    remaining: { ...allocation },
    measured: zeroAmounts(),
    measurementStatus: Object.fromEntries(
      runTreeResourceDimensions.map((dimension) => [
        dimension,
        dimension === "modelInputTokens" || dimension === "modelOutputTokens" ||
            dimension === "costUnits"
          ? "not_applicable"
          : "measured",
      ]),
    ) as MutableMeasurementStatus,
    settled: false,
    limitExceeded: false,
    revision: 0,
    settlement: null,
  };
}

function envelopeAmounts(envelope: RunTreeResourceEnvelope): RunTreeResourceAmounts {
  return freezeAmounts(Object.fromEntries(
    runTreeResourceDimensions.map((dimension) => [dimension, envelope[dimension].maximum]),
  ) as MutableAmounts);
}

function zeroAmounts(): MutableAmounts {
  return Object.fromEntries(
    runTreeResourceDimensions.map((dimension) => [dimension, 0]),
  ) as MutableAmounts;
}

function freezeAmounts(input: MutableAmounts): RunTreeResourceAmounts {
  return Object.freeze({ ...input });
}

function mergeStatus(
  current: RunTreeResourceMeasurement["status"],
  next: RunTreeResourceMeasurement["status"],
): RunTreeResourceMeasurement["status"] {
  const precedence: readonly RunTreeResourceMeasurement["status"][] = [
    "not_applicable",
    "measured",
    "unavailable",
    "unknown",
  ];
  return precedence.indexOf(next) > precedence.indexOf(current) ? next : current;
}

function aggregateStatus(
  statuses: readonly RunTreeResourceMeasurement["status"][],
): RunTreeResourceMeasurement["status"] {
  return statuses.reduce(mergeStatus, "not_applicable");
}

function assertMeasurement(
  input: RunTreeResourceMeasurement,
  dimension: RunTreeResourceDimension,
): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError(`${dimension} measurement must be an object.`);
  }
  if (input.status === "measured") {
    nonNegativeInteger(input.value, `${dimension}.value`);
    return;
  }
  if (input.status !== "unavailable" && input.status !== "not_applicable" &&
      input.status !== "unknown") {
    throw new TypeError(`${dimension} measurement status is invalid.`);
  }
}

function nonNegativeInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return input as number;
}

function enforcement(
  input: unknown,
  field: string,
): RunTreeResourceLimit["enforcement"] {
  if (input !== "hard" && input !== "observational") {
    throw new TypeError(`${field} must be hard or observational.`);
  }
  return input;
}

function safeSum(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${field} exceeds the supported range.`);
  }
  return result;
}

function token(input: unknown, field: string): asserts input is string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
}
