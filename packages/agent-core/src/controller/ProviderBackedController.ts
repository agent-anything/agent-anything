import type {
  Provider,
  ProviderCallResult,
  ProviderFailure,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/providers";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  Metadata,
} from "@agent-anything/shared";
import type { ActionCandidate, ActionKind } from "../runner/Action.js";
import type { RuntimeError } from "../runner/RuntimeError.js";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
} from "./Controller.js";

export type BuildProviderRequest<TOutput = unknown> = (
  input: ControllerInput<TOutput>,
) => ProviderRequest | Promise<ProviderRequest>;

export type ParseProviderResponse<TOutput = unknown> = (
  response: ProviderResponse,
  input: ControllerInput<TOutput>,
) => ControllerDecision<TOutput> | Promise<ControllerDecision<TOutput>>;

export type ControllerFailureCode =
  | "model_request_failed"
  | "model_output_invalid"
  | "provider_request_failed"
  | "provider_timeout"
  | "provider_cancellation_unconfirmed";

export interface ControllerFailure extends RuntimeError {
  readonly owner: "model" | "provider";
  readonly code: ControllerFailureCode;
}

export class ControllerError extends Error {
  constructor(
    readonly runtimeError: ControllerFailure,
    readonly boundarySettlement: "unsettled" | "settled_failure" = "unsettled",
  ) {
    super(runtimeError.message);
    this.name = "ControllerError";
  }
}

export interface ProviderBackedControllerInput<TOutput = unknown> {
  readonly provider: Provider;
  readonly buildRequest: BuildProviderRequest<TOutput>;
  readonly parseResponse: ParseProviderResponse<TOutput>;
  readonly maxProviderOutputLength: number;
}

export class ProviderBackedController<TOutput = unknown>
  implements Controller<TOutput>
{
  constructor(private readonly input: ProviderBackedControllerInput<TOutput>) {
    if (
      !Number.isInteger(input.maxProviderOutputLength) ||
      input.maxProviderOutputLength <= 0
    ) {
      throw new TypeError("maxProviderOutputLength must be a positive integer.");
    }
  }

  async next(
    controllerInput: ControllerInput<TOutput>,
    callContext: ControllerCallContext,
  ): Promise<ControllerDecision<TOutput>> {
    throwIfCancelled(callContext);
    const request = await this.buildRequest(controllerInput);

    throwIfCancelled(callContext);
    const response = await this.sendRequest(request, callContext);

    throwIfCancelled(callContext);
    this.assertOutputLength(response);
    const decision = await this.parseResponse(response, controllerInput);

    throwIfCancelled(callContext);
    return validateDecision(decision, controllerInput);
  }

  private async buildRequest(
    input: ControllerInput<TOutput>,
  ): Promise<ProviderRequest> {
    try {
      return await this.input.buildRequest(input);
    } catch (error) {
      throw createControllerError(
        "model",
        "model_request_failed",
        messageFrom(error, "Model request construction failed."),
        false,
        errorMetadata(error),
      );
    }
  }

  private async sendRequest(
    request: ProviderRequest,
    callContext: ControllerCallContext,
  ): Promise<ProviderResponse> {
    let result: ProviderCallResult;
    try {
      result = await this.input.provider.send(
        request,
        createInvocationInterruptionContext(callContext),
      );
    } catch (error) {
      throw createControllerError(
        "provider",
        "provider_request_failed",
        "Provider request failed.",
        false,
        {
          providerId: this.input.provider.descriptor.id,
          ...errorMetadata(error),
        },
      );
    }

    switch (result.kind) {
      case "succeeded":
        return result.response;

      case "failed":
        throw providerFailureError(
          result.failure.code === "provider_timeout"
            ? "provider_timeout"
            : "provider_request_failed",
          result.failure,
          this.input.provider.descriptor.id,
        );

      case "cancelled":
        if (matchesActiveCancellation(result.cancellation, callContext)) {
          throw callContext.cancellation.signal.reason;
        }
        throw providerCancellationUnconfirmedError(
          "Provider returned cancellation without the active Run correlation.",
          this.input.provider.descriptor.id,
          {
            reportedRunId: result.cancellation.runId,
            reportedRequestId: result.cancellation.requestId,
          },
        );

      case "cancellation_unconfirmed":
        throw providerFailureError(
          "provider_cancellation_unconfirmed",
          result.failure,
          this.input.provider.descriptor.id,
        );
    }
  }

  private assertOutputLength(response: ProviderResponse): void {
    if (response.output === null || response.output === undefined) {
      throw invalidOutput("Provider returned no output.");
    }

    let serialized: string | undefined;
    try {
      serialized =
        typeof response.output === "string"
          ? response.output
          : JSON.stringify(response.output);
    } catch (error) {
      throw invalidOutput(
        "Provider output could not be measured.",
        errorMetadata(error),
      );
    }

    if (serialized === undefined) {
      throw invalidOutput("Provider output could not be measured.");
    }

    if (serialized.length > this.input.maxProviderOutputLength) {
      throw invalidOutput("Provider output exceeds the configured limit.", {
        maxProviderOutputLength: this.input.maxProviderOutputLength,
        actualProviderOutputLength: serialized.length,
      });
    }
  }

  private async parseResponse(
    response: ProviderResponse,
    input: ControllerInput<TOutput>,
  ): Promise<ControllerDecision<TOutput>> {
    try {
      return await this.input.parseResponse(response, input);
    } catch (error) {
      if (error instanceof ControllerError) {
        throw error;
      }

      throw invalidOutput(
        messageFrom(error, "Provider output parsing failed."),
        errorMetadata(error),
      );
    }
  }
}

