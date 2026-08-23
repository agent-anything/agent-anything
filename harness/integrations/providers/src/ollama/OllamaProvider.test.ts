import type {
  ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  composeModelInput,
  providerMessagesFromComposition,
  type ModelOutputFormat,
} from "@agent-anything/model-interaction/input";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../http/ProviderHttpTransport.js";
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
        format: TEST_OUTPUT_FORMAT.schema,
      },
    });
    expect(result).toMatchObject({
      kind: "succeeded",
      response: {
        output: "{\"action\":\"complete\",\"summary\":\"done\"}",
        responseId: null,
        continuation: null,
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    });
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

  it("rejects request composition when oneOf branches are not provably exclusive", () => {
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

    expect(() => request(provider, overlapping)).toThrow(
      "Ollama cannot project the requested JSON Schema into its native schema dialect.",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps HTTP failure without reading response body", async () => {
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
        code: "provider_http_error",
        message: "Provider request failed with HTTP 500.",
        statusCode: 500,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
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
      outputFormat: { kind: "text" },
    }, context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "provider_input_accounting_invalid" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function config() {
  return {
    baseUrl: "http://localhost:11434/",
    model: "gemma3:4b",
    timeoutMs: 1000,
    inputLimit: { maximumBytes: 1_024 * 1_024, source: "host_configured" as const },
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
    providerId: provider.inputAccounting.providerId,
    model: provider.inputAccounting.model,
    accounting: provider.inputAccounting,
    outputFormat,
    outputReserve: { unit: "bytes", amount: 0 },
    contextBudget: { unit: "bytes", amount: 0 },
    contextProjectedAmount: 0,
    sections: [
      section("system", "system", "You are concise."),
      section("user", "user", "hello"),
    ],
    lineage: testLineage(),
    composedAt: "2026-08-17T00:00:00.000Z",
  });
  return {
    capability: "helarc.code-agent.plan",
    outputFormat,
    continuation: null,
    messages: providerMessagesFromComposition(composition.sections),
    composition,
    metadata: {},
  };
}

function section(id: string, role: "system" | "user", text: string) {
  return {
    id,
    source: { owner: "provider-test", kind: "message", id, revision: "1" },
    kind: "message",
    role,
    necessity: "mandatory" as const,
    content: { kind: "text" as const, text },
  };
}

function testLineage() {
  return {
    activeContext: null,
    contextProjection: null,
    projectionManifest: null,
    toolExposure: null,
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
