import {describe, expect, it, vi} from "vitest";
import {createCodeFileOperationContribution} from "@agent-anything/helarc-code-agent/file-operation";
import {createOperationBindingResolverSnapshot} from "@agent-anything/operation-catalog/binding";
import {snapshotExecutionEvidence, type ExecutionEvidenceRecordPort} from "@agent-anything/operation-catalog/evidence";
import type {RunActionOperationCorrelation} from "@agent-anything/operation-catalog/identity";
import type {ToolCall} from "@agent-anything/tools/invocation";
import {createHelarcCompensationBindings} from "./HelarcCompensationBindings.js";
import {withHelarcCompensationInput, withoutHelarcCompensationInput} from "./HelarcCompensationInput.js";

const now = "2026-10-16T00:00:00.000Z";
function fixture() {
  const file = createCodeFileOperationContribution({admittedAt: now,
    actionAdapterIds: {read: "read", glob: "glob", grep: "grep", edit: "edit", write: "write"}});
  const tool = withHelarcCompensationInput(file.tools.find(tool => tool.descriptor.name === "Write")!);
  const operation = file.operations.find(operation => operation.operation.ref.operation.name === "write")!;
  const action = (sequence: number) => ({run: {id: "run"}, id: `action-${sequence}`, sequence});
  const correlation = (sequence: number): RunActionOperationCorrelation => ({kind: "run_action", run: {id: "run"},
    runAction: action(sequence), materializationRevision: sequence,
    provenance: {kind: "controller", turn: {run: {id: "run"}, id: `turn-${sequence}`, sequence}, candidateIndex: 0}});
  const record = snapshotExecutionEvidence({ref: {owner: "helarc.code-agent", kind: "execution", id: "result-1", revision: "1"},
    source: {result: {id: "result-1", invocation: {id: "invocation-1", operation: operation.operation.ref}},
      resultRevision: "2", binding: operation.binding.ref, correlation: correlation(1), lowerRefs: []},
    recordedAt: now, outcome: {status: "succeeded", effectCertainty: "confirmed", completionExtent: "complete"},
    coverage: {scope: "Public outcome", extent: "partial", limitations: ["No inverse declared"]}, effects: [], support: []});
  const records: ExecutionEvidenceRecordPort = {
    commitExecutionEvidence: vi.fn(async () => {}), readExecutionEvidence: vi.fn(async () => record),
    commitCompensationAssociation: vi.fn(async () => {}), readCompensationAssociation: vi.fn(async () => null),
  };
  const base = createOperationBindingResolverSnapshot("file", file.bindings);
  const domainResolve = vi.fn(base.resolve);
  const bindings = createHelarcCompensationBindings({bindings: {...base, resolve: domainResolve}, tools: [tool], records});
  const input = {file_path: "sample.txt", content: "restored", compensation_of: {targets: [record.ref], explanation: "Changed objective"}};
  const call: ToolCall = {toolCallId: "tool-call-2", attempt: {id: "attempt-2", runAction: action(2),
    modelCall: {id: "model-call-2", controllerRequestId: "request-2"}}, parentRunAction: action(2),
    toolRevision: tool.descriptor.ref, binding: tool.descriptor.binding, selectionRevision: "selection", exposureProofId: "proof",
    origin: "model", input, inputDigest: "digest", createdAt: now};
  const request = {operation, context: {invocation: {id: "invocation-2", operation: operation.operation.ref},
    correlation: correlation(2), parentInvocation: null,
    interruption: {signal: new AbortController().signal, getCancellation: () => null}}, request: input, basis: call};
  return {record, records, base, domainResolve, tool, input, call, request, bindings};
}

