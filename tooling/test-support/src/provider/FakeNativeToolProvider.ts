import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createModelCallRef,
  createModelTurnId,
  snapshotModelJsonValue,
  snapshotModelToolCall,
  snapshotProviderResponse,
  type ModelJsonValue,
  type Provider,
  type ProviderCallResult,
  type ProviderDescriptor,
  type ProviderRequest,
  type ProviderUsage,
} from "@agent-anything/model-interaction";
import { createFakeProviderContext } from "./FakeProviderContext.js";

export type FakeNativeToolProviderStep =
  | {
      readonly kind: "model_output";
      readonly output: unknown;
      readonly usage?: ProviderUsage | null;
      readonly metadata?: Readonly<Record<string, ModelJsonValue>>;
    }
  | {
      readonly kind: "provider_result";
      readonly result: ProviderCallResult;
    };

export interface FakeNativeToolProviderInput {
  readonly descriptor?: Partial<Omit<ProviderDescriptor, "capabilities">>;
  readonly model?: string;
  readonly steps?: readonly FakeNativeToolProviderStep[];
}

export class FakeNativeToolProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  readonly modelContext: Provider["modelContext"];
  readonly requestBodyTransportLimit: Provider["requestBodyTransportLimit"];
  private readonly steps: FakeNativeToolProviderStep[];
  private readonly recordedRequests: ProviderRequest[] = [];

  constructor(input: FakeNativeToolProviderInput = {}) {
    const providerId = input.descriptor?.id ?? "fake-native-tool-provider";
    const model = input.model ?? "fake-model";
    const context = createFakeProviderContext(providerId, model);
    this.modelContext = context.modelContext;
    this.requestBodyTransportLimit = context.requestBodyTransportLimit;
    this.descriptor = Object.freeze({
      id: providerId,
      name: input.descriptor?.name ?? "Fake Native Tool Provider",
      metadata: Object.freeze({ ...(input.descriptor?.metadata ?? {}) }),
      capabilities: Object.freeze({
        nativeToolInteraction: Object.freeze({
          supported: true as const,
          callableDefinitions: true as const,
          modelCalls: true as const,
          resultMessages: true as const,
          multipleCalls: true,
          callCorrelation: "provider_supplied" as const,
        }),
        structuredGeneration: Object.freeze({ supported: true as const }),
        streaming: Object.freeze({ supported: false as const }),
        modelContext: Object.freeze({
          capacity: this.modelContext.capacity,
          requestedOutput: this.modelContext.requestedOutput,
          inputPreservation: this.modelContext.inputPreservation,
        }),
        continuation: Object.freeze({ supported: false as const }),
        compaction: Object.freeze({ supported: false as const }),
        usageMetering: Object.freeze({
          inputTokens: "unavailable" as const,
          outputTokens: "unavailable" as const,
          costUnits: "unavailable" as const,
        }),
      }),
      requestRetryScheduler: input.descriptor?.requestRetryScheduler ??
        Object.freeze({ kind: "harness" as const }),
    });
    this.steps = [...(input.steps ?? [])];
  }

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.recordedRequests.push(request);
    if (request.purpose === "helarc.task-fulfillment") {
      return createTaskFulfillmentResult(request, this.descriptor.id, this.recordedRequests.length);
    }
    const step = this.steps.shift();
    if (step === undefined) {
      return providerFailure("fake_native_provider_exhausted", "provider");
    }
    if (step.kind === "provider_result") return step.result;
    return createNativeResult(
      request,
      step.output,
      this.descriptor.id,
      this.recordedRequests.length,
      step.usage ?? null,
      step.metadata ?? {},
    );
  }

  requests(): readonly ProviderRequest[] {
    return Object.freeze([...this.recordedRequests]);
  }
}

function createTaskFulfillmentResult(
  request: ProviderRequest,
  providerId: string,
  sequence: number,
): ProviderCallResult {
  if (request.interaction.kind !== "structured_generation") {
    return providerFailure("fake_task_fulfillment_request_kind_invalid", "invalid_request");
  }
  return Object.freeze({
    kind: "succeeded" as const,
    response: snapshotProviderResponse({
      kind: "structured_generation",
      output: Object.freeze({
        status: "fulfilled",
        rationale: "The scripted product fixture accepts the settled completion trajectory.",
        missingOutcomes: Object.freeze([]),
        unsupportedClaims: Object.freeze([]),
      }),
      responseId: `${providerId}:task-fulfillment:${sequence}`,
      continuation: null,
      usage: null,
      metadata: Object.freeze({ fixture: true }),
    }),
  });
}

