import * as React from "react";
import { useEffect, useState } from "react";
import { MODEL_INTERACTION_PROTOCOLS, type ProviderConfiguration } from "../../shared/ProviderConfiguration.js";
import type { ProviderExecutionEligibility, ProviderSettingsApi, ProviderTaskSelection } from "../../shared/ProviderSettingsApi.js";

/** A next-task choice is local draft state, not Settings activation or a change to an accepted Run. */
export function ProtocolTaskSelection({ api, value, onChange, disabled, visible }: {
  api: ProviderSettingsApi;
  value: ProviderTaskSelection | undefined;
  onChange(value: ProviderTaskSelection | undefined): void;
  disabled: boolean;
  visible: boolean;
}) {
  const [choices, setChoices] = useState<readonly { configuration: ProviderConfiguration; eligibility: ProviderExecutionEligibility }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void (async () => {
      const listing = await api.list();
      if (!listing.ok) throw new Error(listing.code);
      const result = [];
      for (const configuration of listing.value.configurations) {
        const eligibility = await api.eligibility(configuration);
        result.push({ configuration, eligibility: eligibility.ok ? eligibility.value : { available: false, reason: eligibility.code } });
      }
      if (active) { setChoices(result); setError(null); }
    })().catch(() => { if (active) setError("Provider configurations could not be loaded."); });
    return () => { active = false; };
  }, [api, visible]);
  const selected = choices.find(choice => choice.configuration.id === value?.id && choice.configuration.revision === value?.revision);
  return <div className="composer-model-selection">
    <label><span>Next task configuration</span><select aria-label="Next task protocol configuration" disabled={disabled || !visible}
      value={value ? `${value.id}:${value.revision}` : ""} onChange={event => {
        const choice = choices.find(item => `${item.configuration.id}:${item.configuration.revision}` === event.target.value);
        onChange(choice ? { id: choice.configuration.id, revision: choice.configuration.revision } : undefined);
      }}>
      <option value="">Current default</option>
      {value && !selected && <option value={`${value.id}:${value.revision}`} disabled>Selected revision unavailable</option>}
      {Object.entries(MODEL_INTERACTION_PROTOCOLS).map(([protocol, definition]) => <optgroup key={protocol} label={definition.name}>
        {choices.filter(choice => choice.configuration.protocol === protocol).map(({ configuration, eligibility }) =>
          <option key={configuration.id} value={`${configuration.id}:${configuration.revision}`} disabled={!eligibility.available || !configuration.model}>
            {configuration.name} / {configuration.model || "No model"}{eligibility.available ? "" : " (execution unavailable)"}
          </option>)}
      </optgroup>)}
    </select></label>
    {error && <small role="alert">{error}</small>}
    {value && !selected && <small role="alert">Choose a current saved revision before starting work.</small>}
  </div>;
}
