import type {
  Provider,
  ProviderCallResult,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../ollama/OllamaProvider.js";
import { OpenAICompatibleProvider } from "../openai-compatible/OpenAICompatibleProvider.js";
import {
  createNativeProviderRequest,
} from "./NativeToolInteractionTestSupport.js";

interface AdapterCase {
  readonly name: string;
  readonly expectedCorrelation: "adapter_assigned" | "provider_supplied";
  create(response: unknown, supported?: boolean): Provider;
  response(input: {
    readonly text: string | null;
    readonly calls: readonly {
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }[];
    readonly finish: "normal" | "output_limit";
  }): unknown;
}

const ADAPTERS: readonly AdapterCase[] = [{
  name: "Ollama",
  expectedCorrelation: "adapter_assigned",
  create(response, supported = true) {
    return new OllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "model-a",
      timeoutMs: 1_000,
      runtime: { contextWindowTokens: 16_384, maximumOutputTokens: 2_048 },
      nativeToolInteraction: { supported },
      inputLimit: { maximumBytes: 1_000_000, source: "host_configured" },
    }, async () => okResponse(response));
  },
  response(input) {
    return {
      message: {
        role: "assistant",
        content: input.text ?? "",
        tool_calls: input.calls.map((call) => ({
          type: "function",
          function: { name: call.name, arguments: call.input },
        })),
      },
      done: true,
      done_reason: input.finish === "output_limit" ? "length" : "stop",
      prompt_eval_count: 8,
      eval_count: 5,
    };
  },
}, {
  name: "OpenAI-compatible",
  expectedCorrelation: "provider_supplied",
  create(response, supported = true) {
    return new OpenAICompatibleProvider({
      baseUrl: "https://provider.local/v1",
      apiKey: "",
      model: "model-a",
      timeoutMs: 1_000,
      nativeToolInteraction: { supported },
      inputLimit: { maximumBytes: 1_000_000, source: "host_configured" },
    }, async () => okResponse(response));
  },
  response(input) {
    return {
      id: "response-1",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: input.text,
          tool_calls: input.calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        },
        finish_reason: input.finish === "output_limit" ? "length" :
          input.calls.length > 0 ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
    };
  },
}];

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} native Tool interaction conformance`, () => {
    it("declares the complete configured mechanical capability", () => {
      const provider = adapter.create(adapter.response({ text: "done", calls: [], finish: "normal" }));
      expect(provider.descriptor.capabilities.nativeToolInteraction).toEqual({
        supported: true,
        callableDefinitions: true,
        modelCalls: true,
        resultMessages: true,
        multipleCalls: true,
        callCorrelation: adapter.expectedCorrelation,
      });
    });

    it("normalizes one complete text-only turn", async () => {
      const provider = adapter.create(adapter.response({
        text: "Task complete.",
        calls: [],
        finish: "normal",
      }));
      expect(await provider.send(createNativeProviderRequest(provider), context())).toMatchObject({
        kind: "succeeded",
        response: {
          kind: "native_tool_turn",
          turn: {
            assistant: {
              role: "assistant",
              content: [{ kind: "text", text: "Task complete." }],
            },
            finish: { kind: "normal" },
            usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
          },
        },
      });
    });

    it("preserves mixed text and several ordered calls", async () => {
      const provider = adapter.create(adapter.response({
        text: "I will inspect both targets.",
        calls: [{ id: "call-1", name: "Read", input: { file_path: "package.json" } }, {
          id: "call-2",
          name: "Search",
          input: { query: "scripts" },
        }],
        finish: "normal",
      }));
      const turn = successfulTurn(await provider.send(
        createNativeProviderRequest(provider),
        context(),
      ));
      expect(turn.finish).toEqual({ kind: "normal" });
      expect(turn.assistant.content.map((block) => block.kind)).toEqual([
        "text",
        "model_tool_call",
        "model_tool_call",
      ]);
      const calls = turn.assistant.content.flatMap((block) =>
        block.kind === "model_tool_call" ? [block.call] : []);
      expect(calls.map((call) => ({ name: call.name, input: call.input, ordinal: call.ordinal })))
        .toEqual([{ name: "Read", input: { file_path: "package.json" }, ordinal: 1 }, {
          name: "Search",
          input: { query: "scripts" },
          ordinal: 2,
        }]);
      expect(calls.every((call) =>
        call.modelCallRef.controllerRequestId === "controller-request-1" &&
        call.modelCallRef.branchId === "run-1:main"
      )).toBe(true);
      expect(new Set(calls.map((call) => call.modelCallRef.id)).size).toBe(2);
    });

    it("classifies output-limit turns without interpreting them as completion", async () => {
      const provider = adapter.create(adapter.response({
        text: "partial",
        calls: [],
        finish: "output_limit",
      }));
      const turn = successfulTurn(await provider.send(
        createNativeProviderRequest(provider),
        context(),
      ));
      expect(turn.finish).toEqual({ kind: "output_limit" });
    });

    it("rejects malformed arguments and empty normal output", async () => {
      const malformed = adapter.create(adapter.response({
        text: null,
        calls: [{ id: "call-1", name: "Read", input: "not-an-object" }],
        finish: "normal",
      }));
      await expect(malformed.send(createNativeProviderRequest(malformed), context()))
        .resolves.toMatchObject({
          kind: "failed",
          failure: { code: "provider_response_malformed" },
        });

      const empty = adapter.create(adapter.response({ text: null, calls: [], finish: "normal" }));
      await expect(empty.send(createNativeProviderRequest(empty), context()))
        .resolves.toMatchObject({
          kind: "failed",
          failure: { code: "provider_response_empty" },
        });
    });

    it("rejects an undeclared native capability before transport", async () => {
      const fetchImpl = vi.fn(async () => okResponse({}));
      const provider = adapter.name === "Ollama"
        ? new OllamaProvider({
            baseUrl: "http://localhost:11434",
            model: "model-a",
            timeoutMs: 1_000,
            runtime: { contextWindowTokens: 16_384, maximumOutputTokens: 2_048 },
            nativeToolInteraction: { supported: false },
            inputLimit: { maximumBytes: 1_000_000, source: "host_configured" },
          }, fetchImpl)
        : new OpenAICompatibleProvider({
            baseUrl: "https://provider.local/v1",
            apiKey: "",
            model: "model-a",
            timeoutMs: 1_000,
            nativeToolInteraction: { supported: false },
            inputLimit: { maximumBytes: 1_000_000, source: "host_configured" },
          }, fetchImpl);
      await expect(provider.send(createNativeProviderRequest(provider), context()))
        .resolves.toMatchObject({
          kind: "failed",
          failure: { code: "provider_native_tool_interaction_unsupported" },
        });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
}

it("normalizes equivalent adapter responses to equivalent provider-neutral meaning", async () => {
  const turns = await Promise.all(ADAPTERS.map(async (adapter) => {
    const provider = adapter.create(adapter.response({
      text: "Inspecting.",
      calls: [{ id: "call-1", name: "Read", input: { file_path: "package.json" } }],
      finish: "normal",
    }));
    return successfulTurn(await provider.send(createNativeProviderRequest(provider), context()));
  }));
  expect(turns.map((turn) => ({
    content: turn.assistant.content.map((block) => block.kind === "text"
      ? block
      : { kind: block.kind, name: block.call.name, input: block.call.input }),
    finish: turn.finish,
    usage: turn.usage,
  }))).toEqual([{
    content: [{ kind: "text", text: "Inspecting." }, {
      kind: "model_tool_call",
      name: "Read",
      input: { file_path: "package.json" },
    }],
    finish: { kind: "normal" },
    usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13, costUnits: null, metadata: {} },
  }, {
    content: [{ kind: "text", text: "Inspecting." }, {
      kind: "model_tool_call",
      name: "Read",
      input: { file_path: "package.json" },
    }],
    finish: { kind: "normal" },
    usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13, costUnits: null, metadata: {} },
  }]);
});

function successfulTurn(result: ProviderCallResult) {
  if (result.kind !== "succeeded" || result.response.kind !== "native_tool_turn") {
    throw new TypeError("Expected one successful native Tool turn.");
  }
  return result.response.turn;
}

function context(): InvocationInterruptionContext {
  return { signal: new AbortController().signal, interruption: null };
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
