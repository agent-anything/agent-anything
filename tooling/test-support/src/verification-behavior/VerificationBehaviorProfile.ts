export type VerificationBehaviorDimension =
  | "profile"
  | "command_check"
  | "target_state"
  | "evidence"
  | "assessment"
  | "completion_gate"
  | "lifecycle"
  | "disclosure";

export interface VerificationBehaviorScenario {
  readonly id: string;
  readonly dimension: VerificationBehaviorDimension;
  readonly expected: string;
}

export const VALIDATION_BEHAVIOR_SCENARIOS: readonly VerificationBehaviorScenario[] = deepFreeze([
  scenario("profile.empty", "profile", "not_required"),
  scenario("profile.mandatory", "profile", "gate_enforced"),
  scenario("command.completed", "command_check", "completed"),
  scenario("command.partial", "command_check", "partial"),
  scenario("command.failed", "command_check", "failed"),
  scenario("command.denied", "command_check", "denied"),
  scenario("command.timed_out", "command_check", "timed_out"),
  scenario("command.cancelled", "command_check", "cancelled"),
  scenario("target.satisfied", "target_state", "satisfied"),
  scenario("target.violated", "target_state", "violated"),
  scenario("target.unavailable", "target_state", "unavailable"),
  scenario("target.stale", "target_state", "stale"),
  scenario("evidence.insufficient", "evidence", "inconclusive"),
  scenario("evidence.conflicting", "evidence", "policy_resolved"),
  scenario("assessment.satisfied", "assessment", "satisfied"),
  scenario("assessment.violated", "assessment", "violated"),
  scenario("assessment.inconclusive", "assessment", "inconclusive"),
  scenario("gate.eligible", "completion_gate", "completion_eligible"),
  scenario("gate.unassessed", "completion_gate", "blocked_unassessed"),
  scenario("gate.pending", "completion_gate", "blocked_pending"),
  scenario("gate.stale", "completion_gate", "blocked_stale"),
  scenario("gate.violated", "completion_gate", "blocked_violated"),
  scenario("gate.inconclusive", "completion_gate", "blocked_inconclusive"),
  scenario("gate.invalid", "completion_gate", "invalid"),
  scenario("gate.failed", "completion_gate", "failed"),
  scenario("lifecycle.cancelled", "lifecycle", "fail_closed"),
  scenario("lifecycle.conflict", "lifecycle", "fail_closed"),
  scenario("lifecycle.duplicate", "lifecycle", "fail_closed"),
  scenario("lifecycle.late", "lifecycle", "history_only"),
  scenario("lifecycle.post_terminal", "lifecycle", "history_only"),
  scenario("disclosure.renderer", "disclosure", "bounded"),
  scenario("disclosure.evaluation", "disclosure", "bounded"),
]);

function scenario(
  id: string,
  dimension: VerificationBehaviorDimension,
  expected: string,
): VerificationBehaviorScenario {
  return Object.freeze({ id, dimension, expected });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
