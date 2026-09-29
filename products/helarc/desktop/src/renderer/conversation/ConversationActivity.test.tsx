import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationActivityItem } from "../../shared/HelarcWorkbench.js";
import { ConversationActivity } from "./ConversationActivity.js";
import { ModelResponseProgress } from "./ConversationEntries.js";

const command: ConversationActivityItem = {
  id: "command", runId: "root", kind: "command", title: "dotnet build",
  attribution: null, state: "ongoing", status: "Running", startedAt: null,
  endedAt: null, detail: { kind: "command", executionId: "execution" }, child: null,
};
const scope = {threadId:"thread", productRunId:"work", runId:"root"};

describe("Response activity disclosure", () => {
  it("starts with one collapsed row and exposes multiplicity without reading details", () => {
    const html = renderToStaticMarkup(<ConversationActivity scope={scope}
      items={[command, {...command,id:"other",title:"Another command"}]} revision={1} visible renderChild={() => null}/>);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("dotnet build");
    expect(html).toContain("2 operations");
    expect(html).not.toContain("Another command");
    expect(html).not.toContain("wb-activity-content");
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
