import { createHash } from "node:crypto";
import type { PlanLimits } from "@agent-anything/agent-runtime/plan";
import {
  snapshotModelCallableDefinitions,
  type ModelCallableDefinition,
  type ModelJsonSchema,
} from "@agent-anything/model-interaction";

export type HelarcControllerControlName = "update_plan" | "final_result";

export interface HelarcControllerControlGuidanceEntry {
  readonly name: HelarcControllerControlName;
  readonly modelDescription: string;
}

export interface HelarcControllerControlGuidance {
  readonly id: "helarc.controller-control-guidance";
  readonly revision: string;
  readonly entries: readonly HelarcControllerControlGuidanceEntry[];
}

const ENTRIES = Object.freeze([
  Object.freeze({
    name: "update_plan" as const,
    modelDescription: [
      "Create or replace the current Run Plan when an explicit multi-step representation materially improves coordination, progress tracking, or recovery.",
      "A Plan is optional and may be created or revised at any turn; do not create one for a simple direct task.",
      "Every call replaces the complete visible Plan, so retain still-relevant steps, mark established work completed, keep future work pending, and use at most one in_progress step.",
      "Once a Plan exists, update it promptly after a step's outcome is established, when work moves to another step, or when the scope or approach changes.",
      "When ending, submit the complete final Plan snapshot inside final_result instead of calling update_plan separately in that turn. The snapshot is applied before the ending proposal is considered.",
      "Keep still-relevant unfinished work visible and use explanation to describe unresolved or changed work. Never mark unfinished steps completed merely because the Run is ending.",
      "Do not create a Plan solely to close the Run or repeat an unchanged update.",
      "The Plan records intended progression but grants no Tool, Permission, or execution authority and does not prove that a step succeeded.",
    ].join(" "),
  }),
  Object.freeze({
    name: "final_result" as const,
    modelDescription: [
      "Submit your final user-facing response and propose ending this Run normally.",
      "The response may be an answer, partial result, limitation, or refusal; ending does not assert that the user's objective was achieved.",
      "Use this control when no further model turn is needed. Ordinary assistant text is commentary, not an ending signal.",
      "Call final_result at most once per turn, with the complete response string; an empty response is valid.",
      "If a Plan already exists, include its complete final snapshot in plan, even when unchanged. Report actual step progress; pending or in_progress steps do not prevent ending. Never mark unfinished work completed merely to end the Run.",
      "Without an existing Plan, plan is optional; do not create one solely to end. Do not call update_plan in the same turn as final_result; put the final snapshot in this call instead.",
      "Other Tool calls may accompany it. Their requests and the embedded Plan update are processed before ending; failed or unresolved work may return feedback instead of accepting the ending proposal.",
      "Do not claim results of accompanying calls that have not yet been observed. If their results are needed to form your response, wait for them before submitting final_result.",
    ].join(" "),
  }),
]);

export const HELARC_CONTROLLER_CONTROL_GUIDANCE = createGuidance();

export function createHelarcControllerControlDefinitions(
  guidance: HelarcControllerControlGuidance,
  limits: PlanLimits,
  hasPlan: boolean,
): readonly ModelCallableDefinition[] {
  assertPlanLimits(limits);
  const byName = new Map(guidance.entries.map((entry) => [entry.name, entry]));
  if (byName.size !== 2 || !byName.has("update_plan") || !byName.has("final_result")) {
    throw new TypeError("Helarc Controller Control Guidance must completely define update_plan and final_result.");
  }
  return snapshotModelCallableDefinitions([
    {
      name: "final_result",
      description: byName.get("final_result")!.modelDescription,
      inputSchema: {
        type: "object",
        properties: {
          response: {type: "string", description: "Complete user-facing final response, including any limitations. May be empty."},
          plan: createPlanSchema(limits),
        },
        required: hasPlan ? ["response", "plan"] : ["response"],
        additionalProperties: false,
      },
    },
    {
      name: "update_plan",
      description: byName.get("update_plan")!.modelDescription,
      inputSchema: {
        type: "object",
        properties: {
          explanation: {
            type: "string",
            maxLength: limits.maxExplanationLength,
            description: "Optional concise reason for creating or replacing the Plan, especially when its structure or direction changed.",
          },
          plan: createPlanSchema(limits),
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
  ]);
}

function createPlanSchema(limits: PlanLimits): ModelJsonSchema {
  return {
    type: "array",
    minItems: 1,
    maxItems: limits.maxSteps,
    description: "Complete replacement Plan in intended work order. Include all still-relevant steps and use at most one in_progress status. Unfinished steps may remain when ending.",
    items: {
      type: "object",
      properties: {
        step: {
          type: "string", minLength: 1, maxLength: limits.maxStepLength,
          description: "Concrete bounded outcome or unit of work whose progress can be understood independently.",
        },
        status: {
          type: "string", enum: ["pending", "in_progress", "completed"],
          description: "Current step state: pending has not started, in_progress is the one active step, and completed is established as done.",
        },
      },
      required: ["step", "status"],
      additionalProperties: false,
    },
  };
}

function createGuidance(): HelarcControllerControlGuidance {
  const material = Object.freeze({
    id: "helarc.controller-control-guidance" as const,
    entries: ENTRIES,
  });
  return Object.freeze({
    ...material,
    revision: `sha256:${createHash("sha256")
      .update(JSON.stringify(material), "utf8")
      .digest("hex")}`,
  });
}

function assertPlanLimits(limits: PlanLimits): void {
  if (
    limits === null || typeof limits !== "object" ||
    !Number.isSafeInteger(limits.maxSteps) || limits.maxSteps < 1 ||
    !Number.isSafeInteger(limits.maxStepLength) || limits.maxStepLength < 1 ||
    !Number.isSafeInteger(limits.maxExplanationLength) ||
    limits.maxExplanationLength < 1
  ) {
    throw new TypeError("Helarc Controller Control Guidance requires positive Plan limits.");
  }
}
