import type {AgentActivityExecutionContext} from "../decision/TaskDecisionActivity.js";

export interface RunPreparationRegistration {
  readonly id: string;
  readonly binding: string;
  readonly deadlineAt: string;
}
export interface RunPreparationRecord extends RunPreparationRegistration {
  readonly authority: string;
  readonly status: "registered" | "completed" | "failed" | "cancelled";
  readonly failure: string | null;
}
/** No decision, input-consumption or effect-dispatch port is supplied to auxiliary work. */
export interface RunPreparationWorkPort {
  current(): RunPreparationRecord | null;
  read(id: string): RunPreparationRecord | null;
  start(registration: RunPreparationRegistration, execute: (context: AgentActivityExecutionContext) => Promise<void>): Promise<boolean>;
  wait(id: string): Promise<void>;
}
