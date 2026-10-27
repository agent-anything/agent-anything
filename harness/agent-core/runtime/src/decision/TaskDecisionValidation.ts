import { snapshotProviderFailure } from "@agent-anything/model-interaction";
import type {
ModelAssistantContentBlock,
ModelCallRef,
ModelReasoning,
ModelCallableRequest,
ModelTurnFinish,
ProviderUsage
} from "@agent-anything/model-interaction";
import {
modelCallRefKey,
snapshotModelCallRef,
snapshotModelReasoning,
snapshotModelCallableRequest,
snapshotModelTurn
} from "@agent-anything/model-interaction";
import type {
TaskDecisionProposal,
TaskDecisionInputSources,
TaskDecisionModelItem,
ProgressionCandidate
} from "./TaskDecisionActivity.js";
import {
snapshotConversationOpeningReceipt
} from "./TaskConversation.js";
import { TaskDecisionActivityError,type TaskDecisionActivityFailure,type TaskDecisionActivityFailureCode,type DecisionActivityDeadline } from "./TaskDecisionActivityError.js";
import {
snapshotInputDeliveryReceipt
} from "./DecisionInputDelivery.js";
import {
StructuredOutputError,
type StructuredOutputFailureCategory
} from "./StructuredOutput.js";

export function validateTaskDecisionProposal<TOutput>(
  candidate: TaskDecisionProposal<TOutput>,
  input: TaskDecisionInputSources<TOutput>,
): TaskDecisionProposal<TOutput> {
  if (!isRecord(candidate)) {
    throw decisionContractError("controller_decision_invalid");
  }

  const modelItems = validateModelItems(candidate.modelItems);
  const inputDeliveryReceipt = snapshotInputDeliveryReceipt(candidate.inputDeliveryReceipt, input.inputDelivery);
  const openingReceipt = candidate.openingReceipt == null ? null : snapshotConversationOpeningReceipt(candidate.openingReceipt, input.runId);
  if (openingReceipt && (input.interaction.opening || input.interaction.latestTurn)) throw decisionContractError("conversation_opening_repeated");
  if (inputDeliveryReceipt?.via.kind === "controller" &&
      inputDeliveryReceipt.via.controllerRequestId !== input.toolExposure.controllerRequestId) {
    throw decisionContractError("controller_input_delivery_request_mismatch");
  }
  const modelCalls = new Map(modelItems.flatMap((item) =>
    item.kind === "model_tool_call"
      ? [[modelCallRefKey(item.call.modelCallRef), item.call] as const]
      : []
  ));
  if (modelCalls.size !== modelItems.filter(item => item.kind === "model_tool_call").length) {
    throw decisionContractError("controller_model_call_duplicated");
  }

  switch (candidate.kind) {
    case "propose_completion": {
      if (!isRecord(candidate.completionSource)) {
        throw decisionContractError("controller_completion_source_required");
      }
      let completionSource: import("./TaskDecisionActivity.js").CompletionSource;
      const remainingCalls = new Map(modelCalls);
      if (candidate.completionSource.kind === "model_call") {
        const modelCallRef = snapshotModelCallRef(candidate.completionSource.modelCallRef);
        const key = modelCallRefKey(modelCallRef);
        if (!remainingCalls.has(key)) {
          throw decisionContractError("controller_completion_source_invalid");
        }
        const sourceCandidates = Array.isArray(candidate.candidates)
          ? candidate.candidates.filter(item => isRecord(item) && isRecord(item.modelCallRef) &&
              modelCallRefKey(snapshotModelCallRef(item.modelCallRef as unknown as ModelCallRef)) === key)
          : [];
        if (sourceCandidates.some(item => item.kind !== "state_transition" || item.transition !== "plan_update")) {
          throw decisionContractError("controller_completion_source_candidate_invalid");
        }
        if (sourceCandidates.length === 0) remainingCalls.delete(key);
        completionSource = Object.freeze({ kind: "model_call", modelCallRef });
      } else if (candidate.completionSource.kind === "controller") {
        completionSource = Object.freeze({ kind: "controller" });
      } else {
        throw decisionContractError("controller_completion_source_invalid");
      }
      const candidates = validateCandidates(candidate.candidates, remainingCalls, true);
      let validation;
      try {
        validation = input.agent.output.validate(candidate.output);
      } catch (error) {
        throw invalidOutput(
          "Agent output validation failed.",
          errorMetadata(error),
        );
      }

      if (!validation.valid) {
        throw structuredOutputError(
          "agent_output_contract",
          "agent_output_invalid",
          "Return a final output that satisfies the active Agent output contract.",
        );
      }

      return Object.freeze({
        kind: "propose_completion",
        ...(inputDeliveryReceipt === null ? {} : {inputDeliveryReceipt}),
        ...(openingReceipt === null ? {} : {openingReceipt}),
        candidates,
        completionSource,
        output: validation.output,
        modelItems,
      });
    }

    case "advance": {
      const candidates = validateCandidates(candidate.candidates, modelCalls);
      return Object.freeze({
        kind: "advance",
        ...(inputDeliveryReceipt === null ? {} : {inputDeliveryReceipt}),
        ...(openingReceipt === null ? {} : {openingReceipt}),
        candidates: candidates as readonly [ProgressionCandidate, ...ProgressionCandidate[]],
        modelItems,
      });
    }

    case "continue_with_feedback": {
      if (modelCalls.size !== 0) {
        throw decisionContractError("controller_feedback_with_model_calls");
      }
      return Object.freeze({
        kind: "continue_with_feedback",
        ...(inputDeliveryReceipt === null ? {} : {inputDeliveryReceipt}),
        ...(openingReceipt === null ? {} : {openingReceipt}),
        feedback: snapshotTaskDecisionFeedback(candidate.feedback),
        modelItems,
      });
    }

    default:
      throw decisionContractError("controller_decision_kind_invalid");
  }
}

