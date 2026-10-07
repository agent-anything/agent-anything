import { createHash } from "node:crypto";
import type { ModelMessage, ModelToolCall, ModelJsonValue } from "@agent-anything/model-interaction";
import { validateToolInput } from "@agent-anything/tools/validation";
import { finalResultInputError } from "../controller/HelarcFinalResultInput.js";
import { validatePlanUpdate } from "@agent-anything/agent-runtime/plan";
import type { HelarcQualificationProfile } from "./HelarcQualificationProfile.js";
import type { HelarcModelQualificationScope, HelarcModelQualificationOutcome } from "../model-qualification/HelarcModelQualification.js";

export const HELARC_QUALIFICATION_SUITE_REVISION = "helarc.native-call-baseline.v2";
export const HELARC_QUALIFICATION_REPETITIONS = 3;
export const HELARC_QUALIFICATION_REQUEST_TIMEOUT_MS = 120_000;
export const HELARC_QUALIFICATION_MAX_REQUESTS_PER_TRIAL = 3;
export const HELARC_QUALIFICATION_LIMITATIONS = Object.freeze([
  "Baseline native-call evidence only; not a coding-quality or reliability guarantee.",
  "Tool results are fixtures. No files, processes, approvals, or child Runs are executed.",
  "Only the listed Cases are checked, not every Tool, concurrent scheduling, or recovery path.",
  "Root instructions are exercised; delegated instructions and Stop Hooks are not executed.",
  "The endpoint model has no verified immutable artifact identity; an alias may change without notice.",
  "Three Trials per Case are retained; no statistical success-rate claim is made.",
]);

export const HELARC_QUALIFICATION_CASES = Object.freeze([
  { id: "final-response", scope: "agent_loop", title: "Explicit final response", tool: null },
  { id: "read-result", scope: "workspace_observation", title: "Read and consume result", tool: "Read" },
  { id: "write-result", scope: "workspace_mutation", title: "Write and consume result", tool: "Write" },
  { id: "write-denied", scope: "workspace_mutation", title: "Respect a denied write", tool: "Write" },
  { id: "shell-result", scope: "process_execution", title: "Shell and consume result", tool: "shell" },
  { id: "question-answer", scope: "user_interaction", title: "Ask and consume answer", tool: "AskUserQuestion" },
  { id: "agent-result", scope: "delegation", title: "Delegate and consume result", tool: "Agent" },
] as const);

export type HelarcQualificationCaseId = typeof HELARC_QUALIFICATION_CASES[number]["id"];
export type HelarcQualificationTrialOutcome = "passed" | "failed" | "inconclusive";
export type HelarcQualificationStage = "operation_request" | "final_response";
export type HelarcQualificationFailureCategory = "protocol" | "case_requirement" | "infrastructure";
export interface HelarcQualificationFailure {
  readonly category: Exclude<HelarcQualificationFailureCategory, "infrastructure">;
  readonly reason: string;
}

export interface HelarcQualificationCase {
  readonly marker: string;
  readonly id: HelarcQualificationCaseId;
  readonly scope: HelarcModelQualificationScope;
  readonly title: string;
  readonly callableName: string | null;
  readonly expectedInput: Readonly<Record<string, ModelJsonValue>>;
  readonly expectedResponse: string;
  readonly prompt: string;
  readonly fixture: ModelJsonValue | null;
  readonly denied: boolean;
}

export interface HelarcQualificationTrial {
  readonly id: string;
  readonly caseId: HelarcQualificationCaseId;
  readonly repetition: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: HelarcQualificationTrialOutcome;
  readonly reason: string;
  readonly stage: HelarcQualificationStage;
  readonly failureCategory: HelarcQualificationFailureCategory | null;
  readonly fixtureResultRequestId: string | null;
  readonly scenario: HelarcQualificationCase;
  readonly messages: readonly ModelMessage[];
  readonly requests: readonly { readonly id: string; readonly durationMs: number; readonly usage: unknown }[];
  readonly digest: string;
}

export function qualificationDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

