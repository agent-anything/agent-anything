import type {
  ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  composeModelInput,
  modelMessagesFromComposition,
} from "@agent-anything/model-interaction/input";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../http/ProviderHttpTransport.js";
import {
  createNativeProviderRequest,
  createSettledToolResultMessage,
  defaultMessages,
} from "../native-tool-conformance/NativeToolInteractionTestSupport.js";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider.js";

describe("OpenAICompatibleProvider", () => {
  afterEach(() => vi.useRealTimers());

  it("sends an OpenAI-compatible chat completions request", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://provider.local/v1/",
      apiKey: "secret-key",
      model: "model-a",
      timeoutMs: 1000,
      nativeToolInteraction: { supported: true },
      inputLimit: testInputLimit(),
    }, async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as unknown,
      });
      return okResponse({
        id: "response-1",
        choices: [{ message: { content: "{\"action\":\"complete\",\"summary\":\"done\"}" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
    });

    const result = await provider.send(request(provider), context());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://provider.local/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-key",
      },
      body: {
        model: "model-a",
        messages: [
          { role: "system", content: "Follow the test instructions." },
          { role: "user", content: "hello" },
        ],
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: TEST_OUTPUT_FORMAT.name,
            schema: TEST_OUTPUT_FORMAT.schema,
            strict: false,
          },
        },
      },
    });
    expect(result).toMatchObject({
      kind: "succeeded",
      response: {
        output: "{\"action\":\"complete\",\"summary\":\"done\"}",
        responseId: "response-1",
        continuation: null,
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    });
  });

  it("encodes native functions and replays exact tool_call_id correlation", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider(config(), async (_url, init) => {
      calls.push(JSON.parse(init.body) as Record<string, unknown>);
      return calls.length === 1
        ? okResponse({
            id: "response-1",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: "{\"file_path\":\"package.json\"}",
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          })
        : okResponse({
            id: "response-2",
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Done." },
              finish_reason: "stop",
            }],
          });
    });

    const firstRequest = createNativeProviderRequest(provider);
    const first = await provider.send(firstRequest, context());
    if (first.kind !== "succeeded" || first.response.kind !== "native_tool_turn") {
      throw new TypeError("Expected one native OpenAI-compatible turn.");
    }
    const callBlock = first.response.turn.assistant.content.find(
      (block) => block.kind === "model_tool_call",
    );
    if (callBlock?.kind !== "model_tool_call") throw new TypeError("Expected one Tool call.");
    expect(callBlock.call.providerCallRef).toEqual({
      providerId: "openai-compatible.chat-completions",
      id: "call-1",
    });

    await provider.send(createNativeProviderRequest(provider, {
      requestId: "native-request-2",
      messages: [
        ...defaultMessages(),
        first.response.turn.assistant,
        createSettledToolResultMessage(callBlock.call),
      ],
    }), context());

    expect(calls[0]).toMatchObject({
      model: "model-a",
      messages: [
        { role: "system", content: "Use the available callable when needed." },
        { role: "user", content: "Inspect package.json." },
      ],
      tools: [{
        type: "function",
        function: {
          name: "Read",
          description: "Read one workspace file.",
          parameters: expect.any(Object),
        },
      }, {
        type: "function",
        function: {
          name: "Search",
          description: "Search workspace text.",
          parameters: expect.any(Object),
        },
      }],
      tool_choice: "auto",
      stream: false,
    });
    expect(calls[0]).not.toHaveProperty("response_format");
    expect(new TextEncoder().encode(JSON.stringify(calls[0])).byteLength)
      .toBe(firstRequest.composition.accounting.inputAmount);
    expect(calls[1]).toMatchObject({
      messages: [
        expect.any(Object),
        expect.any(Object),
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: {
              name: "Read",
              arguments: "{\"file_path\":\"package.json\"}",
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: "{\"text\":\"file contents\"}",
        },
      ],
    });
  });

  it("maps HTTP failure without leaking credentials", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://provider.local/v1",
      apiKey: "secret-key",
      model: "model-a",
      timeoutMs: 1000,
      nativeToolInteraction: { supported: true },
      inputLimit: testInputLimit(),
    }, async () => ({
      ok: false,
      status: 401,
      async json() {
        return { error: "secret-key" };
      },
    }));

    const result = await provider.send(request(provider), context());

    expect(result).toMatchObject({
      kind: "failed",
      failure: {
        code: "provider_authentication_failed",
        message: "Provider authentication failed with HTTP 401.",
        statusCode: 401,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("truthfully rejects continuation for Chat Completions before transport", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ choices: [] }));
    const provider = new OpenAICompatibleProvider(config(), fetchImpl);

    expect(provider.descriptor.capabilities.continuation).toEqual({ supported: false });
    await expect(provider.send({
      ...request(provider),
      continuation: continuationRef(),
    }, context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_continuation_unsupported" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("projects trusted HTTP retry metadata into ProviderFailure", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => ({
      ok: false,
      status: 429,
      headers: {
        get(name) {
          if (name === "retry-after") return "2";
          if (name === "x-request-id") return "request_429";
          return null;
        },
      },
      async json() {
        return {};
      },
    }));

    await expect(provider.send(request(provider), context())).resolves.toMatchObject({
      kind: "failed",
      failure: {
        statusCode: 429,
        retryAfterMs: 2_000,
        requestId: "request_429",
        metadata: {},
      },
    });
  });

  it("maps malformed provider responses", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => okResponse({ choices: [] }));

    await expect(provider.send(request(provider), context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_response_malformed" },
    });
  });

  it("rejects missing and duplicate Provider Tool call ids", async () => {
    for (const toolCalls of [[{
      type: "function",
      function: { name: "Read", arguments: "{\"file_path\":\"a.txt\"}" },
    }], [{
      id: "duplicate-call",
      type: "function",
      function: { name: "Read", arguments: "{\"file_path\":\"a.txt\"}" },
    }, {
      id: "duplicate-call",
      type: "function",
      function: { name: "Search", arguments: "{\"query\":\"x\"}" },
    }]]) {
      const provider = new OpenAICompatibleProvider(config(), async () => okResponse({
        id: "response-1",
        choices: [{
          message: { role: "assistant", content: null, tool_calls: toolCalls },
          finish_reason: "tool_calls",
        }],
      }));
      await expect(provider.send(createNativeProviderRequest(provider), context()))
        .resolves.toMatchObject({
          kind: "failed",
          failure: { code: "provider_response_malformed" },
        });
    }
  });

  it("normalizes an explicit refusal without treating it as completion", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => okResponse({
      id: "response-1",
      choices: [{
        message: { role: "assistant", content: null, refusal: "Request refused." },
        finish_reason: "stop",
      }],
    }));
    await expect(provider.send(createNativeProviderRequest(provider), context()))
      .resolves.toMatchObject({
        kind: "succeeded",
        response: {
          kind: "native_tool_turn",
          turn: {
            assistant: { role: "assistant", content: [] },
            finish: { kind: "refusal", reason: "Request refused." },
          },
        },
      });
  });

  it("returns exact cancellation when response decoding settles after cancellation", async () => {
    const interruption = cancellableContext();
    const provider = new OpenAICompatibleProvider(config(), async () => ({
      ok: true,
      status: 200,
      async json() {
        interruption.cancel();
        return {
          id: "late-response",
          choices: [{
            message: { role: "assistant", content: "late" },
            finish_reason: "stop",
          }],
        };
      },
    }));

    await expect(provider.send(createNativeProviderRequest(provider), interruption.context))
      .resolves.toEqual({
        kind: "cancelled",
        cancellation: { runId: "run_001", requestId: "cancel_001" },
      });
  });

  it("maps timeout failures", async () => {
    vi.useFakeTimers();
    const abortingFetch: FetchLike = async (_url, init) => {
      await rejectWhenAborted(init.signal);
      throw new Error("unreachable");
    };
    const provider = new OpenAICompatibleProvider(config(), abortingFetch);
    const result = provider.send(request(provider), context());

    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_timeout" },
    });
  });

  it("does not classify an unrelated AbortError as timeout or Run cancellation", async () => {
    const provider = new OpenAICompatibleProvider(config(), async () => {
      throw Object.assign(new Error("unrelated abort"), { name: "AbortError" });
    });

    await expect(provider.send(request(provider), context())).resolves.toMatchObject({
      kind: "failed",
      failure: {
        category: "transport",
        code: "provider_request_failed",
        metadata: { causeName: "AbortError" },
      },
    });
  });

  it("returns exact Run cancellation when it aborts the active request", async () => {
    const interruption = cancellableContext();
    const provider = new OpenAICompatibleProvider(config(), async (_url, init) => {
      await rejectWhenAborted(init.signal);
      throw new Error("unreachable");
    });
    const result = provider.send(request(provider), interruption.context);

    interruption.cancel();

    await expect(result).resolves.toEqual({
      kind: "cancelled",
      cancellation: { runId: "run_001", requestId: "cancel_001" },
    });
  });

  it("does not start transport work for an already-cancelled invocation", async () => {
    const interruption = cancellableContext();
    interruption.cancel();
    const fetchImpl = vi.fn(async () => okResponse({ choices: [] }));
    const provider = new OpenAICompatibleProvider(config(), fetchImpl);

    await expect(provider.send(request(provider), interruption.context)).resolves.toEqual({
      kind: "cancelled",
      cancellation: { runId: "run_001", requestId: "cancel_001" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function config() {
  return {
    baseUrl: "https://provider.local/v1",
    apiKey: "",
    model: "model-a",
    timeoutMs: 1000,
    nativeToolInteraction: { supported: true },
    inputLimit: testInputLimit(),
  };
}

function testInputLimit() {
  return { maximumBytes: 1_024 * 1_024, source: "host_configured" as const };
}

function context(): InvocationInterruptionContext {
  return {
    signal: new AbortController().signal,
    interruption: null,
  };
}

function cancellableContext() {
  const controller = new AbortController();
  let interruption: InvocationInterruptionContext["interruption"] = null;
  return {
    context: {
      signal: controller.signal,
      get interruption() {
        return interruption;
      },
    } satisfies InvocationInterruptionContext,
    cancel() {
      interruption = {
        kind: "run_cancellation",
        cancellation: { runId: "run_001", requestId: "cancel_001" },
      };
      controller.abort(interruption);
    },
  };
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
}

function request(provider: OpenAICompatibleProvider): ProviderRequest {
  const composition = composeModelInput({
    id: "openai-test-composition",
    providerId: provider.inputAccounting.providerId,
    model: provider.inputAccounting.model,
    accounting: provider.inputAccounting,
    interaction: { kind: "structured_generation", outputFormat: TEST_OUTPUT_FORMAT },
    outputReserve: { unit: "bytes", amount: 0 },
    contextBudget: { unit: "bytes", amount: 0 },
    contextProjectedAmount: 0,
    sections: [
      section("instructions", "system", "Follow the test instructions."),
      section("user", "user", "hello"),
    ],
    lineage: testLineage(),
    composedAt: "2026-08-17T00:00:00.000Z",
  });
  return {
    requestId: composition.id,
    purpose: "helarc.code-agent.plan",
    correlation: {
      controllerRequestId: "controller-request-1",
      branchId: "branch-1",
    },
    interaction: composition.interaction,
    messages: modelMessagesFromComposition(composition),
    composition,
    continuation: null,
    metadata: {},
  };
}

function section(id: string, role: "system" | "user", text: string) {
  return {
    id,
    source: { owner: "provider-test", kind: "message", id, revision: "1" },
    kind: id === "instructions" ? "agent_instruction" : "message",
    role,
    necessity: "mandatory" as const,
    content: { kind: "text" as const, text },
  };
}

function testLineage() {
  return {
    instructionBinding: { owner: "agent-runtime", kind: "agent_instruction_binding", id: "binding", revision: "1" },
    agent: { owner: "agent-core", kind: "agent_revision", id: "agent", revision: "1" },
    instructions: { owner: "agent-core", kind: "agent_instructions", id: "instructions", revision: "1" },
    instructionRelease: { owner: "provider-test", kind: "agent_instruction_release", id: "release", revision: "1" },
    instructionResolver: { owner: "provider-test", kind: "agent_instruction_resolver", id: "resolver", revision: "1" },
    instructionContent: { owner: "agent-core", kind: "agent_instruction_content_digest", id: "instructions", revision: "1" },
    instructionModel: { providerId: "openai-compatible.chat-completions", model: "model-a" },
    instructionBlocks: [{ owner: "provider-test", kind: "message", id: "instructions", revision: "1" }],
    activeContext: null,
    contextProjection: null,
    projectionManifest: null,
    toolSelection: null,
    toolExposureContent: null,
    toolExposureBasis: null,
    toolExposureProof: null,
    controllerControlSet: null,
    interactionHistory: null,
    protocol: { owner: "provider-test", kind: "protocol", id: "test", revision: "1" },
    policy: { owner: "provider-test", kind: "policy", id: "test", revision: "1" },
  };
}

const TEST_OUTPUT_FORMAT = {
  kind: "json_schema" as const,
  name: "test_decision",
  schemaId: "test.decision",
  schemaRevision: "1",
  schema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["completion"] } },
    required: ["kind"],
    additionalProperties: false,
  },
};

function continuationRef(): ProviderRequest["continuation"] & object {
  return {
    id: "continuation-1",
    providerId: "helarc-openai-compatible",
    model: "model-a",
    mechanism: "response_chaining",
    predecessor: null,
    branchId: "branch-1",
    requestId: "request-1",
    responseId: "response-1",
    activeContext: { id: "context-1", runId: "run-1", version: 1 },
    protocol: { id: "protocol-1", revision: "1" },
    toolExposureContent: { id: "tools-1", revision: "1" },
    policy: { id: "policy-1", revision: "1" },
    state: {
      kind: "opaque_provider_state",
      handle: "opaque-state",
      sensitivity: "restricted",
    },
    createdAt: "2026-08-17T00:00:00.000Z",
  };
}

function okResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    },
  };
}
