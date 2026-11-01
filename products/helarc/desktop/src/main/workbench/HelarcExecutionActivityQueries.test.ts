import { describe, expect, it, vi } from "vitest";
import type { ActivityWorkView } from "@agent-anything/agent-runtime/activity";
import type { HelarcRunProjection } from "@agent-anything/helarc/run";
import type { HelarcThreadRecord } from "@agent-anything/helarc/work-context";
import type { HelarcHostActiveRun } from "../run/HelarcHostRunComposition.js";
import { CommandOutputRegistry } from "./CommandOutputRegistry.js";
import { HelarcWorkbenchQueries } from "./HelarcWorkbenchQueries.js";
import { projectExecutionActivity } from "./HelarcExecutionActivityQueries.js";

type Work = ActivityWorkView["items"][number];
type Stage = Work["stages"][number];
const scope = { threadId: "thread", productRunId: "work", runId: "root" };
const temporary = { kind: "temporary" as const, code: "private-code", message: "private restriction JSON / credential" };
function stage(values: Partial<Stage> = {}): Stage {
  return { requestId: "private-request", status: "submitted", capabilities: [], dispatchRestriction: null,
    authorizationRestrictions: {}, schedulingWait: null, ...values };
}
function work(values: Partial<Work> = {}): Work {
  return { workId: "private-work", runId: "root", pathId: "private-path", owner: "context-representation",
    purpose: { id: "context.input-preparation", revision: "1" }, reason: "necessary", service: "guaranteed",
    cancelled: false, closed: false, pathsSealed: false, settlementConfirmed: false, pendingInputs: 0,
    updatedAt: "2026-11-01T00:00:00Z", hasMoreStages: false, stages: [stage()], ...values };
}
function fixture(items: readonly Work[] = [work()]) {
  const projection = {
    productRunId: "work", harnessRunId: "root",
    host: { runId: "root", sequence: 1, status: "running", terminal: null, pendingInteractions: [], retry: null,
      enforcement: { selected: "disabled" },
      runTree: { nodes: [
        { runId: "root", parentRunId: null, status: "running", terminal: null },
        { runId: "child", parentRunId: "root", status: "running", terminal: null },
        { runId: "grandchild", parentRunId: "child", status: "running", terminal: null },
        { runId: "sibling", parentRunId: "root", status: "running", terminal: null },
      ] } },
    product: { runId: "work", sequence: 1, result: null, continuation: null, commands: [],
      responses: { revision: 0, omittedAttempts: 0, retainedBytes: 0, attempts: [] },
      presentation: { revision: 0, nextSequence: 1, omittedRecords: 0, retainedBytes: 0, records: [], activeCalls: [],
        omittedActiveCalls: 0, labels: [], plans: {}, sourceSequences: {} } },
    display: { status: "running", terminal: false, statusSource: "host" },
  } as unknown as HelarcRunProjection;
  const thread = { thread: { id: "thread", revision: 1 }, messages: [], runs: [
    { id: "work", harnessRunId: "root", terminal: null, updatedAt: "2026-11-01T00:00:00Z",
      lastProjection: { ...projection, recordedAt: "2026-11-01T00:00:00Z" } },
  ] } as unknown as HelarcThreadRecord;
  let view: ActivityWorkView = { scopeId: "helarc-tree:root", revision: 7, hasMore: false, items };
  let live = true;
  const activities = vi.fn(async () => view);
  const sources = {
    loadThread: async () => thread,
    live: () => live ? { projection, handle: {} as HelarcHostActiveRun } : null,
    outputs: new CommandOutputRegistry(), activities,
  };
  return { query: new HelarcWorkbenchQueries(sources), projection, activities, sources,
    restore: () => { live = false; }, setView: (value: ActivityWorkView) => { view = value; } };
}

