import {
  snapshotDelegationRequestRef,
  snapshotDelegationResultRef,
  snapshotDelegationRunCorrelation,
  type DelegationResultRef,
  type DelegationRunCorrelation,
} from "@agent-anything/agent-core/delegation";
import type { ArtifactRef } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "@agent-anything/context/evidence";
import type { RunResult, RunResultStatus } from "../run/index.js";
import {
  createDelegationContractIdentity,
  deepFreeze,
  isoDateTime,
  nonNegativeInteger,
  strictRecord,
  token,
} from "./DelegationContract.js";
import type {
  DelegationExpectedResultForm,
  DelegationLimits,
  DelegationRequest,
} from "./DelegationRequest.js";
import {
  snapshotDelegationLimits,
  snapshotDelegationRequest,
} from "./DelegationRequest.js";

export type DelegationVerificationStatus =
  | "not_required"
  | "pending"
  | "satisfied"
  | "violated"
  | "inconclusive"
  | "stale"
  | "unavailable";

export interface DelegationVerificationSummary {
  readonly status: DelegationVerificationStatus;
  readonly snapshotRevision: string | null;
  readonly mandatoryTotal: number;
  readonly mandatorySatisfied: number;
  readonly limitationCodes: readonly string[];
}

export type DelegationEffectStatus = "none" | "known" | "partial" | "unknown";

export interface DelegationEffectSummary {
  readonly status: DelegationEffectStatus;
  readonly attempted: number;
  readonly settled: number;
  readonly uncertain: number;
  readonly settlementRefs: readonly string[];
}

export type DelegationUsageUnavailableReason =
  | "not_metered"
  | "provider_omitted"
  | "not_applicable";

export type DelegationUsageMeasurement =
  | { readonly status: "measured"; readonly value: number }
  | {
      readonly status: "unavailable";
      readonly reason: DelegationUsageUnavailableReason;
    };

export interface DelegationUsageSummary {
  readonly controllerTurns: DelegationUsageMeasurement;
  readonly actions: DelegationUsageMeasurement;
  readonly modelInputTokens: DelegationUsageMeasurement;
  readonly modelOutputTokens: DelegationUsageMeasurement;
  readonly costUnits: DelegationUsageMeasurement;
}

export type DelegationLimitKind =
  | "controller_turns"
  | "actions"
  | "model_input_tokens"
  | "model_output_tokens"
  | "cost_units"
  | "duration"
  | "context_bytes"
  | "result_bytes";

export interface DelegationLimitDisposition {
  readonly status: "within_limits" | "exhausted";
  readonly exhaustedLimit: DelegationLimitKind | null;
  readonly controllerTurns: number;
  readonly actions: number;
  readonly durationMs: number;
  readonly contextBytes: number;
  readonly resultBytes: number;
}

export interface DelegationReferenceTransfer<TRef extends string> {
  readonly refs: readonly TRef[];
  readonly totalCount: number;
  readonly omittedCount: number;
}

export interface DelegationResultExpectationCoverage {
  readonly form: DelegationExpectedResultForm;
  readonly required: boolean;
  readonly disposition: "present" | "absent" | "failed" | "unavailable";
  readonly itemCount: number;
}

export type DelegationUncertainty =
  | "effects_partial"
  | "effects_unknown"
  | "verification_inconclusive"
  | "verification_unavailable"
  | "model_input_tokens_unavailable"
  | "model_output_tokens_unavailable"
  | "cost_units_unavailable";

export interface DelegationTerminalSummary {
  readonly status: RunResultStatus;
  readonly code: string | null;
  readonly failureKind: string | null;
  readonly cancellationOrigin: string | null;
}

export interface DelegationNarrative {
  readonly trust: "attributed_model_output";
  readonly text: string;
}

