import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, openSync, writeFileSync, fsyncSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { INSPECTION_FORMAT_VERSION } from "../records/index.js";

export interface InspectionSource {
  readonly sourceId: string;
  readonly name: string;
  readonly application: string;
  readonly formatVersion: typeof INSPECTION_FORMAT_VERSION;
}

export interface InspectionDatasetManifest {
  readonly formatVersion: typeof INSPECTION_FORMAT_VERSION;
  readonly sourceId: string;
  readonly datasetId: string;
  readonly producerInstanceId: string;
  readonly createdAt: string;
  readonly status: "open" | "closed";
}

export function defaultInspectionRoot(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "AgentAnything", "inspection");
}

export function validateOpaqueId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new TypeError("Invalid local inspection identifier.");
}

export function containedInspectionPath(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Inspection path escapes its root.");
  let cursor = base;
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("Inspection root cannot be a link.");
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("Inspection path cannot contain links.");
  }
  if (existsSync(target) && existsSync(base)) {
    const realRel = relative(realpathSync(base), realpathSync(target));
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("Inspection real path escapes its root.");
  }
  return target;
}

export function atomicInspectionJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

export function registerInspectionSource(root: string, application: string, name: string): InspectionSource {
  const sources = containedInspectionPath(root, "sources");
  mkdirSync(sources, { recursive: true, mode: 0o700 });
  if (!application || application.length > 512 || !name || name.length > 512) throw new Error("inspection_source_invalid");
  const sourceId = createHash("sha256").update(application).digest("hex");
  const source: InspectionSource = { formatVersion: INSPECTION_FORMAT_VERSION, sourceId, application, name };
  const dir = containedInspectionPath(root, "sources", source.sourceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "source.json");
  if (existsSync(path)) {
    if (statSync(path).size > 64 * 1024) throw new Error("inspection_source_invalid");
    const existing = JSON.parse(readFileSync(path, "utf8")) as InspectionSource;
    if (existing.formatVersion !== INSPECTION_FORMAT_VERSION) throw new Error("inspection_source_unsupported");
    if (existing.application !== application || existing.sourceId !== sourceId) throw new Error("inspection_source_invalid");
    return existing;
  }
  atomicInspectionJson(path, source);
  return source;
}

export function datasetDirectory(root: string, sourceId: string, datasetId: string): string {
  validateOpaqueId(sourceId);
  validateOpaqueId(datasetId);
  return containedInspectionPath(root, "sources", sourceId, "datasets", datasetId);
}
