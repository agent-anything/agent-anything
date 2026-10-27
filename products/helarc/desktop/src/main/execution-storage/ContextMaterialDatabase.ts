import type Database from "better-sqlite3";
import type {ContextMaterialObservation} from "./ContextMaterialObservation.js";
import {CONTEXT_MATERIAL_LIMITS as LIMITS, ContextMaterialError, contextMaterialDigest, snapshotContextMaterialRef,
  snapshotContextMaterialRefs, type ContextMaterialDescription, type ContextMaterialDocument, type ContextMaterialRef,
  type ContextMaterialRead, type ContextMaterialSearch, type ContextMaterialPage, type ContextMaterialSearchPage} from "@agent-anything/context/material";

export const CONTEXT_MATERIAL_SCHEMA = `
CREATE TABLE context_materials(id TEXT PRIMARY KEY, revision TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE context_material_chunks(id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE context_material_members(sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, material_id TEXT NOT NULL REFERENCES context_materials(id), UNIQUE(run_id,material_id));
CREATE INDEX context_material_scope ON context_material_members(run_id,sequence);
CREATE TABLE context_material_consumers(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE context_material_holds(consumer_id TEXT NOT NULL REFERENCES context_material_consumers(id), material_id TEXT NOT NULL REFERENCES context_materials(id), PRIMARY KEY(consumer_id,material_id));
CREATE TABLE context_material_fences(run_id TEXT PRIMARY KEY);
CREATE TABLE context_material_releases(consumer_id TEXT PRIMARY KEY);
CREATE TABLE context_material_reads(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_digest TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE context_material_searches(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_digest TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL);
`;
interface Manifest {description: ContextMaterialDescription; discoverable?: boolean; chunks: readonly {id: string; start: number; end: number}[];}
interface SearchProgress {input:ContextMaterialSearch; page:ContextMaterialSearchPage;}
export interface ContextMaterialTransfer {readonly id: string; readonly sourceRunId: string; readonly recipientRunId: string;
  readonly references: readonly ContextMaterialRef[]; readonly basis: {readonly kind: "assignment" | "result" | "continuation" | "working_view" | "frozen_request" | "prepared_read"; readonly id: string};}
export type ContextMaterialCommand =
  | {kind: "read"; runId: string; input: ContextMaterialRead; invocationId: string}
  | {kind: "search"; runId: string; input: ContextMaterialSearch; invocationId: string; finish?: boolean}
  | {kind: "prepare"; transfer: ContextMaterialTransfer}
  | {kind: "accept"; transfer: ContextMaterialTransfer}
  | {kind: "release"; consumerId: string}
  | {kind: "validate"; runId: string; references: readonly ContextMaterialRef[]};
export type ContextMaterialValue = ContextMaterialPage | ContextMaterialSearchPage | {kind:"search_progress"} | null;

/** Derived views and durable source holds share the authoritative execution transaction. */
export class ContextMaterialDatabase {
  private readonly statements = new Map<string, Database.Statement>();
  private readonly observations: ContextMaterialObservation[] = [];
  takeObservations(): readonly ContextMaterialObservation[] {return this.observations.splice(0);}
  constructor(private readonly db: Database.Database) {}
  private sql(query: string) {let value = this.statements.get(query); if (!value) {value = this.db.prepare(query); this.statements.set(query, value);} return value;}

