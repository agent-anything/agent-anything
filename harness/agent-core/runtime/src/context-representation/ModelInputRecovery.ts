import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type {
  ModelContextAssessment,
  ModelContextCapacity,
  ProviderFailure,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import type { ModelInputComposition } from "@agent-anything/model-interaction/input";
import type { RunContextFailure } from "../run/index.js";

export type ModelInputRecoveryCapability =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly ref: { readonly id: string; readonly revision: string };
      readonly maximumAttempts: number;
    };

export interface ModelInputRecoveryInput {
  readonly sourceRequest: ProviderRequest;
  readonly sourceComposition: ModelInputComposition;
  readonly targetCapacity: ModelContextCapacity;
  readonly assessment: ModelContextAssessment;
  readonly requestDigest: string;
  readonly attempt: { readonly id: string; readonly number: number };
  readonly trigger:
    | { readonly kind: "local_assessment" }
    | { readonly kind: "provider_rejection"; readonly failure: ProviderFailure };
}

export type ModelInputRecoveryResult =
  | {
      readonly status: "recomposed";
      readonly composition: ModelInputComposition;
      readonly predecessorCompositionId: string;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly failure: RunContextFailure };

export interface ModelInputRecoveryPort {
  readonly capability: ModelInputRecoveryCapability;
  recover(
    input: ModelInputRecoveryInput,
    interruption: InvocationInterruptionContext,
  ): Promise<ModelInputRecoveryResult>;
}

export const unsupportedModelInputRecovery: ModelInputRecoveryPort = Object.freeze({
  capability: Object.freeze({ supported: false as const }),
  async recover() {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "Model input recovery is not available in this composition.",
    });
  },
});
