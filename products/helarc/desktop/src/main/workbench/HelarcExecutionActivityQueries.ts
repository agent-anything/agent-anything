import { createHash } from "node:crypto";
import type { ActivityWorkView } from "@agent-anything/agent-runtime/activity";
import { helarcSubtaskName, type HelarcRunProjection } from "@agent-anything/helarc/run";
import type {
  ExecutionActivitiesQuery, ExecutionActivitiesResult, ExecutionActivity,
  ExecutionActivityPurpose, ExecutionActivityState,
} from "../../shared/HelarcExecutionActivities.js";
import type { WorkbenchScope } from "../../shared/HelarcWorkbench.js";
import type { WorkbenchQuerySources } from "./HelarcWorkbenchQueries.js";
import { fitsPage, readRejected, taskScopeValid } from "./WorkbenchReadLimits.js";

type Work = ActivityWorkView["items"][number];
type Stage = Work["stages"][number];
type State = { state: ExecutionActivityState; status: string };

const purposes: Readonly<Record<string, readonly [ExecutionActivityPurpose, string]>> = {
  "task.model-response": ["task_response", "Task response"],
  "helarc.stop-model-assessment": ["completion_check", "Completion check"],
  "context.input-preparation": ["input_preparation", "Input preparation"],
  "context.input-materialization": ["material_access", "Input material access"],
  "context.source-publication": ["source_publication", "Source publication"],
  "context.representation-method": ["context_method", "Context method"],
};

export class HelarcExecutionActivityQueries {
  constructor(
    private readonly sources: WorkbenchQuerySources,
    private readonly resolve: (scope: WorkbenchScope) => Promise<{ projection: HelarcRunProjection } | null>,
  ) {}

  async read(query: ExecutionActivitiesQuery): Promise<ExecutionActivitiesResult> {
    if (!taskScopeValid(query) || (query.includeDescendants !== undefined && typeof query.includeDescendants !== "boolean")) {
      return readRejected("invalid_query");
    }
    try {
      const resolved = await this.resolve(query);
      if (!resolved) return readRejected("not_found");
      if (!this.sources.activities) return { status: "unavailable" };
      const projection = resolved.projection;
      const rootRunId = projection.host.runId;
      const view = await this.sources.activities(rootRunId);
      if (view.scopeId !== `helarc-tree:${rootRunId}`) return readRejected("read_failed");
      const nodes = new Map(projection.host.runTree.nodes.map(node => [node.runId, node]));
      const selected = new Set([query.runId]);
      if (query.includeDescendants) {
        const children = new Map<string, string[]>();
        for (const node of nodes.values()) {
          if (node.parentRunId !== null) children.set(node.parentRunId, [...(children.get(node.parentRunId) ?? []), node.runId]);
        }
        const queue = [query.runId];
        for (let i = 0; i < queue.length; i++) {
          for (const child of children.get(queue[i]!) ?? []) {
            if (!selected.has(child)) { selected.add(child); queue.push(child); }
          }
        }
      }
      const items: ExecutionActivity[] = [];
      let hasMore = view.hasMore;
      for (const item of view.items) {
        const node = nodes.get(item.runId);
        // The snapshot can race a newer child projection. Never invent membership.
        if (!node) { hasMore = true; continue; }
        if (!selected.has(item.runId)) continue;
        const taskEnded = projection.display.terminal || !!node.terminal || ["completed", "failed", "cancelled"].includes(node.status);
        const label = item.runId === rootRunId ? "Main task" : helarcSubtaskName(projection.product.presentation.labels, item.runId);
        items.push(projectExecutionActivity(item, taskEnded, label));
      }
      const page = {
        status: "page" as const,
        scope: { threadId: query.threadId, productRunId: query.productRunId, runId: query.runId },
        revision: view.revision, items, hasMore,
      };
      while (!fitsPage(page) && items.length) { items.pop(); page.hasMore = true; }
      return fitsPage(page) ? page : readRejected("read_failed");
    } catch { return readRejected("read_failed"); }
  }
}

export function projectExecutionActivity(item: Work, taskEnded: boolean, taskLabel: string): ExecutionActivity {
  const [purpose, title] = item.purpose && Object.hasOwn(purposes, item.purpose.id)
    ? purposes[item.purpose.id]! : ["other" as const, item.pathId === null ? "Scheduled work" : "Activity"];
  const state = activityState(item, purpose);
  return {
    id: createHash("sha256").update(JSON.stringify([item.workId, item.pathId])).digest("hex"),
    runId: item.runId, taskLabel: taskLabel.slice(0, 120), taskEnded, purpose, title, ...state,
    placement: item.cancelled || item.closed ? "settlement" : taskEnded ? "remaining"
      : purpose === "task_response" || purpose === "completion_check" ? "foreground"
      : item.reason === "opportunity" || item.reason === "optional" ? "background" : "support",
    detailsLimited: item.hasMoreStages,
  };
}

function currentAction(stage: Stage, cancelled: boolean) {
  switch (stage.status) {
    case "submitted": return cancelled ? null : "admission";
    case "admitted": return cancelled ? null : "execution";
    case "dispatched": return "reconciliation";
    case "raw_result": return cancelled ? "settlement" : "interpretation";
    default: return null;
  }
}

function activityState(item: Work, purpose: ExecutionActivityPurpose): State {
  if (item.settlementConfirmed) return { state: "settled", status: "Settled" };
  const active = item.stages.filter(stage => currentAction(stage, item.cancelled) !== null);
  for (const stage of active) {
    const action = currentAction(stage, item.cancelled)!;
    const restriction = stage.authorizationRestrictions[action];
    if (restriction) return { state: "authorization", status: restriction.kind === "temporary"
      ? "Authorization temporarily restricted" : "Authorization denied" };
  }
  if (item.cancelled || item.closed) return { state: "settling", status: active.some(stage => stage.status === "dispatched")
    ? "Awaiting original result" : "Awaiting settlement confirmation" };
  if (item.pathId === null) return item.pathsSealed
    ? { state: "unknown", status: "Awaiting further activity" }
    : { state: "preparing", status: "Awaiting execution preparation" };
  if (active.some(stage => stage.status === "admitted" && stage.dispatchRestriction)) {
    return { state: "execution_limit", status: "Execution restricted" };
  }
  const queued = active.find(stage => stage.status === "admitted" && stage.schedulingWait);
  if (queued) return { state: "resource_queue", status: queued.schedulingWait === "resource_occupied"
    ? "Waiting for resources" : "Waiting for a service turn" };
  if (item.pendingInputs > 0) return { state: "waiting_input", status: "Waiting for input materials" };
  if (active.some(stage => stage.status === "dispatched")) {
    const modelRequest = active.some(stage => stage.status === "dispatched" && stage.capabilities.includes("model-request"));
    // A task response path also records its source and input limitations without calling a model.
    if (purpose === "task_response") return modelRequest
      ? { state: "running", status: "Awaiting model result" }
      : { state: "preparing", status: "Preparing task response" };
    return { state: "running", status: "Awaiting execution result" };
  }
  if (active.some(stage => stage.status === "raw_result")) return { state: "processing", status: "Processing returned result" };
  if (active.some(stage => stage.status === "submitted" || stage.status === "admitted")) return {
    state: "preparing", status: purpose === "task_response"
      ? active.some(stage => (stage.status === "submitted" || stage.status === "admitted") && stage.capabilities.includes("model-request"))
        ? "Preparing model request" : "Preparing task response"
      : "Preparing",
  };
  return { state: "unknown", status: item.hasMoreStages ? "Activity details incomplete" : "Awaiting further activity" };
}
