import type { InvocationInterruptionContext, InvocationInterruptionRef } from "@agent-anything/agent-core/control";
import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type { ActionSettlementRef } from "@agent-anything/canonical-action/subject";
import type { ActionEffectCertainty } from "@agent-anything/canonical-action/settlement";
import type {
  ContextContributionLimits,
  ContextContributionRef,
} from "@agent-anything/context/contribution";
import type {
  OperationBindingRevisionRef,
  OperationInvocationRef,
} from "@agent-anything/operation-catalog/identity";
import type {
  OperationResult,
  OperationResultRef,
} from "@agent-anything/operation-catalog/result";
import {
  createVerificationFailure,
  type VerificationFailure,
  type VerificationOwnerRef,
  type VerificationRequirement,
  type VerificationRequirementRef,
  type VerificationSpecification,
  type VerificationSpecificationRef,
} from "../definition/index.js";
/*
 * Check records retain child-owner correlation, while VerificationFailure owns
 * only the Verification interpretation of an unsuccessful Check settlement.
 */
import type { VerificationAssessment, VerificationCurrentSnapshot } from "../assessment/index.js";
import type { VerificationEvidence, VerificationEvidenceCoverage } from "../evidence/index.js";
import type {
  VerificationSubjectAdapterRef,
  VerificationSubjectScopeEntry,
  VerificationSubjectSnapshot,
  VerificationSubjectSnapshotRef,
} from "../subject/index.js";
import type { CompletionGateRecord } from "../completion/index.js";
import type {
  VerificationPersistenceRecord,
} from "../persistence/index.js";
import type {
  VerificationEvaluationProjection,
  VerificationContextProjection,
  VerificationHostProjection,
  VerificationObservabilityProjection,
  VerificationRunnerProjection,
} from "../projection/index.js";
import type { VerificationOperationCheckResolverPort } from "./VerificationExecutionAdapters.js";

export type VerificationCheckOrigin =
  | "controller"
  | "trusted_automatic"
  | "trusted_workflow"
  | "owner_request";

export type CheckResultStatus =
  | "invalid"
  | "unavailable"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "failed"
  | "partial"
  | "completed";

export type VerificationCheckRetryPolicy = "never" | "safe" | "confirmed_no_effect";
export type VerificationCheckReplayBasis = "initial" | "safe_replay" | "confirmed_no_effect";

export interface CheckDefinitionRef {
  readonly id: string;
  readonly revision: string;
}

export interface CheckAttemptRef {
  readonly id: string;
  readonly ordinal: number;
}

export interface CheckResultRef {
  readonly id: string;
  readonly revision: string;
}

export interface CheckFindingRef {
  readonly id: string;
  readonly revision: string;
}

export type VerificationCheckEffectProfile =
  | {
      readonly kind: "pure";
      readonly evaluator: VerificationOwnerRef;
      readonly operationBinding: null;
    }
  | {
      readonly kind: "effectful";
      readonly evaluator: null;
      readonly operationBinding: OperationBindingRevisionRef;
    };

export interface CheckDefinition {
  readonly ref: CheckDefinitionRef;
  readonly owner: string;
  readonly family: string;
  readonly requirementKinds: readonly string[];
  readonly subjectKinds: readonly string[];
  readonly acceptedOrigins: readonly VerificationCheckOrigin[];
  readonly effect: VerificationCheckEffectProfile;
  readonly resultInterpreter: VerificationOwnerRef;
  readonly environmentNeeds: readonly string[];
  readonly maximumDurationMs: number;
  readonly maximumAttempts: number;
  readonly maximumCostUnits: number | null;
  readonly retryPolicy: VerificationCheckRetryPolicy;
  readonly evidencePolicyRevision: string;
}