function validateDecision<TOutput>(
  candidate: ControllerDecision<TOutput>,
  input: ControllerInput<TOutput>,
): ControllerDecision<TOutput> {
  if (!isRecord(candidate)) {
    throw invalidOutput("Controller decision must be an object.");
  }

  const modelItems = validateModelItems(candidate.modelItems);
  const modelItemIds = new Set(modelItems.map((item) => item.id));

  switch (candidate.kind) {
    case "final_output": {
      let validation;
      try {
        validation = input.agent.output.validate(candidate.output);
      } catch (error) {
        throw invalidOutput(
          "Agent output validation failed.",
          errorMetadata(error),
        );
      }

      if (!validation.valid) {
        throw invalidOutput(validation.message);
      }

      return Object.freeze({
        kind: "final_output",
        output: validation.output,
        modelItems,
      });
    }

    case "actions":
      return Object.freeze({
        kind: "actions",
        actions: validateActions(candidate.actions, modelItemIds),
        modelItems,
      });

    case "stop":
      return Object.freeze({
        kind: "stop",
        reason: nonEmptyText(candidate.reason, "Stop reason"),
        modelItems,
      });

    default:
      throw invalidOutput("Controller decision kind is not supported.");
  }
}

function validateModelItems(candidate: unknown): readonly ControllerModelItem[] {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw invalidOutput("Controller decision must include model items.");
  }

  const ids = new Set<string>();
  const items = candidate.map((item, index) => {
    if (!isRecord(item)) {
      throw invalidOutput(`Model item at index ${index} must be an object.`);
    }

    const id = nonEmptyText(item.id, `Model item ${index} id`);
    if (ids.has(id)) {
      throw invalidOutput(`Model item id ${id} is duplicated.`);
    }
    ids.add(id);

    if (!isRecord(item.metadata)) {
      throw invalidOutput(`Model item ${id} metadata must be an object.`);
    }

    return Object.freeze({
      id,
      kind: nonEmptyText(item.kind, `Model item ${id} kind`),
      content: item.content,
      metadata: Object.freeze({ ...item.metadata }),
    });
  });

  return Object.freeze(items);
}

