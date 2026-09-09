import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { inspectionSubjectKey, INSPECTION_FORMAT_VERSION, type InspectionRecord, type InspectionCoverage, type InspectionContentDescriptor } from "../records/index.js";
import { containedInspectionPath, validateOpaqueId, type InspectionDatasetManifest } from "../sources/index.js";

export interface InspectionContentWrite { readonly descriptor: InspectionContentDescriptor; readonly text: string | null }
export interface InspectionTelemetryWrite {
  readonly id: string; readonly kind: "span" | "log"; readonly traceId: string | null;
  readonly spanId: string | null; readonly recordId: string; readonly subjectKey: string;
  readonly data: string;
}

const SCHEMA = `
CREATE TABLE dataset (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, manifest TEXT NOT NULL, watermark INTEGER NOT NULL, coverage TEXT NOT NULL);
CREATE TABLE records (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, capture_sequence INTEGER NOT NULL, subject_key TEXT NOT NULL, run_id TEXT, owner TEXT NOT NULL, subject_kind TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT, fingerprint TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX records_subject ON records(subject_key, sequence);
CREATE INDEX records_run ON records(run_id, sequence);
CREATE INDEX records_kind ON records(kind, sequence);
CREATE TABLE relations (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE INDEX relations_from ON relations(from_key, sequence);
CREATE INDEX relations_to ON relations(to_key, sequence);
CREATE TABLE contents (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, record_id TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE definitions (subject_key TEXT NOT NULL, sequence INTEGER NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(subject_key, sequence));
CREATE TABLE lifecycle_definitions (subject_key TEXT NOT NULL, sequence INTEGER NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(subject_key, sequence));
CREATE TABLE subject_snapshots (subject_key TEXT NOT NULL, sequence INTEGER NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(subject_key, sequence));
CREATE TABLE telemetry_spans (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, trace_id TEXT, span_id TEXT, value TEXT NOT NULL);
CREATE TABLE telemetry_logs (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, trace_id TEXT, span_id TEXT, value TEXT NOT NULL);
CREATE TABLE telemetry_correlations (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, record_id TEXT NOT NULL, subject_key TEXT NOT NULL, kind TEXT NOT NULL);
CREATE INDEX telemetry_subject ON telemetry_correlations(subject_key, sequence);
CREATE TABLE capture_issues (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL);
`;
const TABLES = ["dataset", "records", "relations", "contents", "definitions", "lifecycle_definitions", "subject_snapshots", "telemetry_spans", "telemetry_logs", "telemetry_correlations", "capture_issues"];
type Row = Record<string, string | number | null>;

export class InspectionDatabase {
  private readonly db: Database.Database;
  readonly directory: string;

