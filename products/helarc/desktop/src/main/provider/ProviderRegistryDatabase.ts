import {snapshotProviderDraft} from "./ProviderDraftValidation.js";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ProviderConfigurationError, providerToken, providerDestination,
  type ProviderConfiguration, type ProviderConfigurationDraft, type ProviderConfigurationReceipt } from "../../shared/ProviderConfiguration.js";
import { validCredentialRef } from "./ProviderCredentialStore.js";
import type { PrivateConnectionBinding, PrivateCredentialRevision, ProviderDependencyPin, ProviderRegistryCommand,
  ProviderRegistryEvent, ProviderRegistryUpdate, ProviderRegistryValue } from "./ProviderRegistryProtocol.js";

const schema = `
CREATE TABLE registry (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, epoch INTEGER NOT NULL, sealed_basis TEXT, identity TEXT NOT NULL);
CREATE TABLE configurations (id TEXT PRIMARY KEY, revision TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE revisions (id TEXT NOT NULL, revision TEXT NOT NULL, binding_id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,revision));
CREATE TABLE selection (id INTEGER PRIMARY KEY CHECK(id=1), configuration_id TEXT NOT NULL, revision TEXT NOT NULL);
CREATE TABLE credentials (id TEXT PRIMARY KEY, value TEXT NOT NULL, digest TEXT NOT NULL, configuration_id TEXT NOT NULL, target_key TEXT NOT NULL, status TEXT NOT NULL);
CREATE INDEX credentials_target ON credentials(target_key,status);
CREATE TABLE bindings (id TEXT PRIMARY KEY, configuration_id TEXT NOT NULL, configuration_revision TEXT NOT NULL, credential_id TEXT, revision INTEGER NOT NULL, revoked INTEGER NOT NULL, availability TEXT, observed_at TEXT);
CREATE INDEX bindings_credential ON bindings(credential_id);
CREATE TABLE updates (id TEXT PRIMARY KEY, owner_epoch INTEGER NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, disposition TEXT NOT NULL, revision TEXT, binding_id TEXT);
CREATE INDEX updates_disposition ON updates(disposition,id);
CREATE TABLE update_credentials (update_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL);
CREATE INDEX update_credentials_credential ON update_credentials(credential_id);
CREATE TABLE pins (id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, acceptance_id TEXT NOT NULL, owner TEXT NOT NULL, purpose TEXT NOT NULL, state TEXT NOT NULL);
CREATE INDEX pins_binding ON pins(binding_id,state);
CREATE TABLE events (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE repairs (binding_id TEXT NOT NULL, revision INTEGER NOT NULL, replacement_binding_id TEXT NOT NULL, confirmed_at TEXT NOT NULL, PRIMARY KEY(binding_id,revision));
`;
type Row = Record<string, string | number | null>;

