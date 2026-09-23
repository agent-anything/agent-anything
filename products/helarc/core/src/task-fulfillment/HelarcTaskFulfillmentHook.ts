import { createHash } from "node:crypto";
import { ExecutionFlowPath, type ExecutionFlowContext } from "@agent-anything/observability/execution-flow";
import { HELARC_STOP_EXECUTION_FLOW } from "./HelarcStopExecutionFlow.js";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createAgentHookComposition,
  type AgentHookComposition,
  type AgentStopHandler,
  type AgentStopHandlerResult,
} from "@agent-anything/agent-hooks/composition";
import type { AgentStopEvent } from "@agent-anything/agent-hooks/events";
import type {
  ModelJsonValue,
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import { assessModelContext } from "@agent-anything/model-interaction";
import { modelInputFromComposition, composeModelInput } from "@agent-anything/model-interaction/input";
import type { HelarcInstructionSectionSetting } from "../instructions/HelarcProtocolInstructions.js";
import {
  snapshotHelarcTaskFulfillmentAssessment,
  type HelarcTaskFulfillmentAssessment,
  type HelarcTaskFulfillmentFinding,
  type HelarcTaskFulfillmentStatus,
} from "./HelarcTaskFulfillment.js";

export const HELARC_TASK_FULFILLMENT_HOOK_REVISION =
  "helarc.task-fulfillment-stop-hook.v4";

const hookRef = Object.freeze({
  owner: "helarc",
  id: "helarc.task-fulfillment.stop",
  revision: HELARC_TASK_FULFILLMENT_HOOK_REVISION,
});

const handlerRef = Object.freeze({
  id: "helarc.task-fulfillment.provider-handler",
  revision: HELARC_TASK_FULFILLMENT_HOOK_REVISION,
});

const interaction = Object.freeze({
  kind: "structured_generation" as const,
  outputFormat: Object.freeze({
    kind: "json_schema" as const,
    name: "helarc_task_fulfillment",
    schemaId: "helarc.task-fulfillment-assessment",
    schemaRevision: "3",
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze([
        "status", "disposition", "rationale", "missingOutcomes", "unsupportedClaims",
      ]),
      properties: Object.freeze({
        disposition: Object.freeze({
          type: "string",
          enum: Object.freeze(["allow", "continue"]),
          description: "Independently allow this processing to end or request concrete useful follow-up described in rationale. Any fulfillment status may accompany either disposition: fulfilled can still require follow-up, while incomplete or uncertain alone does not require continuation.",
        }),
        status: Object.freeze({
          type: "string",
          enum: Object.freeze(["fulfilled", "incomplete", "uncertain"]),
          description: "Assessment of the original Task outcomes from the current evidence, not a Run terminal state or a Stop disposition. Later evidence may change this conclusion. Plan maintenance alone is not a missing Task outcome.",
        }),
        rationale: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 8_192,
          description: "Explain the assessment and disposition. For continue, identify the concrete useful next work, including follow-up when status is fulfilled.",
        }),
        missingOutcomes: Object.freeze({
          type: "array",
          maxItems: 16,
          items: Object.freeze({ type: "string" }),
        }),
        unsupportedClaims: Object.freeze({
          type: "array",
          maxItems: 16,
          items: Object.freeze({ type: "string" }),
        }),
      }),
    }),
  }),
});

export class HelarcTaskFulfillmentHook implements AgentStopHandler {
  private readonly assessments: HelarcTaskFulfillmentAssessment[] = [];
  private readonly instructions: string;

