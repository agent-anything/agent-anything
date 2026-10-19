import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { executionEvidenceKey, type ExecutionEvidenceRef } from "@agent-anything/operation-catalog/evidence";
import { FILE_MATERIAL_POLICY as policy, snapshotFileMaterialPreparation, validFileDigest,
  type FileMaterialPreparation, type FileMaterialRecord, type FileMaterialReservation, type FileMaterialRead } from "@agent-anything/helarc-local-environment/filesystem";
import { ExecutionStoreError } from "./ExecutionStoreProtocol.js";

export const FILE_MATERIAL_SCHEMA = `
CREATE TABLE file_materials (reference_key TEXT PRIMARY KEY, state TEXT NOT NULL, reserved INTEGER NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE file_material_chunks (reference_key TEXT NOT NULL REFERENCES file_materials(reference_key), offset INTEGER NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(reference_key, offset));
`;
type Row = {reference_key: string; state: string; reserved: number; digest: string; value: string};
type Chunk = {offset: number; bytes: Buffer; digest: string};

/** Uses the authoritative store's fenced Worker connection and FULL durability. */
export class FileMaterialDatabase {
  constructor(private readonly data: Database.Database) {}

  reserve(input: FileMaterialPreparation): FileMaterialReservation {
    const preparation = snapshotFileMaterialPreparation(input);
    return this.data.transaction((): FileMaterialReservation => {
      const prior = this.read(preparation.ref);
      if (prior) {
        if (!isDeepStrictEqual(prior.preparation, preparation)) fail("file_material_identity_conflict");
        return {status: "reserved", record: prior};
      }
      if (preparation.byteLength > policy.maxFileBytes) return {status: "unavailable", reason: "file_size_limit"};
      const counts = this.data.prepare("SELECT count(*) AS count, coalesce(sum(reserved),0) AS bytes, coalesce(sum(state='staging'),0) AS staging FROM file_materials").get() as {count: number; bytes: number; staging: number};
      if (counts.count >= policy.maxManifests) return {status: "unavailable", reason: "manifest_capacity"};
      if (counts.bytes + preparation.byteLength > policy.maxStoreBytes) return {status: "unavailable", reason: "store_capacity"};
      if (counts.staging >= policy.maxConcurrentCaptures) return {status: "unavailable", reason: "capture_capacity"};
      const record: FileMaterialRecord = {preparation, state: "staging", digest: null, finishedAt: null, reason: null, pins: [preparation.runId], expiresAt: null};
      const text = JSON.stringify(record);
      this.data.prepare("INSERT INTO file_materials VALUES (?,?,?,?,?)").run(executionEvidenceKey(preparation.ref), record.state, preparation.byteLength, digest(text), text);
      return {status: "reserved", record};
    })();
  }

  append(reference: ExecutionEvidenceRef<"material">, offset: number, base64: string): void {
    const bytes = decodeChunk(base64);
    integer(offset);
    this.data.transaction(() => {
      const record = this.require(reference);
      if (record.state !== "staging" || offset + bytes.length > record.preparation.byteLength) fail("file_material_stage_invalid");
      const key = executionEvidenceKey(reference);
      const prior = this.data.prepare("SELECT offset,bytes,digest FROM file_material_chunks WHERE reference_key=? AND offset=?").get(key, offset) as Chunk | undefined;
      if (prior) {
        checkChunk(prior);
        if (!bytes.equals(prior.bytes)) fail("file_material_chunk_conflict");
        return;
      }
      const row = this.data.prepare("SELECT coalesce(max(offset + length(bytes)),0) AS next FROM file_material_chunks WHERE reference_key=?").get(key) as {next: number};
      if (offset !== row.next) fail("file_material_chunk_order_invalid");
      this.data.prepare("INSERT INTO file_material_chunks VALUES (?,?,?,?)").run(key, offset, bytes, digest(bytes));
    })();
  }

  publish(reference: ExecutionEvidenceRef<"material">, expectedDigest: string, at: string): FileMaterialRecord {
    date(at);
    if (!validFileDigest(expectedDigest)) fail("file_material_digest_invalid");
    return this.data.transaction(() => {
      const record = this.require(reference);
      if (record.state === "available") {
        if (record.digest !== expectedDigest || record.finishedAt !== at) fail("file_material_identity_conflict");
        return record;
      }
      if (record.state !== "staging") fail("file_material_stage_invalid");
      const hash = createHash("sha256");
      let size = 0;
      for (const chunk of this.data.prepare("SELECT offset,bytes,digest FROM file_material_chunks WHERE reference_key=? ORDER BY offset").iterate(executionEvidenceKey(reference)) as Iterable<Chunk>) {
        checkChunk(chunk);
        if (chunk.offset !== size) fail("file_material_incomplete");
        hash.update(chunk.bytes); size += chunk.bytes.length;
      }
      const actualDigest = `sha256:${hash.digest("hex")}`;
      if (size !== record.preparation.byteLength || expectedDigest !== actualDigest ||
          record.preparation.before.kind === "present" && record.preparation.before.contentDigest !== actualDigest) fail("file_material_incomplete");
      if (Date.parse(at) < Date.parse(record.preparation.preparedAt)) fail("file_material_time_invalid");
      const complete: FileMaterialRecord = {...record, state: "available", digest: actualDigest, finishedAt: at};
      this.save(complete);
      return complete;
    })();
  }

