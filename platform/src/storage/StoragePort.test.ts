import { describe, expect, it } from "vitest";
import type { Evidence } from "../evidence/index.js";
import { InMemoryStorage } from "./InMemoryStorage.js";
import type { StoragePort } from "./StoragePort.js";

describe("InMemoryStorage", () => {
  it("stores an evidence artifact", async () => {
    const storage = new InMemoryStorage();

    const artifact = await storage.storeEvidence(createEvidence());

    expect(artifact).toMatchObject({
      id: "artifact_evidence_evidence_001",
      kind: "evidence",
      ref: "memory://evidence/evidence_001",
      metadata: {
        contentType: "application/json",
        storage: "in-memory",
      },
    });
  });

  it("returns stable references", async () => {
    const storage = new InMemoryStorage();

    const first = await storage.storeEvidence(createEvidence());
    const second = await storage.storeEvidence(createEvidence());

    expect(first.id).toBe(second.id);
    expect(first.ref).toBe(second.ref);
  });

  it("reads back artifacts when using in-memory storage", async () => {
    const storage = new InMemoryStorage();

    const artifact = await storage.storeEvidence(createEvidence());

    expect(storage.getArtifact(artifact.id)).toMatchObject({
      id: "artifact_evidence_evidence_001",
    });
    expect(storage.getEvidence("evidence_001")).toMatchObject({
      id: "evidence_001",
    });
  });

  it("can be replaced through the StoragePort contract", async () => {
    const storage: StoragePort = new InMemoryStorage();

    const artifact = await storage.storeEvidence(createEvidence());

    expect(artifact.kind).toBe("evidence");
  });
});

function createEvidence(): Evidence {
  return {
    id: "evidence_001",
    source: {
      kind: "toolResult",
      toolCallId: "tool_call_001",
      toolName: "net.lookupDns",
    },
    summary: "example.com resolves to one A record.",
    content: {
      records: ["93.184.216.34"],
    },
    sensitivity: "public",
    metadata: {
      createdFrom: "tool_call_001",
    },
  };
}