  constructor(
    private readonly provider: Provider,
    stopInstructions: readonly HelarcInstructionSectionSetting[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.instructions = stopInstructions
      .filter(({ enabled, content }) => enabled && content.trim().length > 0)
      .map(({ content }) => content).join("\n\n");
  }

  getAssessments(): readonly HelarcTaskFulfillmentAssessment[] {
    return Object.freeze([...this.assessments]);
  }

  async handle(
    event: AgentStopEvent,
    interruptionContext: InvocationInterruptionContext,
    executionFlow?: ExecutionFlowContext,
  ): Promise<AgentStopHandlerResult> {
    const flow = new ExecutionFlowPath(HELARC_STOP_EXECUTION_FLOW, executionFlow ?? {}, event.run.id, []);
    try {
      const result = await this.handleWithFlow(event, interruptionContext, flow);
      flow.advance("decision", {disposition:result.disposition}).output(flow.material("Stop instruction decision", "returned", result));
      flow.close("returned");
      return result;
    } catch (error) { flow.close("failed"); throw error; }
  }

  private async handleWithFlow(event: AgentStopEvent, interruptionContext: InvocationInterruptionContext, flow: ExecutionFlowPath): Promise<AgentStopHandlerResult> {
    flow.advance("instructions", {}, [flow.material("Stop instruction input", "received", {event, instructions: this.instructions})])
      .check("effective_instructions", this.instructions.length ? "passed" : "not_applicable", {characterCount:this.instructions.length, assessmentEnabled:this.instructions.length > 0});
    if (this.instructions.length === 0) {
      return Object.freeze({ disposition: "allow" as const });
    }
    readHelarcTaskObjective(event);
    const request = buildRequest(this.provider, event, this.instructions);
    flow.advance("request", {providerId:this.provider.descriptor.id}, [{owner:"model-interaction",kind:"request",id:request.requestId,revision:null}]);
    const result = await this.provider.send(request, interruptionContext);
    const resultRef = flow.material("Stop model result", "returned", result, "provider");
    flow.current?.output(resultRef);
    const assessmentStep = flow.advance("assessment", {providerOutcome:result.kind}, [resultRef]);
    const candidate = parseProviderResult(result);
    const assessment = createAssessment(event, candidate, this.now());
    this.assessments.push(assessment);
    assessmentStep.output(flow.material("Stop instruction assessment", "assessed", assessment));
    return assessment.disposition === "allow"
      ? Object.freeze({ disposition: "allow" as const })
      : Object.freeze({
          disposition: "continue" as const,
          code: "stop_instructions_continue",
          message: assessment.feedback!,
        });
  }
}

export function createHelarcTaskFulfillmentHookComposition(
  provider: Provider,
  stopInstructions: readonly HelarcInstructionSectionSetting[],
  now?: () => string,
): Readonly<{
  hook: HelarcTaskFulfillmentHook;
  composition: AgentHookComposition;
}> {
  const hook = new HelarcTaskFulfillmentHook(provider, stopInstructions, now);
  return Object.freeze({
    hook,
    composition: createAgentHookComposition({
      id: "helarc.agent-hooks",
      revision: HELARC_TASK_FULFILLMENT_HOOK_REVISION,
      registrations: Object.freeze([Object.freeze({
        ref: hookRef,
        point: "Stop" as const,
        mode: "blocking" as const,
        runKinds: Object.freeze(["root" as const, "descendant" as const]),
        handler: handlerRef,
        timeoutMs: 120_000,
        maximumResultBytes: 16_384,
      })]),
      bindings: Object.freeze([Object.freeze({
        ref: handlerRef,
        point: "Stop" as const,
        mode: "blocking" as const,
        handler: hook,
      })]),
    }),
  });
}

interface HelarcFulfillmentCandidate {
  readonly status: HelarcTaskFulfillmentStatus;
  readonly disposition: "allow" | "continue";
  readonly rationale: string;
  readonly missingOutcomes: readonly string[];
  readonly unsupportedClaims: readonly string[];
}

function buildRequest(provider: Provider, event: AgentStopEvent, instructions: string): ProviderRequest {
  if (!provider.descriptor.capabilities.structuredGeneration.supported) {
    throw new TypeError("Task Fulfillment requires Provider structured generation.");
  }
  const taskObjective = readHelarcTaskObjective(event);
  const material = Object.freeze({
    originalTask: taskObjective,
    completionProposal: event.candidate.kind === "complete" ? event.candidate.output : null,
    settledInteraction: event.interaction.messages,
    unsettledCallCount: event.interaction.unsettledCalls.length,
    settledCallCount: event.interaction.settledCallCount,
    completionBasis: Object.freeze({
      candidate: event.candidate.ref,
      plan: event.plan,
      pending: event.pending,
    }),
  });
  const source = (kind: string, id: string, revision: string | null) => Object.freeze({
    owner: "helarc",
    kind,
    id,
    revision,
  });
  const instructionRevision = `sha256:${createHash("sha256").update(instructions, "utf8").digest("hex")}`;
  const instructionSource = source("stop_instructions", "helarc.stop-instructions", instructionRevision);
  const sections = Object.freeze([
    ...(instructions.length === 0 ? [] : [Object.freeze({
      id: `${event.ref.id}:instructions`,
      source: instructionSource,
      kind: "agent_instruction",
      role: "instruction" as const,
      necessity: "mandatory" as const,
      content: Object.freeze({ kind: "text" as const, text: instructions }),
    })]),
    Object.freeze({
      id: `${event.ref.id}:material`,
      source: source("task_fulfillment_material", event.task.id, event.ref.revision),
      kind: "task_fulfillment_material",
      role: "user" as const,
      necessity: "mandatory" as const,
      content: Object.freeze({
        kind: "model_message" as const,
        message: Object.freeze({
          role: "user" as const,
          content: Object.freeze([Object.freeze({
            kind: "text" as const,
            text: JSON.stringify(material),
          })]),
        }),
      }),
    }),
  ]);
  const composition = composeModelInput({
    id: `${event.ref.id}:task-fulfillment`,
    providerId: provider.modelContext.target.providerId,
    model: provider.modelContext.target.model,
    interaction,
    sections,
    lineage: Object.freeze({
      instructionBinding: source("task_fulfillment_binding", hookRef.id, instructionRevision),
      agent: source("product_hook", hookRef.id, hookRef.revision),
      instructions: instructionSource,
      instructionRelease: source("task_fulfillment_release", hookRef.id, instructionRevision),
      instructionResolver: source("task_fulfillment_resolver", hookRef.id, hookRef.revision),
      instructionContent: instructionSource,
      instructionModel: Object.freeze({
        providerId: provider.modelContext.target.providerId,
        model: provider.modelContext.target.model,
      }),
      instructionBlocks: Object.freeze(instructions.length === 0 ? [] : [instructionSource]),
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
      interactionHistory: event.interaction.messages.length === 0
        ? null
        : source("model_interaction_projection", event.interaction.id, event.interaction.revision),
      protocol: source("task_fulfillment_protocol", hookRef.id, hookRef.revision),
      policy: source("task_fulfillment_policy", hookRef.id, hookRef.revision),
    }),
    composedAt: event.emittedAt,
  });
  const modelInput = modelInputFromComposition(composition);
  const headroom = Object.freeze({
    unit: "tokens" as const,
    amount: 256,
    policy: Object.freeze({ id: "helarc.task-fulfillment-headroom", revision: "1" }),
  });
  const measurement = provider.modelContext.measure(composition, event.emittedAt);
  const assessment = assessModelContext({
    compositionId: composition.id,
    capacity: provider.modelContext.capacity,
    measurement,
    requestedOutput: provider.modelContext.requestedOutput,
    headroom,
    assessedAt: event.emittedAt,
    revision: "helarc.task-fulfillment-context-assessment.v1",
  });
  if (assessment.disposition === "proven_overflow") {
    throw new TypeError("Task Fulfillment model input exceeds the admitted context capacity.");
  }
  return Object.freeze({
    requestId: composition.id,
    purpose: "helarc.task-fulfillment",
    correlation: Object.freeze({
      controllerRequestId: event.controllerRequestId,
      branchId: `${event.run.id}:task-fulfillment`,
    }),
    instructions: modelInput.instructions,
    messages: modelInput.messages,
    interaction: composition.interaction,
    composition,
    modelContext: Object.freeze({
      requestedOutput: provider.modelContext.requestedOutput,
      headroom,
      assessment,
    }),
    continuation: null,
    metadata: Object.freeze({
      runId: event.run.id,
      taskId: event.task.id,
      completionCandidateId: event.candidate.ref.id,
      completionCandidateRevision: event.candidate.ref.revision,
      hookRevision: hookRef.revision,
      stopInstructionsRevision: instructionRevision,
    }),
  });
}

function parseProviderResult(result: ProviderCallResult): HelarcFulfillmentCandidate {
  if (result.kind !== "succeeded") {
    const code = result.kind === "cancelled"
      ? "provider_call_cancelled"
      : result.kind === "failed" || result.kind === "cancellation_unconfirmed"
        ? result.failure.code
        : result.providerCode ?? "continuation_rejected";
    throw new Error(`Provider could not evaluate Task Fulfillment: ${code}.`);
  }
  if (result.response.kind !== "structured_generation") {
    throw new TypeError("Task Fulfillment requires a structured-generation response.");
  }
  return parseCandidate(result.response.output);
}

function parseCandidate(value: ModelJsonValue): HelarcFulfillmentCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Task Fulfillment response must be an object.");
  }
  const record = value as { readonly [key: string]: ModelJsonValue };
  const expected = ["status", "disposition", "rationale", "missingOutcomes", "unsupportedClaims"];
  if (Object.keys(record).some((key) => !expected.includes(key)) ||
      expected.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError("Task Fulfillment response shape is invalid.");
  }
  if (record.status !== "fulfilled" && record.status !== "incomplete" && record.status !== "uncertain") {
    throw new TypeError("Task Fulfillment status is invalid.");
  }
  const missingOutcomes = boundedTextArray(record.missingOutcomes, "missingOutcomes");
  if (record.disposition !== "allow" && record.disposition !== "continue") {
    throw new TypeError("Task Fulfillment Stop disposition is invalid.");
  }
  const unsupportedClaims = boundedTextArray(record.unsupportedClaims, "unsupportedClaims");
  if (record.status === "fulfilled" && (missingOutcomes.length > 0 || unsupportedClaims.length > 0)) {
    throw new TypeError("A fulfilled Task response cannot carry unresolved outcomes or claims.");
  }
  return Object.freeze({
    status: record.status,
    disposition: record.disposition,
    rationale: boundedText(record.rationale, "rationale"),
    missingOutcomes,
    unsupportedClaims,
  });
}

