import type { Evidence } from "../evidence/index.js";
import type { Report } from "../report/index.js";
import type { StoragePort } from "./StoragePort.js";
import type { StoredArtifact, StoredArtifactKind } from "./StoredArtifact.js";

export class InMemoryStorage implements StoragePort {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly reports = new Map<string, Report>();
  private readonly evidence = new Map<string, Evidence>();

  async storeReport(report: Report): Promise<StoredArtifact> {
    this.reports.set(report.id, report);

    return this.storeArtifact("report", report.id, {
      contentType: "application/json",
      storage: "in-memory",
    });
  }

  async storeEvidence(evidence: Evidence): Promise<StoredArtifact> {
    this.evidence.set(evidence.id, evidence);

    return this.storeArtifact("evidence", evidence.id, {
      contentType: "application/json",
      storage: "in-memory",
    });
  }

  getArtifact(id: string): StoredArtifact | undefined {
    return this.artifacts.get(id);
  }

  getReport(id: string): Report | undefined {
    return this.reports.get(id);
  }

  getEvidence(id: string): Evidence | undefined {
    return this.evidence.get(id);
  }

  private storeArtifact(
    kind: StoredArtifactKind,
    sourceId: string,
    metadata: StoredArtifact["metadata"],
  ): StoredArtifact {
    const artifact: StoredArtifact = {
      id: `artifact_${kind}_${sourceId}`,
      kind,
      ref: `memory://${kind}/${sourceId}`,
      createdAt: new Date().toISOString(),
      metadata,
    };

    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }
}
