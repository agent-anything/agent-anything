import { describe, expect, it, vi } from "vitest";
import type { ToolResult, ToolResultStatus } from "@agent-anything/tools";
import type { EvidenceBuilderPort } from "./EvidenceBuilder.js";
import type { EvidencePersistencePort } from "../persistence/index.js";
import {
  classifyToolResult,
  settleToolResultEvidence,
} from "./EvidenceSettlement.js";

describe("Evidence settlement", () => {
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

  it("publishes the correlated EvidenceRef and ArtifactRef after persistence", async () => {
    const result = toolResult("succeeded");
    const builder = evidenceBuilder("evidence_1");
    const persistEvidence = vi.fn(async () => stored("evidence_1", "storage_1"));
    const settlement = await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: builder,
      persistence: { persistEvidence },
      isInterrupted: () => false,
    });

    expect(settlement).toEqual({
      status: "settled",
      evidenceRefs: ["evidence_1"],
      artifactRefs: ["memory://evidence/evidence_1"],
    });
    expect(persistEvidence).toHaveBeenCalledOnce();
  });

  it("retains only the confirmed reference prefix when later persistence fails", async () => {
    const result = toolResult("succeeded");
    const builder: EvidenceBuilderPort = {
      buildFromToolResult() {
        return [evidence("evidence_1", result), evidence("evidence_2", result)];
      },
    };
    let calls = 0;
    const persistence: EvidencePersistencePort = {
      async persistEvidence(item) {
        calls += 1;
        return calls === 1
          ? stored(item.id, "storage_1")
          : failedPersistence("evidence_store_unavailable");
      },
    };

    expect(await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: builder,
      persistence,
      isInterrupted: () => false,
    })).toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_1"],
      artifactRefs: ["memory://evidence/evidence_1"],
      error: {
        owner: "storage",
        code: "storage_write_failed",
        metadata: { persistenceCode: "evidence_store_unavailable" },
      },
    });
  });

  it("retains only the confirmed reference prefix when interruption wins", async () => {
    const result = toolResult("succeeded");
    const builder: EvidenceBuilderPort = {
      buildFromToolResult() {
        return [evidence("evidence_1", result), evidence("evidence_2", result)];
      },
    };
    let interrupted = false;
    const persistEvidence = vi.fn(async (item: ReturnType<typeof evidence>) => {
      interrupted = true;
      return stored(item.id, "storage_1");
    });

    expect(await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: builder,
      persistence: { persistEvidence },
      isInterrupted: () => interrupted,
    })).toEqual({
      status: "interrupted",
      evidenceRefs: ["evidence_1"],
      artifactRefs: ["memory://evidence/evidence_1"],
    });
    expect(persistEvidence).toHaveBeenCalledOnce();
  });

  it("rejects Evidence that is not correlated to the exact ToolResult", async () => {
    const result = toolResult("succeeded");
    const persistEvidence = vi.fn(async () => stored("evidence_1", "storage_1"));
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
      persistence: { persistEvidence },
      isInterrupted: () => false,
    });

    expect(settlement).toMatchObject({
      status: "failed",
      error: { owner: "tool", code: "tool_evidence_creation_failed" },
    });
    expect(persistEvidence).not.toHaveBeenCalled();
  });

  it("rejects an uncorrelated persistence receipt without publishing references", async () => {
    const result = toolResult("succeeded");
    const settlement = await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: evidenceBuilder("evidence_1"),
      persistence: {
        async persistEvidence() {
          return stored("different_evidence", "storage_1");
        },
      },
      isInterrupted: () => false,
    });

    expect(settlement).toMatchObject({
      status: "failed",
      evidenceRefs: [],
      artifactRefs: [],
      error: { owner: "storage", code: "storage_write_failed" },
    });
  });

  it("starts no Evidence work after interruption is accepted", async () => {
    const result = toolResult("succeeded");
    const buildFromToolResult = vi.fn(() => [evidence("evidence_1", result)]);
    const persistEvidence = vi.fn(async () => stored("evidence_1", "storage_1"));
    const settlement = await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
      classification: validClassification(result),
      evidenceBuilder: { buildFromToolResult },
      persistence: { persistEvidence },
      isInterrupted: () => true,
    });

    expect(settlement).toEqual({ status: "interrupted", evidenceRefs: [], artifactRefs: [] });
    expect(buildFromToolResult).not.toHaveBeenCalled();
    expect(persistEvidence).not.toHaveBeenCalled();
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

function stored(evidenceRef: string, storageId: string) {
  return {
    status: "stored" as const,
    artifact: {
      storageId,
      evidenceRef,
      artifactRef: `memory://evidence/${evidenceRef}`,
      createdAt: "2026-07-13T00:00:01.000Z",
      metadata: {},
    },
  };
}

function failedPersistence(code: string) {
  return {
    status: "failed" as const,
    error: {
      code,
      message: "Evidence persistence is unavailable.",
      retryable: true,
      metadata: {},
    },
  };
}
