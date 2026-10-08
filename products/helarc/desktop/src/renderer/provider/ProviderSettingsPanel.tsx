import * as React from "react";
import { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE, HELARC_DEFAULT_PROVIDER_SETTINGS,
  type HelarcMainSnapshot, type HelarcProviderProfileSnapshot, type HelarcSaveProviderConfigInput } from "../../shared/HelarcDesktopApi.js";
import { QualificationSettingsPanel } from "../QualificationSettingsPanel.js";
import { ModelThinkingFields } from "./ModelThinkingFields.js";
import { useModelDiscovery } from "./useModelDiscovery.js";
import type { HelarcCredentialSelection } from "../../shared/HelarcProviderCredentials.js";

type Draft = Omit<HelarcSaveProviderConfigInput, "commandId" | "apiKeyUpdate"> & { modelSettings: NonNullable<HelarcSaveProviderConfigInput["modelSettings"]> };
type Service = Draft["modelSettings"]["service"];
type ConfigurationSelection = { kind: "saved"; id: string } | { kind: "new"; id: string } | null;
const defaultProviderNames: Record<Draft["modelSettings"]["service"], string> = {
  ollama: HELARC_DEFAULT_PROVIDER_SETTINGS.displayName,
  deepseek: "DeepSeek Provider",
  generic: "OpenAI-compatible Provider",
};
const commandId = () => `provider-${crypto.randomUUID()}`;
export function ProviderSettingsPanel({ snapshot, onSaved }: { snapshot: HelarcMainSnapshot; onSaved: (snapshot: HelarcMainSnapshot) => void }) {
  const initial = snapshot.provider.profiles.find(profile => profile.id === snapshot.provider.activeProfile?.id && profile.revision) ?? null;
  const [service, setService] = useState<Service>(() => serviceFor(initial));
  const [selection, setSelection] = useState<ConfigurationSelection>(() => initial ? { kind: "saved", id: initial.id } : null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profiles = snapshot.provider.profiles.filter(profile => !!profile.revision && serviceFor(profile) === service);
  const provider = selection?.kind === "saved" ? profiles.find(profile => profile.id === selection.id) ?? null : null;
  const editorKey = selection?.kind === "new" ? selection.id : provider ? `${provider.id}:${provider.revision}` : null;
  const discardAllowed = () => !dirty || window.confirm("Discard unsaved configuration changes?");
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Provider settings could not be updated."); }
    finally { setBusy(false); }
  };
  return <>
    <section className="settings-panel" aria-label="Provider configuration">
      <strong>Provider</strong>
      <label><span>Service</span><select aria-label="Service" value={service} disabled={busy} onChange={event => {
        if (!discardAllowed()) return;
        setService(event.target.value as Service); setSelection(null); setDirty(false); setError(null);
      }}><option value="ollama">Ollama</option><option value="deepseek">DeepSeek</option><option value="generic">OpenAI-compatible</option></select></label>
      <div className="provider-profile-picker">
        <label><span>Configuration</span><select aria-label="Saved configuration" value={provider?.id ?? ""} disabled={busy || profiles.length === 0}
          onChange={event => {
            const id = event.target.value;
            if (!id || !discardAllowed()) return;
            void perform(async () => {
              const receipt = await window.helarc.selectProvider({ commandId: commandId(), profileId: id });
              if (receipt.status !== "handled") throw new Error("Configuration could not be selected.");
              onSaved(receipt.result);
              if (receipt.result.provider.activeProfile?.id !== id) throw new Error(receipt.result.error?.message ?? "Configuration could not be selected.");
              setSelection({ kind: "saved", id }); setDirty(false);
            });
          }}>
          <option value="" disabled>{selection?.kind === "new" ? "New configuration (unsaved)" : profiles.length ? "Select a configuration" : "No saved configurations"}</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
        </select></label>
        <button type="button" className="secondary-button" aria-label="New configuration" title="New configuration" disabled={busy} onClick={() => {
          if (!discardAllowed()) return;
          setSelection({ kind: "new", id: commandId() }); setDirty(false); setError(null);
        }}><Plus size={16}/></button>
        {provider && <button type="button" className="secondary-button" aria-label="Delete configuration" title="Delete configuration" disabled={busy} onClick={() => {
          if (!window.confirm(`Delete ${provider.displayName}?${dirty ? " Unsaved changes will also be discarded." : ""}`)) return;
          void perform(async () => {
            const receipt = await window.helarc.deleteProvider({ commandId: commandId(), profileId: provider.id, expectedRevision: provider.revision! });
            if (receipt.status !== "handled") throw new Error("Configuration could not be deleted.");
            onSaved(receipt.result);
            if (receipt.result.provider.profiles.some(profile => profile.id === provider.id)) throw new Error(receipt.result.error?.message ?? "Configuration could not be deleted.");
            setSelection(null); setDirty(false); setError(receipt.result.error?.message ?? null);
          });
        }}><Trash2 size={16}/></button>}
      </div>
      {error && <p role="alert" className="settings-error">{error}</p>}
      {editorKey && <ProviderConfigurationForm key={editorKey} provider={provider} service={service} busy={busy}
        onDirty={() => setDirty(true)}
        configurationError={provider && provider.id === snapshot.provider.activeProfile?.id ? snapshot.provider.error?.message ?? null : null}
        onSave={input => perform(async () => {
          const receipt = await window.helarc.saveProviderConfig(input);
          if (receipt.status !== "handled") throw new Error("Configuration could not be saved.");
          onSaved(receipt.result);
          const saved = receipt.result.provider.activeProfile;
          if (!saved?.revision || serviceFor(saved) !== service ||
              (provider ? saved.id !== provider.id || saved.revision === provider.revision : snapshot.provider.profiles.some(profile => profile.id === saved.id))) {
            throw new Error(receipt.result.error?.message ?? "Configuration could not be saved.");
          }
          setSelection({ kind: "saved", id: saved.id }); setDirty(false); setError(receipt.result.error?.message ?? null);
        })} />}
    </section>
    {provider && provider.id === snapshot.provider.activeProfile?.id && editorKey && <QualificationSettingsPanel key={editorKey}
      api={typeof window === "undefined" ? null : window.helarc} dirty={dirty || busy}/>}
  </>;
}

