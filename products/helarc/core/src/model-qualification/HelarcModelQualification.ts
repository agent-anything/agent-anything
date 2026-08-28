import { createHash } from "node:crypto";

export const HELARC_MODEL_QUALIFICATION_PROTOCOL_REVISION =
  "helarc.model-qualification.v1";

export const HELARC_MODEL_QUALIFICATION_SCOPES = Object.freeze([
  "agent_loop",
  "workspace_observation",
  "workspace_mutation",
  "process_execution",
  "user_interaction",
  "delegation",
] as const);

export type HelarcModelQualificationScope =
  typeof HELARC_MODEL_QUALIFICATION_SCOPES[number];

export type HelarcModelQualificationOutcome =
  | "qualified"
  | "not_qualified"
  | "inconclusive";

export type HelarcModelQualificationApplicabilityStatus =
  | "current"
  | "stale"
  | "absent";

export type HelarcModelQualificationPolicy =
  | "require_qualified"
  | "allow_experimental";

export type HelarcModelUseDispositionStatus =
  | "qualified"
  | "experimental"
  | "blocked";

export type HelarcModelIdentityStrength =
  | "immutable"
  | "mutable_alias"
  | "unknown";

export interface HelarcModelQualificationTarget {
  readonly id: string;
  readonly productRevision: string;
  readonly providerKind: string;
  readonly providerAdapterRevision: string;
  readonly providerCapabilityDigest: string;
  readonly endpointCompatibilityFamily: string;
  readonly safeProviderConfigurationDigest: string;
  readonly modelId: string;
  readonly modelArtifactRevision: string | null;
  readonly modelIdentityStrength: HelarcModelIdentityStrength;
  readonly modelRuntimeRevision: string | null;
  readonly generationConfigurationDigest: string;
  readonly agentInstructionBinding: string;
  readonly toolGuidanceBinding: string;
  readonly toolSelectionRevision: string;
  readonly modelInteractionRevision: string;
  readonly operatingProfileRevision: string;
  readonly qualificationProtocolRevision: string;
}

export interface HelarcModelQualificationEvidenceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface HelarcModelQualificationDecisionRef {
  readonly id: string;
  readonly revision: string;
}

export interface HelarcModelQualificationDecision {
  readonly ref: HelarcModelQualificationDecisionRef;
  readonly target: HelarcModelQualificationTarget;
  readonly scope: HelarcModelQualificationScope;
  readonly outcome: HelarcModelQualificationOutcome;
  readonly evidenceRefs: readonly HelarcModelQualificationEvidenceRef[];
  readonly limitations: readonly string[];
  readonly decidedAt: string;
  readonly decidedBy: string;
  readonly supersedes: HelarcModelQualificationDecisionRef | null;
}

export interface HelarcModelQualificationCatalog {
  readonly revision: string;
  readonly decisions: readonly HelarcModelQualificationDecision[];
}

export interface HelarcModelQualificationApplicability {
  readonly targetId: string;
  readonly scope: HelarcModelQualificationScope;
  readonly status: HelarcModelQualificationApplicabilityStatus;
  readonly decision: HelarcModelQualificationDecision | null;
  readonly staleDecisionRefs: readonly HelarcModelQualificationDecisionRef[];
}

export interface HelarcModelUseScopeDisposition {
  readonly scope: HelarcModelQualificationScope;
  readonly applicability: HelarcModelQualificationApplicabilityStatus;
  readonly outcome: HelarcModelQualificationOutcome | null;
  readonly decision: HelarcModelQualificationDecisionRef | null;
}

export interface HelarcModelUseDisposition {
  readonly id: string;
  readonly status: HelarcModelUseDispositionStatus;
  readonly policy: HelarcModelQualificationPolicy;
  readonly targetId: string;
  readonly nativeToolInteractionSupported: boolean;
  readonly scopes: readonly HelarcModelUseScopeDisposition[];
  readonly reasons: readonly string[];
}

