import type { DelegationRunCorrelation } from "@agent-anything/agent-core/delegation";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import { runSettlementCauseCode, type RunItem, type RunResult } from "../run/index.js";
import type {
  RunTreeResourceMeasurement,
  RunTreeResourceSettlement,
} from "../runner/RunTreeResourceAccount.js";
import {
  createDelegationResult,
  type DelegationEffectSummary,
  type DelegationLimitDisposition,
  type DelegationResult,
  type DelegationUsageSummary,
  type DelegationVerificationSummary,
} from "./DelegationResult.js";
import type { DelegationRequest } from "./DelegationRequest.js";

export interface DelegationResultConstructionInput {
  readonly resultId: string;
  readonly request: DelegationRequest;
  readonly correlation: DelegationRunCorrelation;
  readonly childResult: RunResult;
  readonly narrative: string | null;
  readonly resourceSettlement: RunTreeResourceSettlement;
  readonly createdAt: string;
}

export function constructDelegationResult(
  input: DelegationResultConstructionInput,
): DelegationResult {
  const usage = usageSummary(input.resourceSettlement);
  return createDelegationResult({
    resultId: input.resultId,
    request: input.request,
    correlation: input.correlation,
    childResult: input.childResult,
    narrative: input.narrative,
    verification: verificationSummary(input.childResult.items),
    effects: effectSummary(input.childResult.items),
    usage,
    limitDisposition: limitDisposition(
      input.request,
      input.childResult,
      input.resourceSettlement,
    ),
    createdAt: input.createdAt,
  });
}

function verificationSummary(
  items: readonly RunItem[],
): DelegationVerificationSummary {
  const projection = [...items].reverse().find(
    ({ payload }) => payload.kind === "verification_feedback",
  );
  if (projection === undefined || projection.payload.kind !== "verification_feedback") {
    return Object.freeze({
      status: "not_required" as const,
      snapshotRevision: null,
      mandatoryTotal: 0,
      mandatorySatisfied: 0,
      limitationCodes: Object.freeze([]),
    });
  }
  const verification = projection.payload.verification;
  const mandatory = verification.feedback.filter(({ necessity }) => necessity === "mandatory");
  const states = mandatory.map(({ state }) => state);
  const status = mandatory.some(({ activeAttempts }) => activeAttempts.length > 0) ||
      states.some((state) => state === "pending" || state === "unassessed")
    ? "pending" as const
    : states.some((state) => state === "violated")
      ? "violated" as const
      : states.some((state) => state === "inconclusive")
        ? "inconclusive" as const
        : states.some((state) => state === "stale")
          ? "stale" as const
          : states.length === 0
            ? "not_required" as const
            : "satisfied" as const;
  const limitationCodes = mandatory
    .filter(({ state }) => state !== "satisfied")
    .flatMap(({ reasonCodes }) => reasonCodes)
    .filter((code, index, values) => values.indexOf(code) === index);
  return Object.freeze({
    status,
    snapshotRevision: `${verification.snapshot.runId}:${verification.snapshot.revision}`,
    mandatoryTotal: mandatory.length,
    mandatorySatisfied: states.filter((state) => state === "satisfied").length,
    limitationCodes: Object.freeze(limitationCodes),
  });
}

function effectSummary(items: readonly RunItem[]): DelegationEffectSummary {
  const results = items.flatMap(({ payload }) =>
    payload.kind === "observation" && payload.observation.payload.kind === "operation"
      ? [payload.observation.payload.result]
      : []
  ).filter(hasCanonicalActionSettlement);
  if (results.length === 0) {
    return Object.freeze({
      status: "none" as const,
      attempted: 0,
      settled: 0,
      uncertain: 0,
      settlementRefs: Object.freeze([]),
    });
  }
  const uncertainty = results.filter((result) => {
    const certainty = effectCertainty(result);
    return certainty === "partial" || certainty === "unknown";
  }).length;
  const settlementRefs = results.flatMap((result) =>
    result.lowerRefs
      .filter(({ owner, kind }) => owner === "canonical-action" && kind === "action_settlement")
      .map(({ id }) => id)
  ).filter((ref, index, values) => values.indexOf(ref) === index);
  return Object.freeze({
    status: uncertainty === 0
      ? "known" as const
      : uncertainty === results.length
        ? "unknown" as const
        : "partial" as const,
    attempted: results.length,
    settled: results.length - uncertainty,
    uncertain: uncertainty,
    settlementRefs: Object.freeze(settlementRefs),
  });
}