export interface DelegationResult {
  readonly schemaVersion: 1;
  readonly ref: DelegationResultRef;
  readonly request: DelegationRequest["ref"];
  readonly correlation: DelegationRunCorrelation;
  readonly terminal: DelegationTerminalSummary;
  readonly narrative: DelegationNarrative | null;
  readonly evidence: DelegationReferenceTransfer<EvidenceRef>;
  readonly artifacts: DelegationReferenceTransfer<ArtifactRef>;
  readonly verification: DelegationVerificationSummary;
  readonly effects: DelegationEffectSummary;
  readonly usage: DelegationUsageSummary;
  readonly limits: DelegationLimits;
  readonly limitDisposition: DelegationLimitDisposition;
  readonly expectationCoverage: readonly DelegationResultExpectationCoverage[];
  readonly uncertainty: readonly DelegationUncertainty[];
  readonly createdAt: string;
}

export class DelegationResultValidationError extends TypeError {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DelegationResultValidationError";
  }
}

export function createDelegationResult(input: {
  readonly resultId: string;
  readonly request: DelegationRequest;
  readonly correlation: DelegationRunCorrelation;
  readonly childResult: RunResult;
  readonly narrative: string | null;
  readonly verification: DelegationVerificationSummary;
  readonly effects: DelegationEffectSummary;
  readonly usage: DelegationUsageSummary;
  readonly limitDisposition: DelegationLimitDisposition;
  readonly createdAt: string;
}): DelegationResult {
  try {
    strictRecord(input, "DelegationResultInput", [
      "resultId",
      "request",
      "correlation",
      "childResult",
      "narrative",
      "verification",
      "effects",
      "usage",
      "limitDisposition",
      "createdAt",
    ]);
    const resultId = token(input.resultId, "resultId");
    const request = snapshotDelegationRequest(input.request);
    const correlation = snapshotDelegationRunCorrelation(input.correlation);
    if (
      correlation.request.id !== request.ref.id ||
      correlation.request.revision !== request.ref.revision
    ) {
      fail("delegation_result_request_mismatch", "Delegation result correlation does not match the request.");
    }
    validateChildResult(input.childResult, correlation);
    const narrative = snapshotNarrative(
      input.narrative,
      request.expectedResult.maxNarrativeCharacters,
    );
    const verification = snapshotVerification(input.verification);
    const effects = snapshotEffects(input.effects);
    const usage = snapshotUsage(input.usage);
    const limitDisposition = snapshotLimitDisposition(
      input.limitDisposition,
      request.limits,
    );
    const evidence = transferRefs(
      input.childResult.evidenceRefs,
      requestedMaximum(request, "evidence"),
      "evidence",
    );
    const artifacts = transferRefs(
      input.childResult.artifactRefs,
      requestedMaximum(request, "artifacts"),
      "artifacts",
    );
    const terminal = terminalSummary(input.childResult);
    const expectationCoverage = request.expectedResult.requirements.map(
      (requirement) => coverageFor(
        requirement.form,
        requirement.required,
        terminal,
        narrative,
        evidence,
        artifacts,
        verification,
        effects,
      ),
    );
    const uncertainty = deriveUncertainty(verification, effects, usage);
    const createdAt = isoDateTime(input.createdAt, "createdAt");
    if (Date.parse(createdAt) < Date.parse(input.childResult.completedAt)) {
      fail("delegation_result_time_invalid", "Delegation result cannot precede child settlement.");
    }
    const material = deepFreeze({
      request: request.ref,
      correlation,
      terminal,
      narrative,
      evidence,
      artifacts,
      verification,
      effects,
      usage,
      limits: request.limits,
      limitDisposition,
      expectationCoverage: Object.freeze(expectationCoverage),
      uncertainty,
      createdAt,
    });
    const byteLength = new TextEncoder().encode(JSON.stringify(material)).byteLength;
    if (byteLength > request.limits.maxResultBytes) {
      fail("delegation_result_too_large", "Delegation result exceeds the accepted result limit.");
    }
    const revision = createDelegationContractIdentity(
      "agent-anything.delegation-result.v1",
      material,
    );
    return deepFreeze({
      schemaVersion: 1 as const,
      ref: snapshotDelegationResultRef({ id: resultId, revision }),
      ...material,
    });
  } catch (error) {
    if (error instanceof DelegationResultValidationError) throw error;
    throw new DelegationResultValidationError(
      "delegation_result_invalid",
      error instanceof Error ? error.message : "Delegation result is invalid.",
    );
  }
}

