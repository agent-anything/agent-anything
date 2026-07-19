import type {
  Provider,
  ProviderCallResult,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderRequest,
} from "@agent-anything/providers";
import type { InvocationInterruptionContext } from "@agent-anything/shared";

export interface FakeProviderInput {
  descriptor?: Partial<Omit<ProviderDescriptor, "capabilities">> & {
    capabilities?: Partial<ProviderCapabilities>;
  };
  results?: ProviderCallResult[];
}

export class FakeProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  private readonly results: ProviderCallResult[];
  private readonly recordedRequests: ProviderRequest[] = [];

  constructor(input: FakeProviderInput = {}) {
    this.descriptor = {
      id: input.descriptor?.id ?? "fake-provider",
      name: input.descriptor?.name ?? "Fake Provider",
      metadata: input.descriptor?.metadata ?? {},
      capabilities: {
        supportsToolPlanning: true,
        supportsStructuredOutput: true,
        supportsStreaming: false,
        ...input.descriptor?.capabilities,
      },
      requestRetryScheduler: input.descriptor?.requestRetryScheduler ?? {
        kind: "platform",
      },
    };
    this.results = [...(input.results ?? [])];
  }

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.recordedRequests.push(cloneRequest(request));

    const result = this.results.shift();
    if (!result) {
      return {
        kind: "failed",
        failure: {
          category: "fake",
          code: "fake_provider_exhausted",
          message: "FakeProvider has no queued response.",
          metadata: {
            providerId: this.descriptor.id,
          },
        },
      };
    }

    return cloneResult(result);
  }

  requests(): ProviderRequest[] {
    return this.recordedRequests.map(cloneRequest);
  }
}

function cloneRequest(request: ProviderRequest): ProviderRequest {
  return cloneStructured(request);
}

function cloneResult(result: ProviderCallResult): ProviderCallResult {
  return cloneStructured(result);
}

function cloneStructured<TValue>(value: TValue): TValue {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as TValue;
}
