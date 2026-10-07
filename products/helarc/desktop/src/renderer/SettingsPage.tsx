import { X } from "lucide-react";
import * as React from "react";
import { InstructionSettingsPanel } from "./InstructionSettingsPanel.js";
import { InspectionSettingsPanel } from "./InspectionSettingsPanel.js";
import { QualificationSettingsPanel } from "./QualificationSettingsPanel.js";
import { useEffect, useState, type FormEvent } from "react";
import type {
  HelarcMainSnapshot,
  HelarcModelUsePolicy,
  HelarcProviderKind,
  HelarcProviderProfileSnapshot,
} from "../shared/HelarcDesktopApi.js";
import {
  HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE,
  HELARC_DEFAULT_PROVIDER_SETTINGS,
} from "../shared/HelarcDesktopApi.js";

export function SettingsPage({
  snapshot,
  onSaved,
  onClose,
}: {
  snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot) => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <h1 id="settings-title">Settings</h1>
        <button
          className="secondary-button settings-close"
          type="button"
          onClick={onClose}
          title="Close settings"
          aria-label="Close settings"
          autoFocus
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <main className="settings-page-body" aria-labelledby="settings-title">
        <SettingsPanel snapshot={snapshot} onSaved={onSaved} />
      </main>
    </div>
  );
}

export function SettingsPanel({
  snapshot,
  onSaved,
}: {
  snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot) => void;
}) {
  const [tab, setTab] = useState<"provider" | "instructions" | "inspection">(
    "provider",
  );
  const [instructionsOpened, setInstructionsOpened] = useState(false);
  return (
    <div className="settings-content">
      <div className="settings-tabs" role="tablist" aria-label="Settings">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "provider"}
          onClick={() => setTab("provider")}
        >
          Provider
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "instructions"}
          onClick={() => {
            setInstructionsOpened(true);
            setTab("instructions");
          }}
        >
          Instructions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "inspection"}
          onClick={() => setTab("inspection")}
        >
          Inspection
        </button>
      </div>
      <div hidden={tab !== "provider"}>
        <ProviderSettingsPanel snapshot={snapshot} onSaved={onSaved} />
      </div>
      <div hidden={tab !== "instructions"}>
        {instructionsOpened && (
          <InstructionSettingsPanel api={getHelarcApi()} />
        )}
      </div>
      {tab === "inspection" && <InspectionSettingsPanel api={getHelarcApi()} />}
    </div>
  );
}