function usageSummary(
  settlement: RunTreeResourceSettlement,
): DelegationUsageSummary {
  return Object.freeze({
    controllerTurns: Object.freeze({
      status: "measured" as const,
      value: measured(settlement.usage.controllerTurns, "controllerTurns"),
    }),
    actions: Object.freeze({
      status: "measured" as const,
      value: measured(settlement.usage.actions, "actions"),
    }),
    modelInputTokens: delegationMeasurement(settlement.usage.modelInputTokens),
    modelOutputTokens: delegationMeasurement(settlement.usage.modelOutputTokens),
    costUnits: delegationMeasurement(settlement.usage.costUnits),
  });
}

function delegationMeasurement(input: RunTreeResourceMeasurement) {
  return input.status === "measured"
    ? Object.freeze({ status: "measured" as const, value: input.value })
    : Object.freeze({
        status: "unavailable" as const,
        reason: input.status === "not_applicable"
          ? "not_applicable" as const
          : "provider_omitted" as const,
      });
}

function limitDisposition(
  request: DelegationRequest,
  result: RunResult,
  settlement: RunTreeResourceSettlement,
): DelegationLimitDisposition {
  const usage = settlement.usage;
  const controllerTurns = measured(usage.controllerTurns, "controllerTurns");
  const actions = measured(usage.actions, "actions");
  const contextBytes = measured(usage.contextBytes, "contextBytes");
  const resultBytes = measured(usage.resultBytes, "resultBytes");
  const durationMs = Math.max(
    0,
    Date.parse(result.completedAt) - Date.parse(result.startedAt),
  );
  const terminalCode = runSettlementCauseCode(result.cause);
  const exhaustedLimit = controllerTurns > request.limits.maxControllerTurns ||
      terminalCode === "runtime_limit_exceeded" &&
        controllerTurns >= request.limits.maxControllerTurns
    ? "controller_turns" as const
    : actions > request.limits.maxActions
      ? "actions" as const
      : exceeds(usage.modelInputTokens, request.limits.maxModelInputTokens)
        ? "model_input_tokens" as const
        : exceeds(usage.modelOutputTokens, request.limits.maxModelOutputTokens)
          ? "model_output_tokens" as const
          : exceeds(usage.costUnits, request.limits.maxCostUnits)
            ? "cost_units" as const
      : durationMs > request.limits.maxDurationMs ||
          terminalCode === "runtime_deadline_exceeded"
        ? "duration" as const
        : contextBytes > request.limits.maxContextBytes
          ? "context_bytes" as const
          : resultBytes > request.limits.maxResultBytes ||
              settlement.status === "limit_exceeded"
            ? "result_bytes" as const
            : null;
  return Object.freeze({
    status: exhaustedLimit === null ? "within_limits" as const : "exhausted" as const,
    exhaustedLimit,
    controllerTurns,
    actions,
    durationMs,
    contextBytes,
    resultBytes,
  });
}

function measured(input: RunTreeResourceMeasurement, field: string): number {
  if (input.status !== "measured") {
    throw new TypeError(`Delegation ${field} usage must be measured.`);
  }
  return input.value;
}

function exceeds(input: RunTreeResourceMeasurement, maximum: number): boolean {
  return input.status === "measured" && input.value > maximum;
}

function hasCanonicalActionSettlement(result: OperationResult): boolean {
  return result.lowerRefs.some(
    ({ owner, kind }) => owner === "canonical-action" && kind === "action_settlement",
  );
}

function effectCertainty(
  result: OperationResult,
): "none" | "confirmed" | "partial" | "unknown" {
  const value = result.metadata.effectCertainty;
  if (value === "none" || value === "confirmed" || value === "partial" || value === "unknown") {
    return value;
  }
  if (result.status === "succeeded") return "confirmed";
  if (result.status === "partial") return "partial";
  if (result.status === "unknown_effect") return "unknown";
  return "none";
}
