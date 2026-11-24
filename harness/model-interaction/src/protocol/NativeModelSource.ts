import {
  ModelProtocolBindingError, protocolDigest, protocolList, protocolRecord, protocolToken,
  snapshotModelInteractionProtocol, snapshotProtocolRevisionRef,
  type ModelInteractionProtocolRef, type ProtocolRevisionRef,
} from "./ProtocolIdentity.js";

export interface ModelInteractionScope {
  readonly runId: string;
  readonly activityId: string;
  readonly recipientId: string;
  readonly purpose: ProtocolRevisionRef;
  readonly compositionDigest: string;
}
export interface NativeModelSourceRef {
  readonly scope: ModelInteractionScope;
  readonly protocol: ModelInteractionProtocolRef;
  readonly interpretation: ProtocolRevisionRef;
  readonly operationId: string;
  /** An immutable retained observation, not merely the service's response ID. */
  readonly record: ProtocolRevisionRef;
  readonly position: { readonly format: string; readonly value: string };
  readonly nativeIdentity: { readonly kind: string; readonly id: string } | null;
}
export interface ModelPurposeEvidence {
  readonly scope: ModelInteractionScope;
  readonly interpreter: ProtocolRevisionRef;
  readonly sources: readonly NativeModelSourceRef[];
  /** Interpretation/effect acceptance is independent of native completion. */
  readonly acceptance: ProtocolRevisionRef;
}

export function snapshotModelInteractionScope(value: unknown): ModelInteractionScope {
  protocolRecord(value, ["runId", "activityId", "recipientId", "purpose", "compositionDigest"]);
  if (typeof value.compositionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.compositionDigest))
    throw new ModelProtocolBindingError("protocol_composition_digest_invalid");
  return Object.freeze({ runId: protocolToken(value.runId), activityId: protocolToken(value.activityId), recipientId: protocolToken(value.recipientId),
    purpose: snapshotProtocolRevisionRef(value.purpose), compositionDigest: value.compositionDigest });
}
export function snapshotNativeModelSource(value: unknown): NativeModelSourceRef {
  protocolRecord(value, ["scope", "protocol", "interpretation", "operationId", "record", "position", "nativeIdentity"]);
  protocolRecord(value.position, ["format", "value"]);
  if (typeof value.position.value !== "string") throw new ModelProtocolBindingError("native_source_position_invalid");
  let nativeIdentity: NativeModelSourceRef["nativeIdentity"] = null;
  if (value.nativeIdentity !== null) {
    protocolRecord(value.nativeIdentity, ["kind", "id"]);
    nativeIdentity = Object.freeze({ kind: protocolToken(value.nativeIdentity.kind), id: protocolToken(value.nativeIdentity.id) });
  }
  return Object.freeze({ scope: snapshotModelInteractionScope(value.scope), protocol: snapshotModelInteractionProtocol(value.protocol),
    interpretation: snapshotProtocolRevisionRef(value.interpretation), operationId: protocolToken(value.operationId), record: snapshotProtocolRevisionRef(value.record),
    position: Object.freeze({ format: protocolToken(value.position.format), value: value.position.value }), nativeIdentity });
}
export function nativeModelSourceKey(value: NativeModelSourceRef): string {
  return protocolDigest(snapshotNativeModelSource(value));
}
export function snapshotModelPurposeEvidence(value: unknown): ModelPurposeEvidence {
  protocolRecord(value, ["scope", "interpreter", "sources", "acceptance"]);
  const scope = snapshotModelInteractionScope(value.scope);
  const sources = protocolList(value.sources, snapshotNativeModelSource, true);
  if (sources.some(source => protocolDigest(source.scope) !== protocolDigest(scope)))
    throw new ModelProtocolBindingError("purpose_evidence_scope_mismatch");
  if (new Set(sources.map(nativeModelSourceKey)).size !== sources.length)
    throw new ModelProtocolBindingError("purpose_evidence_source_duplicate");
  if (sources.some(source => protocolDigest(source.protocol) !== protocolDigest(sources[0]!.protocol)))
    throw new ModelProtocolBindingError("purpose_evidence_protocol_mismatch");
  return Object.freeze({ scope, interpreter: snapshotProtocolRevisionRef(value.interpreter), sources, acceptance: snapshotProtocolRevisionRef(value.acceptance) });
}