export function snapshotTaskDecisionFeedback(candidate: unknown): import("./TaskDecisionActivity.js").TaskDecisionFeedback {
  if (!isRecord(candidate) || !isRecord(candidate.source)) {
    throw decisionContractError("controller_feedback_invalid");
  }
  const source = candidate.source;
  return Object.freeze({
    source: Object.freeze({
      owner: nonEmptyDecisionText(source.owner),
      kind: nonEmptyDecisionText(source.kind),
      id: nonEmptyDecisionText(source.id),
      revision: nonEmptyDecisionText(source.revision),
    }),
    code: nonEmptyDecisionText(candidate.code),
    message: boundedDecisionText(candidate.message, 8_192),
  });
}

function validateModelItems(candidate: unknown): readonly TaskDecisionModelItem[] {
  if (!Array.isArray(candidate)) {
    throw decisionContractError("controller_model_items_required");
  }
  if (candidate.length === 0) return Object.freeze([]);

  const ids = new Set<string>();
  const items = candidate.map((item): TaskDecisionModelItem => {
    if (!isRecord(item)) {
      throw decisionContractError("controller_model_item_invalid");
    }

    const id = nonEmptyDecisionText(item.id);
    if (ids.has(id)) {
      throw decisionContractError("controller_model_item_id_duplicated");
    }
    ids.add(id);

    if (!isRecord(item.metadata)) {
      throw decisionContractError("controller_model_item_metadata_invalid");
    }

    const metadata = Object.freeze({ ...item.metadata });
    switch (item.kind) {
      case "assistant_reasoning":
        return Object.freeze({ id, kind: "assistant_reasoning", turnId: nonEmptyDecisionText(item.turnId),
          reasoning: snapshotModelReasoning(item.reasoning as ModelReasoning), metadata });
      case "assistant_text":
        return Object.freeze({
          id,
          kind: "assistant_text",
          turnId: nonEmptyDecisionText(item.turnId),
          contentBlockOrdinal: nonNegativeSafeInteger(
            item.contentBlockOrdinal,
            "controller_model_content_ordinal_invalid",
          ),
          text: boundedDecisionText(item.text, 131_072),
          metadata,
        });
      case "model_tool_call":
        return Object.freeze({
          id,
          kind: "model_tool_call",
          call: snapshotModelCallableRequest(item.call as ModelCallableRequest),
          metadata,
        });
      case "model_turn_finish":
        return Object.freeze({
          id,
          kind: "model_turn_finish",
          turnId: nonEmptyDecisionText(item.turnId),
          finish: item.finish as ModelTurnFinish,
          metadata,
        }) as TaskDecisionModelItem;
      case "model_response_correlation": {
        if (!isRecord(item.response)) {
          throw decisionContractError("controller_model_response_correlation_invalid");
        }
        return Object.freeze({
          id,
          kind: "model_response_correlation",
          turnId: nonEmptyDecisionText(item.turnId),
          response: Object.freeze({
            providerId: nonEmptyDecisionText(item.response.providerId),
            requestId: nonEmptyDecisionText(item.response.requestId),
            responseId: item.response.responseId === null
              ? null
              : nonEmptyDecisionText(item.response.responseId),
          }),
          usage: item.usage as ProviderUsage | null,
          metadata,
        }) as TaskDecisionModelItem;
      }
      default:
        throw decisionContractError("controller_model_item_kind_invalid");
    }
  });
  const finishItems = items.filter((item) => item.kind === "model_turn_finish");
  const correlationItems = items.filter((item) =>
    item.kind === "model_response_correlation"
  );
  if (finishItems.length !== 1 || correlationItems.length !== 1) {
    throw decisionContractError("controller_model_turn_incomplete");
  }
  const finish = finishItems[0]!;
  const correlation = correlationItems[0]!;
  const content: ModelAssistantContentBlock[] = [];
  for (const item of items) {
    if (item.kind === "assistant_text") {
      if (item.contentBlockOrdinal !== content.length) {
        throw decisionContractError("controller_model_content_order_invalid");
      }
      content.push(Object.freeze({ kind: "text", text: item.text }));
    }
    if (item.kind === "model_tool_call") {
      content.push(Object.freeze({ kind: "model_tool_call", call: item.call }));
    }
  }
  const reasoning = items.filter(item => item.kind === "assistant_reasoning");
  if (reasoning.length > 1 || reasoning.some(item => item.turnId !== finish.turnId)) {
    throw decisionContractError("controller_model_reasoning_invalid");
  }
  const turn = snapshotModelTurn({
    turnId: finish.turnId,
    assistant: { role: "assistant", content, ...(reasoning[0] ? { reasoning: reasoning[0].reasoning } : {}) },
    finish: finish.finish,
    usage: correlation.usage,
    responseRef: correlation.response,
  });
  return Object.freeze(items.map((item): TaskDecisionModelItem => {
    if (item.kind === "model_turn_finish") {
      return Object.freeze({ ...item, finish: turn.finish });
    }
    if (item.kind === "model_response_correlation") {
      return Object.freeze({
        ...item,
        response: turn.responseRef,
        usage: turn.usage,
      });
    }
    return item;
  }));
}