export interface HelarcModelQualificationSafeProjection {
  readonly providerKind: string;
  readonly modelId: string;
  readonly modelIdentityStrength: HelarcModelIdentityStrength;
  readonly status: HelarcModelUseDispositionStatus;
  readonly policy: HelarcModelQualificationPolicy;
  readonly scopes: readonly HelarcModelUseScopeDisposition[];
  readonly reasons: readonly string[];
}

export type HelarcModelQualificationErrorCode =
  | "model_qualification_target_invalid"
  | "model_qualification_evidence_invalid"
  | "model_qualification_decision_invalid"
  | "model_qualification_decision_duplicate"
  | "model_qualification_supersession_invalid"
  | "model_qualification_catalog_corrupt"
  | "model_qualification_scope_invalid"
  | "model_qualification_policy_invalid";

export class HelarcModelQualificationError extends TypeError {
  constructor(
    readonly code: HelarcModelQualificationErrorCode,
    message: string,
    readonly path: string | null = null,
  ) {
    super(message);
    this.name = "HelarcModelQualificationError";
  }
}

export function createHelarcModelQualificationTarget(
  input: Omit<HelarcModelQualificationTarget, "id">,
): HelarcModelQualificationTarget {
  assertExactRecord(input, "HelarcModelQualificationTarget", [
    "productRevision",
    "providerKind",
    "providerAdapterRevision",
    "providerCapabilityDigest",
    "endpointCompatibilityFamily",
    "safeProviderConfigurationDigest",
    "modelId",
    "modelArtifactRevision",
    "modelIdentityStrength",
    "modelRuntimeRevision",
    "generationConfigurationDigest",
    "agentInstructionBinding",
    "toolGuidanceBinding",
    "toolSelectionRevision",
    "modelInteractionRevision",
    "operatingProfileRevision",
    "qualificationProtocolRevision",
  ], "model_qualification_target_invalid");
  const fields = {
    productRevision: token(input.productRevision, "target.productRevision"),
    providerKind: token(input.providerKind, "target.providerKind"),
    providerAdapterRevision: token(
      input.providerAdapterRevision,
      "target.providerAdapterRevision",
    ),
    providerCapabilityDigest: digestRef(
      input.providerCapabilityDigest,
      "target.providerCapabilityDigest",
    ),
    endpointCompatibilityFamily: token(
      input.endpointCompatibilityFamily,
      "target.endpointCompatibilityFamily",
    ),
    safeProviderConfigurationDigest: digestRef(
      input.safeProviderConfigurationDigest,
      "target.safeProviderConfigurationDigest",
    ),
    modelId: token(input.modelId, "target.modelId"),
    modelArtifactRevision: nullableToken(
      input.modelArtifactRevision,
      "target.modelArtifactRevision",
    ),
    modelIdentityStrength: identityStrength(input.modelIdentityStrength),
    modelRuntimeRevision: nullableToken(
      input.modelRuntimeRevision,
      "target.modelRuntimeRevision",
    ),
    generationConfigurationDigest: digestRef(
      input.generationConfigurationDigest,
      "target.generationConfigurationDigest",
    ),
    agentInstructionBinding: token(
      input.agentInstructionBinding,
      "target.agentInstructionBinding",
    ),
    toolGuidanceBinding: token(
      input.toolGuidanceBinding,
      "target.toolGuidanceBinding",
    ),
    toolSelectionRevision: token(
      input.toolSelectionRevision,
      "target.toolSelectionRevision",
    ),
    modelInteractionRevision: token(
      input.modelInteractionRevision,
      "target.modelInteractionRevision",
    ),
    operatingProfileRevision: token(
      input.operatingProfileRevision,
      "target.operatingProfileRevision",
    ),
    qualificationProtocolRevision: token(
      input.qualificationProtocolRevision,
      "target.qualificationProtocolRevision",
    ),
  };
  return deepFreeze({
    id: digest("agent-anything.helarc.model-qualification-target.v1", fields),
    ...fields,
  });
}

