import * as React from "react";
import { useEffect } from "react";
import type { HelarcProviderSnapshot } from "../../shared/HelarcDesktopApi.js";
import type { HelarcModelSelection } from "../../shared/HelarcModelSelection.js";
import { ModelThinkingFields } from "./ModelThinkingFields.js";
import { useModelDiscovery } from "./useModelDiscovery.js";

export function ComposerModelSelection({ provider, value, onChange, disabled }: {
  provider: HelarcProviderSnapshot; value: HelarcModelSelection | undefined;
  onChange: (value: HelarcModelSelection | undefined) => void; disabled: boolean;
}) {
  const profile = provider.profiles.find(p => p.id === value?.profileId) ?? provider.activeProfile;
  useEffect(() => {
    if (value && (!profile?.revision || value.profileId !== profile.id || value.profileRevision !== profile.revision)) onChange(undefined);
  }, [profile?.id, profile?.revision, value?.profileId, value?.profileRevision]);
  const selection = value ?? (profile?.revision ? { profileId: profile.id, profileRevision: profile.revision,
    model: profile.model, thinking: profile.modelSettings?.thinking ?? { mode: "default" as const } } : undefined);
  const model = selection?.model ?? "";
  const discovery = useModelDiscovery(profile?.id, profile?.revision, model);
  if (!profile?.revision || !selection) return null;
  return <div className="composer-model-selection">
    <label><span>Provider</span><select aria-label="Next task Provider" value={profile.id} disabled={disabled} onChange={event => {
      const selected = provider.profiles.find(p => p.id === event.target.value);
      if (selected?.revision) onChange({ profileId: selected.id, profileRevision: selected.revision, model: selected.model,
        thinking: selected.modelSettings?.thinking ?? { mode: "default" } });
    }}>{provider.profiles.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}</select></label>
    <label><span>Model</span><input aria-label="Next task model" list="composer-models" value={model} disabled={disabled}
      onChange={event => onChange({ ...selection, model: event.target.value, thinking: { mode: "default" } })}/>
      <datalist id="composer-models">{discovery.result?.ok && discovery.result.catalog.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></label>
    <ModelThinkingFields value={selection.thinking} capability={discovery.capability} disabled={disabled}
      onChange={thinking => onChange({ ...selection, thinking })}/>
    {discovery.result && !discovery.result.ok && <small className="wb-muted">{discovery.result.error}</small>}
  </div>;
}