describe("Desktop execution activity projection", () => {
  it("allowlists fields and never returns restriction messages, identities or capabilities", () => {
    const value = projectExecutionActivity(work({ stages: [stage({ status: "admitted",
      capabilities: ["private-capability"], authorizationRestrictions: { execution: temporary } })] }), false, "Main task");
    expect(value).toMatchObject({ state: "authorization", status: "Authorization temporarily restricted" });
    expect(JSON.stringify(value)).not.toMatch(/private-|credential|capabilities|authorizationRestrictions|workId|pathId|requestId/);
  });
  it.each([
    ["submitted", "admission"], ["admitted", "execution"], ["dispatched", "reconciliation"], ["raw_result", "interpretation"],
  ] as const)("uses the current %s action, not historical refusals", (status, action) => {
    const value = work({ stages: [stage({ status, authorizationRestrictions: { [action]: temporary } })] });
    expect(projectExecutionActivity(value, false, "Main task").state).toBe("authorization");
    expect(projectExecutionActivity(work({ stages: [stage({ status, authorizationRestrictions: { settlement: temporary } })] }), false, "Main task").state)
      .not.toBe("authorization");
  });
  it("uses settlement authorization only for cancelled original raw results", () => {
    const raw = stage({ status: "raw_result", authorizationRestrictions: { interpretation: temporary } });
    expect(projectExecutionActivity(work({ cancelled: true, stages: [raw] }), true, "Main task").state).toBe("settling");
    expect(projectExecutionActivity(work({ cancelled: true, stages: [{ ...raw, authorizationRestrictions: { settlement: temporary } }] }), true, "Main task").state)
      .toBe("authorization");
  });
  it("separates recorded resource waits from dispatch limits and unknown outcomes", () => {
    expect(projectExecutionActivity(work({ stages: [stage({ status: "admitted", schedulingWait: "resource_occupied" })] }), false, "Main task"))
      .toMatchObject({ state: "resource_queue", status: "Waiting for resources" });
    expect(projectExecutionActivity(work({ stages: [stage({ status: "admitted", dispatchRestriction: temporary })] }), false, "Main task").state)
      .toBe("execution_limit");
    expect(projectExecutionActivity(work({ cancelled: true, stages: [stage({ status: "dispatched" })] }), true, "Main task"))
      .toMatchObject({ state: "settling", status: "Awaiting original result", placement: "settlement", taskEnded: true });
  });
  it("never infers foreground model execution from a pathless owner", () => {
    expect(projectExecutionActivity(work({ pathId: null, purpose: null, owner: "task-decision", reason: "task", stages: [] }), false, "Main task"))
      .toMatchObject({ title: "Scheduled work", state: "preparing", status: "Awaiting execution preparation", placement: "support" });
  });
  it("does not infer strict settlement from a closed service or accepted stage", () => {
    const value = work({ closed: true, stages: [stage({ status: "accepted" })] });
    expect(projectExecutionActivity(value, true, "Main task").state).toBe("settling");
    expect(projectExecutionActivity({ ...value, settlementConfirmed: true }, true, "Main task").state).toBe("settled");
    expect(projectExecutionActivity({ ...value, closed: false, hasMoreStages: true }, false, "Main task"))
      .toMatchObject({ state: "unknown", detailsLimited: true });
  });
  it("does not infer activity cancellation or settlement merely from task termination", () => {
    expect(projectExecutionActivity(work({ pathId: null, purpose: null, stages: [] }), true, "Main task"))
      .toMatchObject({ state: "preparing", placement: "remaining", taskEnded: true });
  });
  it("keeps model responses foreground even when the scheduling reason is opportunity", () => {
    expect(projectExecutionActivity(work({ purpose: { id: "task.model-response", revision: "3" }, reason: "opportunity",
      stages: [stage({ status: "dispatched", capabilities: ["model-request"] })] }), false, "Main task"))
      .toMatchObject({ purpose: "task_response", placement: "foreground", title: "Task response", status: "Awaiting model result" });
  });
  it.each(["submitted", "admitted", "dispatched"] as const)("does not label a %s non-model task stage as a model request", status => {
    const item = work({ purpose: { id: "task.model-response", revision: "3" }, stages: [stage({ status })] });
    expect(projectExecutionActivity(item, false, "Main task"))
      .toMatchObject({ placement: "foreground", state: "preparing", status: "Preparing task response" });
  });
  it("identifies preparation of an actual task model stage using its declared capability", () => {
    expect(projectExecutionActivity(work({ purpose: { id: "task.model-response", revision: "3" },
      stages: [stage({ status: "admitted", capabilities: ["model-request"] })] }), false, "Main task"))
      .toMatchObject({ state: "preparing", status: "Preparing model request" });
  });
  it("does not convert an unknown purpose into a task response based on model capability", () => {
    expect(projectExecutionActivity(work({ purpose: { id: "unknown-purpose", revision: "1" },
      stages: [stage({ status: "dispatched", capabilities: ["model-request"] })] }), false, "Main task"))
      .toMatchObject({ purpose: "other", title: "Activity", placement: "support", status: "Awaiting execution result" });
  });
  it("keeps input waiting, preparation and result processing distinct", () => {
    expect(projectExecutionActivity(work({ pendingInputs: 1, stages: [] }), false, "Main task").state).toBe("waiting_input");
    expect(projectExecutionActivity(work(), false, "Main task").state).toBe("preparing");
    expect(projectExecutionActivity(work({ stages: [stage({ status: "raw_result" })] }), false, "Main task").state).toBe("processing");
  });
  it("exposes foreground input preparation before any task model stage exists", () => {
    expect(projectExecutionActivity(work({ purpose: { id: "task.model-response", revision: "3" }, pendingInputs: 1,
      stages: [stage({ status: "accepted" })] }), false, "Main task"))
      .toMatchObject({ purpose: "task_response", placement: "foreground", state: "waiting_input", status: "Waiting for input materials" });
  });
  it("does not show unknown professional identifiers as a label", () => {
    expect(projectExecutionActivity(work({ purpose: { id: "private-purpose", revision: "secret" } }), false, "Main task"))
      .toMatchObject({ purpose: "other", title: "Activity" });
  });
});

