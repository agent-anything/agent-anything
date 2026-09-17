import { describe, expect, it } from "vitest";
import type { InspectionSubjectRef } from "@agent-anything/inspection/records";
import { inspectionDetailQuery, inspectionObjectHistoryLocation, readInspectionDetailTarget, type InspectionDetailTarget } from "./InspectionDetailTarget.js";
import { inspectionReadLocation } from "./InspectionLocation.js";

const subject: InspectionSubjectRef = { sourceId: "source", datasetId: "dataset", owner: "agent-core", kind: "definition", id: "agent", runId: null, revision: "1" };
const scope = { sourceId: "source", datasetId: "dataset", watermark: 42 };

describe("Contextual inspection targets", () => {
  it("keeps object, exact record and establishing relation identities distinct", () => {
    const targets: InspectionDetailTarget[] = [{ kind: "object", subject }, { kind: "record", recordId: "historical" }, { kind: "relation", recordId: "binding-event", linkId: "binding-link" }];
    for (const target of targets) expect(readInspectionDetailTarget(JSON.stringify(target))).toEqual(target);
    expect(inspectionDetailQuery(targets[0]!, scope, "next-page")).toEqual({ ...scope, kind: "list_records", subject, limit: 20, after: "next-page" });
    expect(inspectionDetailQuery(targets[1]!, scope)).toEqual({ ...scope, kind: "get_record", recordId: "historical" });
    expect(inspectionDetailQuery(targets[2]!, scope)).toEqual({ ...scope, kind: "get_record", recordId: "binding-event" });
  });
  it("rejects incomplete targets without dropping revision or scope", () => {
    for (const value of [null, "not-json", "{}", JSON.stringify({ kind: "record", recordId: "" }),
      JSON.stringify({ kind: "relation", recordId: "event" }),
      JSON.stringify({ kind: "object", subject: { ...subject, revision: undefined } }),
      JSON.stringify({ kind: "object", subject: { ...subject, runId: 5 } }), " ".repeat(8193)]) {
      expect(readInspectionDetailTarget(value)).toBeNull();
    }
  });
  it("contextual reads do not alter or reload the underlying investigation", () => {
    const params = new URLSearchParams({ source: "source", dataset: "dataset", watermark: "42", area: "Definitions", run: "parent", record: "binding-event" });
    const original = inspectionReadLocation(params);
    params.set("detail", JSON.stringify({ kind: "object", subject: { ...subject, runId: "child" } }));
    params.set("content", JSON.stringify({ id: "body", recordId: "exact" }));
    expect(inspectionReadLocation(params)).toBe(original);
    const query = inspectionDetailQuery({ kind: "object", subject: { ...subject, kind: "request", runId: "child" } }, scope);
    expect(query).not.toHaveProperty("runId");
    expect(query).toMatchObject({ watermark: 42, subject: { runId: "child", revision: "1" } });
  });
  it("explicit history moves to the object's own scope, clearing incompatible focus", () => {
    expect(inspectionObjectHistoryLocation(subject)).toMatchObject({ area: "Definitions", view: "Records", run: null, subject: JSON.stringify(subject), detail: null, record: null, descendants: null });
    expect(inspectionObjectHistoryLocation({ ...subject, kind: "request", runId: "child" })).toMatchObject({ area: "Runs", view: "Records", run: "child", flowOccurrence: null });
  });
});