export interface CheckAttempt {
  readonly ref: CheckAttemptRef;
  readonly run: RunRef;
  readonly requirement: VerificationRequirementRef;
  readonly subject: VerificationSubjectSnapshotRef;
  readonly definition: CheckDefinitionRef;
  readonly origin: VerificationCheckOrigin;
  readonly predecessor: CheckAttemptRef | null;
  readonly environment: VerificationOwnerRef | null;
  readonly scope: readonly VerificationSubjectScopeEntry[];
  readonly configuration: VerificationOwnerRef | null;
  readonly coverageTarget: number;
  readonly costLimitUnits: number | null;
  readonly replayBasis: VerificationCheckReplayBasis;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly deadlineAt: string;
  readonly interruption: InvocationInterruptionRef | null;
  readonly runAction: RunActionRef | null;
  readonly operationInvocation: OperationInvocationRef | null;
  readonly actionSettlement: ActionSettlementRef | null;
}

export interface CheckFinding {
  readonly ref: CheckFindingRef;
  readonly owner: string;
  readonly claim: string;
  readonly polarity: "supports" | "contradicts" | "limits";
  readonly severity: "info" | "warning" | "error";
  readonly sourceRefs: readonly VerificationOwnerRef[];
  readonly limitations: readonly string[];
}

export interface CheckResult {
  readonly ref: CheckResultRef;
  readonly attempt: CheckAttemptRef;
  readonly status: CheckResultStatus;
  readonly findings: readonly CheckFinding[];
  readonly operationResult: OperationResultRef | null;
  readonly actionSettlement: ActionSettlementRef | null;
  readonly coverage: VerificationEvidenceCoverage;
  readonly costUnits: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly limitations: readonly string[];
  readonly failure: VerificationFailure | null;
}

export interface VerificationCheckRequest {
  readonly requirement: VerificationRequirementRef;
  readonly subject: VerificationSubjectSnapshotRef;
  readonly definition: CheckDefinitionRef;
  readonly origin: VerificationCheckOrigin;
  readonly runAction: RunActionRef | null;
  readonly predecessor: CheckAttemptRef | null;
  readonly environment: VerificationOwnerRef | null;
  readonly configuration: VerificationOwnerRef | null;
  readonly coverageTarget: number;
  readonly expectedRevision: number;
}

export interface VerificationAssessmentRequest {
  readonly requirement: VerificationRequirementRef;
  readonly subject: VerificationSubjectSnapshotRef;
  readonly evidenceRefs: readonly { readonly id: string; readonly revision: string }[];
  readonly expectedRevision: number;
}

export interface VerificationSpecificationAdmission {
  readonly specification: VerificationSpecification;
  readonly requirements: readonly VerificationRequirement[];
  readonly expectedRevision: number;
}

export interface VerificationCheckDefinitionAdmission {
  readonly definition: CheckDefinition;
  readonly expectedRevision: number;
}

export interface VerificationSubjectCaptureRequest {
  readonly requirement: VerificationRequirementRef;
  readonly adapter: VerificationSubjectAdapterRef;
  readonly kind: string;
  readonly requestedSource: VerificationOwnerRef;
  readonly expectedRevision: number;
}

export interface VerificationSubjectRehydrationRequest {
  readonly requirement: VerificationRequirementRef;
  readonly adapter: VerificationSubjectAdapterRef;
  readonly snapshot: VerificationSubjectSnapshotRef;
  readonly expectedRevision: number;
}

export interface VerificationSubjectFreshnessRequest {
  readonly requirement: VerificationRequirementRef;
  readonly snapshot: VerificationSubjectSnapshotRef;
  readonly expectedRevision: number;
}

export interface VerificationEvidenceAdmissionRequest {
  readonly evidence: VerificationEvidence;
  readonly expectedRevision: number;
}

export interface VerificationGateRecordRequest {
  readonly record: CompletionGateRecord;
  readonly expectedRevision: number;
}

export interface VerificationExecutionCloseRequest {
  readonly expectedRevision: number;
  readonly closedAt: string;
}

export interface VerificationLedgerSnapshot {
  readonly run: RunRef;
  readonly revision: number;
  readonly acceptingCurrentChanges: boolean;
  readonly specification: VerificationSpecificationRef | null;
  readonly requirements: readonly VerificationRequirementRef[];
  readonly subjects: readonly VerificationSubjectSnapshotRef[];
  readonly definitions: readonly CheckDefinitionRef[];
  readonly attempts: readonly CheckAttemptRef[];
  readonly results: readonly CheckResultRef[];
  readonly evidence: readonly { readonly id: string; readonly revision: string }[];
  readonly assessments: readonly { readonly id: string; readonly revision: string }[];
  readonly gates: readonly { readonly id: string; readonly revision: string }[];
  readonly current: VerificationCurrentSnapshot;
}

