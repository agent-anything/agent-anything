import type {
  Provider,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/providers";

export interface FakeProviderInput {
  descriptor?: Partial<Omit<ProviderDescriptor, "capabilities">> & {
    capabilities?: Partial<ProviderCapabilities>;
  };
  responses?: ProviderResponse[];
}

export class FakeProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  private readonly responses: ProviderResponse[];
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
    };
    this.responses = [...(input.responses ?? [])];
  }

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    this.recordedRequests.push(cloneRequest(request));

    const response = this.responses.shift();
    if (!response) {
      return {
        status: "failed",
        output: null,
        usage: null,
        error: {
          code: "fake_provider_exhausted",
          message: "FakeProvider has no queued response.",
        },
        metadata: {
          providerId: this.descriptor.id,
        },
      };
    }

    return cloneResponse(response);
  }

  requests(): ProviderRequest[] {
    return this.recordedRequests.map(cloneRequest);
  }
}

function cloneRequest(request: ProviderRequest): ProviderRequest {
  return cloneStructured(request);
}

function cloneResponse(response: ProviderResponse): ProviderResponse {
  return cloneStructured(response);
}

function cloneStructured<TValue>(value: TValue): TValue {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as TValue;
}