function ProviderSettingsPanel({
  snapshot,
  onSaved,
}: {
  snapshot: HelarcMainSnapshot;
  onSaved: (snapshot: HelarcMainSnapshot) => void;
}) {
  const provider = snapshot.provider.configured
    ? snapshot.provider.activeProfile
    : null;
  const [isSaving, setIsSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selectedProviderKind, setSelectedProviderKind] =
    useState<HelarcProviderKind>(
      provider?.providerKind ?? HELARC_DEFAULT_PROVIDER_SETTINGS.providerKind,
    );
  const [drafts, setDrafts] = useState(() => ({
    ollama: createProviderDraft("ollama", provider),
    "openai-compatible": createProviderDraft("openai-compatible", provider),
  }));
  const draft = drafts[selectedProviderKind];
  const canKeepCredential = provider?.credentialStatus === "present" &&
    provider.providerKind === selectedProviderKind &&
    sameApiBase(provider.baseUrl, draft.baseUrl);
  const credentialStatus = draft.apiKey.trim() || canKeepCredential
    ? "present"
    : provider?.providerKind === selectedProviderKind && sameApiBase(provider.baseUrl, draft.baseUrl)
      ? provider.credentialStatus : "missing";
  const formKey = provider
    ? `${provider.id}:${provider.providerKind}:${provider.displayName}:${provider.baseUrl}:${provider.model}:${provider.timeoutMs}:${provider.ollamaRuntime?.contextWindowTokens ?? "managed"}:${provider.ollamaRuntime?.maximumOutputTokens ?? "managed"}:${provider.credentialStatus}:${provider.qualificationPolicy}`
    : "unconfigured-provider";

  useEffect(() => {
    if (!provider) return;
    setSelectedProviderKind(provider.providerKind);
    setDrafts(current => ({
      ...current,
      [provider.providerKind]: createProviderDraft(provider.providerKind, provider),
    }));
    setDirty(false);
  }, [formKey]);

  function updateDraft<K extends keyof ProviderSettingsDraft>(key: K, value: ProviderSettingsDraft[K]) {
    setDrafts(current => ({
      ...current,
      [selectedProviderKind]: {
        ...current[selectedProviderKind],
        ...(key === "baseUrl" ? { apiKey: "" } : {}),
        [key]: value,
      },
    }));
    setDirty(true);
  }

  async function saveProviderConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = getHelarcApi();
    if (!api) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const submittedProviderKind = readProviderKind(
      formData,
      provider?.providerKind ?? HELARC_DEFAULT_PROVIDER_SETTINGS.providerKind,
    );
    const submittedDisplayName = readFormString(formData, "displayName");
    const submittedBaseUrl = readFormString(formData, "baseUrl");
    const submittedModel = readFormString(formData, "model");
    const submittedTimeoutMs = readFormNumber(
      formData,
      "timeoutMs",
      provider?.timeoutMs ?? HELARC_DEFAULT_PROVIDER_SETTINGS.timeoutMs,
    );
    const submittedOllamaRuntime =
      submittedProviderKind === "ollama"
        ? {
            contextWindowTokens: readFormNumber(
              formData,
              "ollamaContextWindowTokens",
              provider?.ollamaRuntime?.contextWindowTokens ??
                HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.contextWindowTokens,
            ),
            maximumOutputTokens: readFormNumber(
              formData,
              "ollamaMaximumOutputTokens",
              provider?.ollamaRuntime?.maximumOutputTokens ??
                HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE.maximumOutputTokens,
            ),
          }
        : null;
    const submittedQualificationPolicy = readQualificationPolicy(
      formData,
      provider?.qualificationPolicy ??
        HELARC_DEFAULT_PROVIDER_SETTINGS.qualificationPolicy,
    );
    const submittedApiKey = readFormString(formData, "apiKey");

    setIsSaving(true);
    try {
      const receipt = await api.saveProviderConfig({
        commandId: createCommandId("provider.save"),
        providerKind: submittedProviderKind,
        displayName: submittedDisplayName,
        baseUrl: submittedBaseUrl,
        model: submittedModel,
        timeoutMs: submittedTimeoutMs,
        ollamaRuntime: submittedOllamaRuntime,
        qualificationPolicy: submittedQualificationPolicy,
        apiKeyUpdate:
          submittedApiKey.trim().length > 0
            ? "set"
            : canKeepCredential
              ? "keep"
              : "clear",
        apiKey: submittedApiKey,
      });
      if (receipt.status === "handled") {
        onSaved(receipt.result);
        if (receipt.result.provider.configured) {
          const saved = receipt.result.provider.activeProfile;
          setDrafts(current => ({ ...current, [saved.providerKind]: createProviderDraft(saved.providerKind, saved) }));
          setDirty(false);
        }
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
    <form
      className="settings-panel"
      aria-label="Provider settings"
      onSubmit={saveProviderConfig}
    >
      <strong>Provider</strong>
      <label>
        <span>Type</span>
        <select
          name="providerKind"
          value={selectedProviderKind}
          onChange={(event) => {
            setSelectedProviderKind(readProviderKindValue(event.target.value));
            setDirty(true);
          }}
          disabled={isSaving}
        >
          <option value="openai-compatible">OpenAI-compatible</option>
          <option value="ollama">Ollama</option>
        </select>
      </label>
      <label>
        <span>Name</span>
        <input
          name="displayName"
          value={draft.displayName}
          onChange={event => updateDraft("displayName", event.target.value)}
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Base URL</span>
        <input
          name="baseUrl"
          value={draft.baseUrl}
          onChange={event => updateDraft("baseUrl", event.target.value)}
          required
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Model</span>
        <input
          name="model"
          value={draft.model}
          onChange={event => updateDraft("model", event.target.value)}
          required
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      <label>
        <span>Timeout</span>
        <input
          name="timeoutMs"
          type="number"
          min="1000"
          step="1000"
          value={draft.timeoutMs}
          onChange={event => updateDraft("timeoutMs", event.target.value)}
          required
          autoComplete="off"
          disabled={isSaving}
        />
      </label>
      {selectedProviderKind === "ollama" ? (
        <>
          <label>
            <span>Context window</span>
            <input
              name="ollamaContextWindowTokens"
              type="number"
              min="4096"
              step="1024"
              value={draft.contextWindowTokens}
              onChange={event => updateDraft("contextWindowTokens", event.target.value)}
              required
              autoComplete="off"
              disabled={isSaving}
            />
          </label>
          <label>
            <span>Maximum output</span>
            <input
              name="ollamaMaximumOutputTokens"
              type="number"
              min="256"
              step="256"
              value={draft.maximumOutputTokens}
              onChange={event => updateDraft("maximumOutputTokens", event.target.value)}
              required
              autoComplete="off"
              disabled={isSaving}
            />
          </label>
        </>
      ) : null}
      <label>
        <span>Model qualification</span>
        <select
          name="qualificationPolicy"
          value={draft.qualificationPolicy}
          onChange={event => updateDraft("qualificationPolicy", event.target.value as HelarcModelUsePolicy)}
          disabled={isSaving}
        >
          <option value="require_qualified">Require qualified</option>
          <option value="allow_experimental">Allow experimental</option>
        </select>
      </label>
      <label>
        <span>API key</span>
        <input
          name="apiKey"
          type="password"
          value={draft.apiKey}
          onChange={event => updateDraft("apiKey", event.target.value)}
          autoComplete="off"
          disabled={isSaving}
          placeholder={
            canKeepCredential
              ? "Stored key is present"
              : "Optional for local endpoints"
          }
        />
      </label>
      <div className="settings-status">
        <span>Credential</span>
        <strong>{credentialStatus}</strong>
      </div>
      <div className="settings-status">
        <span>Qualification policy</span>
        <strong>
          {draft.qualificationPolicy}
        </strong>
      </div>
      {snapshot.provider.configured ? null : (
        <p className="settings-error">{snapshot.provider.error.message}</p>
      )}
      <button
        className="primary-button compact"
        type="submit"
        disabled={isSaving}
      >
        Save
      </button>
    </form>
    <QualificationSettingsPanel api={getHelarcApi()} dirty={dirty || isSaving} />
    </>
  );
}

interface ProviderSettingsDraft {
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: string;
  contextWindowTokens: string;
  maximumOutputTokens: string;
  qualificationPolicy: HelarcModelUsePolicy;
  apiKey: string;
}

function createProviderDraft(kind: HelarcProviderKind, profile: HelarcProviderProfileSnapshot | null): ProviderSettingsDraft {
  const saved = profile?.providerKind === kind ? profile : null;
  const defaults = HELARC_DEFAULT_PROVIDER_SETTINGS;
  const ollama = HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE;
  return {
    displayName: saved?.displayName ?? (kind === "ollama" ? defaults.displayName : "OpenAI-compatible Provider"),
    baseUrl: saved?.baseUrl ?? (kind === "ollama" ? defaults.baseUrl : ""),
    model: saved?.model ?? (kind === "ollama" ? defaults.model : ""),
    timeoutMs: String(saved?.timeoutMs ?? defaults.timeoutMs),
    contextWindowTokens: String(saved?.ollamaRuntime?.contextWindowTokens ?? ollama.contextWindowTokens),
    maximumOutputTokens: String(saved?.ollamaRuntime?.maximumOutputTokens ?? ollama.maximumOutputTokens),
    qualificationPolicy: saved?.qualificationPolicy ?? defaults.qualificationPolicy,
    apiKey: "",
  };
}

function sameApiBase(left: string, right: string): boolean {
  try {
    return new URL(left).href.replace(/\/+$/, "") === new URL(right).href.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function readFormNumber(
  formData: FormData,
  key: string,
  fallback: number,
): number {
  const parsed = Number(readFormString(formData, key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProviderKind(
  formData: FormData,
  fallback: HelarcProviderKind,
): HelarcProviderKind {
  const value = readFormString(formData, "providerKind");
  return value === "openai-compatible" || value === "ollama" ? value : fallback;
}

function readProviderKindValue(value: string): HelarcProviderKind {
  return value === "ollama" ? "ollama" : "openai-compatible";
}

function readQualificationPolicy(
  formData: FormData,
  fallback: HelarcModelUsePolicy,
): HelarcModelUsePolicy {
  const value = formData.get("qualificationPolicy");
  return value === "require_qualified" || value === "allow_experimental"
    ? value
    : fallback;
}

function getHelarcApi() {
  return typeof window === "undefined" ? null : window.helarc;
}

function createCommandId(kind: string): string {
  return `helarc-desktop-${kind}-${globalThis.crypto.randomUUID()}`;
}
