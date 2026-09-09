import { describe, expect, it, vi } from "vitest";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { InspectionTelemetry } from "./InspectionTelemetry.js";
import type { InspectionRecord } from "../records/index.js";

const record: InspectionRecord = {
  id: "record", subject: { sourceId: "source", datasetId: "dataset", owner: "runtime", kind: "run", id: "run", runId: "run", revision: null },
  occurredAt: null, capturedAt: "2026-09-09T00:00:00Z", ownerSequence: null, captureSequence: 1, commitSequence: 1, policyRevision: "1", contents: [], links: [],
  payload: { kind: "event", name: "observed", code: null, sequence: null },
};

describe("Local telemetry failure isolation", () => {
  it("bounds ended export work and reports rejected writes without throwing into native recording", async () => {
    const telemetry = new InspectionTelemetry("source", "dataset");
    for (let i = 0; i < 2200; i++) telemetry.accept({ ...record, id: `record-${i}`, commitSequence: i + 1 });
    expect(telemetry.dropped).toBe(152);
    let writes = 0;
    await expect(telemetry.flush(() => { writes++; throw new Error("disk unavailable"); })).resolves.toBeUndefined();
    expect(writes).toBe(2048); expect(telemetry.dropped).toBe(2200);
    telemetry.accept(record);
    await telemetry.close(() => { writes++; });
    expect(writes).toBe(2049);
  });

  it("accounts for an SDK flush failure without losing an already queued local export", async () => {
    const telemetry = new InspectionTelemetry("source", "dataset");
    telemetry.accept(record);
    const failure = vi.spyOn(BasicTracerProvider.prototype, "forceFlush").mockRejectedValueOnce(new Error("SDK failure"));
    let writes = 0;
    try {
      await expect(telemetry.flush(() => { writes++; })).resolves.toBeUndefined();
      expect(writes).toBe(1); expect(telemetry.dropped).toBe(1);
    } finally { failure.mockRestore(); await telemetry.close(() => {}); }
  });
});
