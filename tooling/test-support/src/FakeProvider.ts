import type {
  Provider,
  ProviderCallResult,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createUtf8ModelInputAccounting,
  type ProviderModelInputAccounting,
} from "@agent-anything/model-interaction/input";

export interface FakeProviderInput {
  descriptor?: Partial<Omit<ProviderDescriptor, "capabilities">> & {
    capabilities?: Partial<ProviderCapabilities>;
  };
  results?: ProviderCallResult[];
}

export class FakeProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  readonly inputAccounting: ProviderModelInputAccounting;
  private readonly results: ProviderCallResult[];
  private readonly recordedRequests: ProviderRequest[] = [];

  constructor(input: FakeProviderInput = {}) {
    const providerId = input.descriptor?.id ?? "fake-provider";
    this.inputAccounting = createUtf8ModelInputAccounting({
      providerId,
      model: "fake-model",
      maximumInputBytes: 4 * 1_024 * 1_024,
      limitSource: "host_configured",
      estimator: { id: "fake-provider.utf8-content", revision: "1" },
      framing: { id: "fake-provider.framing", revision: "1" },
      renderRequest: (instructions, messages, interaction) => JSON.stringify({
        instructions,
        messages,
        interaction,
      }),
    });
    this.descriptor = {
      id: providerId,
      name: input.descriptor?.name ?? "Fake Provider",
      metadata: input.descriptor?.metadata ?? {},
      capabilities: {
        nativeToolInteraction: { supported: false },
        structuredGeneration: { supported: true },
        streaming: { supported: false },
        modelInput: this.inputAccounting.capability,
        continuation: { supported: false },
        compaction: { supported: false },
        ...input.descriptor?.capabilities,
      },
      requestRetryScheduler: input.descriptor?.requestRetryScheduler ?? {
        kind: "harness",
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
