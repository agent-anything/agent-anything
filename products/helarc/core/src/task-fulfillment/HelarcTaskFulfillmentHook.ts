import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createRunLifecycleHookComposition,
  type RunLifecycleHookComposition,
  type StopHookDecision,
  type StopHookHandler,
} from "@agent-anything/agent-runtime/hooks";
import type { StopLifecycleEvent } from "@agent-anything/agent-runtime/lifecycle";
import type {
  ModelJsonValue,
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import { assessModelContext } from "@agent-anything/model-interaction";
import { modelInputFromComposition, composeModelInput } from "@agent-anything/model-interaction/input";
import {
  snapshotHelarcTaskFulfillmentAssessment,
  type HelarcTaskFulfillmentAssessment,
  type HelarcTaskFulfillmentFinding,
  type HelarcTaskFulfillmentStatus,
} from "./HelarcTaskFulfillment.js";

export const HELARC_TASK_FULFILLMENT_HOOK_REVISION =
  "helarc.task-fulfillment-stop-hook.v1";

const hookRef = Object.freeze({
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
    schemaRevision: "1",
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze([
        "status", "rationale", "missingOutcomes", "unsupportedClaims",
      ]),
      properties: Object.freeze({
        status: Object.freeze({
          type: "string",
          enum: Object.freeze(["fulfilled", "incomplete", "uncertain"]),
        }),
        rationale: Object.freeze({ type: "string" }),
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

const instructions = [
  "Evaluate whether the proposed completion and settled trajectory fulfill the original task objective.",
  "Judge the original objective, not a reduced or substituted objective.",
  "An explanation of how to perform requested work is not fulfillment when the task requested actual action.",
  "Use only settled trajectory material as evidence that actions occurred.",
  "Only successful or explicitly usable partial semantic outcomes are positive fulfillment evidence.",
  "A failed, denied, cancelled, timed-out, invalid, unavailable, or unknown-effect result is not evidence that its requested outcome succeeded.",
  "A later attributable successful result may recover an earlier failure; the earlier failure itself must never be reported as success.",
  "Return fulfilled only when every material requested outcome is covered.",
  "Return incomplete when outcomes are missing or the proposal answers a different objective.",
  "Return uncertain when the available material cannot support either conclusion.",
  "Do not infer that a file changed or a command ran from the proposal text alone.",
].join("\n");

export class HelarcTaskFulfillmentHook implements StopHookHandler {
  private readonly assessments: HelarcTaskFulfillmentAssessment[] = [];

  constructor(
    private readonly provider: Provider,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getAssessments(): readonly HelarcTaskFulfillmentAssessment[] {
    return Object.freeze([...this.assessments]);
  }

  async handle(
    event: StopLifecycleEvent,
    interruptionContext: InvocationInterruptionContext,
  ): Promise<StopHookDecision> {
    readHelarcTaskObjective(event);
    const request = buildRequest(this.provider, event);
    const result = await this.provider.send(request, interruptionContext);
    const candidate = parseProviderResult(result);
    const assessment = createAssessment(event, candidate, this.now());
    this.assessments.push(assessment);
    return assessment.status === "fulfilled"
      ? Object.freeze({ kind: "allow" as const })
      : Object.freeze({
          kind: "block" as const,
          code: assessment.status === "incomplete"
            ? "task_fulfillment_incomplete"
            : "task_fulfillment_uncertain",
          reason: assessment.feedback!,
        });
  }
}

export function createHelarcTaskFulfillmentHookComposition(
  provider: Provider,
  now?: () => string,
): Readonly<{
  hook: HelarcTaskFulfillmentHook;
  composition: RunLifecycleHookComposition;
}> {
  const hook = new HelarcTaskFulfillmentHook(provider, now);
  return Object.freeze({
    hook,
    composition: createRunLifecycleHookComposition({
      id: "helarc.lifecycle-hooks",
      revision: HELARC_TASK_FULFILLMENT_HOOK_REVISION,
      registrations: Object.freeze([Object.freeze({
        ref: hookRef,
        owner: Object.freeze({
          owner: "helarc",
          kind: "task_fulfillment",
          id: hookRef.id,
          revision: hookRef.revision,
          run: null,
        }),
        event: "Stop" as const,
        runKinds: Object.freeze(["root" as const, "descendant" as const]),
        handler: handlerRef,
        timeoutMs: 120_000,
        maximumResultBytes: 16_384,
      })]),
      bindings: Object.freeze([Object.freeze({
        ref: handlerRef,
        event: "Stop" as const,
        handler: hook,
      })]),
    }),
  });
}

interface HelarcFulfillmentCandidate {
  readonly status: HelarcTaskFulfillmentStatus;
  readonly rationale: string;
  readonly missingOutcomes: readonly string[];
  readonly unsupportedClaims: readonly string[];
}

function buildRequest(provider: Provider, event: StopLifecycleEvent): ProviderRequest {
  if (!provider.descriptor.capabilities.structuredGeneration.supported) {
    throw new TypeError("Task Fulfillment requires Provider structured generation.");
  }
  const taskObjective = readHelarcTaskObjective(event);
  const material = Object.freeze({
    originalTask: taskObjective,
    completionProposal: event.output,
    settledInteraction: event.interaction.messages,
    unsettledCallCount: event.interaction.unsettledCalls.length,
    settledCallCount: event.interaction.settledCallCount,
    completionBasis: event.basis,
  });
  const source = (kind: string, id: string, revision: string | null) => Object.freeze({
    owner: "helarc",
    kind,
    id,
    revision,
  });
  const sections = Object.freeze([
    Object.freeze({
      id: `${event.ref.id}:instructions`,
      source: source("task_fulfillment_instructions", hookRef.id, hookRef.revision),
      kind: "agent_instruction",
      role: "instruction" as const,
      necessity: "mandatory" as const,
      content: Object.freeze({ kind: "text" as const, text: instructions }),
    }),
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
      instructionBinding: source("task_fulfillment_binding", hookRef.id, hookRef.revision),
      agent: source("product_hook", hookRef.id, hookRef.revision),
      instructions: source("task_fulfillment_instructions", hookRef.id, hookRef.revision),
      instructionRelease: source("task_fulfillment_release", hookRef.id, hookRef.revision),
      instructionResolver: source("task_fulfillment_resolver", hookRef.id, hookRef.revision),
      instructionContent: source("task_fulfillment_content", hookRef.id, hookRef.revision),
      instructionModel: Object.freeze({
        providerId: provider.modelContext.target.providerId,
        model: provider.modelContext.target.model,
      }),
      instructionBlocks: Object.freeze([
        source("task_fulfillment_instructions", hookRef.id, hookRef.revision),
      ]),
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
      controllerRequestId: event.basis.controllerTurn.id,
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
      completionProposalId: event.basis.completionProposal.id,
      completionProposalRevision: event.basis.completionProposal.revision,
      hookRevision: hookRef.revision,
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
  const expected = ["status", "rationale", "missingOutcomes", "unsupportedClaims"];
  if (Object.keys(record).some((key) => !expected.includes(key)) ||
      expected.some((key) => !Object.hasOwn(record, key))) {
    throw new TypeError("Task Fulfillment response shape is invalid.");
  }
  if (record.status !== "fulfilled" && record.status !== "incomplete" && record.status !== "uncertain") {
    throw new TypeError("Task Fulfillment status is invalid.");
  }
  const missingOutcomes = boundedTextArray(record.missingOutcomes, "missingOutcomes");
  const unsupportedClaims = boundedTextArray(record.unsupportedClaims, "unsupportedClaims");
  if (record.status === "fulfilled" && (missingOutcomes.length > 0 || unsupportedClaims.length > 0)) {
    throw new TypeError("A fulfilled Task response cannot carry unresolved outcomes or claims.");
  }
  return Object.freeze({
    status: record.status,
    rationale: boundedText(record.rationale, "rationale"),
    missingOutcomes,
    unsupportedClaims,
  });
}

function createAssessment(
  event: StopLifecycleEvent,
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
    turn: event.basis.controllerTurn,
    task: Object.freeze({ id: event.task.id, kind: event.task.kind }),
    proposal: event.basis.completionProposal,
    status: candidate.status,
    rationale: candidate.rationale,
    findings: Object.freeze(findings),
    feedback: candidate.status === "fulfilled" ? null : buildFeedback(candidate, findings),
    assessedAt,
  });
}

function buildFeedback(
  candidate: HelarcFulfillmentCandidate,
  findings: readonly HelarcTaskFulfillmentFinding[],
): string {
  const prefix = candidate.status === "incomplete"
    ? "The proposed completion does not yet fulfill the original task."
    : "Task fulfillment is uncertain from the settled trajectory.";
  const details = findings.map((finding) => finding.message).join(" ");
  const feedback = `${prefix} ${details} Continue from the original task objective and use settled actions or clarification as needed.`.trim();
  return feedback.length <= 4_096 ? feedback : `${feedback.slice(0, 4_093)}...`;
}

function readHelarcTaskObjective(event: StopLifecycleEvent): string {
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
