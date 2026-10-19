import type { CommandInputContract } from "./CommandInputContract.js";

export interface CommandConstraintFact {
  readonly runId: string;
  readonly actionId: string;
  readonly invocationId: string | null;
  readonly executionId: string | null;
  readonly managerId: string;
  readonly configuration: CommandInputContract["ref"];
  readonly occurredAt: string;
  readonly stage: "preparation" | "capacity" | "deadline" | "execution_deadline";
  readonly status: "passed" | "not_satisfied";
  readonly basis: Readonly<Record<string, string | number | boolean | null>>;
}
export type CommandConstraintObserver = (fact: CommandConstraintFact) => void;

export function publishCommandConstraint(observer: CommandConstraintObserver | undefined, fact: CommandConstraintFact): void {
  try { observer?.(Object.freeze({...fact, basis: Object.freeze({...fact.basis})})); }
  catch { /* Capture is not an admission or execution dependency. */ }
}
