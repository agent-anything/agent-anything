import type {DelegationResult} from "@agent-anything/agent-runtime/delegation";
import type {ExecutionEvidenceRef, ExecutionReferencePage} from "@agent-anything/operation-catalog/evidence";

/** Product projection of trusted owner references, independent of narrative content. */
export interface HelarcExecutionHandoff {
  validate(parentRunId: string, references: readonly ExecutionEvidenceRef[]): Promise<void>;
  project(result: DelegationResult): Promise<ExecutionReferencePage>;
}
