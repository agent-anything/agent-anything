import type {
  EnterpriseStoragePort,
  EnterpriseStoredArtifact,
  StoreEnterpriseArtifactInput,
} from "../enterprise-storage/index.js";

export type FakeEnterpriseStoragePortHandler = (
  input: StoreEnterpriseArtifactInput,
) => EnterpriseStoredArtifact | Promise<EnterpriseStoredArtifact>;

export class FakeEnterpriseStoragePort implements EnterpriseStoragePort {
  readonly inputs: StoreEnterpriseArtifactInput[] = [];
  readonly artifacts: EnterpriseStoredArtifact[] = [];

  constructor(
    private readonly handler?: FakeEnterpriseStoragePortHandler,
  ) {}

  async storeArtifact(
    input: StoreEnterpriseArtifactInput,
  ): Promise<EnterpriseStoredArtifact> {
    this.inputs.push(input);

    const artifact = this.handler
      ? await this.handler(input)
      : createStoredArtifact(input);

    this.artifacts.push(artifact);
    return artifact;
  }
}

function createStoredArtifact(
  input: StoreEnterpriseArtifactInput,
): EnterpriseStoredArtifact {
  return {
    id: `enterprise_artifact_${input.kind}_${sanitizeRef(input.ref)}`,
    kind: input.kind,
    ref: input.ref,
    workspaceId: input.workspaceId,
    retentionPolicyRef: input.retentionPolicyRef,
    accessPolicyRef: input.accessPolicyRef,
    auditRef: input.auditRef ?? null,
    createdAt: "2026-06-13T00:00:00.000Z",
    metadata: input.metadata,
  };
}

function sanitizeRef(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