function validateCandidates(
  candidate: unknown,
  modelCalls: ReadonlyMap<string, ModelCallableRequest>,
  allowEmpty = false,
): readonly ProgressionCandidate[] {
  if (!Array.isArray(candidate) || (!allowEmpty && candidate.length === 0)) {
    throw decisionContractError("controller_candidates_required");
  }

  const candidates = candidate.map((progression) => {
    if (!isRecord(progression)) {
      throw decisionContractError("controller_candidate_invalid");
    }

    const modelCallRef = progression.modelCallRef === null && progression.kind === "operation_request"
      ? null : snapshotModelCallRef(progression.modelCallRef as ModelCallRef);
    if (modelCallRef !== null && !modelCalls.has(modelCallRefKey(modelCallRef))) {
      throw decisionContractError("controller_candidate_provenance_invalid");
    }
    return validateProgressionCandidate(progression, modelCallRef);
  });

  const candidateCallKeys = candidates.flatMap((item) => item.modelCallRef === null ? [] : [modelCallRefKey(item.modelCallRef)]);
  if (
    new Set(candidateCallKeys).size !== candidateCallKeys.length ||
    candidateCallKeys.length !== modelCalls.size
  ) {
    throw decisionContractError("controller_candidate_call_coverage_invalid");
  }
  const orderedCalls = [...modelCalls.keys()];
  if (candidateCallKeys.some((key, index) => key !== orderedCalls[index])) {
    throw decisionContractError("controller_candidate_call_order_invalid");
  }

  validateCandidateOrdering(candidates);
  return Object.freeze(candidates);
}

