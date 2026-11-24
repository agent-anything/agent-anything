import { ModelProtocolBindingError, protocolToken } from "./ProtocolIdentity.js";
import { assertChildModelComposition, snapshotModelAgentCompositionBinding, type ModelAgentCompositionBinding } from "./ModelAgentComposition.js";

export interface ModelCompositionScope {
  readonly runId: string;
  readonly recipientId: string;
}
export type ModelCompositionFactory<TParticipants> = (scope: ModelCompositionScope) => TParticipants;

/** A registry of explicitly composed implementations, not a native-path router. */
export class ModelCompositionRegistry<TParticipants> {
  private readonly factories = new Map<string, ModelCompositionFactory<TParticipants>>();

  register(binding: ModelAgentCompositionBinding, factory: ModelCompositionFactory<TParticipants>): void {
    const original = snapshotModelAgentCompositionBinding(binding);
    if (typeof factory !== "function") throw new ModelProtocolBindingError("protocol_composition_factory_missing");
    if (this.factories.has(original.digest)) throw new ModelProtocolBindingError("protocol_composition_already_registered");
    this.factories.set(original.digest, factory);
  }

  require(binding: ModelAgentCompositionBinding): ModelCompositionFactory<TParticipants> {
    const original = snapshotModelAgentCompositionBinding(binding);
    const factory = this.factories.get(original.digest);
    if (!factory) throw new ModelProtocolBindingError("original_protocol_composition_unavailable");
    return factory;
  }

  create(binding: ModelAgentCompositionBinding, scope: ModelCompositionScope): TParticipants {
    const factory = this.require(binding);
    return factory(Object.freeze({ runId: protocolToken(scope.runId), recipientId: protocolToken(scope.recipientId) }));
  }

  createChild(parent: ModelAgentCompositionBinding, parentScope: ModelCompositionScope,
    child: ModelAgentCompositionBinding, childScope: ModelCompositionScope): TParticipants {
    this.requireChild(parent, child);
    protocolToken(parentScope.recipientId);
    if (protocolToken(parentScope.runId) === protocolToken(childScope.runId))
      throw new ModelProtocolBindingError("child_interaction_scope_not_independent");
    return this.create(child, childScope);
  }

  requireChild(parent: ModelAgentCompositionBinding, child: ModelAgentCompositionBinding): ModelCompositionFactory<TParticipants> {
    // Both original bindings must resolve before the caller creates any Child work.
    this.require(parent);
    assertChildModelComposition(parent, child);
    return this.require(child);
  }
}
