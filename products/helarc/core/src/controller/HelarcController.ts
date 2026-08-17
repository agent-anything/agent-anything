import type {
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
  ProgressionCandidate,
} from "@agent-anything/agent-runtime/controller";
import { StructuredOutputError, type ProviderRequestBuildContext, type StructuredOutputFailure } from "@agent-anything/agent-runtime/controller";
import type { ProviderRequest, ProviderResponse } from "@agent-anything/model-interaction";
import {
  composeModelInput,
  providerMessagesFromComposition,
} from "@agent-anything/model-interaction/input";

import {
  buildHelarcPromptAssembly,
  HELARC_ACTION_CONTRACT_VERSION,
  HELARC_MODEL_OUTPUT_RESERVE_BYTES,
  HELARC_PROMPT_ARCHITECTURE_VERSION,
  HELARC_TOOL_CATALOG_VERSION,
} from "../prompt/HelarcPromptAssembly.js";
import { readHelarcToolCatalog } from "../tools/HelarcToolCatalog.js";

export const HELARC_CONTROLLER_CAPABILITY = "helarc.code-agent.turn";
export const HELARC_CONTROLLER_OUTPUT_MAX_LENGTH = 64_000;
export const HELARC_PERMISSION_REQUEST_PROTOCOL = Object.freeze({
  owner: "helarc",
  kind: "permission_request",
  revision: "1",
});

export type HelarcChangeOperationKind = "create" | "update" | "delete";

export interface HelarcChangeIntent {
  operation: HelarcChangeOperationKind;
  path: string;
  content?: string;
}

export type HelarcAgentOutput =
  | { kind: "complete"; summary: string }
  | { kind: "propose"; summary: string; change: HelarcChangeIntent };

export type HelarcProviderStructuredOutput =
  | { action: "call_tool"; reason?: string; toolName: string; input: unknown }
  | {
      action: "request_permissions";
      rootId: string;
      permissions: Record<string, unknown>;
      reason: string;
    }
  | { action: "update_plan"; explanation?: string; plan: unknown }
  | { action: "complete"; summary: string }
  | { action: "propose"; summary: string; change: HelarcChangeIntent }
  | { action: "stop"; reason: string };

export type HelarcControllerParseErrorCode =
  | "controller_output_too_large"
  | "controller_output_not_json"
  | "controller_output_invalid"
  | "controller_action_invalid"
  | "controller_tool_name_required"
  | "controller_tool_input_required"
  | "controller_tool_input_invalid"
  | "controller_tool_name_unsupported"
  | "controller_summary_required"
  | "controller_change_required"
  | "controller_change_operation_required"
  | "controller_change_operation_invalid"
  | "controller_change_path_required"
  | "controller_change_content_required"
  | "controller_stop_reason_required";

export class HelarcControllerParseError extends StructuredOutputError {
  constructor(readonly code: HelarcControllerParseErrorCode) {
    super(helarcStructuredOutputFailure(code));
    this.name = "HelarcControllerParseError";
  }
}