export function snapshotDelegationResult(
  input: DelegationResult,
): DelegationResult {
  try {
    strictRecord(input, "DelegationResult", [
      "schemaVersion",
      "ref",
      "request",
      "correlation",
      "terminal",
      "narrative",
      "evidence",
      "artifacts",
      "verification",
      "effects",
      "usage",
      "limits",
      "limitDisposition",
      "expectationCoverage",
      "uncertainty",
      "createdAt",
    ]);
    if (input.schemaVersion !== 1) {
      throw new TypeError("Delegation result must use schema version 1.");
    }
    const ref = snapshotDelegationResultRef(input.ref);
    const request = snapshotDelegationRequestRef(input.request);
    const correlation = snapshotDelegationRunCorrelation(input.correlation);
    if (
      correlation.request.id !== request.id ||
      correlation.request.revision !== request.revision
    ) {
      throw new TypeError("Delegation result request and correlation disagree.");
    }
    const terminal = snapshotTerminal(input.terminal);
    const limits = snapshotDelegationLimits(input.limits);
    const narrative = input.narrative === null
      ? null
      : snapshotNarrativeValue(input.narrative, limits.maxResultBytes);
    const evidence = snapshotReferenceTransfer(input.evidence, "evidence");
    const artifacts = snapshotReferenceTransfer(input.artifacts, "artifacts");
    const verification = snapshotVerification(input.verification);
    const effects = snapshotEffects(input.effects);
    const usage = snapshotUsage(input.usage);
    const limitDisposition = snapshotLimitDisposition(input.limitDisposition, limits);
    const expectationCoverage = snapshotCoverage(input.expectationCoverage);
    const uncertainty = snapshotUncertainty(input.uncertainty);
    const expectedUncertainty = deriveUncertainty(verification, effects, usage);
    if (
      uncertainty.length !== expectedUncertainty.length ||
      uncertainty.some((value, index) => value !== expectedUncertainty[index])
    ) {
      throw new TypeError("Delegation uncertainty is inconsistent with owner summaries.");
    }
    const createdAt = isoDateTime(input.createdAt, "createdAt");
    const material = deepFreeze({
      request,
      correlation,
      terminal,
      narrative,
      evidence,
      artifacts,
      verification,
      effects,
      usage,
      limits,
      limitDisposition,
      expectationCoverage,
      uncertainty,
      createdAt,
    });
    if (new TextEncoder().encode(JSON.stringify(material)).byteLength > limits.maxResultBytes) {
      throw new TypeError("Delegation result exceeds its accepted result limit.");
    }
    const revision = createDelegationContractIdentity(
      "agent-anything.delegation-result.v1",
      material,
    );
    if (ref.revision !== revision) {
      throw new TypeError("Delegation result revision does not match its immutable content.");
    }
    return deepFreeze({ schemaVersion: 1 as const, ref, ...material });
  } catch (error) {
    if (error instanceof DelegationResultValidationError) throw error;
    throw new DelegationResultValidationError(
      "delegation_result_invalid",
      error instanceof Error ? error.message : "Delegation result is invalid.",
    );
  }
}

function validateChildResult(
  result: RunResult,
  correlation: DelegationRunCorrelation,
): void {
  if (
    result.run.id !== correlation.child.run.id ||
    result.runId !== correlation.child.run.id ||
    result.taskId !== correlation.child.task.id ||
    result.startingAgent.id !== correlation.child.agent.id ||
    result.startingAgent.revision !== correlation.child.agent.revision
  ) {
    fail("delegation_result_child_mismatch", "Child RunResult does not match the delegation correlation.");
  }
}

