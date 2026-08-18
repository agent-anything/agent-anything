import { describe, expect, it } from "vitest";

interface ValidationTrial {
  readonly id: string;
  readonly support: "supported" | "unsupported" | "infrastructure_failed";
  readonly checkAvailable: boolean | null;
  readonly executionCompleted: boolean | null;
  readonly evidenceAdmitted: boolean | null;
  readonly assessmentCorrect: boolean | null;
  readonly staleDetected: boolean | null;
  readonly falseAccepted: boolean | null;
  readonly falseRejected: boolean | null;
  readonly gateLatencyMs: number | null;
  readonly checkCostUnits: number | null;
  readonly downstreamSucceeded: boolean | null;
}

const TRIALS: readonly ValidationTrial[] = Object.freeze([
  Object.freeze({
    id: "satisfied-target",
    support: "supported",
    checkAvailable: true,
    executionCompleted: true,
    evidenceAdmitted: true,
    assessmentCorrect: true,
    staleDetected: null,
    falseAccepted: false,
    falseRejected: false,
    gateLatencyMs: 4,
    checkCostUnits: 0,
    downstreamSucceeded: true,
  }),
  Object.freeze({
    id: "stale-target",
    support: "supported",
    checkAvailable: true,
    executionCompleted: true,
    evidenceAdmitted: true,
    assessmentCorrect: true,
    staleDetected: true,
    falseAccepted: false,
    falseRejected: false,
    gateLatencyMs: 6,
    checkCostUnits: 0,
    downstreamSucceeded: false,
  }),
  Object.freeze({
    id: "unsupported-check",
    support: "unsupported",
    checkAvailable: null,
    executionCompleted: null,
    evidenceAdmitted: null,
    assessmentCorrect: null,
    staleDetected: null,
    falseAccepted: null,
    falseRejected: null,
    gateLatencyMs: null,
    checkCostUnits: null,
    downstreamSucceeded: null,
  }),
  Object.freeze({
    id: "environment-failed",
    support: "infrastructure_failed",
    checkAvailable: null,
    executionCompleted: null,
    evidenceAdmitted: null,
    assessmentCorrect: null,
    staleDetected: null,
    falseAccepted: null,
    falseRejected: null,
    gateLatencyMs: null,
    checkCostUnits: null,
    downstreamSucceeded: null,
  }),
]);

describe("Validation behavior Evaluation profile", () => {
  it("reports Validation dimensions separately and excludes unsupported infrastructure truth", () => {
    const included = TRIALS.filter(({ support }) => support === "supported");
    const metrics = Object.freeze({
      checkAvailability: rate(included, "checkAvailable"),
      executionCompletion: rate(included, "executionCompleted"),
      evidenceAdmission: rate(included, "evidenceAdmitted"),
      assessmentCorrectness: rate(included, "assessmentCorrect"),
      staleDetection: rate(included, "staleDetected"),
      falseAcceptance: rate(included, "falseAccepted"),
      falseRejection: rate(included, "falseRejected"),
      gateLatencyMs: mean(included, "gateLatencyMs"),
      checkCostUnits: mean(included, "checkCostUnits"),
      downstreamOutcome: rate(included, "downstreamSucceeded"),
      excluded: TRIALS.filter(({ support }) => support !== "supported")
        .map(({ id, support }) => Object.freeze({ id, reason: support })),
    });

    expect(metrics).toEqual({
      checkAvailability: 1,
      executionCompletion: 1,
      evidenceAdmission: 1,
      assessmentCorrectness: 1,
      staleDetection: 1,
      falseAcceptance: 0,
      falseRejection: 0,
      gateLatencyMs: 5,
      checkCostUnits: 0,
      downstreamOutcome: 0.5,
      excluded: [
        { id: "unsupported-check", reason: "unsupported" },
        { id: "environment-failed", reason: "infrastructure_failed" },
      ],
    });
  });
});

function rate<T extends keyof ValidationTrial>(
  trials: readonly ValidationTrial[],
  key: T,
): number | null {
  const values = trials.map((trial) => trial[key]).filter((value): value is boolean =>
    typeof value === "boolean");
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function mean<T extends keyof ValidationTrial>(
  trials: readonly ValidationTrial[],
  key: T,
): number | null {
  const values = trials.map((trial) => trial[key]).filter((value): value is number =>
    typeof value === "number");
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
