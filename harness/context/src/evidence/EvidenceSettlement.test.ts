import { describe, expect, it, vi } from "vitest";
import type { ToolResult, ToolResultStatus } from "@agent-anything/tools";
import type {
  EvidenceBuilderPort,
  EvidenceEligibleToolResult,
} from "./EvidenceBuilder.js";
import type { EvidencePersistencePort } from "../persistence/index.js";
import {
  classifyToolResult,
  settleToolResultEvidence,
} from "./EvidenceSettlement.js";

describe("Evidence settlement", () => {
  it.each([
    ["succeeded", { createEvidence: true, failed: false }],
    ["partial", { createEvidence: true, failed: true }],
    ["failed", { createEvidence: false, failed: true }],
    ["timeout", { createEvidence: false, failed: true }],
  ] as const)("classifies %s ToolResult", (status, expected) => {
    expect(classifyToolResult(toolResult(status))).toEqual(expected);
  });

  it.each(["failed", "timeout"] as const)(
    "starts no Evidence work for %s ToolResult",
    async (status) => {
      const buildFromToolResult = vi.fn();
      const persistEvidence = vi.fn();
      await expect(settleToolResultEvidence({
        actionId: "action_1",
        toolResult: toolResult(status),
        evidenceBuilder: { buildFromToolResult },
        persistence: { persistEvidence },
        isInterrupted: () => false,
      })).resolves.toEqual({
        status: "settled",
        evidenceRefs: [],
        artifactRefs: [],
      });
      expect(buildFromToolResult).not.toHaveBeenCalled();
      expect(persistEvidence).not.toHaveBeenCalled();
    },
  );

  it("recognizes partial Evidence eligibility only from the typed attestation", () => {
    const result = toolResult("partial");
    expect(result).toMatchObject({
      outputUsability: "validated",
      error: { code: "tool_partial" },
    });
    expect(classifyToolResult(result)).toEqual({
      createEvidence: true,
      failed: true,
    });
  });

  it("publishes the correlated EvidenceRef and ArtifactRef after persistence", async () => {
    const result = toolResult("succeeded");
    const builder = evidenceBuilder("evidence_1");
    const persistEvidence = vi.fn(async () => stored("evidence_1", "storage_1"));
    const settlement = await settleToolResultEvidence({
      actionId: "action_1",
      toolResult: result,
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
      evidenceBuilder: { buildFromToolResult },
      persistence: { persistEvidence },
      isInterrupted: () => true,
    });

    expect(settlement).toEqual({ status: "interrupted", evidenceRefs: [], artifactRefs: [] });
    expect(buildFromToolResult).not.toHaveBeenCalled();
    expect(persistEvidence).not.toHaveBeenCalled();
  });
});

function toolResult(status: ToolResultStatus): ToolResult {
  const base = {
    toolCallId: "action_1",
    toolName: "test.external",
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
  switch (status) {
    case "succeeded":
      return { ...base, status, output: { ok: true } };
    case "partial":
      return {
        ...base,
        status,
        output: { ok: true },
        outputUsability: "validated",
        error: { code: "tool_partial", message: "partial" },
      };
    case "failed":
    case "timeout":
      return {
        ...base,
        status,
        error: { code: `tool_${status}`, message: status },
      };
  }
}

function evidenceBuilder(id: string): EvidenceBuilderPort {
  return { buildFromToolResult: ({ toolResult: result }) => [evidence(id, result)] };
}

function evidence(id: string, result: EvidenceEligibleToolResult) {
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
