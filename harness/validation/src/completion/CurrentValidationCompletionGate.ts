import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createValidationFailure, type ValidationCompletionDisposition } from "../definition/index.js";
import {
  snapshotCompletionGateDecision,
  snapshotCompletionGateInput,
  type CompletionGateDecision,
  type CompletionGateDecisionStatus,
  type CompletionGateInput,
  type CompletionGatePort,
  type CompletionGateReason,
  type CompletionGateRequirementState,
} from "./CompletionGate.js";

export class CurrentValidationCompletionGate implements CompletionGatePort {
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async evaluate(
    candidate: CompletionGateInput,
    interruption: InvocationInterruptionContext,
  ): Promise<CompletionGateDecision> {
    let input: CompletionGateInput;
    try {
      input = snapshotCompletionGateInput(candidate);
    } catch (error) {
      return snapshotCompletionGateDecision({
        invocation: candidate.invocation,
        validationSnapshot: candidate.validationSnapshot,
        status: "invalid",
        disposition: "fail",
        reasons: [],
        failure: createValidationFailure({
          code: "validation_gate_input_invalid",
          stage: "completion_gate",
          message: error instanceof Error ? error.message : "Completion Gate input is invalid.",
          retryable: false,
          cause: null,
        }),
        decidedAt: this.timestamp(),
      });
    }
    if (interruption.signal.aborted) {
      return this.failed(input, "validation_gate_cancelled", "Completion Gate evaluation was cancelled.");
    }
    const unsatisfiedCondition = input.conditions.find((condition) =>
      condition.required && !condition.satisfied);
    if (unsatisfiedCondition !== undefined) {
      return this.blocked(input, "blocked_unassessed", "block", [{
        owner: unsatisfiedCondition.owner,
        code: "validation_gate_condition_unsatisfied",
        message: "A required completion condition is not satisfied.",
        requirement: null,
      }]);
    }
    const selected = selectBlockingState(input.mandatoryStates);
    if (selected !== null) {
      return this.blocked(input, selected.status, selected.item.disposition!, [{
        owner: "validation",
        code: `validation_requirement_${selected.item.current.status}`,
        message: `A mandatory Validation Requirement is ${selected.item.current.status}.`,
        requirement: selected.item.current.requirement,
      }]);
    }
    return snapshotCompletionGateDecision({
      invocation: input.invocation,
      validationSnapshot: input.validationSnapshot,
      status: "completion_eligible",
      disposition: null,
      reasons: [],
      failure: null,
      decidedAt: this.timestamp(),
    });
  }

  private blocked(
    input: CompletionGateInput,
    status: Exclude<CompletionGateDecisionStatus, "completion_eligible" | "invalid" | "failed">,
    disposition: ValidationCompletionDisposition,
    reasons: readonly [CompletionGateReason, ...CompletionGateReason[]],
  ): CompletionGateDecision {
    return snapshotCompletionGateDecision({
      invocation: input.invocation,
      validationSnapshot: input.validationSnapshot,
      status,
      disposition,
      reasons,
      failure: null,
      decidedAt: this.timestamp(),
    });
  }

  private failed(
    input: CompletionGateInput,
    code: `validation_${string}`,
    message: string,
  ): CompletionGateDecision {
    return snapshotCompletionGateDecision({
      invocation: input.invocation,
      validationSnapshot: input.validationSnapshot,
      status: "failed",
      disposition: "fail",
      reasons: [],
      failure: createValidationFailure({
        code,
        stage: "completion_gate",
        message,
        retryable: false,
        cause: null,
      }),
      decidedAt: this.timestamp(),
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
      throw new TypeError("Completion Gate clock must return an ISO date-time.");
    }
    return value;
  }
}

function selectBlockingState(
  states: readonly CompletionGateRequirementState[],
): {
  readonly status: Exclude<CompletionGateDecisionStatus, "completion_eligible" | "invalid" | "failed">;
  readonly item: CompletionGateRequirementState;
} | null {
  const priority = ["pending", "stale", "violated", "inconclusive", "unassessed"] as const;
  for (const state of priority) {
    const item = states.find((candidate) => candidate.current.status === state);
    if (item !== undefined) return { status: `blocked_${state}`, item };
  }
  return null;
}
