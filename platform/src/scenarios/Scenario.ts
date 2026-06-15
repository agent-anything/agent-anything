import type { AgentTask } from "../core/task/index.js";
import type { RuntimeStatus } from "../core/runtime/index.js";
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
