import type { InvocationCancellationRef, InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { ProviderDescriptor } from "./ProviderCapabilities.js";
import type { ProviderRequest } from "./ProviderRequest.js";
import type { ProviderFailure, ProviderResponse } from "./ProviderResponse.js";
import type { ProviderModelContext } from "./context/index.js";
import type { ProviderTransportLimit } from "./transport/index.js";

export type ProviderCallResult =
  | {
      readonly kind: "succeeded";
      readonly response: ProviderResponse;
    }
  | {
      readonly kind: "failed";
      readonly failure: ProviderFailure;
    }
  | {
      readonly kind: "cancelled";
      readonly cancellation: InvocationCancellationRef;
    }
  | {
      readonly kind: "cancellation_unconfirmed";
      readonly failure: ProviderFailure;
    }
  | {
      readonly kind: "continuation_rejected";
      readonly continuationId: string;
      readonly providerCode: string | null;
    };

export interface Provider {
  readonly descriptor: ProviderDescriptor;
  readonly modelContext: ProviderModelContext;
  readonly requestBodyTransportLimit: ProviderTransportLimit;
  send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult>;
}