describe("Helarc compensation binding", () => {
  it("separates model intent from domain input and retains the exact Call, Turn and source without promising reversal", async () => {
    const f = fixture();
    const result = await f.bindings.resolve(f.request);
    expect(result).toMatchObject({status: "resolved", binding: {kind: "direct", request: {file_path: "sample.txt", content: "restored"},
      compensation: {call: {id: "model-call-2", turnId: "turn-2"}, acceptedAt: now, targets: [{execution: f.record.ref,
        result: f.record.source.result, resultRevision: "2"}], explanation: "Changed objective"}}});
    expect(f.domainResolve.mock.calls[0]?.[0].request).not.toHaveProperty("compensation_of");
    expect(f.request.basis.input).toHaveProperty("compensation_of");
    expect(f.records.commitCompensationAssociation).toHaveBeenCalledTimes(1);
    expect(f.record.outcome.status).toBe("succeeded");
    expect(f.record.support).toEqual([]);
    await f.bindings.resolve(f.request);
    const calls = vi.mocked(f.records.commitCompensationAssociation).mock.calls;
    expect(calls[1]?.[0]).toEqual(calls[0]?.[0]);
  });

  it("leaves unassociated work unchanged", async () => {
    const f = fixture();
    const input = withoutHelarcCompensationInput(f.input);
    await expect(f.bindings.resolve({...f.request, request: input})).resolves.toMatchObject({status: "resolved", binding: {request: input}});
    expect(f.records.readExecutionEvidence).not.toHaveBeenCalled();
    expect(f.records.commitCompensationAssociation).not.toHaveBeenCalled();
  });

  it.each(["unknown", "foreign", "wrong-revision", "duplicate", "material", "malformed"])("rejects %s targets before domain resolution", async mode => {
    const f = fixture();
    let input: unknown = f.input;
    if (mode === "unknown") vi.mocked(f.records.readExecutionEvidence).mockResolvedValue(null);
    if (mode === "foreign") vi.mocked(f.records.readExecutionEvidence).mockResolvedValue({...f.record,
      source: {...f.record.source, correlation: {kind: "owner_operation", owner: "other", operationId: "x", operationRevision: "1"}}});
    if (mode === "wrong-revision") input = {...f.input, compensation_of: {targets: [{...f.record.ref, revision: "wrong"}]}};
    if (mode === "duplicate") input = {...f.input, compensation_of: {targets: [f.record.ref, f.record.ref]}};
    if (mode === "material") input = {...f.input, compensation_of: {targets: [{...f.record.ref, kind: "material"}]}};
    if (mode === "malformed") input = {...f.input, compensation_of: {targets: []}};
    await expect(f.bindings.resolve({...f.request, request: input})).resolves.toMatchObject({status: "invalid"});
    expect(f.domainResolve).not.toHaveBeenCalled();
    expect(f.records.commitCompensationAssociation).not.toHaveBeenCalled();
  });

  it.each(["read", "commit"])("preserves %s uncertainty as a required owner commit failure", async stage => {
    const f = fixture();
    vi.mocked(stage === "read" ? f.records.readExecutionEvidence : f.records.commitCompensationAssociation)
      .mockRejectedValue(new Error("lost acknowledgement"));
    await expect(f.bindings.resolve(f.request)).rejects.toMatchObject({name: "OperationCommitError"});
  });

  it("requires a trusted model caller and storage, while not inventing access from a Run Tree", async () => {
    const f = fixture();
    await expect(f.bindings.resolve({...f.request, basis: {...f.call, parentRunAction: {...f.call.parentRunAction, run: {id: "another-run"}}}}))
      .resolves.toMatchObject({status: "invalid", code: "compensation_caller_invalid"});
    const noStore = createHelarcCompensationBindings({bindings: f.base, tools: [f.tool]});
    await expect(noStore.resolve(f.request)).resolves.toMatchObject({status: "invalid", code: "execution_reference_unavailable"});
    expect(f.records.readExecutionEvidence).not.toHaveBeenCalled();
  });

  it("versions only the exposed input and rejects schema collisions", () => {
    const f = fixture();
    expect(f.tool.descriptor.schemaRevisions).toMatchObject({input: "2.compensation-v1", output: "2"});
    expect(f.tool.descriptor.inputSchema).toMatchObject({additionalProperties: false,
      properties: {compensation_of: {required: ["targets"], properties: {targets: {minItems: 1, maxItems: 64}}}}});
    expect(() => withHelarcCompensationInput(f.tool)).toThrow("compensation_of");
  });
});
