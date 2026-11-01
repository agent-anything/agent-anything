import { describe, expect, it, vi } from "vitest";
import { createHelarcProviderProfile } from "@agent-anything/helarc/configuration";
import type { FileHelarcProviderProfileStore } from "./HelarcProviderProfileStore.js";
import type { ProviderCredentialStore } from "./ProviderCredentialStore.js";
import { HelarcProviderSelection } from "./HelarcProviderSelection.js";
import { createHelarcProvider } from "./createHelarcProvider.js";
import { restoreHelarcProvider } from "./restoreHelarcProvider.js";
import { retainHelarcProviderBinding } from "../execution-storage/HelarcExecutionAdmission.js";
import {createNativeToolTurnInteraction,type ProviderRequest,type Provider} from "@agent-anything/model-interaction";
import {composeModelInput} from "@agent-anything/model-interaction/input";
import {bindHelarcRunProvider} from "./HelarcRunProviderBinding.js";

function taskRequest(provider:Provider):ProviderRequest {
  const source=(id:string)=>({owner:"fixture",kind:"record",id,revision:"1"});
  const lineage=Object.fromEntries(["instructionBinding","agent","instructions","instructionRelease","instructionResolver","instructionContent","activeContext","contextProjection","projectionManifest","toolSelection","toolExposureContent","toolExposureBasis","toolExposureProof","toolGuidance","controllerControlGuidance","callableDefinitions","protocol","policy"].map(k=>[k,source(k)]));
  Object.assign(lineage,{instructionModel:{providerId:provider.descriptor.id,model:provider.modelContext.target.model},instructionBlocks:[],modelQualification:null,interactionHistory:null});
  const interaction=createNativeToolTurnInteraction([{name:"final_result",description:"End this execution",inputSchema:{type:"object",properties:{},additionalProperties:false}}]);
  const composition=composeModelInput({id:"request",providerId:provider.descriptor.id,model:provider.modelContext.target.model,interaction,
    lineage:lineage as unknown as ProviderRequest["composition"]["lineage"],composedAt:"2026-10-29T00:00:00.000Z",
    sections:[{id:"task",kind:"task",source:source("task"),role:"user",necessity:"mandatory",content:{kind:"text",text:"Inspect the original input."}}]});
  return {requestId:composition.id,purpose:"task",correlation:{controllerRequestId:"request",branchId:"main"},instructions:composition.instructions,messages:composition.messages,interaction,composition,
    modelContext:{requestedOutput:provider.modelContext.requestedOutput,headroom:{unit:"tokens",amount:0,policy:{id:"fixture",revision:"1"}},assessment:null},continuation:null,metadata:{}};
}

function fixture() {
  const p = createHelarcProviderProfile({ id: "local", revision: "1", providerKind: "ollama", displayName: "Local",
    baseUrl: "http://localhost:11435", model: "model", timeoutMs: 1000, credentialStatus: "empty_allowed",
    ollamaRuntime: { contextWindowTokens: 16384 } });
  if (!p.ok) throw Error("profile");
  const stored = { ok: true as const, profile: p.profile, config: { providerKind: "ollama" as const,
    baseUrl: p.profile.baseUrl, model: p.profile.model, apiKey: "", timeoutMs: 1000, ollamaRuntime: p.profile.ollamaRuntime,
    modelSettings: p.profile.modelSettings } };
  const store = { resolveActiveProfile: vi.fn(async () => stored), resolveProfile: vi.fn(async () => stored) };
  const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).endsWith("/api/tags")
    ? { models: [{ name: "model", digest: "sha256:artifact" }] }
    : { thinking: { values: [false, true], default: true } })));
  const selection = new HelarcProviderSelection(store as unknown as FileHelarcProviderProfileStore, {} as ProviderCredentialStore, fetch);
  return { selection, store, stored, fetch };
}

