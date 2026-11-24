import * as React from "react";
import { useEffect, useRef, useState } from "react";

export function ProviderModelCatalog({ models, model, onSelect }: {
  models: readonly string[]; model: string; onSelect(model: string): void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    setFilter("");
    if (details.current) details.current.open = true;
  }, [models]);
  const query = filter.trim().toLowerCase();
  const matches = query ? models.filter(id => id.toLowerCase().includes(query)) : models;
  if (!models.length) return <small role="status">No models returned.</small>;
  return <details ref={details} className="provider-model-catalog">
    <summary>{models.length} {models.length === 1 ? "model" : "models"}</summary>
    <input type="search" aria-label="Filter models" placeholder="Filter models" value={filter}
      onChange={event => setFilter(event.target.value)} />
    {query && <small role="status">{matches.length} of {models.length} models</small>}
    {matches.length > 0 && <select aria-label="Available models" size={Math.min(7, Math.max(2, matches.length))}
      value={matches.includes(model) ? model : ""} onChange={event => onSelect(event.target.value)}>
      <option value="" disabled hidden />
      {matches.map(id => <option key={id} value={id} title={id}>{id}</option>)}
    </select>}
  </details>;
}