  constructor(directory: string, manifest?: InspectionDatasetManifest) {
    this.directory = directory;
    if (manifest) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      mkdirSync(join(directory, "content"), { mode: 0o700 });
      mkdirSync(join(directory, "staging"), { mode: 0o700 });
    }
    const file = containedInspectionPath(directory, "inspection.sqlite");
    this.db = new Database(file, { readonly: !manifest, fileMustExist: !manifest, timeout: 250 });
    try {
      this.db.pragma("trusted_schema = OFF");
      if (manifest) {
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = FULL");
        this.db.pragma("wal_autocheckpoint = 1000");
        this.db.exec(SCHEMA);
        const coverage: InspectionCoverage = { status: "open", watermark: 0, captured: 0, dropped: 0, rejected: 0, telemetryDropped: 0, heartbeat: manifest.createdAt, limitations: [] };
        this.db.prepare("INSERT INTO dataset VALUES (1, ?, ?, 0, ?)").run(INSPECTION_FORMAT_VERSION, JSON.stringify(manifest), JSON.stringify(coverage));
      }
      this.validateSchema();
    } catch (error) { this.db.close(); throw error; }
  }

  private validateSchema(): void {
    const objects = this.db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
    if (objects.some((row) => row.type === "view" || row.type === "trigger" || /CREATE\s+VIRTUAL/i.test(String(row.sql))) ||
      TABLES.some((table) => !objects.some((row) => row.name === table && row.type === "table"))) throw new Error("inspection_dataset_unsupported");
    const row = this.db.prepare("SELECT version FROM dataset WHERE id=1").get() as Row | undefined;
    if (row?.version !== INSPECTION_FORMAT_VERSION) throw new Error("inspection_dataset_unsupported");
  }

  engineVersion(): string { return (this.db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version; }
  snapshot(): InspectionCoverage {
    const row = this.db.prepare("SELECT watermark, coverage FROM dataset WHERE id=1").get() as Row;
    return { ...JSON.parse(String(row.coverage)), watermark: Number(row.watermark) };
  }
  manifest(): InspectionDatasetManifest {
    return JSON.parse(String((this.db.prepare("SELECT manifest FROM dataset WHERE id=1").get() as Row).manifest));
  }
  snapshotAt(watermark: number): InspectionCoverage {
    const current = this.snapshot();
    if (!Number.isSafeInteger(watermark) || watermark < 0 || watermark > current.watermark) throw new Error("inspection_cursor_invalid");
    const issue = this.db.prepare("SELECT value FROM capture_issues WHERE sequence<=? ORDER BY sequence DESC LIMIT 1").get(watermark) as Row | undefined;
    const base: InspectionCoverage = issue ? JSON.parse(String(issue.value)) : { ...current, status: "open", dropped: 0, rejected: 0, telemetryDropped: 0, limitations: [], heartbeat: this.manifest().createdAt };
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM records WHERE sequence<=?").get(watermark) as Row;
    return { ...base, watermark, captured: Number(row.total) };
  }

  write(record: InspectionRecord, contents: readonly InspectionContentWrite[]): { record: InspectionRecord; duplicate: boolean } {
    const fingerprint = createHash("sha256").update(JSON.stringify({ subject: record.subject, payload: record.payload, links: record.links, contents: record.contents, occurredAt: record.occurredAt, ownerSequence: record.ownerSequence })).digest("hex");
    const prior = this.db.prepare("SELECT fingerprint, value FROM records WHERE id=?").get(record.id) as Row | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("inspection_record_conflict");
      return { record: JSON.parse(String(prior.value)), duplicate: true };
    }
    for (const content of contents) {
      if (content.text === null) continue;
      validateOpaqueId(content.descriptor.id);
      const staging = containedInspectionPath(this.directory, "staging", content.descriptor.id);
      const target = containedInspectionPath(this.directory, "content", content.descriptor.id);
      const fd = openSync(staging, "wx", 0o600);
      try { writeFileSync(fd, content.text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(staging, target);
    }
    return this.db.transaction(() => {
      const previous = this.snapshot();
      const sequence = nextSequence(previous.watermark);
      const committed: InspectionRecord = { ...record, commitSequence: sequence };
      const key = inspectionSubjectKey(record.subject);
      this.db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(record.id, sequence, record.captureSequence, key, record.subject.runId, record.subject.owner, record.subject.kind, record.payload.kind, record.occurredAt, fingerprint, JSON.stringify(committed));
      const relationStatement = this.db.prepare("INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const link of record.links) relationStatement.run(link.id, sequence, inspectionSubjectKey(link.from), inspectionSubjectKey(link.to), link.kind, record.id, JSON.stringify(link));
      for (const descriptor of record.contents) this.db.prepare("INSERT INTO contents VALUES (?, ?, ?, ?)").run(descriptor.id, sequence, record.id, JSON.stringify(descriptor));
      this.db.prepare("INSERT INTO subject_snapshots VALUES (?, ?, ?)").run(key, sequence, record.id);
      if (record.payload.kind === "definition") this.db.prepare("INSERT INTO definitions VALUES (?, ?, ?)").run(key, sequence, record.id);
      if (record.payload.kind === "lifecycle") this.db.prepare("INSERT INTO lifecycle_definitions VALUES (?, ?, ?)").run(key, sequence, record.id);
      this.db.prepare("UPDATE dataset SET watermark=?, coverage=? WHERE id=1").run(sequence, JSON.stringify({ ...previous, watermark: sequence, captured: previous.captured + 1, heartbeat: new Date().toISOString() }));
      return { record: committed, duplicate: false };
    })();
  }

  writeTelemetry(input: InspectionTelemetryWrite): void {
    this.db.transaction(() => {
      const table = input.kind === "span" ? "telemetry_spans" : "telemetry_logs";
      if (this.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(input.id)) return;
      const sequence = nextSequence(this.snapshot().watermark);
      this.db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`).run(input.id, sequence, input.traceId, input.spanId, input.data);
      this.db.prepare("INSERT INTO telemetry_correlations VALUES (?, ?, ?, ?, ?)").run(input.id, sequence, input.recordId, input.subjectKey, input.kind);
      this.db.prepare("UPDATE dataset SET watermark=? WHERE id=1").run(sequence);
    })();
  }

  updateCoverage(change: Partial<InspectionCoverage>): void {
    this.db.transaction(() => {
      const previous = this.snapshot();
      const next = { ...previous, ...change, watermark: nextSequence(previous.watermark), heartbeat: new Date().toISOString() };
      this.db.prepare("INSERT INTO capture_issues VALUES (?, ?)").run(next.watermark, JSON.stringify(next));
      this.db.prepare("UPDATE dataset SET watermark=?, coverage=? WHERE id=1").run(next.watermark, JSON.stringify(next));
    })();
  }

  records(input: { watermark: number; after?: number; limit?: number; runId?: string; owner?: string; kind?: string; subjectKey?: string; subjectKind?: string }): InspectionRecord[] {
    const clauses = ["sequence <= ?", "sequence > ?"];
    const values: (string | number)[] = [input.watermark, input.after ?? 0];
    for (const [column, value] of [["run_id", input.runId], ["owner", input.owner], ["kind", input.kind], ["subject_key", input.subjectKey], ["subject_kind", input.subjectKind]]) {
      if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
    }
    return (this.db.prepare(`SELECT value FROM records WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`).all(...values, Math.min(input.limit ?? 100, 501)) as Row[]).map((row) => JSON.parse(String(row.value)));
  }

  record(id: string, watermark: number): InspectionRecord | null {
    const row = this.db.prepare("SELECT value FROM records WHERE id=? AND sequence<=?").get(id, watermark) as Row | undefined;
    return row ? JSON.parse(String(row.value)) : null;
  }

  latest(subjectKey: string, watermark: number, kind?: string): InspectionRecord | null {
    const row = (kind
      ? this.db.prepare("SELECT value FROM records WHERE subject_key=? AND sequence<=? AND kind=? ORDER BY sequence DESC LIMIT 1").get(subjectKey, watermark, kind)
      : this.db.prepare("SELECT value FROM records WHERE subject_key=? AND sequence<=? ORDER BY (subject_kind='run' AND kind='snapshot') DESC, (kind='definition') DESC, sequence DESC LIMIT 1").get(subjectKey, watermark)) as Row | undefined;
    return row ? JSON.parse(String(row.value)) : null;
  }

  subjects(watermark: number, kind?: string, after = 0, limit = 100): InspectionRecord[] {
    const payload = kind === "run" ? "AND kind='snapshot'" : kind === "definition" ? "AND kind='definition'" : "";
    return (this.db.prepare(`SELECT r.value FROM records r JOIN (SELECT subject_key, MAX(sequence) sequence FROM records WHERE sequence<=? ${kind ? "AND subject_kind=?" : ""} ${payload} GROUP BY subject_key) latest ON r.sequence=latest.sequence WHERE r.sequence>? ORDER BY r.sequence LIMIT ?`).all(...(kind ? [watermark, kind, after, limit] : [watermark, after, limit])) as Row[]).map((row) => JSON.parse(String(row.value)));
  }

  relations(watermark: number, subjectKey: string | null, kinds: readonly string[] = [], after = 0, limit = 500): import("../records/index.js").InspectionLink[] {
    const clauses = ["sequence<=?", "sequence>?"];
    const args: (string | number)[] = [watermark, after];
    if (subjectKey !== null) { clauses.push("(from_key=? OR to_key=?)"); args.push(subjectKey, subjectKey); }
    if (kinds.length > 0) { clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`); args.push(...kinds); }
    return (this.db.prepare(`SELECT value FROM relations WHERE ${clauses.join(" AND ")} ORDER BY sequence, id LIMIT ?`).all(...args, limit) as Row[]).map((row) => JSON.parse(String(row.value)));
  }

  content(id: string, watermark: number): InspectionContentDescriptor | null {
    validateOpaqueId(id);
    const row = this.db.prepare("SELECT value FROM contents WHERE id=? AND sequence<=?").get(id, watermark) as Row | undefined;
    return row ? JSON.parse(String(row.value)) : null;
  }

  readContent(id: string, watermark: number, offset: number, length: number): { descriptor: InspectionContentDescriptor; text: string; offset: number; nextOffset: number | null } | null {
    const descriptor = this.content(id, watermark);
    if (!descriptor) return null;
    if (descriptor.availability !== "present") return { descriptor, text: "", offset, nextOffset: null };
    const path = containedInspectionPath(this.directory, "content", id);
    if (!existsSync(path)) return { descriptor: { ...descriptor, availability: "unavailable", unavailableReason: "content_missing" }, text: "", offset, nextOffset: null };
    if (statSync(path).size > 8 * 1024 * 1024 || !Number.isSafeInteger(offset) || offset < 0 || length < 4 || length > 256 * 1024) throw new Error("inspection_query_invalid");
    const bytes = readFileSync(path);
    if (bytes.length !== descriptor.retainedBytes || createHash("sha256").update(bytes).digest("hex") !== descriptor.digest) return { descriptor: { ...descriptor, availability: "unavailable", unavailableReason: "content_integrity_failed" }, text: "", offset, nextOffset: null };
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)) throw new Error("inspection_query_invalid");
    let end = Math.min(bytes.length, offset + length);
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return { descriptor, text: bytes.subarray(offset, end).toString("utf8"), offset, nextOffset: end < bytes.length ? end : null };
  }

  telemetry(watermark: number, subjectKey: string | null, limit = 100, after = 0): { kind: string; sequence: number; recordId: unknown; subjectKey: unknown; value: unknown }[] {
    const values: { kind: string; sequence: number; recordId: unknown; subjectKey: unknown; value: unknown }[] = [];
    for (const kind of ["span", "log"] as const) {
      const table = kind === "span" ? "telemetry_spans" : "telemetry_logs";
      const rows = this.db.prepare(`SELECT t.value, c.record_id, c.subject_key, t.sequence FROM ${table} t JOIN telemetry_correlations c ON c.id=t.id WHERE t.sequence<=? AND t.sequence>? ${subjectKey ? "AND c.subject_key=?" : ""} ORDER BY t.sequence LIMIT ?`).all(...(subjectKey ? [watermark, after, subjectKey, limit] : [watermark, after, limit])) as Row[];
      values.push(...rows.map((row) => ({ kind, sequence: Number(row.sequence), recordId: row.record_id, subjectKey: row.subject_key, value: JSON.parse(String(row.value)) })));
    }
    return values.sort((left, right) => left.sequence - right.sequence).slice(0, limit);
  }

  size(): number {
    return ["inspection.sqlite", "inspection.sqlite-wal", "inspection.sqlite-shm"].reduce((total, name) => {
      const file = join(this.directory, name);
      return total + (existsSync(file) ? statSync(file).size : 0);
    }, 0);
  }
  checkpoint(): void { this.db.pragma("wal_checkpoint(PASSIVE)"); }
  close(): void { this.db.close(); }
}

function nextSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error("inspection_sequence_exhausted");
  return value + 1;
}
