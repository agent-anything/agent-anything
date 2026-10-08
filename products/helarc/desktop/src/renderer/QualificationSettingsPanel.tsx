import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, Check, FileText } from "lucide-react";
import type { HelarcDesktopApi } from "../shared/HelarcDesktopApi.js";
import type { HelarcQualificationSnapshot, HelarcQualificationCommandResult } from "../shared/HelarcQualification.js";

type QualificationApi = Pick<HelarcDesktopApi, "getQualification" | "startQualification" | "cancelQualification" | "publishQualification" | "readQualificationEvidence">;

export function QualificationSettingsPanel({ api, dirty }: { api: QualificationApi | null; dirty: boolean }) {
  const [snapshot, setSnapshot] = useState<HelarcQualificationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<string | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (!api?.getQualification) return;
    const request = ++sequence.current;
    try {
      const value = await api.getQualification();
      if (mounted.current && request === sequence.current) setSnapshot(value);
    } catch { if (mounted.current && request === sequence.current) setError("Qualification data could not be loaded."); }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!disposed) timer = setTimeout(() => void poll(), 2_000); };
    void poll();
    return () => { disposed = true; mounted.current = false; sequence.current++; clearTimeout(timer); };
  }, [refresh]);

  async function command(execute: () => Promise<{ status: string; result?: HelarcQualificationCommandResult }>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const receipt = await execute();
      if (receipt.status !== "handled" || !receipt.result) setError("The qualification command could not be accepted.");
      else if (!receipt.result.ok) setError(receipt.result.error);
      await refresh();
    } catch { if (mounted.current) setError("The qualification command could not be completed."); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="qualification-panel" aria-label="Model qualification">
    <h2>Model Qualification</h2>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {!snapshot ? <p>Loading qualification…</p> : <QualificationSettingsView snapshot={snapshot} dirty={dirty} busy={busy}
      onStart={() => api && snapshot.targetId && void command(() => api.startQualification({ commandId: id(), targetId: snapshot.targetId! }))}
      onCancel={campaignId => api && void command(() => api.cancelQualification({ commandId: id(), campaignId }))}
      onPublish={campaignId => api && snapshot.targetId && void command(() => api.publishQualification({ commandId: id(), campaignId, targetId: snapshot.targetId!, reviewed: true }))}
      onEvidence={async (campaignId, trialId) => {
        if (!api) return;
        try {
          const result = await api.readQualificationEvidence({ campaignId, trialId });
          if (mounted.current) { if (result.ok) setEvidence(result.text); else setError(result.error); }
        } catch { if (mounted.current) setError("Evidence could not be read."); }
      }} />}
    {evidence !== null && <details className="qualification-evidence" open>
      <summary>Retained evidence</summary>
      <pre>{evidence}</pre>
      <button className="secondary-button" type="button" onClick={() => setEvidence(null)}>Close evidence</button>
    </details>}
  </section>;
}

