import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
  ProviderResponse,
} from "@agent-anything/providers";
import { FakeProvider } from "@agent-anything/testing";
import type { Agent } from "../agent/index.js";
import { projectContext, createInitialContext } from "../context/index.js";
import { createRunCancellationController } from "../runner/index.js";
import type { AgentTask } from "../task/index.js";
import type {
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "./Controller.js";
import {
  ControllerError,
  ProviderBackedController,
} from "./ProviderBackedController.js";
import {
  StructuredOutputError,
  type ProviderRequestBuildContext,
} from "./StructuredOutput.js";
import {
  createSystemRetryExecutor,
  systemRetryClock,
} from "../retry/index.js";

interface TestOutput {
  readonly summary: string;
}

describe("ProviderBackedController", () => {
  afterEach(() => vi.useRealTimers());

  it("builds a request and returns Agent-validated final output with model provenance", async () => {
    const provider = new FakeProvider({
      results: [succeededResult({ summary: "Done" })],
    });
    const controller = createController(provider, {
      buildRequest(input) {
        return request(`Run ${input.runId} for task ${input.task.id}.`);
      },
      parseResponse(response) {
        return finalDecision(response.output);
      },
    });

    const result = await controller.next(createControllerInput(), callContext());

    expect(result).toEqual({
      kind: "final_output",
      output: { summary: "Done" },
      modelItems: [modelItem("model_item_1", { summary: "Done" })],
    });
    expect(provider.requests()).toEqual([
      request("Run run_001 for task task_001."),
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.modelItems)).toBe(true);
  });

  it("preserves ordered actions and validates their model-item references", async () => {
    const provider = new FakeProvider({
      results: [succeededResult({ action: "tools" })],
    });
    const controller = createController(provider, {
      parseResponse() {
        return {
          kind: "actions",
          actions: [
            {
              kind: "tool",
              name: "workspace.readFile",
              input: { path: "README.md" },
              modelItemId: "model_item_1",
            },
            {
              kind: "internal",
              name: "plan.update",
              input: { step: "Inspect README" },
              modelItemId: "model_item_2",
            },
          ],
          modelItems: [
            modelItem("model_item_1", { tool: "workspace.readFile" }),
            modelItem("model_item_2", { action: "plan.update" }),
          ],
        };
      },
    });

    const result = await controller.next(createControllerInput(), callContext());

    expect(result.kind).toBe("actions");
    if (result.kind !== "actions") {
      throw new Error("Expected actions decision.");
    }
    expect(result.actions.map((action) => action.name)).toEqual([
      "workspace.readFile",
      "plan.update",
    ]);
    expect(result.actions.map((action) => action.modelItemId)).toEqual([
      "model_item_1",
      "model_item_2",
    ]);
  });

  it("normalizes stop decisions", async () => {
    const controller = createController(
      new FakeProvider({ results: [succeededResult({ action: "stop" })] }),
      {
        parseResponse() {
          return {
            kind: "stop",
            reason: "  No safe next action.  ",
            modelItems: [modelItem("model_item_1", { action: "stop" })],
          };
        },
      },
    );

    await expect(
      controller.next(createControllerInput(), callContext()),
    ).resolves.toMatchObject({
      kind: "stop",
      reason: "No safe next action.",
    });
  });

  it("maps failed provider responses to attributed ControllerError values", async () => {
    const controller = createController(
      new FakeProvider({
        results: [
          {
            kind: "failed",
            failure: {
              category: "transport",
              code: "upstream_unavailable",
              message: "Provider unavailable.",
              metadata: {},
            },
          },
        ],
      }),
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).runtimeError).toEqual({
      owner: "provider",
      code: "provider_request_failed",
      message: "Provider unavailable.",
      retryable: false,
      metadata: {
        providerId: "fake-provider",
        providerFailureCategory: "transport",
        providerErrorCode: "upstream_unavailable",
        providerRequestId: null,
        providerStatusCode: null,
        providerRetryAfterMs: null,
      },
    });
  });

  it("preserves Provider timeout as an owner-specific failure", async () => {
    const controller = createController(new FakeProvider({
      results: [{
        kind: "failed",
        failure: {
          category: "timeout",
          code: "provider_timeout",
          message: "Provider request timed out.",
          metadata: {},
        },
      }],
    }));

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "provider",
      code: "provider_timeout",
      metadata: {
        providerFailureCategory: "timeout",
        providerErrorCode: "provider_timeout",
      },
    });
  });

  it("retries a safe transport failure with one stable operation and fresh requests", async () => {
    const requests: ProviderRequest[] = [];
    const events: Array<Record<string, unknown>> = [];
    const buildRequest = vi.fn(() => request("original request"));
    const provider: Provider = {
      descriptor: providerDescriptor("retrying-provider"),
      async send(candidate) {
        requests.push(candidate);
        if (requests.length === 1) {
          candidate.messages[0].content = "mutated by first attempt";
          return failedResult("transport", "network_unavailable");
        }
        return succeededResult({ summary: "Recovered" });
      },
    };
    const controller = createController(provider, {
      buildRequest,
      parseResponse: (response) => finalDecision(response.output),
    });

    const result = await controller.next(
      createControllerInput(),
      callContext(undefined, {
        maxRetries: 1,
        retryableCategories: ["transport"],
        events,
      }),
    );

    expect(result).toMatchObject({ kind: "final_output", output: { summary: "Recovered" } });
    expect(buildRequest).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests[1].messages[0].content).toBe("original request");
    const providerEvents = events.filter((event) => event.owner === "provider_request");
    expect(providerEvents.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(new Set(providerEvents.map((event) => event.operationId))).toEqual(new Set([
      "run_001:controller:1:provider-request:1",
    ]));
    expect(providerEvents[0].attemptId).not.toBe(providerEvents[3].attemptId);
  });

  it.each([
    [429, "rate_limit"],
    [503, "server_error"],
    [408, "timeout"],
  ])("retries technically safe HTTP %s as %s", async (statusCode, category) => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        failedResult("http", "provider_http_error", { statusCode, retryAfterMs: 0 }),
        succeededResult({ summary: "Recovered" }),
      ],
    });
    const controller = createController(provider);

    await controller.next(createControllerInput(), callContext(undefined, {
      maxRetries: 1,
      retryableCategories: [category],
      serverDelay: { mode: "prefer_trusted", maxServerDelayMs: 1_000 },
      events,
    }));

    expect(provider.requests()).toHaveLength(2);
    expect(events.find((event) => event.type === "retry_scheduled")).toMatchObject({
      failureCategory: category,
      delaySource: "trusted_server_delay",
    });
  });

  it.each(["timeout", "rate_limit", "server_error"])(
    "retries an adapter-normalized %s failure without an HTTP status",
    async (category) => {
      const provider = new FakeProvider({
        results: [
          failedResult(category, `provider_${category}`),
          succeededResult({ summary: "Recovered" }),
        ],
      });

      await createController(provider).next(
        createControllerInput(),
        callContext(undefined, {
          maxRetries: 1,
          retryableCategories: [category],
        }),
      );

      expect(provider.requests()).toHaveLength(2);
    },
  );

  it("does not retry a non-retryable authentication failure", async () => {
    const provider = new FakeProvider({
      results: [failedResult("http", "provider_http_error", { statusCode: 401 })],
    });
    const controller = createController(provider);

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        maxRetries: 3,
        retryableCategories: ["transport", "timeout", "rate_limit", "server_error"],
      }),
    ));

    expect(provider.requests()).toHaveLength(1);
    expect((error as ControllerError).runtimeError).toMatchObject({
      code: "provider_request_failed",
      metadata: { providerFailureCategory: "authentication", providerStatusCode: 401 },
    });
  });

  it("maps exact budget consumption to provider_retry_exhausted", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        failedResult("transport", "network_unavailable"),
        failedResult("transport", "network_unavailable"),
        failedResult("transport", "network_unavailable"),
      ],
    });
    const controller = createController(provider);

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        maxRetries: 2,
        retryableCategories: ["transport"],
        events,
      }),
    ));

    expect(provider.requests()).toHaveLength(3);
    expect((error as ControllerError).runtimeError).toMatchObject({
      code: "provider_retry_exhausted",
      metadata: {
        retryExhaustionReason: "retry_budget_exhausted",
        retryTotalAttempts: 3,
        providerFailureCategory: "transport",
      },
    });
    expect(events.find((event) =>
      event.owner === "provider_request" && event.type === "retry_exhausted"
    )).toMatchObject({
      type: "retry_exhausted",
      reason: "retry_budget_exhausted",
      totalAttempts: 3,
    });
  });

  it("stops at the absolute operation deadline without Run cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const events: Array<Record<string, unknown>> = [];
    const provider: Provider = {
      descriptor: providerDescriptor("deadline-provider"),
      async send(_request, context) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        expect(context.interruption).toMatchObject({ kind: "operation_deadline" });
        return failedResult("deadline", "provider_operation_deadline");
      },
    };
    const controller = createController(provider);
    const run = captureError(controller.next(createControllerInput(), callContext(undefined, {
      maxRetries: 2,
      retryableCategories: ["transport", "timeout"],
      deadlineAt: "2026-07-14T00:00:00.025Z",
      events,
    })));

    await vi.advanceTimersByTimeAsync(25);
    const error = await run;

    expect((error as ControllerError).runtimeError).toMatchObject({
      code: "provider_retry_exhausted",
      metadata: { retryExhaustionReason: "deadline_exceeded", retryTotalAttempts: 1 },
    });
    expect(events.filter((event) => event.owner === "provider_request")
      .map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_exhausted",
    ]);
  });

  it("cancels during Provider backoff without starting another attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        failedResult("transport", "network_unavailable"),
        succeededResult({ summary: "must not run" }),
      ],
    });
    const controller = createController(provider);
    const run = controller.next(createControllerInput(), callContext(cancellation.context, {
      maxRetries: 1,
      retryableCategories: ["transport"],
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
      deadlineAt: "2026-07-14T00:00:10.000Z",
      events,
    }));
    await waitForRetryEvent(events, "retry_scheduled");
    const outcome = captureError(run);
    const receipt = cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });

    await expect(outcome).resolves.toBe(receipt.request);
    expect(provider.requests()).toHaveLength(1);
    expect(events.find((event) =>
      event.owner === "provider_request" && event.type === "retry_cancelled"
    )).toMatchObject({ type: "retry_cancelled", phase: "backoff" });
  });

  it("rejects SDK-owned request Retry without a conforming projection path", () => {
    const provider = new FakeProvider({
      descriptor: {
        requestRetryScheduler: {
          kind: "sdk",
          sdkName: "example-sdk",
          maxRetries: 2,
          exposesAttemptEvents: false,
          supportsCancellation: true,
        },
      },
    });

    expect(() => createController(provider)).toThrow(
      "requires platform-owned Provider request Retry",
    );
  });

  it("accepts only cancellation correlated to the active Run request", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const provider: Provider = {
      descriptor: providerDescriptor("cancelling-provider"),
      async send(_request, context) {
        const receipt = cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        expect(context.interruption).toEqual({
          kind: "run_cancellation",
          cancellation: {
            runId: "run_001",
            requestId: receipt.request.id,
          },
        });
        return {
          kind: "cancelled",
          cancellation: {
            runId: "run_001",
            requestId: receipt.request.id,
          },
        };
      },
    };
    const controller = createController(provider);

    const error = await captureError(controller.next(createControllerInput(), {
      ...callContext(cancellation.context),
    }));

    expect(error).toBe(cancellation.context.request);
  });

  it("fails closed for mismatched or unconfirmed Provider cancellation", async () => {
    const mismatched = createController(new FakeProvider({
      results: [{
        kind: "cancelled",
        cancellation: { runId: "another_run", requestId: "unknown_request" },
      }],
    }));
    const unconfirmed = createController(new FakeProvider({
      results: [{
        kind: "cancellation_unconfirmed",
        failure: {
          category: "cancellation",
          code: "provider_cancellation_unconfirmed",
          message: "Provider settlement could not be confirmed.",
          metadata: {},
        },
      }],
    }));

    const mismatchedError = await captureError(
      mismatched.next(createControllerInput(), callContext()),
    );
    const unconfirmedError = await captureError(
      unconfirmed.next(createControllerInput(), callContext()),
    );

    expect((mismatchedError as ControllerError).runtimeError.code)
      .toBe("provider_cancellation_unconfirmed");
    expect((unconfirmedError as ControllerError).runtimeError).toMatchObject({
      owner: "provider",
      code: "provider_cancellation_unconfirmed",
      message: "Provider settlement could not be confirmed.",
    });
  });

  it("does not expose thrown provider messages as runtime error messages", async () => {
    const controller = createController(throwingProvider());

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "provider",
      code: "provider_request_failed",
      message: "Provider request failed.",
      metadata: {
        providerId: "throwing-provider",
        causeName: "Error",
      },
    });
  });

  it("attributes request construction failures to the model request boundary", async () => {
    const controller = createController(new FakeProvider(), {
      buildRequest() {
        throw new TypeError("Prompt assembly failed.");
      },
    });

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "model",
      code: "model_request_failed",
      message: "Prompt assembly failed.",
    });
  });

  it("rejects oversized provider output before product parsing", async () => {
    const parseResponse = vi.fn(() => finalDecision({ summary: "unused" }));
    const controller = createController(
      new FakeProvider({ results: [succeededResult("123456")] }),
      { parseResponse, maxProviderOutputLength: 5 },
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(parseResponse).not.toHaveBeenCalled();
    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "model",
      code: "model_output_invalid",
      message: "Model output did not satisfy the active structured-output contract.",
      metadata: {
        structuredOutputFailureCategory: "structured_output_size",
        structuredOutputFailureCode: "structured_output_too_large",
      },
    });
  });

  it("rejects parser failures and Agent output contract failures", async () => {
    const parseFailure = createController(
      new FakeProvider({ results: [succeededResult({ malformed: true })] }),
      {
        parseResponse() {
          throw new SyntaxError("Expected action kind.");
        },
      },
    );
    const outputFailure = createController(
      new FakeProvider({ results: [succeededResult({ summary: 42 })] }),
      {
        parseResponse(response) {
          return finalDecision(response.output);
        },
      },
    );

    const parseError = await captureError(
      parseFailure.next(createControllerInput(), callContext()),
    );
    const outputError = await captureError(
      outputFailure.next(createControllerInput(), callContext()),
    );

    expect((parseError as ControllerError).runtimeError).toMatchObject({
      code: "model_output_invalid",
      message: "Provider output parsing failed.",
    });
    expect((outputError as ControllerError).runtimeError).toMatchObject({
      code: "model_output_invalid",
      message: "Model output did not satisfy the active structured-output contract.",
      metadata: {
        structuredOutputFailureCategory: "agent_output_contract",
        structuredOutputFailureCode: "agent_output_invalid",
      },
    });
  });

  it("corrects one eligible structured-output failure within one stable operation", async () => {
    const rawInvalidOutput = "raw invalid output with private content";
    const buildContexts: ProviderRequestBuildContext[] = [];
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [
        succeededResult(rawInvalidOutput),
        succeededResult({ summary: "Recovered" }),
      ],
    });
    const controller = createController(provider, {
      buildRequest(_input, context) {
        buildContexts.push(context);
        return request(context.correction === null
          ? "Initial request"
          : `Correction: ${context.correction.failure.correctionFeedback}`);
      },
      parseResponse(response) {
        if (response.output === rawInvalidOutput) {
          throw correctionError(
            "structured_output_syntax",
            "test_output_not_json",
            "Return one valid structured object.",
          );
        }
        return finalDecision(response.output);
      },
    });

    const decision = await controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
        events,
      }),
    );

    expect(decision).toMatchObject({
      kind: "final_output",
      output: { summary: "Recovered" },
    });
    expect(provider.requests()).toHaveLength(2);
    expect(buildContexts).toHaveLength(2);
    expect(buildContexts[0]).toEqual({ attemptNumber: 1, correction: null });
    expect(buildContexts[1]).toMatchObject({
      attemptNumber: 2,
      correction: {
        previousAttemptNumber: 1,
        failure: {
          category: "structured_output_syntax",
          code: "test_output_not_json",
          correctionFeedback: "Return one valid structured object.",
        },
      },
    });
    expect(JSON.stringify(buildContexts[1])).not.toContain(rawInvalidOutput);
    expect(provider.requests()[1].messages[0].content).not.toContain(rawInvalidOutput);

    const structuredEvents = events.filter((event) => event.owner === "structured_output");
    expect(structuredEvents.map((event) => event.type)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "retry_scheduled",
      "retry_attempt_started",
      "retry_attempt_finished",
    ]);
    expect(new Set(structuredEvents.map((event) => event.operationId))).toEqual(
      new Set(["run_001:controller:1:structured-output:1"]),
    );
    expect(new Set(events
      .filter((event) => event.owner === "provider_request")
      .map((event) => event.operationId))).toEqual(new Set([
        "run_001:controller:1:provider-request:1",
        "run_001:controller:1:provider-request:2",
      ]));
  });

  it("corrects an Agent output-contract failure before returning a decision", async () => {
    const provider = new FakeProvider({
      results: [
        succeededResult({ summary: 42 }),
        succeededResult({ summary: "Recovered" }),
      ],
    });
    const controller = createController(provider, {
      parseResponse(response) {
        return finalDecision(response.output);
      },
    });

    const decision = await controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["agent_output_contract"],
      }),
    );

    expect(provider.requests()).toHaveLength(2);
    expect(decision).toMatchObject({
      kind: "final_output",
      output: { summary: "Recovered" },
    });
  });

  it("does not retry an untyped parser exception as a model correction", async () => {
    const provider = new FakeProvider({
      results: [succeededResult("invalid-1"), succeededResult("invalid-2")],
    });
    const controller = createController(provider, {
      parseResponse() {
        throw new SyntaxError("Parser implementation failed.");
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: [
          "structured_output_syntax",
          "structured_output_schema",
        ],
      }),
    ));

    expect(provider.requests()).toHaveLength(1);
    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "model",
      code: "model_output_invalid",
      message: "Provider output parsing failed.",
    });
  });

  it("maps repeated eligible output failures to structured-output exhaustion", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new FakeProvider({
      results: [succeededResult("invalid-1"), succeededResult("invalid-2")],
    });
    const controller = createController(provider, {
      parseResponse() {
        throw correctionError(
          "structured_output_schema",
          "test_schema_invalid",
          "Return the required summary field.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_schema"],
        events,
      }),
    ));

    expect(provider.requests()).toHaveLength(2);
    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "model",
      code: "model_structured_output_retry_exhausted",
      metadata: {
        retryExhaustionReason: "retry_budget_exhausted",
        retryTotalAttempts: 2,
        structuredOutputFailureCategory: "structured_output_schema",
        structuredOutputFailureCode: "test_schema_invalid",
      },
    });
    expect(events.find((event) =>
      event.owner === "structured_output" && event.type === "retry_exhausted"
    )).toMatchObject({ reason: "retry_budget_exhausted", totalAttempts: 2 });
  });

  it("preserves a Provider-owned failure during a correction request", async () => {
    const provider = new FakeProvider({
      results: [
        succeededResult("invalid"),
        failedResult("http", "provider_http_error", { statusCode: 401 }),
      ],
    });
    const controller = createController(provider, {
      parseResponse() {
        throw correctionError(
          "structured_output_syntax",
          "test_output_not_json",
          "Return valid structured output.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
      }),
    ));

    expect(provider.requests()).toHaveLength(2);
    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "provider",
      code: "provider_request_failed",
      metadata: {
        providerFailureCategory: "authentication",
        providerStatusCode: 401,
      },
    });
  });

  it("starts no correction attempt when cancellation wins during parsing", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const provider = new FakeProvider({ results: [succeededResult("invalid")] });
    const controller = createController(provider, {
      parseResponse() {
        cancellation.requestCancellation({
          origin: "user",
          reasonCode: "user_requested",
        });
        throw correctionError(
          "structured_output_syntax",
          "test_output_not_json",
          "Return valid structured output.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(cancellation.context, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
      }),
    ));

    expect(error).toBe(cancellation.context.request);
    expect(provider.requests()).toHaveLength(1);
  });

  it("does not schedule a correction beyond the absolute Run deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const provider = new FakeProvider({ results: [succeededResult("invalid")] });
    const controller = createController(provider, {
      parseResponse() {
        throw correctionError(
          "structured_output_syntax",
          "test_output_not_json",
          "Return valid structured output.",
        );
      },
    });

    const error = await captureError(controller.next(
      createControllerInput(),
      callContext(undefined, {
        structuredMaxRetries: 1,
        structuredRetryableCategories: ["structured_output_syntax"],
        structuredBaseDelayMs: 1_000,
        structuredMaxDelayMs: 1_000,
        deadlineAt: "2026-07-14T00:00:00.025Z",
      }),
    ));

    expect(provider.requests()).toHaveLength(1);
    expect((error as ControllerError).runtimeError).toMatchObject({
      code: "model_structured_output_retry_exhausted",
      metadata: {
        retryExhaustionReason: "deadline_exceeded",
        retryTotalAttempts: 1,
      },
    });
  });

  it.each([
    ["empty model items", { ...finalDecision({ summary: "Done" }), modelItems: [] }],
    [
      "duplicate model item ids",
      {
        ...finalDecision({ summary: "Done" }),
        modelItems: [modelItem("duplicate", {}), modelItem("duplicate", {})],
      },
    ],
    [
      "unknown action provenance",
      {
        kind: "actions",
        actions: [
          {
            kind: "tool",
            name: "workspace.readFile",
            input: {},
            modelItemId: "missing",
          },
        ],
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
    [
      "empty actions",
      {
        kind: "actions",
        actions: [],
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
    [
      "empty stop reason",
      {
        kind: "stop",
        reason: " ",
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
    [
      "unsupported decision kind",
      {
        kind: "handoff",
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
  ])("rejects malformed decision: %s", async (_name, malformedDecision) => {
    const controller = createController(
      new FakeProvider({ results: [succeededResult({})] }),
      {
        parseResponse() {
          return malformedDecision as unknown as ControllerDecision<TestOutput>;
        },
      },
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).runtimeError.code).toBe("model_output_invalid");
  });

  it("does not start provider work after cancellation", async () => {
    const provider = new FakeProvider({ results: [succeededResult({})] });
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const receipt = cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    const controller = createController(provider);

    const error = await captureError(
      controller.next(createControllerInput(), {
        ...callContext(cancellation.context),
      }),
    );

    expect(error).toBe(receipt.request);
    expect(provider.requests()).toEqual([]);
  });

  it("discards a provider response when cancellation wins during the active call", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const parseResponse = vi.fn(() => finalDecision({ summary: "unused" }));
    const provider: Provider = {
      descriptor: providerDescriptor("cancelling-provider"),
      async send() {
        cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        return succeededResult({ summary: "Too late" });
      },
    };
    const controller = createController(provider, { parseResponse });

    const error = await captureError(
      controller.next(createControllerInput(), {
        ...callContext(cancellation.context),
      }),
    );

    expect(error).toBe(cancellation.context.request);
    expect(parseResponse).not.toHaveBeenCalled();
  });

  it("requires a positive integer provider output limit", () => {
    expect(
      () =>
        createController(new FakeProvider(), {
          maxProviderOutputLength: 0,
        }),
    ).toThrow("maxProviderOutputLength must be a positive integer.");
  });
});

function createController(
  provider: Provider,
  overrides: Partial<{
    buildRequest: (
      input: ControllerInput<TestOutput>,
      context: ProviderRequestBuildContext,
    ) => ProviderRequest;
    parseResponse: (
      response: ProviderResponse,
      input: ControllerInput<TestOutput>,
    ) => ControllerDecision<TestOutput>;
    maxProviderOutputLength: number;
  }> = {},
): ProviderBackedController<TestOutput> {
  return new ProviderBackedController({
    provider,
    buildRequest: overrides.buildRequest ?? (() => request("Choose the next action.")),
    parseResponse:
      overrides.parseResponse ?? (() => finalDecision({ summary: "Done" })),
    structuredOutputContractId: "test-controller-output-v1",
    maxProviderOutputLength: overrides.maxProviderOutputLength ?? 10_000,
    retryExecutor: createSystemRetryExecutor(),
    retryClock: systemRetryClock,
  });
}

function createControllerInput(): ControllerInput<TestOutput> {
  const task = createTask();
  return {
    runId: "run_001",
    iteration: 1,
    agent: createAgent(),
    task,
    conversationItems: [],
    context: projectContext(
      createInitialContext(task),
      null,
      testPermissionProjection(),
    ),
    workspace: {
      id: "workspace_001",
      name: "Test workspace",
      rootRef: "workspace://root",
      trustState: "trusted",
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    identity: {
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    metadata: {},
  };
}

function testPermissionProjection() {
  return {
    profile: {
      profileId: ":read-only",
      sourceProfileIds: [":read-only"],
      environmentId: "test",
      enforcement: "managed" as const,
      workspaceRootCount: 1,
      fileSystem: {
        unrestricted: false,
        allowsRead: true,
        allowsWrite: false,
        hasDenials: false,
        managed: false,
      },
      network: {
        enabled: false,
        profileRestricted: false,
        managedRestricted: false,
        hasDenials: false,
      },
      managedConstraintSetId: "test",
      canRequestAdditionalPermissions: false,
    },
    authority: {
      hasAdditionalFileSystemRead: false,
      hasAdditionalFileSystemWrite: false,
      hasAdditionalNetwork: false,
      actionCoverageCount: 0,
      runGrantCount: 0,
      sessionAuthorityCount: 0,
      policyAmendmentCount: 0,
    },
    approval: {
      canRequest: false,
      reviewer: null,
      pending: false,
      requestsRemaining: 0,
    },
  };
}

function createAgent(): Agent<TestOutput> {
  return {
    id: "agent_001",
    name: "Test Agent",
    instructions: "Complete the test task.",
    tools: [],
    output: {
      validate(candidate) {
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "summary" in candidate &&
          typeof candidate.summary === "string"
        ) {
          return { valid: true, output: { summary: candidate.summary } };
        }

        return {
          valid: false,
          message: "Final output must contain a summary string.",
        };
      },
    },
    metadata: {},
  };
}

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "test.agent.run",
    input: {},
    createdAt: "2026-07-13T00:00:00.000Z",
    metadata: {},
  };
}

function request(content: string): ProviderRequest {
  return {
    messages: [{ role: "user", content, metadata: {} }],
    capability: "agent-control",
    metadata: {},
  };
}

function succeededResult(output: unknown): ProviderCallResult {
  return {
    kind: "succeeded",
    response: {
      output,
      usage: null,
      metadata: {},
    },
  };
}

function failedResult(
  category: string,
  code: string,
  metadata: Record<string, unknown> = {},
): ProviderCallResult {
  const { retryAfterMs, requestId, statusCode, ...safeMetadata } = metadata;
  return {
    kind: "failed",
    failure: {
      category,
      code,
      message: "Provider request failed.",
      ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
      ...(typeof requestId === "string" ? { requestId } : {}),
      ...(typeof statusCode === "number" ? { statusCode } : {}),
      metadata: safeMetadata,
    },
  };
}

function correctionError(
  category: ConstructorParameters<typeof StructuredOutputError>[0]["category"],
  code: string,
  correctionFeedback: string,
): StructuredOutputError {
  return new StructuredOutputError({ category, code, correctionFeedback });
}

function finalDecision(output: unknown): ControllerDecision<TestOutput> {
  return {
    kind: "final_output",
    output: output as TestOutput,
    modelItems: [modelItem("model_item_1", output)],
  };
}

function modelItem(id: string, content: unknown) {
  return {
    id,
    kind: "assistant_message",
    content,
    metadata: {},
  };
}

function callContext(
  cancellation = createRunCancellationController({ runId: "run_001" }).context,
  overrides: Partial<{
    maxRetries: number;
    retryableCategories: string[];
    baseDelayMs: number;
    maxDelayMs: number;
    serverDelay:
      | { mode: "ignore" }
      | { mode: "prefer_trusted"; maxServerDelayMs: number };
    deadlineAt: string;
    events: Array<Record<string, unknown>>;
    structuredMaxRetries: number;
    structuredRetryableCategories: string[];
    structuredBaseDelayMs: number;
    structuredMaxDelayMs: number;
  }> = {},
): ControllerCallContext {
  const providerPolicy = {
    maxRetries: overrides.maxRetries ?? 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: overrides.baseDelayMs ?? 0,
      maxDelayMs: overrides.maxDelayMs ?? 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: overrides.retryableCategories ?? [],
    serverDelay: overrides.serverDelay ?? { mode: "ignore" as const },
  };
  const structuredOutputPolicy = {
    maxRetries: overrides.structuredMaxRetries ?? 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: overrides.structuredBaseDelayMs ?? 0,
      maxDelayMs: overrides.structuredMaxDelayMs ?? 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: overrides.structuredRetryableCategories ?? [],
    serverDelay: { mode: "ignore" as const },
  };
  return {
    cancellation,
    retry: {
      providerRequest: providerPolicy,
      structuredOutput: structuredOutputPolicy,
      deadlineAt: overrides.deadlineAt ?? "2099-01-01T00:00:00.000Z",
      events: {
        emit(event) {
          overrides.events?.push(event as unknown as Record<string, unknown>);
        },
      },
    },
  };
}

async function waitForRetryEvent(
  events: readonly Record<string, unknown>[],
  type: string,
): Promise<void> {
  for (let check = 0; check < 20; check += 1) {
    if (events.some((event) => event.type === type)) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error(`Timed out waiting for ${type}.`);
}

function throwingProvider(): Provider {
  return {
    descriptor: providerDescriptor("throwing-provider"),
    async send() {
      throw new Error("secret upstream details");
    },
  };
}

function providerDescriptor(id: string) {
  return {
    id,
    name: id,
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    requestRetryScheduler: { kind: "platform" as const },
    metadata: {},
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject.");
}
