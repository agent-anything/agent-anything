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

export type RunTreeResourceLimit =
  | {
      readonly enforcement: "hard";
      readonly maximum: number;
      readonly minimumChildGrant: number;
    }
  | {
      readonly enforcement: "observational";
      readonly threshold: number;
    };

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

export type RunTreeResourceDimensionSnapshot =
  | {
      readonly enforcement: "hard";
      readonly capacity: number;
      readonly measuredConsumed: number;
      readonly chargedUnknown: number;
      readonly activeReserved: number;
      readonly available: number;
      readonly cumulativeReleased: number;
      readonly measurementStatus: RunTreeResourceMeasurement["status"];
    }
  | {
      readonly enforcement: "observational";
      readonly threshold: number;
      readonly observed: number;
      readonly overage: number;
      readonly measurementStatus: RunTreeResourceMeasurement["status"];
    };

export type RunTreeResourceSnapshot = Readonly<
  Record<RunTreeResourceDimension, RunTreeResourceDimensionSnapshot>
>;

export interface RunTreeNodeResourceSnapshot {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly requestedAllocation: RunTreeResourceAmounts;
  readonly hardGrant: RunTreeResourceAmounts;
  readonly hardAvailable: RunTreeResourceAmounts;
  readonly observationalThresholds: RunTreeResourceAmounts;
  readonly delegationCeiling: RunTreeResourceAmounts;
  readonly usage: RunTreeResourceUsage;
  readonly settled: boolean;
  readonly revision: number;
}

export type RunTreeResourceReservation =
  | {
      readonly status: "accepted";
      readonly requestedAllocation: RunTreeResourceAmounts;
      readonly hardGrant: RunTreeResourceAmounts;
      readonly observationalThresholds: RunTreeResourceAmounts;
    }
  | {
      readonly status: "rejected";
      readonly code: "descendant_run_resource_limit_exceeded";
      readonly dimension: RunTreeResourceDimension;
      readonly reason: "insufficient_available" | "below_minimum_grant";
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
  readonly chargedUnknown: RunTreeResourceAmounts;
}

interface MutableNodeAccount {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly requestedAllocation: MutableAmounts;
  readonly hardGrant: MutableAmounts;
  readonly hardAvailable: MutableAmounts;
  readonly observationalThresholds: MutableAmounts;
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
  private readonly measuredConsumed = zeroAmounts();
  private readonly chargedUnknown = zeroAmounts();
  private readonly cumulativeReleased = zeroAmounts();
  private readonly observed = zeroAmounts();