function snapshotNarrative(
  input: string | null,
  maximumLength: number,
): DelegationNarrative | null {
  if (input === null) return null;
  if (typeof input !== "string" || input.length > maximumLength) {
    fail("delegation_result_narrative_invalid", "Delegation narrative exceeds its accepted bound.");
  }
  return Object.freeze({ trust: "attributed_model_output" as const, text: input });
}

function snapshotNarrativeValue(
  input: DelegationNarrative,
  maximumLength: number,
): DelegationNarrative {
  strictRecord(input, "DelegationNarrative", ["trust", "text"]);
  if (input.trust !== "attributed_model_output") {
    throw new TypeError("Delegation narrative trust class is unsupported.");
  }
  if (typeof input.text !== "string" || input.text.length > maximumLength) {
    throw new TypeError("Delegation narrative exceeds its accepted bound.");
  }
  return Object.freeze({ trust: "attributed_model_output", text: input.text });
}

function snapshotVerification(
  input: DelegationVerificationSummary,
): DelegationVerificationSummary {
  strictRecord(input, "DelegationVerificationSummary", [
    "status",
    "snapshotRevision",
    "mandatoryTotal",
    "mandatorySatisfied",
    "limitationCodes",
  ]);
  if (![
    "not_required",
    "pending",
    "satisfied",
    "violated",
    "inconclusive",
    "stale",
    "unavailable",
  ].includes(input.status)) {
    throw new TypeError("Delegation Verification status is unsupported.");
  }
  const mandatoryTotal = nonNegativeInteger(input.mandatoryTotal, "mandatoryTotal");
  const mandatorySatisfied = nonNegativeInteger(
    input.mandatorySatisfied,
    "mandatorySatisfied",
  );
  if (mandatorySatisfied > mandatoryTotal) {
    throw new TypeError("Delegation Verification satisfied count exceeds total.");
  }
  if (!Array.isArray(input.limitationCodes) || input.limitationCodes.length > 128) {
    throw new TypeError("Delegation Verification limitations must be bounded.");
  }
  const limitationCodes = input.limitationCodes.map((code, index) =>
    token(code, `limitationCodes[${index}]`),
  );
  if (new Set(limitationCodes).size !== limitationCodes.length) {
    throw new TypeError("Delegation Verification limitations must be unique.");
  }
  return deepFreeze({
    status: input.status,
    snapshotRevision: input.snapshotRevision === null
      ? null
      : token(input.snapshotRevision, "snapshotRevision"),
    mandatoryTotal,
    mandatorySatisfied,
    limitationCodes: Object.freeze(limitationCodes),
  });
}

function snapshotEffects(input: DelegationEffectSummary): DelegationEffectSummary {
  strictRecord(input, "DelegationEffectSummary", [
    "status",
    "attempted",
    "settled",
    "uncertain",
    "settlementRefs",
  ]);
  if (!["none", "known", "partial", "unknown"].includes(input.status)) {
    throw new TypeError("Delegation effect status is unsupported.");
  }
  const attempted = nonNegativeInteger(input.attempted, "effects.attempted");
  const settled = nonNegativeInteger(input.settled, "effects.settled");
  const uncertain = nonNegativeInteger(input.uncertain, "effects.uncertain");
  if (settled + uncertain > attempted) {
    throw new TypeError("Delegation effect counts are inconsistent.");
  }
  if (input.status === "none" && attempted !== 0) {
    throw new TypeError("A no-effect summary cannot contain attempts.");
  }
  if (input.status === "known" && uncertain !== 0) {
    throw new TypeError("A known-effect summary cannot contain uncertainty.");
  }
  if ((input.status === "partial" || input.status === "unknown") && uncertain === 0) {
    throw new TypeError("An uncertain effect summary requires uncertain attempts.");
  }
  if (!Array.isArray(input.settlementRefs) || input.settlementRefs.length > 512) {
    throw new TypeError("Delegation effect settlement refs must be bounded.");
  }
  const settlementRefs = input.settlementRefs.map((ref, index) =>
    token(ref, `settlementRefs[${index}]`),
  );
  if (new Set(settlementRefs).size !== settlementRefs.length) {
    throw new TypeError("Delegation effect settlement refs must be unique.");
  }
  return deepFreeze({
    status: input.status,
    attempted,
    settled,
    uncertain,
    settlementRefs: Object.freeze(settlementRefs),
  });
}