export function createHelarcModelQualificationDecision(input: {
  readonly id: string;
  readonly target: HelarcModelQualificationTarget;
  readonly scope: HelarcModelQualificationScope;
  readonly outcome: HelarcModelQualificationOutcome;
  readonly evidenceRefs: readonly HelarcModelQualificationEvidenceRef[];
  readonly limitations?: readonly string[];
  readonly decidedAt: string;
  readonly decidedBy: string;
  readonly supersedes?: HelarcModelQualificationDecisionRef | null;
}): HelarcModelQualificationDecision {
  assertExactRecord(input, "HelarcModelQualificationDecision", [
    "id",
    "target",
    "scope",
    "outcome",
    "evidenceRefs",
    "limitations",
    "decidedAt",
    "decidedBy",
    "supersedes",
  ], "model_qualification_decision_invalid");
  const id = token(input.id, "decision.id");
  const target = snapshotTarget(input.target);
  const evidenceRefs = snapshotEvidenceRefs(input.evidenceRefs);
  if (evidenceRefs.length === 0) {
    qualificationError(
      "model_qualification_evidence_invalid",
      "A model qualification decision requires at least one exact evidence reference.",
      "decision.evidenceRefs",
    );
  }
  const fields = {
    target,
    scope: qualificationScope(input.scope),
    outcome: qualificationOutcome(input.outcome),
    evidenceRefs,
    limitations: snapshotLimitations(input.limitations ?? []),
    decidedAt: dateTime(input.decidedAt, "decision.decidedAt"),
    decidedBy: token(input.decidedBy, "decision.decidedBy"),
    supersedes: input.supersedes == null
      ? null
      : snapshotDecisionRef(input.supersedes, "decision.supersedes"),
  };
  return deepFreeze({
    ref: {
      id,
      revision: digest("agent-anything.helarc.model-qualification-decision.v1", {
        id,
        ...fields,
      }),
    },
    ...fields,
  });
}

export function createHelarcModelQualificationCatalog(input: {
  readonly decisions: readonly HelarcModelQualificationDecision[];
}): HelarcModelQualificationCatalog {
  assertExactRecord(input, "HelarcModelQualificationCatalog", ["decisions"],
    "model_qualification_catalog_corrupt");
  if (!Array.isArray(input.decisions)) {
    qualificationError(
      "model_qualification_catalog_corrupt",
      "A model qualification catalog requires a decision array.",
      "decisions",
    );
  }
  assertDenseArray(input.decisions, "decisions", "model_qualification_catalog_corrupt");
  const decisions = Object.freeze(input.decisions.map(snapshotDecision));
  const refKeys = decisions.map(({ ref }) => decisionRefKey(ref));
  if (new Set(refKeys).size !== refKeys.length) {
    qualificationError(
      "model_qualification_decision_duplicate",
      "A model qualification catalog cannot contain duplicate decision revisions.",
      "decisions",
    );
  }
  const byRef = new Map(decisions.map((decision) => [decisionRefKey(decision.ref), decision]));
  const superseded = new Set<string>();
  for (const decision of decisions) {
    if (decision.supersedes === null) continue;
    const previous = byRef.get(decisionRefKey(decision.supersedes));
    if (previous === undefined) {
      qualificationError(
        "model_qualification_supersession_invalid",
        `Decision '${decisionRefKey(decision.ref)}' supersedes a missing decision.`,
      );
    }
    if (previous.target.id !== decision.target.id || previous.scope !== decision.scope) {
      qualificationError(
        "model_qualification_supersession_invalid",
        "A qualification decision may supersede only the same exact target and scope.",
      );
    }
    const previousKey = decisionRefKey(previous.ref);
    if (superseded.has(previousKey)) {
      qualificationError(
        "model_qualification_supersession_invalid",
        `Decision '${previousKey}' has more than one successor.`,
      );
    }
    superseded.add(previousKey);
    assertNoSupersessionCycle(decision, byRef);
  }
  const groups = new Map<string, HelarcModelQualificationDecision[]>();
  for (const decision of decisions) {
    const key = targetScopeKey(decision.target.id, decision.scope);
    const group = groups.get(key) ?? [];
    group.push(decision);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const heads = group.filter((decision) => !superseded.has(decisionRefKey(decision.ref)));
    if (heads.length !== 1) {
      qualificationError(
        "model_qualification_supersession_invalid",
        `Qualification target and scope '${key}' must have exactly one current decision head.`,
      );
    }
  }
  return deepFreeze({
    revision: digest("agent-anything.helarc.model-qualification-catalog.v1", {
      decisions: decisions.map(({ ref }) => ref),
    }),
    decisions,
  });
}

