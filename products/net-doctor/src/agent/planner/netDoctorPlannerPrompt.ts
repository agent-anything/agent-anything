import type { PlannerInput, ToolCall } from "@agent-anything/platform";
import type { NetDoctorInput } from "../../input/index.js";
import { redactNetDoctorPromptText } from "./netDoctorPromptRedaction.js";

export const netDoctorPlannerCapability = "net-doctor.tool-planning";

export const netDoctorToolNames = [
  "netDoctor.dnsLookup",
  "netDoctor.tcpConnect",
  "netDoctor.httpReachability",
  "netDoctor.proxyConfig",
] as const;

export type NetDoctorToolName = typeof netDoctorToolNames[number];

export function buildNetDoctorPlannerPrompt(input: PlannerInput): string {
  const taskInput = readNetDoctorInput(input.task.input);
  const toolCalls = readToolCalls(input.task.input);

  return [
    "You are NetDoctor, a safe network diagnostic planner.",
    "Choose exactly one next action as structured JSON.",
    "",
    "Allowed output shapes:",
    '{"kind":"callTool","toolName":"netDoctor.dnsLookup","reason":"why this tool is next"}',
    '{"kind":"final","finalOutput":{"conclusion":"short diagnosis"},"reason":"why enough evidence exists"}',
    '{"kind":"stop","stopReason":"why planning should stop","reason":"why stopping is appropriate"}',
    "",
    "Safety rules:",
    "- Use only the listed tools.",
    "- Prefer read-only diagnostics.",
    "- Do not request raw secrets, credentials, tokens, or proxy values.",
    "- Use observation summaries and evidence refs only.",
    "",
    `Target: ${redactNetDoctorPromptText(taskInput.target?.normalized ?? "(unknown)")}`,
    `Symptom: ${redactNetDoctorPromptText(taskInput.symptom ?? "(none)")}`,
    "",
    "Available tools:",
    ...toolCalls.map((toolCall) => `- ${toolCall.toolName}`),
    "",
    "Context observations:",
    ...formatObservations(input),
    "",
    "Evidence refs:",
    ...formatEvidenceRefs(input),
  ].join("\n");
}

export function isNetDoctorToolName(value: string): value is NetDoctorToolName {
  return netDoctorToolNames.includes(value as NetDoctorToolName);
}

function formatObservations(input: PlannerInput): string[] {
  if (input.context.observations.length === 0) {
    return ["- (none)"];
  }

  return input.context.observations.map((observation) => {
    const refs = observation.evidenceRefs.length === 0
      ? "no evidence refs"
      : `evidence refs: ${observation.evidenceRefs.join(", ")}`;

    return `- ${redactNetDoctorPromptText(observation.summary)} (${redactNetDoctorPromptText(refs)})`;
  });
}

function formatEvidenceRefs(input: PlannerInput): string[] {
  if (input.context.evidenceRefs.length === 0) {
    return ["- (none)"];
  }

  return input.context.evidenceRefs.map((evidenceRef) =>
    `- ${redactNetDoctorPromptText(evidenceRef)}`,
  );
}

function readNetDoctorInput(input: unknown): Partial<NetDoctorInput> {
  return isRecord(input) ? input as Partial<NetDoctorInput> : {};
}

function readToolCalls(input: unknown): ToolCall[] {
  if (!isRecord(input) || !Array.isArray(input.toolCalls)) {
    return [];
  }

  return input.toolCalls.filter(isToolCall);
}

function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value) && typeof value.toolName === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
