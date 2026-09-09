import { useEffect, useState, type FormEvent } from "react";
import type { HelarcDesktopApi } from "../shared/HelarcDesktopApi.js";
import type { HelarcInspectionSettings, HelarcInspectionSettingsSnapshot } from "../shared/HelarcInspectionSettings.js";

const fields: readonly [keyof HelarcInspectionSettings, string][] = [["enabled", "Record diagnostic facts"], ["definition", "Tool definitions"], ["agent", "Agent content and RunItems"], ["provider", "Provider requests and responses"], ["execution", "Execution input and output"]];
export function InspectionSettingsPanel({ api }: { api: HelarcDesktopApi | null }) {
  const [snapshot, setSnapshot] = useState<HelarcInspectionSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<HelarcInspectionSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api?.getInspectionSettings().then((value) => { if (active) { setSnapshot(value); setDraft(value.settings); } }).catch((cause) => { if (active) setError(String(cause.message)); });
    return () => { active = false; };
  }, [api]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!api || !draft) return;
    setSaving(true); setError(null);
    try {
      const result = await api.saveInspectionSettings({ commandId: crypto.randomUUID(), settings: draft });
      if (result.status !== "handled") throw new Error(result.code);
      setSnapshot(result.result); setDraft(result.result.settings);
    } catch (cause) { setError((cause as Error).message); } finally { setSaving(false); }
  }
  return <form className="settings-panel" onSubmit={(event) => { void save(event); }}><h2>Inspection</h2>{error && <p role="alert">{error}</p>}{draft && fields.map(([key, label]) => <label className="inspection-setting" key={key}><input type="checkbox" checked={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} disabled={saving} /><span>{label}</span></label>)}{snapshot && <dl className="inspection-health"><dt>Recorder</dt><dd>{snapshot.health.available ? "Available" : snapshot.health.code ?? "Unavailable"}</dd><dt>Queued</dt><dd>{snapshot.health.queued}</dd><dt>Dropped / rejected</dt><dd>{snapshot.health.dropped} / {snapshot.health.rejected}</dd></dl>}<button type="submit" disabled={!draft || saving}>{saving ? "Saving..." : "Save"}</button></form>;
}
