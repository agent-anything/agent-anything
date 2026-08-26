import type { DelegationRunCorrelation } from "@agent-anything/agent-core/delegation";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type { RunItem, RunResult } from "../run/index.js";
import type { DelegationResourceSettlement } from "./DelegationResourceLedger.js";
import {
  createDelegationResult,
  type DelegationEffectSummary,
  type DelegationLimitDisposition,
  type DelegationResult,
  type DelegationUsageSummary,
  type DelegationValidationSummary,
} from "./DelegationResult.js";
import type { DelegationRequest } from "./DelegationRequest.js";

export interface DelegationResultConstructionInput {
  readonly resultId: string;
  readonly request: DelegationRequest;
  readonly correlation: DelegationRunCorrelation;
  readonly childResult: RunResult;
  readonly narrative: string | null;
  readonly resourceSettlement: DelegationResourceSettlement;
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
    validation: validationSummary(input.childResult.items),
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

function validationSummary(
  items: readonly RunItem[],
): DelegationValidationSummary {
  const projection = [...items].reverse().find(
    ({ payload }) => payload.kind === "validation_feedback",
  );
  if (projection === undefined || projection.payload.kind !== "validation_feedback") {
    return Object.freeze({
      status: "not_required" as const,
      snapshotRevision: null,
      mandatoryTotal: 0,
      mandatorySatisfied: 0,
      limitationCodes: Object.freeze([]),
    });
  }
  const validation = projection.payload.validation;
  const states = validation.feedback.map(({ state }) => state);
  const status = validation.pendingAttempts.length > 0 ||
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
  const limitationCodes = validation.feedback
    .filter(({ state }) => state !== "satisfied")
    .map(({ code }) => code)
    .filter((code, index, values) => values.indexOf(code) === index);
  return Object.freeze({
    status,
    snapshotRevision: `${validation.snapshot.runId}:${validation.snapshot.revision}`,
    mandatoryTotal: validation.feedback.length,
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
  settlement: DelegationResourceSettlement,
): DelegationUsageSummary {
  return Object.freeze({
    controllerTurns: Object.freeze({
      status: "measured" as const,
      value: settlement.usage.controllerTurns,
    }),
    actions: Object.freeze({
      status: "measured" as const,
      value: settlement.usage.actions,
    }),
    modelInputTokens: unavailableMeasurement(),
    modelOutputTokens: unavailableMeasurement(),
    costUnits: unavailableMeasurement(),
  });
}

function unavailableMeasurement() {
  return Object.freeze({
    status: "unavailable" as const,
    reason: "not_metered" as const,
  });
}

function limitDisposition(
  request: DelegationRequest,
  result: RunResult,
  settlement: DelegationResourceSettlement,
): DelegationLimitDisposition {
  const usage = settlement.usage;
  const durationMs = Math.max(
    0,
    Date.parse(result.completedAt) - Date.parse(result.startedAt),
  );
  const exhaustedLimit = usage.controllerTurns > request.limits.maxControllerTurns ||
      result.code === "runtime_limit_exceeded" &&
        usage.controllerTurns >= request.limits.maxControllerTurns
    ? "controller_turns" as const
    : usage.actions > request.limits.maxActions
      ? "actions" as const
      : durationMs > request.limits.maxDurationMs ||
          result.code === "runtime_deadline_exceeded"
        ? "duration" as const
        : usage.contextBytes > request.limits.maxContextBytes
          ? "context_bytes" as const
          : usage.resultBytes > request.limits.maxResultBytes ||
              settlement.status === "limit_exceeded"
            ? "result_bytes" as const
            : null;
  return Object.freeze({
    status: exhaustedLimit === null ? "within_limits" as const : "exhausted" as const,
    exhaustedLimit,
    controllerTurns: usage.controllerTurns,
    actions: usage.actions,
    durationMs,
    contextBytes: usage.contextBytes,
    resultBytes: usage.resultBytes,
  });
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
