import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExecutionActivitiesPage, ExecutionActivity } from "../../shared/HelarcExecutionActivities.js";
import type { ConversationActivityItem } from "../../shared/HelarcWorkbench.js";
import { DelegatedConversations } from "../conversation/DelegatedConversations.js";
import { activitiesForScope, ChildExecutionActivity, ExecutionActivityContext, ExecutionActivitiesSummary, ForegroundActivity } from "./ExecutionActivities.js";

const scope = { threadId: "thread", productRunId: "work", runId: "root" };
function activity(changes: Partial<ExecutionActivity> = {}): ExecutionActivity {
  return { id: "hidden-activity-id", runId: "root", taskLabel: "Main task", taskEnded: false, purpose: "task_response",
    title: "Task response", state: "waiting_input", status: "Waiting for input materials", placement: "foreground",
    detailsLimited: false, ...changes };
}
function page(items: readonly ExecutionActivity[], hasMore = false): ExecutionActivitiesPage {
  return { status: "page", scope, revision: 5, items, hasMore };
}
function foreground(items: readonly ExecutionActivity[], options: { active?: boolean; responseProgress?: string | null; hasMore?: boolean } = {}) {
  return renderToStaticMarkup(<ExecutionActivityContext.Provider value={{ result: page(items, options.hasMore), failed: false }}>
    <ForegroundActivity scope={scope} active={options.active ?? true} showAvailability responseProgress={options.responseProgress ?? null} />
  </ExecutionActivityContext.Provider>);
}

