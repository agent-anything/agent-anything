import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import {
  snapshotDelegationOriginCorrelation,
  snapshotDelegationPredecessorCorrelation,
  snapshotDelegationRequestRef,
  snapshotDelegationResultRef,
  type DelegationOriginCorrelation,
  type DelegationPredecessorCorrelation,
  type DelegationRequestRef,
  type DelegationResultRef,
} from "@agent-anything/agent-core/delegation";
import type { ContextJsonObject, ContextJsonValue } from "@agent-anything/context/contract";
import type { ToolRevisionRef } from "@agent-anything/tools/identity";
import type { ToolCall } from "@agent-anything/tools/invocation";
import {
  snapshotDelegationAuthorityDimensions,
  snapshotDelegationAuthorityDerivation,
  type DelegationAuthorityDerivation,
  type DelegationAuthorityDerivationRef,
  type DelegationAuthorityDimensionInput,
} from "./DelegationAuthority.js";
import {
  boundedText,
  createDelegationContractIdentity,
  deepFreeze,
  isoDateTime,
  positiveInteger,
  snapshotDelegationJsonValue,
  strictRecord,
  token,
} from "./DelegationContract.js";
import {
  snapshotDelegationLimitDerivation,
  type DelegationLimitDerivation,
  type DelegationLimitDerivationRef,
} from "./DelegationResources.js";

export interface DelegationContextMaterialRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface DelegationContextMaterial {
  readonly ref: DelegationContextMaterialRef;
  readonly payload: ContextJsonValue;
}

export type DelegationContextMaterialRole =
  | "root_purpose"
  | "workspace"
  | "product_context"
  | "parent_fact"
  | "predecessor_result";

export interface DelegationContextPlanEntry {
  readonly role: DelegationContextMaterialRole;
  readonly material: DelegationContextMaterialRef;
  readonly necessity: "mandatory" | "optional";
}

export interface DelegationContextPlan {
  readonly schemaVersion: 1;
  readonly entries: readonly DelegationContextPlanEntry[];
  readonly maxContextBytes: number;
  readonly revision: string;
}

export interface DelegatedObjective {
  readonly text: string;
  readonly constraints: readonly string[];
}

export type DelegationExpectedResultForm =
  | "narrative"
  | "evidence"
  | "artifacts"
  | "validation"
  | "effects";

export interface DelegationExpectedResultRequirement {
  readonly form: DelegationExpectedResultForm;
  readonly required: boolean;
  readonly maxItems: number;
}

export interface DelegationResultExpectation {
  readonly requirements: readonly DelegationExpectedResultRequirement[];
  readonly maxNarrativeCharacters: number;
  readonly revision: string;
}

export interface DelegationTaskPreparation {
  readonly kind: string;
  readonly input: ContextJsonValue;
  readonly metadata: ContextJsonObject;
}

export interface DelegationLimits {
  readonly maxControllerTurns: number;
  readonly maxActions: number;
  readonly maxDurationMs: number;
  readonly maxContextBytes: number;
  readonly maxResultBytes: number;
  readonly revision: string;
}

export interface DelegationPreparation {
  readonly schemaVersion: 1;
  readonly childAgent: AgentRevisionRef;
  readonly task: DelegationTaskPreparation;
  readonly objective: DelegatedObjective;
  readonly expectedResult: DelegationResultExpectation;
  readonly contextPlan: DelegationContextPlan;
  readonly requestedAuthority: readonly DelegationAuthorityDimensionInput[];
  readonly limits: DelegationLimits;
  readonly predecessor: DelegationResultRef | null;
}

export interface DelegationToolCallCorrelation {
  readonly id: string;
  readonly tool: ToolRevisionRef;
  readonly inputDigest: string;
  readonly bindingRevision: string;
  readonly selectionRevision: string;
  readonly exposureProofId: string;
}

export interface DelegationRequest {
  readonly schemaVersion: 1;
  readonly ref: DelegationRequestRef;
  readonly origin: DelegationOriginCorrelation;
  readonly toolCall: DelegationToolCallCorrelation;
  readonly childAgent: AgentRevisionRef;
  readonly task: DelegationTaskPreparation;
  readonly objective: DelegatedObjective;
  readonly rootPurposeAnchor: DelegationContextMaterialRef;
  readonly expectedResult: DelegationResultExpectation;
  readonly contextPlan: DelegationContextPlan;
  readonly authorityDerivation: DelegationAuthorityDerivationRef;
  readonly limitDerivation: DelegationLimitDerivationRef;
  readonly limits: DelegationLimits;
  readonly predecessor: DelegationPredecessorCorrelation | null;
  readonly createdAt: string;
}

