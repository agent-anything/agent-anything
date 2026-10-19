import { useEffect, useState } from "react";
import { CircleStop, Play } from "lucide-react";
import type { HelarcRecoverableWork } from "../../shared/HelarcExecutionRecovery.js";

export function ExecutionRecovery({threadId, status, onRecovered}: {
  readonly threadId: string | null;
  readonly status: string;
  readonly onRecovered: () => void;
}) {
  const [entries, setEntries] = useState<readonly HelarcRecoverableWork[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void window.helarc.listRecoverableWork().then(value => {if (current) {setEntries(value); setError(null);}},
      () => {if (current) setError("Retained work could not be read.");});
    return () => {current = false;};
  }, [threadId, status]);
  const recover = async (entry: HelarcRecoverableWork, intent: "continue" | "cancel") => {
    setBusy(true); setError(null);
    try {
      const result = await window.helarc.recoverWork({id: entry.id, revision: entry.revision, intent});
      if (!result.ok) setError(result.message);
      else {setEntries(values => values.filter(value => value.id !== entry.id)); onRecovered();}
    } catch {setError("Recovery could not be confirmed. The retained execution was not discarded.");}
    finally {setBusy(false);}
  };
  if (entries.length === 0 && !error) return null;
  return <section className="wb-recovery" aria-label="Interrupted work">
    {entries.filter(entry => threadId === null || entry.threadId === threadId).map(entry =>
      <div key={entry.id} className="wb-recovery-item">
        <div><strong>{entry.state === "delivery_pending" ? "Result ready to restore" : "Interrupted work"}</strong><p>{entry.title}</p></div>
        <button type="button" className="wb-icon" title={entry.state === "delivery_pending" ? "Restore result" : "Resume work"}
          aria-label={entry.state === "delivery_pending" ? "Restore result" : "Resume work"} disabled={busy} onClick={() => void recover(entry, "continue")}><Play size={16}/></button>
        {entry.state === "interrupted" && <button type="button" className="wb-icon danger" title="Cancel retained work"
          aria-label="Cancel retained work" disabled={busy} onClick={() => void recover(entry, "cancel")}><CircleStop size={16}/></button>}
      </div>)}
    {error && <p role="alert" className="wb-warning">{error}</p>}
  </section>;
}
