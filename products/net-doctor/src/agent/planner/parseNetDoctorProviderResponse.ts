import type {
  PlanStep,
  PlannerInput,
  ProviderResponse,
  ToolCall,
} from "@agent-anything/platform";
import { isNetDoctorToolName } from "./netDoctorPlannerPrompt.js";

export function parseNetDoctorProviderResponse(
  response: ProviderResponse,
  input: PlannerInput,
): PlanStep {
  const output = parseOutput(response.output);

  switch (output.kind) {
    case "callTool":
      return createCallToolPlanStep(output, input);
    case "final":
      return {
        id: readString(output.id) ?? createPlanStepId(input, "final"),
        kind: "final",
        finalOutput: output.finalOutput ?? null,
        reason: readString(output.reason) ?? "Provider returned final diagnosis.",
        metadata: {
          product: "net-doctor",
          providerMetadata: response.metadata,
        },
      };
    case "stop":
      return {
        id: readString(output.id) ?? createPlanStepId(input, "stop"),
        kind: "stop",
        stopReason: readString(output.stopReason) ?? "Provider requested stop.",
        reason: readString(output.reason) ?? "Provider requested stop.",
        metadata: {
          product: "net-doctor",
          providerMetadata: response.metadata,
        },
      };
    default:
      throw new Error("Provider output kind is not supported by NetDoctor planner.");
  }
}

function createCallToolPlanStep(
  output: Record<string, unknown>,
  input: PlannerInput,
): PlanStep {
  const toolName = readString(output.toolName);
  if (toolName === null) {
    throw new Error("Provider callTool output must include toolName.");
  }

  if (!isNetDoctorToolName(toolName)) {
    throw new Error(`Provider selected unknown NetDoctor tool '${toolName}'.`);
  }

  const toolCall = findPlannedToolCall(input, toolName);
  if (!toolCall) {
    throw new Error(`Task does not contain tool call '${toolName}'.`);
  }

  return {
    id: readString(output.id) ?? createPlanStepId(input, toolName),
    kind: "callTool",
    toolCall,
    reason: readString(output.reason) ?? `Provider selected ${toolName}.`,
    metadata: {
      product: "net-doctor",
      providerToolName: toolName,
    },
  };
}

function parseOutput(output: unknown): Record<string, unknown> {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      throw new Error("Provider output was not valid JSON.");
    }
  }

  if (isRecord(output)) {
    return output;
  }

  throw new Error("Provider output must be a structured object.");
}

function findPlannedToolCall(
  input: PlannerInput,
  toolName: string,
): ToolCall | undefined {
  if (!isRecord(input.task.input) || !Array.isArray(input.task.input.toolCalls)) {
    return undefined;
  }

  return input.task.input.toolCalls
    .filter(isToolCall)
    .find((toolCall) => toolCall.toolName === toolName);
}

function createPlanStepId(input: PlannerInput, suffix: string): string {
  return `plan_step_${input.task.id}_${suffix.replaceAll(".", "_")}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value) && typeof value.toolName === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