function createAssessment(
  event: AgentStopEvent,
  candidate: HelarcFulfillmentCandidate,
  assessedAt: string,
): HelarcTaskFulfillmentAssessment {
  const findings: HelarcTaskFulfillmentFinding[] = [
    ...candidate.missingOutcomes.map((message) => Object.freeze({
      kind: "missing_outcome" as const,
      code: "task_outcome_missing",
      message,
    })),
    ...candidate.unsupportedClaims.map((message) => Object.freeze({
      kind: "unsupported_claim" as const,
      code: "completion_claim_unsupported",
      message,
    })),
  ];
  if (candidate.status === "incomplete" && findings.length === 0) {
    findings.push(Object.freeze({
      kind: "objective_mismatch",
      code: "task_objective_not_covered",
      message: candidate.rationale,
    }));
  }
  if (candidate.status === "uncertain" && findings.length === 0) {
    findings.push(Object.freeze({
      kind: "uncertainty",
      code: "task_fulfillment_uncertain",
      message: candidate.rationale,
    }));
  }
  return snapshotHelarcTaskFulfillmentAssessment({
    id: `${event.ref.id}:task-fulfillment`,
    revision: event.ref.revision,
    hookRevision: hookRef.revision,
    event: event.ref,
    run: event.run,
    controllerRequestId: event.controllerRequestId,
    task: Object.freeze({ id: event.task.id, kind: event.task.kind }),
    candidate: event.candidate.ref,
    status: candidate.status,
    disposition: candidate.disposition,
    rationale: candidate.rationale,
    findings: Object.freeze(findings),
    feedback: candidate.disposition === "allow" ? null : buildFeedback(candidate, findings),
    assessedAt,
  });
}

function buildFeedback(
  candidate: HelarcFulfillmentCandidate,
  findings: readonly HelarcTaskFulfillmentFinding[],
): string {
  const details = findings.map((finding) => finding.message).join(" ");
  const feedback = `${candidate.rationale} ${details}`.trim();
  return feedback.length <= 4_096 ? feedback : `${feedback.slice(0, 4_093)}...`;
}

function readHelarcTaskObjective(event: AgentStopEvent): string {
  if (event.task.input === null ||
      typeof event.task.input !== "object" ||
      typeof (event.task.input as { prompt?: unknown }).prompt !== "string" ||
      (event.task.input as { prompt: string }).prompt.trim().length === 0) {
    throw new TypeError("Helarc Task Fulfillment requires a Product Task with one prompt objective.");
  }
  return (event.task.input as { prompt: string }).prompt;
}

function boundedText(value: unknown, field: string, maximum = 8_192): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`Task Fulfillment ${field} must be bounded non-empty text.`);
  }
  return value;
}

function boundedTextArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError(`Task Fulfillment ${field} must be a bounded array.`);
  }
  return Object.freeze(value.map((item, index) => boundedText(item, `${field}[${index}]`, 1_024)));
}