function snapshotUsage(input: DelegationUsageSummary): DelegationUsageSummary {
  strictRecord(input, "DelegationUsageSummary", [
    "controllerTurns",
    "actions",
    "modelInputTokens",
    "modelOutputTokens",
    "costUnits",
  ]);
  const usage = deepFreeze({
    controllerTurns: snapshotMeasurement(input.controllerTurns, "controllerTurns"),
    actions: snapshotMeasurement(input.actions, "actions"),
    modelInputTokens: snapshotMeasurement(input.modelInputTokens, "modelInputTokens"),
    modelOutputTokens: snapshotMeasurement(input.modelOutputTokens, "modelOutputTokens"),
    costUnits: snapshotMeasurement(input.costUnits, "costUnits"),
  });
  if (usage.controllerTurns.status !== "measured" || usage.actions.status !== "measured") {
    throw new TypeError("Delegation controller-turn and Action usage must be measured exactly.");
  }
  return usage;
}

function snapshotMeasurement(
  input: DelegationUsageMeasurement,
  field: string,
): DelegationUsageMeasurement {
  if (input.status === "measured") {
    strictRecord(input, field, ["status", "value"]);
    return Object.freeze({
      status: "measured" as const,
      value: nonNegativeInteger(input.value, `${field}.value`),
    });
  }
  if (input.status !== "unavailable") {
    throw new TypeError(`${field}.status is unsupported.`);
  }
  strictRecord(input, field, ["status", "reason"]);
  if (!["not_metered", "provider_omitted", "not_applicable"].includes(input.reason)) {
    throw new TypeError(`${field}.reason is unsupported.`);
  }
  return Object.freeze({ status: "unavailable" as const, reason: input.reason });
}

function snapshotLimitDisposition(
  input: DelegationLimitDisposition,
  limits: DelegationLimits,
): DelegationLimitDisposition {
  strictRecord(input, "DelegationLimitDisposition", [
    "status",
    "exhaustedLimit",
    "controllerTurns",
    "actions",
    "durationMs",
    "contextBytes",
    "resultBytes",
  ]);
  if (input.status !== "within_limits" && input.status !== "exhausted") {
    throw new TypeError("Delegation limit disposition status is unsupported.");
  }
  if (
    input.exhaustedLimit !== null &&
    !["controller_turns", "actions", "duration", "context_bytes", "result_bytes"].includes(input.exhaustedLimit)
  ) {
    throw new TypeError("Delegation exhausted-limit kind is unsupported.");
  }
  if ((input.status === "exhausted") !== (input.exhaustedLimit !== null)) {
    throw new TypeError("Delegation limit disposition and exhausted limit disagree.");
  }
  const snapshot = deepFreeze({
    status: input.status,
    exhaustedLimit: input.exhaustedLimit,
    controllerTurns: nonNegativeInteger(input.controllerTurns, "controllerTurns"),
    actions: nonNegativeInteger(input.actions, "actions"),
    durationMs: nonNegativeInteger(input.durationMs, "durationMs"),
    contextBytes: nonNegativeInteger(input.contextBytes, "contextBytes"),
    resultBytes: nonNegativeInteger(input.resultBytes, "resultBytes"),
  });
  if (snapshot.status === "within_limits" && (
    snapshot.controllerTurns > limits.maxControllerTurns ||
    snapshot.actions > limits.maxActions ||
    snapshot.durationMs > limits.maxDurationMs ||
    snapshot.contextBytes > limits.maxContextBytes ||
    snapshot.resultBytes > limits.maxResultBytes
  )) {
    throw new TypeError("Delegation usage exceeds limits but is marked within limits.");
  }
  return snapshot;
}