export function resolveHelarcModelQualificationApplicability(input: {
  readonly catalog: HelarcModelQualificationCatalog;
  readonly target: HelarcModelQualificationTarget;
  readonly scope: HelarcModelQualificationScope;
}): HelarcModelQualificationApplicability {
  const target = snapshotTarget(input.target);
  const scope = qualificationScope(input.scope);
  const heads = currentDecisionHeads(input.catalog.decisions);
  const current = heads.find((decision) =>
    decision.target.id === target.id && decision.scope === scope
  );
  if (current !== undefined) {
    return deepFreeze({
      targetId: target.id,
      scope,
      status: "current" as const,
      decision: current,
      staleDecisionRefs: Object.freeze([]),
    });
  }
  const staleDecisionRefs = Object.freeze(heads
    .filter((decision) =>
      decision.scope === scope && sameModelSubject(decision.target, target)
    )
    .map(({ ref }) => ref)
    .sort((left, right) => decisionRefKey(left).localeCompare(decisionRefKey(right))));
  return deepFreeze({
    targetId: target.id,
    scope,
    status: staleDecisionRefs.length === 0 ? "absent" as const : "stale" as const,
    decision: null,
    staleDecisionRefs,
  });
}

export function deriveHelarcModelUseDisposition(input: {
  readonly catalog: HelarcModelQualificationCatalog;
  readonly target: HelarcModelQualificationTarget;
  readonly nativeToolInteractionSupported: boolean;
  readonly requiredScopes: readonly HelarcModelQualificationScope[];
  readonly policy: HelarcModelQualificationPolicy;
}): HelarcModelUseDisposition {
  const target = snapshotTarget(input.target);
  const policy = qualificationPolicy(input.policy);
  const requiredScopes = snapshotScopes(input.requiredScopes);
  if (!requiredScopes.includes("agent_loop")) {
    qualificationError(
      "model_qualification_scope_invalid",
      "Every Helarc model-use disposition requires the agent_loop qualification scope.",
      "requiredScopes",
    );
  }
  if (typeof input.nativeToolInteractionSupported !== "boolean") {
    qualificationError(
      "model_qualification_target_invalid",
      "Native Tool interaction support must be a boolean mechanical capability claim.",
      "nativeToolInteractionSupported",
    );
  }
  const applicability = requiredScopes.map((scope) =>
    resolveHelarcModelQualificationApplicability({ catalog: input.catalog, target, scope })
  );
  const scopes = Object.freeze(applicability.map((item) => Object.freeze({
    scope: item.scope,
    applicability: item.status,
    outcome: item.decision?.outcome ?? null,
    decision: item.decision?.ref ?? null,
  })));
  const reasons: string[] = [];
  let status: HelarcModelUseDispositionStatus;
  if (!input.nativeToolInteractionSupported) {
    status = "blocked";
    reasons.push("native_tool_interaction_unsupported");
  } else {
    const currentNotQualified = applicability.filter((item) =>
      item.status === "current" && item.decision?.outcome === "not_qualified"
    );
    if (currentNotQualified.length > 0) {
      status = "blocked";
      reasons.push(...currentNotQualified.map(({ scope }) => `scope_not_qualified:${scope}`));
    } else {
      const unresolved = applicability.filter((item) =>
        item.status !== "current" || item.decision?.outcome !== "qualified"
      );
      if (unresolved.length === 0) {
        status = "qualified";
      } else if (policy === "allow_experimental") {
        status = "experimental";
        reasons.push(...unresolved.map((item) =>
          item.status === "current"
            ? `scope_inconclusive:${item.scope}`
            : `scope_${item.status}:${item.scope}`
        ));
      } else {
        status = "blocked";
        reasons.push(...unresolved.map((item) =>
          item.status === "current"
            ? `scope_inconclusive:${item.scope}`
            : `scope_${item.status}:${item.scope}`
        ));
      }
    }
  }
  const fields = {
    status,
    policy,
    targetId: target.id,
    nativeToolInteractionSupported: input.nativeToolInteractionSupported,
    scopes,
    reasons: Object.freeze([...new Set(reasons)].sort(compareStrings)),
  };
  return deepFreeze({
    id: digest("agent-anything.helarc.model-use-disposition.v1", fields),
    ...fields,
  });
}

