import { describe, expect, it } from "vitest";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type {
  ModelJsonValue,
  Provider,
  ProviderCallResult,
  ProviderDescriptor,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import {
  createUtf8ModelInputAccounting,
  type ProviderModelInputAccounting,
} from "@agent-anything/model-interaction/input";
import type { TaskFulfillmentEvaluationInput } from "@agent-anything/agent-runtime/completion";
import { HELARC_TASK_KIND } from "../task/index.js";
import { HelarcTaskFulfillmentEvaluator } from "./HelarcTaskFulfillmentEvaluator.js";

const NOW = "2026-08-28T00:00:00.000Z";

describe("HelarcTaskFulfillmentEvaluator", () => {
  it("assesses the proposed completion against the original Helarc Task", async () => {
    const provider = new StructuredProvider({
      status: "fulfilled",
      rationale: "The settled trajectory contains every requested outcome.",
      missingOutcomes: [],
      unsupportedClaims: [],
    });
    const evaluator = new HelarcTaskFulfillmentEvaluator(provider, () => NOW);

    const result = await evaluator.evaluate(createInput(), context());

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      kind: "assessed",
      assessment: { status: "fulfilled", feedback: null, findings: [] },
    });
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
  });

  it("turns missing outcomes into bounded continuation feedback", async () => {
    const provider = new StructuredProvider({
      status: "incomplete",
      rationale: "The response explains the work but does not show execution.",
      missingOutcomes: ["No settled command result shows that the program ran."],
      unsupportedClaims: [],
    });
    const evaluator = new HelarcTaskFulfillmentEvaluator(provider, () => NOW);

    const result = await evaluator.evaluate(createInput(), context());

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      kind: "assessed",
      assessment: {
        status: "incomplete",
        findings: [{ kind: "missing_outcome", code: "task_outcome_missing" }],
      },
    });
    if (result.kind === "assessed") {
      expect(result.assessment.feedback).toContain("does not yet fulfill the original task");
      expect(result.assessment.feedback).toContain("No settled command result");
    }
  });

  it("rejects contradictory fulfilled output from the Provider", async () => {
    const provider = new StructuredProvider({
      status: "fulfilled",
      rationale: "The Task is complete.",
      missingOutcomes: ["The requested process was not executed."],
      unsupportedClaims: [],
    });
    const evaluator = new HelarcTaskFulfillmentEvaluator(provider, () => NOW);

    await expect(evaluator.evaluate(createInput(), context())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "task_fulfillment_response_invalid", retryable: false },
    });
  });
});

class StructuredProvider implements Provider {
  readonly descriptor: ProviderDescriptor;
  readonly inputAccounting: ProviderModelInputAccounting;
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly output: ModelJsonValue) {
    this.inputAccounting = createUtf8ModelInputAccounting({
      providerId: "task-fulfillment-provider",
      model: "test-model",
      maximumInputBytes: 1_000_000,
      limitSource: "host_configured",
      estimator: { id: "test.utf8", revision: "1" },
      framing: { id: "test.framing", revision: "1" },
      renderRequest: (instructions, messages, interaction) =>
        JSON.stringify({ instructions, messages, interaction }),
    });
    this.descriptor = Object.freeze({
      id: "task-fulfillment-provider",
      name: "Task Fulfillment Provider",
      metadata: Object.freeze({}),
      capabilities: Object.freeze({
        nativeToolInteraction: Object.freeze({ supported: false as const }),
        structuredGeneration: Object.freeze({ supported: true as const }),
        streaming: Object.freeze({ supported: false as const }),
        modelInput: this.inputAccounting.capability,
        continuation: Object.freeze({ supported: false as const }),
        compaction: Object.freeze({ supported: false as const }),
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

function createInput(): TaskFulfillmentEvaluationInput {
  return {
    assessment: { id: "assessment-1", revision: "1" },
    run: { id: "run-1" },
    turn: { run: { id: "run-1" }, id: "turn-1", sequence: 1 },
    objective: { id: "task-1", kind: HELARC_TASK_KIND, revision: "sha256:objective" },
    task: {
      id: "task-1",
      kind: HELARC_TASK_KIND,
      input: { prompt: "Create a console application and run it once." },
      createdAt: NOW,
      metadata: {},
    },
    proposal: { id: "proposal-1", revision: "sha256:proposal" },
    output: { summary: "Here is how to create the application." },
    interaction: {
      id: "interaction-1",
      revision: "1",
      messages: [],
      unsettledCalls: [],
      settledCallCount: 0,
    },
    verification: { snapshot: { runId: "run-1", revision: 0 }, gate: null },
    requestedAt: NOW,
    deadlineAt: "2026-08-28T00:00:05.000Z",
  };
}

function context(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}
