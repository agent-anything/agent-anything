import { expect, it } from "vitest";
import { OPENAI_RESPONSES, nativeModelSourceKey, type NativeModelSourceRef } from "@agent-anything/model-interaction/protocol";
import type { InspectionRecordInput, InspectionSubjectRef } from "../records/index.js";
import { validateInspectionInput } from "../records/InspectionValidation.js";
import { ProtocolEvidenceInspectionAdapter } from "./ProtocolEvidenceInspectionAdapter.js";
import { createNativeModelCallRef } from "@agent-anything/model-interaction";
import type { InspectionRecorder } from "../recording/index.js";
import { RunExecutionInspectionAdapter } from "./RunExecutionInspectionAdapter.js";

it("records exact native sources and purpose acceptance without a transport, credential or common lifecycle", () => {
  const records: InspectionRecordInput[] = [];
  const recorder = {
    ref(owner: string, kind: InspectionSubjectRef["kind"], id: string, runId: string | null = null, revision: string | null = null): InspectionSubjectRef {
      return { sourceId: "source", datasetId: "dataset", owner, kind, id, runId, revision };
    },
    offer(value: InspectionRecordInput) { records.push(value); },
  };
  const adapter = new ProtocolEvidenceInspectionAdapter(recorder);
  const source: NativeModelSourceRef = { scope: { runId: "root", activityId: "activity", recipientId: "task", purpose: { id: "task", revision: "1" }, compositionDigest: `sha256:${"a".repeat(64)}` },
    protocol: OPENAI_RESPONSES, interpretation: { id: "original-reader", revision: "1" }, operationId: "operation",
    record: { id: "observed", revision: "1" }, position: { format: "json-pointer", value: "/output/0" }, nativeIdentity: { kind: "response", id: "same-remote-id" } };
  const next = { ...source, record: { ...source.record, revision: "2" } };
  adapter.source(source); adapter.source(next);
  const evidence={ scope: source.scope, sources: [source], interpreter: { id: "task-interpreter", revision: "1" }, acceptance: { id: "accepted", revision: "1" } };
  adapter.accepted(evidence);
  expect(records[0]!.subject.id).toBe(nativeModelSourceKey(source));
  expect(records[1]!.subject.id).not.toBe(records[0]!.subject.id);
  expect(records[2]!.links?.[0]?.from.id).toBe(records[0]!.subject.id);
  expect(records[2]!.links?.[0]?.to.id).toBe("accepted");
  expect(records.every(record => record.subject.kind !== "turn")).toBe(true);
  expect(records[0]!.contents?.[0]?.name).toContain("not the native body");
  const call = createNativeModelCallRef({ providerRequestId: "original-operation", controllerRequestId: "task-decision",
    branchId: "root", contentBlockOrdinal: 0, nativeSource: source, purposeAcceptance: { id: "accepted", revision: "1" } });
  new RunExecutionInspectionAdapter(recorder as InspectionRecorder).observe({ kind: "scheduling", runId: "root", occurredAt: null,
    call, position: 0, disposition: "admitted", rule: "local-call", groupId: null, reason: null });
  const scheduling = records.at(-1)!;
  expect(scheduling.subject.id).toBe(call.id);
  expect(scheduling.links).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "binding", from: expect.objectContaining({ id: nativeModelSourceKey(source) }) }),
    expect.objectContaining({ kind: "produces", from: expect.objectContaining({ id: "accepted", revision: "1" }) }),
  ]));
  expect(records.flatMap(record => record.links ?? []).every(link => link.from.kind !== "turn" && link.to.kind !== "turn")).toBe(true);
  for (const record of records) expect(() => validateInspectionInput(record)).not.toThrow();
  adapter.source(source);
  expect(records.at(-1)).toEqual(records[0]);
  expect(records[0].occurredAt).toBeNull();
  adapter.accepted(evidence);
  expect(records.at(-1)).toEqual(records[2]);
});