function ProviderConfigurationForm({ provider, service, busy, configurationError, onDirty, onSave }: {
  provider: HelarcProviderProfileSnapshot | null;
  service: Service;
  busy: boolean;
  configurationError: string | null;
  onDirty(): void;
  onSave(input: HelarcSaveProviderConfigInput): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFor(provider, service));
  const [error, setError] = useState<string | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(true), [windowsAvailable, setWindowsAvailable] = useState(false);
  const [storedCredential, setStoredCredential] = useState<HelarcCredentialSelection>({ source: "safe-storage" });
  const [clearKey, setClearKey] = useState(false);
  useEffect(() => {
    let current = true;
    setCredentialLoading(true); setClearKey(false);
    void window.helarc.getProviderCredentialSettings({ profileId: provider?.revision ? provider.id : null,
      profileRevision: provider?.revision ?? null }).then(settings => {
        if (!current) return;
        setStoredCredential(settings.selection); setWindowsAvailable(settings.windowsAvailable);
        setDraft(draft => ({ ...draft, credential: settings.selection })); setCredentialLoading(false);
      }, () => { if (current) setError("Credential settings could not be read. Reopen Settings to retry."); });
    return () => { current = false; };
  }, [provider?.id, provider?.revision]);
  const locked = busy || credentialLoading;
  const unchangedConnection = !!provider && sameUrl(draft.baseUrl, provider.baseUrl) && draft.providerKind === provider.providerKind &&
    draft.modelSettings.service === (provider.modelSettings?.service ?? (provider.providerKind === "ollama" ? "ollama" : "generic"));
  const discovery = useModelDiscovery(provider?.id, provider?.revision, draft.model, unchangedConnection);
  const update = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); onDirty(); };
  const keepCredential = !clearKey && unchangedConnection && !!provider?.revision && provider.credentialStatus === "present" && storedCredential.source !== "windows-reference";
  const credential = draft.credential ?? { source: "safe-storage" as const };
  return <form className="provider-configuration-form" aria-label="Provider settings" onSubmit={event => {
      event.preventDefault();
      if (locked) return;
      void onSave({ ...draft, commandId: commandId(),
          apiKeyUpdate: credential.source === "windows-reference" ? "reference" : draft.apiKey.trim() ? "set" : keepCredential ? "keep" : "clear" });
    }}>
      <label><span>Name</span><input aria-label="Name" required value={draft.displayName} disabled={locked} onChange={event => update({ displayName: event.target.value })}/></label>
      <label><span>Base URL</span><input aria-label="Base URL" required value={draft.baseUrl} disabled={locked} onChange={event => update({ baseUrl: event.target.value, apiKey: "", credential: { source: "safe-storage" } })}/></label>
      <label><span>Model</span><input aria-label="Model" list="provider-models" value={draft.model} disabled={locked} onChange={event => update({ model: event.target.value, modelSettings: { ...draft.modelSettings, thinking: { mode: "default" } } })}/>
        <datalist id="provider-models">{discovery.result?.ok && discovery.result.catalog.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></label>
      <div className="provider-discovery-status"><button type="button" className="secondary-button" title="Refresh models" aria-label="Refresh models" disabled={locked || discovery.loading || !unchangedConnection} onClick={discovery.refresh}><RefreshCw size={16}/></button>
        <small>{!unchangedConnection ? "Save the connection to query models." : discovery.loading ? "Reading model metadata..." : discovery.result && !discovery.result.ok ? discovery.result.error : discovery.result?.ok ? `${discovery.result.catalog.models.length} models available` : ""}</small></div>
      <ModelThinkingFields value={draft.modelSettings.thinking} capability={discovery.capability} disabled={locked || !draft.model.trim()}
        onChange={thinking => update({ modelSettings: { ...draft.modelSettings, thinking } })}/>
      <label><span>Timeout (ms)</span><input aria-label="Timeout" type="number" min="1000" step="1000" required disabled={locked} value={draft.timeoutMs}
        onChange={event => update({ timeoutMs: Number(event.target.value) })}/></label>
      {draft.ollamaRuntime && <label><span>Context window</span><input aria-label="Context window" type="number" min="1" required value={draft.ollamaRuntime.contextWindowTokens} disabled={locked}
        onChange={event => update({ ollamaRuntime: { ...draft.ollamaRuntime!, contextWindowTokens: Number(event.target.value) } })}/></label>}
      <label><span>Maximum output tokens</span><input aria-label="Maximum output" type="number" min="1" required disabled={locked} value={draft.ollamaRuntime?.maximumOutputTokens ?? draft.modelSettings.maximumOutputTokens}
        onChange={event => update(draft.ollamaRuntime ? { ollamaRuntime: { ...draft.ollamaRuntime, maximumOutputTokens: Number(event.target.value) } }
          : { modelSettings: { ...draft.modelSettings, maximumOutputTokens: Number(event.target.value) } })}/></label>
      <label><span>Model qualification</span><select aria-label="Model qualification" value={draft.qualificationPolicy} disabled={locked} onChange={event => update({ qualificationPolicy: event.target.value as Draft["qualificationPolicy"] })}>
        <option value="require_qualified">Require qualified</option><option value="allow_experimental">Allow experimental</option></select></label>
      <label><span>Credential storage</span><select aria-label="Credential storage" disabled={busy || credentialLoading} value={credential.source}
        onChange={event => { const source = event.target.value as HelarcCredentialSelection["source"];
          update({ apiKey: "", credential: source === "windows-reference" ? { source, target: "", encoding: "utf16le" } : { source } }); }}>
        <option value="safe-storage">Encrypted local storage (Electron)</option>
        <option value="windows-managed" disabled={!windowsAvailable}>Windows Credential Manager</option>
        <option value="windows-reference" disabled={!windowsAvailable}>Existing Windows credential</option>
      </select></label>
      {credential.source === "windows-reference" ? <>
        <label><span>Credential target</span><input aria-label="Credential target" required maxLength={2048} disabled={busy || credentialLoading} value={credential.target}
          onChange={event => update({ credential: { ...credential, target: event.target.value } })}/></label>
        <label><span>Credential encoding</span><select aria-label="Credential encoding" disabled={busy || credentialLoading} value={credential.encoding}
          onChange={event => update({ credential: { ...credential, encoding: event.target.value as "utf16le" | "utf8" } })}>
          <option value="utf16le">UTF-16LE</option><option value="utf8">UTF-8</option>
        </select></label>
      </> : <label><span>API key</span><input aria-label="API key" type="password" autoComplete="off" disabled={busy || credentialLoading} value={draft.apiKey}
        placeholder={keepCredential ? "Stored key is present" : "Optional for local endpoints"} onChange={event => update({ apiKey: event.target.value })}/></label>}
      <div className="settings-status"><span>Credential</span><strong>{credentialLoading ? "Loading" : credential.source === "windows-reference" ? "External reference" : draft.apiKey || keepCredential ? "present" : "empty"}</strong>
        {provider?.credentialStatus === "present" && !clearKey && <button type="button" className="secondary-button" aria-label="Remove credential from configuration" title="Remove credential from configuration" disabled={busy || credentialLoading}
          onClick={() => { setClearKey(true); update({ apiKey: "", credential: { source: "safe-storage" } }); }}><Trash2 size={14}/></button>}
      </div>
      {(error || configurationError) && <p role="alert" className="settings-error">{error ?? configurationError}</p>}
      <button className="primary-button compact" type="submit" disabled={busy || credentialLoading}>Save</button>
    </form>;
}
function serviceFor(profile: HelarcProviderProfileSnapshot | null): Service {
  return profile?.modelSettings?.service ?? (profile?.providerKind === "openai-compatible" ? "generic" : "ollama");
}
function draftFor(profile: HelarcProviderProfileSnapshot | null, service: Service): Draft {
  return { profileId: profile?.revision ? profile.id : null, expectedRevision: profile?.revision ?? null,
    providerKind: profile?.providerKind ?? (service === "ollama" ? "ollama" : "openai-compatible"), displayName: profile?.displayName ?? defaultProviderNames[service],
    baseUrl: profile?.baseUrl ?? (service === "ollama" ? HELARC_DEFAULT_PROVIDER_SETTINGS.baseUrl : service === "deepseek" ? "https://api.deepseek.com" : ""), model: profile?.model ?? "",
    timeoutMs: profile?.timeoutMs ?? HELARC_DEFAULT_PROVIDER_SETTINGS.timeoutMs, apiKey: "",
    ollamaRuntime: profile ? profile.ollamaRuntime : service === "ollama" ? { ...HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE } : null,
    qualificationPolicy: profile?.qualificationPolicy ?? HELARC_DEFAULT_PROVIDER_SETTINGS.qualificationPolicy,
    modelSettings: profile?.modelSettings ?? { service, thinking: { mode: "default" }, maximumOutputTokens: 4096 } };
}
function sameUrl(a: string, b: string): boolean { try { return new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, ""); } catch { return false; } }
