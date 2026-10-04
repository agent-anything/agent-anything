import { describe, expect, it } from "vitest";
import type { ConversationBlock } from "../../shared/HelarcWorkbench.js";
import { conversationBlockGroups } from "./ConversationBlockGroups.js";

const scope = {threadId: "thread", productRunId: "product", runId: "root"};
function call(id: string, index: number, group: string | null, time = ""): ConversationBlock {
  return {kind: "activity", id, modelItemId: id, ordinal: index, item: {
    id, runId: "root", kind: "operation", title: "Delegate", attribution: null, state: "ongoing",
    status: "Pending", startedAt: null, endedAt: null, observedAt: time, detail: null,
    child: {scope: {...scope, runId: id}, label: id, displayName: `Subtask ${index + 1}`, status: "running",
      relationship: "created", activity: null, textRevision: null, textPreview: null,
      concurrentGroup: group ? {id: group, index, count: 2} : null},
  }};
}
const text: ConversationBlock = {kind: "text", id: "text", modelItemId: "text", ordinal: 2,
  text: "Parent commentary", omittedBytes: 0, detail: null, disposition: null, artifactIds: []};

describe("delegated conversation grouping", () => {
  it("uses explicit protocol membership and index, never response timestamps", () => {
    const groups = conversationBlockGroups([call("b", 1, "group", "earlier"), text, call("a", 0, "group", "later")]);
    expect(groups.map(g => g.kind)).toEqual(["delegations", "text"]);
    const group = groups[0]!;
    expect(group.kind === "delegations" && group.blocks.map(b => b.id)).toEqual(["a", "b"]);
  });
  it("does not merge serial, unknown-provenance, or separate concurrent groups", () => {
    expect(conversationBlockGroups([call("a", 0, null), call("b", 1, null),
      call("c", 0, "g1"), call("d", 0, "g2")]).map(g => g.id))
      .toEqual(["delegation:a", "delegation:b", "delegation:g1", "delegation:g2"]);
  });
  it("keeps ordinary work and later Child references in their own positions", () => {
    const original = call("reference", 0, "group") as Extract<ConversationBlock, {kind: "activity"}>;
    const referenced: ConversationBlock = {...original,
      item: {...original.item, child: {...original.item.child!, relationship: "referenced"}}};
    expect(conversationBlockGroups([call("created", 0, "group"), text, referenced]).map(g => g.kind))
      .toEqual(["delegations", "text", "activities"]);
  });
});
