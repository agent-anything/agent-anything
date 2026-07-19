import type {
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
} from "@agent-anything/agent-core";
import {
  StructuredOutputError,
  type ProviderRequestBuildContext,
  type StructuredOutputFailure,
} from "@agent-anything/agent-runtime";
import type { ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import type { Metadata } from "@agent-anything/shared";
import {
  buildHelarcPromptAssembly,
  HELARC_ACTION_CONTRACT_VERSION,
  HELARC_PROMPT_ARCHITECTURE_VERSION,
  HELARC_TOOL_CATALOG_VERSION,
} from "./HelarcPromptAssembly.js";
import { readHelarcToolCatalog } from "./HelarcToolCatalog.js";

export const HELARC_CONTROLLER_CAPABILITY = "helarc.code-agent.turn";
export const HELARC_CONTROLLER_OUTPUT_MAX_LENGTH = 64_000;

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
  const promptAssembly = buildHelarcPromptAssembly({ controllerInput: input });
  const correctionMessage = context.correction === null
    ? null
    : buildHelarcCorrectionMessage(context.correction.failure);

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
      promptSectionIds: promptAssembly.systemSections.map((section) => section.id),
      structuredOutputAttemptNumber: context.attemptNumber,
      ...(context.correction === null ? {} : {
        structuredOutputCorrectionCategory: context.correction.failure.category,
        structuredOutputCorrectionCode: context.correction.failure.code,
      }),
    },
    messages: [
      { role: "system", content: promptAssembly.systemPrompt, metadata: {} },
      { role: "user", content: promptAssembly.userPrompt, metadata: {} },
      ...(correctionMessage === null ? [] : [{
        role: "user" as const,
        content: correctionMessage,
        metadata: { kind: "structured-output-correction" },
      }]),
    ],
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
        kind: "actions",
        actions: Object.freeze([Object.freeze({
          kind: "tool" as const,
          name: output.toolName,
          input: output.input,
          modelItemId: modelItem.id,
        })]) as readonly [{
          readonly kind: "tool";
          readonly name: string;
          readonly input: unknown;
          readonly modelItemId: string;
        }],
        modelItems,
      });

    case "request_permissions":
      return Object.freeze({
        kind: "actions",
        actions: Object.freeze([Object.freeze({
          kind: "permission_request" as const,
          name: "request_permissions" as const,
          input: Object.freeze({
            rootId: output.rootId,
            permissions: output.permissions,
            reason: output.reason,
          }),
          modelItemId: modelItem.id,
        })]) as readonly [{
          readonly kind: "permission_request";
          readonly name: "request_permissions";
          readonly input: unknown;
          readonly modelItemId: string;
        }],
        modelItems,
      });

    case "update_plan":
      return Object.freeze({
        kind: "actions",
        actions: Object.freeze([Object.freeze({
          kind: "internal" as const,
          name: "update_plan",
          input: Object.freeze({
            ...(output.explanation === undefined
              ? {}
              : { explanation: output.explanation }),
            plan: output.plan,
          }),
          modelItemId: modelItem.id,
        })]) as readonly [{
          readonly kind: "internal";
          readonly name: "update_plan";
          readonly input: unknown;
          readonly modelItemId: string;
        }],
        modelItems,
      });

    case "stop":
      return Object.freeze({ kind: "stop", reason: output.reason, modelItems });

    case "complete":
      return Object.freeze({
        kind: "final_output",
        output: Object.freeze({ kind: "complete", summary: output.summary }),
        modelItems,
      });

    case "propose":
      return Object.freeze({
        kind: "final_output",
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
): Metadata {
  const toolCatalog = readHelarcToolCatalog(input);
  const metadata: Metadata = {
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

  return metadata;
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
