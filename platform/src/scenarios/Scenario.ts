import type { AgentTask, RuntimeStatus } from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";

export interface Scenario<TInput = unknown> {
  id: string;
  name: string;
  task: AgentTask<TInput>;
  expected: ScenarioExpectation;
  metadata: Metadata;
}

export interface ScenarioExpectation {
  status: RuntimeStatus;
  minEvidenceCount: number;
}