export function QualificationSettingsView({ snapshot, dirty, busy, onStart, onCancel, onPublish, onEvidence }: {
  snapshot: HelarcQualificationSnapshot; dirty: boolean; busy: boolean;
  onStart(): void; onCancel(id: string): void; onPublish(id: string): void; onEvidence(id: string, trial: string | null): void;
}) {
  const [reviewed, setReviewed] = useState<string | null>(null);
  return <>
    <div className="qualification-heading"><strong>{snapshot.model ?? "No saved Provider"}</strong><span>{label(snapshot.disposition ?? "unavailable")}</span></div>
    {snapshot.generationConfiguration && <details className="qualification-configuration"><summary>Effective model settings</summary>
      <pre>{JSON.stringify(snapshot.generationConfiguration, null, 2)}</pre></details>}
    {snapshot.error && <p className="settings-error" role="alert">{snapshot.error}</p>}
    <table className="qualification-table"><thead><tr><th>Scope</th><th>Evidence</th><th>Decision</th></tr></thead>
      <tbody>{snapshot.scopes.map(scope => <tr key={scope.scope}><td>{label(scope.scope)}</td><td>{label(scope.applicability)}</td><td>{label(scope.outcome ?? "not_published")}</td></tr>)}</tbody>
    </table>
    <p className="qualification-budget">{snapshot.protocol.totalTrials} trials · Up to {snapshot.protocol.maximumRequests} model requests · {snapshot.protocol.requestTimeoutMs / 1000}s per request</p>
    <details><summary>Coverage and limitations</summary><ul>{snapshot.protocol.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
    {dirty && <p className="settings-error">Provider settings have unsaved changes.</p>}
    <div className="qualification-actions">
      <button type="button" className="primary-button compact" disabled={dirty || busy || !snapshot.available || snapshot.activeCampaignId !== null}
        onClick={onStart}><Play size={15} aria-hidden="true" /> Run verification</button>
      {snapshot.activeCampaignId && <button type="button" className="secondary-button" disabled={busy}
        onClick={() => onCancel(snapshot.activeCampaignId!)}><Square size={14} aria-hidden="true" /> Cancel verification</button>}
    </div>
    {snapshot.campaigns.length > 0 && <h3>Verification history</h3>}
    {snapshot.campaigns.map(campaign => <details className="qualification-campaign" key={campaign.id} open={campaign.status === "running" ? true : undefined}>
      <summary>{new Date(campaign.startedAt).toLocaleString()} · {campaign.model} · {label(campaign.status)} · {campaign.completedTrials}/{campaign.totalTrials}
        {!campaign.currentTarget && " · Different configuration"}{campaign.publishedAt && " · Published"}</summary>
      {campaign.currentCase && <p role="status">{campaign.currentCase}</p>}
      <table className="qualification-table"><thead><tr><th>Scope</th><th>Passed</th><th>Result</th></tr></thead>
        <tbody>{campaign.results.map(scope => <tr key={scope.scope}><td>{label(scope.scope)}</td><td>{scope.passed}/{scope.required}</td><td>{label(scope.outcome)}</td></tr>)}</tbody>
      </table>
      <button type="button" className="secondary-button" onClick={() => onEvidence(campaign.id, null)}><FileText size={15} aria-hidden="true" /> Configuration evidence</button>
      <ul className="qualification-trials">{campaign.trials.map(trial => <li key={trial.id}>
        <button type="button" onClick={() => onEvidence(campaign.id, trial.id)}>{trial.title} · Trial {trial.repetition}</button>
        <span>{label(trial.outcome)} · {label(trial.stage)}{trial.failureCategory && ` · ${label(trial.failureCategory)}`} · {label(trial.reason)}
          {trial.resultDelivery === "not_submitted" && " · Tool result not submitted; result handling was not tested."}</span>
      </li>)}</ul>
      {campaign.status === "completed" && campaign.results.some(scope => scope.outcome !== "qualified") &&
        <p>Verification did not pass. Results are retained, but cannot be published.</p>}
      {campaign.status === "completed" && campaign.currentTarget && !campaign.publishedAt &&
        campaign.results.length > 0 && campaign.results.every(scope => scope.outcome === "qualified") && <div className="qualification-publication">
        <p>Publishing applies these passing results to future Runs.</p>
        <label><input type="checkbox" checked={reviewed === campaign.id} onChange={event => setReviewed(event.target.checked ? campaign.id : null)} />
          I reviewed the evidence, coverage limits, and mutable model identity.</label>
        <button type="button" className="secondary-button" disabled={dirty || busy || snapshot.activeCampaignId !== null || reviewed !== campaign.id}
          onClick={() => onPublish(campaign.id)}><Check size={15} aria-hidden="true" /> Publish reviewed results</button>
      </div>}
    </details>)}
  </>;
}

function id() { return `qualification-${globalThis.crypto.randomUUID()}`; }
function label(value: string): string { return value.replaceAll("_", " ").replace(/^./, c => c.toUpperCase()); }
