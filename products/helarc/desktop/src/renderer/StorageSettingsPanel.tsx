import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import type { HelarcDesktopApi } from "../shared/HelarcDesktopApi.js";
import type { HelarcStorageSnapshot, HelarcStorageCleanupResult } from "../shared/HelarcStorage.js";

export function StorageSettingsPanel({ api }: { api: HelarcDesktopApi | null }) {
  const [snapshot, setSnapshot] = useState<HelarcStorageSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<HelarcStorageCleanupResult | null>(null);
  const refresh = useCallback(async () => {
    if (!api) { setError("Storage is unavailable."); return; }
    setBusy(true); setError(null); setConfirming(false);
    try { setSnapshot(await api.getStorage()); setSelection([]); }
    catch { setError("Storage could not be refreshed."); }
    finally { setBusy(false); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function cleanup() {
    if (!api || busy || !selection.length) return;
    setBusy(true); setError(null); setResult(null); setConfirming(false);
    try {
      const receipt = await api.cleanupStorage({ commandId: crypto.randomUUID(), recordingIds: selection });
      if (receipt.status !== "handled") throw new Error(receipt.code);
      setResult(receipt.result); setSelection([]);
      setSnapshot(await api.getStorage());
    } catch { setError("Cleanup or the usage refresh could not finish. Refresh storage to check the current state."); }
    finally { setBusy(false); }
  }

  const recordings = snapshot?.inspection.recordings ?? [];
  const eligible = recordings.filter(recording => recording.status === "closed");
  const selectedBytes = recordings.reduce((sum, recording) => sum + (selection.includes(recording.id) ? recording.bytes : 0), 0);
  const removed = result?.recordings.filter(recording => recording.status === "removed").length ?? 0;
  return <section className="settings-panel storage-panel" aria-labelledby="storage-title">
    <div className="storage-heading"><h2 id="storage-title">Storage</h2>
      <button type="button" className="secondary-button" onClick={() => { void refresh(); }} disabled={busy} title="Refresh storage usage" aria-label="Refresh storage usage"><RefreshCw size={16} aria-hidden="true" /></button>
    </div>
    {busy && <p role="status">{snapshot ? "Updating storage..." : "Measuring storage..."}</p>}
    {error && <p role="alert">{error}</p>}
    {snapshot && <>
      <p className="storage-note">Measured {new Date(snapshot.measuredAt).toLocaleString()}</p>
      <table className="storage-table"><thead><tr><th>Category</th><th>Size</th><th>Cleanup</th></tr></thead><tbody>
        <tr><th scope="row">Inspection recordings</th><td>{formatBytes(snapshot.inspection.bytes)}</td><td>Closed recordings below</td></tr>
        {snapshot.categories.map(category => <tr key={category.id}><th scope="row">{category.name}</th><td>{formatBytes(category.bytes)}</td><td className="storage-note">Not available here</td></tr>)}
      </tbody></table>
      {snapshot.issues.map(issue => <p role="alert" key={issue}>{issue}</p>)}
      <section className="storage-recordings" aria-labelledby="recordings-title">
        <div className="storage-heading"><h3 id="recordings-title">Inspection recordings <span className="storage-note">({recordings.length})</span></h3>
          <button type="button" className="secondary-button" onClick={() => setConfirming(true)} disabled={busy || !selection.length}><Trash2 size={16} aria-hidden="true" />Delete selected ({selection.length})</button>
        </div>
        <p className="storage-note">Source: {formatBytes(snapshot.inspection.bytes)} / {formatBytes(snapshot.inspection.sourceLimitBytes)}. Per recording limit: {formatBytes(snapshot.inspection.datasetLimitBytes)}.</p>
        <p className="storage-note">Recorder: {snapshot.inspection.health.available ? "Available" : `Stopped (${snapshot.inspection.health.code ?? "unavailable"}). Restart Helarc after resolving the cause.`}</p>
        {confirming && <div className="storage-confirmation" role="alertdialog" aria-labelledby="cleanup-title">
          <strong id="cleanup-title">Delete {selection.length} recordings ({formatBytes(selectedBytes)})?</strong>
          <p>Recorded diagnostic content will be permanently removed. Conversations, settings and workspace files are not affected.</p>
          <div className="storage-actions"><button type="button" className="secondary-button" onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="secondary-button" onClick={() => { void cleanup(); }}><Trash2 size={16} aria-hidden="true" />Delete recordings</button></div>
        </div>}
        {result && <div role="status" className="storage-cleanup-result">
          <p>{removed} removed. {result.recordings.length - removed} retained.</p>
          {result.recordings.some(recording => recording.status !== "removed") && <ul>{result.recordings.filter(recording => recording.status !== "removed").map(recording => <li key={recording.id}><code>{recording.id}</code>: {recording.status === "protected" ? "Protected or currently being read" : "Unavailable; not removed"}</li>)}</ul>}
        </div>}
        {recordings.length === 0 ? <p className="storage-note">No recordings available.</p> : <>
          <p className="storage-note">Open or unconfirmed recordings are protected. Active readers can temporarily prevent deletion.</p>
          <table className="storage-table storage-recording-table"><thead><tr>
            <th><input type="checkbox" aria-label="Select all closed recordings" disabled={busy || !eligible.length} checked={eligible.length > 0 && selection.length === eligible.length} onChange={event => { setSelection(event.target.checked ? eligible.map(recording => recording.id) : []); setConfirming(false); }} /></th>
            <th>Created / recording</th><th>Size</th><th>State</th>
          </tr></thead><tbody>{recordings.map(recording => <tr key={recording.id}>
            <td><input type="checkbox" aria-label={`Select recording ${recording.id}`} checked={selection.includes(recording.id)} disabled={busy || recording.status !== "closed"} onChange={event => { setSelection(current => event.target.checked ? [...current, recording.id] : current.filter(id => id !== recording.id)); setConfirming(false); }} /></td>
            <td>{recording.createdAt ? new Date(recording.createdAt).toLocaleString() : "Unknown"}<code title={recording.id}>{recording.id}</code></td>
            <td>{formatBytes(recording.bytes)}</td>
            <td>{recording.status === "closed" ? recording.captureFailure ? "Closed after capture failure" : "Closed" : recording.status === "open" ? "Open / closure unconfirmed" : "Unavailable"}{recording.captureFailure && <small>{recording.captureFailure}</small>}</td>
          </tr>)}</tbody></table>
        </>}
      </section>
    </>}
  </section>;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(1)} ${units[index]}`;
}