export class DelegationRequestValidationError extends TypeError {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DelegationRequestValidationError";
  }
}

export function materializeDelegationRequest(input: {
  readonly requestId: string;
  readonly origin: DelegationOriginCorrelation;
  readonly toolCall: ToolCall;
  readonly preparation: DelegationPreparation;
  readonly authorityDerivation: DelegationAuthorityDerivation;
  readonly limitDerivation: DelegationLimitDerivation;
  readonly predecessor: {
    readonly correlation: DelegationPredecessorCorrelation;
    readonly material: DelegationContextMaterial;
  } | null;
  readonly createdAt: string;
}): DelegationRequest {
  try {
    strictRecord(input, "DelegationRequestMaterializationInput", [
      "requestId",
      "origin",
      "toolCall",
      "preparation",
      "authorityDerivation",
      "limitDerivation",
      "predecessor",
      "createdAt",
    ]);
    const requestId = token(input.requestId, "requestId");
    const origin = snapshotDelegationOriginCorrelation(input.origin);
    const preparation = snapshotDelegationPreparation(input.preparation);
    const authority = snapshotDelegationAuthorityDerivation(input.authorityDerivation);
    const limitDerivation = snapshotDelegationLimitDerivation(input.limitDerivation);
    const createdAt = isoDateTime(input.createdAt, "createdAt");
    const toolCall = snapshotToolCallCorrelation(input.toolCall, origin, preparation.childAgent);
    const resolvedPredecessor = input.predecessor === null
      ? null
      : Object.freeze({
          correlation: snapshotDelegationPredecessorCorrelation(
            input.predecessor.correlation,
          ),
          material: snapshotDelegationContextMaterial(input.predecessor.material),
        });
    if ((preparation.predecessor === null) !== (resolvedPredecessor === null)) {
      fail(
        "delegation_predecessor_resolution_mismatch",
        "Delegation predecessor proposal and trusted resolution disagree.",
      );
    }
    if (
      preparation.predecessor !== null &&
      resolvedPredecessor !== null &&
      (preparation.predecessor.id !== resolvedPredecessor.correlation.result.id ||
        preparation.predecessor.revision !== resolvedPredecessor.correlation.result.revision)
    ) {
      fail(
        "delegation_predecessor_result_mismatch",
        "Delegation predecessor does not match the trusted settled result.",
      );
    }
    const contextPlan = createDelegationContextPlan({
      entries: Object.freeze([
        ...preparation.contextPlan.entries,
        ...(resolvedPredecessor === null
          ? []
          : [Object.freeze({
              role: "predecessor_result" as const,
              material: resolvedPredecessor.material.ref,
              necessity: "mandatory" as const,
            })]),
      ]),
      maxContextBytes: preparation.contextPlan.maxContextBytes,
    });
    const rootPurposeAnchor = contextPlan.entries.find(
      (entry) => entry.role === "root_purpose",
    )!.material;

    const requestAuthoritySource = authority.sources.find(
      (source) => source.role === "request",
    )!;
    const requestedAuthority = snapshotDelegationAuthorityDimensions(
      preparation.requestedAuthority,
    );
    if (
      requestAuthoritySource.dimensions.some(
        (dimension, index) =>
          dimension.revision !== requestedAuthority[index]!.revision,
      )
    ) {
      fail(
        "delegation_authority_request_mismatch",
        "Delegation authority derivation does not contain the exact Product request constraints.",
      );
    }

    const requestLimitSource = limitDerivation.sources.find(
      (source) => source.role === "request",
    )!;
    if (requestLimitSource.ceiling.revision !== preparation.limits.revision) {
      fail(
        "delegation_limit_request_mismatch",
        "Delegation limit derivation does not contain the exact Product request ceiling.",
      );
    }
    if (contextPlan.maxContextBytes > limitDerivation.effective.maxContextBytes) {
      fail(
        "delegation_context_limit_exceeded",
        "Delegation Context plan exceeds the effective attenuated Context limit.",
      );
    }

    if (
      resolvedPredecessor !== null &&
      resolvedPredecessor.correlation.root.id !== origin.root.run.id
    ) {
      fail(
        "delegation_predecessor_wrong_root",
        "Delegation predecessor must belong to the same root Run.",
      );
    }

    const material = deepFreeze({
      origin,
      toolCall,
      childAgent: preparation.childAgent,
      task: preparation.task,
      objective: preparation.objective,
      rootPurposeAnchor,
      expectedResult: preparation.expectedResult,
      contextPlan,
      authorityDerivation: authority.ref,
      limitDerivation: limitDerivation.ref,
      limits: limitDerivation.effective,
      predecessor: resolvedPredecessor?.correlation ?? null,
      createdAt,
    });
    const revision = createDelegationContractIdentity(
      "agent-anything.delegation-request.v1",
      material,
    );
    return deepFreeze({
      schemaVersion: 1 as const,
      ref: { id: requestId, revision },
      ...material,
    });
  } catch (error) {
    if (error instanceof DelegationRequestValidationError) throw error;
    throw new DelegationRequestValidationError(
      "delegation_request_invalid",
      error instanceof Error ? error.message : "Delegation request is invalid.",
    );
  }
}