  publish(document: ContextMaterialDocument, recipientRunId: string): void {
    const {description, text} = document;
    snapshotContextMaterialRef(description.reference);
    const body = Buffer.from(text, "utf8");
    if (body.length !== description.bytes || contextMaterialDigest(text) !== description.reference.revision) fail("context_material_integrity_failed");
    const existing = this.manifest(description.reference.id);
    if (existing) {
      if (existing.description.reference.revision !== description.reference.revision || existing.description.originRunId !== description.originRunId ||
          JSON.stringify(existing.description.source) !== JSON.stringify(description.source)) fail("context_material_conflict");
    } else {
      const chunks: Manifest["chunks"][number][] = [];
      for (let start = 0; start < body.length; start += 65_536) {
        const bytes = body.subarray(start, Math.min(body.length, start + 65_536));
        const id = digest(bytes);
        this.sql("INSERT OR IGNORE INTO context_material_chunks VALUES (?,?)").run(id, bytes);
        chunks.push({id, start, end: start + bytes.length});
      }
      const value = JSON.stringify({description, chunks} satisfies Manifest);
      this.sql("INSERT INTO context_materials VALUES (?,?,?,?)").run(description.reference.id, description.reference.revision, contextMaterialDigest(value), value);
    }
    const membership = this.sql("INSERT OR IGNORE INTO context_material_members(run_id,material_id) VALUES (?,?)").run(recipientRunId, description.reference.id);
    if (membership.changes) this.observations.push({kind: "published", runId: recipientRunId, description: existing?.description ?? description});
  }

  /** Chunk-backed publications share the execution transaction and immutable byte store. */
  publishChunks(description: ContextMaterialDescription, texts: readonly string[], recipientRunId: string, discoverable = false): void {
    snapshotContextMaterialRef(description.reference);
    const chunks: Manifest["chunks"][number][] = [], hash = createHash("sha256");
    let start = 0;
    for (const text of texts) {
      const body = Buffer.from(text,"utf8"); hash.update(body);
      for (let offset=0;offset<body.length;offset+=65_536) {
        const bytes=body.subarray(offset,Math.min(body.length,offset+65_536)),id=digest(bytes);
        this.sql("INSERT OR IGNORE INTO context_material_chunks VALUES (?,?)").run(id,bytes);
        chunks.push({id,start,end:start+bytes.length}); start+=bytes.length;
      }
    }
    if (start !== description.bytes || `sha256:${hash.digest("hex")}` !== description.reference.revision) fail("context_material_integrity_failed");
    const existing=this.manifest(description.reference.id);
    const value=JSON.stringify({description,chunks,discoverable} satisfies Manifest);
    if (existing && JSON.stringify(existing)!==value) fail("context_material_conflict");
    if (!existing) this.sql("INSERT INTO context_materials VALUES (?,?,?,?)").run(description.reference.id,description.reference.revision,contextMaterialDigest(value),value);
    const added=this.sql("INSERT OR IGNORE INTO context_material_members(run_id,material_id) VALUES (?,?)").run(recipientRunId,description.reference.id);
    if (added.changes) this.observations.push({kind:"published",runId:recipientRunId,description});
  }

  validate(runId: string, references: readonly ContextMaterialRef[]): void {
    for (const reference of snapshotContextMaterialRefs(references)) this.access(runId, reference);
  }

  prepare(transfer: ContextMaterialTransfer): void {
    if (![transfer.id, transfer.sourceRunId, transfer.recipientRunId, transfer.basis.id].every(value => typeof value === "string" && value.length > 0 && value.length <= 2048) ||
        !["assignment", "result", "continuation", "working_view", "frozen_request", "prepared_read"].includes(transfer.basis.kind)) fail("context_consumer_invalid");
    if (this.sql("SELECT 1 FROM context_material_releases WHERE consumer_id=?").get(transfer.id)) fail("context_consumer_released");
    this.validate(transfer.sourceRunId, transfer.references);
    const value = JSON.stringify(transfer), hash = contextMaterialDigest(value);
    const previous = this.consumer(transfer.id);
    if (previous) {
      if (previous.digest !== hash) fail("context_consumer_conflict");
      if (previous.state === "released") fail("context_consumer_released");
      return;
    }
    if (this.sql("SELECT 1 FROM context_material_fences WHERE run_id=?").get(transfer.recipientRunId)) fail("context_recipient_released");
    this.sql("INSERT INTO context_material_consumers VALUES (?,?,?,?,?)").run(transfer.id, transfer.recipientRunId, "prepared", hash, value);
    for (const ref of transfer.references) this.sql("INSERT INTO context_material_holds VALUES (?,?)").run(transfer.id, ref.id);
    this.observations.push({kind: "retention", transfer, state: "prepared"});
  }

