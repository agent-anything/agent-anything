import { describe, expect, it, vi } from "vitest";
import type { EvidencePersistencePort } from "../persistence/index.js";
import { EvidenceBuilder, type EvidenceBuilderPort } from "./EvidenceBuilder.js";
import { settleEvidenceContribution } from "./EvidenceSettlement.js";
import type { EvidenceContribution } from "./EvidenceSource.js";

describe("Evidence settlement", () => {
  it("publishes correlated references only after persistence", async () => {
    const evidenceId = "evidence_code-agent_operation-result_operation-result-1";
    const persistEvidence = vi.fn(async (
      item: Parameters<EvidencePersistencePort["persistEvidence"]>[0],
    ) => stored(item.id));
    const result = await settleEvidenceContribution({
      actionId: "run-action-1",
      contribution: contribution(),
      evidenceBuilder: new EvidenceBuilder(),
      persistence: { persistEvidence },
      isInterrupted: () => false,
    });
    expect(result).toEqual({
      status: "settled",
      evidenceRefs: [evidenceId],
      artifactRefs: [`memory://evidence/${evidenceId}`],
    });
    expect(persistEvidence).toHaveBeenCalledOnce();
  });

  it("retains only the confirmed prefix after a later persistence failure", async () => {
    const builder: EvidenceBuilderPort = {
      build: ({ contribution: value }) => [
        evidence("evidence_1", value),
        evidence("evidence_2", value),
      ],
    };
    let count = 0;
    const persistence: EvidencePersistencePort = {
      async persistEvidence(item) {
        count += 1;
        return count === 1 ? stored(item.id) : {
          status: "failed" as const,
          error: {
            code: "evidence_store_unavailable",
            message: "Evidence storage is unavailable.",
            retryable: true,
            metadata: {},
          },
        };
      },
    };
    await expect(settleEvidenceContribution({
      actionId: "run-action-1",
      contribution: contribution(),
      evidenceBuilder: builder,
      persistence,
      isInterrupted: () => false,
    })).resolves.toMatchObject({
      status: "failed",
      evidenceRefs: ["evidence_1"],
      artifactRefs: ["memory://evidence/evidence_1"],
      failure: { code: "context_evidence_persistence_failed" },
    });
  });

  it("starts no work after accepted interruption", async () => {
    const build = vi.fn();
    const persistEvidence = vi.fn();
    await expect(settleEvidenceContribution({
      actionId: "run-action-1",
      contribution: contribution(),
      evidenceBuilder: { build },
      persistence: { persistEvidence },
      isInterrupted: () => true,
    })).resolves.toEqual({
      status: "interrupted",
      evidenceRefs: [],
      artifactRefs: [],
    });
    expect(build).not.toHaveBeenCalled();
    expect(persistEvidence).not.toHaveBeenCalled();
  });

  it("rejects Evidence with a different source", async () => {
    const persistEvidence = vi.fn();
    const result = await settleEvidenceContribution({
      actionId: "run-action-1",
      contribution: contribution(),
      evidenceBuilder: {
        build: ({ contribution: value }) => [{
          ...evidence("evidence_1", value),
          source: { ...value.source, id: "different" },
        }],
      },
      persistence: { persistEvidence },
      isInterrupted: () => false,
    });
    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "context_evidence_creation_failed" },
    });
    expect(persistEvidence).not.toHaveBeenCalled();
  });
});

function contribution(): EvidenceContribution {
  return {
    source: {
      owner: "code-agent",
      kind: "operation-result",
      id: "operation-result-1",
      revision: "1",
      metadata: {},
    },
    settlementRefs: [{
      owner: "operation-catalog",
      kind: "operation-result",
      id: "operation-result-1",
      revision: "1",
    }],
    usability: "complete",
    summary: "Repository search result.",
    content: { matches: ["src/index.ts"] },
    metadata: {},
  };
}

function evidence(id: string, value: EvidenceContribution) {
  return {
    id,
    source: value.source,
    summary: value.summary,
    content: value.content,
    sensitivity: "restricted" as const,
    metadata: {},
  };
}

function stored(evidenceRef: string) {
  return {
    status: "stored" as const,
    artifact: {
      storageId: `storage-${evidenceRef}`,
      evidenceRef,
      artifactRef: `memory://evidence/${evidenceRef}`,
      createdAt: "2026-08-13T00:00:00.000Z",
      metadata: {},
    },
  };
}