export function snapshotDelegationPreparation(
  input: DelegationPreparation,
): DelegationPreparation {
  strictRecord(input, "DelegationPreparation", [
    "schemaVersion",
    "childAgent",
    "task",
    "objective",
    "expectedResult",
    "contextPlan",
    "requestedAuthority",
    "limits",
    "predecessor",
  ]);
  if (input.schemaVersion !== 1) {
    throw new TypeError("Delegation preparation must use schema version 1.");
  }
  const childAgent = snapshotAgentRef(input.childAgent);
  const task = snapshotTask(input.task);
  const objective = snapshotObjective(input.objective);
  const expectedResult = snapshotExpectation(input.expectedResult);
  const contextPlan = snapshotContextPlan(input.contextPlan);
  const requestedAuthority = snapshotDelegationAuthorityDimensions(
    input.requestedAuthority,
  );
  const limits = snapshotDelegationLimits(input.limits);
  const predecessor = input.predecessor === null
    ? null
    : snapshotDelegationResultRef(input.predecessor);
  const predecessorEntries = contextPlan.entries.filter(
    (entry) => entry.role === "predecessor_result",
  );
  if (predecessorEntries.length > 0) {
    throw new TypeError(
      "Product preparation cannot assign trusted predecessor Context material.",
    );
  }
  if (contextPlan.maxContextBytes > limits.maxContextBytes) {
    throw new TypeError("Delegation Context plan exceeds the request Context limit.");
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    childAgent,
    task,
    objective,
    expectedResult,
    contextPlan,
    requestedAuthority,
    limits,
    predecessor,
  });
}

