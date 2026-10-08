import * as React from "react";
import type { ModelThinkingSelection, ModelThinkingCapability } from "../../shared/HelarcModelSelection.js";

export function ModelThinkingFields({ value, capability, onChange, disabled = false }: {
  value: ModelThinkingSelection; capability?: ModelThinkingCapability;
  onChange: (value: ModelThinkingSelection) => void; disabled?: boolean;
}) {
  const values = capability?.values ?? [];
  const selected = value.mode === "enabled" && value.effort ? `effort:${value.effort}` : value.mode;
  const options = [{ value: "default", label: "Provider default" },
    ...(values.includes(false) ? [{ value: "disabled", label: "Off" }] : []),
    ...(values.includes(true) ? [{ value: "enabled", label: "On" }] : []),
    ...values.filter((v): v is string => typeof v === "string").map(v => ({ value: `effort:${v}`, label: `On / ${v}` }))];
  return <label className="model-thinking-field"><span>Thinking</span>
    <select aria-label="Thinking" value={selected} disabled={disabled} onChange={event => {
      const mode = event.target.value;
      onChange(mode === "default" || mode === "disabled" ? { mode } : mode === "enabled" ? { mode } : { mode: "enabled", effort: mode.slice(7) });
    }}>
      {!options.some(option => option.value === selected) && <option value={selected} disabled>{value.mode === "enabled" ? `On${value.effort ? ` / ${value.effort}` : ""}` : value.mode === "disabled" ? "Off" : "Provider default"} (support not confirmed)</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <small className="wb-muted">{capability?.status === "known"
      ? `Source: ${capability.source}. Default: ${capability.defaultValue === null ? "not reported" : capability.defaultValue === false ? "off" : capability.defaultValue === true ? "on" : capability.defaultValue}.`
      : "Thinking support unknown"}</small>
  </label>;
}