export function buildHelarcProviderRequest(
  input: ControllerInput<HelarcAgentOutput>,
  context: ProviderRequestBuildContext,
): ProviderRequest {
  const correctionMessage = context.correction === null
    ? null
    : buildHelarcCorrectionMessage(context.correction.failure);
  const promptAssembly = buildHelarcPromptAssembly({
    controllerInput: input,
    correctionMessage,
  });
  const composition = composeModelInput({
    id: `${input.runId}:model-input:${input.iteration}:${context.attemptNumber}`,
    providerId: context.inputAccounting.providerId,
    model: context.inputAccounting.model,
    accounting: context.inputAccounting,
    outputReserve: Object.freeze({
      unit: input.contextManifest.budget.unit,
      amount: HELARC_MODEL_OUTPUT_RESERVE_BYTES,
    }),
    contextBudget: Object.freeze({
      unit: input.contextManifest.budget.unit,
      amount: input.contextManifest.budget.maximum,
    }),
    contextProjectedAmount: input.context.accounting.amount,
    sections: promptAssembly.sections,
    lineage: Object.freeze({
      activeContext: Object.freeze({
        owner: "context",
        kind: "active_context",
        id: input.context.activeContext.id,
        revision: String(input.context.activeContext.version),
      }),
      contextProjection: Object.freeze({
        owner: "context",
        kind: "context_projection",
        id: input.context.id,
        revision: String(input.context.activeContext.version),
      }),
      projectionManifest: Object.freeze({
        owner: "context",
        kind: "projection_manifest",
        id: input.contextManifest.id,
        revision: String(input.contextManifest.activeContext.version),
      }),
      toolExposure: Object.freeze({
        owner: "tools",
        kind: "tool_exposure",
        id: input.toolExposure.id,
        revision: input.toolExposure.selectionRevision,
      }),
      protocol: Object.freeze({
        owner: "helarc",
        kind: "action_contract",
        id: HELARC_ACTION_CONTRACT_VERSION,
        revision: HELARC_ACTION_CONTRACT_VERSION,
      }),
      policy: Object.freeze({
        owner: "context",
        kind: "projection_policy",
        id: input.contextManifest.policy.id,
        revision: input.contextManifest.policy.revision,
      }),
    }),
    composedAt: input.context.createdAt,
  });

  return {
    capability: HELARC_CONTROLLER_CAPABILITY,
    metadata: {
      runId: input.runId,
      controllerIteration: input.iteration,
      taskId: input.task.id,
      taskKind: input.task.kind,
      promptArchitectureVersion: promptAssembly.versions.promptArchitectureVersion,
      actionContractVersion: promptAssembly.versions.actionContractVersion,
      toolCatalogVersion: promptAssembly.versions.toolCatalogVersion,
      exposedToolNames: promptAssembly.exposedToolNames,
      promptSectionIds: promptAssembly.promptSections.map((section) => section.id),
      modelInputCompositionId: composition.id,
      contextProjectionId: input.context.id,
      contextManifestId: input.contextManifest.id,
      structuredOutputAttemptNumber: context.attemptNumber,
      ...(context.correction === null ? {} : {
        structuredOutputCorrectionCategory: context.correction.failure.category,
        structuredOutputCorrectionCode: context.correction.failure.code,
      }),
    },
    messages: providerMessagesFromComposition(composition.sections).map((message) =>
      message.metadata.modelInputSectionId === "helarc:model-input:structured_output_correction"
        ? Object.freeze({
            ...message,
            metadata: Object.freeze({
              ...message.metadata,
              kind: "structured-output-correction",
            }),
          })
        : message
    ),
    composition,
  };
}

function helarcStructuredOutputFailure(
  code: HelarcControllerParseErrorCode,
): StructuredOutputFailure {
  switch (code) {
    case "controller_output_not_json":
      return {
        category: "structured_output_syntax",
        code,
        correctionFeedback: "Return one valid JSON object without markdown or surrounding text.",
      };
    case "controller_output_too_large":
      return {
        category: "structured_output_size",
        code,
        correctionFeedback: "Return a shorter JSON object within the configured output limit.",
      };
    case "controller_tool_name_unsupported":
      return {
        category: "structured_output_semantic",
        code,
        correctionFeedback: "Use only a Tool exposed in the active Tool catalog.",
      };
    default:
      return {
        category: "structured_output_schema",
        code,
        correctionFeedback: "Return one JSON object that satisfies the active Helarc action contract.",
      };
  }
}

function buildHelarcCorrectionMessage(failure: StructuredOutputFailure): string {
  return [
    "Correct the previous response.",
    `Issue category: ${failure.category}`,
    `Issue code: ${failure.code}`,
    failure.correctionFeedback,
    "Return only the corrected JSON object.",
  ].join("\n");
}