export function snapshotDelegationRequest(
  input: DelegationRequest,
): DelegationRequest {
  try {
    strictRecord(input, "DelegationRequest", [
      "schemaVersion",
      "ref",
      "origin",
      "toolCall",
      "childAgent",
      "task",
      "objective",
      "rootPurposeAnchor",
      "expectedResult",
      "contextPlan",
      "authorityDerivation",
      "limitDerivation",
      "limits",
      "predecessor",
      "createdAt",
    ]);
    if (input.schemaVersion !== 1) {
      throw new TypeError("Delegation request must use schema version 1.");
    }
    const ref = snapshotDelegationRequestRef(input.ref);
    const origin = snapshotDelegationOriginCorrelation(input.origin);
    const toolCall = snapshotToolCallCorrelationValue(input.toolCall);
    const childAgent = snapshotAgentRef(input.childAgent);
    const task = snapshotTask(input.task);
    const objective = snapshotObjective(input.objective);
    const expectedResult = snapshotExpectation(input.expectedResult);
    const contextPlan = snapshotContextPlan(input.contextPlan);
    const rootPurposeAnchor = snapshotMaterialRef(input.rootPurposeAnchor);
    const acceptedRootPurpose = contextPlan.entries.find(
      (entry) => entry.role === "root_purpose",
    )!.material;
    if (materialRefKey(rootPurposeAnchor) !== materialRefKey(acceptedRootPurpose)) {
      throw new TypeError("Delegation root-purpose anchor does not match the Context plan.");
    }
    const authorityDerivation = snapshotAuthorityRef(input.authorityDerivation);
    const limitDerivation = snapshotLimitDerivationRef(input.limitDerivation);
    const limits = snapshotDelegationLimits(input.limits);
    const predecessor = input.predecessor === null
      ? null
      : snapshotDelegationPredecessorCorrelation(input.predecessor);
    const predecessorEntries = contextPlan.entries.filter(
      (entry) => entry.role === "predecessor_result",
    );
    if (predecessor !== null && predecessor.root.id !== origin.root.run.id) {
      throw new TypeError("Delegation predecessor must belong to the same root Run.");
    }
    if (predecessor === null && predecessorEntries.length > 0) {
      throw new TypeError("A Delegation request cannot include predecessor material without a predecessor result.");
    }
    if (predecessor !== null && predecessorEntries.length !== 1) {
      throw new TypeError("A Delegation continuation requires exactly one predecessor-result material reference.");
    }
    if (contextPlan.maxContextBytes > limits.maxContextBytes) {
      throw new TypeError("Delegation Context plan exceeds the effective Context limit.");
    }
    const createdAt = isoDateTime(input.createdAt, "createdAt");
    const material = deepFreeze({
      origin,
      toolCall,
      childAgent,
      task,
      objective,
      rootPurposeAnchor,
      expectedResult,
      contextPlan,
      authorityDerivation,
      limitDerivation,
      limits,
      predecessor,
      createdAt,
    });
    const revision = createDelegationContractIdentity(
      "agent-anything.delegation-request.v1",
      material,
    );
    if (ref.revision !== revision) {
      throw new TypeError("Delegation request revision does not match its immutable content.");
    }
    return deepFreeze({ schemaVersion: 1 as const, ref, ...material });
  } catch (error) {
    if (error instanceof DelegationRequestValidationError) throw error;
    throw new DelegationRequestValidationError(
      "delegation_request_invalid",
      error instanceof Error ? error.message : "Delegation request is invalid.",
    );
  }
}

export function snapshotDelegationContextPlan(
  input: DelegationContextPlan,
): DelegationContextPlan {
  return snapshotContextPlan(input);
}

export function snapshotDelegationResultExpectation(
  input: DelegationResultExpectation,
): DelegationResultExpectation {
  return snapshotExpectation(input);
}

export function snapshotDelegationLimits(
  input: DelegationLimits,
): DelegationLimits {
  strictRecord(input, "DelegationLimits", [
    "maxControllerTurns",
    "maxActions",
    "maxDurationMs",
    "maxContextBytes",
    "maxResultBytes",
    "revision",
  ]);
  const material = deepFreeze({
    maxControllerTurns: positiveInteger(input.maxControllerTurns, "maxControllerTurns"),
    maxActions: positiveInteger(input.maxActions, "maxActions"),
    maxDurationMs: positiveInteger(input.maxDurationMs, "maxDurationMs"),
    maxContextBytes: positiveInteger(input.maxContextBytes, "maxContextBytes"),
    maxResultBytes: positiveInteger(input.maxResultBytes, "maxResultBytes"),
  });
  const revision = createDelegationContractIdentity(
    "agent-anything.delegation-limits.v1",
    material,
  );
  if (token(input.revision, "DelegationLimits.revision") !== revision) {
    throw new TypeError("Delegation limit revision does not match its immutable content.");
  }
  return deepFreeze({ ...material, revision });
}

export function createDelegationLimits(
  input: Omit<DelegationLimits, "revision">,
): DelegationLimits {
  strictRecord(input, "DelegationLimitsInput", [
    "maxControllerTurns",
    "maxActions",
    "maxDurationMs",
    "maxContextBytes",
    "maxResultBytes",
  ]);
  const material = deepFreeze({
    maxControllerTurns: positiveInteger(input.maxControllerTurns, "maxControllerTurns"),
    maxActions: positiveInteger(input.maxActions, "maxActions"),
    maxDurationMs: positiveInteger(input.maxDurationMs, "maxDurationMs"),
    maxContextBytes: positiveInteger(input.maxContextBytes, "maxContextBytes"),
    maxResultBytes: positiveInteger(input.maxResultBytes, "maxResultBytes"),
  });
  return deepFreeze({
    ...material,
    revision: createDelegationContractIdentity(
      "agent-anything.delegation-limits.v1",
      material,
    ),
  });
}