function terminalSummary(result: RunResult): DelegationTerminalSummary {
  return Object.freeze({
    status: result.status,
    code: result.code,
    failureKind: result.status === "failed" ? result.failure.kind : null,
    cancellationOrigin: result.cancellation?.origin ?? null,
  });
}

function snapshotTerminal(
  input: DelegationTerminalSummary,
): DelegationTerminalSummary {
  strictRecord(input, "DelegationTerminalSummary", [
    "status",
    "code",
    "failureKind",
    "cancellationOrigin",
  ]);
  if (!["succeeded", "blocked", "failed", "cancelled"].includes(input.status)) {
    throw new TypeError("Delegation terminal status is unsupported.");
  }
  const code = input.code === null ? null : token(input.code, "terminal.code");
  const failureKind = input.failureKind === null
    ? null
    : token(input.failureKind, "terminal.failureKind");
  const cancellationOrigin = input.cancellationOrigin === null
    ? null
    : token(input.cancellationOrigin, "terminal.cancellationOrigin");
  if ((input.status === "succeeded") !== (code === null)) {
    throw new TypeError("Delegation terminal status and code disagree.");
  }
  if ((input.status === "failed") !== (failureKind !== null)) {
    throw new TypeError("Delegation terminal failure attribution is inconsistent.");
  }
  if (input.status === "cancelled" && code !== "runtime_cancelled") {
    throw new TypeError("Cancelled delegation must preserve runtime_cancelled.");
  }
  if (cancellationOrigin !== null && input.status !== "cancelled" && input.status !== "failed") {
    throw new TypeError("Delegation cancellation attribution is inconsistent.");
  }
  return Object.freeze({
    status: input.status,
    code,
    failureKind,
    cancellationOrigin,
  });
}