export function fakeNativeModelOutput(
  output: unknown,
  input: {
    readonly usage?: ProviderUsage | null;
    readonly metadata?: Readonly<Record<string, ModelJsonValue>>;
  } = {},
): FakeNativeToolProviderStep {
  return Object.freeze({
    kind: "model_output",
    output,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}

export function fakeNativeProviderResult(
  result: ProviderCallResult,
): FakeNativeToolProviderStep {
  return Object.freeze({ kind: "provider_result", result });
}

function createNativeResult(
  request: ProviderRequest,
  output: unknown,
  providerId: string,
  sequence: number,
  usage: ProviderUsage | null,
  metadata: Readonly<Record<string, ModelJsonValue>>,
): ProviderCallResult {
  if (request.interaction.kind !== "native_tool_turn") {
    return providerFailure("fake_native_request_kind_invalid", "invalid_request");
  }
  if (!isRecord(output) || typeof output.kind !== "string") {
    return providerFailure("provider_response_malformed", "response");
  }
  const responseId = `${providerId}:response:${sequence}`;
  const turnId = createModelTurnId({ providerId, requestId: request.requestId, responseId });
  const content = output.kind === "completion"
    ? [Object.freeze({
        kind: "text" as const,
        text: typeof output.summary === "string" ? output.summary : "",
      })]
    : [Object.freeze({
        kind: "model_tool_call" as const,
        call: snapshotModelToolCall({
          modelCallRef: createModelCallRef({
            providerRequestId: request.requestId,
            controllerRequestId: request.correlation.controllerRequestId,
            turnId,
            contentBlockOrdinal: 0,
            branchId: request.correlation.branchId,
          }),
          providerCallRef: { providerId, id: `${responseId}:call:0` },
          name: callableName(request, output),
          input: callableInput(output),
          ordinal: 0,
        }),
      })];
  return Object.freeze({
    kind: "succeeded" as const,
    response: snapshotProviderResponse({
      kind: "native_tool_turn",
      turn: {
        turnId,
        assistant: { role: "assistant", content },
        finish: { kind: "normal" },
        usage,
        responseRef: { providerId, requestId: request.requestId, responseId },
      },
      continuation: null,
      metadata: snapshotObject(metadata),
    }),
  });
}

function callableName(
  request: ProviderRequest,
  output: Readonly<Record<string, unknown>>,
): string {
  if (output.kind === "plan_update") return "update_plan";
  if (output.kind === "stop") return "stop";
  if (output.kind !== "tool_call" || typeof output.toolName !== "string") {
    return "unknown_scripted_callable";
  }
  const stem = output.toolName.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 42) || "tool";
  return request.interaction.kind === "native_tool_turn"
    ? request.interaction.callables.find(({ name }) => name.startsWith(`${stem}_`))?.name ??
      `unknown_${stem}`
    : `unknown_${stem}`;
}

function callableInput(output: Readonly<Record<string, unknown>>): {
  readonly [key: string]: ModelJsonValue;
} {
  if (output.kind === "plan_update") {
    return snapshotObject({
      ...(typeof output.explanation === "string" ? { explanation: output.explanation } : {}),
      plan: output.plan,
    });
  }
  if (output.kind === "stop") return Object.freeze({ reason: String(output.reason) });
  return snapshotObject(output.input);
}

function snapshotObject(value: unknown): { readonly [key: string]: ModelJsonValue } {
  const snapshot = snapshotModelJsonValue(value, "FakeNativeToolProvider.value");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("FakeNativeToolProvider requires a JSON object.");
  }
  return snapshot as { readonly [key: string]: ModelJsonValue };
}

function providerFailure(code: string, category: string): ProviderCallResult {
  return Object.freeze({
    kind: "failed" as const,
    failure: Object.freeze({
      category,
      code,
      message: "Fake native Provider could not produce a Model Turn.",
      metadata: Object.freeze({}),
    }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
