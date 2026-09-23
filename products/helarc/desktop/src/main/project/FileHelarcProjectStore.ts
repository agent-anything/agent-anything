import { randomUUID } from "node:crypto";
import { snapshotHelarcProject, type HelarcProject } from "@agent-anything/helarc/configuration";
import type { HelarcProductCommandPayloadMap } from "../../shared/HelarcDesktopCommand.js";
import { SerializedAtomicFile } from "../persistence/SerializedAtomicFile.js";

export class FileHelarcProjectStore {
  private readonly file: SerializedAtomicFile;

  constructor(path: string) {
    this.file = new SerializedAtomicFile(path);
  }

  listProjects(): Promise<HelarcProject[]> {
    return this.file.transact(async (file) => readProjects(await file.readText()));
  }

  save(input: HelarcProductCommandPayloadMap["project.save"]): Promise<HelarcProject[]> {
    return this.file.transact(async (file) => {
      const projects = readProjects(await file.readText());
      const existing = input.id === null ? undefined : projects.find((project) => project.id === input.id);
      if ((input.id === null && input.expectedRevision !== null) ||
          (input.id !== null && (!existing || existing.revision !== input.expectedRevision))) {
        throw new Error("Project changed. Reopen its settings before saving again.");
      }
      const now = new Date().toISOString();
      const project = snapshotHelarcProject({
        id: existing?.id ?? `project-${randomUUID()}`,
        revision: (existing?.revision ?? 0) + 1,
        name: input.name.trim(),
        primaryProfileId: input.primaryProfileId,
        additionalProfileIds: input.additionalProfileIds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing && existing.updatedAt > now ? existing.updatedAt : now,
      });
      const updated = existing ? projects.map((item) => item.id === project.id ? project : item) : [...projects, project];
      await file.replaceText(JSON.stringify({ formatVersion: 1, projects: updated }, null, 2));
      return updated;
    });
  }
}

function readProjects(text: string | null): HelarcProject[] {
  if (text === null) return [];
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        Object.keys(data).sort().join(",") !== "formatVersion,projects" ||
        (data as { formatVersion?: unknown }).formatVersion !== 1 ||
        !Array.isArray((data as { projects?: unknown }).projects)) throw new Error();
    const projects = (data as { projects: unknown[] }).projects.map(snapshotHelarcProject);
    if (new Set(projects.map((project) => project.id)).size !== projects.length) throw new Error();
    return projects;
  } catch {
    throw new Error("Project Store document version or shape is invalid.");
  }
}