export function createHelarcQualificationCase(
  profile: Pick<HelarcQualificationProfile, "callables" | "shellRuntime">, id: HelarcQualificationCaseId, marker: string,
): HelarcQualificationCase {
  const entry = HELARC_QUALIFICATION_CASES.find(c => c.id === id)!;
  const tool = entry.tool === "shell" ? profile.shellRuntime.toolName : entry.tool;
  const binding = tool === null ? null : profile.callables.bindings.find(b => b.kind === "tool" && b.toolName === tool);
  if (tool !== null && !binding) throw new TypeError(`Qualification Tool ${tool} is unavailable.`);
  const callableName = binding?.callableName ?? null;
  const expectedInput: Record<string, ModelJsonValue> = {};
  const denied = id === "write-denied";
  const path = "qualification-note.txt";
  let operation = "";
  if (tool === "Read") {
    expectedInput.file_path = path;
    operation = `Read the file ${JSON.stringify(path)} once.`;
  } else if (tool === "Write") {
    expectedInput.file_path = path; expectedInput.content = denied ? "qualification sample" : "qualification sample\n";
    operation = `Write exactly the text "qualification sample" ${denied
      ? "with no trailing newline"
      : "followed by exactly one LF newline character (U+000A), not the two literal characters backslash and n"} to the new file ${JSON.stringify(path)} once.`;
  } else if (entry.tool === "shell") {
    expectedInput.command = tool === "Bash" ? "printf 'qualification sample'" : "Write-Output 'qualification sample'";
    operation = `Submit exactly this command once through the native Shell: ${JSON.stringify(expectedInput.command)}.`;
  } else if (tool === "Agent") {
    expectedInput.prompt = "Return the fixture receipt for this delegated task.";
    operation = `Delegate once with prompt exactly ${JSON.stringify(expectedInput.prompt)}.`;
  } else if (tool === "AskUserQuestion") {
    operation = "Ask one question, with id 'choice', asking the user to choose red or blue. Allow one answer, and supply these two options with labels 'red' and 'blue'.";
  }
  const expectedResponse = denied ? `not_written:${marker}` : tool === "AskUserQuestion" ? `blue:${marker}` : marker;
  const fixture: ModelJsonValue | null = tool === null ? null : {
    qualification_fixture: true,
    status: denied ? "denied" : "succeeded",
    receipt: marker,
    ...(denied ? { code: "permission_denied", effects: "none", instruction: "The write did not occur. Do not retry." } : {}),
    ...(tool === "AskUserQuestion" ? { answers: [{ question_id: "choice", selected_labels: ["blue"], text: null }] } : {}),
  };
  const noPlan = "Do not create or update a Plan. In final_result, omit plan or supply an empty array.";
  const prompt = tool === null
    ? `This is a bounded native-call qualification Case. Return exactly ${JSON.stringify(marker)} using final_result. No other calls are allowed. ${noPlan}`
    : `This is a controlled qualification fixture, not a real workspace. Calls are intercepted and have no external effects. ${operation} ` +
      `Use only the requested operation, then final_result. ${noPlan} The result will contain a fresh receipt which is not known yet. ` +
      (tool === "AskUserQuestion" ? "On success, final_result.response must be the selected answer label followed by ':' and the receipt. "
        : "If the result succeeds, final_result.response must equal the receipt exactly. ") +
      "If denied, do not retry: final_result.response must be 'not_written:' followed by the receipt. Do not invent a receipt or claim an unobserved outcome.";
  return { marker, id, scope: entry.scope, title: entry.title, callableName, expectedInput, expectedResponse, prompt, fixture, denied };
}

type QualificationGradingProfile = Pick<HelarcQualificationProfile, "callables" | "tools" | "planLimits">;

function checkCallableInput(profile: QualificationGradingProfile, call: ModelToolCall): HelarcQualificationFailure | null {
  const binding = profile.callables.bindings.find(b => b.callableName === call.name);
  if (!binding) return { category: "protocol", reason: "unexpected_callable" };
  if (binding.kind === "tool") {
    const descriptor = profile.tools.find(t => t.name === binding.toolName);
    return !descriptor || validateToolInput({ descriptor, value: call.input }).status !== "valid"
      ? { category: "protocol", reason: "invalid_tool_input" } : null;
  }
  if (binding.control === "final_result") return finalResultInputError(call.input, false, profile.planLimits)
    ? { category: "protocol", reason: "invalid_final_result" } : null;
  return validatePlanUpdate(call.input, profile.planLimits) ? { category: "protocol", reason: "invalid_plan_update" } : null;
}

export function checkQualificationCall(profile: QualificationGradingProfile, scenario: HelarcQualificationCase, call: ModelToolCall): HelarcQualificationFailure | null {
  const invalid = checkCallableInput(profile, call);
  if (invalid) return invalid;
  if (call.name !== scenario.callableName) return { category: "case_requirement", reason: "requested_operation_not_called" };
  if (Object.entries(scenario.expectedInput).some(([key, value]) => JSON.stringify(call.input[key]) !== JSON.stringify(value))) {
    return { category: "case_requirement", reason: "incorrect_tool_arguments" };
  }
  if (scenario.id === "question-answer") {
    const questions = call.input.questions;
    if (!Array.isArray(questions) || questions.length !== 1) return { category: "case_requirement", reason: "incorrect_question" };
    const question = questions[0] as Record<string, ModelJsonValue>;
    if (question.id !== "choice" || question.allow_multiple !== false || !Array.isArray(question.options)) return { category: "case_requirement", reason: "incorrect_question" };
    const options = question.options as Record<string, ModelJsonValue>[];
    if (options.length !== 2 || !options.some(o => o.label === "red") || !options.some(o => o.label === "blue")) return { category: "case_requirement", reason: "incorrect_question_options" };
  }
  return null;
}

export function checkQualificationFinal(profile: QualificationGradingProfile, call: ModelToolCall, expected: string): HelarcQualificationFailure | null {
  const invalid = checkCallableInput(profile, call);
  if (invalid) return invalid;
  if (call.name !== "final_result") return { category: "case_requirement", reason: "expected_final_result" };
  if (Array.isArray(call.input.plan) && call.input.plan.length > 0) return { category: "case_requirement", reason: "unexpected_plan" };
  return (call.input.response as string).trim() === expected ? null : { category: "case_requirement", reason: "incorrect_final_response" };
}

export function summarizeQualificationScopes(trials: readonly HelarcQualificationTrial[]) {
  const scopes = [...new Set(HELARC_QUALIFICATION_CASES.map(c => c.scope))];
  return scopes.map(scope => {
    const cases = HELARC_QUALIFICATION_CASES.filter(c => c.scope === scope);
    const relevant = trials.filter(t => cases.some(c => c.id === t.caseId));
    const complete = cases.every(c => Array.from({ length: HELARC_QUALIFICATION_REPETITIONS }, (_, i) => i + 1)
      .every(repetition => relevant.some(t => t.caseId === c.id && t.repetition === repetition)));
    const outcome: HelarcModelQualificationOutcome = relevant.some(t => t.outcome === "failed") ? "not_qualified"
      : !complete || relevant.some(t => t.outcome === "inconclusive") ? "inconclusive" : "qualified";
    return { scope, outcome, passed: relevant.filter(t => t.outcome === "passed").length,
      total: relevant.length, required: cases.length * HELARC_QUALIFICATION_REPETITIONS };
  });
}
