import type { AgentDefinitionRevisionRef } from "@agent-anything/agent-core/agent";
import {
  ModelProtocolBindingError, protocolDigest, protocolList, protocolRecord, protocolToken,
  sameProtocolRef, sameRevisionRef, snapshotModelInteractionProtocol, snapshotProtocolRevisionRef,
  type ModelInteractionProtocolRef, type ProtocolRevisionRef,
} from "./ProtocolIdentity.js";

export interface ModelProtocolParticipantRef {
  readonly implementation: ProtocolRevisionRef;
  readonly protocol: ModelInteractionProtocolRef;
}

/** Configuration is a retained, non-secret basis, not a pointer to current Settings. */
export interface ModelProtocolConfigurationBinding {
  readonly configuration: ProtocolRevisionRef;
  readonly protocol: ModelInteractionProtocolRef;
  readonly model: string;
  readonly connectionBinding: ProtocolRevisionRef;
}

export interface ModelPurposeParticipants {
  readonly purpose: ProtocolRevisionRef;
  readonly interpreter: ModelProtocolParticipantRef;
  readonly input: ModelProtocolParticipantRef;
}

export interface ModelAgentComposition {
  readonly agent: AgentDefinitionRevisionRef;
  readonly protocol: ModelInteractionProtocolRef;
  readonly configuration: ModelProtocolConfigurationBinding;
  readonly adapter: ModelProtocolParticipantRef;
  readonly task: ModelPurposeParticipants;
  readonly auxiliary: readonly ModelPurposeParticipants[];
}
export interface ModelAgentCompositionBinding {
  readonly composition: ModelAgentComposition;
  readonly digest: string;
}

export function snapshotModelProtocolParticipant(value: unknown): ModelProtocolParticipantRef {
  protocolRecord(value, ["implementation", "protocol"]);
  return Object.freeze({ implementation: snapshotProtocolRevisionRef(value.implementation), protocol: snapshotModelInteractionProtocol(value.protocol) });
}
export function snapshotModelProtocolConfiguration(value: unknown): ModelProtocolConfigurationBinding {
  protocolRecord(value, ["configuration", "protocol", "model", "connectionBinding"]);
  return Object.freeze({ configuration: snapshotProtocolRevisionRef(value.configuration), protocol: snapshotModelInteractionProtocol(value.protocol),
    model: protocolToken(value.model), connectionBinding: snapshotProtocolRevisionRef(value.connectionBinding) });
}
function snapshotPurpose(value: unknown): ModelPurposeParticipants {
  protocolRecord(value, ["purpose", "interpreter", "input"]);
  return Object.freeze({ purpose: snapshotProtocolRevisionRef(value.purpose), interpreter: snapshotModelProtocolParticipant(value.interpreter), input: snapshotModelProtocolParticipant(value.input) });
}

export function bindModelAgentComposition(value: unknown): ModelAgentCompositionBinding {
  protocolRecord(value, ["agent", "protocol", "configuration", "adapter", "task", "auxiliary"]);
  const composition: ModelAgentComposition = Object.freeze({ agent: snapshotProtocolRevisionRef(value.agent), protocol: snapshotModelInteractionProtocol(value.protocol),
    configuration: snapshotModelProtocolConfiguration(value.configuration), adapter: snapshotModelProtocolParticipant(value.adapter),
    task: snapshotPurpose(value.task), auxiliary: protocolList(value.auxiliary, snapshotPurpose) });
  const purposes = [composition.task, ...composition.auxiliary];
  if (new Set(purposes.map(p => p.purpose.id)).size !== purposes.length) throw new ModelProtocolBindingError("protocol_purpose_duplicate");
  const protocols = [composition.configuration.protocol, composition.adapter.protocol, ...purposes.flatMap(p => [p.input.protocol, p.interpreter.protocol])];
  if (protocols.some(p => !sameProtocolRef(composition.protocol, p))) throw new ModelProtocolBindingError("protocol_composition_mismatch");
  return Object.freeze({ composition, digest: protocolDigest(composition) });
}

export function snapshotModelAgentCompositionBinding(value: unknown): ModelAgentCompositionBinding {
  protocolRecord(value, ["composition", "digest"]);
  const result = bindModelAgentComposition(value.composition);
  if (result.digest !== value.digest) throw new ModelProtocolBindingError("protocol_composition_integrity_failed");
  return result;
}

/** Validate before creating a Child; inheritance never copies mutable interaction state. */
export function assertChildModelComposition(parent: ModelAgentCompositionBinding, child: ModelAgentCompositionBinding): void {
  const p = snapshotModelAgentCompositionBinding(parent).composition;
  const c = snapshotModelAgentCompositionBinding(child).composition;
  if (!sameProtocolRef(p.protocol, c.protocol) || protocolDigest(p.configuration) !== protocolDigest(c.configuration))
    throw new ModelProtocolBindingError("child_protocol_binding_incompatible");
}

export function requireModelPurpose(binding: ModelAgentCompositionBinding, purpose: ProtocolRevisionRef): ModelPurposeParticipants {
  const { composition } = snapshotModelAgentCompositionBinding(binding);
  const ref = snapshotProtocolRevisionRef(purpose);
  const selected = [composition.task, ...composition.auxiliary].find(p => sameRevisionRef(p.purpose, ref));
  if (!selected) throw new ModelProtocolBindingError("protocol_purpose_unavailable");
  return selected;
}
