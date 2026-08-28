import { createHash } from "node:crypto";
import type { PlanLimits } from "@agent-anything/agent-runtime/plan";
import {
  snapshotModelCallableDefinitions,
  type ModelCallableDefinition,
} from "@agent-anything/model-interaction";

export const HELARC_STOP_REASON_MAX_LENGTH = 4_096;

export type HelarcControllerControlName = "update_plan" | "stop";

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
    name: "stop" as const,
    modelDescription: "Stop the current Run without claiming successful completion when no safe useful continuation remains, required information or authority is unavailable, an explicit user instruction requires stopping, or continuing would be misleading. Supply one concise reason that states the actual blocker or stop basis. Call stop by itself: it cannot be combined with Tools or update_plan in the same Model Turn. Do not use stop for ordinary Tool failures that can be diagnosed or corrected, for completed work, or as a substitute for a user-facing completion response.",
  }),
  Object.freeze({
    name: "update_plan" as const,
    modelDescription: "Create or replace the current Run Plan when an explicit multi-step representation materially improves coordination, progress tracking, or recovery. A Plan is optional and may be created or revised at any turn; do not create one for a simple direct task. Every call replaces the complete visible Plan, so retain still-relevant steps, mark established work completed, keep future work pending, and use at most one in_progress step. The Plan records intended progression but grants no Tool, Permission, or execution authority and does not prove that a step succeeded.",
  }),
]);

export const HELARC_CONTROLLER_CONTROL_GUIDANCE = createGuidance();

export function createHelarcControllerControlDefinitions(
  guidance: HelarcControllerControlGuidance,
  limits: PlanLimits,
): readonly ModelCallableDefinition[] {
  assertPlanLimits(limits);
  const byName = new Map(guidance.entries.map((entry) => [entry.name, entry]));
  if (byName.size !== 2 || !byName.has("stop") || !byName.has("update_plan")) {
    throw new TypeError("Helarc Controller Control Guidance must completely define update_plan and stop.");
  }
  return snapshotModelCallableDefinitions([
    {
      name: "stop",
      description: byName.get("stop")!.modelDescription,
      inputSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            minLength: 1,
            maxLength: HELARC_STOP_REASON_MAX_LENGTH,
            description: "Concise truthful reason why this Run cannot or should not continue. It is a stop basis, not a success summary.",
          },
        },
        required: ["reason"],
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
          plan: {
            type: "array",
            minItems: 1,
            maxItems: limits.maxSteps,
            description: "Complete replacement Plan in intended work order. Include all still-relevant steps and use at most one in_progress status.",
            items: {
              type: "object",
              properties: {
                step: {
                  type: "string",
                  minLength: 1,
                  maxLength: limits.maxStepLength,
                  description: "Concrete bounded outcome or unit of work whose progress can be understood independently.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Current step state: pending has not started, in_progress is the one active step, and completed is established as done.",
                },
              },
              required: ["step", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
  ]);
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