  read(reference: ExecutionEvidenceRef<"material">): FileMaterialRecord | null {
    const key = executionEvidenceKey(reference);
    const row = this.data.prepare("SELECT * FROM file_materials WHERE reference_key=?").get(key) as Row | undefined;
    if (!row) return null;
    try {
      if (digest(row.value) !== row.digest) throw new Error();
      const record = JSON.parse(row.value) as FileMaterialRecord;
      const preparation = snapshotFileMaterialPreparation(record.preparation);
      if (executionEvidenceKey(preparation.ref) !== key || !["staging", "available", "aborted", "expired"].includes(record.state) || row.state !== record.state ||
          !Array.isArray(record.pins) || new Set(record.pins).size !== record.pins.length || record.pins.some(pin => !validToken(pin)) ||
          (record.state === "staging" || record.state === "available" ? preparation.byteLength : 0) !== row.reserved) throw new Error();
      if (record.state === "staging" && (record.digest !== null || record.finishedAt !== null || record.reason !== null || record.pins.length === 0 || record.expiresAt !== null)) throw new Error();
      if (record.state === "available" && (!validFileDigest(record.digest) || !record.finishedAt || record.reason !== null || (record.pins.length === 0) !== (record.expiresAt !== null))) throw new Error();
      if ((record.state === "aborted" || record.state === "expired") && (!record.reason || record.pins.length !== 0 || record.expiresAt !== null)) throw new Error();
      if (record.expiresAt !== null) date(record.expiresAt);
      if (record.finishedAt !== null) date(record.finishedAt);
      return {...record, preparation};
    } catch { return fail("file_material_corrupt"); }
  }

  readRange(reference: ExecutionEvidenceRef<"material">, offset: number, length: number): FileMaterialRead {
    integer(offset); integer(length);
    if (length < 1 || length > policy.readBytes) fail("file_material_range_invalid");
    return this.data.transaction(() => {
      const record = this.require(reference);
      if (record.state !== "available" || record.preparation.before.kind === "absent") fail("file_material_content_unavailable");
      if (offset > record.preparation.byteLength) fail("file_material_range_invalid");
      const end = Math.min(offset + length, record.preparation.byteLength);
      const chunks = this.data.prepare("SELECT offset,bytes,digest FROM file_material_chunks WHERE reference_key=? AND offset < ? AND offset + length(bytes) > ? ORDER BY offset")
        .all(executionEvidenceKey(reference), end, offset) as Chunk[];
      const bytes = Buffer.alloc(end - offset);
      let next = offset;
      for (const chunk of chunks) {
        checkChunk(chunk);
        const start = Math.max(offset, chunk.offset), finish = Math.min(end, chunk.offset + chunk.bytes.length);
        if (start !== next) fail("file_material_corrupt");
        chunk.bytes.copy(bytes, start - offset, start - chunk.offset, finish - chunk.offset); next = finish;
      }
      if (next !== end) fail("file_material_corrupt");
      return {reference, offset, base64: bytes.toString("base64"), byteLength: bytes.length, totalBytes: record.preparation.byteLength, digest: record.digest!};
    })();
  }

  abort(reference: ExecutionEvidenceRef<"material">, reason: string, at: string): FileMaterialRecord {
    token(reason); date(at);
    return this.data.transaction(() => {
      const record = this.require(reference);
      if (record.state === "aborted" && record.reason === reason && record.finishedAt === at) return record;
      if (record.state !== "staging") fail("file_material_stage_invalid");
      this.data.prepare("DELETE FROM file_material_chunks WHERE reference_key=?").run(executionEvidenceKey(reference));
      const aborted: FileMaterialRecord = {...record, state: "aborted", finishedAt: at, reason, pins: [], expiresAt: null};
      this.save(aborted); return aborted;
    })();
  }

  pin(reference: ExecutionEvidenceRef<"material">, ownerId: string): FileMaterialRecord {
    token(ownerId);
    return this.data.transaction(() => {
      const record = this.require(reference);
      if (record.state !== "available") fail("file_material_content_unavailable");
      if (record.pins.includes(ownerId)) return record;
      if (record.pins.length >= 1024) fail("file_material_pin_capacity");
      const pinned = {...record, pins: [...record.pins, ownerId], expiresAt: null};
      this.save(pinned); return pinned;
    })();
  }