export function projectHelarcModelQualificationSafe(input: {
  readonly target: HelarcModelQualificationTarget;
  readonly disposition: HelarcModelUseDisposition;
}): HelarcModelQualificationSafeProjection {
  const target = snapshotTarget(input.target);
  if (input.disposition.targetId !== target.id) {
    qualificationError(
      "model_qualification_target_invalid",
      "Model-use disposition targets a different qualification target.",
    );
  }
  return deepFreeze({
    providerKind: target.providerKind,
    modelId: target.modelId,
    modelIdentityStrength: target.modelIdentityStrength,
    status: input.disposition.status,
    policy: input.disposition.policy,
    scopes: input.disposition.scopes,
    reasons: input.disposition.reasons,
  });
}

function snapshotTarget(input: HelarcModelQualificationTarget): HelarcModelQualificationTarget {
  const { id, ...fields } = input;
  const recreated = createHelarcModelQualificationTarget(fields);
  if (id !== recreated.id) {
    qualificationError(
      "model_qualification_target_invalid",
      "Model qualification target identity does not match its exact contents.",
      "target.id",
    );
  }
  return recreated;
}

function snapshotDecision(
  input: HelarcModelQualificationDecision,
): HelarcModelQualificationDecision {
  const recreated = createHelarcModelQualificationDecision({
    id: input.ref.id,
    target: input.target,
    scope: input.scope,
    outcome: input.outcome,
    evidenceRefs: input.evidenceRefs,
    limitations: input.limitations,
    decidedAt: input.decidedAt,
    decidedBy: input.decidedBy,
    supersedes: input.supersedes,
  });
  if (recreated.ref.revision !== input.ref.revision) {
    qualificationError(
      "model_qualification_catalog_corrupt",
      `Qualification decision '${input.ref.id}' digest is invalid.`,
    );
  }
  return recreated;
}

function snapshotEvidenceRefs(
  input: readonly HelarcModelQualificationEvidenceRef[],
): readonly HelarcModelQualificationEvidenceRef[] {
  if (!Array.isArray(input)) {
    qualificationError(
      "model_qualification_evidence_invalid",
      "Qualification evidence references must be an array.",
      "evidenceRefs",
    );
  }
  assertDenseArray(input, "evidenceRefs", "model_qualification_evidence_invalid");
  const refs = input.map((ref, index) => {
    assertExactRecord(ref, `evidenceRefs[${index}]`, ["owner", "kind", "id", "revision"],
      "model_qualification_evidence_invalid");
    return Object.freeze({
      owner: token(ref.owner, `evidenceRefs[${index}].owner`),
      kind: token(ref.kind, `evidenceRefs[${index}].kind`),
      id: token(ref.id, `evidenceRefs[${index}].id`),
      revision: token(ref.revision, `evidenceRefs[${index}].revision`),
    });
  });
  const keys = refs.map((ref) => `${ref.owner}/${ref.kind}/${ref.id}@${ref.revision}`);
  if (new Set(keys).size !== keys.length) {
    qualificationError(
      "model_qualification_evidence_invalid",
      "Qualification evidence references cannot contain duplicates.",
      "evidenceRefs",
    );
  }
  return Object.freeze(refs);
}

