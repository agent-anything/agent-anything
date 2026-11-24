import {snapshotProviderDraft} from "./ProviderDraftValidation.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProviderRegistryDatabase } from "./ProviderRegistryDatabase.js";
import { ProviderConfigurationService } from "./ProviderConfigurationService.js";
import { createProviderSettingsService } from "./ProviderSettingsService.js";
import { ProviderCredentialStore } from "./ProviderCredentialStore.js";
import { SafeStorageCredentialBackend, type PersistedProviderCredential } from "./SafeStorageCredentialBackend.js";
import { defaultProviderDraft, type ProviderConfigurationReceipt, type SaveProviderConfiguration } from "../../shared/ProviderConfiguration.js";
import type { ProviderRegistryCommand, ProviderRegistryPort } from "./ProviderRegistryProtocol.js";
import { discoverProviderModels } from "./ProviderModelDiscovery.js";
import { ProviderConnectionRetention } from "./ProviderConnectionRetention.js";

const roots: string[] = [], databases: ProviderRegistryDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of roots.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("helarc-provider-registry-")) throw new Error("Unsafe test cleanup");
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helarc-provider-registry-")); roots.push(root);
  const protectedRecords = new Map<string, PersistedProviderCredential>(), windows = new Map<string, string>();
  const counts = { reads: 0, creates: 0, deletes: 0 };
  const cipher = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).toString("base64"), decryptString: (value: string) => Buffer.from(value, "base64").toString() };
  const credentials = new ProviderCredentialStore(new SafeStorageCredentialBackend({
    async read(id) { counts.reads++; return protectedRecords.get(id) ?? null; },
    async write(record) { counts.creates++; protectedRecords.set(record.profileId, record); },
    async delete(id) { counts.deletes++; protectedRecords.delete(id); },
  }, cipher), {
    async available() { return true; }, async read(id) { counts.reads++; return windows.get(id) ?? null; },
    async create(id, secret) { counts.creates++; windows.set(id, secret); }, async delete(id) { counts.deletes++; windows.delete(id); },
  });
  const open = () => {
    const database = new ProviderRegistryDatabase(join(root, "provider.sqlite")); databases.push(database);
    const port: ProviderRegistryPort = { async request(command) { return database.execute(command); }, async close() { database.close(); } };
    return { database, port, service: new ProviderConfigurationService(port, credentials, cipher) };
  };
  return { ...open(), open, root, counts, windows, protectedRecords };
}
function input(overrides: Partial<SaveProviderConfiguration> = {}): SaveProviderConfiguration {
  return { configurationId: `provider-${randomUUID()}`, updateId: randomUUID(), expectedRevision: null,
    draft: defaultProviderDraft("openai.responses"), credential: { kind: "set", storage: "windows-managed", secret: "synthetic-key" }, ...overrides };
}
function configuration(receipt: ProviderConfigurationReceipt) {
  if (!receipt.configuration) throw new Error("Expected committed configuration"); return receipt.configuration;
}
describe("Protocol configuration and Host connection custody", () => {
  it("saves before model selection without activation; lists never resolve secrets", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    expect(saved.model).toBe(""); expect(saved.credentialBackend).toBe("windows-managed");
    const reads = f.counts.reads;
    for (let i = 0; i < 10; i++) expect((await f.service.list()).defaultSelection).toBeNull();
    expect(f.counts.reads).toBe(reads);
    await expect(f.service.activate(saved.id, saved.revision, () => undefined)).rejects.toThrow("provider_model_required");
    expect(JSON.stringify(await f.service.list())).not.toContain("synthetic-key");
    expect(JSON.stringify(await f.service.list())).not.toContain("Helarc/Provider/");
  });
  it("queries a committed update after lost acknowledgement without creating another key", async () => {
    const f = fixture(), request = input();
    const first = await f.service.save(request), creates = f.counts.creates;
    expect(await f.service.save(request)).toEqual(first);
    expect(await f.service.receipt(request.updateId)).toEqual(first);
    expect(f.counts.creates).toBe(creates);
    await expect(f.service.save({ ...request, credential: { kind: "set", storage: "windows-managed", secret: "changed-key" } })).rejects.toThrow("provider_update_identity_conflict");
  });
  it("publishes only one concurrent expected revision and retains the winning key", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    const edit = { configurationId: saved.id, expectedRevision: saved.revision, draft: { ...defaultProviderDraft("openai.responses"), model: "test-model" } };
    const results = await Promise.allSettled([f.service.save(input(edit)), f.service.save(input(edit))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const current = await f.service.get(saved.id);
    expect(current?.model).toBe("test-model");
    await expect(f.service.withConnection(current!.connectionBindingId, async (_config, key) => key)).resolves.toBe("synthetic-key");
  });
  it("preserves a default revision independently of editing and browsing", async () => {
    const f = fixture(), draft = { ...defaultProviderDraft("openai.responses"), model: "first" };
    const saved = configuration(await f.service.save(input({ draft })));
    await f.service.activate(saved.id, saved.revision, () => undefined);
    const edited = configuration(await f.service.save(input({ configurationId: saved.id, expectedRevision: saved.revision, draft: { ...draft, model: "second" }, credential: { kind: "keep" } })));
    expect((await f.service.defaultConfiguration())?.model).toBe("first");
    expect((await f.service.get(edited.id))?.model).toBe("second");
    await expect(f.service.activate(edited.id, edited.revision, () => { throw new Error("not implemented"); })).rejects.toThrow("not implemented");
    expect((await f.service.defaultConfiguration())?.revision).toBe(saved.revision);
  });
  it("retains separate Parent, Child and auxiliary pins after rotation and archive", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    for (const owner of ["parent", "child", "auxiliary"]) {
      await f.service.pin({ id: owner, bindingId: saved.connectionBindingId, owner, purpose: "model", acceptanceId: `accept:${owner}`, state: "provisional" });
      await f.service.settlePin(owner, `accept:${owner}`, "confirmed");
    }
    const replacement = configuration(await f.service.save(input({ configurationId: saved.id, expectedRevision: saved.revision })));
    await f.service.archive(replacement.id, replacement.revision);
    await f.service.settlePin("parent", "accept:parent", "released");
    await f.service.collect();
    await expect(f.service.withConnection(saved.connectionBindingId, async (_config, key) => key)).resolves.toBe("synthetic-key");
    expect((await f.service.pins()).filter(pin => pin.state === "confirmed")).toHaveLength(2);
    await f.service.settlePin("child", "accept:child", "released");
    await f.service.settlePin("auxiliary", "accept:auxiliary", "released");
    expect((await f.service.collect()).deleted).toBe(1);
    await expect(f.service.withConnection(saved.connectionBindingId, async () => null)).rejects.toThrow("provider_credential_not_usable");
  });
  it("fences prior owners and retains provisional acceptance across restart", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    const pin = { id: "pin", bindingId: saved.connectionBindingId, owner: "root", purpose: "task", acceptanceId: "original-acceptance", state: "provisional" as const };
    await f.service.pin(pin);
    const restarted = f.open();
    await expect(f.service.list()).rejects.toThrow("provider_registry_owner_stale");
    expect(await restarted.service.pins()).toEqual([pin]);
    await restarted.service.pin(pin);
    await restarted.service.settlePin(pin.id, pin.acceptanceId, "confirmed");
    expect(await restarted.service.pins()).toEqual([{ ...pin, state: "confirmed" }]);
  });
  it("uses the verified external bytes once, detecting changes before the next dispatch", async () => {
    const f = fixture(); f.windows.set("external-test", "external-first");
    const saved = configuration(await f.service.save(input({ credential: { kind: "reference", target: "external-test", encoding: "utf8" } })));
    const before = f.counts.reads;
    expect(await f.service.withConnection(saved.connectionBindingId, async (_config, key) => key)).toBe("external-first");
    expect(f.counts.reads - before).toBe(1);
    f.windows.set("external-test", "external-second");
    await expect(f.service.withConnection(saved.connectionBindingId, async () => null)).rejects.toThrow("provider_credential_changed");
    await f.service.archive(saved.id, saved.revision); await f.service.collect();
    expect(f.windows.get("external-test")).toBe("external-second");
  });
  it.each([
    ["hElArC/pRoViDeR/example", "provider_credential_target_reserved"],
    ["", "provider_credential_selection_invalid"],
  ])("rejects external target %j before reading credentials or recording a save", async (target, code) => {
    const f = fixture(), api = createProviderSettingsService(f.service, { eligibility() { throw new Error("unexpected activation"); } });
    const request = input({ credential: { kind: "reference", target, encoding: "utf16le" } });
    expect(await api.save(request)).toEqual({ ok: false, code });
    expect(await f.service.receipt(request.updateId)).toBeNull();
    expect(f.counts).toEqual({ reads: 0, creates: 0, deletes: 0 });
  });
  it("repairs only accepted scope while preserving the old model and options", async () => {
    const f = fixture(), draft = { ...defaultProviderDraft("openai.responses"), model: "original-model" };
    const first = configuration(await f.service.save(input({ draft })));
    const replacement = configuration(await f.service.save(input({ draft: { ...draft, model: "different-new-model" }, credential: { kind: "set", storage: "windows-managed", secret: "rotated" } })));
    await f.service.repair(first.connectionBindingId, 1, replacement.connectionBindingId, true);
    expect(await f.service.withConnection(first.connectionBindingId, async (config, key) => [config.model, key])).toEqual(["original-model", "rotated"]);
    const foreign = configuration(await f.service.save(input({ draft: { ...draft, baseUrl: "https://other.test/v1" } })));
    await expect(f.service.repair(first.connectionBindingId, 2, foreign.connectionBindingId, true)).rejects.toThrow("provider_repair_scope_mismatch");
  });
  it("fences dispatch on revocation while local binding reads remain available", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    await f.service.revoke(saved.connectionBindingId, 1);
    expect((await f.service.binding(saved.connectionBindingId)).configuration.revision).toBe(saved.revision);
    await expect(f.service.withConnection(saved.connectionBindingId, async () => null)).rejects.toThrow("provider_binding_revoked");
  });
  it("allows a safe display rename without changing semantic identity", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    const next = configuration(await f.service.save(input({ configurationId: saved.id, expectedRevision: saved.revision,
      draft: { ...defaultProviderDraft("openai.responses"), name: "Renamed" }, credential: { kind: "keep" } })));
    expect(next.semanticRevision).toBe(saved.semanticRevision);
    expect(next.revision).not.toBe(saved.revision);
  });
  it("refuses secret normalization, foreign endpoints and unauthorized storage combinations", async () => {
    const f = fixture();
    await expect(f.service.save(input({ credential: { kind: "set", storage: "safe-storage", secret: " key " } }))).rejects.toThrow("provider_credential_invalid");
    const oversized = input({ credential: { kind: "set", storage: "windows-managed", secret: "x".repeat(1281) } });
    await expect(f.service.save(oversized)).rejects.toThrow("provider_credential_invalid");
    expect(await f.service.receipt(oversized.updateId)).toBeNull();
    await expect(f.service.save(input({ draft: { ...defaultProviderDraft("openai.responses"), baseUrl: "https://api.deepseek.com" } }))).rejects.toThrow("provider_destination_protocol_mismatch");
    const draft = defaultProviderDraft("openai.responses");
    if (draft.native.protocol !== "openai.responses") throw new Error();
    expect(() => snapshotProviderDraft({ ...draft, native: { ...draft.native, transport: ["http"] } })).toThrow("provider_native_choices_invalid");
    expect(() => snapshotProviderDraft({ ...draft, native: { ...draft.native, continuity: ["replay"] } })).toThrow("provider_native_choices_invalid");
    const ollama = defaultProviderDraft("ollama.chat");
    expect(() => snapshotProviderDraft({ ...ollama, native: { ...ollama.native, think: ["default"] } })).toThrow("provider_thinking_invalid");
    await expect(f.service.save(input({ draft: { ...draft, native: { ...draft.native, background: true } } }))).rejects.toThrow("provider_native_retention_not_authorized");
    expect(f.counts.creates).toBe(0);
  });
  it("publishes a verified staged update after restart without rewriting its key", async () => {
    const f = fixture(), request = input();
    let stopped = false;
    const original = f.port.request.bind(f.port);
    f.port.request = async command => {
      if (command.kind === "publish_update" && !stopped) { stopped = true; throw new Error("crash before publication"); }
      return original(command);
    };
    await expect(f.service.save(request)).rejects.toThrow("crash before publication");
    const creates = f.counts.creates, restarted = f.open();
    expect(await restarted.service.reconcileUpdates()).toMatchObject({ resolved: 1, retained: 0 });
    expect((await restarted.service.receipt(request.updateId))?.disposition).toBe("committed");
    expect(f.counts.creates).toBe(creates);
  });
  it("does not let a collection claim race a new dependency", async () => {
    const f=fixture(),saved=configuration(await f.service.save(input()));
    const binding=await f.service.binding(saved.connectionBindingId);
    await f.service.archive(saved.id,saved.revision);
    await f.port.request({kind:"claim_collection",id:binding.credential!.id});
    await expect(f.service.pin({id:"late-pin",bindingId:binding.id,acceptanceId:"late-accept",owner:"child",purpose:"task",state:"provisional"})).rejects.toThrow("provider_credential_not_usable");
  });
  it("advances collection pagination even when a whole page is retained", async () => {
    const f=fixture();
    const first=configuration(await f.service.save(input({configurationId:"provider-00000000-0000-0000-0000-000000000000"})));
    const last=configuration(await f.service.save(input({configurationId:"provider-ffffffff-ffff-ffff-ffff-ffffffffffff"})));
    await f.service.archive(last.id,last.revision);
    const page=await f.service.collect("",1);expect(page.deleted).toBe(0);expect(page.next).not.toBeNull();
    expect((await f.service.collect(page.next!,1)).deleted).toBe(1);
    expect((await f.service.binding(first.connectionBindingId)).credential?.status).toBe("verified");
  });
  it("retains a managed entry shared by explicit repairs across configurations", async () => {
    const f = fixture(), managed = configuration(await f.service.save(input()));
    const original = await f.service.binding(managed.connectionBindingId), target = original.credential!.ref.id;
    await expect(f.service.save(input({ credential: { kind: "reference", target: target.toUpperCase(), encoding: "utf16le" } }))).rejects.toMatchObject({ code: "provider_credential_target_reserved" });
    const alias = configuration(await f.service.save(input()));
    await f.service.repair(alias.connectionBindingId, 1, managed.connectionBindingId, true);
    await f.service.pin({ id: "alias-child", bindingId: alias.connectionBindingId, acceptanceId: "accepted-child", owner: "child", purpose: "task", state: "provisional" });
    await f.service.archive(managed.id, managed.revision);
    expect((await f.service.collect()).deleted).toBe(1);
    expect(f.windows.has(target)).toBe(true);
    expect(await f.service.dependencies(managed.connectionBindingId)).toMatchObject({ bindingOutstanding: 0, credentialOutstanding: 1, credentialBindings: 2 });
    await f.service.archive(alias.id, alias.revision);
    expect((await f.service.collect()).deleted).toBe(0);
    await f.service.settlePin("alias-child", "accepted-child", "released");
    expect((await f.service.collect()).deleted).toBe(1);
    expect((await f.service.binding(alias.connectionBindingId)).credential?.status).toBe("deleted");
  });
  it("resumes explicit credential destruction after interruption despite outstanding dependencies", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    await f.service.pin({ id: "retained", bindingId: saved.connectionBindingId, acceptanceId: "accept", owner: "child", purpose: "task", state: "provisional" });
    await f.port.request({ kind: "destroy_credential", id: saved.connectionBindingId, revision: 1 });
    const restarted = f.open();
    await expect(restarted.service.withConnection(saved.connectionBindingId, async () => null)).rejects.toThrow("provider_binding_revoked");
    expect((await restarted.service.collect()).deleted).toBe(1);
    expect((await restarted.service.readPin("retained"))?.state).toBe("provisional");
    expect((await restarted.service.binding(saved.connectionBindingId)).configuration.revision).toBe(saved.revision);
  });
  it("rechecks revocation after credential resolution and never calls the sender", async () => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    const original = f.port.request.bind(f.port);
    f.port.request = async command => {
      if (command.kind === "authorize") await f.service.revoke(saved.connectionBindingId, 1);
      return original(command);
    };
    let sends = 0;
    await expect(f.service.withConnection(saved.connectionBindingId, async () => { sends++; })).rejects.toThrow("provider_binding_revoked");
    expect(sends).toBe(0);
  });
  it("reconciles a lost acceptance ACK from original execution evidence without reading a key", async () => {
    const f=fixture(),saved=configuration(await f.service.save(input())),pin={id:"pin",bindingId:saved.connectionBindingId,acceptanceId:"acceptance",owner:"root",purpose:"task",state:"provisional" as const};
    let accepted=false;
    const custody=new ProviderConnectionRetention(f.service,{async read(){return accepted?"accepted":"unknown";}});
    await expect(custody.accept(pin,async()=>{accepted=true;throw new Error("lost ACK");})).rejects.toThrow("lost ACK");
    expect((await f.service.readPin(pin.id))?.state).toBe("provisional");
    f.windows.clear();const reads=f.counts.reads;
    expect((await custody.recover({kind:"connection",bindingId:pin.bindingId,pinId:pin.id,acceptanceId:pin.acceptanceId})).revision).toBe(saved.revision);
    expect(f.counts.reads).toBe(reads);
    await expect(f.service.withConnection(pin.bindingId,async()=>null)).rejects.toThrow("provider_credential_missing");
  });
  it("discovers only on request using the bound URL and exact verified key", async () => {
    const f=fixture(),saved=configuration(await f.service.save(input({draft:{...defaultProviderDraft("openai.responses"),baseUrl:"http://localhost:29999/proxy/v1"}})));
    const calls: {url:string;init:RequestInit|undefined}[]=[];
    const fetcher:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({data:[{id:"model-a"},{id:"model-b"}]});};
    const reads=f.counts.reads;
    const result=await discoverProviderModels(f.service,saved.id,saved.revision,fetcher);
    expect(calls).toHaveLength(1);expect(calls[0].url).toBe("http://localhost:29999/proxy/v1/models");
    expect(calls[0].init?.redirect).toBe("manual");expect((calls[0].init?.headers as Record<string,string>).Authorization).toBe("Bearer synthetic-key");
    expect(result.models).toEqual(["model-a","model-b"]);expect(result.capabilityEvidence).toBe("unknown");expect(f.counts.reads-reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
  });
  it("refuses redirects and stale discovery without leaking remote response text", async () => {
    const f=fixture(),saved=configuration(await f.service.save(input()));
    await expect(discoverProviderModels(f.service,saved.id,saved.revision,async()=>new Response("secret in remote error",{status:302,headers:{location:"https://elsewhere.test"}}))).rejects.toThrow("provider_redirect_refused");
    await expect(discoverProviderModels(f.service,saved.id,saved.revision,async()=>{
      await f.service.archive(saved.id,saved.revision);return Response.json({data:[{id:"model"}]});
    })).rejects.toThrow("provider_discovery_revision_stale");
  });
  it.each([
    [401, "invalid_api_key", "invalid_api_key"],
    [403, "insufficient_permissions", "insufficient_permissions"],
    [401, "secret-in-error-code", null],
    [403, "x".repeat(8200), null],
  ] as const)("returns only the HTTP status and recognized error code for model discovery (%#)", async (status, remoteCode, expected) => {
    const f = fixture(), saved = configuration(await f.service.save(input()));
    const api = createProviderSettingsService(f.service, { eligibility() { throw new Error("unexpected activation"); } },
      async () => Response.json({error: {code: remoteCode, message: "remote message echoes synthetic-key"}}, {status}));
    expect(await api.discover(saved)).toEqual({ok: false, code: "provider_authentication_rejected",
      discoveryRejection: {httpStatus: status, providerCode: expected}});
  });
});