describe("Read-only execution activity presentation", () => {
  it("shows input waiting at the conversation bottom without creating a message or call", () => {
    const html = foreground([activity()]);
    expect(html).toContain("Task response: Waiting for input materials");
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/hidden-activity-id|data-entry|data-model-item|tool_call|article/);
  });
  it("keeps resource queue and current authorization restrictions visible over old response progress", () => {
    for (const status of ["Waiting for resources", "Authorization temporarily restricted"]) {
      const html = foreground([activity({ state: "authorization", status })], { responseProgress: "Receiving model response" });
      expect(html).toContain(status);
      expect(html).not.toContain("Receiving model response");
    }
  });
  it("uses real model streaming progress for the dispatched task response without duplicating it", () => {
    const html = foreground([activity({ state: "running", status: "Awaiting model result" })], { responseProgress: "Receiving model response" });
    expect(html.match(/Receiving model response/g)).toHaveLength(1);
    expect(html).not.toContain("Awaiting model result");
    expect(html).not.toContain("Background");
  });
  it("does not turn support/background activity into foreground task progress", () => {
    expect(foreground([activity({ placement: "background", purpose: "context_method", title: "Context method" })])).toBe("");
    expect(foreground([activity({ placement: "support", purpose: "other", title: "Scheduled work" })])).toBe("");
  });
  it("does not attach task response streaming to a different foreground purpose", () => {
    const html = foreground([activity({ purpose: "completion_check", title: "Completion check", state: "running", status: "Awaiting execution result" })],
      { responseProgress: "Receiving model response" });
    expect(html).toContain("Completion check: Awaiting execution result");
    expect(html).not.toContain("Receiving model response");
  });
  it("never revives a terminal or inactive task to display independent settlement", () => {
    const item = activity({ taskEnded: true, placement: "settlement", state: "settling", status: "Awaiting original result" });
    expect(foreground([item], { active: false })).toBe("");
    expect(foreground([item])).toBe("");
    const html = renderToStaticMarkup(<ExecutionActivitiesSummary result={page([item])} failed={false} onRetry={() => {}} />);
    expect(html).toContain("Task ended");
    expect(html).toContain("Awaiting original result");
    expect(html).toContain("Settlement");
    expect(html).not.toMatch(/Working|Running|Resume/);
  });
  it.each(["settling", "settled"] as const)("does not restore old model progress when the %s snapshot confirms a terminal task", state => {
    expect(foreground([activity({ taskEnded: true, state, placement: "settlement" })], {
      active: true, responseProgress: "Receiving model response",
    })).toBe("");
  });
  it("never uses a Child activity as the Parent foreground state", () => {
    expect(foreground([activity({ runId: "child", status: "Child input pending" })])).toBe("");
  });
  it("removes only confirmed settled rows and does not infer an empty bounded snapshot is complete", () => {
    const html = renderToStaticMarkup(<ExecutionActivitiesSummary result={page([activity({ state: "settled", placement: "settlement" })], true)} failed={false} onRetry={() => {}} />);
    expect(html).toContain("Some activities are outside this view.");
    expect(html).not.toContain("Task response");
    expect(html).not.toMatch(/All settled|No pending/);
  });
  it("separates unfinished activity from confirmed cancellation or closure", () => {
    const html = renderToStaticMarkup(<ExecutionActivitiesSummary result={page([activity({
      placement: "remaining", taskEnded: true, title: "Scheduled work", state: "preparing", status: "Awaiting execution preparation",
    })])} failed={false} onRetry={() => {}} />);
    expect(html).toContain("Unfinished activity");
    expect(html).toContain("Task ended");
    expect(html).not.toContain("Settlement");
  });
  it("does not continue presenting stale active rows after a failed read", () => {
    const html = renderToStaticMarkup(<ExecutionActivitiesSummary result={page([activity({ placement: "background" })])} failed onRetry={() => {}} />);
    expect(html).toContain("Activity status unavailable");
    expect(html).not.toContain("Task response");
    expect(html).toContain('aria-label="Retry activity status"');
  });
  it("uses the same snapshot for Child, scoped to original work and task identity", () => {
    const result = page([activity(), activity({ runId: "child", title: "Child response" })]);
    expect(activitiesForScope(result, { ...scope, productRunId: "older-work", runId: "child" })).toEqual([]);
    expect(activitiesForScope(result, { ...scope, threadId: "other" })).toEqual([]);
    const html = renderToStaticMarkup(<ExecutionActivityContext.Provider value={{ result, failed: false }}>
      <ChildExecutionActivity scope={{ ...scope, runId: "child" }} />
    </ExecutionActivityContext.Provider>);
    expect(html).toContain("Child response: Waiting for input materials");
    expect(html).not.toContain("Task response");
    expect(html).not.toContain("hidden-activity-id");
  });
  it("shows preparation, background methods and settlement as distinct attributed groups", () => {
    const html = renderToStaticMarkup(<ExecutionActivitiesSummary failed={false} onRetry={() => {}} result={page([
      activity({ id: "support", placement: "support", title: "Input preparation" }),
      activity({ id: "background", placement: "background", title: "Context method", taskLabel: "Subtask 1" }),
      activity({ id: "settlement", placement: "settlement", title: "Source publication", state: "settling" }),
    ])} />);
    expect(html).toContain("Input preparation");
    expect(html).toContain("Context method");
    expect(html).toContain("Subtask 1");
    expect(html).toContain("Source publication");
    expect(html).not.toContain("Task response");
  });
  it("shows Child execution waiting while its conversation remains collapsed", () => {
    const item: ConversationActivityItem = {
      id: "original-call", runId: "root", kind: "operation", title: "Delegate", attribution: null,
      state: "ongoing", status: "Working", startedAt: null, endedAt: null, observedAt: "2026-11-01T00:00:00Z", detail: null,
      child: { scope: { ...scope, runId: "child" }, displayName: "Subtask 1", label: "Inspect sources", status: "running",
        relationship: "created", concurrentGroup: null, textRevision: null, textPreview: null, activity: null },
    };
    const html = renderToStaticMarkup(<ExecutionActivityContext.Provider value={{ result: page([activity({ runId: "child", state: "resource_queue", status: "Waiting for resources" })]), failed: false }}>
      <DelegatedConversations items={[item]} visible renderChild={() => <div>Unexpected history mount</div>} />
    </ExecutionActivityContext.Provider>);
    expect(html).toContain("Waiting for resources");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Unexpected history mount");
  });
});
