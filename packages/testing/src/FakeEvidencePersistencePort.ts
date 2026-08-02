import type {
  Evidence,
  EvidencePersistencePort,
  EvidencePersistenceResult,
} from "@agent-anything/context";

export type FakeEvidencePersistenceHandler = (
  evidence: Evidence,
) => EvidencePersistenceResult | Promise<EvidencePersistenceResult>;

export class FakeEvidencePersistencePort implements EvidencePersistencePort {
  private readonly storedEvidence: Evidence[] = [];
  private nextStorageId = 1;

  constructor(
    private readonly handler?: FakeEvidencePersistenceHandler,
  ) {}

  get evidence(): readonly Evidence[] {
    return Object.freeze([...this.storedEvidence]);
  }

  async persistEvidence(evidence: Evidence): Promise<EvidencePersistenceResult> {
    this.storedEvidence.push(evidence);
    if (this.handler !== undefined) {
      return this.handler(evidence);
    }

    const storageId = `fake_evidence_${this.nextStorageId}`;
    this.nextStorageId += 1;
    return {
      status: "stored",
      artifact: {
        storageId,
        evidenceRef: evidence.id,
        artifactRef: `memory://evidence/${evidence.id}`,
        createdAt: new Date().toISOString(),
        metadata: { adapter: "fake" },
      },
    };
  }
}