  constructor(rootRunId: string, envelope: RunTreeResourceEnvelope) {
    token(rootRunId, "rootRunId");
    this.envelope = snapshotRunTreeResourceEnvelope(envelope);
    const requested = envelopeAmounts(this.envelope);
    this.nodes.set(rootRunId, createNode(rootRunId, null, requested, this.envelope));
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
    const requested = snapshotRunTreeResourceAmounts(allocationInput);
    for (const dimension of runTreeResourceDimensions) {
      const limit = this.envelope[dimension];
      if (limit.enforcement !== "hard") continue;
      if (requested[dimension] > parent.hardAvailable[dimension]) {
        return rejectedReservation(dimension, "insufficient_available");
      }
      if (
        requested[dimension] > 0 &&
        requested[dimension] < limit.minimumChildGrant
      ) {
        return rejectedReservation(dimension, "below_minimum_grant");
      }
    }

    const hardGrant = zeroAmounts();
    const observationalThresholds = zeroAmounts();
    for (const dimension of runTreeResourceDimensions) {
      const limit = this.envelope[dimension];
      if (limit.enforcement === "hard") {
        hardGrant[dimension] = requested[dimension];
        parent.hardAvailable[dimension] -= requested[dimension];
      } else {
        observationalThresholds[dimension] = requested[dimension];
      }
    }
    parent.revision += 1;
    this.nodes.set(
      childRunId,
      createNode(childRunId, parentRunId, requested, this.envelope),
    );
    return Object.freeze({
      status: "accepted" as const,
      requestedAllocation: freezeAmounts({ ...requested }),
      hardGrant: freezeAmounts(hardGrant),
      observationalThresholds: freezeAmounts(observationalThresholds),
    });
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
      const limit = this.envelope[dimension];
      node.measurementStatus[dimension] = mergeStatus(
        node.measurementStatus[dimension],
        measurement.status,
      );
      if (measurement.status !== "measured") {
        if (
          limit.enforcement === "hard" &&
          (measurement.status === "unavailable" || measurement.status === "unknown")
        ) {
          result = Object.freeze({
            status: "measurement_unavailable" as const,
            dimension,
          });
        }
        continue;
      }

      node.measured[dimension] = safeSum(
        node.measured[dimension],
        measurement.value,
        `${dimension} Run usage`,
      );
      if (limit.enforcement === "observational") {
        this.observed[dimension] = safeSum(
          this.observed[dimension],
          measurement.value,
          `${dimension} observed tree usage`,
        );
        continue;
      }

      const previousAvailable = node.hardAvailable[dimension];
      this.measuredConsumed[dimension] = safeSum(
        this.measuredConsumed[dimension],
        measurement.value,
        `${dimension} measured tree consumption`,
      );
      node.hardAvailable[dimension] = Math.max(
        0,
        previousAvailable - measurement.value,
      );
      if (measurement.value > previousAvailable) {
        node.limitExceeded = true;
        result = Object.freeze({ status: "limit_exceeded" as const, dimension });
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
    const chargedUnknown = zeroAmounts();
    let measurementUnavailable = false;
    for (const dimension of runTreeResourceDimensions) {
      const limit = this.envelope[dimension];
      if (limit.enforcement === "observational") continue;
      const status = node.measurementStatus[dimension];
      const uncertain = status === "unavailable" || status === "unknown";
      if (uncertain) {
        chargedUnknown[dimension] = node.hardAvailable[dimension];
        this.chargedUnknown[dimension] = safeSum(
          this.chargedUnknown[dimension],
          chargedUnknown[dimension],
          `${dimension} conservatively charged unknown consumption`,
        );
        node.hardAvailable[dimension] = 0;
        measurementUnavailable = true;
        continue;
      }

      released[dimension] = node.hardAvailable[dimension];
      this.cumulativeReleased[dimension] = safeSum(
        this.cumulativeReleased[dimension],
        released[dimension],
        `${dimension} cumulative release flow`,
      );
      if (node.parentRunId !== null) {
        const parent = this.requireActiveNode(node.parentRunId);
        parent.hardAvailable[dimension] = safeSum(
          parent.hardAvailable[dimension],
          released[dimension],
          `${dimension} parent available capacity`,
        );
        parent.revision += 1;
      }
      node.hardAvailable[dimension] = 0;
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
      chargedUnknown: freezeAmounts(chargedUnknown),
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
      requestedAllocation: freezeAmounts(node.requestedAllocation),
      hardGrant: freezeAmounts(node.hardGrant),
      hardAvailable: freezeAmounts(node.hardAvailable),
      observationalThresholds: freezeAmounts(node.observationalThresholds),
      delegationCeiling: freezeAmounts(delegationCeiling(node)),
      usage: this.nodeUsage(node),
      settled: node.settled,
      revision: node.revision,
    });
  }

