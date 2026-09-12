import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { InspectionRecorder } from "../../dist/recording/InspectionRecorder.js";
import { InspectionQueryService } from "../../dist/query/InspectionQueryService.js";
import { DEFAULT_INSPECTION_CAPTURE_POLICY } from "../content/index.js";
import { snapshotInspectionJson } from "../records/InspectionValidation.js";
import { retireInspectionDatasets } from "../../dist/storage/index.js";
import { datasetDirectory } from "../sources/index.js";
import { acquireInspectionReadLease } from "../storage/InspectionDatasetAccess.js";
import { RunExecutionInspectionAdapter, RunTranscriptInspectionAdapter } from "../../dist/adapters/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function setup(rich = false) {
  const directory = mkdtempSync(join(tmpdir(), "agent-inspection-test-"));
  cleanup.push(async () => { const target = resolve(directory); if (!relative(tmpdir(), target).startsWith("agent-inspection-test-")) throw new Error("Invalid cleanup target"); rmSync(target, { recursive: true, force: true }); });
  const recorder = await InspectionRecorder.create({ root: directory, application: "test", name: "Test", policy: { ...DEFAULT_INSPECTION_CAPTURE_POLICY, agent: rich } });
  const query = new InspectionQueryService(directory);
  cleanup.push(async () => query.close()); cleanup.push(async () => recorder.flush(true));
  const subject = recorder.ref("runtime", "run", "run-1", "run-1");
  return { directory, recorder, query, subject, selection: { sourceId: subject.sourceId, datasetId: subject.datasetId } };
}
describe("Inspection recording", () => {
  it("shares source identity across producers and defers retirement while a reader holds a lease", async () => {
    const { directory, recorder, selection } = await setup();
    const other = await InspectionRecorder.create({ root: directory, application: "test", name: "Test" });
    cleanup.push(async () => other.flush(true));
    expect(other.source.sourceId).toBe(recorder.source.sourceId);
    expect(other.manifest.datasetId).not.toBe(recorder.manifest.datasetId);
    await recorder.flush(true);
    const release = acquireInspectionReadLease(datasetDirectory(directory, selection.sourceId, selection.datasetId));
    const options = { datasetId: selection.datasetId, before: "2099-01-01T00:00:00Z", apply: true };
    try { expect(retireInspectionDatasets(directory, selection.sourceId, options)[0]?.status).toBe("active"); }
    finally { release(); }
    expect(retireInspectionDatasets(directory, selection.sourceId, options)[0]?.status).toBe("removed");
    const query = new InspectionQueryService(directory);
    try { await expect(query.query({ kind: "get_snapshot", ...selection })).rejects.toThrow("inspection_dataset_cleared"); }
    finally { await query.close(); }
  });

  it("isolates a real content publication I/O failure and leaves earlier native facts readable", async () => {
    const { directory, recorder, query, subject, selection } = await setup(true);
    recorder.offer({ id: "before-fault", subject, occurredAt: null, payload: { kind: "event", name: "committed", sequence: null, code: null } });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const content = join(datasetDirectory(directory, selection.sourceId, selection.datasetId), "content");
    rmdirSync(content);
    writeFileSync(content, "not a directory");
    expect(recorder.offer({ id: "failed-publication", subject, occurredAt: null, payload: { kind: "event", name: "fault", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: "not committed" }] })).toBe(true);
    await recorder.flush();
    expect(recorder.health()).toMatchObject({ available: false, code: "inspection_storage_unavailable", queued: 0 });
    expect(recorder.health().dropped).toBeGreaterThan(0);
    expect(recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "after fault", sequence: null, code: null } })).toBe(false);
    expect((await query.query({ kind: "list_records", ...snapshot })).records.map((record) => record.id)).toEqual(["before-fault"]);
    await expect(recorder.flush(true)).resolves.toBeUndefined();
  });

  it("bounds query concurrency, cancels without changing records, and pages telemetry at the same watermark", async () => {
    const { recorder, query, subject, selection } = await setup();
    for (let i = 0; i < 6; i++) recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "page", sequence: i, code: null } });
    await recorder.flush();
    const abort = new AbortController();
    const cancelled = query.query({ kind: "get_snapshot", ...selection }, abort.signal);
    const second = query.query({ kind: "get_snapshot", ...selection });
    await expect(query.query({ kind: "get_snapshot", ...selection })).rejects.toThrow("inspection_query_busy");
    abort.abort();
    await expect(cancelled).rejects.toThrow("inspection_query_cancelled");
    const snapshot = (await second).selection!;
    const first = await query.query({ kind: "get_telemetry", ...snapshot, limit: 2 });
    const next = await query.query({ kind: "get_telemetry", ...snapshot, limit: 2, after: Number(first.next) });
    expect(first.telemetry).toHaveLength(2); expect(next.telemetry).toHaveLength(2);
    expect(next.telemetry[0]).not.toEqual(first.telemetry[0]);
    expect((await query.query({ kind: "list_records", ...snapshot })).records).toHaveLength(6);
    expect(() => query.query({ kind: "get_subject", ...snapshot, subject: { ...subject, datasetId: "different" } })).toThrow("inspection_access_denied");
  });

  it("preserves historical watermarks, Run-scoped scheduling and unknown interval coverage", async () => {
    const { recorder, query, subject, selection } = await setup();
    recorder.offer({ id: "initial", subject, occurredAt: null, payload: { kind: "snapshot", status: "running", revision: 1, agentId: "agent", parentRunId: null, taskId: "task" } });
    await recorder.flush();
    const first = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    recorder.offer({ id: "queued", subject: recorder.ref("runtime", "call", "call", subject.id), occurredAt: null, payload: { kind: "scheduling", position: 0, disposition: "queued", rule: "serial", reason: null, groupId: "decision" } });
    recorder.offer({ subject, occurredAt: "2026-09-09T00:00:03Z", payload: { kind: "interval", phase: "settled", activity: "run", status: "succeeded", clock: "source" } });
    await recorder.flush();
    const latest = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    expect((await query.query({ kind: "get_snapshot", ...first })).selection).toEqual(first);
    expect((await query.query({ kind: "get_scheduling", ...latest, subject })).records.map((record) => record.id)).toEqual(["queued"]);
    expect((await query.query({ kind: "get_timeline", ...latest })).limitations).toContain("interval_start_not_in_snapshot_page");
    expect((await query.query({ kind: "get_record", ...first, recordId: "queued" })).records).toEqual([]);
  });
  it("uses actual Run span contexts for descendants and retains state across later events", async () => {
    const { recorder, query, subject, selection } = await setup();
    const child = recorder.ref("runtime", "run", "child", "child");
    for (const [ref, phase, time] of [[subject, "started", "00"], [child, "started", "01"], [child, "settled", "02"], [subject, "settled", "03"]] as const) {
      recorder.offer({ subject: ref, occurredAt: `2026-09-09T00:00:${time}Z`, payload: { kind: "interval", phase, activity: "run", status: phase === "settled" ? "succeeded" : null, clock: "clock" },
        links: ref === child && phase === "started" ? [{ from: subject, to: child, kind: "descendant", condition: null, operation: null, sourceLocation: null, targetLocation: null }] : [] });
    }
    recorder.offer({ subject, occurredAt: null, payload: { kind: "snapshot", status: "succeeded", revision: 9, agentId: "agent", parentRunId: null, taskId: "task" } });
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "late diagnostic", sequence: null, code: null } });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    expect((await query.query({ kind: "get_subject", ...snapshot, subject })).records[0]?.payload).toMatchObject({ kind: "snapshot", status: "succeeded" });
    const spans = (await query.query({ kind: "get_telemetry", ...snapshot })).telemetry.filter((item: any) => item.kind === "span") as any[];
    const parent = spans.find((item) => item.value.links.length === 0);
    const descendant = spans.find((item) => item.value.links.length === 1);
    expect(parent.value.parentSpanContext).toBeNull();
    expect(descendant.value.parentSpanContext).toBeNull();
    expect(descendant.value.links[0].context).toEqual(parent.value.context);
    expect(descendant.value.context.traceId).not.toBe(parent.value.context.traceId);
  });

  it("joins raw Child result, delivered observation, Context admission and projection without inventing dependencies", async () => {
    const { recorder, query, selection } = await setup(true);
    const execution = new RunExecutionInspectionAdapter(recorder);
    const transcript = new RunTranscriptInspectionAdapter(recorder);
    const now = "2026-09-09T00:00:00Z";
    const projected = { ref: { id: "delegation-result", revision: "1" }, output: { answer: "child result" } };
    execution.observe({ kind: "descendant_result", runId: "run-1", occurredAt: now, parentRunActionId: "action", raw: { runId: "child", output: "raw" }, projected } as never);
    const observation = { id: "observation", owner: "agent-runtime", runId: "run-1", runAction: { id: "action" }, createdAt: now, payload: { kind: "descendant_result_transfer", result: projected, output: "delivered" } };
    transcript.observe({ runId: "run-1", sequence: 1, item: { ref: { id: "item", sequence: 1 }, createdAt: now, payload: { kind: "observation", observation } } } as never);
    const context = { ref: { id: "context", runId: "run-1", version: 1 }, createdAt: now, items: [{ ref: { id: "context-item" }, lifecycle: { kind: "active" }, contribution: { ref: { id: "contribution", revision: "1" }, source: { owner: "agent-runtime", kind: "run_observation", id: "observation", revision: "1" }, payload: { kind: "text", text: "delivered" } } }] };
    execution.observe({ kind: "context_committed", runId: "run-1", occurredAt: now, context } as never);
    execution.observe({ kind: "context_projection", runId: "run-1", occurredAt: now,
      projection: { blocks: [{ item: { id: "context-item" }, payload: { kind: "text", text: "delivered" } }] },
      manifest: { id: "manifest", activeContext: context.ref, projectionId: "projection", records: [{ item: { id: "context-item" }, contribution: { id: "contribution", revision: "1" }, disposition: "included", reason: "included_exact", transformation: null }] },
    } as never);
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const flow = (await query.query({ kind: "get_data_flow", ...snapshot })).graph!;
    expect(flow.links.map((link) => link.kind)).toEqual(expect.arrayContaining(["transforms", "delivers", "produces", "includes"]));
    expect(flow.links.some((link) => link.targetLocation?.jsonPointer === "/blocks/0")).toBe(true);
    expect((await query.query({ kind: "get_dependencies", ...snapshot })).graph?.links).toHaveLength(0);
    expect(recorder.health().rejected).toBe(0);
  });

  it("redacts encoded JSON, distinguishes missing source content, and bounds saturated ingress", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "body", sequence: null, code: null }, contents: [
      { name: "encoded", class: "agent", stage: "encoded_json", mediaType: "text/plain", value: '{"apiKey":"private-key","text":"visible"}' },
      { name: "missing", class: "agent", stage: "received", mediaType: "application/json", value: null, unavailableReason: "source_limit" },
    ] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const record = (await query.query({ kind: "list_records", ...snapshot })).records[0]!;
    const content = (await query.query({ kind: "get_content", ...snapshot, contentId: record.contents[0]!.id })).content!;
    expect(content.text).not.toContain("private-key"); expect(content.descriptor.redacted).toBe(true);
    expect(record.contents[1]).toMatchObject({ availability: "unavailable", unavailableReason: "source_limit" });
    for (let i = 0; i < 4200; i++) recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "load", sequence: i, code: null } });
    expect(recorder.health().queued).toBeLessThanOrEqual(4096);
    expect(recorder.health().dropped).toBeGreaterThan(0);
  });
  it("commits ongoing native facts before span end and projects correlated ended telemetry", async () => {
    const { recorder, query, subject, selection } = await setup();
    expect(recorder.offer({ id: "start", subject, occurredAt: "2026-09-09T00:00:00Z", payload: { kind: "interval", phase: "started", activity: "run", status: null, clock: "producer" } })).toBe(true);
    await recorder.flush();
    const snapshot = await query.query({ kind: "get_snapshot", ...selection });
    const watermark = snapshot.selection!.watermark;
    const ongoing = await query.query({ kind: "list_records", ...selection, watermark });
    expect(ongoing.records).toHaveLength(1);
    expect((await query.query({ kind: "get_telemetry", ...selection, watermark })).telemetry).toHaveLength(0);
    recorder.offer({ id: "end", subject, occurredAt: "2026-09-09T00:00:01Z", payload: { kind: "interval", phase: "settled", activity: "run", status: "succeeded", clock: "producer" } });
    await recorder.flush();
    const newer = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    expect((await query.query({ kind: "get_telemetry", ...newer })).telemetry).toHaveLength(1);
    expect((await query.query({ kind: "list_records", ...selection, watermark })).records).toHaveLength(1);
    await recorder.flush(true);
    expect((await query.query({ kind: "get_snapshot", ...selection })).coverage?.status).toBe("closed");
  });
  it("excludes disabled content and strips known credential keys from opted-in data", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "test", sequence: null, code: null }, contents: [{ name: "state", stage: "committed", class: "agent", mediaType: "application/json", value: { text: "visible", apiKey: "never-return" } }, { name: "response", stage: "response", class: "provider", mediaType: "text/plain", value: "not-retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const records = (await query.query({ kind: "list_records", ...snapshot })).records;
    expect(records[0]!.contents[1]!.availability).toBe("not_captured");
    const content = (await query.query({ kind: "get_content", ...snapshot, contentId: records[0]!.contents[0]!.id })).content!;
    expect(content.text).toContain("visible"); expect(content.text).not.toContain("never-return"); expect(content.descriptor.redacted).toBe(true);
  });
  it("deduplicates identities, reports conflicts and rejects invalid or executable payloads", async () => {
    const { recorder, query, subject, selection } = await setup();
    const input = { id: "same", subject, occurredAt: null, payload: { kind: "event" as const, name: "test", sequence: null, code: null } };
    expect(recorder.offer(input)).toBe(true); expect(recorder.offer(input)).toBe(true);
    expect(recorder.offer({ ...input, payload: { ...input.payload, name: "conflict" } })).toBe(true);
    expect(recorder.offer({ ...input, payload: { kind: "missing" } } as never)).toBe(false);
    let invoked = false;
    expect(() => snapshotInspectionJson({ get value() { invoked = true; return "bad"; } })).toThrow();
    expect(invoked).toBe(false);
    await recorder.flush();
    const snapshot = await query.query({ kind: "get_snapshot", ...selection });
    expect(snapshot.coverage?.captured).toBe(1); expect(snapshot.coverage?.rejected).toBeGreaterThan(0);
    expect(snapshot.coverage?.limitations).toContain("conflicting_record_identity");
  });
  it.each(["agent", "provider", "execution"] as const)("returns uncaptured %s metadata regardless of later capture settings", async (kind) => {
    const { recorder, query, subject, selection } = await setup();
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "uncaptured", sequence: null, code: null }, contents: [{ name: kind, stage: "received", class: kind, mediaType: "text/plain", value: "never retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const descriptor = (await query.query({ kind: "list_records", ...snapshot })).records[0]!.contents[0]!;
    const input = { kind: "get_content" as const, ...snapshot, contentId: descriptor.id };
    const expected = { descriptor: { availability: "not_captured", retainedBytes: 0, digest: null }, text: "", nextOffset: null };
    expect((await query.query(input)).content).toMatchObject(expected);
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "disabled", enabled: false });
    expect((await query.query(input)).content).toMatchObject(expected);
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "enabled", agent: true, provider: true, execution: true });
    expect((await query.query(input)).content).toMatchObject(expected);
  });
  it("keeps unavailable source content distinct from a revoked retained body", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "missing", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: null, unavailableReason: "source_limit" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const descriptor = (await query.query({ kind: "list_records", ...snapshot })).records[0]!.contents[0]!;
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "revoked" });
    expect((await query.query({ kind: "get_content", ...snapshot, contentId: descriptor.id })).content).toMatchObject({ descriptor: { availability: "unavailable", unavailableReason: "source_limit" }, text: "", nextOffset: null });
  });
  it("revokes historical content access without deleting retained records", async () => {
    const { recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "content", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: "retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const record = (await query.query({ kind: "list_records", ...snapshot })).records[0]!;
    recorder.setPolicy({ ...DEFAULT_INSPECTION_CAPTURE_POLICY, revision: "revoked" });
    await recorder.flush();
    await expect(query.query({ kind: "get_content", ...snapshot, contentId: record.contents[0]!.id })).rejects.toThrow("inspection_access_denied");
    expect((await query.query({ kind: "list_records", ...snapshot })).records).toHaveLength(1);
  });
  it("reports damaged content and retires only explicitly closed datasets", async () => {
    const { directory, recorder, query, subject, selection } = await setup(true);
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "content", sequence: null, code: null }, contents: [{ name: "body", stage: "received", class: "agent", mediaType: "text/plain", value: "retained" }] });
    await recorder.flush();
    const snapshot = (await query.query({ kind: "get_snapshot", ...selection })).selection!;
    const id = (await query.query({ kind: "list_records", ...snapshot })).records[0]!.contents[0]!.id;
    writeFileSync(join(datasetDirectory(directory, subject.sourceId, subject.datasetId), "content", id), "damaged");
    expect((await query.query({ kind: "get_content", ...snapshot, contentId: id })).content?.descriptor.availability).toBe("unavailable");
    const options = { before: "2099-01-01T00:00:00Z", apply: true };
    expect(retireInspectionDatasets(directory, subject.sourceId, options)[0]?.status).toBe("active");
    await recorder.flush(true);
    expect(retireInspectionDatasets(directory, subject.sourceId, { ...options, apply: false })[0]?.status).toBe("eligible");
    expect(retireInspectionDatasets(directory, subject.sourceId, options)[0]?.status).toBe("removed");
  });
});
