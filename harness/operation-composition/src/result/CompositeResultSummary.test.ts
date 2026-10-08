import { describe, expect, it } from "vitest";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type { CompositeNodeSettlement, CompositeResult } from "./CompositeResult.js";
import { createCompositeResultSummary, readCompositeResultSummary } from "./CompositeResultSummary.js";

describe("CompositeResultSummary", () => {
  it("preserves nested approval quota detail without flattening to the composite failure", () => {
    const detail = {kind: "capacity", stage: "approval_admission", scope: {owner: "agent-runtime", kind: "run_tree"},
      limit: {name: "total_requests", count: 8, maximum: 8}, dispatch: "never_dispatched",
      description: "Approval capacity reached; action was never dispatched."} as const;
    const rejected = child("start", "invalid", "approval_tree_total_limit_exceeded");
    if (!rejected.result?.failure) throw new Error("Expected failed result.");
    const result = {...rejected.result, status: "failed" as const, failure: {...rejected.result.failure,
      owner: "agent-runtime", detail: {...detail, private: "private-detail"}}};
    const inner = createCompositeResultSummary(composite([{...rejected, status: "failed", result}]));
    const summary = createCompositeResultSummary(composite([{...rejected, result: {...rejected.result,
      metadata: {compositeSettlement: inner}}}]));
    expect(summary.children[0]?.composite?.children[0]).toMatchObject({
      failure: {owner: "agent-runtime", code: "approval_tree_total_limit_exceeded", detail},
      effectCertainty: "none", completionExtent: "none",
    });
    expect(readCompositeResultSummary(summary)).toEqual(summary);
    expect(JSON.stringify(summary)).not.toContain("private-detail");
    expect(JSON.stringify(summary)).not.toContain("private-payload");
  });

  it("retains a failed step's operation, permission cause and no-effect facts without payload metadata", () => {
    const result = composite([child("start", "invalid", "interaction_expired")]);
    expect(createCompositeResultSummary(result)).toMatchObject({status: "failed", omittedChildCount: 0, children: [{
      nodeId: "start", status: "invalid", operation: {operation: {namespace: "test", name: "start"}, revision: "1"},
      failure: {owner: "permission", code: "interaction_expired"},
      effectCertainty: "none", completionExtent: "none",
    }]});
    expect(JSON.stringify(createCompositeResultSummary(result))).not.toContain("private-payload");
  });

  it("keeps successful effects alongside failed and unknown steps without certifying the whole workflow", () => {
    const wrote = child("write", "succeeded");
    const unknown = child("lost", "unknown_effect", "lost_settlement");
    const summary = createCompositeResultSummary(composite([wrote, child("denied", "invalid", "interaction_expired"), unknown], "partial"));
    expect(summary.status).toBe("partial");
    expect(summary.children.find(c => c.nodeId === "write")).toMatchObject({effectCertainty: "confirmed", completionExtent: "complete"});
    expect(summary.children.find(c => c.nodeId === "lost")).toMatchObject({effectCertainty: "unknown", completionExtent: "unknown"});
  });

  it("preserves missing-result failures and does not invent effects or operation references", () => {
    const summary = createCompositeResultSummary(composite([{nodeId: "prepare", instance: 1, runAction: null,
      status: "failed", result: null, failure: {code: "composite_transform_failed", message: "Transform failed", retryable: false, metadata: {secret: "private-payload"}}}]));
    expect(summary.children[0]).toMatchObject({operation: null, resultId: null, effectCertainty: null,
      completionExtent: null, failure: {owner: "operation-composition", code: "composite_transform_failed"}});
  });

  it("prioritizes failures in a bounded summary and preserves truncation across metadata reads", () => {
    const children = Array.from({length: 40}, (_, i) => child(`ok-${i}`, "succeeded"));
    const last = child("last", "invalid", "denied");
    if (!last.result?.failure) throw new Error("Expected failure.");
    const failure = {...last.result.failure, message: "x".repeat(1_500)};
    const summary = createCompositeResultSummary(composite([...children, {...last, result: {...last.result, failure}}]));
    expect(summary.children).toHaveLength(32);
    expect(summary.omittedChildCount).toBe(9);
    expect(summary.children[0]).toMatchObject({nodeId: "last", failure: {messageTruncated: true}});
    expect(readCompositeResultSummary(summary)).toEqual(summary);
  });

  it("does not copy arbitrary metadata or invalid summaries", () => {
    expect(readCompositeResultSummary({children: []})).toBeNull();
    const summary = createCompositeResultSummary(composite([child("ok", "succeeded")]));
    expect(readCompositeResultSummary({...summary, credential: "private-payload", children: summary.children.map(c => ({...c, output: "private-payload"}))})).toEqual(summary);
  });

  it("retains nested failure causes under one shared node and depth budget", () => {
    const inner = createCompositeResultSummary(composite([child("start", "invalid", "interaction_expired")]));
    const outer = child("nested", "invalid", "composite_failed");
    if (outer.result === null) throw new Error("Expected result.");
    const wrap = (nested: unknown) => createCompositeResultSummary(composite([{...outer, result: {
      ...outer.result!, metadata: {compositeSettlement: nested},
    }}]));
    const projected = wrap(inner);
    expect(projected.children[0]?.composite?.children[0]?.failure?.code).toBe("interaction_expired");
    let deep = inner;
    for (let i = 0; i < 8; i += 1) deep = wrap(deep);
    expect(JSON.stringify(deep)).toContain('"nestedSummaryOmitted":true');
    expect(readCompositeResultSummary(deep)).toEqual(deep);
    const wide = wrap(createCompositeResultSummary(composite(Array.from({length: 40}, (_, i) => child(`failed-${i}`, "invalid", "denied")))));
    expect(wide.children[0]?.composite?.children).toHaveLength(31);
    expect(wide.children[0]?.composite?.omittedChildCount).toBe(9);
  });
});

function composite(children: readonly CompositeNodeSettlement[], status: CompositeResult["status"] = "failed"): CompositeResult {
  return {compositeId: "composite-1", definition: {id: "definition", revision: "1"}, status, children,
    output: null, failure: {code: "composite_failed", message: "Failed", retryable: false, metadata: {}},
    startedAt: "2026-09-30T00:00:00.000Z", finishedAt: "2026-09-30T00:00:01.000Z"};
}

function child(nodeId: string, status: "succeeded" | "invalid" | "unknown_effect", code?: string): CompositeNodeSettlement {
  const operation = {operation: {namespace: "test", name: nodeId}, revision: "1"};
  const failure = code ? {owner: "permission", code, message: code, retryable: false, metadata: {secret: "private-payload"}} : null;
  const result = {ref: {id: `result-${nodeId}`, invocation: {id: `invocation-${nodeId}`, operation}},
    binding: {operation, revision: "1"}, semanticOwner: "test", status,
    output: status === "succeeded" ? {secret: "private-payload"} : null, failure,
    startedAt: "2026-09-30T00:00:00.000Z", finishedAt: "2026-09-30T00:00:01.000Z",
    lowerRefs: [{owner: "canonical-action", kind: "action_settlement", id: `action-${nodeId}`, revision: "1"}],
    metadata: {effectCertainty: status === "succeeded" ? "confirmed" : status === "invalid" ? "none" : "unknown",
      completionExtent: status === "succeeded" ? "complete" : status === "invalid" ? "none" : "unknown"},
  } as OperationResult;
  return {nodeId, instance: 1, runAction: null, status, result, failure};
}
