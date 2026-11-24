import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, Plus, RefreshCw, Save, ShieldOff, Trash2 } from "lucide-react";
import type { HelarcMainSnapshot } from "../../shared/HelarcDesktopApi.js";
import { MODEL_INTERACTION_PROTOCOLS, defaultProviderDraft,providerCapacityTarget,providerCompactionTarget, type CredentialEdit, type ProviderConfiguration,
  type ProviderConfigurationDraft, type ProviderConfigurationListing, type ProviderProtocolId, type SaveProviderConfiguration } from "../../shared/ProviderConfiguration.js";
import type { ProviderExecutionEligibility, ProviderSettingsApi, ProviderSettingsResult } from "../../shared/ProviderSettingsApi.js";
import {InRequestCompactionSettings} from "./InRequestCompactionSettings.js";
import {ProviderModelCatalog} from "./ProviderModelCatalog.js";

function value<T>(result: ProviderSettingsResult<T>): T {
  if (result.ok) return result.value;
  if (result.discoveryRejection) {
    const {httpStatus,providerCode} = result.discoveryRejection;
    const detail = providerCode ? ` (${providerCode})` : "";
    const hint = providerCode === "unsupported_country_region_territory" ? "The provider reported a region restriction."
      : providerCode === "invalid_project" || providerCode === "invalid_organization" ? "Check the organization or project selected for this key."
      : providerCode === "invalid_api_key" ? "The provider rejected the API key. Check the saved credential."
      : httpStatus === 403 || providerCode === "insufficient_permissions" || providerCode === "insufficient_scope" ? "Check access to list models for this key and project."
      : "Check the saved credential and its account or project.";
    throw new Error(`Model list request rejected: HTTP ${httpStatus}${detail}. ${hint}`);
  }
  throw new Error(result.code);
}
function message(error: unknown): string {
  const code = error instanceof Error ? error.message : "provider_settings_failed";
  return ({ provider_native_arrangement_not_installed: "The native execution arrangement is not installed yet.",
    provider_configuration_conflict: "Configuration changed. Reopen it before saving.",
    provider_credential_changed: "The external credential changed; confirm a replacement.",
    provider_credential_target_reserved: "Helarc manages targets starting with Helarc/Provider/. To save a key for this configuration, choose Windows Credential Manager and enter the key. For a read-only reference, use a target managed outside Helarc.",
    provider_credential_selection_invalid: "Check the credential source, target name and encoding. The target name cannot be empty or have leading or trailing spaces.",
    provider_redirect_refused: "Redirect refused. Save the intended endpoint explicitly.",
    provider_authentication_rejected: "The service rejected authentication or access.",
  } as Record<string,string>)[code] ?? code;
}
function targetOf(draft:ProviderConfigurationDraft):string|null {
  try{return providerCompactionTarget(draft);}catch{return null;}
}
function draftOf(saved: ProviderConfiguration): ProviderConfigurationDraft {
  return { protocol:saved.protocol,name:saved.name,baseUrl:saved.baseUrl,model:saved.model,generationLifetimeMs:saved.generationLifetimeMs,native:saved.native,observation:saved.observation,
    ...(saved.capacityDeclaration?{capacityDeclaration:saved.capacityDeclaration}:{}),
    ...(saved.inRequestCompaction?{inRequestCompaction:saved.inRequestCompaction}:{}) };
}
export function ProviderSettingsPanel({ host, snapshot, onSaved }: { host: Window["helarc"] | null; snapshot: HelarcMainSnapshot; onSaved(snapshot: HelarcMainSnapshot): void }) {
  const api = host?.providerConfigurations;
  if (!api) return <section className="settings-panel"><p role="alert">Provider configuration storage is unavailable.</p></section>;
  return <ProtocolSettings api={api} legacyName={snapshot.provider.activeProfile?.displayName ?? null} onActivated={async () => onSaved(await host.getSnapshot())}/>;
}
function ProtocolSettings({ api, legacyName, onActivated }: { api: ProviderSettingsApi; legacyName: string | null; onActivated(): Promise<void> }) {
  const [listing,setListing]=useState<ProviderConfigurationListing>({configurations:[],defaultSelection:null});
  const [protocol,setProtocol]=useState<ProviderProtocolId>("ollama.chat"),[selected,setSelected]=useState<string|null>(null);
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{let current=true;void api.list().then(result=>{if(current)setListing(value(result));}).catch(error=>{if(current)setError(message(error));});return()=>{current=false;};},[api]);
  const profiles=listing.configurations.filter(c=>c.protocol===protocol), saved=profiles.find(c=>c.id===selected)??null;
  const mayLeave=()=>!busy&&(!dirty||window.confirm("Discard unsaved configuration changes?"));
  const refresh=async()=>setListing(value(await api.list()));
  return <section className="settings-panel" aria-label="Provider configuration"><strong>Provider</strong>
    <label><span>Model Interaction Protocol</span><select aria-label="Model Interaction Protocol" value={protocol} disabled={busy} onChange={event=>{
      if(!mayLeave())return;setProtocol(event.target.value as ProviderProtocolId);setSelected(null);setDirty(false);setError(null);
    }}>{Object.entries(MODEL_INTERACTION_PROTOCOLS).map(([id,info])=><option key={id} value={id}>{info.name}</option>)}</select></label>
    <div className="provider-profile-picker"><label><span>Configuration</span><select aria-label="Saved configuration" value={saved?.id??""} disabled={busy||!profiles.length} onChange={event=>{
      if(!mayLeave())return;setSelected(event.target.value||null);setDirty(false);setError(null);
    }}><option value="">{selected&&!saved?"New configuration (unsaved)":profiles.length?"Select a configuration":"No saved configurations"}</option>
      {profiles.map(c=><option key={c.id} value={c.id}>{c.name}{c.isDefault?" (default)":""}</option>)}</select></label>
      <button className="secondary-button" title="New configuration" aria-label="New configuration" disabled={busy} onClick={()=>{if(!mayLeave())return;setSelected(`provider-${crypto.randomUUID()}`);setDirty(false);setError(null);}}><Plus size={16}/></button>
      {saved&&<button className="secondary-button" title="Remove from future selection" aria-label="Remove configuration" disabled={busy} onClick={()=>{
        if(!mayLeave()||!window.confirm(`Remove ${saved.name} from future selection? Existing execution bindings and credentials remain retained.`))return;
        setBusy(true);void api.archive(saved).then(value).then(refresh).then(()=>{setSelected(null);setDirty(false);}).catch(error=>setError(message(error))).finally(()=>setBusy(false));
      }}><Trash2 size={16}/></button>}
    </div>
    <p className="settings-note">Default: {listing.configurations.find(c=>c.isDefault)?.name??(listing.defaultSelection?"An earlier saved revision":legacyName?`${legacyName} (existing execution configuration)`:"None")}</p>
    {error&&<p role="alert" className="settings-error">{error}</p>}
    {selected&&<ConfigurationEditor key={`${selected}:${saved?.revision??"new"}`} api={api} id={selected} saved={saved} protocol={protocol} busy={busy} setBusy={setBusy}
      dirty={()=>setDirty(true)} committed={async c=>{await refresh();setSelected(c.id);setDirty(false);}}
      activated={async()=>{await refresh();await onActivated();}} configurations={listing.configurations}/>}
  </section>;
}
function ConfigurationEditor({api,id,saved,protocol,busy,setBusy,dirty,committed,activated,configurations}:{
  api:ProviderSettingsApi;id:string;saved:ProviderConfiguration|null;protocol:ProviderProtocolId;busy:boolean;setBusy(b:boolean):void;dirty():void;
  committed(c:ProviderConfiguration):Promise<void>;activated():Promise<void>;configurations:readonly ProviderConfiguration[];
}) {
  const [draft,setDraft]=useState<ProviderConfigurationDraft>(()=>saved?draftOf(saved):defaultProviderDraft(protocol));
  // Newly entered credentials stay outside the ordinary configuration draft.
  const [secret,setSecret]=useState(""),[target,setTarget]=useState(""),[encoding,setEncoding]=useState<"utf8"|"utf16le">("utf16le");
  const [mode,setMode]=useState<"keep"|"none"|"safe-storage"|"windows-managed"|"windows-reference">(saved?"keep":"none");
  const [windows,setWindows]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState<string|null>(null);
  const [models,setModels]=useState<readonly string[]|null>(null),[eligible,setEligible]=useState<ProviderExecutionEligibility|null>(null),[replacement,setReplacement]=useState("");
  const [unresolved,setUnresolved]=useState(false), pending=useRef<SaveProviderConfiguration|null>(null),current=useRef(true);
  const targetKey=targetOf(draft);
  const [invalidEdit,setInvalidEdit]=useState<{target:string;invalid:boolean}|null>(null);
  const [preview,setPreview]=useState<{target:string;policy?:NonNullable<ProviderConfigurationDraft["inRequestCompaction"]>;error?:string}|null>(null);
  const needsPolicy=Boolean(draft.model.trim()||draft.inRequestCompaction);
  const policyTarget=needsPolicy?targetKey:null;
  const compactionDefaults=preview?.target===policyTarget?preview?.policy:undefined;
  const policy=draft.inRequestCompaction??compactionDefaults;
  // Only the target and native choices cross this read-only boundary, never entered credentials.
  const previewDraft=React.useMemo(()=>({...defaultProviderDraft(protocol),model:draft.model,baseUrl:draft.baseUrl,native:draft.native}),
    [protocol,draft.model,draft.baseUrl,draft.native]);
  useEffect(()=>{
    if(!policyTarget)return;
    let active=true;
    void api.previewPolicy({draft:previewDraft}).then(value).then(policy=>{
      if(active)setPreview({target:policyTarget,policy});
    }).catch(cause=>{if(active)setPreview({target:policyTarget,error:message(cause)});});
    return()=>{active=false;};
  },[api,policyTarget,previewDraft]);
  const invalidCompaction=(needsPolicy&&(!targetKey||!compactionDefaults))||Boolean(invalidEdit&&invalidEdit.target===targetKey&&invalidEdit.invalid);
  useEffect(()=>{current.current=true;
    void api.credentialSettings(saved?.connectionBindingId??null).then(result=>{if(!current.current)return;const settings=value(result);setWindows(settings.windowsAvailable);
      if(!saved&&protocol!=="ollama.chat")setMode(settings.windowsAvailable?"windows-managed":"safe-storage");
      if(settings.selection.source==="windows-reference"){setTarget(settings.selection.target);setEncoding(settings.selection.encoding);}setReady(true);
    }).catch(error=>{if(current.current)setError(message(error));});
    if(saved)void api.eligibility(saved).then(result=>{if(current.current)setEligible(value(result));}).catch(error=>{if(current.current)setError(message(error));});
    return()=>{current.current=false;pending.current=null;};
  },[api,saved,protocol]);
  const update=(patch:Partial<ProviderConfigurationDraft>)=>{setDraft(previous=>{
    let next={...previous,...patch};
    if(next.capacityDeclaration){
      let applicable=false;try{applicable=next.capacityDeclaration.target===providerCapacityTarget(next);}catch{/* An unfinished target cannot carry capacity evidence. */}
      if(!applicable){const {capacityDeclaration:_capacity,...without}=next;next=without;}
    }
    if (targetOf(next)!==targetOf(previous)) {
      const {inRequestCompaction:_old,...rest}=next;
      next={...rest,native:rest.native.protocol==="openai.responses"?{...rest.native,allowInRequestCompaction:false}:rest.native};
    }
    return next;
  });dirty();};
  async function work(run:()=>Promise<void>){setBusy(true);setError(null);try{await run();}catch(error){if(current.current)setError(message(error));}finally{setBusy(false);}}
  async function save(){
    const credential:CredentialEdit=mode==="keep"||mode==="none"?{kind:mode}:mode==="windows-reference"?{kind:"reference",target,encoding}:{kind:"set",storage:mode,secret};
    const request=pending.current??{updateId:crypto.randomUUID(),configurationId:id,expectedRevision:saved?.revision??null,draft:policy?{...draft,inRequestCompaction:policy}:draft,credential};pending.current=request;setUnresolved(true);
    const observed=value(await api.receipt(request.updateId));
    let receipt;
    try { receipt=observed?.disposition==="committed"?observed:value(await api.save(request)); }
    catch(error) {
      const check=await api.receipt(request.updateId);
      if(check.ok&&(check.value===null||check.value.disposition==="abandoned")){pending.current=null;setUnresolved(false);}
      throw error;
    }
    if(receipt.disposition==="abandoned"){pending.current=null;setUnresolved(false);throw new Error("Save abandoned. Reopen the current configuration.");}
    if(!receipt.configuration)throw new Error("Save acknowledgement pending. Retry the same save.");
    pending.current=null;setSecret("");setUnresolved(false);await committed(receipt.configuration);
  }
  const native=draft.native,disabled=busy||unresolved;
  const sameCatalogSource=saved && mode==="keep" && draft.baseUrl===saved.baseUrl &&
    (native.protocol!=="openai.responses" || (saved.native.protocol==="openai.responses" &&
      native.organization===saved.native.organization && native.project===saved.native.project));
  const declareCapacity=(patch:Partial<NonNullable<ProviderConfigurationDraft["capacityDeclaration"]>>)=>{
    try{update({capacityDeclaration:{target:providerCapacityTarget(draft),sharedTokens:0,basis:"",validUntil:null,...draft.capacityDeclaration,...patch}});}
    catch(cause){setError(message(cause));}
  };
  const toggle=(label:string,key:"background"|"stream"|"store"|"allowTemporaryRetention"|"allowConnectionMemory"|"allowInRequestCompaction")=>native.protocol==="openai.responses"&&
    <label key={key}><input type="checkbox" checked={native[key]} onChange={event=>update({native:{...native,[key]:event.target.checked}})}/><span>{label}</span></label>;
  return <><fieldset disabled={disabled} className="provider-configuration-fields">
    <label><span>Name</span><input aria-label="Configuration name" value={draft.name} onChange={e=>update({name:e.target.value})}/></label>
    <label><span>API base URL</span><input aria-label="API base URL" value={draft.baseUrl} onChange={e=>update({baseUrl:e.target.value})}/></label>
    <label><span>Model</span><input aria-label="Model" value={draft.model} onChange={e=>update({model:e.target.value})}/></label>
    <button type="button" className="secondary-button" disabled={!sameCatalogSource||!saved||JSON.stringify(draft)!==JSON.stringify(draftOf(saved))} onClick={()=>void work(async()=>{if(saved){const result=value(await api.discover(saved));if(current.current)setModels(result.models);}})}><RefreshCw size={14}/>Query models</button>
    {sameCatalogSource && models && <ProviderModelCatalog models={models} model={draft.model} onSelect={model=>update({model})}/>}
    <label><span>Authentication</span><select aria-label="Credential source" value={mode} disabled={!ready} onChange={e=>{setMode(e.target.value as typeof mode);setSecret("");dirty();}}>
      {saved&&<option value="keep">Keep current credential</option>}<option value="none">No authentication</option><option value="windows-managed" disabled={!windows}>Windows Credential Manager</option><option value="safe-storage">Encrypted local storage</option><option value="windows-reference" disabled={!windows}>Existing Windows credential (read-only)</option>
    </select></label>
    {(mode==="windows-managed"||mode==="safe-storage")&&<label><span>New API key</span><input aria-label="New API key" type="password" autoComplete="new-password" value={secret} onChange={e=>{setSecret(e.target.value);dirty();}}/></label>}
    {mode==="windows-reference"&&<><label><span>Credential target</span><input value={target} onChange={e=>{setTarget(e.target.value);dirty();}}/></label><label><span>Encoding</span><select value={encoding} onChange={e=>{setEncoding(e.target.value as typeof encoding);dirty();}}><option value="utf16le">UTF-16 LE</option><option value="utf8">UTF-8</option></select></label></>}
    {native.protocol==="ollama.chat"&&<><label><span>Context window (declared tokens)</span><input type="number" min="1" value={native.contextWindowTokens} onChange={e=>update({native:{...native,contextWindowTokens:Number(e.target.value)}})}/></label>
      <label><span>Thinking</span><select value={native.think} onChange={e=>update({native:{...native,think:e.target.value as typeof native.think}})}>{["default","disabled","enabled"].map(c=><option key={c}>{c}</option>)}</select></label></>}
    {native.protocol==="deepseek.chat-completions"&&<label><span>Thinking</span><select value={native.thinking} onChange={e=>update({native:{...native,thinking:e.target.value as typeof native.thinking}})}>{["default","disabled","enabled"].map(c=><option key={c}>{c}</option>)}</select></label>}
    {native.protocol!=="ollama.chat"&&<details><summary>Declared model capacity</summary>
      <label><span>Shared context window (tokens)</span><input type="number" min="1" placeholder="Unknown" value={draft.capacityDeclaration?.sharedTokens||""} onChange={e=>{
        if(!e.target.value){setDraft(previous=>{const {capacityDeclaration:_capacity,...rest}=previous;return rest;});dirty();}
        else declareCapacity({sharedTokens:Number(e.target.value)});
      }}/></label>
      {draft.capacityDeclaration&&<><label><span>Capacity source</span><input value={draft.capacityDeclaration.basis} onChange={e=>declareCapacity({basis:e.target.value})}/></label>
        <label><span>Valid until (UTC, optional)</span><input value={draft.capacityDeclaration.validUntil??""} placeholder="2026-12-31T00:00:00.000Z" onChange={e=>declareCapacity({validUntil:e.target.value||null})}/></label></>}
    </details>}
    {native.protocol==="openai.responses"&&<details><summary>Responses options</summary>
      <label><span>Organization</span><input value={native.organization??""} onChange={e=>update({native:{...native,organization:e.target.value||null}})}/></label>
      <label><span>Project</span><input value={native.project??""} onChange={e=>update({native:{...native,project:e.target.value||null}})}/></label>
      <label><span>Transport</span><select value={native.transport} onChange={e=>update({native:{...native,transport:e.target.value as typeof native.transport}})}><option value="http">HTTP</option><option value="websocket">WebSocket</option></select></label>
      <label><span>Continuity</span><select value={native.continuity} onChange={e=>update({native:{...native,continuity:e.target.value as typeof native.continuity}})}><option value="replay">Explicit replay</option><option value="stored-response">Stored response</option><option value="connection-memory">Connection memory</option></select></label>
      {toggle("Stream","stream")}{toggle("Background response","background")}{toggle("Store responses","store")}{toggle("Allow temporary background retention","allowTemporaryRetention")}{toggle("Allow connection-local memory","allowConnectionMemory")}{toggle("Allow in-request compaction","allowInRequestCompaction")}
      <label><span>Reasoning effort (declared)</span><input value={native.reasoningEffort??""} placeholder="Provider default" onChange={e=>update({native:{...native,reasoningEffort:e.target.value||null}})}/></label>
    </details>}
    {native.protocol==="openai.responses"&&policy&&compactionDefaults&&<InRequestCompactionSettings key={policy.target}
      policy={policy} defaults={compactionDefaults}
      validate={async candidate=>value(await api.previewPolicy({draft:{...previewDraft,inRequestCompaction:candidate}}))}
      onChange={policy=>update({inRequestCompaction:policy})} onInvalid={invalid=>setInvalidEdit({target:policy.target,invalid})} onDirty={dirty}/>}
    <details><summary>Observation and lifetime policy</summary><label><span>Generation lifetime (ms)</span><input type="number" min="1" value={draft.generationLifetimeMs} onChange={e=>update({generationLifetimeMs:Number(e.target.value)})}/></label>
      {([["connectMs","Connect (ms)"],["readMs","Retrieve / cancel (ms)"],["silenceMs","Stream silence (ms)"],["pollMinimumMs","Initial poll (ms)"],["pollMaximumMs","Maximum poll (ms)"],["failureRetries","Observation retries"],["failureEpisodeMs","Failure episode (ms)"]] as const).map(([key,label])=><label key={key}><span>{label}</span><input type="number" min={key==="failureRetries"?0:1} value={draft.observation[key]} onChange={e=>update({observation:{...draft.observation,[key]:Number(e.target.value)}})}/></label>)}
    </details>
  </fieldset>
  <p className="settings-note">Capabilities: unknown · Rates: unknown · Cache: provider default</p>
  {needsPolicy&&!targetKey&&<p role="alert" className="settings-error">Check the API base URL for this protocol.</p>}
  {preview?.target===policyTarget&&preview?.error&&<p role="alert" className="settings-error">{preview.error}</p>}
  {saved&&<p className="settings-note">Credential: {saved.credentialAvailability} · Target: {saved.targetAttribution==="provider_endpoint"?"Provider endpoint":"User-declared route"}</p>}
  {error&&<p role="alert" className="settings-error">{error}</p>}
  <div className="provider-configuration-actions"><button type="button" className="primary-button" disabled={busy||!ready||invalidCompaction} onClick={()=>void work(save)}><Save size={14}/>{unresolved?"Resolve / retry save":"Save configuration"}</button>
    {saved&&<button type="button" className="secondary-button" disabled={disabled||!eligible?.available||!saved.model} title={eligible?.reason?message(new Error(eligible.reason)):"Use saved revision as default"} onClick={()=>void work(async()=>{value(await api.activate(saved));await activated();})}><Check size={14}/>Use as default</button>}
  </div>
  {saved&&eligible&&!eligible.available&&<p className="settings-note">Execution unavailable: {message(new Error(eligible.reason??"provider_native_arrangement_not_installed"))}</p>}
  {saved&&<details><summary>Accepted connection access</summary>
    {(saved.credentialBackend==="safe-storage"||saved.credentialBackend==="windows-managed")&&<button className="secondary-button" disabled={disabled} onClick={()=>void work(async()=>{
      const d=value(await api.dependencies(saved.connectionBindingId));
      if(!window.confirm(`Destroy this managed local credential? ${d.credentialOutstanding} retained dependencies across ${d.credentialBindings} connection bindings may lose access, including other references to this credential. This does NOT revoke the key at the provider.`))return;
      value(await api.destroyCredential({bindingId:saved.connectionBindingId,revision:d.bindingRevision,confirmed:true}));await committed(saved);
    })}><Trash2 size={14}/>Delete managed credential</button>}
    <button className="secondary-button" disabled={disabled} onClick={()=>void work(async()=>{const d=value(await api.dependencies(saved.connectionBindingId));
      if(!window.confirm(`Revoke local access? ${d.bindingOutstanding} dependencies may require repair. Remote work already sent is not cancelled.`))return;
      value(await api.revoke({bindingId:saved.connectionBindingId,revision:d.bindingRevision,confirmed:true}));await committed(saved);
    })}><ShieldOff size={14}/>Revoke local access</button>
    <label><span>Replacement connection</span><select value={replacement} disabled={disabled} onChange={e=>setReplacement(e.target.value)}><option value="">Select replacement</option>{configurations.filter(c=>c.protocol===saved.protocol&&c.connectionBindingId!==saved.connectionBindingId).map(c=><option key={c.id} value={c.connectionBindingId}>{c.name}</option>)}</select></label>
    <button className="secondary-button" disabled={disabled||!replacement} onClick={()=>void work(async()=>{const d=value(await api.dependencies(saved.connectionBindingId));
      if(!window.confirm("Confirm the replacement serves the same original account/project. Original endpoint, model, progress and native resource identities will not change."))return;
      value(await api.repair({bindingId:saved.connectionBindingId,revision:d.bindingRevision,replacementBindingId:replacement,confirmedSameScope:true}));await committed(saved);
    })}><KeyRound size={14}/>Repair original connection</button>
  </details>}
  </>;
}