function validateProgressionCandidate(
  candidate: Record<string, unknown>,
  modelCallRef: ModelCallRef | null,
): ProgressionCandidate {
  if (candidate.kind === "operation_request") {
    if (candidate.origin !== "controller_protocol") throw decisionContractError("controller_operation_request_invalid");
    return Object.freeze({kind: "operation_request" as const, origin: "controller_protocol" as const,
      operation: validateOperationRevisionRef(candidate.operation), request: candidate.request, modelCallRef});
  }
  if (modelCallRef === null) {
    throw decisionContractError("controller_candidate_provenance_invalid");
  }
  if (candidate.kind === "state_transition") {
    if (candidate.transition === "plan_update") {
      return Object.freeze({
        kind: "state_transition" as const,
        transition: "plan_update" as const,
        input: candidate.input,
        modelCallRef,
      });
    }
    if (candidate.transition === "handoff" && isRecord(candidate.input)) {
      const currentAgent = validateAgentRevisionRef(candidate.input.currentAgent);
      const targetAgent = validateAgentRevisionRef(candidate.input.targetAgent);
      const transferPolicy = candidate.input.transferPolicy;
      if (
        transferPolicy !== "all_context" &&
        transferPolicy !== "bounded_context" &&
        transferPolicy !== "fresh_context"
      ) throw decisionContractError("controller_handoff_transfer_invalid");
      const expectedRunRevision = candidate.input.expectedRunRevision;
      if (!Number.isSafeInteger(expectedRunRevision) || (expectedRunRevision as number) < 0) {
        throw decisionContractError("controller_handoff_revision_invalid");
      }
      return Object.freeze({
        kind: "state_transition" as const,
        transition: "handoff" as const,
        input: Object.freeze({
          expectedRunRevision: expectedRunRevision as number,
          currentAgent,
          targetAgent,
          reason: nonEmptyDecisionText(candidate.input.reason),
          transferPolicy,
          admissionEvidenceRef: nonEmptyDecisionText(candidate.input.admissionEvidenceRef),
        }),
        modelCallRef,
      });
    }
    throw decisionContractError("controller_state_transition_invalid");
  }
  if (candidate.kind === "tool_request" && isRecord(candidate.tool)) {
      const revision = candidate.tool.revision;
      if (revision !== null && typeof revision !== "string") {
        throw decisionContractError("controller_tool_revision_invalid");
      }
      const originValue = candidate.tool.origin;
      if (originValue !== "model" && originValue !== "workflow") {
        throw decisionContractError("controller_tool_origin_invalid");
      }
      const origin: "model" | "workflow" = originValue;
      const controllerRequestId = candidate.tool.controllerRequestId;
      if (
        (origin === "model" && typeof controllerRequestId !== "string") ||
        (origin === "workflow" && controllerRequestId !== null)
      ) {
        throw decisionContractError("controller_tool_provenance_invalid");
      }
      return Object.freeze({
        kind: "tool_request" as const,
        tool: Object.freeze({
          name: nonEmptyDecisionText(candidate.tool.name),
          revision: revision as string | null,
          input: candidate.tool.input,
          origin,
          controllerRequestId: origin === "model"
            ? nonEmptyDecisionText(controllerRequestId)
            : null,
        }),
        modelCallRef,
      });
  }
  if (candidate.kind === "interaction_request") {
    const blockingScope = candidate.blockingScope;
    if (blockingScope !== "none" && blockingScope !== "branch" && blockingScope !== "run") {
      throw decisionContractError("controller_interaction_blocking_scope_invalid");
    }
    const requestVersion = candidate.requestVersion;
    if (!Number.isSafeInteger(requestVersion) || (requestVersion as number) < 1) {
      throw decisionContractError("controller_interaction_version_invalid");
    }
    const expiresAt = candidate.expiresAt;
    if (expiresAt !== null && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
      throw decisionContractError("controller_interaction_expiry_invalid");
    }
    return Object.freeze({
      kind: "interaction_request" as const,
      protocol: validateProtocolRef(candidate.protocol),
      subject: candidate.subject,
      subjectRef: validateSubjectRef(candidate.subjectRef),
      presentation: candidate.presentation,
      blockingScope: blockingScope as "none" | "branch" | "run",
      requestVersion: requestVersion as number,
      expiresAt: expiresAt as string | null,
      modelCallRef,
    });
  }
  if (candidate.kind === "model_call_rejection") {
    return Object.freeze({
      kind: "model_call_rejection" as const,
      name: nonEmptyDecisionText(candidate.name),
      code: nonEmptyDecisionText(candidate.code),
      message: nonEmptyDecisionText(candidate.message),
      modelCallRef,
    });
  }
  throw decisionContractError("controller_candidate_kind_invalid");
}

