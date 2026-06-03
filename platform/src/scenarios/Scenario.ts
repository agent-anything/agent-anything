import type { AgentTask } from "../core/task";
import type { RuntimeStatus } from "../core/runtime";
import type { Metadata } from "../shared/types";

export interface Scenario<TInput = unknown> {
  id: string;
  name: string;
  task: AgentTask<TInput>;
  expected: ScenarioExpectation;
  metadata: Metadata;
}

export interface ScenarioExpectation {
  status: RuntimeStatus;
  reportRequired: boolean;
  minEvidenceCount: number;
}
