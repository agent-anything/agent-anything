import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationActivityItem } from "../../shared/HelarcWorkbench.js";
import { ConversationActivity } from "./ConversationActivity.js";
import { ModelResponseProgress } from "./ConversationEntries.js";
import { DelegatedConversations } from "./DelegatedConversations.js";

const command: ConversationActivityItem = {
  id: "command", runId: "root", kind: "command", title: "dotnet build",
  attribution: null, state: "ongoing", status: "Running", startedAt: null,
  endedAt: null, detail: { kind: "command", executionId: "execution" }, child: null,
  observedAt: "2026-09-30T00:00:00.000Z",
};
const scope = {threadId:"thread", productRunId:"work", runId:"root"};

describe("Response activity disclosure", () => {
  it("shows public text and command activity together without mounting Child histories", () => {
    const renderChild = vi.fn(() => null);
    const html = renderToStaticMarkup(<DelegatedConversations visible renderChild={renderChild} items={[{
      ...command, child: {scope: {...scope, runId: "child"}, displayName: "Subtask 1", label: "Inspect",
        status: "running", relationship: "created", concurrentGroup: null, textRevision: "1",
        textPreview: {text: "The latest public text", revision: "1", disposition: null, retentionLimited: false},
        activity: {items: [{...command, runId: "child"}], activeCount: 3, omittedCount: 0, retentionLimited: false}},
    }]} />);
    expect(html).toContain("The latest public text");
    expect(html).toContain("dotnet build");
    expect(html).toContain("+2");
    expect(html).toContain('aria-label="Expand Subtask 1"');
    expect(html).not.toContain('role="tab"');
    expect(renderChild).not.toHaveBeenCalled();
  });
  it("starts with one collapsed row and exposes multiplicity without reading details", () => {
    const html = renderToStaticMarkup(<ConversationActivity scope={scope}
      items={[command, {...command,id:"other",title:"Another command"}]} revision={1} visible renderChild={() => null}/>);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("dotnet build");
    expect(html).toContain("2 operations");
    expect(html).not.toContain("Another command");
    expect(html).not.toContain("wb-activity-content");
  });
  it("shows attributed nested activity while the delegated conversation remains closed", () => {
    const renderChild = vi.fn(() => null);
    const delegated: ConversationActivityItem = {...command, id: "delegation", kind: "operation", title: "Subtask 1: Inspect files", state: "settled",
      detail: null, child: {scope: {...scope, runId: "child"}, displayName: "Subtask 1", label: "Inspect files", concurrentGroup: null, textRevision: null, textPreview: null,
        relationship: "created", status: "running", activity: {activeCount: 2, omittedCount: 0, retentionLimited: false,
          items: [{...command, id: "nested-command", runId: "nested", attribution: "Subtask 1.1"},
            {...command, id: "model", runId: "child", kind: "model", title: "Waiting for model response", status: "",
              attribution: "Subtask 1", observedAt: "2026-09-30T00:00:01.000Z"}]}}};
    const html = renderToStaticMarkup(<ConversationActivity scope={scope} items={[delegated]} revision={2} visible renderChild={renderChild}/>);
    expect(html).toContain("Subtask 1");
    expect(html).toContain("Waiting for model response");
    expect(html).toContain("+1 active");
    expect(html).not.toContain("Inspect files");
    expect(html).not.toContain("dotnet build");
    expect(renderChild).not.toHaveBeenCalled();
    const finished = {...delegated, child: {...delegated.child!, status: "completed", activity: {items: [], activeCount: 0, omittedCount: 0, retentionLimited: false}}};
    const retained = renderToStaticMarkup(<ConversationActivity scope={scope} items={[finished]} revision={3} visible renderChild={renderChild}/>);
    expect(retained).toContain("Subtask 1: Inspect files");
    expect(retained).not.toContain("wb-activity-progress-pulse");
    expect(retained).not.toContain("Waiting for model response");
  });
  it.each(["ongoing", "waiting", "settled", "inactive"] as const)("limits animation to live activity when state is %s", state => {
    for (const visible of [true, false]) {
      const html = renderToStaticMarkup(<ConversationActivity scope={scope}
        items={[{...command,state}]} revision={1} visible={visible} renderChild={() => null}/>);
      expect(html.includes("wb-activity-progress-pulse")).toBe(visible && state === "ongoing");
      expect(html).not.toContain("loader-circle");
    }
  });
  it("uses only the latest actual attempt for model progress", () => {
    const attempt = {runId:"root",requestId:"request",controllerRequestId:"controller",invocationId:"one",revision:1,
      state:"receiving",code:null,parts:[]};
    expect(renderToStaticMarkup(<ModelResponseProgress attempts={[attempt]} live/>)).toContain("Waiting for model response");
    expect(renderToStaticMarkup(<ModelResponseProgress attempts={[attempt,{...attempt,invocationId:"two",state:"committed"}]} live/>)).toBe("");
    expect(renderToStaticMarkup(<ModelResponseProgress attempts={[attempt]} live={false}/>)).toBe("");
  });
});