  getSnapshot(rootRunId: string): RunTreeResourceSnapshot {
    const root = this.requireNode(rootRunId);
    const snapshot = {} as Record<RunTreeResourceDimension, RunTreeResourceDimensionSnapshot>;
    for (const dimension of runTreeResourceDimensions) {
      const limit = this.envelope[dimension];
      const status = aggregateStatus(
        [...this.nodes.values()].map((node) => node.measurementStatus[dimension]),
      );
      if (limit.enforcement === "observational") {
        snapshot[dimension] = Object.freeze({
          enforcement: "observational" as const,
          threshold: limit.threshold,
          observed: this.observed[dimension],
          overage: Math.max(0, this.observed[dimension] - limit.threshold),
          measurementStatus: status,
        });
        continue;
      }
      const activeReserved = [...this.nodes.values()]
        .filter((node) => node.runId !== rootRunId && !node.settled)
        .reduce(
          (total, node) => safeSum(
            total,
            node.hardAvailable[dimension],
            `${dimension} active reserved projection`,
          ),
          0,
        );
      snapshot[dimension] = Object.freeze({
        enforcement: "hard" as const,
        capacity: limit.maximum,
        measuredConsumed: this.measuredConsumed[dimension],
        chargedUnknown: this.chargedUnknown[dimension],
        activeReserved,
        available: root.hardAvailable[dimension],
        cumulativeReleased: this.cumulativeReleased[dimension],
        measurementStatus: status,
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
    if (limit.enforcement === "hard") {
      const maximum = nonNegativeInteger(limit.maximum, `${dimension}.maximum`);
      const minimumChildGrant = nonNegativeInteger(
        limit.minimumChildGrant,
        `${dimension}.minimumChildGrant`,
      );
      if (minimumChildGrant > maximum) {
        throw new TypeError(`${dimension}.minimumChildGrant cannot exceed maximum.`);
      }
      result[dimension] = Object.freeze({
        enforcement: "hard" as const,
        maximum,
        minimumChildGrant,
      });
    } else if (limit.enforcement === "observational") {
      result[dimension] = Object.freeze({
        enforcement: "observational" as const,
        threshold: nonNegativeInteger(limit.threshold, `${dimension}.threshold`),
      });
    } else {
      throw new TypeError(`${dimension}.enforcement must be hard or observational.`);
    }
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
  requested: RunTreeResourceAmounts,
  envelope: RunTreeResourceEnvelope,
): MutableNodeAccount {
  const hardGrant = zeroAmounts();
  const observationalThresholds = zeroAmounts();
  for (const dimension of runTreeResourceDimensions) {
    if (envelope[dimension].enforcement === "hard") {
      hardGrant[dimension] = requested[dimension];
    } else {
      observationalThresholds[dimension] = requested[dimension];
    }
  }
  return {
    runId,
    parentRunId,
    requestedAllocation: { ...requested },
    hardGrant,
    hardAvailable: { ...hardGrant },
    observationalThresholds,
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

function delegationCeiling(node: MutableNodeAccount): MutableAmounts {
  return Object.fromEntries(runTreeResourceDimensions.map((dimension) => [
    dimension,
    node.hardGrant[dimension] > 0 || node.observationalThresholds[dimension] === 0
      ? node.hardAvailable[dimension]
      : node.observationalThresholds[dimension],
  ])) as MutableAmounts;
}

function rejectedReservation(
  dimension: RunTreeResourceDimension,
  reason: "insufficient_available" | "below_minimum_grant",
): RunTreeResourceReservation {
  return Object.freeze({
    status: "rejected" as const,
    code: "descendant_run_resource_limit_exceeded" as const,
    dimension,
    reason,
  });
}

function envelopeAmounts(envelope: RunTreeResourceEnvelope): RunTreeResourceAmounts {
  return freezeAmounts(Object.fromEntries(
    runTreeResourceDimensions.map((dimension) => {
      const limit = envelope[dimension];
      return [dimension, limit.enforcement === "hard" ? limit.maximum : limit.threshold];
    }),
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
  if (
    input.status !== "unavailable" &&
    input.status !== "not_applicable" &&
    input.status !== "unknown"
  ) {
    throw new TypeError(`${dimension} measurement status is invalid.`);
  }
}

function nonNegativeInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return input as number;
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