  release(reference: ExecutionEvidenceRef<"material">, ownerId: string, at: string): FileMaterialRecord {
    token(ownerId); date(at);
    return this.data.transaction(() => {
      const record = this.require(reference);
      if (!record.pins.includes(ownerId)) return record;
      if (record.state !== "available") fail("file_material_stage_invalid");
      const pins = record.pins.filter(pin => pin !== ownerId);
      const released = {...record, pins, expiresAt: pins.length ? null : new Date(Date.parse(at) + policy.retentionMs).toISOString()};
      this.save(released); return released;
    })();
  }

  expire(at: string): readonly FileMaterialRecord[] {
    date(at);
    return this.data.transaction(() => {
      const expired: FileMaterialRecord[] = [];
      const candidates = this.data.prepare(`SELECT reference_key FROM file_materials
        WHERE state='available' AND json_array_length(value, '$.pins')=0
        AND json_extract(value, '$.expiresAt') <= ? ORDER BY reference_key LIMIT ?`)
        .all(at, policy.expiryBatchSize) as {reference_key: string}[];
      for (const {reference_key} of candidates) {
        const ref = referenceFromKey(reference_key);
        const record = this.require(ref);
        if (record.state !== "available" || record.pins.length || record.expiresAt === null || record.expiresAt > at) continue;
        this.data.prepare("DELETE FROM file_material_chunks WHERE reference_key=?").run(executionEvidenceKey(ref));
        const updated: FileMaterialRecord = {...record, state: "expired", reason: "retention_expired", expiresAt: null};
        this.save(updated); expired.push(updated);
      }
      return expired;
    })();
  }

  pinnedOwners(): readonly string[] {
    return [...new Set(this.references().flatMap(ref => this.require(ref).pins))];
  }

  finalizePage(owners: readonly string[], after: string | null, at: string,
    mayRelease: (record: FileMaterialRecord) => boolean): {records: readonly FileMaterialRecord[]; next: string | null} {
    date(at);
    const rows = this.data.prepare("SELECT reference_key FROM file_materials WHERE reference_key > ? ORDER BY reference_key LIMIT ?")
      .all(after ?? "", policy.expiryBatchSize) as {reference_key: string}[];
    const records: FileMaterialRecord[] = [];
    for (const row of rows) {
      const ref = referenceFromKey(row.reference_key), record = this.require(ref);
      const released = record.pins.filter(owner => owners.includes(owner));
      if (!released.length || !mayRelease(record)) continue;
      if (record.state === "staging") records.push(this.abort(ref, "settled_without_effect", at));
      else if (record.state === "available") {
        let updated = record;
        for (const owner of released) updated = this.release(ref, owner, at);
        records.push(updated);
      }
    }
    return {records, next: rows.length === policy.expiryBatchSize ? rows.at(-1)!.reference_key : null};
  }

  private references(): readonly ExecutionEvidenceRef<"material">[] {
    return (this.data.prepare("SELECT reference_key FROM file_materials").all() as {reference_key: string}[])
      .map(row => referenceFromKey(row.reference_key));
  }
  private require(ref: ExecutionEvidenceRef<"material">): FileMaterialRecord {const record = this.read(ref); if (!record) fail("file_material_unavailable"); return record;}
  private save(record: FileMaterialRecord): void {
    const text = JSON.stringify(record);
    this.data.prepare("UPDATE file_materials SET state=?,reserved=?,digest=?,value=? WHERE reference_key=?")
      .run(record.state, record.state === "available" || record.state === "staging" ? record.preparation.byteLength : 0, digest(text), text, executionEvidenceKey(record.preparation.ref));
  }
}

function referenceFromKey(key: string): ExecutionEvidenceRef<"material"> {
  try {
    const [owner, kind, id, revision] = JSON.parse(key);
    const ref = {owner, kind, id, revision};
    if (kind !== "material" || executionEvidenceKey(ref) !== key) fail("file_material_corrupt");
    return ref;
  } catch {return fail("file_material_corrupt");}
}

function digest(bytes: string | Uint8Array): string {return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;}
function checkChunk(chunk: Chunk): void {
  if (!Buffer.isBuffer(chunk.bytes) || chunk.bytes.length < 1 || chunk.bytes.length > policy.chunkBytes || digest(chunk.bytes) !== chunk.digest) fail("file_material_corrupt");
}
function decodeChunk(base64: string): Buffer {
  if (typeof base64 !== "string" || base64.length < 1 || base64.length > Math.ceil(policy.chunkBytes / 3) * 4) fail("file_material_chunk_invalid");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 1 || bytes.length > policy.chunkBytes || bytes.toString("base64") !== base64) fail("file_material_chunk_invalid");
  return bytes;
}
function validToken(value: unknown): value is string {return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");}
function token(value: string): void {if (!validToken(value)) fail("file_material_input_invalid");}
function date(value: string): void {if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("file_material_time_invalid");}
function integer(value: number): void {if (!Number.isSafeInteger(value) || value < 0) fail("file_material_range_invalid");}
function fail(code: string): never {throw new ExecutionStoreError(code);}
