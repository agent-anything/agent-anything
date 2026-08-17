import type { SafeProjectionManifest } from "@agent-anything/context/projection";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileHelarcContextManifestStore,
  HelarcContextManifestStoreCorruptionError,
} from "./FileHelarcContextManifestStore.js";

describe("FileHelarcContextManifestStore", () => {
  it("persists only the safe Manifest projection and restores it", async () => {
    const filePath = await storePath();
    const store = new FileHelarcContextManifestStore(filePath);
    await expect(store.persistManifest(manifest())).resolves.toEqual({
      kind: "stored",
      recordId: "manifest-1",
    });

    await expect(new FileHelarcContextManifestStore(filePath).listManifests())
      .resolves.toEqual([manifest()]);
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain("payload");
    expect(persisted).not.toContain("sourceRef");
    expect(persisted).not.toContain("itemId");
  });

  it("rejects incompatible persisted versions instead of migrating them", async () => {
    const filePath = await storePath();
    await writeFile(filePath, JSON.stringify({ formatVersion: 2, records: [] }));
    await expect(new FileHelarcContextManifestStore(filePath).listManifests())
      .rejects.toBeInstanceOf(HelarcContextManifestStoreCorruptionError);
  });
});

async function storePath(): Promise<string> {
  return join(
    await mkdtemp(join(tmpdir(), "helarc-context-manifest-store-")),
    "context-manifests.json",
  );
}

function manifest(): SafeProjectionManifest {
  return {
    schemaVersion: 1,
    manifestId: "manifest-1",
    projectionId: "projection-1",
    requestId: "request-1",
    activeContextId: "context-1",
    activeContextVersion: 1,
    profileId: "profile-1",
    profileRevision: "1",
    policyId: "policy-1",
    policyRevision: "1",
    estimatorId: "estimator-1",
    estimatorRevision: "1",
    accountingUnit: "bytes",
    budgetMaximum: 4096,
    consideredItemCount: 1,
    projectedItemCount: 1,
    projectedAmount: 128,
    dispositionCounts: {
      included: 1,
      transformed: 0,
      referenced: 0,
      omitted: 0,
      rejected: 0,
      blocked: 0,
    },
    outcome: "projected",
    code: null,
    createdAt: "2026-08-17T00:00:00.000Z",
  };
}