describe("Scoped readExecutionActivities", () => {
  it("uses the actual root source, with exact task scope unless descendants are requested", async () => {
    const f = fixture([work(), work({ runId: "child" }), work({ runId: "grandchild" }), work({ runId: "sibling" })]);
    const exact = await f.query.readExecutionActivities({ ...scope, runId: "child" });
    expect(exact.status === "page" && exact.items.map(item => item.runId)).toEqual(["child"]);
    const subtree = await f.query.readExecutionActivities({ ...scope, runId: "child", includeDescendants: true });
    expect(subtree.status === "page" && subtree.items.map(item => item.runId)).toEqual(["child", "grandchild"]);
    expect(f.activities).toHaveBeenCalledWith("root");
  });
  it.each([{ threadId: "other" }, { productRunId: "other" }, { runId: "unrelated" }])("rejects foreign scope before querying activities: %j", async (change) => {
    const f = fixture();
    expect(await f.query.readExecutionActivities({ ...scope, ...change })).toEqual({ status: "rejected", code: "not_found" });
    expect(f.activities).not.toHaveBeenCalled();
  });
  it("rejects invalid descendant switches and source scopes", async () => {
    const f = fixture();
    expect(await f.query.readExecutionActivities({ ...scope, includeDescendants: "all" as unknown as boolean }))
      .toEqual({ status: "rejected", code: "invalid_query" });
    expect(f.activities).not.toHaveBeenCalled();
    f.setView({ scopeId: "helarc-tree:other", revision: 8, hasMore: false, items: [work()] });
    expect(await f.query.readExecutionActivities(scope)).toEqual({ status: "rejected", code: "read_failed" });
  });
  it("does not invent membership for unknown nodes and preserves bounded-view information", async () => {
    const f = fixture([work({ runId: "unrelated" }), work({ hasMoreStages: true })]);
    const result = await f.query.readExecutionActivities({ ...scope, includeDescendants: true });
    expect(result).toMatchObject({ status: "page", revision: 7, hasMore: true, items: [{ runId: "root", detailsLimited: true }] });
    expect(JSON.stringify(result)).not.toContain("unrelated");
  });
  it("reads retained scope after restoration, independently from live Host ownership", async () => {
    const f = fixture();
    f.restore();
    expect(await f.query.readExecutionActivities(scope)).toMatchObject({ status: "page", items: [{ runId: "root" }] });
  });
  it("keeps task terminal state while exposing independent unfinished activity", async () => {
    const f = fixture([work({ cancelled: true, stages: [stage({ status: "dispatched" })] })]);
    (f.projection.display as { terminal: boolean }).terminal = true;
    expect(await f.query.readExecutionActivities(scope)).toMatchObject({ status: "page", items: [{ taskEnded: true, placement: "settlement" }] });
    expect(f.projection.display.terminal).toBe(true);
  });
  it("reports an absent reader or failed read without fabricating an empty successful snapshot", async () => {
    const f = fixture();
    const query = new HelarcWorkbenchQueries({ ...f.sources, activities: undefined });
    expect(await query.readExecutionActivities(scope)).toEqual({ status: "unavailable" });
    f.activities.mockRejectedValueOnce(new Error("secret storage location"));
    expect(await f.query.readExecutionActivities(scope)).toEqual({ status: "rejected", code: "read_failed" });
  });
});
