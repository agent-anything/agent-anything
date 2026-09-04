import {
  createUnknownModelInputMeasurement,
  type ProviderModelContext,
} from "@agent-anything/model-interaction";
import type { ProviderTransportLimit } from "@agent-anything/model-interaction/transport";
import type { ModelInputComposition } from "@agent-anything/model-interaction/input";

export function createFakeProviderContext(
  providerId: string,
  model = "fake-model",
): Readonly<{
  modelContext: ProviderModelContext;
  requestBodyTransportLimit: ProviderTransportLimit;
}> {
  const capacity = Object.freeze({ supported: false as const });
  const requestedOutput = Object.freeze({
    unit: "tokens" as const,
    maximum: 1_024,
    source: "host_configured" as const,
    revision: "fake-provider.requested-output.v1",
  });
  const inputPreservation = Object.freeze({
    providerId,
    model,
    adapterRevision: "fake-provider.adapter.v1",
    runtimeVersion: null,
    truncation: "unknown" as const,
    contextShift: "unknown" as const,
    evidence: Object.freeze([]),
    revision: "fake-provider.input-preservation.v1",
  });
  const modelContext: ProviderModelContext = Object.freeze({
    target: Object.freeze({ providerId, model, revision: "fake-provider.target.v1" }),
    capacity,
    requestedOutput,
    inputPreservation,
    measure(composition: ModelInputComposition, measuredAt: string) {
      return createUnknownModelInputMeasurement({
        compositionId: composition.id,
        measuredAt,
        reason: "unsupported",
      });
    },
  });
  return Object.freeze({
    modelContext,
    requestBodyTransportLimit: Object.freeze({
      maximumBytes: 4 * 1_024 * 1_024,
      source: "host_configured" as const,
      revision: "fake-provider.transport-limit.v1",
    }),
  });
}
