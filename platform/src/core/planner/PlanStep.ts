import type { Metadata } from "../../shared/types.js";
import type { ToolCall } from "../../tools/index.js";

export type PlanStepKind = "callTool" | "final" | "stop";

export type PlanStep =
  | CallToolPlanStep
  | FinalPlanStep
  | StopPlanStep;

interface BasePlanStep {
  id: string;
  kind: PlanStepKind;
  reason: string;
  metadata: Metadata;
}

export interface CallToolPlanStep extends BasePlanStep {
  kind: "callTool";
  toolCall: ToolCall;
}

export interface FinalPlanStep extends BasePlanStep {
  kind: "final";
  finalOutput: unknown;
}

export interface StopPlanStep extends BasePlanStep {
  kind: "stop";
  stopReason: string;
}