/** Host-private metadata only. Vault I/O and execution acceptance never run inside these transactions. */
export class ProviderRegistryDatabase {
  work = { queries: 0, rowsRead: 0, rowsChanged: 0, statementsPrepared: 0 };
  readonly epoch: number;
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 5000");
      this.epoch = this.db.transaction(() => {
        if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='registry'").get()) {
          if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()) fail("provider_registry_unknown_schema");
          this.db.exec(schema); this.db.prepare("INSERT INTO registry VALUES(1,1,0,NULL,?)").run(randomUUID());
        }
        const row = this.db.prepare("SELECT version,epoch FROM registry WHERE id=1").get() as Row;
        if (row?.version !== 1 || !Number.isSafeInteger(row.epoch)) fail("provider_registry_corrupt");
        const epoch = Number(row.epoch) + 1;
        this.db.prepare("UPDATE registry SET epoch=? WHERE id=1").run(epoch);
        return epoch;
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { if (this.db.open) this.db.close(); }
  execute(command: ProviderRegistryCommand): ProviderRegistryValue {
    this.work = { queries: 0, rowsRead: 0, rowsChanged: 0, statementsPrepared: 0 };
    if (command.kind === "close") { this.close(); return null; }
    return this.db.transaction(() => {
      if (this.one("SELECT epoch FROM registry WHERE id=1")?.epoch !== this.epoch) fail("provider_registry_owner_stale");
      switch (command.kind) {
        case "identity": return String(this.one("SELECT identity FROM registry WHERE id=1")!.identity);
        case "pending_updates": {
          page(command.after, command.limit);
          return this.all("SELECT id,value,digest FROM updates WHERE disposition='pending' AND id>? ORDER BY id LIMIT ?", command.after, command.limit).map(row => {
            const update = JSON.parse(String(row.value)) as ProviderRegistryUpdate;
            if (hash(update) !== row.digest || update.id !== row.id) fail("provider_registry_corrupt");
            snapshotProviderDraft(update.draft); return update;
          });
        }
        case "list": {
          const selected = this.one("SELECT configuration_id,revision FROM selection WHERE id=1");
          return { configurations: this.all("SELECT id,revision FROM configurations WHERE archived=0 ORDER BY id").map(row => this.configuration(String(row.id), String(row.revision))),
            defaultSelection: selected ? { id: String(selected.configuration_id), revision: String(selected.revision) } : null };
        }
        case "get": {
          const current = this.one("SELECT revision FROM configurations WHERE id=?", token(command.id));
          return current ? this.configuration(command.id, command.revision ?? String(current.revision)) : null;
        }
        case "default": {
          const selected = this.one("SELECT configuration_id,revision FROM selection WHERE id=1");
          return selected ? this.configuration(String(selected.configuration_id), String(selected.revision)) : null;
        }
        case "key_basis": {
          let value = this.one("SELECT sealed_basis FROM registry WHERE id=1")!.sealed_basis;
          if (!value && command.sealed !== undefined) {
            if (this.one("SELECT 1 FROM credentials LIMIT 1")) fail("provider_credential_check_basis_missing");
            if (typeof command.sealed !== "string" || !command.sealed || command.sealed.length > 16384) fail("provider_credential_check_basis_invalid");
            this.run("UPDATE registry SET sealed_basis=? WHERE id=1", command.sealed); value = command.sealed;
          }
          return value as string | null;
        }
        case "begin_update": return this.begin(command.update);
        case "update_receipt": return this.receipt(token(command.id));
        case "verify_credential": {
          const credential = this.credential(token(command.id));
          if (credential.status !== "staged" && credential.status !== "verified") fail("provider_credential_not_usable");
          if (credential.equalityTag !== command.equalityTag) fail("provider_credential_changed");
          this.run("UPDATE credentials SET status='verified' WHERE id=?", credential.id); return null;
        }
        case "publish_update": return this.publish(token(command.id));
        case "abandon_update": {
          const receipt = this.receipt(token(command.id));
          if (!receipt) fail("provider_update_missing");
          if (receipt.disposition === "pending") {
            const row = this.one("SELECT owner_epoch FROM updates WHERE id=?", command.id)!;
            if (row.owner_epoch !== this.epoch) fail("provider_update_quiescence_unconfirmed");
            this.run("UPDATE updates SET disposition='abandoned' WHERE id=?", command.id);
            this.event("update_abandoned", command.id);
          }
          return this.receipt(command.id);
        }
        case "activate": {
          const config = this.current(token(command.id), token(command.revision));
          if (!config.model) fail("provider_model_required");
          this.usable(this.binding(config.connectionBindingId));
          this.run("INSERT INTO selection VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET configuration_id=excluded.configuration_id,revision=excluded.revision", config.id, config.revision);
          this.event("default_selected", config.connectionBindingId); return this.configuration(config.id, config.revision);
        }
        case "archive": {
          const config = this.current(token(command.id), token(command.revision));
          this.run("UPDATE configurations SET archived=1 WHERE id=?", config.id);
          this.run("DELETE FROM selection WHERE configuration_id=?", config.id);
          this.event("configuration_archived", config.connectionBindingId); return null;
        }
        case "binding": return this.binding(token(command.id));
        case "dependencies": {
          const binding = this.binding(token(command.id));
          const target = binding.credential ? targetKey(binding.credential.ref) : null;
          return {
            bindingRevision: binding.revision,
            bindingOutstanding: Number(this.one("SELECT count(*) AS count FROM pins WHERE binding_id=? AND state!='released'", binding.id)!.count),
            credentialOutstanding: target === null ? 0 : Number(this.one(`SELECT count(*) AS count FROM pins p JOIN bindings b ON b.id=p.binding_id
              WHERE b.credential_id IN (SELECT id FROM credentials WHERE target_key=?) AND p.state!='released'`, target)!.count),
            credentialBindings: target === null ? 0 : Number(this.one("SELECT count(*) AS count FROM bindings WHERE credential_id IN (SELECT id FROM credentials WHERE target_key=?) AND revoked=0", target)!.count),
          };
        }
        case "authorize": {
          const binding = this.binding(token(command.id)); this.usable(binding);
          if (binding.revision !== command.revision || (binding.credential?.id ?? null) !== command.credentialId) fail("provider_binding_changed");
          return null;
        }
        case "availability": {
          if (!["locally_resolvable", "missing", "changed", "unavailable"].includes(command.status)) fail("provider_availability_invalid");
          this.run("UPDATE bindings SET availability=?,observed_at=? WHERE id=? AND revision=?", command.status, new Date().toISOString(), token(command.id), command.revision);
          return null;
        }
        case "pin": return this.pin(command.pin);
        case "read_pin": {
          const row = this.one("SELECT * FROM pins WHERE id=?", token(command.id));
          return row ? { id: String(row.id), bindingId: String(row.binding_id), acceptanceId: String(row.acceptance_id), owner: String(row.owner), purpose: String(row.purpose), state: row.state as ProviderDependencyPin["state"] } : null;
        }
        case "settle_pin": {
          const row = this.one("SELECT * FROM pins WHERE id=?", token(command.id));
          if (!row || row.acceptance_id !== token(command.acceptanceId)) fail("provider_pin_acceptance_mismatch");
          if (!["confirmed", "released"].includes(command.disposition)) fail("provider_pin_disposition_invalid");
          if (row.state === "released" && command.disposition !== "released") fail("provider_pin_already_released");
          if (row.state === command.disposition) return null;
          this.run("UPDATE pins SET state=? WHERE id=?", command.disposition, command.id);
          this.event(`pin_${command.disposition}`, command.id); return null;
        }
        case "pins": {
          page(command.after, command.limit);
          const rows = command.bindingId ? this.all("SELECT * FROM pins WHERE binding_id=? AND id>? ORDER BY id LIMIT ?", token(command.bindingId), command.after, command.limit)
            : this.all("SELECT * FROM pins WHERE id>? ORDER BY id LIMIT ?", command.after, command.limit);
          return rows.map(row => ({ id: String(row.id), bindingId: String(row.binding_id), acceptanceId: String(row.acceptance_id), owner: String(row.owner), purpose: String(row.purpose), state: row.state as ProviderDependencyPin["state"] }));
        }
        case "repair": return this.repair(command);
        case "revoke": {
          const binding = this.binding(token(command.id));
          if (binding.revision !== command.revision) fail("provider_binding_changed");
          this.run("UPDATE bindings SET revoked=1,revision=revision+1 WHERE id=?", binding.id);
          this.event("binding_revoked", binding.id); return null;
        }
        case "destroy_credential": {
          const binding = this.binding(token(command.id));
          if (binding.revision !== command.revision) fail("provider_binding_changed");
          const credential = binding.credential;
          if (!credential || credential.ref.ownership !== "managed") fail("provider_credential_not_owned");
          const target = targetKey(credential.ref);
          this.run("UPDATE bindings SET revoked=1,revision=revision+1 WHERE credential_id IN (SELECT id FROM credentials WHERE target_key=?)", target);
          this.run("UPDATE credentials SET status='deleting' WHERE target_key=?", target);
          this.event("credential_destruction_authorized", binding.id);
          return { ...credential, status: "deleting" as const };
        }
        case "collectible": {
          page(command.after, command.limit);
          const rows = this.all("SELECT id FROM credentials WHERE id>? AND status!='deleted' ORDER BY id LIMIT ?", command.after, command.limit);
          return { examined: rows.length, next: rows.length === command.limit ? String(rows.at(-1)!.id) : null,
            candidates: rows.map(row => this.credential(String(row.id))).filter(credential => credential.ref.ownership === "managed" && (credential.status === "deleting" || !this.retained(credential.id))) };
        }
        case "claim_collection": {
          const credential = this.credential(token(command.id));
          if (credential.ref.ownership !== "managed") fail("provider_credential_not_owned");
          if (credential.status === "deleted") return null;
          if (credential.status === "deleting") return credential;
          if (this.retained(credential.id)) fail("provider_credential_retained");
          this.run("UPDATE credentials SET status='deleting' WHERE id=?", credential.id);
          this.event("credential_collection_claimed", credential.id); return { ...credential, status: "deleting" as const };
        }
        case "finish_collection": {
          const credential = this.credential(token(command.id));
          if (credential.status !== "deleting" && credential.status !== "deleted") fail("provider_collection_not_claimed");
          if (credential.status === "deleted") return null;
          this.run("UPDATE credentials SET status='deleted' WHERE target_key=?", targetKey(credential.ref));
          this.event("credential_collected", credential.id); return null;
        }
        case "events": {
          if (!Number.isSafeInteger(command.after) || command.after < 0) fail("provider_page_invalid");
          page("", command.limit);
          return this.all("SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?", command.after, command.limit)
            .map(row => ({ sequence: Number(row.sequence), kind: String(row.kind), subjectId: String(row.subject_id), occurredAt: String(row.occurred_at) } satisfies ProviderRegistryEvent));
        }
      }
    }).immediate();
  }
  private begin(input: ProviderRegistryUpdate): ProviderConfigurationReceipt {
    const id = token(input.id), configurationId = token(input.configurationId), draft = snapshotProviderDraft(input.draft);
    if (!/^provider-[a-f0-9-]{36}$/.test(configurationId)) fail("provider_configuration_identity_invalid");
    if (input.expectedRevision !== null) token(input.expectedRevision);
    if (!["keep", "replace", "none"].includes(input.credentialMode)) fail("provider_credential_intent_invalid");
    if ((input.credentialMode === "replace") !== (input.credential !== null)) fail("provider_credential_intent_invalid");
    if (input.credential) {
      token(input.credential.id);
      if (input.credential.status !== "staged" || !validCredentialRef(input.credential.ref, configurationId) || !/^[a-f0-9]{64}$/.test(input.credential.equalityTag)) fail("provider_credential_revision_invalid");
    }
    const normalized = { ...input, id, configurationId, draft }, digest = hash(normalized);
    const existing = this.one("SELECT digest FROM updates WHERE id=?", id);
    if (existing) {
      if (existing.digest !== digest) fail("provider_update_identity_conflict");
      return this.receipt(id)!;
    }
    const current = this.one("SELECT * FROM configurations WHERE id=?", configurationId);
    if ((current?.revision ?? null) !== input.expectedRevision || current?.archived === 1) fail("provider_configuration_conflict");
    if (!current && Number(this.one("SELECT count(*) AS count FROM configurations WHERE archived=0")!.count) >= 64) fail("provider_configuration_limit");
    if (current) {
      const previous = this.configuration(configurationId, String(current.revision));
      if (previous.protocol !== draft.protocol) fail("provider_protocol_immutable");
      if (input.credentialMode === "keep" && !isDeepStrictEqual(scope(previous), scope(draft))) fail("provider_credential_destination_consent_required");
    } else if (input.credentialMode === "keep") fail("provider_credential_not_configured");
    if (input.credential) {
      if (this.one("SELECT 1 FROM credentials WHERE id=?", input.credential.id)) fail("provider_credential_identity_conflict");
      if (this.one("SELECT 1 FROM credentials WHERE target_key=? AND status='deleting' LIMIT 1", targetKey(input.credential.ref))) fail("provider_credential_collection_in_progress");
      this.run("INSERT INTO credentials VALUES(?,?,?,?,?,'staged')", input.credential.id, JSON.stringify(input.credential), hash(input.credential), configurationId, targetKey(input.credential.ref));
    }
    const credentialId = input.credential?.id ?? (input.credentialMode === "keep" && current
      ? this.binding(this.configuration(configurationId, String(current.revision)).connectionBindingId).credential?.id ?? null : null);
    if (credentialId && input.credentialMode === "keep" && this.credential(credentialId).status !== "verified") fail("provider_credential_not_usable");
    this.run("INSERT INTO updates VALUES(?,?,?,?, 'pending',NULL,NULL)", id, this.epoch, digest, JSON.stringify(normalized));
    if (credentialId) this.run("INSERT INTO update_credentials VALUES(?,?)", id, credentialId);
    this.event("update_staged", id); return this.receipt(id)!;
  }
  private publish(id: string): ProviderConfigurationReceipt {
    const receipt = this.receipt(id); if (!receipt) fail("provider_update_missing");
    if (receipt.disposition !== "pending") return receipt;
    const row = this.one("SELECT * FROM updates WHERE id=?", id)!;
    // A restarted owner may finish a verified intent, but never replace its content or create another key.
    const update = JSON.parse(String(row.value)) as ProviderRegistryUpdate;
    if (hash(update) !== row.digest) fail("provider_registry_corrupt");
    const draft = snapshotProviderDraft(update.draft);
    const current = this.one("SELECT * FROM configurations WHERE id=?", update.configurationId);
    if ((current?.revision ?? null) !== update.expectedRevision || current?.archived === 1) fail("provider_configuration_conflict");
    const credentialId = this.one("SELECT credential_id FROM update_credentials WHERE update_id=?", id)?.credential_id ?? null;
    if (credentialId && this.credential(String(credentialId)).status !== "verified") fail("provider_credential_verification_required");
    const revision = randomUUID(), bindingId = `connection-${randomUUID()}`;
    const { name: _name, ...semantic } = draft;
    const value = { ...draft, id: update.configurationId, revision, semanticRevision: hash(semantic), connectionBindingId: bindingId,
      targetAttribution: providerDestination(draft.baseUrl, draft.protocol).attribution };
    this.run("INSERT INTO revisions VALUES(?,?,?,?,?)", value.id, revision, bindingId, hash(value), JSON.stringify(value));
    this.run("INSERT INTO configurations VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision", value.id, revision);
    this.run("INSERT INTO bindings VALUES(?,?,?,?,1,0,NULL,NULL)", bindingId, value.id, revision, credentialId);
    this.run("UPDATE updates SET disposition='committed',revision=?,binding_id=? WHERE id=?", revision, bindingId, id);
    this.event("configuration_committed", bindingId); return this.receipt(id)!;
  }
  private receipt(id: string): ProviderConfigurationReceipt | null {
    const row = this.one("SELECT value,digest,disposition,revision FROM updates WHERE id=?", id);
    if (!row) return null;
    const value = JSON.parse(String(row.value)) as ProviderRegistryUpdate;
    if (hash(value) !== row.digest || value.id !== id || !["pending", "committed", "abandoned"].includes(String(row.disposition))) fail("provider_registry_corrupt");
    return { updateId: id, disposition: row.disposition as ProviderConfigurationReceipt["disposition"],
      configuration: row.disposition === "committed" ? this.configuration(value.configurationId, String(row.revision)) : null };
  }
  private current(id: string, revision: string): ProviderConfiguration {
    const row = this.one("SELECT * FROM configurations WHERE id=?", id);
    if (!row || row.archived !== 0 || row.revision !== revision) fail("provider_configuration_conflict");
    return this.configuration(id, revision);
  }
  private configuration(id: string, revision: string): ProviderConfiguration {
    const row = this.one("SELECT digest,value FROM revisions WHERE id=? AND revision=?", id, revision);
    if (!row) fail("provider_configuration_missing");
    const value = JSON.parse(String(row.value));
    if (hash(value) !== row.digest || value.id !== id || value.revision !== revision) fail("provider_registry_corrupt");
    const draft = snapshotProviderDraft(pickDraft(value));
    const binding = this.one("SELECT * FROM bindings WHERE id=?", value.connectionBindingId);
    if (!binding || binding.configuration_id !== id || binding.configuration_revision !== revision) fail("provider_binding_missing");
    const credential = binding.credential_id ? this.credential(String(binding.credential_id)) : null;
    const selected = this.one("SELECT 1 FROM selection WHERE configuration_id=? AND revision=?", id, revision);
    return { ...draft, id, revision, semanticRevision: value.semanticRevision, connectionBindingId: value.connectionBindingId,
      targetAttribution: value.targetAttribution, archived: this.one("SELECT archived FROM configurations WHERE id=?", id)?.archived === 1,
      isDefault: !!selected, credentialBackend: !credential ? "none" : credential.ref.storage === "safe-storage" ? "safe-storage"
        : credential.ref.ownership === "managed" ? "windows-managed" : "windows-reference",
      credentialAvailability: binding.revoked ? "revoked" : !credential ? "not_configured" : credential.status === "verified" ? (binding.availability ?? "unchecked") as ProviderConfiguration["credentialAvailability"] : credential.status === "deleted" ? "missing" : "unavailable",
      availabilityObservedAt: binding.observed_at === null ? null : String(binding.observed_at) };
  }
  private credential(id: string): PrivateCredentialRevision {
    const row = this.one("SELECT * FROM credentials WHERE id=?", id); if (!row) fail("provider_credential_missing");
    const value = JSON.parse(String(row.value)) as PrivateCredentialRevision;
    if (hash(value) !== row.digest || !validCredentialRef(value.ref, String(row.configuration_id)) || targetKey(value.ref) !== row.target_key || value.id !== id || !/^[a-f0-9]{64}$/.test(value.equalityTag) || !["staged", "verified", "deleting", "deleted", "revoked"].includes(String(row.status))) fail("provider_registry_corrupt");
    return { ...value, status: row.status as PrivateCredentialRevision["status"] };
  }
  private binding(id: string): PrivateConnectionBinding {
    const row = this.one("SELECT * FROM bindings WHERE id=?", id); if (!row) fail("provider_binding_missing");
    return { id, revision: Number(row.revision), configuration: this.configuration(String(row.configuration_id), String(row.configuration_revision)),
      credential: row.credential_id ? this.credential(String(row.credential_id)) : null, revoked: row.revoked === 1 };
  }
  private usable(binding: PrivateConnectionBinding): void {
    if (binding.revoked) fail("provider_binding_revoked");
    if (binding.credential && binding.credential.status !== "verified") fail("provider_credential_not_usable");
    if (binding.credential && this.one("SELECT 1 FROM credentials WHERE target_key=? AND status='deleting' LIMIT 1", targetKey(binding.credential.ref))) fail("provider_credential_collection_in_progress");
    if (!binding.credential && binding.configuration.protocol !== "ollama.chat") fail("provider_credential_required");
  }
  private pin(pin: ProviderDependencyPin): null {
    for (const field of [pin.id, pin.bindingId, pin.acceptanceId, pin.owner, pin.purpose]) token(field);
    if (pin.state !== "provisional") fail("provider_pin_invalid");
    const existing = this.one("SELECT * FROM pins WHERE id=?", pin.id);
    if (existing) {
      if (existing.binding_id !== pin.bindingId || existing.acceptance_id !== pin.acceptanceId || existing.owner !== pin.owner || existing.purpose !== pin.purpose || existing.state === "released") fail("provider_pin_identity_conflict");
      return null;
    }
    this.usable(this.binding(pin.bindingId));
    this.run("INSERT INTO pins VALUES(?,?,?,?,?,'provisional')", pin.id, pin.bindingId, pin.acceptanceId, pin.owner, pin.purpose);
    this.event("pin_provisional", pin.id); return null;
  }
  private repair(command: Extract<ProviderRegistryCommand, { kind: "repair" }>): PrivateConnectionBinding {
    const original = this.binding(token(command.id)), replacement = this.binding(token(command.replacementBindingId));
    if (original.revision !== command.revision) fail("provider_binding_changed");
    this.usable(replacement);
    if (!command.confirmedSameScope || !isDeepStrictEqual(scope(original.configuration), scope(replacement.configuration))) fail("provider_repair_scope_mismatch");
    this.run("UPDATE bindings SET credential_id=?,revision=revision+1,revoked=0,availability=NULL,observed_at=NULL WHERE id=?", replacement.credential?.id ?? null, original.id);
    this.run("INSERT INTO repairs VALUES(?,?,?,?)", original.id, original.revision + 1, replacement.id, new Date().toISOString());
    this.event("binding_repaired", original.id); return this.binding(original.id);
  }
  private retained(id: string): boolean {
    const target = String(this.one("SELECT target_key FROM credentials WHERE id=?", id)!.target_key);
    return !!this.one(`SELECT 1 FROM update_credentials uc JOIN updates u ON u.id=uc.update_id WHERE uc.credential_id IN (SELECT id FROM credentials WHERE target_key=?) AND u.disposition='pending' LIMIT 1`, target) ||
      !!this.one(`SELECT 1 FROM bindings b JOIN configurations c ON c.id=b.configuration_id AND c.revision=b.configuration_revision
        WHERE b.credential_id IN (SELECT id FROM credentials WHERE target_key=?) AND c.archived=0 AND b.revoked=0 LIMIT 1`, target) ||
      !!this.one(`SELECT 1 FROM bindings b JOIN selection s ON s.configuration_id=b.configuration_id AND s.revision=b.configuration_revision
        WHERE b.credential_id IN (SELECT id FROM credentials WHERE target_key=?) AND b.revoked=0 LIMIT 1`, target) ||
      !!this.one(`SELECT 1 FROM bindings b JOIN pins p ON p.binding_id=b.id WHERE b.credential_id IN (SELECT id FROM credentials WHERE target_key=?) AND p.state!='released' LIMIT 1`, target);
  }
  private event(kind: string, subject: string): void { this.run("INSERT INTO events(kind,subject_id,occurred_at) VALUES(?,?,?)", kind, subject, new Date().toISOString()); }
  private statement(sql: string): Database.Statement {
    let value = this.statements.get(sql); if (!value) { value = this.db.prepare(sql); this.statements.set(sql, value); this.work.statementsPrepared++; } return value;
  }
  private one(sql: string, ...parameters: (string | number | null)[]): Row | undefined { this.work.queries++; const result=this.statement(sql).get(...parameters) as Row | undefined; if(result)this.work.rowsRead++;return result; }
  private all(sql: string, ...parameters: (string | number | null)[]): Row[] { this.work.queries++;const result=this.statement(sql).all(...parameters) as Row[];this.work.rowsRead+=result.length;return result; }
  private run(sql: string, ...parameters: (string | number | null)[]): void { this.work.queries++;this.work.rowsChanged+=this.statement(sql).run(...parameters).changes; }
}
function pickDraft(value: ProviderConfigurationDraft): ProviderConfigurationDraft {
  return { protocol: value.protocol, name: value.name, baseUrl: value.baseUrl, model: value.model, generationLifetimeMs: value.generationLifetimeMs, native: value.native, observation: value.observation,
    ...(value.capacityDeclaration!==undefined?{capacityDeclaration:value.capacityDeclaration}:{}),
    ...(value.inRequestCompaction!==undefined?{inRequestCompaction:value.inRequestCompaction}:{}) };
}
function scope(value: ProviderConfigurationDraft): unknown {
  return { protocol: value.protocol, baseUrl: value.baseUrl, organization: value.native.protocol === "openai.responses" ? value.native.organization : null,
    project: value.native.protocol === "openai.responses" ? value.native.project : null };
}
function page(after: string, limit: number): void { if (typeof after !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("provider_page_invalid"); }
function token(value: unknown): string { return providerToken(value); }
function targetKey(ref: PrivateCredentialRevision["ref"]): string {
  return hash([ref.storage, ref.storage === "windows" ? ref.id.toUpperCase() : ref.id]);
}
function fail(code: string): never { throw new ProviderConfigurationError(code); }
function hash(value: unknown): string {
  function canonical(input: unknown): unknown { return Array.isArray(input) ? input.map(canonical) : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : input; }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
