import {
  ModelProtocolBindingError, requireModelPurpose, sameProtocolRef, sameRevisionRef,
  snapshotModelAgentCompositionBinding, snapshotModelInteractionScope, snapshotModelPurposeEvidence,
  snapshotProtocolRevisionRef,
  type ModelAgentCompositionBinding, type ModelInteractionScope, type ModelPurposeEvidence, type ProtocolRevisionRef,
} from "@agent-anything/model-interaction/protocol";
import { modelInputValueDigest } from "@agent-anything/model-interaction/input";

export interface ProtocolModelActivity {
  readonly composition: ModelAgentCompositionBinding;
  readonly scope: ModelInteractionScope;
  /** These are original accepted conditions; this contract never selects a native path. */
  readonly conditions: {
    readonly input: ProtocolRevisionRef;
    readonly authority: ProtocolRevisionRef;
    readonly resources: ProtocolRevisionRef;
    readonly control: ProtocolRevisionRef;
  };
  readonly digest: string;
}

export function bindProtocolModelActivity(input: Omit<ProtocolModelActivity, "digest">): ProtocolModelActivity {
  record(input, ["composition", "scope", "conditions", "digest"]);
  const composition = snapshotModelAgentCompositionBinding(input.composition);
  const scope = snapshotModelInteractionScope(input.scope);
  requireModelPurpose(composition, scope.purpose);
  if (scope.compositionDigest !== composition.digest) throw new ModelProtocolBindingError("activity_original_composition_mismatch");
  const conditions = snapshotConditions(input.conditions);
  const value = { composition, scope, conditions };
  return Object.freeze({ ...value, digest: modelInputValueDigest(value) });
}

export function assertProtocolModelActivityOriginal(original: ProtocolModelActivity, current: ProtocolModelActivity): void {
  for (const activity of [original, current]) {
    const reconstructed = bindProtocolModelActivity(activity);
    if (activity.digest !== reconstructed.digest) throw new ModelProtocolBindingError("protocol_activity_integrity_failed");
  }
  if (original.digest !== current.digest) throw new ModelProtocolBindingError("protocol_activity_original_binding_unavailable");
}

/** Legal acceptance checks provenance; the registered purpose owner interprets its content. */
export function assertProtocolPurposeEvidence(activity: ProtocolModelActivity, input: ModelPurposeEvidence): ModelPurposeEvidence {
  assertProtocolModelActivityOriginal(activity, activity);
  const evidence = snapshotModelPurposeEvidence(input);
  const purpose = requireModelPurpose(activity.composition, activity.scope.purpose);
  if (modelInputValueDigest(evidence.scope) !== modelInputValueDigest(activity.scope) ||
      !sameRevisionRef(evidence.interpreter, purpose.interpreter.implementation) ||
      evidence.sources.some(source => !sameProtocolRef(source.protocol, activity.composition.composition.protocol) ||
        !sameRevisionRef(source.interpretation, activity.composition.composition.adapter.implementation)))
    throw new ModelProtocolBindingError("protocol_purpose_evidence_binding_mismatch");
  return evidence;
}

function snapshotConditions(input: ProtocolModelActivity["conditions"]): ProtocolModelActivity["conditions"] {
  record(input, ["input", "authority", "resources", "control"]);
  return Object.freeze({ input: snapshotProtocolRevisionRef(input.input), authority: snapshotProtocolRevisionRef(input.authority),
    resources: snapshotProtocolRevisionRef(input.resources), control: snapshotProtocolRevisionRef(input.control) });
}

function record(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length ||
      Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, d]) => !keys.includes(key) || !d.enumerable || !("value" in d)))
    throw new ModelProtocolBindingError("protocol_activity_conditions_invalid");
}
