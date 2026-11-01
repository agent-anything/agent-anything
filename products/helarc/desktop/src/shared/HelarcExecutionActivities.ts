import type { WorkbenchRejected, WorkbenchScope } from "./HelarcWorkbench.js";

export interface ExecutionActivitiesQuery extends WorkbenchScope {
  includeDescendants?: boolean;
}
export type ExecutionActivityPurpose =
  | "task_response" | "completion_check" | "input_preparation"
  | "material_access" | "source_publication" | "context_method" | "other";
export type ExecutionActivityState =
  | "preparing" | "waiting_input" | "resource_queue" | "authorization"
  | "execution_limit" | "running" | "processing" | "settling" | "settled" | "unknown";
export interface ExecutionActivity {
  readonly id: string;
  readonly runId: string;
  readonly taskLabel: string;
  readonly taskEnded: boolean;
  readonly purpose: ExecutionActivityPurpose;
  readonly title: string;
  readonly state: ExecutionActivityState;
  readonly status: string;
  readonly placement: "foreground" | "support" | "background" | "settlement" | "remaining";
  readonly detailsLimited: boolean;
}
export interface ExecutionActivitiesPage {
  readonly status: "page";
  readonly scope: WorkbenchScope;
  readonly revision: number;
  readonly items: readonly ExecutionActivity[];
  readonly hasMore: boolean;
}
export type ExecutionActivitiesResult = ExecutionActivitiesPage | WorkbenchRejected
  | { readonly status: "unavailable" };
