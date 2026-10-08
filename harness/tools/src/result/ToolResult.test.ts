import { describe, expect, it } from "vitest";
import type { ToolCall } from "../invocation/index.js";
import { adaptToolSemanticResult } from "./ToolResult.js";

describe("adaptToolSemanticResult", () => {
  it.each(["failed", "partial"] as const)("preserves approval quota detail in a %s Tool result", status => {
    const detail = {kind: "capacity", stage: "admission", scope: {owner: "test-owner", kind: "operation"},
      limit: {name: "requests", count: 8, maximum: 8}, dispatch: "never_dispatched",
      description: "Request capacity reached; action was never dispatched."} as const;
    const call = {toolCallId: "call", toolRevision: {tool: {namespace: "test", name: "tool"}, revision: "1"}} as ToolCall;
    const result = adaptToolSemanticResult(call, {
      operationInvocation: {id: "invocation", operation: {operation: {namespace: "test", name: "operation"}, revision: "1"}},
      status, output: status === "partial" ? {completed: ["other-child"]} : null,
      error: {code: "approval_tree_total_limit_exceeded", message: "Approval request limit reached.", detail},
      startedAt: "2026-10-08T00:00:00.000Z", finishedAt: "2026-10-08T00:00:00.000Z", metadata: {},
    });
    expect(result).toMatchObject({status, error: {code: "approval_tree_total_limit_exceeded", detail}});
  });
});