describe("Provider selection admission", () => {
  it("restores local contracts without credentials and reports a missing original credential before transport",async()=>{
    const {selection}=fixture(),resolved=(await selection.resolve())!;
    const original=createHelarcProvider(resolved.config);
    const ref={storage:"windows" as const,ownership:"external" as const,id:"original-account",encoding:"utf16le" as const};
    const credentials={resolveApiKey:vi.fn(async()=>({ok:true as const,apiKey:null,credentialStatus:"missing" as const}))};
    const saved={providerProfile:resolved.profile,providerBinding:retainHelarcProviderBinding(original),providerCredential:{kind:"saved" as const,ref}};
    const restored=bindHelarcRunProvider(JSON.parse(JSON.stringify(saved)),credentials);
    expect(credentials.resolveApiKey).not.toHaveBeenCalled();
    const request=taskRequest(restored),encoded=restored.encodeInput!(request,"buffered");
    restored.verifyEncodedInput!(request,encoded);
    expect(credentials.resolveApiKey).not.toHaveBeenCalled();
    const result=await restored.send(request,{signal:new AbortController().signal,interruption:null},{mode:"buffered",invocationId:"attempt",encodedInput:encoded});
    expect(result).toMatchObject({kind:"failed",failure:{code:"provider_credential_missing",metadata:{transportDispatched:false}}});
    expect(credentials.resolveApiKey).toHaveBeenCalledTimes(1);
    expect(credentials.resolveApiKey).toHaveBeenCalledWith(ref);
    expect(JSON.stringify(saved)).not.toContain("apiKey");
  });
  it("preserves full-input encoding and verification through selection and original-binding recovery",async()=>{
    const {selection}=fixture(),resolved=(await selection.resolve())!;
    const wrapped=createHelarcProvider(resolved.config);
    const request=taskRequest(wrapped),encoded=wrapped.encodeInput!(request,"streaming");
    expect(JSON.parse(encoded.body)).toMatchObject({model:"model",stream:true,messages:[{role:"user",content:"Inspect the original input."}]});
    expect(JSON.parse(encoded.body).tools[0].function.name).toBe("final_result");
    const recovered=restoreHelarcProvider({providerProfile:resolved.profile,providerBinding:retainHelarcProviderBinding(wrapped)},"");
    expect(recovered.encodeInput!(request,"streaming")).toEqual(encoded);
    expect(()=>recovered.verifyEncodedInput!(request,encoded)).not.toThrow();
    expect(()=>recovered.verifyEncodedInput!(request,{...encoded,body:"{}"})).toThrow("encoded_model_input_binding_changed");
  });
  it("retains requested, advertised and loaded context as distinct recoverable facts", async () => {
    const {selection, fetch, stored} = fixture();
    stored.config.ollamaRuntime = {contextWindowTokens: 163840};
    stored.profile.ollamaRuntime = stored.config.ollamaRuntime;
    fetch.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/api/tags")
      ? {models: [{name: "model", digest: "sha256:artifact"}]}
      : String(url).endsWith("/api/version") ? {version: "0.35.1"}
      : String(url).endsWith("/api/ps") ? {models: [{name: "model", digest: "sha256:artifact", context_length: 16384}]}
      : {model_info: {"model.context_length": 131072}, template: "template-v1", thinking: {values: [false, true], default: true}})));
    const resolved = (await selection.resolve())!;
    const original = createHelarcProvider(resolved.config);
    expect(original.modelContext.capacity).toMatchObject({maximum: 131072});
    expect(original.modelContext.accounting?.evidence).toMatchObject({advertisedModelCapacity: 131072, observedLoadedContext: 16384});
    expect(original.modelContext.accounting?.basis).toMatchObject({runtimeVersion: "0.35.1"});
    expect(original.modelContext.accounting?.limitations).toContain("input_preservation_unqualified");
    const saved = {providerProfile: resolved.profile, providerBinding: retainHelarcProviderBinding(original)};
    const restored = restoreHelarcProvider(JSON.parse(JSON.stringify(saved)), "");
    expect(retainHelarcProviderBinding(restored)).toEqual(saved.providerBinding);
    expect(saved.providerBinding.modelContext.accounting).not.toHaveProperty("project");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("restores the exact resolved thinking and artifact without serializing implementation or credentials", async () => {
    const {selection} = fixture();
    const resolved = (await selection.resolve())!;
    const original = createHelarcProvider(resolved.config);
    const saved = {providerProfile: resolved.profile, providerBinding: retainHelarcProviderBinding(original)};
    const serialized = JSON.stringify(saved);
    expect(serialized).not.toContain("apiKey");
    expect(saved.providerBinding.modelContext).not.toHaveProperty("measure");
    const restored = restoreHelarcProvider(JSON.parse(serialized), "rotated-secret");
    expect(retainHelarcProviderBinding(restored)).toEqual(saved.providerBinding);
    expect(restored.descriptor.metadata.generationConfiguration).toMatchObject({think: true, modelArtifact: "sha256:artifact"});
    expect(() => restoreHelarcProvider({...saved, providerBinding: {...saved.providerBinding,
      descriptor: {...saved.providerBinding.descriptor, id: "changed-adapter"}}}, "")).toThrow("original Provider");
  });
  it("discovers from an incomplete connection but requires a model for generation", async () => {
    const { selection, stored, fetch } = fixture();
    stored.config.model = "";
    stored.profile.model = "";
    await expect(selection.validateSavedSelection(stored.config)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await expect(selection.resolve()).rejects.toThrow("Select a model");
    expect(() => createHelarcProvider(stored.config)).toThrow("Select a model");
    expect(fetch).not.toHaveBeenCalled();
    expect(await selection.discover({ profileId: "local", profileRevision: "1", model: "", refresh: false }))
      .toMatchObject({ ok: true, catalog: { models: [{ id: "model" }] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain("/api/tags");
    expect(await selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "default" } }))
      .toMatchObject({ ok: true, config: { model: "model" } });
  });
  it("freezes a known default without replacing the saved preference", async () => {
    const { selection, stored, fetch } = fixture();
    const resolved = await selection.resolve();
    expect(resolved?.config.modelSettings?.thinking).toEqual({ mode: "enabled" });
    expect(resolved?.profile.modelSettings?.thinking).toEqual({ mode: "default" });
    expect(stored.config.modelSettings?.thinking).toEqual({ mode: "default" });
    expect(resolved?.config.modelArtifact).toBe("sha256:artifact");
    await selection.resolve();
    expect(fetch).toHaveBeenCalledTimes(8);
    stored.profile = { ...stored.profile, revision: "2", displayName: "Renamed" };
    const next = await selection.resolve();
    expect(fetch).toHaveBeenCalledTimes(12);
    expect(createHelarcProvider(next!.config).modelContext.accounting?.basis)
      .toEqual(createHelarcProvider(resolved!.config).modelContext.accounting?.basis);
  });
  it("rejects stale selection and responses that arrive after a profile edit", async () => {
    const { selection, store, stored, fetch } = fixture();
    await expect(selection.resolve({ profileId: "local", profileRevision: "old", model: "model", thinking: { mode: "default" } })).rejects.toThrow("changed");
    expect(fetch).not.toHaveBeenCalled();
    store.resolveActiveProfile.mockResolvedValueOnce(stored).mockResolvedValueOnce({ ...stored, profile: { ...stored.profile, revision: "2" } });
    await expect(selection.resolve()).rejects.toThrow("changed during selection");
  });
  it("rejects an active-profile switch during default resolution", async () => {
    const { selection, store, stored } = fixture();
    store.resolveActiveProfile.mockResolvedValueOnce(stored).mockResolvedValueOnce({ ...stored, profile: { ...stored.profile, id: "other" } });
    await expect(selection.resolve()).rejects.toThrow("changed during selection");
  });
  it("does not silently downgrade unsupported controls", async () => {
    const { selection } = fixture();
    await expect(selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "enabled", effort: "max" } })).rejects.toThrow("not supported");
    const disabled = await selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "disabled" } });
    expect(disabled?.config.modelSettings?.thinking).toEqual({ mode: "disabled" });
  });
  it("allows an unresolved provider default offline but rejects explicit controls", async () => {
    const { selection, fetch } = fixture();
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    expect((await selection.resolve())?.config.modelSettings?.thinking).toEqual({ mode: "default" });
    await expect(selection.resolve({ profileId: "local", profileRevision: "1", model: "model", thinking: { mode: "disabled" } })).rejects.toThrow("not known");
  });
  it("rejects contradictory metadata rather than assuming a default", async () => {
    const { selection, fetch } = fixture();
    fetch.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/api/tags") ? { models: [] }
      : { thinking: { values: [false], default: true } })));
    await expect(selection.resolve()).rejects.toThrow("inconsistent");
  });
});
