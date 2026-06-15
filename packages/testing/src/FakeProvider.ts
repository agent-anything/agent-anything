import type {
  Provider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/providers";

export interface FakeProviderInput {
  capabilities?: Partial<ProviderCapabilities>;
  responses?: ProviderResponse[];
}

export class FakeProvider implements Provider {
  readonly capabilities: ProviderCapabilities;
  private readonly responses: ProviderResponse[];
  private readonly recordedRequests: ProviderRequest[] = [];

  constructor(input: FakeProviderInput = {}) {
    this.capabilities = {
      id: "fake-provider",
      name: "Fake Provider",
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
      metadata: {},
      ...input.capabilities,
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
          providerId: this.capabilities.id,
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
