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

  it("maps HTTP failure without leaking credentials", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://provider.local/v1",
      apiKey: "secret-key",
      model: "model-a",
      timeoutMs: 1000,
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
        code: "provider_http_error",
        message: "Provider request failed with HTTP 401.",
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