export function createDelegationContextPlan(input: {
  readonly entries: readonly DelegationContextPlanEntry[];
  readonly maxContextBytes: number;
}): DelegationContextPlan {
  strictRecord(input, "DelegationContextPlanInput", ["entries", "maxContextBytes"]);
  const entries = snapshotContextEntries(input.entries);
  const maxContextBytes = positiveInteger(input.maxContextBytes, "maxContextBytes");
  const material = deepFreeze({ entries, maxContextBytes });
  return deepFreeze({
    schemaVersion: 1 as const,
    ...material,
    revision: createDelegationContractIdentity(
      "agent-anything.delegation-context-plan.v1",
      material,
    ),
  });
}

export function createDelegationContextMaterial(input: {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly payload: unknown;
}): DelegationContextMaterial {
  strictRecord(input, "DelegationContextMaterialInput", [
    "owner",
    "kind",
    "id",
    "payload",
  ]);
  const material = deepFreeze({
    owner: token(input.owner, "DelegationContextMaterial.owner"),
    kind: token(input.kind, "DelegationContextMaterial.kind"),
    id: token(input.id, "DelegationContextMaterial.id"),
    payload: snapshotDelegationJsonValue(
      input.payload as ContextJsonValue,
      "DelegationContextMaterial.payload",
    ),
  });
  return deepFreeze({
    ref: {
      owner: material.owner,
      kind: material.kind,
      id: material.id,
      revision: createDelegationContractIdentity(
        "agent-anything.delegation-context-material.v1",
        material,
      ),
    },
    payload: material.payload,
  });
}

export function snapshotDelegationContextMaterial(
  input: DelegationContextMaterial,
): DelegationContextMaterial {
  strictRecord(input, "DelegationContextMaterial", ["ref", "payload"]);
  const snapshot = createDelegationContextMaterial({
    owner: input.ref.owner,
    kind: input.ref.kind,
    id: input.ref.id,
    payload: input.payload,
  });
  if (snapshot.ref.revision !== input.ref.revision) {
    throw new TypeError(
      "Delegation Context material revision does not match its immutable payload.",
    );
  }
  return snapshot;
}

export function createDelegationResultExpectation(input: {
  readonly requirements: readonly DelegationExpectedResultRequirement[];
  readonly maxNarrativeCharacters: number;
}): DelegationResultExpectation {
  strictRecord(input, "DelegationResultExpectationInput", [
    "requirements",
    "maxNarrativeCharacters",
  ]);
  const requirements = snapshotRequirements(input.requirements);
  const maxNarrativeCharacters = positiveInteger(
    input.maxNarrativeCharacters,
    "maxNarrativeCharacters",
  );
  const material = deepFreeze({ requirements, maxNarrativeCharacters });
  return deepFreeze({
    ...material,
    revision: createDelegationContractIdentity(
      "agent-anything.delegation-result-expectation.v1",
      material,
    ),
  });
}

function snapshotContextPlan(input: DelegationContextPlan): DelegationContextPlan {
  strictRecord(input, "DelegationContextPlan", [
    "schemaVersion",
    "entries",
    "maxContextBytes",
    "revision",
  ]);
  if (input.schemaVersion !== 1) {
    throw new TypeError("Delegation Context plan must use schema version 1.");
  }
  const entries = snapshotContextEntries(input.entries);
  const maxContextBytes = positiveInteger(input.maxContextBytes, "maxContextBytes");
  const material = deepFreeze({ entries, maxContextBytes });
  const revision = createDelegationContractIdentity(
    "agent-anything.delegation-context-plan.v1",
    material,
  );
  if (token(input.revision, "DelegationContextPlan.revision") !== revision) {
    throw new TypeError("Delegation Context-plan revision does not match its immutable content.");
  }
  return deepFreeze({ schemaVersion: 1 as const, ...material, revision });
}

