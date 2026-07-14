import type {
  InvocationCancellationRef,
  InvocationInterruptionContext,
} from "@agent-anything/shared";
import type { ProviderDescriptor } from "./ProviderCapabilities.js";
import type { ProviderRequest } from "./ProviderRequest.js";
import type { ProviderFailure, ProviderResponse } from "./ProviderResponse.js";

export type ProviderCallResult<TOutput = unknown> =
  | {
      readonly kind: "succeeded";
      readonly response: ProviderResponse<TOutput>;
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
    };

export interface Provider {
  readonly descriptor: ProviderDescriptor;
  send(
    request: ProviderRequest,
    context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult>;
}
