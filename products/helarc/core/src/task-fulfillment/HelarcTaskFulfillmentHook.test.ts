import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { AgentStopEvent } from "@agent-anything/agent-hooks/events";
import type {
  ModelInputComposition,
  ModelJsonValue,
  Provider,
  ProviderCallResult,
  ProviderDescriptor,
  ProviderModelContext,
  ProviderRequest,
  ProviderTransportLimit,
} from "@agent-anything/model-interaction";
import { createUnknownModelInputMeasurement } from "@agent-anything/model-interaction";
import { describe, expect, it } from "vitest";
import { HELARC_TASK_KIND } from "../task/index.js";
import { HelarcTaskFulfillmentHook } from "./HelarcTaskFulfillmentHook.js";

const NOW = "2026-08-28T00:00:00.000Z";

describe("HelarcTaskFulfillmentHook", () => {
  it("allows a proposed completion fulfilled by the settled trajectory", async () => {
    const provider = new StructuredProvider({
      status: "fulfilled",
      rationale: "The settled trajectory contains every requested outcome.",
      missingOutcomes: [],
      unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, () => NOW);

    await expect(hook.handle(createEvent(), context())).resolves.toEqual({ disposition: "allow" });
    expect(hook.getAssessments()).toMatchObject([
      { status: "fulfilled", feedback: null, findings: [] },
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      purpose: "helarc.task-fulfillment",
      interaction: { kind: "structured_generation" },
      metadata: { taskId: "task-1" },
    });
    expect(provider.requests[0]?.interaction).toBe(provider.requests[0]?.composition.interaction);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
      "Create a console application and run it once.",
    );
    expect(JSON.stringify(provider.requests[0]?.instructions)).toContain(
      "failed, denied, cancelled, timed-out, invalid, unavailable, or unknown-effect",
    );
  });

  it("turns missing outcomes into bounded Stop Hook feedback", async () => {
    const provider = new StructuredProvider({
      status: "incomplete",
      rationale: "The response explains the work but does not show execution.",
      missingOutcomes: ["No settled command result shows that the program ran."],
      unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, () => NOW);

    const decision = await hook.handle(createEvent(), context());

    expect(decision).toMatchObject({
      disposition: "continue",
      code: "task_fulfillment_incomplete",
    });
    if (decision.disposition === "continue") {
      expect(decision.message).toContain("does not yet fulfill the original task");
      expect(decision.message).toContain("No settled command result");
    }
    expect(hook.getAssessments()).toMatchObject([{
      status: "incomplete",
      findings: [{ kind: "missing_outcome", code: "task_outcome_missing" }],
    }]);
  });

  it("surfaces contradictory Provider output as a non-decision Hook error", async () => {
    const provider = new StructuredProvider({
      status: "fulfilled",
      rationale: "The Task is complete.",
      missingOutcomes: ["The requested process was not executed."],
      unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, () => NOW);

    await expect(hook.handle(createEvent(), context())).rejects.toThrow(
      "A fulfilled Task response cannot carry unresolved outcomes or claims.",
    );
    expect(hook.getAssessments()).toEqual([]);
  });
});

class StructuredProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  readonly modelContext: ProviderModelContext;
  readonly requestBodyTransportLimit: ProviderTransportLimit = Object.freeze({
    maximumBytes: 1_000_000,
    source: "host_configured",
    revision: "1",
  });
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly output: ModelJsonValue) {
    const inputPreservation = Object.freeze({
      providerId: "task-fulfillment-provider",
      model: "test-model",
      adapterRevision: "1",
      runtimeVersion: null,
      truncation: "disabled" as const,
      contextShift: "disabled" as const,
      evidence: Object.freeze([]),
      revision: "1",
    });
    const requestedOutput = Object.freeze({
      unit: "tokens" as const,
      maximum: 1_024,
      source: "product_configured" as const,
      revision: "1",
    });
    this.modelContext = Object.freeze({
      target: Object.freeze({
        providerId: "task-fulfillment-provider",
        model: "test-model",
        revision: "1",
      }),
      capacity: Object.freeze({ supported: false as const }),
      requestedOutput,
      inputPreservation,
      measure(composition: ModelInputComposition, measuredAt: string) {
        return createUnknownModelInputMeasurement({
          compositionId: composition.id,
          measuredAt,
          reason: "unsupported",
        });
      },
    });
    this.descriptor = Object.freeze({
      id: "task-fulfillment-provider",
      name: "Task Fulfillment Provider",
      metadata: Object.freeze({}),
      capabilities: Object.freeze({
        nativeToolInteraction: Object.freeze({ supported: false as const }),
        structuredGeneration: Object.freeze({ supported: true as const }),
        streaming: Object.freeze({ supported: false as const }),
        modelContext: Object.freeze({
          capacity: this.modelContext.capacity,
          requestedOutput,
          inputPreservation,
        }),
        continuation: Object.freeze({ supported: false as const }),
        compaction: Object.freeze({ supported: false as const }),
        usageMetering: Object.freeze({
          inputTokens: "unavailable" as const,
          outputTokens: "unavailable" as const,
          costUnits: "unavailable" as const,
        }),
      }),
      requestRetryScheduler: Object.freeze({ kind: "harness" as const }),
    });
  }

  async send(
    request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    this.requests.push(request);
    return Object.freeze({
      kind: "succeeded" as const,
      response: Object.freeze({
        kind: "structured_generation" as const,
        output: this.output,
        responseId: "task-fulfillment-response-1",
        continuation: null,
        usage: null,
        metadata: Object.freeze({}),
      }),
    });
  }
}

function createEvent(): AgentStopEvent<{ readonly summary: string }> {
  const run = Object.freeze({ id: "run-1" });
  return Object.freeze({
    ref: Object.freeze({
      run,
      id: "run-1:stop:1",
      sequence: 1,
      revision: "1",
    }),
    point: "Stop" as const,
    run,
    runKind: "root" as const,
    agent: Object.freeze({ id: "helarc", revision: "1" }),
    task: Object.freeze({
      id: "task-1",
      kind: HELARC_TASK_KIND,
      input: Object.freeze({ prompt: "Create a console application and run it once." }),
      createdAt: NOW,
      metadata: Object.freeze({}),
    }),
    controllerRequestId: "controller-request-1",
    iteration: 1,
    candidate: Object.freeze({
      ref: Object.freeze({ id: "proposal-1", revision: "1" }),
      kind: "complete" as const,
      output: Object.freeze({ summary: "Here is how to create the application." }),
    }),
    interaction: Object.freeze({
      id: "interaction-1",
      revision: "1",
      messages: Object.freeze([]),
      unsettledCalls: Object.freeze([]),
      settledCallCount: 0,
    }),
    plan: null,
    verification: Object.freeze({
      snapshot: Object.freeze({ runId: "run-1", revision: 2 }),
      gate: Object.freeze({ id: "completion-gate-1", revision: "1" }),
    }),
    pending: Object.freeze([]),
    emittedAt: NOW,
  });
}

function context(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}