  accept(transfer: ContextMaterialTransfer): void {
    this.prepare(transfer);
    for (const ref of transfer.references) this.sql("INSERT OR IGNORE INTO context_material_members(run_id,material_id) VALUES (?,?)").run(transfer.recipientRunId, ref.id);
    if (this.sql("UPDATE context_material_consumers SET state='accepted' WHERE id=? AND state='prepared'").run(transfer.id).changes) {
      this.observations.push({kind: "retention", transfer, state: "accepted"});
    }
  }

  release(consumerId: string): void {
    this.sql("INSERT OR IGNORE INTO context_material_releases VALUES (?)").run(consumerId);
    const row = this.consumer(consumerId);
    if (!row || row.state === "released") return;
    if (contextMaterialDigest(row.value) !== row.digest) fail("context_consumer_corrupt");
    this.sql("DELETE FROM context_material_holds WHERE consumer_id=?").run(consumerId);
    this.sql("UPDATE context_material_consumers SET state='released' WHERE id=?").run(consumerId);
    this.observations.push({kind: "retention", transfer: JSON.parse(row.value), state: "released"});
  }

  releaseRun(runId: string): void {
    this.sql("INSERT OR IGNORE INTO context_material_fences VALUES (?)").run(runId);
    for (const row of this.sql("SELECT id FROM context_material_consumers WHERE run_id=? AND state!='released'").all(runId) as {id: string}[]) this.release(row.id);
  }

