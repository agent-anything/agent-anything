import { helarcSubtaskName, type HelarcRunPresentationRecord, type HelarcRunProjection } from "@agent-anything/helarc/run";

/** Received Product content only; not system instructions or a Provider-request replay. */
export function conversationInputText(record: HelarcRunPresentationRecord, p: HelarcRunProjection): {
  title: string; text: string; omittedBytes: number; disposition: string | null;
} | null {
  if (!p.host.runTree.nodes.some(node => node.runId === record.runId && node.parentRunId !== null)) return null;
  const content = record.content;
  if (content.kind === "received_input") {
    const sender = content.senderRunId === null ? null : helarcSubtaskName(p.product.presentation.labels, content.senderRunId);
    const label = content.inputKind === "task" ? "Received task" : content.inputKind === "agent_result" ? "Result" : "Message";
    return {title: sender ? `${label} from ${sender}` : label,
      text: content.text || "No text was delivered.", omittedBytes: content.omittedBytes,
      disposition: content.disposition};
  }
  if (content.kind === "steering" && content.disposition === "applied") {
    return {title: content.origin === "user" ? "Message from you" : content.origin === "host" ? "Host message" : "Agent message",
      text: content.instruction, omittedBytes: content.omittedBytes, disposition: null};
  }
  return null;
}
