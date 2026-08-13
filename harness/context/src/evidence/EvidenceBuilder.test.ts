import { describe, expect, it } from "vitest";
import { EvidenceBuilder, snapshotEvidenceContribution } from "./EvidenceBuilder.js";
import type { EvidenceContribution } from "./EvidenceSource.js";

describe("EvidenceBuilder", () => {
  it("builds conservatively classified Evidence from an owner contribution", () => {
    const evidence = new EvidenceBuilder().build({ contribution: contribution() });

    expect(evidence).toEqual([{
      id: "evidence_code-agent_operation-result_operation-result-1",
      source: {
        owner: "code-agent",
        kind: "operation-result",
        id: "operation-result-1",
        revision: "1",
        metadata: { adapter: "fake" },
      },
      summary: "Repository search result.",
      content: { matches: ["src/index.ts"] },
      sensitivity: "restricted",
      metadata: {
        contributionUsability: "complete",
        settlementRefs: [{
          owner: "operation-catalog",
          kind: "operation-result",
          id: "operation-result-1",
          revision: "1",
        }],
      },
    }]);
  });

  it("accepts partial material only through an explicit usability attestation", () => {
    const [evidence] = new EvidenceBuilder().build({
      contribution: contribution("partial_validated"),
      sensitivity: "private",
    });
    expect(evidence?.metadata).toMatchObject({
      contributionUsability: "partial_validated",
    });
    expect(evidence?.sensitivity).toBe("private");
  });

  it("rejects missing settlement correlation", () => {
    expect(() => snapshotEvidenceContribution({
      ...contribution(),
      settlementRefs: [],
    } as never)).toThrow(/settlement reference/);
  });

  it("never trusts sensitivity-like contribution metadata", () => {
    const [evidence] = new EvidenceBuilder().build({
      contribution: {
        ...contribution(),
        metadata: { sensitivity: "public" },
      },
    });
    expect(evidence?.sensitivity).toBe("restricted");
  });
});

function contribution(
  usability: EvidenceContribution["usability"] = "complete",
): EvidenceContribution {
  return {
    source: {
      owner: "code-agent",
      kind: "operation-result",
      id: "operation-result-1",
      revision: "1",
      metadata: { adapter: "fake" },
    },
    settlementRefs: [{
      owner: "operation-catalog",
      kind: "operation-result",
      id: "operation-result-1",
      revision: "1",
    }],
    usability,
    summary: "Repository search result.",
    content: { matches: ["src/index.ts"] },
    metadata: {},
  };
}