export function assertModelDecisionProvenance<TOutput>(
  decision: TaskDecisionProposal<TOutput>,
  controllerRequestId: string,
): void {
  if (decision.modelItems.length === 0) {
    throw decisionContractError("controller_model_items_required");
  }
  if (decision.kind === "continue_with_feedback") return;
  for (const candidate of decision.candidates) {
    if (candidate.modelCallRef === null) throw decisionContractError("controller_provider_call_provenance_required");
    if (
      candidate.kind === "tool_request" &&
      (
        candidate.tool.origin !== "model" ||
        candidate.tool.controllerRequestId !== controllerRequestId
      )
    ) {
      throw decisionContractError("controller_provider_tool_provenance_invalid");
    }
  }
}

function validateCandidateOrdering(candidates: readonly ProgressionCandidate[]): void {
  if (candidates.filter((item) => item.kind === "state_transition" && item.transition === "plan_update").length > 1) {
    throw decisionContractError("controller_plan_candidate_duplicated");
  }
  const handoffIndex = candidates.findIndex((item) => item.kind === "state_transition" && item.transition === "handoff");
  const suspendingIndex = candidates.findIndex((item) => item.kind === "interaction_request" && item.blockingScope !== "none");
  if (handoffIndex >= 0 && handoffIndex !== candidates.length - 1) {
    throw decisionContractError("controller_handoff_must_be_last");
  }
  if (suspendingIndex >= 0 && suspendingIndex !== candidates.length - 1) {
    throw decisionContractError("controller_suspending_interaction_must_be_last");
  }
  if (handoffIndex >= 0 && suspendingIndex >= 0) {
    throw decisionContractError("controller_handoff_interaction_conflict");
  }
}

function validateAgentRevisionRef(value: unknown): { readonly id: string; readonly revision: string } {
  if (!isRecord(value)) throw decisionContractError("controller_agent_revision_invalid");
  return Object.freeze({ id: nonEmptyDecisionText(value.id), revision: nonEmptyDecisionText(value.revision) });
}

