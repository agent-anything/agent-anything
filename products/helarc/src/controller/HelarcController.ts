import type {
  ControllerDecision,
  ControllerInput,
  ControllerModelItem,
} from "@agent-anything/agent-core";
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

export class HelarcControllerParseError extends Error {
  constructor(
    readonly code: HelarcControllerParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HelarcControllerParseError";
  }
}

export function buildHelarcProviderRequest(
  input: ControllerInput<HelarcAgentOutput>,
): ProviderRequest {
  const promptAssembly = buildHelarcPromptAssembly({ controllerInput: input });

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
    },
    messages: [
      { role: "system", content: promptAssembly.systemPrompt, metadata: {} },
      { role: "user", content: promptAssembly.userPrompt, metadata: {} },
    ],
  };
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
    throw new HelarcControllerParseError(
      "controller_output_invalid",
      "Provider output must be a JSON object.",
    );
  }

  const action = readString(value, "action");
  switch (action) {
    case "call_tool":
      return parseCallToolOutput(value);
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
      throw new HelarcControllerParseError(
        "controller_action_invalid",
        "Provider output action is not supported.",
      );
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
    throw new HelarcControllerParseError(
      "controller_output_too_large",
      "Provider output is too large.",
    );
  }

  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new HelarcControllerParseError(
      "controller_output_not_json",
      "Provider output must be valid JSON.",
    );
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

  throw new HelarcControllerParseError(
    "controller_tool_name_unsupported",
    "Tool is not exposed in the active tool catalog.",
  );
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
    throw new HelarcControllerParseError(
      "controller_tool_input_required",
      "input is required.",
    );
  }
  if (!isRecord(value.input)) {
    throw new HelarcControllerParseError(
      "controller_tool_input_invalid",
      "input must be a JSON object.",
    );
  }
  return value.input;
}

function parseChangeIntent(value: unknown): HelarcChangeIntent {
  if (!isRecord(value)) {
    throw new HelarcControllerParseError(
      "controller_change_required",
      "Proposed output requires a change object.",
    );
  }

  const operation = readRequiredString(
    value,
    "operation",
    "controller_change_operation_required",
  );
  if (operation !== "create" && operation !== "update" && operation !== "delete") {
    throw new HelarcControllerParseError(
      "controller_change_operation_invalid",
      "Change operation is not supported.",
    );
  }

  const path = readRequiredString(value, "path", "controller_change_path_required");
  const content = readRawOptionalString(value, "content");
  if ((operation === "create" || operation === "update") && content === undefined) {
    throw new HelarcControllerParseError(
      "controller_change_content_required",
      "Create and update changes require content.",
    );
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
    throw new HelarcControllerParseError(code, `${key} is required.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
