import type { HelarcRunProjection } from "@agent-anything/helarc/run";
import type { ConversationChildTextPreview } from "../../shared/HelarcWorkbench.js";

/** Display-only tail, not another Child history reader or a generated summary. */
export function conversationChildResponse(p: HelarcRunProjection, runId: string): ConversationChildTextPreview | null {
  const record = p.product.presentation.records.filter(r => r.runId === runId &&
    (r.content.kind === "assistant_text" || r.content.kind === "final_response") && r.content.text).at(-1);
  const attempt = p.product.responses.attempts.filter(a => a.runId === runId &&
    a.parts.some(part => (part.kind === "text" || part.kind === "final_response") && part.text)).at(-1);
  const part = attempt?.parts.filter(part => (part.kind === "text" || part.kind === "final_response") && part.text).at(-1);
  // Commit provenance wins over a buffered preview of the same public block.
  const committed = record && part && (record.id === part.committedRecordId ||
    (part.modelItemId !== null && record.origin?.modelItemId === part.modelItemId));
  if (attempt && part && !committed && (!record || attempt.observedAt > record.observedAt)) {
    return {
      text: tail(part.text), revision: JSON.stringify([attempt.invocationId, part.id, part.receivedLength]),
      disposition: ["failed", "rejected", "cancelled", "interrupted"].includes(attempt.state)
        ? `${attempt.state} response` : part.kind === "final_response" ? "Awaiting completion" : null,
      retentionLimited: part.omittedBytes > 0,
    };
  }
  if (!record || (record.content.kind !== "assistant_text" && record.content.kind !== "final_response")) return null;
  const content = record.content;
  return {
    text: tail(content.text), revision: JSON.stringify([record.id, record.revision]),
    disposition: content.kind !== "final_response" || content.disposition === "completed" ? null
      : ["proposed", "accepted"].includes(content.disposition) ? "Awaiting completion" : "Not finalized",
    retentionLimited: content.omittedBytes > 0,
  };
}

function tail(text: string): string {
  let start = Math.max(0, text.length - 512);
  if (/[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start++;
  return text.slice(start);
}
