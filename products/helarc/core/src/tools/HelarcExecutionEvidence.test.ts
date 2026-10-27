import {describe, expect, it, vi} from "vitest";
import type {ToolResultPresenter} from "@agent-anything/agent-runtime/execution-coordinator";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import type {ExecutionEvidenceRecord, ExecutionEvidenceRecordPort} from "@agent-anything/operation-catalog/evidence";
import type {ToolRegistrationSnapshot} from "@agent-anything/tools/registration";
import {createHelarcToolResultPresenters} from "./HelarcToolResultPresenters.js";
import {HELARC_SHELL_OPERATION} from "./HelarcCommandIdentity.js";
import {bindingRefForCodeFileTool} from "@agent-anything/helarc-code-agent/file-operation";
import {commitHelarcExecutionEvidence, helarcExecutionReferences} from "./HelarcExecutionEvidence.js";

type Commit = Parameters<NonNullable<ToolResultPresenter["committed"]>>[0];
function setup() {
  const commitExecutionEvidence = vi.fn(async (_record: ExecutionEvidenceRecord) => {});
  const commitInitialDelivery = vi.fn();
  const records = {commitExecutionEvidence} as unknown as ExecutionEvidenceRecordPort;
  const tool = {tool: {namespace: "test", name: "shell"}, revision: "1"};
  const registrations = [{descriptor: {ref: tool, binding: {kind: "operation", operation: HELARC_SHELL_OPERATION}}}] as unknown as ToolRegistrationSnapshot["registrations"];
  const presenter = createHelarcToolResultPresenters(registrations, {commitInitialDelivery}, records)[0]!;
  const action = {run: {id: "run-1"}, id: "action-1", sequence: 1};
  const input = {
    runId: "run-1", call: {parentRunAction: action}, resultRevision: "result-2",
    correlation: {kind: "run_action", run: {id: "run-1"}, runAction: action,
      provenance: {kind: "controller", turn: {run: {id: "run-1"}, id: "turn-1", sequence: 1}, candidateIndex: 0}, materializationRevision: 1},
    result: {ref: {id: "result-1", invocation: {id: "operation-1", operation: HELARC_SHELL_OPERATION}},
      binding: {operation: HELARC_SHELL_OPERATION, revision: "2"}, semanticOwner: "helarc",
      status: "succeeded", output: {}, failure: null, lowerRefs: [{owner: "commands", kind: "process", id: "process-1", revision: "3"}],
      metadata: {}, startedAt: "2026-10-16T00:00:00.000Z", finishedAt: "2026-10-16T00:00:01.000Z"},
    presentation: {modelCallRef: {id: "call-1"}, presentation: {disposition: "complete"},
      content: {output: {observation_id: "observation-1", next_cursor: "cursor-1"}}},
  } as unknown as Commit;
  return {presenter, input, commitExecutionEvidence, commitInitialDelivery};
}

