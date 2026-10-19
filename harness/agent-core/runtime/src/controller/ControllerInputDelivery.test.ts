import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "@agent-anything/model-interaction";
import { modelInputSectionLocations } from "@agent-anything/model-interaction/input";
import { RunInputNotifications, type RunInputNotification } from "../runner/RunInputNotifications.js";
import { createControllerInputDeliveryReceipt, createInputDeliverySections,
  createProviderInputDeliveryReceipt, snapshotInputDeliveryReceipt } from "./ControllerInputDelivery.js";

const fact = (sequence: number): RunInputNotification => ({runId: "run-1", sequence,
  source: {owner: "process", kind: "scope_closed", id: `process-${sequence}`, revision: "3"},
  occurredAt: "2026-10-13T00:00:00.000Z", data: {status: "completed", output: "untrusted output"}});
function setup() {
  const queue = new RunInputNotifications();
  const facts = [fact(1)];
  const source = {read: (_run: string, after: number) => facts.filter(item => item.sequence > after)};
  queue.collect("run-1", source, 8192);
  const batch = queue.prepare("run-1", "turn-1")!;
  return {queue, source, facts, batch};
}
describe("Controller input delivery", () => {
  it("separates immutable prepared content from source intake and retirement", () => {
    const {queue, source, facts, batch} = setup();
    facts.push(fact(2));
    queue.collect("run-1", source, 8192);
    expect(queue.checkpoint).toBe(2);
    expect(queue.undelivered).toBe(2);
    expect(batch.entries).toHaveLength(1);
    expect(snapshotInputDeliveryReceipt(null, batch)).toBeNull();
    expect(queue.prepare("run-1", "retry")!.entries).toHaveLength(2);
    queue.accepted(batch, createControllerInputDeliveryReceipt(batch, "turn-1"));
    expect(queue.undelivered).toBe(1);
    expect(queue.prepare("run-1", "next")!.entries.map(entry => entry.sequence)).toEqual([2]);
    expect(() => queue.accepted(batch, createControllerInputDeliveryReceipt(batch, "turn-1"))).toThrow("no longer pending");
  });
  it("requires exact actual composition membership and preserves host data, not instructions", () => {
    const {batch} = setup();
    const sections = createInputDeliverySections(batch);
    const request = {requestId: "request-1", composition: {id: "composition-1", sections}} as ProviderRequest;
    const receipt = createProviderInputDeliveryReceipt(batch, request)!;
    expect(receipt.via).toEqual({kind: "provider", requestId: "request-1", compositionId: "composition-1", sectionIds: [sections[0]!.id]});
    expect(modelInputSectionLocations(sections)[0]!.jsonPointers).toEqual(["/messages/0/content/0"]);
    expect(sections[0]).toMatchObject({role: "user", necessity: "mandatory", content: {kind: "model_message"}});
    expect(JSON.stringify(sections[0])).toContain("host_notification");
    expect(() => createProviderInputDeliveryReceipt(batch, {...request, composition: {...request.composition, sections: []}})).toThrow("complete, unchanged");
    expect(() => createProviderInputDeliveryReceipt(batch, {...request, composition: {...request.composition,
      sections: [{...sections[0]!, content: {kind: "text", text: "different"}}]}})).toThrow("complete, unchanged");
    expect(() => createProviderInputDeliveryReceipt(batch, {...request, composition: {...request.composition,
      sections: [...sections, {...sections[0]!, id: "later-assistant", role: "assistant"}]}})).toThrow("complete interaction history");
  });
  it("rejects wrong recipient, revision, entry payload, membership, and missing actual locations", () => {
    const {batch} = setup();
    const receipt = createControllerInputDeliveryReceipt(batch, "turn-1");
    for (const invalid of [
      {...receipt, batch: {...receipt.batch, runId: "other"}},
      {...receipt, batch: {...receipt.batch, revision: "2"}},
      {...receipt, entries: []},
      {...receipt, entries: [{sequence: 1, digest: "wrong"}]},
    ]) expect(() => snapshotInputDeliveryReceipt(invalid, batch)).toThrow("prepared batch");
    expect(() => snapshotInputDeliveryReceipt(receipt, null)).toThrow("prepared batch");
    expect(Object.isFrozen(batch.entries[0]!.data)).toBe(true);
  });
});
