import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { InspectionRecorder, InspectionRecorderError } from "@agent-anything/inspection/recording";
import { InspectionQueryService } from "@agent-anything/inspection/query";
import { HelarcInspection } from "./HelarcInspection.js";

it("preserves bounded recording failure causes without failing Desktop startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "helarc-inspection-"));
  const create = vi.spyOn(InspectionRecorder, "create");
  try {
    for (const code of ["inspection_initialization_stalled", "inspection_storage_budget_exhausted", "inspection_storage_scan_failed", "inspection_source_unsupported"]) {
      create.mockRejectedValueOnce(new InspectionRecorderError(code));
      const source = await HelarcInspection.create(join(root, "settings.json"), join(root, "inspection"));
      expect(source.snapshot().health).toMatchObject({ available: false, code });
      expect(source.recorder).toBeNull();
      await source.close();
    }
  } finally {
    create.mockRestore();
    if (!relative(tmpdir(), root).startsWith("helarc-inspection-")) throw new Error("Invalid test cleanup target");
    await rm(root, { recursive: true });
  }
});

it("persists independent capture settings and opens a new recording on source restart", {timeout: 20_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), "helarc-inspection-"));
  const path = join(root, "settings.json");
  const source = await HelarcInspection.create(path, join(root, "inspection"));
  const queries = new InspectionQueryService(join(root, "inspection"));
  try {
    expect(source.snapshot().settings).toEqual({ enabled: true, definition: true, agent: true, provider: true, execution: true });
    expect(source.snapshot().health.available).toBe(true);
    const recorder = source.recorder!;
    const basis = {runId: "retained-run", threadId: "original-thread", productRunId: "original-work",
      checkpointId: "retained-run:tree_commit:42", checkpointRevision: 42, completedAt: "2026-10-14T01:00:00.000Z"};
    source.recordRecoveredDelivery(basis);
    await recorder.flush();
    const recovered = recorder.ref("helarc", "contribution", "original-work:recovered-delivery", "retained-run");
    const recoveredScope = (await queries.query({kind: "get_snapshot", sourceId: recovered.sourceId, datasetId: recovered.datasetId})).selection!;
    const record = (await queries.query({kind: "get_subject", ...recoveredScope, subject: recovered})).records[0]!;
    expect(record.payload).toMatchObject({name: "execution.result_delivery.recovered"});
    expect(record.links.some(link => link.from.id === basis.checkpointId && link.from.revision === "42")).toBe(true);
    const recoveredContent = (await queries.query({kind: "get_content", ...recoveredScope, contentId: record.contents[0]!.id})).content!;
    expect(JSON.parse(recoveredContent.text!)).toEqual(basis);
    const bindingCheck = {runId: basis.runId, outcome: "accepted" as const, code: null,
      component: "composition", changedVariableNames: ["FNM_MULTISHELL_PATH", "Path"]};
    source.recordRecoveryBindingCheck(bindingCheck);
    await recorder.flush();
    const bindingScope = (await queries.query({kind: "get_snapshot", sourceId: recovered.sourceId, datasetId: recovered.datasetId})).selection!;
    const bindingRecords = (await queries.query({kind: "list_records", ...bindingScope, runId: basis.runId, recordKind: "event", limit: 100})).records;
    const binding = bindingRecords.find(record => record.payload.kind === "event" && record.payload.name === "execution.recovery.binding_checked")!;
    expect(binding).toBeDefined();
    expect(binding.links.some(link => link.from.id === basis.runId)).toBe(true);
    const bindingContent = (await queries.query({kind: "get_content", ...bindingScope, contentId: binding.contents[0]!.id})).content!;
    expect(JSON.parse(bindingContent.text!)).toEqual(bindingCheck);
    const subject = recorder.ref("runtime", "run", "default-capture", "default-capture");
    recorder.offer({ subject, occurredAt: null, payload: { kind: "event", name: "capture", sequence: null, code: null }, contents: (["definition", "agent", "provider", "execution"] as const).map((kind) => ({ name: kind, class: kind, stage: "received", mediaType: "application/json", value: { content: kind, apiKey: "not-for-inspection" } })) });
    await recorder.flush();
    const scope = (await queries.query({ kind: "get_snapshot", sourceId: subject.sourceId, datasetId: subject.datasetId })).selection!;
    const contents = (await queries.query({ kind: "get_subject", ...scope, subject })).records[0]!.contents;
    expect(contents).toHaveLength(4);
    for (const descriptor of contents) {
      const content = (await queries.query({ kind: "get_content", ...scope, contentId: descriptor.id })).content!;
      expect(content.descriptor).toMatchObject({ availability: "present", redacted: true });
      expect(content.text).toContain(descriptor.class);
      expect(content.text).not.toContain("not-for-inspection");
    }
    await source.save({ ...source.snapshot().settings, provider: false });
    await source.close();
    const reopened = await HelarcInspection.create(path, join(root, "inspection"));
    try {
      expect(reopened.snapshot().settings).toEqual({ enabled: true, definition: true, agent: true, provider: false, execution: true });
      expect(reopened.recorder?.source.sourceId).toBe(source.recorder?.source.sourceId);
      expect(reopened.recorder?.manifest.datasetId).not.toBe(source.recorder?.manifest.datasetId);
    } finally { await reopened.close(); }
  } finally {
    await queries.close();
    await source.close();
    if (!relative(tmpdir(), root).startsWith("helarc-inspection-")) throw new Error("Invalid test cleanup target");
    await rm(root, { recursive: true });
  }
});
