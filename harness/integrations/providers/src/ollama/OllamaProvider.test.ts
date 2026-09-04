import type {
  ModelMessage,
  ModelToolCall,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import { assessModelContext } from "@agent-anything/model-interaction";
import {
  composeModelInput,
  modelInputFromComposition,
  type ModelOutputFormat,
} from "@agent-anything/model-interaction/input";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../http/ProviderHttpTransport.js";
import {
  createNativeProviderRequest,
  createSettledToolResultMessage,
  defaultMessages,
} from "../native-tool-conformance/NativeToolInteractionTestSupport.js";
import { OllamaProvider } from "./OllamaProvider.js";

describe("OllamaProvider", () => {
  afterEach(() => vi.useRealTimers());

  it("sends an Ollama native generate request", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const provider = new OllamaProvider(config(), async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body) as unknown,
      });
      return okResponse({
        response: "{\"action\":\"complete\",\"summary\":\"done\"}",
        prompt_eval_count: 3,
        eval_count: 4,
      });
    });

    const result = await provider.send(request(provider), context());

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://localhost:11434/api/generate",
      headers: {
        "content-type": "application/json",
      },
      body: {
        model: "gemma3:4b",
        prompt: "system: You are concise.\n\nuser: hello",
        stream: false,
        truncate: false,
        options: {
          num_ctx: 16_384,
          num_predict: 2_048,
        },
        format: TEST_OUTPUT_FORMAT.schema,
      },
    });
    expect(result).toMatchObject({
      kind: "succeeded",
      response: {
        output: { action: "complete", summary: "done" },
        responseId: null,
        continuation: null,
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    });
  });

  it("rejects malformed structured-generation JSON", async () => {
    const provider = new OllamaProvider(config(), async () => okResponse({
      response: "not-json",
    }));

    await expect(provider.send(request(provider), context())).resolves.toMatchObject({
      kind: "failed",
      failure: {
        category: "response",
        code: "provider_structured_output_malformed",
      },
    });
  });

  it("uses /api/chat for native Tools and replays calls and results by trusted order and name", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OllamaProvider(config(), async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return calls.length === 1
        ? okResponse({
            message: {
              role: "assistant",
              content: "Inspecting.",
              thinking: "must not enter normalized output",
              tool_calls: [{
                type: "function",
                function: { name: "Read", arguments: { file_path: "package.json" } },
              }],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 3,
            eval_count: 4,
          })
        : okResponse({
            message: { role: "assistant", content: "Done.", tool_calls: [] },
            done: true,
            done_reason: "stop",
          });
    });

    const firstRequest = createNativeProviderRequest(provider, {
      instructions: {
        content: [
          { kind: "text", text: "Use the available callable when needed." },
          { kind: "text", text: "Follow the active protocol." },
        ],
      },
      messages: [{
        role: "user",
        content: [
          { kind: "text", text: "Task: Inspect package.json." },
          { kind: "text", text: "Current state: no prior work." },
        ],
      }],
    });
    const first = await provider.send(firstRequest, context());
    if (first.kind !== "succeeded" || first.response.kind !== "native_tool_turn") {
      throw new TypeError("Expected one native Ollama turn.");
    }
    const callBlock = first.response.turn.assistant.content.find(
      (block) => block.kind === "model_tool_call",
    );
    if (callBlock?.kind !== "model_tool_call") throw new TypeError("Expected one Tool call.");
    const secondMessages = [
      ...defaultMessages(),
      first.response.turn.assistant,
      createSettledToolResultMessage(callBlock.call),
    ];
    await expect(provider.send(createNativeProviderRequest(provider, {
      requestId: "native-request-2",
      messages: secondMessages,
    }), context())).resolves.toMatchObject({
      kind: "succeeded",
      response: {
        kind: "native_tool_turn",
        turn: { finish: { kind: "normal" } },
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "http://localhost:11434/api/chat",
      body: {
        model: "gemma3:4b",
        messages: [
          {
            role: "system",
            content: "Use the available callable when needed.\n\nFollow the active protocol.",
          },
          {
            role: "user",
            content: "Task: Inspect package.json.\n\nCurrent state: no prior work.",
          },
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
        stream: false,
        truncate: false,
        options: {
          num_ctx: 16_384,
          num_predict: 2_048,
        },
      },
    });
    expect(calls[0]?.body).not.toHaveProperty("format");
    expect(calls[0]?.body).not.toHaveProperty("think");
    expect(new TextEncoder().encode(JSON.stringify(calls[0]?.body)).byteLength)
      .toBeGreaterThan(0);
    expect(calls[1]?.body).toMatchObject({
      messages: [
        expect.any(Object),
        expect.any(Object),
        {
          role: "assistant",
          content: "Inspecting.",
          tool_calls: [{
            type: "function",
            function: {
              index: 0,
              name: "Read",
              arguments: { file_path: "package.json" },
            },
          }],
        },
        {
          role: "tool",
          tool_name: "Read",
          content: "{\"text\":\"file contents\"}",
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("must not enter normalized output");
  });

  it("projects a canonical discriminated union into the Ollama schema dialect", async () => {
    const bodies: unknown[] = [];
    const provider = new OllamaProvider(config(), async (_url, init) => {
      bodies.push(JSON.parse(init.body) as unknown);
      return okResponse({ response: "{\"kind\":\"completion\",\"summary\":\"done\"}" });
    });

    await expect(provider.send(
      request(provider, DISCRIMINATED_OUTPUT_FORMAT),
      context(),
    )).resolves.toMatchObject({ kind: "succeeded" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      format: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["tool_call"] },
              toolName: { type: "string", enum: ["Read"] },
              input: {
                type: "object",
                properties: { file_path: { type: "string" } },
                required: ["file_path"],
                additionalProperties: false,
              },
              reason: { type: "string" },
            },
            required: ["kind", "toolName", "input"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["tool_call"] },
              toolName: { type: "string", enum: ["Write"] },
              input: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["file_path", "content"],
                additionalProperties: false,
              },
              reason: { type: "string" },
            },
            required: ["kind", "toolName", "input"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["completion"] },
              summary: { type: "string" },
              reason: { type: "string" },
            },
            required: ["kind", "summary"],
            additionalProperties: false,
          },
        ],
      },
    });
    expect(JSON.stringify(bodies[0])).not.toContain("oneOf");
    expect(JSON.stringify(bodies[0])).toContain("anyOf");
    expect(JSON.stringify(bodies[0])).not.toContain("minLength");
  });

  it("rejects request encoding when oneOf branches are not provably exclusive", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ response: "{}" }));
    const provider = new OllamaProvider(config(), fetchImpl);
    const overlapping = {
      kind: "json_schema" as const,
      name: "overlapping_decision",
      schemaId: "test.overlapping-decision",
      schemaRevision: "1",
      schema: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["tool_call"] },
              input: { type: "object" },
            },
            required: ["kind", "input"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["tool_call"] },
              input: { type: "object" },
              reason: { type: "string" },
            },
            required: ["kind", "input"],
            additionalProperties: false,
          },
        ],
      },
    } satisfies ModelOutputFormat;

    await expect(provider.send(request(provider, overlapping), context()))
      .resolves.toMatchObject({
        kind: "failed",
        failure: { code: "provider_input_encoding_invalid" },
      });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps HTTP failure without retaining undocumented response fields", async () => {
    const provider = new OllamaProvider(config(), async () => ({
      ok: false,
      status: 500,
      async json() {
        return { response: "secret" };
      },
    }));

    const result = await provider.send(request(provider), context());

    expect(result).toMatchObject({
      kind: "failed",
      failure: {
        code: "provider_server_error",
        message: expect.stringContaining(
          "Provider request failed with HTTP 500. Request diagnostic:",
        ),
        statusCode: 500,
        metadata: {
          ollamaError: null,
          ollamaErrorTruncated: false,
          requestDiagnostic: {
            revision: "1",
            operation: "generate",
            interactionKind: "structured_generation",
            sourceMessageCount: 1,
            toolResultCount: 0,
            nonSucceededToolResultCount: 0,
            callableCount: 0,
            encodedBodyBytes: expect.any(Number),
            encodedBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("retains bounded diagnostics when Ollama rejects history after a failed Tool result", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = new OllamaProvider(config(), async (_url, init) => {
      calls.push(JSON.parse(init.body) as Record<string, unknown>);
      if (calls.length === 1) {
        return okResponse({
          message: {
            role: "assistant",
            content: "Running the command.",
            tool_calls: [{
              type: "function",
              function: { name: "Read", arguments: { file_path: "missing.txt" } },
            }],
          },
          done: true,
          done_reason: "stop",
        });
      }
      return {
        ok: false,
        status: 400,
        async json() {
          return {
            error: "invalid message history after tool failure\nrequest rejected",
            ignored: "must not be retained",
          };
        },
      };
    });

    const first = await provider.send(createNativeProviderRequest(provider), context());
    if (first.kind !== "succeeded" || first.response.kind !== "native_tool_turn") {
      throw new TypeError("Expected one native Ollama turn.");
    }
    const callBlock = first.response.turn.assistant.content.find(
      (block) => block.kind === "model_tool_call",
    );
    if (callBlock?.kind !== "model_tool_call") throw new TypeError("Expected one Tool call.");

    const result = await provider.send(createNativeProviderRequest(provider, {
      requestId: "native-request-after-failed-tool",
      messages: [
        ...defaultMessages(),
        first.response.turn.assistant,
        createFailedToolResultMessage(callBlock.call),
      ],
    }), context());

    expect(result).toMatchObject({
      kind: "failed",
      failure: {
        code: "provider_http_error",
        statusCode: 400,
        message: expect.stringContaining(
          "Ollama reported: invalid message history after tool failure request rejected.",
        ),
        metadata: {
          ollamaError: "invalid message history after tool failure request rejected",
          ollamaErrorTruncated: false,
          requestDiagnostic: {
            revision: "1",
            operation: "chat",
            interactionKind: "native_tool_turn",
            sourceMessageCount: 3,
            toolResultCount: 1,
            nonSucceededToolResultCount: 1,
            callableCount: 2,
            encodedBodyBytes: expect.any(Number),
            encodedBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
    });
    expect(result.kind === "failed" ? result.failure.message : "").toContain(
      "nonSucceededToolResults=1",
    );
    expect(JSON.stringify(result)).not.toContain("must not be retained");
    expect(calls[1]).toMatchObject({
      messages: [
        expect.any(Object),
        expect.any(Object),
        {
          role: "assistant",
          tool_calls: [expect.any(Object)],
        },
        {
          role: "tool",
          tool_name: "Read",
          content: JSON.stringify({
            code: "tool_failed",
            message: "private Tool failure content",
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private Tool failure content");
  });

  it("bounds Ollama error diagnostics before retaining them", async () => {
    const provider = new OllamaProvider(config(), async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: `\n${"x".repeat(2_100)}\t` };
      },
    }));

    const result = await provider.send(request(provider), context());
    if (result.kind !== "failed") throw new TypeError("Expected an Ollama failure.");

    expect(result.failure.metadata).toMatchObject({
      ollamaErrorTruncated: true,
    });
    const retained = result.failure.metadata.ollamaError;
    expect(typeof retained === "string" ? retained.length : -1).toBe(2_048);
    expect(result.failure.message).toContain("[truncated]");
  });

  it("maps an explicit native context rejection without retry semantics", async () => {
    const provider = new OllamaProvider(config(), async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: "the input length exceeds the context length" };
      },
    }));

    await expect(provider.send(request(provider), context())).resolves.toMatchObject({
      kind: "failed",
      failure: {
        category: "invalid_request",
        code: "provider_context_window_exceeded",
        statusCode: 400,
        metadata: {
          contextWindowTokens: 16_384,
          maximumOutputTokens: 2_048,
          requestDiagnostic: {
            encodedBodyBytes: expect.any(Number),
            encodedBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
    });
  });

  it("truthfully reports the selected Generate endpoint as continuation unsupported", () => {
    const provider = new OllamaProvider(config());
    expect(provider.descriptor.capabilities.continuation).toEqual({ supported: false });
  });

  it("projects trusted HTTP retry metadata into ProviderFailure", async () => {
    const provider = new OllamaProvider(config(), async () => ({
      ok: false,
      status: 503,
      headers: {
        get(name) {
          if (name === "retry-after") return "0";
          if (name === "request-id") return "ollama_503";
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
        statusCode: 503,
        retryAfterMs: 0,
        requestId: "ollama_503",
        metadata: {},
      },
    });
  });

  it("maps malformed provider responses", async () => {
    const provider = new OllamaProvider(config(), async () => okResponse({ done: true }));

    await expect(provider.send(request(provider), context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_response_malformed" },
    });
  });

  it("rejects incomplete chat turns and invalid JSON response bodies", async () => {
    const incomplete = new OllamaProvider(config(), async () => okResponse({
      message: { role: "assistant", content: "partial", tool_calls: [] },
      done: false,
    }));
    await expect(incomplete.send(createNativeProviderRequest(incomplete), context()))
      .resolves.toMatchObject({
        kind: "failed",
        failure: { code: "provider_response_incomplete" },
      });

    const invalidJson = new OllamaProvider(config(), async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError("invalid JSON");
      },
    }));
    await expect(invalidJson.send(createNativeProviderRequest(invalidJson), context()))
      .resolves.toMatchObject({
        kind: "failed",
        failure: { category: "response", code: "provider_response_malformed" },
      });
  });

  it("assigns stable internal call refs for the same request and response lineage", async () => {
    const provider = new OllamaProvider(config(), async () => okResponse({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "Read", arguments: { file_path: "a.txt" } } }],
      },
      done: true,
      done_reason: "stop",
    }));
    const nativeRequest = createNativeProviderRequest(provider);
    const first = await provider.send(nativeRequest, context());
    const second = await provider.send(nativeRequest, context());
    expect(modelCallIds(first)).toEqual(modelCallIds(second));
  });

  it("maps timeout failures", async () => {
    vi.useFakeTimers();
    const abortingFetch: FetchLike = async (_url, init) => {
      await rejectWhenAborted(init.signal);
      throw new Error("unreachable");
    };
    const provider = new OllamaProvider(config(), abortingFetch);
    const result = provider.send(request(provider), context());

    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_timeout" },
    });
  });

  it("returns exact Run cancellation when it aborts the active request", async () => {
    const interruption = cancellableContext();
    const provider = new OllamaProvider(config(), async (_url, init) => {
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

  it("rejects output-format drift before transport", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ response: "{}" }));
    const provider = new OllamaProvider(config(), fetchImpl);

    await expect(provider.send({
      ...request(provider),
      interaction: { kind: "text_generation" },
    }, context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_request_invalid" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function config() {
  return {
    baseUrl: "http://localhost:11434/",
    model: "gemma3:4b",
    timeoutMs: 1000,
    runtime: {
      contextWindowTokens: 16_384,
      maximumOutputTokens: 2_048,
    },
    nativeToolInteraction: { supported: true },
    requestBodyTransportLimit: {
      maximumBytes: 1_024 * 1_024,
      source: "host_configured" as const,
      revision: "test-transport-limit-1",
    },
  };
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

function request(
  provider: OllamaProvider,
  outputFormat: ModelOutputFormat = TEST_OUTPUT_FORMAT,
): ProviderRequest {
  const composition = composeModelInput({
    id: "ollama-test-composition",
    providerId: provider.modelContext.target.providerId,
    model: provider.modelContext.target.model,
    interaction: { kind: "structured_generation", outputFormat },
    sections: [
      section("instruction", "instruction", "You are concise."),
      section("user", "user", "hello"),
    ],
    lineage: testLineage(),
    composedAt: "2026-08-17T00:00:00.000Z",
  });
  const modelInput = modelInputFromComposition(composition);
  const headroom = {
    unit: "tokens" as const,
    amount: 0,
    policy: { id: "provider-test", revision: "1" },
  };
  const assessedAt = "2026-08-17T00:00:00.000Z";
  return {
    requestId: composition.id,
    purpose: "helarc.code-agent.plan",
    correlation: {
      controllerRequestId: "controller-request-1",
      branchId: "branch-1",
    },
    interaction: composition.interaction,
    continuation: null,
    instructions: modelInput.instructions,
    messages: modelInput.messages,
    composition,
    modelContext: {
      requestedOutput: provider.modelContext.requestedOutput,
      headroom,
      assessment: assessModelContext({
        compositionId: composition.id,
        capacity: provider.modelContext.capacity,
        measurement: provider.modelContext.measure(composition, assessedAt),
        requestedOutput: provider.modelContext.requestedOutput,
        headroom,
        assessedAt,
        revision: "provider-test-assessment-1",
      }),
    },
    metadata: {},
  };
}

function section(id: string, role: "instruction" | "user", text: string) {
  return {
    id,
    source: { owner: "provider-test", kind: "message", id, revision: "1" },
    kind: id === "instruction" ? "agent_instruction" : "message",
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
    instructionModel: { providerId: "ollama.api", model: "gemma3:4b" },
    instructionBlocks: [{ owner: "provider-test", kind: "message", id: "instruction", revision: "1" }],
    activeContext: null,
    contextProjection: null,
    projectionManifest: null,
    toolSelection: null,
    toolExposureContent: null,
    toolExposureBasis: null,
    toolExposureProof: null,
    toolGuidance: null,
    controllerControlGuidance: null,
    callableDefinitions: null,
    modelQualification: null,
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

const DISCRIMINATED_OUTPUT_FORMAT = {
  kind: "json_schema" as const,
  name: "test_union_decision",
  schemaId: "test.union-decision",
  schemaRevision: "1",
  schema: {
    oneOf: [
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["tool_call"] },
          toolName: { type: "string", enum: ["Read"], minLength: 1 },
          input: {
            type: "object",
            properties: { file_path: { type: "string", minLength: 1 } },
            required: ["file_path"],
            additionalProperties: false,
          },
          reason: { type: "string", minLength: 1, maxLength: 128 },
        },
        required: ["kind", "toolName", "input"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["tool_call"] },
          toolName: { type: "string", enum: ["Write"], minLength: 1 },
          input: {
            type: "object",
            properties: {
              file_path: { type: "string", minLength: 1 },
              content: { type: "string" },
            },
            required: ["file_path", "content"],
            additionalProperties: false,
          },
          reason: { type: "string", minLength: 1, maxLength: 128 },
        },
        required: ["kind", "toolName", "input"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["completion"] },
          summary: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1, maxLength: 128 },
        },
        required: ["kind", "summary"],
        additionalProperties: false,
      },
    ],
  },
} satisfies ModelOutputFormat;

function okResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    },
  };
}

function createFailedToolResultMessage(
  call: ModelToolCall,
): Extract<ModelMessage, { readonly role: "tool" }> {
  return {
    role: "tool",
    content: [{
      kind: "model_tool_result",
      result: {
        modelCallRef: call.modelCallRef,
        providerCallRef: call.providerCallRef,
        name: call.name,
        settlement: "failed",
        content: {
          code: "tool_failed",
          message: "private Tool failure content",
        },
        sourceRefs: [{
          owner: "ollama-provider-test",
          kind: "tool_result",
          id: "failed-tool-result-1",
          revision: "1",
        }],
      },
    }],
  };
}

function modelCallIds(result: Awaited<ReturnType<OllamaProvider["send"]>>): string[] {
  if (result.kind !== "succeeded" || result.response.kind !== "native_tool_turn") {
    throw new TypeError("Expected a successful native Tool turn.");
  }
  return result.response.turn.assistant.content.flatMap((block) =>
    block.kind === "model_tool_call" ? [block.call.modelCallRef.id] : []);
}
