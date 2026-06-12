import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentTask,
  Evidence,
  Report,
  RuntimeResult,
  StoragePort,
  StoredArtifact,
  StoredArtifactKind,
} from "@agent-anything/platform";
import type { NetDoctorInput } from "../input/index.js";

export interface NetDoctorTaskHistoryEntry {
  taskId: string;
  target: string;
  symptom: string;
  status: RuntimeResult["status"] | "created";
  createdAt: string;
  updatedAt: string;
  taskDir: string;
  output: unknown | null;
  evidenceRefs: string[];
  artifactRefs: string[];
}

export class LocalNetDoctorStorage implements StoragePort {
  private readonly evidence = new Map<string, Evidence>();
  private readonly reports = new Map<string, Report>();
  private readonly artifacts = new Map<string, StoredArtifact>();

  constructor(
    private readonly rootDir: string,
    private readonly taskId: string,
  ) {}

  async storeTask(
    task: AgentTask<NetDoctorInput & { toolCalls: unknown[] }>,
  ): Promise<void> {
    await this.ensureTaskDir();
    await writeJson(this.taskFilePath("task.json"), task);
    await this.upsertHistory({
      taskId: task.id,
      target: task.input.target.normalized,
      symptom: task.input.symptom,
      status: "created",
      createdAt: task.createdAt,
      updatedAt: new Date().toISOString(),
      taskDir: this.taskDir,
      output: null,
      evidenceRefs: [],
      artifactRefs: [],
    });
  }

  async storeRuntimeResult(result: RuntimeResult): Promise<void> {
    await this.ensureTaskDir();
    await writeJson(this.taskFilePath("runtime-result.json"), result);
    await this.updateHistoryResult(result);
  }

  async storeReport(report: Report): Promise<StoredArtifact> {
    await this.ensureTaskDir();
    this.reports.set(report.id, report);
    await writeJson(this.taskFilePath("report.json"), report);

    return this.storeArtifact("report", report.id, "report.json");
  }

  async storeEvidence(evidence: Evidence): Promise<StoredArtifact> {
    await this.ensureTaskDir();
    this.evidence.set(evidence.id, evidence);

    const evidenceDir = this.taskFilePath("evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeJson(join(evidenceDir, `${evidence.id}.json`), evidence);
    await this.writeEvidenceIndex();

    return this.storeArtifact("evidence", evidence.id, join("evidence", `${evidence.id}.json`));
  }

  getEvidence(id: string): Evidence | undefined {
    return this.evidence.get(id);
  }

  getReport(id: string): Report | undefined {
    return this.reports.get(id);
  }

  getArtifact(id: string): StoredArtifact | undefined {
    return this.artifacts.get(id);
  }

  private async writeEvidenceIndex(): Promise<void> {
    await writeJson(
      this.taskFilePath("evidence.json"),
      [...this.evidence.values()],
    );
  }

  private storeArtifact(
    kind: StoredArtifactKind,
    sourceId: string,
    relativePath: string,
  ): StoredArtifact {
    const artifact: StoredArtifact = {
      id: `artifact_${kind}_${sourceId}`,
      kind,
      ref: this.taskFilePath(relativePath),
      createdAt: new Date().toISOString(),
      metadata: {
        contentType: "application/json",
        storage: "local-net-doctor",
        taskId: this.taskId,
      },
    };

    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  private async updateHistoryResult(result: RuntimeResult): Promise<void> {
    const history = await this.readHistory();
    const existing = history.find((entry) => entry.taskId === result.taskId);

    if (!existing) {
      return;
    }

    existing.status = result.status;
    existing.updatedAt = new Date().toISOString();
    existing.output = result.output;
    existing.evidenceRefs = result.evidenceRefs;
    existing.artifactRefs = result.artifactRefs;
    await writeJson(this.historyPath, history);
  }

  private async upsertHistory(entry: NetDoctorTaskHistoryEntry): Promise<void> {
    const history = await this.readHistory();
    const existingIndex = history.findIndex((item) => item.taskId === entry.taskId);

    if (existingIndex >= 0) {
      history[existingIndex] = entry;
    } else {
      history.unshift(entry);
    }

    await mkdir(this.tasksDir, { recursive: true });
    await writeJson(this.historyPath, history);
  }

  private async readHistory(): Promise<NetDoctorTaskHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : [];
    } catch {
      return [];
    }
  }

  private async ensureTaskDir(): Promise<void> {
    await mkdir(this.taskDir, { recursive: true });
  }

  private taskFilePath(relativePath: string): string {
    return join(this.taskDir, relativePath);
  }

  private get tasksDir(): string {
    return join(this.rootDir, "tasks");
  }

  private get taskDir(): string {
    return join(this.tasksDir, this.taskId);
  }

  private get historyPath(): string {
    return join(this.tasksDir, "task-history.json");
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isHistoryEntry(value: unknown): value is NetDoctorTaskHistoryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.taskId === "string" &&
    typeof record.target === "string" &&
    typeof record.symptom === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.taskDir === "string" &&
    "output" in record &&
    Array.isArray(record.evidenceRefs) &&
    Array.isArray(record.artifactRefs)
  );
}