function snapshotDecisionRef(
  input: HelarcModelQualificationDecisionRef,
  path: string,
): HelarcModelQualificationDecisionRef {
  assertExactRecord(input, path, ["id", "revision"], "model_qualification_decision_invalid");
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    revision: digestRef(input.revision, `${path}.revision`),
  });
}

function snapshotLimitations(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input)) {
    qualificationError(
      "model_qualification_decision_invalid",
      "Qualification limitations must be an array.",
      "limitations",
    );
  }
  assertDenseArray(input, "limitations", "model_qualification_decision_invalid");
  const limitations = input.map((value, index) =>
    boundedText(value, `limitations[${index}]`, 8_192)
  );
  if (new Set(limitations).size !== limitations.length) {
    qualificationError(
      "model_qualification_decision_invalid",
      "Qualification limitations cannot contain duplicates.",
      "limitations",
    );
  }
  return Object.freeze(limitations);
}

function snapshotScopes(
  input: readonly HelarcModelQualificationScope[],
): readonly HelarcModelQualificationScope[] {
  if (!Array.isArray(input) || input.length === 0) {
    qualificationError(
      "model_qualification_scope_invalid",
      "Required qualification scopes must be a non-empty array.",
      "requiredScopes",
    );
  }
  assertDenseArray(input, "requiredScopes", "model_qualification_scope_invalid");
  const scopes = input.map(qualificationScope);
  if (new Set(scopes).size !== scopes.length) {
    qualificationError(
      "model_qualification_scope_invalid",
      "Required qualification scopes cannot contain duplicates.",
      "requiredScopes",
    );
  }
  return Object.freeze(scopes);
}

function currentDecisionHeads(
  decisions: readonly HelarcModelQualificationDecision[],
): readonly HelarcModelQualificationDecision[] {
  const superseded = new Set(decisions
    .flatMap((decision) => decision.supersedes === null ? [] : [decisionRefKey(decision.supersedes)]));
  return decisions.filter((decision) => !superseded.has(decisionRefKey(decision.ref)));
}

function assertNoSupersessionCycle(
  start: HelarcModelQualificationDecision,
  byRef: ReadonlyMap<string, HelarcModelQualificationDecision>,
): void {
  const seen = new Set<string>();
  let current: HelarcModelQualificationDecision | undefined = start;
  while (current !== undefined) {
    const key = decisionRefKey(current.ref);
    if (seen.has(key)) {
      qualificationError(
        "model_qualification_supersession_invalid",
        `Qualification decision '${key}' participates in a supersession cycle.`,
      );
    }
    seen.add(key);
    current = current.supersedes === null
      ? undefined
      : byRef.get(decisionRefKey(current.supersedes));
  }
}

function sameModelSubject(
  left: HelarcModelQualificationTarget,
  right: HelarcModelQualificationTarget,
): boolean {
  return left.providerKind === right.providerKind &&
    left.endpointCompatibilityFamily === right.endpointCompatibilityFamily &&
    left.modelId === right.modelId;
}

function targetScopeKey(targetId: string, scope: HelarcModelQualificationScope): string {
  return `${targetId}/${scope}`;
}

function decisionRefKey(ref: HelarcModelQualificationDecisionRef): string {
  return `${ref.id}@${ref.revision}`;
}