  retainedOwners(): readonly string[] {
    return (this.sql("SELECT DISTINCT c.run_id FROM context_material_consumers c JOIN context_material_holds h ON h.consumer_id=c.id WHERE c.state!='released'").all() as {run_id: string}[]).map(row => row.run_id);
  }
  inheritedReferences(runId: string, after: string | null): readonly ContextMaterialRef[] {
    const references = this.sql("SELECT DISTINCT m.id,m.revision FROM context_material_consumers c JOIN context_material_holds h ON h.consumer_id=c.id JOIN context_materials m ON m.id=h.material_id WHERE c.run_id=? AND c.state='accepted' AND m.id>? ORDER BY m.id LIMIT 16")
      .all(runId, after ?? "") as ContextMaterialRef[];
    for (const reference of references) {
      const consumers = this.sql("SELECT c.id FROM context_material_consumers c JOIN context_material_holds h ON h.consumer_id=c.id WHERE c.run_id=? AND c.state='accepted' AND h.material_id=?").all(runId, reference.id) as {id:string}[];
      for (const row of consumers) {
        const consumer = this.consumer(row.id)!;
        const transfer = JSON.parse(consumer.value) as ContextMaterialTransfer;
        if (transfer.recipientRunId !== runId || !transfer.references.some(ref => ref.id === reference.id && ref.revision === reference.revision)) fail("context_consumer_corrupt");
      }
      this.access(runId, reference);
    }
    return references;
  }
  private consumer(id: string): {state:string; digest:string; value:string} | undefined {
    const row = this.sql("SELECT state,digest,value FROM context_material_consumers WHERE id=?").get(id) as {state:string; digest:string; value:string} | undefined;
    if (row && (contextMaterialDigest(row.value) !== row.digest || !["prepared", "accepted", "released"].includes(row.state))) fail("context_consumer_corrupt");
    return row;
  }
  command(command: ContextMaterialCommand): ContextMaterialValue {
    if (command.kind === "prepare" || command.kind === "accept") {
      this.db.transaction(() => command.kind === "prepare" ? this.prepare(command.transfer) : this.accept(command.transfer))(); return null;
    }
    if (command.kind === "release") {this.db.transaction(() => this.release(command.consumerId))(); return null;}
    if (command.kind === "validate") {this.validate(command.runId, command.references); return null;}
    if (!command.invocationId || command.invocationId.length > 2048) fail("context_invocation_invalid");
    if (command.kind === "search") this.db.transaction(()=>this.prepareSearch(command))();
    return this.db.transaction(() => {
      const requestDigest = contextMaterialDigest(JSON.stringify({kind:command.kind,runId:command.runId,input:command.input,invocationId:command.invocationId}));
      const previous = this.sql("SELECT run_id,request_digest,digest,value FROM context_material_reads WHERE id=?").get(command.invocationId) as
        {run_id: string; request_digest: string; digest: string; value: string} | undefined;
      if (previous) {
        if (previous.run_id !== command.runId || previous.request_digest !== requestDigest) fail("context_invocation_conflict");
        if (contextMaterialDigest(previous.value) !== previous.digest) fail("context_material_integrity_failed");
        const result = JSON.parse(previous.value) as ContextMaterialPage | ContextMaterialSearchPage;
        const descriptions = "description" in result ? [result.description] : result.matches.map(match => match.description);
        this.validate(command.runId, [...new Map(descriptions.map(value => [value.reference.id, value.reference])).values()]);
        this.observeAccess(command, result, true);
        return result;
      }
      const result = command.kind === "read" ? this.read(command.runId, command.input) : this.searchStep(command,requestDigest);
      if ("kind" in result) return result;
      const descriptions = "description" in result ? [result.description] : result.matches.map(match => match.description);
      const references = [...new Map(descriptions.map(value => [value.reference.id, value.reference])).values()];
      if (references.length) this.prepare({id:`${command.invocationId}:material-read`,sourceRunId:command.runId,recipientRunId:command.runId,
        references,basis:{kind:"prepared_read",id:command.invocationId}});
      const value = JSON.stringify(result);
      this.sql("INSERT INTO context_material_reads VALUES (?,?,?,?,?)").run(command.invocationId, command.runId, requestDigest, contextMaterialDigest(value), value);
      if (command.kind === "search") this.sql("DELETE FROM context_material_searches WHERE id=?").run(command.invocationId);
      this.observeAccess(command, result, false);
      return result;
    })();
  }
  private prepareSearch(command:Extract<ContextMaterialCommand,{kind:"search"}>):void {
    if (this.sql("SELECT 1 FROM context_material_reads WHERE id=?").get(command.invocationId) ||
        this.sql("SELECT 1 FROM context_material_searches WHERE id=?").get(command.invocationId)) return;
    const {input,runId,invocationId}=command;
    const query=input.query ?? "",where=input.in ?? "content",limit=input.limit ?? 8;
    if (typeof query!=="string" || Buffer.byteLength(query)>LIMITS.queryBytes || !["content","description"].includes(where) || !integer(limit,1,LIMITS.matches)) fail("context_search_invalid");
    const references=input.references===undefined ? undefined : snapshotContextMaterialRefs(input.references);
    if (references && !references.length) fail("context_search_invalid");
    if (references) this.validate(runId,references);
    const current=(this.sql("SELECT COALESCE(MAX(sequence),0) AS frontier FROM context_material_members WHERE run_id=?").get(runId) as {frontier:number}).frontier;
    const scope=contextMaterialDigest(JSON.stringify(references ?? null));
    let cursor={runId,query,where,scope,frontier:current,sequence:0,offset:0};
    if (input.cursor!==undefined) {
      try {
        if (typeof input.cursor!=="string" || input.cursor.length>4096) throw new Error();
        const value=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8"));
        if (value.runId!==runId || value.query!==query || value.where!==where || value.scope!==scope || !integer(value.frontier,0,current) ||
          !integer(value.sequence,0,value.frontier) || !integer(value.offset,0,32*1024*1024)) throw new Error();
        cursor=value;
      } catch {fail("context_cursor_invalid","Reuse the cursor with its original query and scope, or start a new search.");}
    }
    const members=this.searchMembers(runId,references,cursor.frontier);
    for (let start=0;start<members.length;start+=LIMITS.references) this.prepare({id:`${invocationId}:search-scope:${start}`,
      sourceRunId:runId,recipientRunId:runId,references:members.slice(start,start+LIMITS.references).map(({id,revision})=>({id,revision})),
      basis:{kind:"prepared_read",id:invocationId}});
    const state:SearchProgress={input,page:{matches:[],scannedBytes:0,scannedDescriptions:0,frontier:cursor.frontier,
      exhausted:false,nextCursor:Buffer.from(JSON.stringify(cursor)).toString("base64url"),limitations:["partial_scan","no_match_is_not_absence"]}};
    const value=JSON.stringify(state),requestDigest=contextMaterialDigest(JSON.stringify({kind:"search",runId,input,invocationId}));
    this.sql("INSERT INTO context_material_searches VALUES (?,?,?,?,?)").run(invocationId,runId,requestDigest,contextMaterialDigest(value),value);
    this.observations.push({kind:"access",runId,invocationId,mode:"search",reused:false,references:references ?? [],
      coverage:{state:"prepared",request:input,frontier:cursor.frontier}});
  }
  private searchStep(command:Extract<ContextMaterialCommand,{kind:"search"}>, requestDigest:string):ContextMaterialSearchPage | {kind:"search_progress"} {
    const row=this.sql("SELECT run_id,request_digest,digest,value FROM context_material_searches WHERE id=?").get(command.invocationId) as
      {run_id:string;request_digest:string;digest:string;value:string}|undefined;
    let state:SearchProgress;
    if (row) {
      if (row.run_id!==command.runId || row.request_digest!==requestDigest) fail("context_invocation_conflict");
      if (contextMaterialDigest(row.value)!==row.digest) fail("context_material_integrity_failed");
      state=JSON.parse(row.value);
    } else fail("context_search_preparation_missing");
    const limit=command.input.limit ?? 8;
    if (row && !command.finish && !state.page.exhausted && state.page.matches.length<limit && state.page.scannedBytes<LIMITS.searchBytes) {
      const page=this.search(command.runId,{...state.input,cursor:state.page.nextCursor!,limit:limit-state.page.matches.length});
      state={...state,page:{...page,matches:[...state.page.matches,...page.matches],scannedBytes:state.page.scannedBytes+page.scannedBytes,
        scannedDescriptions:state.page.scannedDescriptions+page.scannedDescriptions}};
    }
    const done=state.page.exhausted || state.page.matches.length>=limit || command.finish || state.page.scannedBytes>=LIMITS.searchBytes;
    if (done) return {...state.page,stopReason:state.page.exhausted ? "scope_exhausted" : state.page.matches.length>=limit ? "result_limit" : "execution_budget"};
    const value=JSON.stringify(state);
    this.sql("INSERT INTO context_material_searches VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,value=excluded.value")
      .run(command.invocationId,command.runId,requestDigest,contextMaterialDigest(value),value);
    this.observations.push({kind:"access",runId:command.runId,invocationId:command.invocationId,mode:"search",reused:false,
      references:command.input.references ?? [],coverage:{state:"scanning",request:command.input,frontier:state.page.frontier,
        scannedBytes:state.page.scannedBytes,scannedDescriptions:state.page.scannedDescriptions,nextCursor:state.page.nextCursor}});
    return {kind:"search_progress"};
  }
  private observeAccess(command: Extract<ContextMaterialCommand, {kind: "read" | "search"}>, result: ContextMaterialPage | ContextMaterialSearchPage, reused: boolean): void {
    const descriptions = "description" in result ? [result.description] : result.matches.map(match => match.description);
    this.observations.push({kind: "access", runId: command.runId, invocationId: command.invocationId, mode: command.kind, reused,
      references: [...new Map([...descriptions.map(value=>value.reference),...(command.kind === "search" ? command.input.references ?? [] : [])].map(value=>[value.id,value])).values()],
      coverage: "description" in result ? {coordinate: result.coordinate, byteStart: result.byteStart, byteEnd: result.byteEnd, complete: result.complete, nextOffset: result.nextOffset}
        : {state:"returned",request:command.input,frontier: result.frontier, scannedBytes: result.scannedBytes, scannedDescriptions: result.scannedDescriptions, exhausted: result.exhausted, nextCursor: result.nextCursor,stopReason:result.stopReason}});
  }
  read(runId: string, input: ContextMaterialRead): ContextMaterialPage {
    const material = this.access(runId, snapshotContextMaterialRef(input.reference));
    const start = input.offset ?? 0, length = input.length ?? LIMITS.pageBytes;
    if (!integer(start, 0, material.description.bytes) || !integer(length, 4, LIMITS.pageBytes)) fail("context_range_invalid", "Use a returned nextOffset and a length of 4-16384 UTF-8 bytes.");
    const raw = this.range(material, start, Math.min(material.description.bytes, start + length + 3));
    if (raw.length && (raw[0]! & 0xc0) === 0x80) fail("context_range_invalid", "Offset is inside a UTF-8 character. Use the prior page's nextOffset.");
    let count = Math.min(length, raw.length);
    while (count < raw.length && (raw[count]! & 0xc0) === 0x80) count--;
    const end = start + count;
    return {description: material.description, text: new TextDecoder("utf-8", {fatal: true}).decode(raw.subarray(0, count)),
      byteStart: start, byteEnd: end, nextOffset: end < material.description.bytes ? end : null,
      complete: start === 0 && end === material.description.bytes, coordinate: "utf8_view_bytes"};
  }