export function parseHelarcProviderResponse(
  response: ProviderResponse,
  input: ControllerInput<HelarcAgentOutput>,
): ControllerDecision<HelarcAgentOutput> {
  const output = parseStructuredOutput(response.output);
  const modelItem = createModelItem(output, input);
  const modelItems = Object.freeze([modelItem]) as readonly [ControllerModelItem];

  switch (output.action) {
    case "call_tool":
      assertToolNameSupported(output.toolName, input);
      return Object.freeze({
        kind: "advance",
        candidates: oneCandidate(Object.freeze({
          kind: "operation_request" as const,
          origin: "tool_request" as const,
          tool: Object.freeze({
            name: output.toolName,
            revision: null,
            input: output.input,
            origin: "model" as const,
            controllerRequestId: input.toolExposure.controllerRequestId,
          }),
          modelItemId: modelItem.id,
        })),
        modelItems,
      });

    case "request_permissions":
      return Object.freeze({
        kind: "advance",
        candidates: oneCandidate(Object.freeze({
          kind: "interaction_request" as const,
          protocol: HELARC_PERMISSION_REQUEST_PROTOCOL,
          subject: Object.freeze({
            runId: input.runId,
            rootId: output.rootId,
            permissions: output.permissions,
            reason: output.reason,
          }),
          subjectRef: Object.freeze({
            owner: "helarc",
            kind: "permission_request",
            id: `${input.runId}:permission:${input.iteration}`,
            revision: "1",
          }),
          presentation: Object.freeze({
            rootId: output.rootId,
            permissions: output.permissions,
            reason: output.reason,
          }),
          requestVersion: 1,
          expiresAt: null,
          blockingScope: "run" as const,
          modelItemId: modelItem.id,
        })),
        modelItems,
      });

    case "update_plan":
      return Object.freeze({
        kind: "advance",
        candidates: oneCandidate(Object.freeze({
          kind: "state_transition" as const,
          transition: "plan_update" as const,
          input: Object.freeze({
            ...(output.explanation === undefined
              ? {}
              : { explanation: output.explanation }),
            plan: output.plan,
          }),
          modelItemId: modelItem.id,
        })),
        modelItems,
      });

    case "stop":
      return Object.freeze({ kind: "propose_stop", reason: output.reason, modelItems });

    case "complete":
      return Object.freeze({
        kind: "propose_completion",
        output: Object.freeze({ kind: "complete", summary: output.summary }),
        modelItems,
      });

    case "propose":
      return Object.freeze({
        kind: "propose_completion",
        output: Object.freeze({
          kind: "propose",
          summary: output.summary,
          change: Object.freeze({ ...output.change }),
        }),
        modelItems,
      });
  }
}

export function parseStructuredOutput(output: unknown): HelarcProviderStructuredOutput {
  const value = normalizeProviderOutput(output);
  if (!isRecord(value)) {
    throw new HelarcControllerParseError("controller_output_invalid");
  }

  const action = readString(value, "action");
  switch (action) {
    case "call_tool":
      return parseCallToolOutput(value);
    case "request_permissions":
      return {
        action,
        rootId: readRequiredString(
          value,
          "rootId",
          "controller_tool_input_invalid",
        ),
        permissions: readRequiredRecord(
          value,
          "permissions",
          "controller_tool_input_invalid",
        ),
        reason: readRequiredString(
          value,
          "reason",
          "controller_tool_input_invalid",
        ),
      };
    case "update_plan":
      return {
        action,
        explanation: readOptionalString(value, "explanation"),
        plan: value.plan,
      };
    case "complete":
      return {
        action,
        summary: readRequiredString(value, "summary", "controller_summary_required"),
      };
    case "propose":
      return {
        action,
        summary: readRequiredString(value, "summary", "controller_summary_required"),
        change: parseChangeIntent(value.change),
      };
    case "stop":
      return {
        action,
        reason: readRequiredString(value, "reason", "controller_stop_reason_required"),
      };
    default:
      throw new HelarcControllerParseError("controller_action_invalid");
  }
}

