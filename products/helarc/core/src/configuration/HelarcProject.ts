export interface HelarcProjectRef {
  readonly id: string;
  readonly revision: number;
}

export interface HelarcProject extends HelarcProjectRef {
  readonly name: string;
  readonly primaryProfileId: string;
  readonly additionalProfileIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function snapshotHelarcProject(value: unknown): HelarcProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Project must be an object.");
  }
  const project = value as Record<string, unknown>;
  const keys = ["id", "revision", "name", "primaryProfileId", "additionalProfileIds", "createdAt", "updatedAt"];
  if (Object.keys(project).length !== keys.length || keys.some(key => !Object.hasOwn(project, key)) ||
      !identity(project.id) || !Number.isSafeInteger(project.revision) || (project.revision as number) < 1 ||
      typeof project.name !== "string" || !project.name.trim() || project.name.length > 200 ||
      !identity(project.primaryProfileId) || !Array.isArray(project.additionalProfileIds) ||
      project.additionalProfileIds.length > 63 || !project.additionalProfileIds.every(identity) ||
      !timestamp(project.createdAt) || !timestamp(project.updatedAt) || project.updatedAt < project.createdAt) {
    throw new TypeError("Project identity, name, folders or revision is invalid.");
  }
  const folders = [project.primaryProfileId, ...project.additionalProfileIds];
  if (new Set(folders).size !== folders.length) throw new TypeError("Project folders must be unique.");
  return Object.freeze({
    id: project.id,
    revision: project.revision as number,
    name: project.name.trim(),
    primaryProfileId: project.primaryProfileId,
    additionalProfileIds: Object.freeze([...project.additionalProfileIds]),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