function validateActions(
  candidate: unknown,
  modelItemIds: ReadonlySet<string>,
): readonly [ActionCandidate, ...ActionCandidate[]] {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw invalidOutput("Actions decision must include at least one action.");
  }

  const actions = candidate.map((action, index) => {
    if (!isRecord(action)) {
      throw invalidOutput(`Action at index ${index} must be an object.`);
    }

    const kind = validateActionKind(action.kind, index);
    const modelItemId = nonEmptyText(action.modelItemId, `Action ${index} modelItemId`);
    if (!modelItemIds.has(modelItemId)) {
      throw invalidOutput(
        `Action ${index} references unknown model item ${modelItemId}.`,
      );
    }

    return Object.freeze({
      kind,
      name: nonEmptyText(action.name, `Action ${index} name`),
      input: action.input,
      modelItemId,
    });
  });

  return Object.freeze(actions) as unknown as readonly [
    ActionCandidate,
    ...ActionCandidate[],
  ];
}

function validateActionKind(candidate: unknown, index: number): ActionKind {
  if (
    candidate !== "internal" &&
    candidate !== "tool" &&
    candidate !== "permission_request"
  ) {
    throw invalidOutput(`Action ${index} kind is not supported.`);
  }

  return candidate;
}

function nonEmptyText(candidate: unknown, field: string): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw invalidOutput(`${field} must be a non-empty string.`);
  }

  return candidate.trim();
}

function throwIfCancelled(context: ControllerCallContext): void {
  if (context.cancellation.signal.aborted) {
    throw context.cancellation.signal.reason;
  }
}

function invalidOutput(
  message: string,
  metadata: Metadata = {},
): ControllerError {
  return createControllerError(
    "model",
    "model_output_invalid",
    message,
    false,
    metadata,
  );
}

function createControllerError(
  owner: ControllerFailure["owner"],
  code: ControllerFailureCode,
  message: string,
  retryable: boolean,
  metadata: Metadata,
  boundarySettlement: "unsettled" | "settled_failure" = "unsettled",
): ControllerError {
  return new ControllerError(
    Object.freeze({
      owner,
      code,
      message,
      retryable,
      metadata: Object.freeze({ ...metadata }),
    }),
    boundarySettlement,
  );
}

function createInvocationInterruptionContext(
  context: ControllerCallContext,
): InvocationInterruptionContext {
  return Object.freeze({
    signal: context.cancellation.signal,
    get interruption(): InvocationInterruptionRef | null {
      const request = context.cancellation.request;
      return request === null
        ? null
        : Object.freeze({
            kind: "run_cancellation" as const,
            cancellation: Object.freeze({
              runId: request.runId,
              requestId: request.id,
            }),
          });
    },
  });
}

function matchesActiveCancellation(
  candidate: { readonly runId: string; readonly requestId: string },
  context: ControllerCallContext,
): boolean {
  const request = context.cancellation.request;
  return context.cancellation.signal.aborted &&
    request !== null &&
    candidate.runId === request.runId &&
    candidate.requestId === request.id;
}

function providerFailureError(
  code: Extract<
    ControllerFailureCode,
    "provider_request_failed" | "provider_timeout" | "provider_cancellation_unconfirmed"
  >,
  failure: ProviderFailure,
  providerId: string,
): ControllerError {
  return createControllerError(
    "provider",
    code,
    failure.message,
    false,
    {
      providerId,
      providerFailureCategory: failure.category,
      providerErrorCode: failure.code,
      providerRequestId: failure.requestId ?? null,
      providerStatusCode: failure.statusCode ?? null,
      providerRetryAfterMs: failure.retryAfterMs ?? null,
      ...failure.metadata,
    },
    "settled_failure",
  );
}

function providerCancellationUnconfirmedError(
  message: string,
  providerId: string,
  metadata: Metadata,
): ControllerError {
  return createControllerError(
    "provider",
    "provider_cancellation_unconfirmed",
    message,
    false,
    { providerId, ...metadata },
    "settled_failure",
  );
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

function errorMetadata(error: unknown): Metadata {
  if (!(error instanceof Error)) {
    return {};
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return {
    causeName: error.name,
    causeCode: code,
  };
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}
