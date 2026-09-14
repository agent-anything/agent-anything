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
CREATE TABLE flow_definitions (definition_key TEXT PRIMARY KEY, digest TEXT NOT NULL, record_id TEXT NOT NULL, sequence INTEGER NOT NULL);
CREATE TABLE flow_records (sequence INTEGER PRIMARY KEY, definition_key TEXT NOT NULL, invocation_id TEXT NOT NULL, occurrence_id TEXT, step_id TEXT, event_kind TEXT NOT NULL, run_id TEXT NOT NULL);
CREATE INDEX flow_invocations ON flow_records(invocation_id, event_kind, sequence);
CREATE INDEX flow_occurrences ON flow_records(occurrence_id, sequence);
CREATE INDEX flow_runs ON flow_records(run_id, event_kind, sequence);
CREATE INDEX flow_steps ON flow_records(invocation_id, step_id, event_kind, sequence);
`;
const TABLES = ["dataset", "records", "relations", "contents", "definitions", "lifecycle_definitions", "subject_snapshots", "telemetry_spans", "telemetry_logs", "telemetry_correlations", "capture_issues", "flow_definitions", "flow_records"];
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
    this.validateFlow(record);
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
      if (record.payload.kind === "flow_definition") {
        const definition = record.payload.definition;
        this.db.prepare("INSERT INTO flow_definitions VALUES (?, ?, ?, ?)").run(flowDefinitionKey(definition), definition.contentDigest, record.id, sequence);
      } else if (isFlowRecord(record)) {
        const value = record.payload.observation;
        this.db.prepare("INSERT INTO flow_records VALUES (?, ?, ?, ?, ?, ?, ?)").run(sequence, flowDefinitionKey(value.definition), value.invocationId, "stepExecutionId" in value ? value.stepExecutionId : null, "stepId" in value ? value.stepId : null, value.kind, value.runId);
      }
      this.db.prepare("UPDATE dataset SET watermark=?, coverage=? WHERE id=1").run(sequence, JSON.stringify({ ...previous, watermark: sequence, captured: previous.captured + 1, heartbeat: new Date().toISOString() }));
      return { record: committed, duplicate: false };
    })();
  }

  writeBatch<T>(write: () => T): T {
    return this.db.transaction(write)();
  }

  private validateFlow(record: InspectionRecord): void {
    if (record.payload.kind === "flow_definition") {
      const definition = record.payload.definition;
      const row = this.db.prepare("SELECT digest, record_id FROM flow_definitions WHERE definition_key=?").get(flowDefinitionKey(definition)) as Row | undefined;
      if (row && (row.digest !== definition.contentDigest || row.record_id !== record.id)) throw new Error("inspection_flow_definition_conflict");
      return;
    }
    if (!isFlowRecord(record)) return;
    const observation = record.payload.observation;
    const watermark = this.snapshot().watermark;
    const invocation = this.flowRecords({watermark,invocationId:observation.invocationId,eventKind:"invocation_entered",limit:1})[0];
    if (invocation?.payload.kind === "flow_invocation") {
      const original = invocation.payload.observation;
      if (original.runId !== observation.runId || flowDefinitionKey(original.definition) !== flowDefinitionKey(observation.definition) || original.definition.contentDigest !== observation.definition.contentDigest || observation.kind === "invocation_entered") throw new Error("inspection_flow_invocation_conflict");
    }
    if ("stepExecutionId" in observation) {
      const entries = this.flowRecords({watermark,occurrenceId:observation.stepExecutionId,eventKind:"step_entered",limit:1});
      const original = entries[0]?.payload;
      if (original?.kind === "flow_step" && (observation.kind === "step_entered" || original.observation.invocationId !== observation.invocationId || original.observation.stepId !== observation.stepId)) throw new Error("inspection_flow_occurrence_conflict");
      if (observation.kind === "step_exited" && this.flowRecords({watermark,occurrenceId:observation.stepExecutionId,eventKind:"step_exited",limit:1}).length) throw new Error("inspection_flow_occurrence_conflict");
    }
    if (observation.kind === "invocation_exited" && this.flowRecords({watermark,invocationId:observation.invocationId,eventKind:"invocation_exited",limit:1}).length) throw new Error("inspection_flow_invocation_conflict");
    const definitionRecord = this.flowDefinition(observation.definition, watermark);
    if (!definitionRecord || definitionRecord.payload.kind !== "flow_definition") return;
    const definition = definitionRecord.payload.definition;
    if (definition.contentDigest !== observation.definition.contentDigest) throw new Error("inspection_flow_definition_mismatch");
    if ("stepId" in observation) {
      const step = definition.steps.find(step => step.id === observation.stepId);
      if (!step || (observation.kind === "constraint" && !step.checks.includes(observation.checkId))) throw new Error("inspection_flow_step_invalid");
    }
    if (observation.kind === "link" && observation.relation === "next") {
      const edge = definition.transitions.find(edge => edge.id === observation.transitionId);
      if (!edge || [observation.from,observation.to].some(ref => ref.invocationId !== observation.invocationId || ref.runId !== observation.runId || ref.owner !== definition.owner || ref.stepExecutionId === null)) throw new Error("inspection_flow_edge_invalid");
      for (const [ref,stepId] of [[observation.from,edge.from],[observation.to,edge.to]] as const) {
        const endpoint = this.flowRecords({watermark,occurrenceId:ref.stepExecutionId!,eventKind:"step_entered",limit:1})[0]?.payload;
        if (endpoint?.kind === "flow_step" && endpoint.observation.stepId !== stepId) throw new Error("inspection_flow_edge_invalid");
      }
    }
  }

  flowDefinition(ref: {owner: string; id: string; revision: string}, watermark: number): InspectionRecord | null {
    const row = this.db.prepare("SELECT record_id FROM flow_definitions WHERE definition_key=? AND sequence<=?").get(flowDefinitionKey(ref), watermark) as Row | undefined;
    return row ? this.record(String(row.record_id), watermark) : null;
  }

  flowRecords(input: {watermark: number; runId?: string; invocationId?: string; occurrenceId?: string; stepId?: string; eventKind?: string; after?: number; limit?: number}): InspectionRecord[] {
    const clauses = ["f.sequence<=?", "f.sequence>?"];
    const args: (number | string)[] = [input.watermark, input.after ?? 0];
    for (const [column,value] of [["run_id",input.runId],["invocation_id",input.invocationId],["occurrence_id",input.occurrenceId],["step_id",input.stepId],["event_kind",input.eventKind]]) {
      if (value !== undefined) { clauses.push(`f.${column}=?`); args.push(value); }
    }
    return (this.db.prepare(`SELECT r.value FROM flow_records f JOIN records r ON r.sequence=f.sequence WHERE ${clauses.join(" AND ")} ORDER BY f.sequence LIMIT ?`).all(...args, Math.min(input.limit ?? 101, 501)) as Row[]).map(row => JSON.parse(String(row.value)));
  }

  flowStatistics(invocationId: string, watermark: number): {stepId: string; visits: number; exits: number; failed: number}[] {
    return (this.db.prepare("SELECT step_id, SUM(event_kind='step_entered') visits, SUM(event_kind='step_exited') exits, SUM(event_kind='step_exited' AND json_extract(r.value,'$.payload.observation.disposition')='failed') failed FROM flow_records f JOIN records r ON r.sequence=f.sequence WHERE f.invocation_id=? AND f.sequence<=? AND f.step_id IS NOT NULL GROUP BY f.step_id LIMIT 128").all(invocationId, watermark) as Row[])
      .map(row => ({stepId: String(row.step_id), visits: Number(row.visits), exits: Number(row.exits), failed: Number(row.failed)}));
  }

  flowTransitions(invocationId: string, watermark: number): {transitionId: string; traversals: number}[] {
    return (this.db.prepare("SELECT json_extract(r.value,'$.payload.observation.transitionId') transition_id, COUNT(*) traversals FROM flow_records f JOIN records r ON r.sequence=f.sequence WHERE f.invocation_id=? AND f.sequence<=? AND f.event_kind='link' AND json_extract(r.value,'$.payload.observation.relation')='next' GROUP BY transition_id LIMIT 512").all(invocationId, watermark) as Row[])
      .map(row => ({transitionId: String(row.transition_id), traversals: Number(row.traversals)}));
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

  records(input: { watermark: number; after?: number; limit?: number; runId?: string; runIds?: readonly string[]; owner?: string; kind?: string; subjectKey?: string; subjectKind?: string; intervalStarts?: boolean }): InspectionRecord[] {
    const clauses = ["sequence <= ?", "sequence > ?"];
    const values: (string | number)[] = [input.watermark, input.after ?? 0];
    for (const [column, value] of [["run_id", input.runId], ["owner", input.owner], ["kind", input.kind], ["subject_key", input.subjectKey], ["subject_kind", input.subjectKind]]) {
      if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
    }
    if (input.runIds) { clauses.push(`run_id IN (${input.runIds.map(() => "?").join(",") || "NULL"})`); values.push(...input.runIds); }
    if (input.intervalStarts) clauses.push("kind='interval' AND json_extract(value,'$.payload.phase')='started'");
    return (this.db.prepare(`SELECT value FROM records WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`).all(...values, Math.min(input.limit ?? 100, 501)) as Row[]).map((row) => JSON.parse(String(row.value)));
  }

  subjectFacts(keys: readonly string[], watermark: number): InspectionRecord[] {
    if (!keys.length) return [];
    if (keys.length > 500) throw new Error("inspection_query_invalid");
    const rows = this.db.prepare(`WITH snapshots AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY subject_key,kind ORDER BY sequence) first_kind,
        ROW_NUMBER() OVER (PARTITION BY subject_key,kind ORDER BY sequence DESC) last_kind
      FROM records WHERE sequence<=? AND subject_key IN (${keys.map(() => "?").join(",")})
    ), ranked AS (
      SELECT value, sequence, ROW_NUMBER() OVER (PARTITION BY subject_key ORDER BY sequence) n,
        COUNT(*) OVER (PARTITION BY subject_key) total
      FROM snapshots WHERE subject_kind<>'run' OR kind<>'snapshot' OR first_kind=1 OR last_kind=1
    ) SELECT value FROM ranked WHERE n<=32 OR n>total-33 ORDER BY sequence`).all(watermark, ...keys) as Row[];
    return rows.map(row => JSON.parse(String(row.value)));
  }

  intervalEnds(start: InspectionRecord, watermark: number): InspectionRecord[] {
    if (start.payload.kind !== "interval") return [];
    const rows = this.db.prepare(`SELECT value FROM records WHERE subject_key=? AND sequence>? AND sequence<=? AND kind='interval'
      AND json_extract(value,'$.payload.activity')=? AND json_extract(value,'$.payload.clock')=? ORDER BY sequence LIMIT 2`)
      .all(inspectionSubjectKey(start.subject), start.commitSequence, watermark, start.payload.activity, start.payload.clock) as Row[];
    return rows.map(row => JSON.parse(String(row.value)));
  }

  hasUnpairedIntervalEnd(watermark: number, runIds?: readonly string[], subjectKey?: string): boolean {
    const clauses=["sequence<=?","kind='interval'"];const args:(string|number)[]=[watermark];
    if(runIds) {clauses.push(`run_id IN (${runIds.map(()=>"?").join(",") || "NULL"})`);args.push(...runIds);}
    if(subjectKey) {clauses.push("subject_key=?");args.push(subjectKey);}
    const row=this.db.prepare(`WITH intervals AS (
      SELECT json_extract(value,'$.payload.phase') phase,
        LAG(json_extract(value,'$.payload.phase')) OVER (PARTITION BY subject_key,json_extract(value,'$.payload.activity'),json_extract(value,'$.payload.clock') ORDER BY sequence) previous
      FROM records WHERE ${clauses.join(" AND ")}
    ) SELECT 1 FROM intervals WHERE phase='settled' AND (previous IS NULL OR previous<>'started') LIMIT 1`).get(...args);
    return row!==undefined;
  }

  clockHorizon(clock: string, watermark: number): string | null {
    const row = this.db.prepare("SELECT MAX(occurred_at) time FROM records WHERE sequence<=? AND kind='interval' AND json_extract(value,'$.payload.clock')=?")
      .get(watermark, clock) as Row;
    return row.time === null ? null : String(row.time);
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

  material(subjectKey: string, watermark: number): InspectionRecord | null {
    const row = this.db.prepare("SELECT value FROM records WHERE subject_key=? AND sequence<=? AND json_array_length(value,'$.contents')>0 ORDER BY sequence DESC LIMIT 1")
      .get(subjectKey, watermark) as Row | undefined;
    return row ? JSON.parse(String(row.value)) : null;
  }

  subjects(watermark: number, kind?: string, after = 0, limit = 100, runIds?: readonly string[]): InspectionRecord[] {
    const payload = kind === "run" ? "AND kind='snapshot'" : kind === "definition" ? "AND kind='definition'" : kind === "request" ? "AND kind='request'" : "";
    const filter = runIds ? `AND run_id IN (${runIds.map(() => "?").join(",") || "NULL"})` : "";
    return (this.db.prepare(`SELECT r.value FROM records r JOIN (SELECT subject_key, MAX(sequence) sequence FROM records WHERE sequence<=? ${kind ? "AND subject_kind=?" : ""} ${payload} ${filter} GROUP BY subject_key) latest ON r.sequence=latest.sequence WHERE r.sequence>? ORDER BY r.sequence LIMIT ?`).all(watermark, ...(kind ? [kind] : []), ...(runIds ?? []), after, Math.min(limit, 501)) as Row[]).map((row) => JSON.parse(String(row.value)));
  }

  relations(watermark: number, subjectKey: string | null, kinds: readonly string[] = [], after = 0, limit = 500, runIds?: readonly string[]): import("../records/index.js").InspectionLink[] {
    const clauses = ["sequence<=?", "sequence>?"];
    const args: (string | number)[] = [watermark, after];
    if (subjectKey !== null) { clauses.push("(from_key=? OR to_key=?)"); args.push(subjectKey, subjectKey); }
    if (kinds.length > 0) { clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`); args.push(...kinds); }
    if (runIds) {
      const placeholders = runIds.map(() => "?").join(",") || "NULL";
      clauses.push(`(json_extract(value,'$.from.runId') IN (${placeholders}) OR json_extract(value,'$.to.runId') IN (${placeholders}))`);
      args.push(...runIds,...runIds);
    }
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

  telemetry(watermark: number, subjectKey: string | null, limit = 100, after = 0, runIds?: readonly string[]): { kind: string; sequence: number; recordId: unknown; subjectKey: unknown; value: unknown }[] {
    const values: { kind: string; sequence: number; recordId: unknown; subjectKey: unknown; value: unknown }[] = [];
    for (const kind of ["span", "log"] as const) {
      const table = kind === "span" ? "telemetry_spans" : "telemetry_logs";
      const runFilter = runIds ? `AND EXISTS (SELECT 1 FROM records r WHERE r.sequence<=? AND r.subject_key=c.subject_key AND r.run_id IN (${runIds.map(()=>"?").join(",") || "NULL"}))` : "";
      const rows = this.db.prepare(`SELECT t.value, c.record_id, c.subject_key, t.sequence FROM ${table} t JOIN telemetry_correlations c ON c.id=t.id WHERE t.sequence<=? AND t.sequence>? ${subjectKey ? "AND c.subject_key=?" : ""} ${runFilter} ORDER BY t.sequence LIMIT ?`).all(watermark, after, ...(subjectKey ? [subjectKey] : []), ...(runIds ? [watermark,...runIds] : []), limit) as Row[];
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

function flowDefinitionKey(ref: {owner: string; id: string; revision: string}): string { return JSON.stringify([ref.owner, ref.id, ref.revision]); }
function isFlowRecord(record: InspectionRecord): record is InspectionRecord & {payload: Extract<InspectionRecord["payload"], {kind: "flow_invocation" | "flow_step" | "flow_constraint" | "flow_link"}>} {
  return ["flow_invocation", "flow_step", "flow_constraint", "flow_link"].includes(record.payload.kind);
}