  search(runId: string, input: ContextMaterialSearch): ContextMaterialSearchPage {
    const query = input.query ?? "", where = input.in ?? "content", limit = input.limit ?? 8;
    if (typeof query !== "string" || Buffer.byteLength(query) > LIMITS.queryBytes || !["content", "description"].includes(where) || !integer(limit, 1, LIMITS.matches)) fail("context_search_invalid");
    const references=input.references===undefined ? undefined : snapshotContextMaterialRefs(input.references);
    if (references && !references.length) fail("context_search_invalid","Provide at least one exact reference or omit references for discovery.");
    const scope=contextMaterialDigest(JSON.stringify(references ?? null));
    if (references) this.validate(runId,references);
    const current = (this.sql("SELECT COALESCE(MAX(sequence),0) AS frontier FROM context_material_members WHERE run_id=?").get(runId) as {frontier: number}).frontier;
    let frontier = current, sequence = 0, offset = 0;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== "string" || input.cursor.length > 4096) throw new Error();
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (cursor.runId !== runId || cursor.query !== query || cursor.where !== where || cursor.scope!==scope || !integer(cursor.frontier, 0, current) ||
            !integer(cursor.sequence, 0, cursor.frontier) || !integer(cursor.offset, 0, 32 * 1024 * 1024)) throw new Error();
        ({frontier, sequence, offset} = cursor);
      } catch {fail("context_cursor_invalid", "Reuse the cursor with its original query and scope, or start a new search.");}
    }
    const rows = this.searchMembers(runId,references,frontier,sequence || 1,LIMITS.descriptions+1);
    const matches: ContextMaterialSearchPage["matches"][number][] = [];
    const needle = Buffer.from(query, "utf8");
    let scannedBytes = 0, scannedDescriptions = 0, exhausted = true;
    for (const row of rows) {
      if (scannedDescriptions >= LIMITS.descriptions || scannedBytes >= LIMITS.scanBytes || matches.length >= limit) {exhausted = false; sequence = row.sequence; offset = 0; break;}
      const material = this.access(runId, row);
      scannedDescriptions++;
      const start = row.sequence === sequence ? offset : 0;
      sequence = row.sequence;
      const total = material.description.bytes;
      if (start > total) fail("context_cursor_invalid");
      if (!query || where === "description") {
        if (!query || material.description.label.includes(query)) matches.push({description: material.description, excerpt: material.description.label, byteStart: 0, byteEnd: 0});
        offset = 0; sequence = row.sequence + 1; continue;
      }
      const primaryEnd = Math.min(total, start + LIMITS.scanBytes - scannedBytes);
      const bytes = this.range(material, start, Math.min(total, primaryEnd + needle.length - 1));
      let from = 0;
      while (matches.length < limit) {
        const found = bytes.indexOf(needle, from);
        if (found < 0 || start + found >= primaryEnd) break;
        const at = start + found;
        const page = this.read(runId, {reference: material.description.reference, offset: at, length: Math.min(LIMITS.pageBytes, Math.max(256, needle.length))});
        matches.push({description: material.description, excerpt: page.text, byteStart: at, byteEnd: page.byteEnd});
        from = found + needle.length;
      }
      const consumed = matches.length >= limit ? from : primaryEnd - start;
      scannedBytes += consumed;
      offset = start + consumed;
      if (offset < total) {exhausted = false; break;}
      offset = 0; sequence = row.sequence + 1;
    }
    const nextCursor = exhausted ? null : Buffer.from(JSON.stringify({runId, query, where, scope, frontier, sequence, offset})).toString("base64url");
    return {matches, nextCursor, exhausted, scannedBytes, scannedDescriptions, frontier,
      limitations: exhausted ? [] : ["partial_scan", "no_match_is_not_absence"]};
  }
  private searchMembers(runId:string,references:readonly ContextMaterialRef[]|undefined,frontier:number,sequence=1,limit=Number.MAX_SAFE_INTEGER) {
    return this.sql(`SELECT a.sequence,m.id,m.revision FROM context_material_members a JOIN context_materials m ON m.id=a.material_id
      WHERE a.run_id=? AND a.sequence>=? AND a.sequence<=? AND ${references ? "m.id IN (SELECT value FROM json_each(?))" :
        "COALESCE(json_extract(m.value,'$.discoverable'),1)=1"}
      ORDER BY a.sequence LIMIT ?`).all(runId,sequence,frontier,...(references ? [JSON.stringify(references.map(value=>value.id))] : []),limit) as {sequence:number;id:string;revision:string}[];
  }

  private access(runId: string, reference: ContextMaterialRef): Manifest {
    if (!this.sql("SELECT 1 FROM context_material_members WHERE run_id=? AND material_id=?").get(runId, reference.id)) fail("context_material_unavailable", "Material is unavailable or not disclosed to this Run.");
    const value = this.manifest(reference.id);
    if (!value || value.description.reference.revision !== reference.revision) fail("context_material_unavailable", "Use the exact retained revision; current external data cannot replace it.");
    return value;
  }
  private manifest(id: string): Manifest | null {
    const row = this.sql("SELECT digest,value FROM context_materials WHERE id=?").get(id) as {digest: string; value: string} | undefined;
    if (!row) return null;
    if (contextMaterialDigest(row.value) !== row.digest) fail("context_material_integrity_failed");
    return JSON.parse(row.value) as Manifest;
  }
  private range(value: Manifest, start: number, end: number): Buffer {
    const parts: Buffer[] = [];
    for (const chunk of value.chunks) if (chunk.start < end && chunk.end > start) {
      const row = this.sql("SELECT bytes FROM context_material_chunks WHERE id=?").get(chunk.id) as {bytes: Buffer} | undefined;
      if (!row || digest(row.bytes) !== chunk.id || row.bytes.length !== chunk.end - chunk.start) fail("context_material_integrity_failed");
      parts.push(row.bytes.subarray(Math.max(0, start - chunk.start), Math.min(row.bytes.length, end - chunk.start)));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== end - start) fail("context_material_unavailable");
    return bytes;
  }
}
import {createHash} from "node:crypto";
function digest(bytes: Buffer) {return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;}
function integer(value: unknown, minimum: number, maximum: number): value is number {return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;}
function fail(code: string, message = code): never {throw new ContextMaterialError(code, message);}