function snapshotContextEntries(
  input: readonly DelegationContextPlanEntry[],
): readonly DelegationContextPlanEntry[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 128) {
    throw new TypeError("Delegation Context plan requires bounded source material.");
  }
  const entries = input.map((entry, index) => {
    strictRecord(entry, `DelegationContextPlan.entries[${index}]`, [
      "role",
      "material",
      "necessity",
    ]);
    if (![
      "root_purpose",
      "workspace",
      "product_context",
      "parent_fact",
      "predecessor_result",
    ].includes(entry.role)) {
      throw new TypeError("Delegation Context material role is unsupported.");
    }
    if (entry.necessity !== "mandatory" && entry.necessity !== "optional") {
      throw new TypeError("Delegation Context material necessity is unsupported.");
    }
    return Object.freeze({
      role: entry.role,
      material: snapshotMaterialRef(entry.material),
      necessity: entry.necessity,
    });
  });
  const keys = entries.map((entry) => materialRefKey(entry.material));
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Delegation Context material references must be unique.");
  }
  const rootEntries = entries.filter((entry) => entry.role === "root_purpose");
  if (rootEntries.length !== 1 || rootEntries[0]!.necessity !== "mandatory") {
    throw new TypeError("Delegation Context plan requires one mandatory root-purpose material reference.");
  }
  return Object.freeze(entries);
}

function snapshotExpectation(
  input: DelegationResultExpectation,
): DelegationResultExpectation {
  strictRecord(input, "DelegationResultExpectation", [
    "requirements",
    "maxNarrativeCharacters",
    "revision",
  ]);
  const requirements = snapshotRequirements(input.requirements);
  const maxNarrativeCharacters = positiveInteger(
    input.maxNarrativeCharacters,
    "maxNarrativeCharacters",
  );
  const material = deepFreeze({ requirements, maxNarrativeCharacters });
  const revision = createDelegationContractIdentity(
    "agent-anything.delegation-result-expectation.v1",
    material,
  );
  if (token(input.revision, "DelegationResultExpectation.revision") !== revision) {
    throw new TypeError("Delegation result-expectation revision does not match its content.");
  }
  return deepFreeze({ ...material, revision });
}

function snapshotRequirements(
  input: readonly DelegationExpectedResultRequirement[],
): readonly DelegationExpectedResultRequirement[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 5) {
    throw new TypeError("Delegation result expectation requires bounded forms.");
  }
  const requirements = input.map((requirement, index) => {
    strictRecord(requirement, `requirements[${index}]`, ["form", "required", "maxItems"]);
    if (!["narrative", "evidence", "artifacts", "validation", "effects"].includes(requirement.form)) {
      throw new TypeError("Delegation expected-result form is unsupported.");
    }
    if (typeof requirement.required !== "boolean") {
      throw new TypeError("Delegation expected-result required flag must be boolean.");
    }
    return Object.freeze({
      form: requirement.form,
      required: requirement.required,
      maxItems: boundedPositiveInteger(
        requirement.maxItems,
        "requirement.maxItems",
        512,
      ),
    });
  });
  if (new Set(requirements.map((requirement) => requirement.form)).size !== requirements.length) {
    throw new TypeError("Delegation expected-result forms must be unique.");
  }
  return Object.freeze(requirements);
}

function snapshotTask(input: DelegationTaskPreparation): DelegationTaskPreparation {
  strictRecord(input, "DelegationTaskPreparation", ["kind", "input", "metadata"]);
  const metadata = snapshotDelegationJsonValue(
    input.metadata,
    "DelegationTaskPreparation.metadata",
  );
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new TypeError("Delegation Task metadata must be a JSON object.");
  }
  return deepFreeze({
    kind: token(input.kind, "DelegationTaskPreparation.kind"),
    input: snapshotDelegationJsonValue(input.input, "DelegationTaskPreparation.input"),
    metadata: metadata as ContextJsonObject,
  });
}

function snapshotObjective(input: DelegatedObjective): DelegatedObjective {
  strictRecord(input, "DelegatedObjective", ["text", "constraints"]);
  if (!Array.isArray(input.constraints) || input.constraints.length > 64) {
    throw new TypeError("Delegated objective constraints must be bounded.");
  }
  const constraints = input.constraints.map((constraint, index) =>
    boundedText(constraint, `DelegatedObjective.constraints[${index}]`, 2_048),
  );
  if (new Set(constraints).size !== constraints.length) {
    throw new TypeError("Delegated objective constraints must be unique.");
  }
  return deepFreeze({
    text: boundedText(input.text, "DelegatedObjective.text", 32_768),
    constraints: Object.freeze(constraints),
  });
}

