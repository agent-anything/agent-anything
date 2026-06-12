import { describe, expect, it } from "vitest";
import { FakeEnterpriseStoragePort } from "../testing/index.js";
import type {
  EnterpriseStoragePort,
  StoreEnterpriseArtifactInput,
} from "./index.js";

describe("EnterpriseStoragePort", () => {
  it("stores enterprise artifact metadata", async () => {
    const storage: EnterpriseStoragePort = new FakeEnterpriseStoragePort();

    const artifact = await storage.storeArtifact(createInput());

    expect(artifact).toMatchObject({
      id: "enterprise_artifact_evidence_memory_evidence_evidence_001",
      kind: "evidence",
      ref: "memory://evidence/evidence_001",
      workspaceId: "workspace_001",
      retentionPolicyRef: "retention_30_days",
      accessPolicyRef: "access_private",
      auditRef: "audit_001",
      metadata: {
        product: "test",
      },
    });
  });

  it("records store inputs in fake enterprise storage", async () => {
    const storage = new FakeEnterpriseStoragePort();
    const input = createInput();

    await storage.storeArtifact(input);

    expect(storage.inputs).toEqual([input]);
    expect(storage.artifacts).toHaveLength(1);
  });

  it("can simulate enterprise storage failure", async () => {
    const storage = new FakeEnterpriseStoragePort(() => {
      throw new Error("Enterprise storage failed.");
    });

    await expect(storage.storeArtifact(createInput())).rejects.toThrow(
      "Enterprise storage failed.",
    );
  });

  it("allows auditRef to be omitted", async () => {
    const storage = new FakeEnterpriseStoragePort();

    const artifact = await storage.storeArtifact({
      ...createInput(),
      auditRef: undefined,
    });

    expect(artifact.auditRef).toBeNull();
  });
});

function createInput(): StoreEnterpriseArtifactInput {
  return {
    kind: "evidence",
    ref: "memory://evidence/evidence_001",
    workspaceId: "workspace_001",
    retentionPolicyRef: "retention_30_days",
    accessPolicyRef: "access_private",
    auditRef: "audit_001",
    metadata: {
      product: "test",
    },
  };
}