function qualificationScope(input: unknown): HelarcModelQualificationScope {
  if (!HELARC_MODEL_QUALIFICATION_SCOPES.includes(input as HelarcModelQualificationScope)) {
    return qualificationError(
      "model_qualification_scope_invalid",
      `Unsupported model qualification scope '${String(input)}'.`,
    );
  }
  return input as HelarcModelQualificationScope;
}

function qualificationOutcome(input: unknown): HelarcModelQualificationOutcome {
  if (input !== "qualified" && input !== "not_qualified" && input !== "inconclusive") {
    return qualificationError(
      "model_qualification_decision_invalid",
      "Model qualification outcome is invalid.",
      "outcome",
    );
  }
  return input;
}

function qualificationPolicy(input: unknown): HelarcModelQualificationPolicy {
  if (input !== "require_qualified" && input !== "allow_experimental") {
    return qualificationError(
      "model_qualification_policy_invalid",
      "Model qualification Product policy is invalid.",
      "policy",
    );
  }
  return input;
}

function identityStrength(input: unknown): HelarcModelIdentityStrength {
  if (input !== "immutable" && input !== "mutable_alias" && input !== "unknown") {
    return qualificationError(
      "model_qualification_target_invalid",
      "Model identity strength is invalid.",
      "modelIdentityStrength",
    );
  }
  return input;
}

function token(input: unknown, path: string): string {
  if (
    typeof input !== "string" || input.length === 0 || input.length > 4_096 ||
    input !== input.trim() || input.includes("\0")
  ) {
    return qualificationError(
      "model_qualification_target_invalid",
      `${path} must be a bounded canonical token.`,
      path,
    );
  }
  return input;
}

function nullableToken(input: unknown, path: string): string | null {
  return input === null ? null : token(input, path);
}

function digestRef(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input)) {
    return qualificationError(
      "model_qualification_target_invalid",
      `${path} must be a canonical SHA-256 reference.`,
      path,
    );
  }
  return input;
}

function boundedText(input: unknown, path: string, maxLength: number): string {
  if (
    typeof input !== "string" || input.trim().length === 0 ||
    input.length > maxLength || input.includes("\0")
  ) {
    return qualificationError(
      "model_qualification_decision_invalid",
      `${path} must be bounded non-empty text.`,
      path,
    );
  }
  return input;
}

function dateTime(input: unknown, path: string): string {
  if (
    typeof input !== "string" || Number.isNaN(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  ) {
    return qualificationError(
      "model_qualification_decision_invalid",
      `${path} must be an ISO date-time string.`,
      path,
    );
  }
  return input;
}

function assertExactRecord(
  input: unknown,
  path: string,
  allowed: readonly string[],
  code: HelarcModelQualificationErrorCode,
): void {
  if (!isPlainRecord(input)) {
    qualificationError(code, `${path} must be a plain object.`, path);
  }
  assertNoAccessors(input, path, code);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    qualificationError(code, `${path} contains an unsupported field.`, path);
  }
}

function assertNoAccessors(
  input: Record<string, any>,
  path: string,
  code: HelarcModelQualificationErrorCode,
): void {
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      qualificationError(code, `${path} cannot contain accessors.`, `${path}.${String(key)}`);
    }
  }
}

function assertDenseArray(
  input: readonly unknown[],
  path: string,
  code: HelarcModelQualificationErrorCode,
): void {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      qualificationError(code, `${path} cannot contain sparse arrays.`, `${path}[${index}]`);
    }
  }
}

function isPlainRecord(input: unknown): input is Record<string, any> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function qualificationError(
  code: HelarcModelQualificationErrorCode,
  message: string,
  path: string | null = null,
): never {
  throw new HelarcModelQualificationError(code, message, path);
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      qualificationError(
        "model_qualification_target_invalid",
        "Model qualification identity data requires finite numbers.",
      );
    }
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainRecord(value)) {
    return qualificationError(
      "model_qualification_target_invalid",
      "Model qualification identity data must use canonical JSON objects.",
    );
  }
  const keys = Object.keys(value).sort(compareStrings);
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
