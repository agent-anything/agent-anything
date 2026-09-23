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
import { createDefaultHelarcInstructionSettings } from "../instructions/HelarcInstructionSettings.js";
import { HelarcTaskFulfillmentHook } from "./HelarcTaskFulfillmentHook.js";
import { snapshotHelarcTaskFulfillmentAssessment } from "./HelarcTaskFulfillment.js";

const NOW = "2026-08-28T00:00:00.000Z";

function enabledStopInstructions() {
  return createDefaultHelarcInstructionSettings().stop.map(section => ({...section, enabled: true}));
}

describe("HelarcTaskFulfillmentHook", () => {
  it.each(["incomplete", "uncertain"] as const)("allows an honest %s outcome without forcing another turn", async (status) => {
    const provider = new StructuredProvider({
      status, disposition: "allow", rationale: "The limitation is disclosed; no useful action remains.",
      missingOutcomes: ["Unavailable external service."], unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, enabledStopInstructions(), () => NOW);
    await expect(hook.handle(createEvent(), context())).resolves.toEqual({ disposition: "allow" });
    expect(hook.getAssessments()).toMatchObject([{ status, disposition: "allow", feedback: null }]);
    expect(provider.requests).toHaveLength(1);
  });

  it("allows a proposed completion fulfilled by the settled trajectory", async () => {
    const provider = new StructuredProvider({
      status: "fulfilled", disposition: "allow",
      rationale: "The settled trajectory contains every requested outcome.",
      missingOutcomes: [],
      unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, enabledStopInstructions(), () => NOW);

    await expect(hook.handle(createEvent(), context())).resolves.toEqual({ disposition: "allow" });
    expect(hook.getAssessments()).toMatchObject([
      { status: "fulfilled", disposition: "allow", feedback: null, findings: [] },
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
      status: "incomplete", disposition: "continue",
      rationale: "The response explains the work but does not show execution.",
      missingOutcomes: ["No settled command result shows that the program ran."],
      unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, enabledStopInstructions(), () => NOW);

    const decision = await hook.handle(createEvent(), context());

    expect(decision).toMatchObject({
      disposition: "continue",
      code: "stop_instructions_continue",
    });
    if (decision.disposition === "continue") {
      expect(decision.message).toContain("The response explains the work but does not show execution.");
      expect(decision.message).toContain("No settled command result");
    }
    expect(hook.getAssessments()).toMatchObject([{
      status: "incomplete", disposition: "continue",
      findings: [{ kind: "missing_outcome", code: "task_outcome_missing" }],
    }]);
  });

  it.each(["root", "descendant"] as const)("allows fulfilled %s work to request truthful Plan follow-up", async (runKind) => {
    const rationale = "The requested work is complete. Update the existing Plan to reflect the settled results before the final response.";
    const provider = new StructuredProvider({
      status: "fulfilled", disposition: "continue", rationale,
      missingOutcomes: [], unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, enabledStopInstructions(), () => NOW);
    const event = {
      ...createEvent(), runKind,
      plan: {
        id: "plan-1", version: 1, status: "active" as const,
        steps: [{ step: "Inspect settled results", status: "in_progress" as const }],
      },
    };

    await expect(hook.handle(event, context())).resolves.toEqual({
      disposition: "continue", code: "stop_instructions_continue", message: rationale,
    });
    const assessment = hook.getAssessments()[0]!;
    expect(assessment).toMatchObject({
      status: "fulfilled", disposition: "continue", findings: [], feedback: rationale,
    });
    expect(event.plan.steps[0]!.status).toBe("in_progress");
    const message = provider.requests[0]!.messages[0]!;
    if (message.role !== "user" || message.content[0]?.kind !== "text") {
      throw new TypeError("Expected Stop assessment material in a user message.");
    }
    expect(JSON.parse(message.content[0].text).completionBasis.plan).toEqual(event.plan);
    expect(JSON.stringify(provider.requests[0]!.instructions)).toContain("If a Plan exists, check whether it reflects the settled work");
    expect(provider.requests[0]!.interaction).toMatchObject({
      kind: "structured_generation",
      outputFormat: { schemaRevision: "3" },
    });
    for (const feedback of [null, "", " \t "]) {
      expect(() => snapshotHelarcTaskFulfillmentAssessment({ ...assessment, feedback })).toThrow();
    }
    expect(() => snapshotHelarcTaskFulfillmentAssessment({ ...assessment, disposition: "allow" })).toThrow();
  });

  it("reassesses later candidates without making fulfilled sticky or rewriting history", async () => {
    const outputs: ModelJsonValue[] = [
      { status: "fulfilled", disposition: "continue", rationale: "Synchronize the stale Plan.", missingOutcomes: [], unsupportedClaims: [] },
      { status: "incomplete", disposition: "continue", rationale: "New evidence reveals an omitted requested check. Perform that check.", missingOutcomes: ["The requested check has not run."], unsupportedClaims: [] },
      { status: "uncertain", disposition: "continue", rationale: "The check returned ambiguous output. Inspect the retained result.", missingOutcomes: [], unsupportedClaims: [] },
      { status: "fulfilled", disposition: "allow", rationale: "The new results establish the requested outcomes and no useful follow-up remains.", missingOutcomes: [], unsupportedClaims: [] },
    ];
    let index = 0;
    const provider = new StructuredProvider(() => outputs[index++]!);
    const hook = new HelarcTaskFulfillmentHook(provider, enabledStopInstructions(), () => NOW);
    await expect(hook.handle(createEvent(1), context())).resolves.toMatchObject({ disposition: "continue" });
    const firstSnapshot = hook.getAssessments();
    const firstRecord = JSON.stringify(firstSnapshot[0]);
    for (let iteration = 2; iteration <= 4; iteration++) {
      await expect(hook.handle(createEvent(iteration), context())).resolves.toMatchObject({
        disposition: iteration === 4 ? "allow" : "continue",
      });
    }

    expect(provider.requests).toHaveLength(4);
    expect(provider.requests.map(request => request.metadata.completionCandidateId))
      .toEqual(["proposal-1", "proposal-2", "proposal-3", "proposal-4"]);
    const assessments = hook.getAssessments();
    expect(assessments.map(({ status }) => status)).toEqual(["fulfilled", "incomplete", "uncertain", "fulfilled"]);
    expect(new Set(assessments.map(({ id }) => id)).size).toBe(4);
    expect(firstSnapshot).toHaveLength(1);
    expect(assessments[0]).toBe(firstSnapshot[0]);
    expect(JSON.stringify(firstSnapshot[0])).toBe(firstRecord);
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(assessments.every(assessment => Object.isFrozen(assessment) && Object.isFrozen(assessment.findings))).toBe(true);
    expect(assessments.at(-1)).toMatchObject({ disposition: "allow", feedback: null });
  });

  it.each(["allow", "continue"] as const)("rejects contradictory fulfilled outcomes even with disposition %s", async (disposition) => {
    const provider = new StructuredProvider({
      status: "fulfilled", disposition,
      rationale: "The Task is complete.",
      missingOutcomes: ["The requested process was not executed."],
      unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, enabledStopInstructions(), () => NOW);

    await expect(hook.handle(createEvent(), context())).rejects.toThrow(
      "A fulfilled Task response cannot carry unresolved outcomes or claims.",
    );
    expect(hook.getAssessments()).toEqual([]);
  });

  it("rejects empty continuation rationale without recording an assessment", async () => {
    const provider = new StructuredProvider({
      status: "fulfilled", disposition: "continue", rationale: " \n ",
      missingOutcomes: [], unsupportedClaims: [],
    });
    const hook = new HelarcTaskFulfillmentHook(provider, enabledStopInstructions(), () => NOW);
    await expect(hook.handle(createEvent(), context())).rejects.toThrow("rationale must be bounded non-empty text");
    expect(hook.getAssessments()).toEqual([]);
  });

  it.each(["root", "descendant"] as const)("uses the snapshotted custom Stop text for a %s request", async (runKind) => {
    const provider = new StructuredProvider({
      status: "fulfilled", disposition: "allow", rationale: "Accepted.", missingOutcomes: [], unsupportedClaims: [],
    });
    const sections = [{ id: "stop_instructions", enabled: true, content: "  Check the requested outcome.\nUse the supplied results.  " }];
    const expected = sections[0]!.content;
    const hook = new HelarcTaskFulfillmentHook(provider, sections, () => NOW);
    sections[0]!.content = "Changed after composition.";
    sections[0]!.enabled = false;
    await hook.handle({ ...createEvent(), runKind }, context());
    const request = provider.requests[0]!;
    expect(request.instructions.content).toEqual([{ kind: "text", text: expected }]);
    expect(JSON.stringify(request)).not.toContain("Evaluate whether the proposed completion");
    expect(request.composition.lineage.instructionContent?.revision).toMatch(/^sha256:/);
    expect(request.metadata.stopInstructionsRevision).toBe(request.composition.lineage.instructionContent?.revision);

    const changed = new HelarcTaskFulfillmentHook(provider, [{ ...sections[0]!, enabled: true }], () => NOW);
    await changed.handle({ ...createEvent(), runKind }, context());
    expect(provider.requests[1]!.composition.lineage.instructionContent?.revision)
      .not.toBe(request.composition.lineage.instructionContent?.revision);
  });

  describe.each(["root", "descendant"] as const)("%s Stop handling", (runKind) => {
    it.each([
      { name: "fresh settings", sections: createDefaultHelarcInstructionSettings().stop },
      { name: "no sections", sections: [] },
      { name: "disabled text", sections: [{ id: "stop_instructions", enabled: false, content: "Retained disabled Stop text." }] },
      { name: "empty text", sections: [{ id: "stop_instructions", enabled: true, content: "" }] },
      { name: "whitespace-only text", sections: [{ id: "stop_instructions", enabled: true, content: " \t\r\n " }] },
    ])("allows without a model request or assessment for $name", async ({ sections }) => {
      const provider = new StructuredProvider({
        status: "incomplete", disposition: "continue", rationale: "More work is needed.", missingOutcomes: ["Requested result is missing."], unsupportedClaims: [],
      });
      const hook = new HelarcTaskFulfillmentHook(provider, sections, () => NOW);

      await expect(hook.handle({ ...createEvent(), runKind }, context())).resolves.toEqual({
        disposition: "allow",
      });
      expect(provider.requests).toHaveLength(0);
      expect(hook.getAssessments()).toEqual([]);
    });
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

  constructor(private readonly output: ModelJsonValue | (() => ModelJsonValue)) {
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
        output: typeof this.output === "function" ? this.output() : this.output,
        responseId: "task-fulfillment-response-1",
        continuation: null,
        usage: null,
        metadata: Object.freeze({}),
      }),
    });
  }
}

function createEvent(iteration = 1): AgentStopEvent<{ readonly summary: string }> {
  const run = Object.freeze({ id: "run-1" });
  return Object.freeze({
    ref: Object.freeze({
      run,
      id: `run-1:stop:${iteration}`,
      sequence: iteration,
      revision: String(iteration),
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
    controllerRequestId: `controller-request-${iteration}`,
    iteration,
    candidate: Object.freeze({
      ref: Object.freeze({ id: `proposal-${iteration}`, revision: String(iteration) }),
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
    pending: Object.freeze([]),
    emittedAt: NOW,
  });
}

function context(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}