function validateOperationRevisionRef(value: unknown): import("@agent-anything/operation-catalog/identity").OperationDefinitionRevisionRef {
  if (!isRecord(value) || !isRecord(value.operation)) throw decisionContractError("controller_operation_revision_invalid");
  return Object.freeze({
    operation: Object.freeze({
      namespace: nonEmptyDecisionText(value.operation.namespace),
      name: nonEmptyDecisionText(value.operation.name),
    }),
    revision: nonEmptyDecisionText(value.revision),
  });
}

function validateProtocolRef(value: unknown): import("@agent-anything/interaction/protocol").InteractionProtocolRef {
  if (!isRecord(value)) throw decisionContractError("controller_interaction_protocol_invalid");
  return Object.freeze({
    owner: nonEmptyDecisionText(value.owner),
    kind: nonEmptyDecisionText(value.kind),
    revision: nonEmptyDecisionText(value.revision),
  });
}

function validateSubjectRef(value: unknown): import("@agent-anything/interaction/protocol").InteractionSubjectRef {
  if (!isRecord(value)) throw decisionContractError("controller_interaction_subject_invalid");
  return Object.freeze({
    owner: nonEmptyDecisionText(value.owner),
    kind: nonEmptyDecisionText(value.kind),
    id: nonEmptyDecisionText(value.id),
    revision: nonEmptyDecisionText(value.revision),
  });
}

function nonEmptyDecisionText(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw decisionContractError("controller_text_field_invalid");
  }

  return candidate.trim();
}

function boundedDecisionText(candidate: unknown, maximumLength: number): string {
  if (typeof candidate !== "string" || candidate.length > maximumLength) {
    throw decisionContractError("controller_text_field_invalid");
  }
  return candidate;
}

function nonNegativeSafeInteger(candidate: unknown, code: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw decisionContractError(code);
  }
  return candidate as number;
}

function invalidOutput(
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): TaskDecisionActivityError {
  return createControllerError(
    "model",
    "model_output_invalid",
    message,
    false,
    metadata,
  );
}

function structuredOutputError(
  category: StructuredOutputFailureCategory,
  code: string,
  correctionFeedback: string,
): StructuredOutputError {
  return new StructuredOutputError({ category, code, correctionFeedback });
}

function decisionContractError(code: string): StructuredOutputError {
  return structuredOutputError(
    "structured_output_schema",
    code,
    "Return exactly one decision that satisfies the active Controller output contract.",
  );
}

function createControllerError(
  owner: TaskDecisionActivityFailure["kind"],
  code: TaskDecisionActivityFailureCode,
  message: string,
  retryable: boolean,
  metadata: Readonly<Record<string, unknown>>,
  operationSettlement: "unsettled" | "settled_failure" = "unsettled",
  providerCategory?: string,
  deadline: DecisionActivityDeadline | null = null,
): TaskDecisionActivityError {
  const frozenMetadata = Object.freeze({ ...metadata });
  return new TaskDecisionActivityError(
    owner === "model"
      ? Object.freeze({
          kind: "model" as const,
          failure: Object.freeze({
            code,
            message,
            retryable,
            metadata: frozenMetadata,
          }),
        })
      : Object.freeze({
          kind: "provider" as const,
          failure: Object.freeze({
            ...snapshotProviderFailure({category: providerCategory ?? providerFailureCategory(code), code, message, metadata: frozenMetadata}),
            code,
          }),
        }),
    operationSettlement,
    deadline,
  );
}

function providerFailureCategory(code: TaskDecisionActivityFailureCode): string {
  if (code === "provider_timeout") return "timeout";
  if (code === "provider_cancellation_unconfirmed") return "cancellation";
  if (code === "provider_retry_exhausted") return "retry_exhausted";
  return "provider";
}

function errorMetadata(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) {
    return {};
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  return {
    causeName: error.name,
    causeCode: code,
  };
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}