function createModelItem(
  output: HelarcProviderStructuredOutput,
  input: ControllerInput<HelarcAgentOutput>,
): ControllerModelItem {
  return Object.freeze({
    id: `${input.runId}:model:${input.iteration}`,
    kind: "assistant_action",
    content: output,
    metadata: Object.freeze(createControllerTraceMetadata(output, input)),
  });
}

function normalizeProviderOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    return output;
  }
  if (output.length > HELARC_CONTROLLER_OUTPUT_MAX_LENGTH) {
    throw new HelarcControllerParseError("controller_output_too_large");
  }

  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new HelarcControllerParseError("controller_output_not_json");
  }
}

function parseCallToolOutput(value: Record<string, unknown>): HelarcProviderStructuredOutput {
  return {
    action: "call_tool",
    toolName: readRequiredString(value, "toolName", "controller_tool_name_required"),
    input: readRequiredToolInput(value),
    reason: readOptionalString(value, "reason"),
  };
}

function assertToolNameSupported(
  toolName: string,
  input: ControllerInput<HelarcAgentOutput>,
): void {
  if (readHelarcToolCatalog(input).tools.some((tool) => tool.name === toolName)) {
    return;
  }

  throw new HelarcControllerParseError("controller_tool_name_unsupported");
}

function createControllerTraceMetadata(
  output: HelarcProviderStructuredOutput,
  input: ControllerInput<HelarcAgentOutput>,
): Readonly<Record<string, unknown>> {
  const toolCatalog = readHelarcToolCatalog(input);
  const metadata: Record<string, unknown> = {
    source: "helarc-controller",
    controllerAction: output.action,
    promptArchitectureVersion: HELARC_PROMPT_ARCHITECTURE_VERSION,
    actionContractVersion: HELARC_ACTION_CONTRACT_VERSION,
    toolCatalogVersion: HELARC_TOOL_CATALOG_VERSION,
    exposedToolNames: toolCatalog.tools.map((tool) => tool.name),
  };

  if (output.action === "call_tool") {
    metadata.requestedToolName = output.toolName;
  }
  if (output.action === "propose") {
    metadata.patchOperation = output.change.operation;
    metadata.patchPath = output.change.path;
  }

  return Object.freeze(metadata);
}

function readRequiredToolInput(value: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(value, "input")) {
    throw new HelarcControllerParseError("controller_tool_input_required");
  }
  if (!isRecord(value.input)) {
    throw new HelarcControllerParseError("controller_tool_input_invalid");
  }
  return value.input;
}

function parseChangeIntent(value: unknown): HelarcChangeIntent {
  if (!isRecord(value)) {
    throw new HelarcControllerParseError("controller_change_required");
  }

  const operation = readRequiredString(
    value,
    "operation",
    "controller_change_operation_required",
  );
  if (operation !== "create" && operation !== "update" && operation !== "delete") {
    throw new HelarcControllerParseError("controller_change_operation_invalid");
  }

  const path = readRequiredString(value, "path", "controller_change_path_required");
  const content = readRawOptionalString(value, "content");
  if ((operation === "create" || operation === "update") && content === undefined) {
    throw new HelarcControllerParseError("controller_change_content_required");
  }

  return content === undefined ? { operation, path } : { operation, path, content };
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = readString(value, key)?.trim();
  return field && field.length > 0 ? field : undefined;
}

function readRawOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  code: HelarcControllerParseErrorCode,
): string {
  const field = readOptionalString(value, key);
  if (!field) {
    throw new HelarcControllerParseError(code);
  }
  return field;
}

function readRequiredRecord(
  value: Record<string, unknown>,
  key: string,
  code: HelarcControllerParseErrorCode,
): Record<string, unknown> {
  const field = value[key];
  if (!isRecord(field)) {
    throw new HelarcControllerParseError(code);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneCandidate<T extends ProgressionCandidate>(candidate: T): readonly [T] {
  return Object.freeze([candidate]) as readonly [T];
}
