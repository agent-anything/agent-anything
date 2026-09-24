import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkbenchActivity, WorkbenchActivityItem } from "../../shared/HelarcWorkbench.js";
import { ConversationActivity, latestActivity } from "./ConversationActivity.js";

const command: WorkbenchActivityItem = {
  id: "command", runId: "root", kind: "command", title: "dotnet build",
  attribution: null, state: "ongoing", status: "Running", startedAt: null,
  endedAt: null, detail: { kind: "command", executionId: "execution" },
};
const response: WorkbenchActivityItem = {
  ...command, id: "response", kind: "response", title: "Waiting for model response",
  status: "", detail: null,
};
function activity(current: WorkbenchActivityItem[], recent: WorkbenchActivityItem[] = []): WorkbenchActivity {
  return { current, recent, omittedCurrent: 0, omittedRecent: 0 };
}

describe("Conversation activity disclosure", () => {
  it("starts with one collapsed row and does not render detail components", () => {
    const html = renderToStaticMarkup(<ConversationActivity
      scope={{ threadId: "thread", productRunId: "work", runId: "root" }}
      activity={activity([command, response])} revision={1} visible error={false} onRetry={() => {}} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("dotnet build");
    expect(html).not.toContain("Waiting for model response");
    expect(html).not.toContain("wb-activity-list");
    expect(html).not.toContain("wb-activity-content");
  });
  it("follows newly observed activity, not the last array position", () => {
    expect(latestActivity(activity([response]), activity([command, response]), response.id)).toBe(command);
  });
  it.each(["ongoing", "waiting", "settled", "inactive"] as const)("limits text progress to live activity when state is %s", state => {
    for (const visible of [true, false]) {
      const html = renderToStaticMarkup(<ConversationActivity
        scope={{ threadId: "thread", productRunId: "work", runId: "root" }}
        activity={activity([{ ...command, state }])} revision={1} visible={visible} error={false} onRetry={() => {}} />);
      expect(html.includes("wb-activity-progress-text")).toBe(visible && state === "ongoing");
      expect(html.includes("wb-activity-progress-pulse")).toBe(visible && state === "ongoing");
      expect(html).not.toContain("loader-circle");
    }
  });
  it("follows visible state changes but preserves selection on unchanged or reordered reads", () => {
    const before = activity([command, response]);
    const receiving = { ...response, title: "Receiving model response" };
    const after = activity([command, receiving]);
    expect(latestActivity(before, after, command.id)).toBe(receiving);
    expect(latestActivity(after, activity([receiving, command]), receiving.id)).toBe(receiving);
  });
  it("follows settlement even when other work remains, then follows the next update", () => {
    const before = activity([command, response]);
    const result = { ...command, state: "settled" as const, status: "Exited with code 0" };
    const after = activity([response], [result]);
    expect(latestActivity(before, after, response.id)).toBe(result);
    const receiving = { ...response, title: "Receiving model response" };
    expect(latestActivity(after, activity([receiving], [result]), result.id)).toBe(receiving);
  });
  it("does not label polling or simultaneous unchanged rows as new work", () => {
    const before = activity([command, response]);
    expect(latestActivity(before, structuredClone(before), response.id)?.id).toBe(response.id);
    expect(latestActivity(null, activity([], [command]))).toBe(command);
    expect(latestActivity(before, activity([]), response.id)).toBeNull();
  });
});