function snapshotToolCallCorrelation(
  call: ToolCall,
  origin: DelegationOriginCorrelation,
  childAgent: AgentRevisionRef,
): DelegationToolCallCorrelation {
  if (
    call.parentRunAction.run.id !== origin.parent.run.id ||
    call.parentRunAction.id !== origin.parent.action.id ||
    call.parentRunAction.sequence !== origin.parent.action.sequence
  ) {
    fail("delegation_tool_call_origin_mismatch", "Delegation Tool Call does not match the parent RunAction.");
  }
  if (call.origin !== "model") {
    fail("delegation_tool_call_origin_invalid", "A delegation request requires a model-origin Agent Tool Call.");
  }
  if (call.exposureProofId === null) {
    fail("delegation_tool_call_exposure_missing", "Delegation Tool Call requires exact model exposure proof.");
  }
  if (
    call.binding.kind !== "descendant_agent" ||
    call.binding.agent.id !== childAgent.id ||
    call.binding.agent.revision !== childAgent.revision
  ) {
    fail("delegation_child_agent_mismatch", "Delegation Tool binding does not match the resolved child Agent revision.");
  }
  return deepFreeze({
    id: token(call.toolCallId, "toolCall.id"),
    tool: snapshotToolRevisionRef(call.toolRevision),
    inputDigest: token(call.inputDigest, "toolCall.inputDigest"),
    bindingRevision: token(call.binding.revision, "toolCall.bindingRevision"),
    selectionRevision: token(call.selectionRevision, "toolCall.selectionRevision"),
    exposureProofId: token(call.exposureProofId, "toolCall.exposureProofId"),
  });
}

function snapshotToolCallCorrelationValue(
  input: DelegationToolCallCorrelation,
): DelegationToolCallCorrelation {
  strictRecord(input, "DelegationToolCallCorrelation", [
    "id",
    "tool",
    "inputDigest",
    "bindingRevision",
    "selectionRevision",
    "exposureProofId",
  ]);
  return deepFreeze({
    id: token(input.id, "toolCall.id"),
    tool: snapshotToolRevisionRef(input.tool),
    inputDigest: token(input.inputDigest, "toolCall.inputDigest"),
    bindingRevision: token(input.bindingRevision, "toolCall.bindingRevision"),
    selectionRevision: token(input.selectionRevision, "toolCall.selectionRevision"),
    exposureProofId: token(input.exposureProofId, "toolCall.exposureProofId"),
  });
}

function snapshotToolRevisionRef(input: ToolRevisionRef): ToolRevisionRef {
  strictRecord(input, "ToolRevisionRef", ["tool", "revision"]);
  strictRecord(input.tool, "ToolRevisionRef.tool", ["namespace", "name"]);
  return deepFreeze({
    tool: {
      namespace: token(input.tool.namespace, "tool.namespace"),
      name: token(input.tool.name, "tool.name"),
    },
    revision: token(input.revision, "tool.revision"),
  });
}

function snapshotMaterialRef(
  input: DelegationContextMaterialRef,
): DelegationContextMaterialRef {
  strictRecord(input, "DelegationContextMaterialRef", [
    "owner",
    "kind",
    "id",
    "revision",
  ]);
  return Object.freeze({
    owner: token(input.owner, "material.owner"),
    kind: token(input.kind, "material.kind"),
    id: token(input.id, "material.id"),
    revision: token(input.revision, "material.revision"),
  });
}

function snapshotAgentRef(input: AgentRevisionRef): AgentRevisionRef {
  strictRecord(input, "AgentRevisionRef", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "childAgent.id"),
    revision: token(input.revision, "childAgent.revision"),
  });
}

function snapshotAuthorityRef(
  input: DelegationAuthorityDerivationRef,
): DelegationAuthorityDerivationRef {
  strictRecord(input, "DelegationAuthorityDerivationRef", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "authorityDerivation.id"),
    revision: token(input.revision, "authorityDerivation.revision"),
  });
}

function snapshotLimitDerivationRef(
  input: DelegationLimitDerivationRef,
): DelegationLimitDerivationRef {
  strictRecord(input, "DelegationLimitDerivationRef", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "limitDerivation.id"),
    revision: token(input.revision, "limitDerivation.revision"),
  });
}

function materialRefKey(input: DelegationContextMaterialRef): string {
  return `${input.owner}/${input.kind}/${input.id}@${input.revision}`;
}

function fail(code: string, message: string): never {
  throw new DelegationRequestValidationError(code, message);
}

function boundedPositiveInteger(
  input: unknown,
  field: string,
  maximum: number,
): number {
  const value = positiveInteger(input, field);
  if (value > maximum) {
    throw new TypeError(`${field} exceeds its supported bound.`);
  }
  return value;
}