describe("Helarc committed execution evidence", () => {
  it("publishes partial Shell facts and settled process support through the shared evidence Contract", async () => {
    const {input, commitExecutionEvidence} = setup();
    const result = {...input.result, output: {task_id: "process-1", snapshot: {ref: {runId: "run-1"}, phase: "settled",
      containment: {disposition: "empty"}, limitations: []}}, status: "partial" as const,
      failure: {owner: "command", code: "output_truncated", message: "Partial capture", retryable: false, metadata: {}}};
    await commitHelarcExecutionEvidence({commitExecutionEvidence} as unknown as ExecutionEvidenceRecordPort, {...input, result});
    const record = commitExecutionEvidence.mock.calls[0]![0];
    expect(record.effects[0]?.value).toMatchObject({phase: "settled", outcome: null});
    expect(record.support[0]?.callables).toHaveLength(1);
    expect(helarcExecutionReferences(result)).toEqual([record.ref, record.effects[0]!.ref, record.support[0]!.ref]);
  });
  it("publishes the same file effect reference exposed to the model without advertising an uncaptured preimage", async () => {
    const {input, commitExecutionEvidence} = setup();
    const binding = bindingRefForCodeFileTool("Write");
    const result: OperationResult = {...input.result, ref: {...input.result.ref,
      invocation: {...input.result.ref.invocation, operation: binding.operation}}, binding, semanticOwner: "helarc.code-agent",
      metadata: {effectCertainty: "confirmed", completionExtent: "complete"},
      output: {target_id: "target-1", file_path: "new.txt", operation: "created", previous_baseline: null,
        current_baseline: {target_id: "target-1", file_path: "new.txt", byte_length: 5, content_digest: `sha256:${"a".repeat(64)}`}}};
    await commitHelarcExecutionEvidence({commitExecutionEvidence} as unknown as ExecutionEvidenceRecordPort, {...input, result});
    const record = commitExecutionEvidence.mock.calls[0]![0];
    expect(helarcExecutionReferences(result)).toEqual([record.ref, record.effects[0]!.ref]);
    expect(record.effects[0]?.value).toMatchObject({operation: "created", before: null});
    expect(record.support).toEqual([]);
    expect(record.coverage.extent).toBe("partial");
  });

  it.each(["succeeded", "failed", "partial", "denied", "cancelled", "timed_out", "invalid", "unknown_effect"] as const)(
    "retains %s outcome without inventing an effect inventory or replay-time timestamps", async status => {
    const {presenter, input, commitExecutionEvidence, commitInitialDelivery} = setup();
    const value = {...input, result: {...input.result, status, failure: status === "succeeded" ? null : {
      owner: "command", code: "reported_outcome", message: "Result", retryable: false, metadata: {},
    }} as OperationResult};
    await presenter.committed!(value);
    await presenter.committed!(value);
    const evidence = commitExecutionEvidence.mock.calls[0]?.[0];
    expect(evidence).toMatchObject({ref: {owner: "helarc", kind: "execution", id: "result-1", revision: "1"},
      source: {result: value.result.ref, resultRevision: "result-2", correlation: input.correlation, lowerRefs: value.result.lowerRefs},
      recordedAt: value.result.finishedAt, outcome: {status, effectCertainty: "unknown", completionExtent: "unknown"},
      coverage: {extent: "partial"}, effects: [], support: []});
    expect(commitExecutionEvidence.mock.calls[1]?.[0]).toEqual(evidence);
    expect(commitInitialDelivery).toHaveBeenCalledTimes(2);
  });

  it("preserves explicitly retained no-effect facts and rejects a different caller", async () => {
    const {presenter, input, commitExecutionEvidence} = setup();
    await presenter.committed!({...input, result: {...input.result, metadata: {effectCertainty: "none", completionExtent: "none"}}});
    expect(commitExecutionEvidence.mock.calls[0]?.[0]).toMatchObject({outcome: {effectCertainty: "none", completionExtent: "none"}});
    await expect(presenter.committed!({...input, runId: "another-run"})).rejects.toThrow("committed Tool caller");
    expect(commitExecutionEvidence).toHaveBeenCalledTimes(1);
  });

  it("does not infer global certainty from a truncated Composite summary", async () => {
    const {presenter, input, commitExecutionEvidence} = setup();
    await presenter.committed!({...input, result: {...input.result, metadata: {compositeSettlement: {
      children: [{effectCertainty: "none"}], omittedChildCount: 10,
    }}}});
    expect(commitExecutionEvidence.mock.calls[0]?.[0]).toMatchObject({outcome: {effectCertainty: "unknown"}});
  });

  it("does not retire initial process output when evidence acknowledgement fails", async () => {
    const {presenter, input, commitExecutionEvidence, commitInitialDelivery} = setup();
    commitExecutionEvidence.mockRejectedValueOnce(new Error("execution_storage_acknowledgement_unknown"));
    await expect(presenter.committed!(input)).rejects.toThrow("execution_storage_acknowledgement_unknown");
    expect(commitInitialDelivery).not.toHaveBeenCalled();
    await presenter.committed!(input);
    expect(commitInitialDelivery).toHaveBeenCalledTimes(1);
  });
});
