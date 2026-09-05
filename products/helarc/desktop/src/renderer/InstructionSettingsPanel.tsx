import * as React from "react";
import { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import type { HelarcDesktopApi } from "../shared/HelarcDesktopApi.js";
import type {
  HelarcInstructionSettings,
  HelarcInstructionSettingsSnapshot,
} from "../shared/HelarcInstructionSettings.js";

const TITLES: Readonly<Record<string, string>> = {
  identity_and_role: "Role Instructions",
  operating_principles: "Operating principles",
  task_execution: "Task execution",
  tool_use_guidance: "Tool use guidance",
  code_change_behavior: "Code change behavior",
  planning_and_progress: "Planning and progress",
  verification_and_completion: "Verification and completion",
  communication: "Communication",
  safety_and_uncertainty: "Safety and uncertainty",
  delegated_work: "Delegated work",
  native_tool_protocol: "Native tool protocol",
  permission_safety: "Permission and safety",
  stop_protocol: "Stop protocol",
  safe_output_boundary: "Output restrictions",
  stop_instructions: "Stop Instructions",
};

export function InstructionSettingsPanel({ api }: { api: HelarcDesktopApi | null }) {
  const [snapshot, setSnapshot] = useState<HelarcInstructionSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!api) {
      setError("Desktop connection unavailable.");
      setLoading(false);
      return;
    }
    api.getInstructionSettings().then((value) => {
      if (active) { setSnapshot(value); setLoading(false); }
    }).catch(() => {
      if (active) { setError("Could not load instruction settings."); setLoading(false); }
    });
    return () => { active = false; };
  }, [api]);

  if (loading) return <p role="status">Loading instructions...</p>;
  if (!snapshot || !api) return <p className="settings-error" role="alert">{error}</p>;
  return <InstructionSettingsEditor snapshot={snapshot} onSave={async (settings) => {
    const receipt = await api.saveInstructionSettings({ commandId: crypto.randomUUID(), settings });
    if (receipt.status !== "handled") throw new Error("Could not save instruction settings.");
    return receipt.result;
  }} />;
}

export function InstructionSettingsEditor({ snapshot, onSave }: {
  snapshot: HelarcInstructionSettingsSnapshot;
  onSave: (settings: HelarcInstructionSettings) => Promise<HelarcInstructionSettingsSnapshot>;
}) {
  const [draft, setDraft] = useState(snapshot.settings);
  const [saved, setSaved] = useState(snapshot.settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function update(group: keyof HelarcInstructionSettings, id: string, change: { enabled?: boolean; content?: string }) {
    setDraft((current) => ({ ...current, [group]: current[group].map((section) =>
      section.id === id ? { ...section, ...change } : section) }));
  }

  function restoreAllText() {
    setDraft((current) => {
      const restoreGroup = (group: keyof HelarcInstructionSettings) => current[group].map((section) => ({
        ...section,
        content: snapshot.defaults[group].find(({ id }) => id === section.id)!.content,
      }));
      return { agent: restoreGroup("agent"), delegated: restoreGroup("delegated"), protocol: restoreGroup("protocol"), stop: restoreGroup("stop") };
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await onSave(draft);
      setDraft(result.settings);
      setSaved(result.settings);
    } catch {
      setError("Could not save instruction settings. Your changes have not been applied.");
    } finally { setSaving(false); }
  }

  return <form className="instruction-settings" aria-label="Instruction settings" onSubmit={save}>
    <div className="instruction-toolbar">
      <span role="status">{saving ? "Saving..." : dirty ? "Unsaved changes" : "Saved"}</span>
      <button type="button" className="icon-button" title="Restore all default text" aria-label="Restore all default text"
        disabled={saving} onClick={restoreAllText}><RotateCcw size={16} /></button>
      <button type="submit" className="primary-button compact" disabled={saving || !dirty}>
        <Save size={15} /> Save
      </button>
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {([
      ["agent", "Agent Instructions"],
      ["delegated", "Child Instructions"],
      ["protocol", "Protocol Instructions"],
      ["stop", "Stop Instructions"],
    ] as const).map(([group, title]) => <section key={group} aria-label={title}>
      {group !== "stop" && <div className="instruction-group-heading">
        <h3>{title}</h3>
        <label className="instruction-toggle">
          <input type="checkbox" aria-label={`Enable all ${title}`} disabled={saving}
            checked={draft[group].every(({ enabled }) => enabled)}
            ref={(element) => {
              if (element) element.indeterminate = draft[group].some(({ enabled }) => enabled)
                && !draft[group].every(({ enabled }) => enabled);
            }}
            onChange={(event) => {
              const enabled = event.target.checked;
              setDraft((current) => ({ ...current, [group]: current[group].map((entry) => ({ ...entry, enabled })) }));
            }} /> Enable all
        </label>
      </div>}
      {draft[group].map((section) => <div className="instruction-section" key={section.id}>
        <div className="instruction-section-heading">
          {group === "stop" ? <h3>{TITLES[section.id]}</h3> : <h4>{TITLES[section.id] ?? section.id}</h4>}
          <div className="instruction-section-controls">
          <label className="instruction-toggle">
            <input type="checkbox" role="switch" checked={section.enabled} disabled={saving}
              aria-label={`Enable ${TITLES[section.id]}`}
              onChange={(event) => update(group, section.id, { enabled: event.target.checked })} />
            <span>{section.enabled ? "Enabled" : "Disabled"}</span>
          </label>
          <button type="button" className="icon-button" disabled={saving}
            title={`Restore ${TITLES[section.id]} default text`} aria-label={`Restore ${TITLES[section.id]} default text`}
            onClick={() => update(group, section.id, { content: snapshot.defaults[group].find(({ id }) => id === section.id)!.content })}>
            <RotateCcw size={15} />
          </button>
          </div>
        </div>
        <textarea aria-label={`${TITLES[section.id]} text`} value={section.content} disabled={saving}
          maxLength={32_768} rows={8} spellCheck={false}
          onChange={(event) => update(group, section.id, { content: event.target.value })} />
      </div>)}
    </section>)}
    <section className="instruction-preview" aria-label="System prompt preview">
      <div className="instruction-group-heading">
        <h3>Model Request Preview (System Prompt)</h3>
      </div>
      {([["root", "Root"], ["child", "Child"], ["stop", "Stop"]] as const).map(([target, title]) => <div className="instruction-preview-target" key={target}>
        <h4>{title}</h4>
        <textarea aria-label={`${title} system prompt preview text`}
          readOnly rows={12} value={instructionPreview(draft, target)} placeholder="No system instructions" />
      </div>)}
    </section>
  </form>;
}

export function instructionPreview(settings: HelarcInstructionSettings, target: "root" | "child" | "stop"): string {
  const sections = target === "stop" ? settings.stop
    : [...settings.agent, ...(target === "child" ? settings.delegated : []), ...settings.protocol];
  return sections
    .filter(({ enabled, content }) => enabled && content.trim().length > 0)
    .map(({ content }) => content).join("\n\n");
}