export interface VerificationExecutionPersistenceFailure {
  readonly recordKind: VerificationPersistenceRecord["kind"] | "current_snapshot";
  readonly failure: VerificationFailure;
}

export interface VerificationLowerCheckSettlement {
  readonly operationInvocation: OperationInvocationRef;
  readonly operationResult: OperationResult;
  readonly actionSettlement: ActionSettlementRef | null;
  readonly effectCertainty: ActionEffectCertainty;
  readonly costUnits: number | null;
}

export interface VerificationSettledOperationCheckRequest {
  readonly check: VerificationCheckRequest;
  readonly settlement: VerificationLowerCheckSettlement;
}

export interface CheckFindingInput {
  readonly owner: string;
  readonly claim: string;
  readonly polarity: CheckFinding["polarity"];
  readonly severity: CheckFinding["severity"];
  readonly sourceRefs: readonly VerificationOwnerRef[];
  readonly limitations: readonly string[];
}

export interface VerificationCheckInterpretation {
  readonly status: CheckResultStatus;
  readonly findings: readonly CheckFindingInput[];
  readonly coverage: VerificationEvidenceCoverage;
  readonly costUnits: number | null;
  readonly limitations: readonly string[];
  readonly failure: VerificationFailure | null;
}

export interface VerificationExecutionPort {
  admitSpecification(
    input: VerificationSpecificationAdmission,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot>;
  admitCheckDefinition(
    input: VerificationCheckDefinitionAdmission,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationLedgerSnapshot>;
  captureSubject(
    input: VerificationSubjectCaptureRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot>;
  rehydrateSubject(
    input: VerificationSubjectRehydrationRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot>;
  checkSubjectFreshness(
    input: VerificationSubjectFreshnessRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot>;
  executeCheck(
    request: VerificationCheckRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<CheckResult>;
  interpretSettledOperationCheck(
    request: VerificationSettledOperationCheckRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<CheckResult>;
  admitEvidence(
    input: VerificationEvidenceAdmissionRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationCurrentSnapshot>;
  assessRequirement(
    request: VerificationAssessmentRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationAssessment>;
  recordCompletionGate(
    input: VerificationGateRecordRequest,
    interruption: InvocationInterruptionContext,
  ): Promise<VerificationLedgerSnapshot>;
  closeCurrentState(input: VerificationExecutionCloseRequest): Promise<VerificationLedgerSnapshot>;
  readCurrentSnapshot(): Promise<VerificationCurrentSnapshot>;
  readLedgerSnapshot(): Promise<VerificationLedgerSnapshot>;
  readHistory(): Promise<readonly VerificationPersistenceRecord[]>;
  readPersistenceFailures(): Promise<readonly VerificationExecutionPersistenceFailure[]>;
  projectRunner(input: {
    readonly contextContribution: ContextContributionRef | null;
  }): Promise<VerificationRunnerProjection>;
  projectContext(limits: ContextContributionLimits): Promise<VerificationContextProjection>;
  projectHost(): Promise<VerificationHostProjection>;
  projectObservability(): Promise<VerificationObservabilityProjection>;
  projectEvaluation(): Promise<VerificationEvaluationProjection>;
}

export interface VerificationExecutionFactoryInput {
  readonly run: RunRef;
  readonly operationChecks: VerificationOperationCheckResolverPort;
}

export interface VerificationExecutionFactory {
  create(input: VerificationExecutionFactoryInput): Promise<VerificationExecutionPort>;
}

export function snapshotCheckDefinition(input: CheckDefinition): CheckDefinition {
  strictRecord(input, "CheckDefinition", [
    "ref", "owner", "family", "requirementKinds", "subjectKinds", "acceptedOrigins", "effect",
    "resultInterpreter", "environmentNeeds", "maximumDurationMs", "maximumAttempts",
    "maximumCostUnits", "retryPolicy", "evidencePolicyRevision",
  ]);
  strictRecord(input.ref, "CheckDefinition.ref", ["id", "revision"]);
  strictRecord(input.effect, "CheckDefinition.effect", ["kind", "evaluator", "operationBinding"]);
  if (input.effect.kind === "pure") {
    if (input.effect.operationBinding !== null) throw new TypeError("A pure CheckDefinition cannot bind an Operation.");
    snapshotOwnerRef(input.effect.evaluator, "CheckDefinition.effect.evaluator");
  } else if (input.effect.kind === "effectful") {
    if (input.effect.evaluator !== null) throw new TypeError("An effectful CheckDefinition cannot bind a pure evaluator.");
    if (input.effect.operationBinding === null) throw new TypeError("An effectful CheckDefinition requires an Operation binding.");
  } else {
    throw new TypeError("CheckDefinition.effect.kind is unsupported.");
  }
  return deepFreeze({
    ...input,
    ref: snapshotRevisionRef(input.ref, "CheckDefinition.ref"),
    owner: token(input.owner, "CheckDefinition.owner"),
    family: token(input.family, "CheckDefinition.family"),
    requirementKinds: tokenList(input.requirementKinds, "CheckDefinition.requirementKinds"),
    subjectKinds: tokenList(input.subjectKinds, "CheckDefinition.subjectKinds"),
    acceptedOrigins: enumList(input.acceptedOrigins, CHECK_ORIGINS, "CheckDefinition.acceptedOrigins"),
    effect: clone(input.effect),
    resultInterpreter: snapshotOwnerRef(input.resultInterpreter, "CheckDefinition.resultInterpreter"),
    environmentNeeds: tokenList(input.environmentNeeds, "CheckDefinition.environmentNeeds", true),
    maximumDurationMs: positiveInteger(input.maximumDurationMs, "CheckDefinition.maximumDurationMs"),
    maximumAttempts: positiveInteger(input.maximumAttempts, "CheckDefinition.maximumAttempts"),
    maximumCostUnits: nullableNonNegativeNumber(input.maximumCostUnits, "CheckDefinition.maximumCostUnits"),
    retryPolicy: retryPolicy(input.retryPolicy, "CheckDefinition.retryPolicy"),
    evidencePolicyRevision: token(input.evidencePolicyRevision, "CheckDefinition.evidencePolicyRevision"),
  });
}

export function snapshotCheckAttempt(input: CheckAttempt): CheckAttempt {
  strictRecord(input, "CheckAttempt", [
    "ref", "run", "requirement", "subject", "definition", "origin", "predecessor",
    "environment", "scope", "configuration", "coverageTarget", "replayBasis", "requestedAt",
    "costLimitUnits", "startedAt", "deadlineAt", "interruption", "runAction", "operationInvocation", "actionSettlement",
  ]);
  strictRecord(input.ref, "CheckAttempt.ref", ["id", "ordinal"]);
  if (!CHECK_ORIGINS.includes(input.origin)) throw new TypeError("CheckAttempt.origin is unsupported.");
  positiveInteger(input.ref.ordinal, "CheckAttempt.ref.ordinal");
  if (input.ref.ordinal === 1 && input.predecessor !== null) {
    throw new TypeError("The first CheckAttempt cannot have a predecessor.");
  }
  if (input.ref.ordinal > 1 && input.predecessor === null) {
    throw new TypeError("A retried CheckAttempt requires its predecessor.");
  }
  return deepFreeze(clone({
    ...input,
    ref: { id: token(input.ref.id, "CheckAttempt.ref.id"), ordinal: input.ref.ordinal },
    run: { id: token(input.run.id, "CheckAttempt.run.id") },
    requirement: snapshotRevisionRef(input.requirement, "CheckAttempt.requirement"),
    subject: snapshotRevisionRef(input.subject, "CheckAttempt.subject"),
    definition: snapshotRevisionRef(input.definition, "CheckAttempt.definition"),
    environment: input.environment === null
      ? null
      : snapshotOwnerRef(input.environment, "CheckAttempt.environment"),
    scope: unique(input.scope.map((item, index) => {
      const path = `CheckAttempt.scope[${index}]`;
      strictRecord(item, path, ["key", "value"]);
      return { key: token(item.key, `${path}.key`), value: nonEmpty(item.value, `${path}.value`) };
    }), (item) => item.key, "CheckAttempt.scope"),
    configuration: input.configuration === null
      ? null
      : snapshotOwnerRef(input.configuration, "CheckAttempt.configuration"),
    coverageTarget: ratio(input.coverageTarget, "CheckAttempt.coverageTarget"),
    costLimitUnits: nullableNonNegativeNumber(input.costLimitUnits, "CheckAttempt.costLimitUnits"),
    replayBasis: replayBasis(input.replayBasis, "CheckAttempt.replayBasis"),
    requestedAt: isoDateTime(input.requestedAt, "CheckAttempt.requestedAt"),
    startedAt: input.startedAt === null ? null : isoDateTime(input.startedAt, "CheckAttempt.startedAt"),
    deadlineAt: isoDateTime(input.deadlineAt, "CheckAttempt.deadlineAt"),
  }));
}

export function snapshotCheckResult(input: CheckResult): CheckResult {
  strictRecord(input, "CheckResult", [
    "ref", "attempt", "status", "findings", "operationResult", "actionSettlement", "startedAt",
    "finishedAt", "coverage", "costUnits", "limitations", "failure",
  ]);
  strictRecord(input.coverage, "CheckResult.coverage", ["ratio", "basis"]);
  if (!CHECK_RESULT_STATUSES.includes(input.status)) throw new TypeError("CheckResult.status is unsupported.");
  if (input.status === "completed" && input.failure !== null) {
    throw new TypeError("A completed CheckResult cannot carry a Failure.");
  }
  if (CHECK_FAILURE_STATUSES.includes(input.status as (typeof CHECK_FAILURE_STATUSES)[number]) && input.failure === null) {
    throw new TypeError("An unsuccessful CheckResult requires VerificationFailure.");
  }
  const coverage = evidenceCoverage(input.coverage, "CheckResult.coverage");
  if (input.status === "partial" &&
      (input.findings.length === 0 || coverage.ratio <= 0 || coverage.ratio >= 1 || input.limitations.length === 0)) {
    throw new TypeError("A partial CheckResult requires usable Findings, incomplete coverage, and limitations.");
  }
  if (input.status !== "completed" && input.status !== "partial" &&
      (input.findings.length > 0 || coverage.ratio !== 0)) {
    throw new TypeError("An unsuccessful CheckResult cannot carry claim Findings or coverage.");
  }
  const startedAt = isoDateTime(input.startedAt, "CheckResult.startedAt");
  const finishedAt = isoDateTime(input.finishedAt, "CheckResult.finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new TypeError("CheckResult cannot finish before it starts.");
  }
  return deepFreeze(clone({
    ...input,
    ref: snapshotRevisionRef(input.ref, "CheckResult.ref"),
    attempt: snapshotAttemptRef(input.attempt, "CheckResult.attempt"),
    coverage,
    costUnits: nullableNonNegativeNumber(input.costUnits, "CheckResult.costUnits"),
    findings: unique(input.findings.map((finding, index) => snapshotFinding(
      finding,
      `CheckResult.findings[${index}]`,
    )), (item) => `${item.ref.id}@${item.ref.revision}`, "CheckResult.findings"),
    limitations: textList(input.limitations, "CheckResult.limitations", true),
    failure: input.failure === null ? null : createVerificationFailure(input.failure),
    startedAt,
    finishedAt,
  }));
}

const CHECK_ORIGINS: readonly VerificationCheckOrigin[] = [
  "controller", "trusted_automatic", "trusted_workflow", "owner_request",
];
const CHECK_RESULT_STATUSES: readonly CheckResultStatus[] = [
  "invalid", "unavailable", "denied", "cancelled", "timed_out", "failed", "partial", "completed",
];
const CHECK_FAILURE_STATUSES = [
  "invalid", "unavailable", "denied", "cancelled", "timed_out", "failed",
] as const;

function snapshotFinding(input: CheckFinding, path: string): CheckFinding {
  strictRecord(input, path, ["ref", "owner", "claim", "polarity", "severity", "sourceRefs", "limitations"]);
  if (!["supports", "contradicts", "limits"].includes(input.polarity)) throw new TypeError(`${path}.polarity is unsupported.`);
  if (!["info", "warning", "error"].includes(input.severity)) throw new TypeError(`${path}.severity is unsupported.`);
  return {
    ...input,
    ref: snapshotRevisionRef(input.ref, `${path}.ref`),
    owner: token(input.owner, `${path}.owner`),
    claim: nonEmpty(input.claim, `${path}.claim`),
    sourceRefs: unique(input.sourceRefs.map((item, index) => snapshotOwnerRef(item, `${path}.sourceRefs[${index}]`)),
      (item) => `${item.owner}:${item.kind}:${item.id}@${item.revision}`, `${path}.sourceRefs`),
    limitations: textList(input.limitations, `${path}.limitations`, true),
  };
}

function snapshotOwnerRef(input: VerificationOwnerRef, path: string): VerificationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return { owner: token(input.owner, `${path}.owner`), kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotRevisionRef(input: { readonly id: string; readonly revision: string }, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}

function snapshotAttemptRef(input: CheckAttemptRef, path: string): CheckAttemptRef {
  strictRecord(input, path, ["id", "ordinal"]);
  return { id: token(input.id, `${path}.id`), ordinal: positiveInteger(input.ordinal, `${path}.ordinal`) };
}

function strictRecord(input: unknown, path: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${path} must be a record.`);
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unsupported field '${unknown[0]}'.`);
}
function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/.test(input)) throw new TypeError(`${path} must be a canonical token.`);
  return input;
}
function nonEmpty(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new TypeError(`${path} is required.`);
  return input;
}
function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) throw new TypeError(`${path} must be a positive integer.`);
  return input as number;
}
function nullableNonNegativeNumber(input: unknown, path: string): number | null {
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new TypeError(`${path} must be null or a non-negative number.`);
  }
  return input;
}
function ratio(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0 || input > 1) {
    throw new TypeError(`${path} must be greater than 0 and at most 1.`);
  }
  return input;
}
function evidenceCoverage(input: VerificationEvidenceCoverage, path: string): VerificationEvidenceCoverage {
  if (typeof input.ratio !== "number" || !Number.isFinite(input.ratio) || input.ratio < 0 || input.ratio > 1) {
    throw new TypeError(`${path}.ratio must be between 0 and 1.`);
  }
  return { ratio: input.ratio, basis: nonEmpty(input.basis, `${path}.basis`) };
}
function retryPolicy(input: unknown, path: string): VerificationCheckRetryPolicy {
  if (input !== "never" && input !== "safe" && input !== "confirmed_no_effect") {
    throw new TypeError(`${path} is unsupported.`);
  }
  return input;
}
function replayBasis(input: unknown, path: string): VerificationCheckReplayBasis {
  if (input !== "initial" && input !== "safe_replay" && input !== "confirmed_no_effect") {
    throw new TypeError(`${path} is unsupported.`);
  }
  return input;
}
function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw new TypeError(`${path} must be an ISO date-time.`);
  return input;
}
function tokenList(input: readonly string[], path: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) throw new TypeError(`${path} must ${allowEmpty ? "be an array" : "not be empty"}.`);
  return unique(input.map((item, index) => token(item, `${path}[${index}]`)), (item) => item, path);
}
function textList(input: readonly string[], path: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) throw new TypeError(`${path} must ${allowEmpty ? "be an array" : "not be empty"}.`);
  return unique(input.map((item, index) => nonEmpty(item, `${path}[${index}]`)), (item) => item, path);
}
function enumList<T extends string>(input: readonly T[], allowed: readonly T[], path: string): readonly T[] {
  if (!Array.isArray(input) || input.length === 0 || input.some((item) => !allowed.includes(item))) throw new TypeError(`${path} contains an unsupported value.`);
  return unique(input, (item) => item, path);
}
function unique<T>(input: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  const values = input.map(key);
  if (new Set(values).size !== values.length) throw new TypeError(`${path} must not contain duplicates.`);
  return [...input];
}
function clone<T>(input: T): T {
  if (Array.isArray(input)) return input.map((item) => clone(item)) as T;
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T;
  }
  return input;
}
function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
