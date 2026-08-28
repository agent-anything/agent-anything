import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import {
  createTaskFulfillmentFailure,
  snapshotTaskFulfillmentEvaluationInput,
  type TaskFulfillmentAssessment,
  type TaskFulfillmentEvaluationInput,
  type TaskFulfillmentEvaluationResult,
  type TaskFulfillmentEvaluatorPort,
  type TaskFulfillmentFinding,
  type TaskFulfillmentStatus,
} from "@agent-anything/agent-runtime/completion";
import type {
  ModelJsonValue,
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import { modelInputFromComposition, composeModelInput } from "@agent-anything/model-interaction/input";

export const HELARC_TASK_FULFILLMENT_EVALUATOR_REVISION =
  "helarc.task-fulfillment-evaluator.v1";

const evaluatorRef = Object.freeze({
  owner: "helarc",
  id: "helarc-task-fulfillment",
  revision: HELARC_TASK_FULFILLMENT_EVALUATOR_REVISION,
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

const instructions = Object.freeze({
  content: Object.freeze([Object.freeze({
    kind: "text" as const,
    text: [
      "Evaluate whether the proposed completion and settled trajectory fulfill the original task objective.",
      "Judge the original objective, not a reduced or substituted objective.",
      "An explanation of how to perform requested work is not fulfillment when the task requested actual action.",
      "Use only settled trajectory material as evidence that actions occurred.",
      "Return fulfilled only when every material requested outcome is covered.",
      "Return incomplete when outcomes are missing or the proposal answers a different objective.",
      "Return uncertain when the available material cannot support either conclusion.",
      "Do not infer that a file changed or a command ran from the proposal text alone.",
    ].join("\n"),
  })]),
});

export class HelarcTaskFulfillmentEvaluator implements TaskFulfillmentEvaluatorPort {
  readonly ref = evaluatorRef;

  constructor(
    private readonly provider: Provider,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async evaluate(
    candidate: TaskFulfillmentEvaluationInput,
    interruptionContext: InvocationInterruptionContext,
  ): Promise<TaskFulfillmentEvaluationResult> {
    let input: TaskFulfillmentEvaluationInput;
    try {
      input = snapshotTaskFulfillmentEvaluationInput(candidate);
      readHelarcTaskObjective(input.task);
    } catch (error) {
      return failed("task_fulfillment_input_invalid", error, false);
    }

    let request: ProviderRequest;
    try {
      request = buildRequest(this.provider, input);
    } catch (error) {
      return failed("task_fulfillment_request_invalid", error, false);
    }

    let result: ProviderCallResult;
    try {
      result = await this.provider.send(request, interruptionContext);
    } catch (error) {
      return failed("task_fulfillment_provider_failed", error, true);
    }
    if (result.kind === "cancelled") {
      return Object.freeze({ kind: "cancelled", cancellation: result.cancellation });
    }
    if (result.kind !== "succeeded") {
      const code = result.kind === "failed" || result.kind === "cancellation_unconfirmed"
        ? result.failure.code
        : result.providerCode ?? "continuation_rejected";
      return failed(
        "task_fulfillment_provider_failed",
        new Error(`Provider could not evaluate Task Fulfillment: ${code}.`),
        result.kind === "failed" && result.failure.category === "transient",
        Object.freeze({ providerCode: code, resultKind: result.kind }),
      );
    }
    if (result.response.kind !== "structured_generation") {
      return failed(
        "task_fulfillment_response_kind_invalid",
        new Error("Task Fulfillment requires a structured-generation response."),
        false,
      );
    }

    let candidateOutput: HelarcFulfillmentCandidate;
    try {
      candidateOutput = parseCandidate(result.response.output);
    } catch (error) {
      return failed("task_fulfillment_response_invalid", error, false);
    }
    return Object.freeze({
      kind: "assessed",
      assessment: createAssessment(input, candidateOutput, this.now()),
    });
  }
}

interface HelarcFulfillmentCandidate {
  readonly status: TaskFulfillmentStatus;
  readonly rationale: string;
  readonly missingOutcomes: readonly string[];
  readonly unsupportedClaims: readonly string[];
}

function buildRequest(provider: Provider, input: TaskFulfillmentEvaluationInput): ProviderRequest {
  const capability = provider.inputAccounting.capability;
  if (!capability.supported) {
    throw new TypeError("Task Fulfillment requires Provider model-input accounting.");
  }
  if (!provider.descriptor.capabilities.structuredGeneration.supported) {
    throw new TypeError("Task Fulfillment requires Provider structured generation.");
  }
  const taskObjective = readHelarcTaskObjective(input.task);
  const material = Object.freeze({
    originalTask: taskObjective,
    completionProposal: input.output,
    settledInteraction: input.interaction.messages,
    unsettledCallCount: input.interaction.unsettledCalls.length,
    settledCallCount: input.interaction.settledCallCount,
    verification: input.verification,
  });
  const source = (kind: string, id: string, revision: string | null) => Object.freeze({
    owner: "helarc",
    kind,
    id,
    revision,
  });
  const sections = Object.freeze([
    Object.freeze({
      id: `${input.assessment.id}:instructions`,
      source: source("task_fulfillment_instructions", evaluatorRef.id, evaluatorRef.revision),
      kind: "agent_instruction",
      role: "instruction" as const,
      necessity: "mandatory" as const,
      content: Object.freeze({ kind: "text" as const, text: instructions.content[0]!.text }),
    }),
    Object.freeze({
      id: `${input.assessment.id}:material`,
      source: source("task_fulfillment_material", input.objective.id, input.objective.revision),
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
  const unit = capability.limit.unit;
  const outputReserveAmount = Math.max(1, Math.min(
    unit === "tokens" ? 1_024 : 4_096,
    Math.floor(capability.limit.maximum / 4),
  ));
  const composition = composeModelInput({
    id: `${input.assessment.id}:model-input`,
    providerId: provider.inputAccounting.providerId,
    model: provider.inputAccounting.model,
    accounting: provider.inputAccounting,
    outputReserve: Object.freeze({ unit, amount: outputReserveAmount }),
    interaction,
    contextBudget: Object.freeze({ unit, amount: 0 }),
    contextProjectedAmount: 0,
    sections,
    lineage: Object.freeze({
      instructionBinding: source("task_fulfillment_binding", evaluatorRef.id, evaluatorRef.revision),
      agent: source("product_evaluator", evaluatorRef.id, evaluatorRef.revision),
      instructions: source("task_fulfillment_instructions", evaluatorRef.id, evaluatorRef.revision),
      instructionRelease: source("task_fulfillment_release", evaluatorRef.id, evaluatorRef.revision),
      instructionResolver: source("task_fulfillment_resolver", evaluatorRef.id, evaluatorRef.revision),
      instructionContent: source("task_fulfillment_content", evaluatorRef.id, evaluatorRef.revision),
      instructionModel: Object.freeze({
        providerId: provider.inputAccounting.providerId,
        model: provider.inputAccounting.model,
      }),
      instructionBlocks: Object.freeze([
        source("task_fulfillment_instructions", evaluatorRef.id, evaluatorRef.revision),
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
      interactionHistory: input.interaction.messages.length === 0
        ? null
        : source("model_interaction_projection", input.interaction.id, input.interaction.revision),
      protocol: source("task_fulfillment_protocol", evaluatorRef.id, evaluatorRef.revision),
      policy: source("task_fulfillment_policy", evaluatorRef.id, evaluatorRef.revision),
    }),
    composedAt: input.requestedAt,
  });
  const modelInput = modelInputFromComposition(composition);
  return Object.freeze({
    requestId: composition.id,
    purpose: "helarc.task-fulfillment",
    correlation: Object.freeze({
      controllerRequestId: input.turn.id,
      branchId: `${input.run.id}:task-fulfillment`,
    }),
    instructions: modelInput.instructions,
    messages: modelInput.messages,
    interaction: composition.interaction,
    composition,
    continuation: null,
    metadata: Object.freeze({
      runId: input.run.id,
      taskId: input.objective.id,
      taskObjectiveRevision: input.objective.revision,
      completionProposalId: input.proposal.id,
      completionProposalRevision: input.proposal.revision,
      evaluatorRevision: evaluatorRef.revision,
    }),
  });
}

function parseCandidate(value: ModelJsonValue): HelarcFulfillmentCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Task Fulfillment response must be an object.");
  }
  const record = value as { readonly [key: string]: ModelJsonValue };
  const keys = Object.keys(record);
  const expected = ["status", "rationale", "missingOutcomes", "unsupportedClaims"];
  const unknown = keys.filter((key) => !expected.includes(key));
  if (unknown.length > 0 || expected.some((key) => !keys.includes(key))) {
    throw new TypeError("Task Fulfillment response shape is invalid.");
  }
  if (!["fulfilled", "incomplete", "uncertain"].includes(record.status as string)) {
    throw new TypeError("Task Fulfillment status is invalid.");
  }
  const status = record.status as TaskFulfillmentStatus;
  const missingOutcomes = boundedTextArray(record.missingOutcomes, "missingOutcomes");
  const unsupportedClaims = boundedTextArray(record.unsupportedClaims, "unsupportedClaims");
  if (status === "fulfilled" && (missingOutcomes.length > 0 || unsupportedClaims.length > 0)) {
    throw new TypeError("A fulfilled Task response cannot carry unresolved outcomes or claims.");
  }
  return Object.freeze({
    status,
    rationale: boundedText(record.rationale, "rationale"),
    missingOutcomes,
    unsupportedClaims,
  });
}

function createAssessment(
  input: TaskFulfillmentEvaluationInput,
  candidate: HelarcFulfillmentCandidate,
  assessedAt: string,
): TaskFulfillmentAssessment {
  const findings: TaskFulfillmentFinding[] = [
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
  return Object.freeze({
    ref: input.assessment,
    evaluator: evaluatorRef,
    run: input.run,
    turn: input.turn,
    objective: input.objective,
    proposal: input.proposal,
    status: candidate.status,
    rationale: candidate.rationale,
    findings: Object.freeze(findings),
    feedback: candidate.status === "fulfilled"
      ? null
      : buildFeedback(candidate, findings),
    assessedAt,
  });
}

function buildFeedback(
  candidate: HelarcFulfillmentCandidate,
  findings: readonly TaskFulfillmentFinding[],
): string {
  const prefix = candidate.status === "incomplete"
    ? "The proposed completion does not yet fulfill the original task."
    : "Task fulfillment is uncertain from the settled trajectory.";
  const details = findings.map((finding) => finding.message).join(" ");
  const feedback = `${prefix} ${details} Continue from the original task objective and use settled actions or clarification as needed.`.trim();
  return feedback.length <= 8_192 ? feedback : `${feedback.slice(0, 8_189)}...`;
}

function readHelarcTaskObjective(task: TaskFulfillmentEvaluationInput["task"]): string {
  if (task.input === null ||
      typeof task.input !== "object" ||
      typeof (task.input as { prompt?: unknown }).prompt !== "string" ||
      (task.input as { prompt: string }).prompt.trim().length === 0) {
    throw new TypeError("Helarc Task Fulfillment requires a Product Task with one prompt objective.");
  }
  return (task.input as { prompt: string }).prompt;
}

function failed(
  code: string,
  error: unknown,
  retryable: boolean,
  metadata: Readonly<Record<string, unknown>> = Object.freeze({}),
): TaskFulfillmentEvaluationResult {
  return Object.freeze({
    kind: "failed",
    failure: createTaskFulfillmentFailure({
      code,
      message: error instanceof Error ? error.message : "Task Fulfillment evaluation failed.",
      retryable,
      metadata,
    }),
  });
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
