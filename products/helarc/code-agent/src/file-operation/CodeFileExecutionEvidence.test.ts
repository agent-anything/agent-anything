import {describe, expect, it} from "vitest";
import type {OperationResult} from "@agent-anything/operation-catalog/result";
import {CODE_FILE_CONTENT_CHANGE_SCHEMA, codeFileExecutionEffects, codeFileCompensationSupport} from "./CodeFileExecutionEvidence.js";
import {bindingRefForCodeFileTool} from "./CodeFileOperation.js";

function result(operation: "created" | "replaced" | "updated" = "replaced"): OperationResult {
  const binding = bindingRefForCodeFileTool(operation === "updated" ? "Edit" : "Write");
  const before = {target_id: "target-1", file_path: "sample.txt", byte_length: 3, content_digest: `sha256:${"a".repeat(64)}`};
  return {ref: {id: "result-1", invocation: {id: "invocation-1", operation: binding.operation}}, binding,
    semanticOwner: "helarc.code-agent", status: "succeeded",
    output: {target_id: before.target_id, file_path: before.file_path, operation,
      previous_baseline: operation === "created" ? null : before,
      current_baseline: {...before, byte_length: 5, content_digest: `sha256:${"b".repeat(64)}`},
      ...(operation === "updated" ? {replacement_count: 1} : {})},
    failure: null, startedAt: "2026-10-16T00:00:00.000Z", finishedAt: "2026-10-16T00:00:01.000Z",
    lowerRefs: [{owner: "canonical-action", kind: "action_settlement", id: "settlement-1", revision: "1"}],
    metadata: {effectCertainty: "confirmed", completionExtent: "complete"},
  } as OperationResult;
}

describe("file content effect evidence", () => {
  it.each(["created", "replaced", "updated"] as const)("retains %s observations without promising restoration", operation => {
    const source = result(operation);
    const [effect] = codeFileExecutionEffects(source);
    expect(effect).toMatchObject({ref: {kind: "effect", id: "result-1:file-content"}, schema: {id: "file-content-change", revision: "2"},
      evidence: source.lowerRefs, value: {operation, before: operation === "created" ? null : expect.objectContaining({byte_length: 3}), after: {byte_length: 5}}});
    expect(CODE_FILE_CONTENT_CHANGE_SCHEMA.validate(effect!.value)).toBe(true);
    expect(effect!.coverage.limitations.join(" ")).toContain("does not retain previous file bytes");
    expect(Object.isFrozen(effect!.value)).toBe(true);
    expect(codeFileExecutionEffects(source)).toEqual([effect]);
  });

  it.each(["failed", "partial", "denied", "cancelled", "timed_out", "invalid", "unknown_effect"] as const)(
    "does not infer a confirmed change from %s output", status => {
      expect(codeFileExecutionEffects({...result(), status} as OperationResult)).toEqual([]);
    });

  it("requires the exact owner, binding and confirmed complete outcome", () => {
    const source = result();
    expect(codeFileExecutionEffects({...source, semanticOwner: "other-owner"})).toEqual([]);
    expect(codeFileExecutionEffects({...source, binding: {...source.binding, revision: "unknown"}})).toEqual([]);
    expect(codeFileExecutionEffects({...source, metadata: {}})).toEqual([]);
    expect(codeFileExecutionEffects({...source, ref: {...source.ref, invocation: {...source.ref.invocation,
      operation: bindingRefForCodeFileTool("Read").operation}}})).toEqual([]);
  });

  it("rejects mismatched target evidence, fake digests and missing old observations", () => {
    const source = result();
    const output = source.output as Record<string, unknown>;
    for (const patch of [{file_path: "other.txt"}, {target_id: "another-target"}, {previous_baseline: null},
      {current_baseline: {...output.current_baseline as object, content_digest: "not-a-digest"}}]) {
      expect(() => codeFileExecutionEffects({...source, output: {...output, ...patch}})).toThrow("matching, validated");
    }
  });

  it("keeps empty existing content distinct from an absent old file", () => {
    const source = result();
    const output = source.output as Record<string, unknown>;
    const [effect] = codeFileExecutionEffects({...source, output: {...output,
      previous_baseline: {...output.previous_baseline as object, byte_length: 0}}});
    expect(effect!.value).toMatchObject({before: {byte_length: 0}});
  });
  it("does not interpret another Operation's similarly named output as file-owner support", () => {
    const source = result();
    const output = {file_support: {material: {availability: "available"}}};
    expect(codeFileCompensationSupport({...source, status: "failed", semanticOwner: "remote", output})).toEqual([]);
    expect(codeFileCompensationSupport({...source, status: "failed", binding: bindingRefForCodeFileTool("Read"), output})).toEqual([]);
    const effect = codeFileExecutionEffects(source)[0]!;
    expect(CODE_FILE_CONTENT_CHANGE_SCHEMA.validate({...effect.value as object, operation: "created"})).toBe(false);
  });
});