function transferRefs<TRef extends string>(
  refs: readonly TRef[],
  maximum: number,
  field: string,
): DelegationReferenceTransfer<TRef> {
  const values = refs.map((ref, index) => token(ref, `${field}[${index}]`) as TRef);
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${field} contains duplicate refs.`);
  }
  return deepFreeze({
    refs: Object.freeze(values.slice(0, maximum)),
    totalCount: values.length,
    omittedCount: Math.max(0, values.length - maximum),
  });
}

function snapshotReferenceTransfer<TRef extends string>(
  input: DelegationReferenceTransfer<TRef>,
  field: string,
): DelegationReferenceTransfer<TRef> {
  strictRecord(input, field, ["refs", "totalCount", "omittedCount"]);
  if (!Array.isArray(input.refs) || input.refs.length > 512) {
    throw new TypeError(`${field}.refs must be bounded.`);
  }
  const refs = input.refs.map((ref, index) => token(ref, `${field}.refs[${index}]`) as TRef);
  if (new Set(refs).size !== refs.length) {
    throw new TypeError(`${field}.refs must be unique.`);
  }
  const totalCount = nonNegativeInteger(input.totalCount, `${field}.totalCount`);
  const omittedCount = nonNegativeInteger(input.omittedCount, `${field}.omittedCount`);
  if (totalCount !== refs.length + omittedCount) {
    throw new TypeError(`${field} counts are inconsistent.`);
  }
  return deepFreeze({ refs: Object.freeze(refs), totalCount, omittedCount });
}

function snapshotCoverage(
  input: readonly DelegationResultExpectationCoverage[],
): readonly DelegationResultExpectationCoverage[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 5) {
    throw new TypeError("Delegation expectation coverage must be bounded.");
  }
  const coverage = input.map((item, index) => {
    strictRecord(item, `expectationCoverage[${index}]`, [
      "form",
      "required",
      "disposition",
      "itemCount",
    ]);
    if (!["narrative", "evidence", "artifacts", "verification", "effects"].includes(item.form)) {
      throw new TypeError("Delegation expectation coverage form is unsupported.");
    }
    if (typeof item.required !== "boolean") {
      throw new TypeError("Delegation expectation coverage required flag must be boolean.");
    }
    if (!["present", "absent", "failed", "unavailable"].includes(item.disposition)) {
      throw new TypeError("Delegation expectation coverage disposition is unsupported.");
    }
    return Object.freeze({
      form: item.form,
      required: item.required,
      disposition: item.disposition,
      itemCount: nonNegativeInteger(item.itemCount, "expectationCoverage.itemCount"),
    });
  });
  if (new Set(coverage.map((item) => item.form)).size !== coverage.length) {
    throw new TypeError("Delegation expectation coverage forms must be unique.");
  }
  return Object.freeze(coverage);
}

function snapshotUncertainty(
  input: readonly DelegationUncertainty[],
): readonly DelegationUncertainty[] {
  const supported: readonly DelegationUncertainty[] = [
    "effects_partial",
    "effects_unknown",
    "verification_inconclusive",
    "verification_unavailable",
    "model_input_tokens_unavailable",
    "model_output_tokens_unavailable",
    "cost_units_unavailable",
  ];
  if (!Array.isArray(input) || input.length > supported.length) {
    throw new TypeError("Delegation uncertainty must be bounded.");
  }
  if (input.some((value) => !supported.includes(value)) || new Set(input).size !== input.length) {
    throw new TypeError("Delegation uncertainty contains unsupported or duplicate values.");
  }
  return Object.freeze([...input]);
}

function requestedMaximum(
  request: DelegationRequest,
  form: "evidence" | "artifacts",
): number {
  return request.expectedResult.requirements.find(
    (requirement) => requirement.form === form,
  )?.maxItems ?? 64;
}

function coverageFor(
  form: DelegationExpectedResultForm,
  required: boolean,
  terminal: DelegationTerminalSummary,
  narrative: DelegationNarrative | null,
  evidence: DelegationReferenceTransfer<EvidenceRef>,
  artifacts: DelegationReferenceTransfer<ArtifactRef>,
  verification: DelegationVerificationSummary,
  _effects: DelegationEffectSummary,
): DelegationResultExpectationCoverage {
  let present = false;
  let unavailable = false;
  let itemCount = 0;
  switch (form) {
    case "narrative":
      present = narrative !== null;
      itemCount = present ? 1 : 0;
      break;
    case "evidence":
      present = evidence.totalCount > 0;
      itemCount = evidence.totalCount;
      break;
    case "artifacts":
      present = artifacts.totalCount > 0;
      itemCount = artifacts.totalCount;
      break;
    case "verification":
      unavailable = verification.status === "unavailable";
      present = !unavailable;
      itemCount = present ? 1 : 0;
      break;
    case "effects":
      present = true;
      itemCount = 1;
      break;
  }
  return Object.freeze({
    form,
    required,
    disposition: present
      ? "present" as const
      : unavailable
        ? "unavailable" as const
        : terminal.status === "succeeded"
          ? "absent" as const
          : "failed" as const,
    itemCount,
  });
}

function deriveUncertainty(
  verification: DelegationVerificationSummary,
  effects: DelegationEffectSummary,
  usage: DelegationUsageSummary,
): readonly DelegationUncertainty[] {
  const values: DelegationUncertainty[] = [];
  if (effects.status === "partial") values.push("effects_partial");
  if (effects.status === "unknown") values.push("effects_unknown");
  if (verification.status === "inconclusive") values.push("verification_inconclusive");
  if (verification.status === "unavailable") values.push("verification_unavailable");
  if (usage.modelInputTokens.status === "unavailable") values.push("model_input_tokens_unavailable");
  if (usage.modelOutputTokens.status === "unavailable") values.push("model_output_tokens_unavailable");
  if (usage.costUnits.status === "unavailable") values.push("cost_units_unavailable");
  return Object.freeze(values);
}

function fail(code: string, message: string): never {
  throw new DelegationResultValidationError(code, message);
}
