import type { ModelContinuationRef } from "@agent-anything/model-interaction/continuation";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileHelarcModelContinuationStore,
  HelarcModelContinuationStoreCorruptionError,
} from "./FileHelarcModelContinuationStore.js";

describe("FileHelarcModelContinuationStore", () => {
  it("restores one exact branch head across Store instances", async () => {
    const filePath = await storePath();
    const first = new FileHelarcModelContinuationStore(filePath);
    await expect(first.commit({
      branchId: "branch-1",
      expectedContinuationId: null,
      continuation: continuation(),
    })).resolves.toEqual({ kind: "committed" });

    const restored = new FileHelarcModelContinuationStore(filePath);
    await expect(restored.load("branch-1")).resolves.toEqual(continuation());
    await expect(restored.listContinuations()).resolves.toHaveLength(1);
  });

  it("uses compare-and-swap for advancement and clearing", async () => {
    const store = new FileHelarcModelContinuationStore(await storePath());
    await store.commit({
      branchId: "branch-1",
      expectedContinuationId: null,
      continuation: continuation(),
    });
    await expect(store.commit({
      branchId: "branch-1",
      expectedContinuationId: "stale-continuation",
      continuation: { ...continuation(), id: "continuation-2" },
    })).resolves.toEqual({ kind: "conflict" });
    await expect(store.clear({
      branchId: "branch-1",
      expectedContinuationId: "continuation-1",
    })).resolves.toEqual({ kind: "committed" });
    await expect(store.load("branch-1")).resolves.toBeNull();
  });

  it("rejects incompatible persisted versions instead of migrating them", async () => {
    const filePath = await storePath();
    await writeFile(filePath, JSON.stringify({ formatVersion: 0, records: [] }));
    await expect(new FileHelarcModelContinuationStore(filePath).listContinuations())
      .rejects.toBeInstanceOf(HelarcModelContinuationStoreCorruptionError);
  });
});

async function storePath(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "helarc-model-continuation-store-")),
    "model-continuations.json",
  );
}

function continuation(): ModelContinuationRef {
  return {
    id: "continuation-1",
    providerId: "provider-1",
    model: "model-1",
    mechanism: "response_chaining",
    predecessor: null,
    branchId: "branch-1",
    requestId: "request-1",
    responseId: "response-1",
    activeContext: { id: "context-1", runId: "run-1", version: 1 },
    protocol: { id: "protocol-1", revision: "1" },
    toolExposureContent: { id: "tools-1", revision: "1" },
    callableDefinitions: { id: "callables-1", revision: "1" },
    policy: { id: "policy-1", revision: "1" },
    state: {
      kind: "opaque_provider_state",
      handle: "opaque-provider-state",
      sensitivity: "restricted",
    },
    createdAt: "2026-08-17T00:00:00.000Z",
  };
}
