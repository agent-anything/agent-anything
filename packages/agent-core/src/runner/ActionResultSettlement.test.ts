import { describe, expect, it, vi } from "vitest";
import type { EvidenceBuilderPort } from "@agent-anything/evidence";
import type { StoragePort } from "@agent-anything/storage";
import type { ToolResult, ToolResultStatus } from "@agent-anything/tools";
import {
  classifyToolResult,
  settleToolResultEvidence,
} from "./ActionResultSettlement.js";

describe("ActionResultSettlement", () => {
  it.each([
    ["succeeded", { createObservation: true, createEvidence: true, failed: false }],
    ["partial", { createObservation: true, createEvidence: true, failed: true }],
    ["interrupted", { createObservation: true, createEvidence: true, failed: true }],
    ["failed", { createObservation: true, createEvidence: false, failed: true }],
    ["cancelled", { createObservation: true, createEvidence: false, failed: true }],
    ["timeout", { createObservation: true, createEvidence: false, failed: true }],
    ["skipped", { createObservation: false, createEvidence: false, failed: false }],
  ] as const)("classifies %s ToolResult", (status, expected) => {
    expect(classifyToolResult(toolResult(status))).toMatchObject({
      status: "valid",
      ...expected,
    });
  });

  it("rejects contradictory succeeded, partial, interrupted, and skipped results", () => {
    expect(classifyToolResult(toolResult("succeeded", null))).toMatchObject({
      status: "invalid",
      error: { owner: "tool", code: "tool_result_invalid" },
    });
    expect(classifyToolResult(toolResult("partial", null))).toMatchObject({ status: "invalid" });
    expect(classifyToolResult(toolResult("interrupted", null))).toMatchObject({ status: "invalid" });
    expect(classifyToolResult(toolResult("skipped", { unexpected: true }))).toMatchObject({
      status: "invalid",
    });
  });

  it("builds and stores exact Evidence references", async () => {
    const result = toolResult("succeeded");
    const builder = evidenceBuilder("evidence_1");
    const storeEvidence = vi.fn(async () => storedArtifact("artifact_1"));
    const settlement = await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: builder,
      storage: { storeEvidence },
      isInterrupted: () => false,
    });

    expect(settlement).toEqual({
      status: "settled",
      evidenceRefs: ["evidence_1"],
      artifactRefs: ["artifact_1"],
    });
    expect(storeEvidence).toHaveBeenCalledOnce();
  });

  it("retains all Evidence refs and the stored artifact prefix when Storage fails", async () => {
    const result = toolResult("succeeded");
    const builder: EvidenceBuilderPort = {
      buildFromToolResult() {
        return [evidence("evidence_1", result), evidence("evidence_2", result)];
      },
    };
    let calls = 0;
    const storage: StoragePort = {
      async storeEvidence() {
        calls += 1;
        if (calls === 2) throw new Error("Storage unavailable.");
        return storedArtifact("artifact_1");
      },
    };

    expect(await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: builder,
      storage,
      isInterrupted: () => false,
    })).toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_1", "evidence_2"],
      artifactRefs: ["artifact_1"],
      error: { owner: "storage", code: "storage_write_failed" },
    });
  });

  it("rejects Evidence that is not correlated to the exact ToolResult", async () => {
    const result = toolResult("succeeded");
    const storeEvidence = vi.fn(async () => storedArtifact("artifact_1"));
    const settlement = await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: {
        buildFromToolResult() {
          return [{
            ...evidence("evidence_1", result),
            source: {
              kind: "toolResult",
              toolCallId: "different_action",
              toolName: result.toolName,
              metadata: {},
            },
          }];
        },
      },
      storage: { storeEvidence },
      isInterrupted: () => false,
    });

    expect(settlement).toMatchObject({
      status: "failed",
      error: { owner: "tool", code: "tool_evidence_creation_failed" },
    });
    expect(storeEvidence).not.toHaveBeenCalled();
  });

  it("starts no Evidence work after interruption is accepted", async () => {
    const result = toolResult("succeeded");
    const buildFromToolResult = vi.fn(() => [evidence("evidence_1", result)]);
    const settlement = await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: { buildFromToolResult },
      storage: { async storeEvidence() { return storedArtifact("artifact_1"); } },
      isInterrupted: () => true,
    });

    expect(settlement).toEqual({ status: "interrupted", evidenceRefs: [], artifactRefs: [] });
    expect(buildFromToolResult).not.toHaveBeenCalled();
  });
});

function toolResult(status: ToolResultStatus, output: unknown = defaultOutput(status)): ToolResult {
  return {
    toolCallId: "action_1",
    toolName: "test.external",
    status,
    output,
    error: status === "succeeded" || status === "skipped"
      ? null
      : { code: `tool_${status}`, message: status },
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}

function defaultOutput(status: ToolResultStatus): unknown {
  return status === "succeeded" || status === "partial" || status === "interrupted"
    ? { ok: true }
    : null;
}

function validClassification(result: ToolResult) {
  const classification = classifyToolResult(result);
  if (classification.status !== "valid") throw new Error("Expected valid ToolResult.");
  return classification;
}

function evidenceBuilder(id: string): EvidenceBuilderPort {
  return { buildFromToolResult: ({ toolResult: result }) => [evidence(id, result)] };
}

function evidence(id: string, result: ToolResult) {
  return {
    id,
    source: {
      kind: "toolResult" as const,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      metadata: {},
    },
    summary: "Evidence",
    content: result.output,
    sensitivity: "public" as const,
    metadata: {},
  };
}

function storedArtifact(id: string) {
  return {
    id,
    kind: "evidence" as const,
    ref: `memory://evidence/${id}`,
    createdAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}
