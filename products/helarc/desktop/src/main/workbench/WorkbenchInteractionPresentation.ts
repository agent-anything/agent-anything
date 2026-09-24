import type { HelarcRunPresentationRecord, HelarcRunProjection } from "@agent-anything/helarc/run";

type Call = Extract<HelarcRunPresentationRecord["content"], { kind: "tool_call" }>;

export function isWorkbenchInteraction(record: HelarcRunPresentationRecord): record is HelarcRunPresentationRecord & { content: Call } {
  return record.content.kind === "tool_call" && record.content.callableKind === "tool" &&
    record.content.toolBindingKind === "interaction";
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Settled user-facing facts, never a replacement Interaction request or submission. */
export function workbenchInteractionText(record: HelarcRunPresentationRecord, projection: Pick<HelarcRunProjection, "host" | "product">): {
  title: string; status: string; text: string;
} | null {
  if (!isWorkbenchInteraction(record) || record.content.settlement === null) return null;
  const c = record.content;
  const protocol = c.interactionProtocol;
  const clarification = protocol?.owner === "helarc" && protocol.kind === "clarification" && protocol.revision === "1";
  const title = clarification ? "Question" : "Interaction";
  const result = object(c.result);
  const statuses: Record<string, string> = {
    resolved: "Answered", expired: "Expired", cancelled: "Cancelled", invalidated: "No longer applicable", failed: "Failed",
  };
  const settledInteraction = result.kind === "interaction" && typeof result.status === "string" && Object.hasOwn(statuses, result.status);
  const rejected = ["tool_rejected", "model_call_rejected", "interaction_rejected"].includes(String(result.kind));
  const status = settledInteraction ? statuses[String(result.status)]! : rejected ? "Not asked" : "Outcome unavailable";
  const lines: string[] = [];
  const attribution = record.runId === projection.host.runId ? "Main task"
    : projection.product.presentation.labels.find(label => label.runId === record.runId)?.label ?? "Subtask";
  lines.push(`From: ${attribution}`, "");

  if (!settledInteraction) {
    lines.push(rejected ? "The interaction request could not proceed." : "Interaction outcome details are unavailable.");
    const code = result.code ?? object(result.failure).code;
    if (typeof code === "string") lines.push(`Reference: ${code}`);
  } else if (clarification) {
    const input = object(c.input);
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const value = object(result.value);
    const answers = Array.isArray(value.answers) ? value.answers.map(object) : [];
    let shown = 0;
    for (const entry of questions.slice(0, 4)) {
      const question = object(entry);
      if (typeof question.prompt !== "string" || typeof question.id !== "string") continue;
      shown++;
      lines.push(question.prompt);
      if (result.status === "resolved") {
        const matches = answers.filter(answer => answer.question_id === question.id);
        const answer = matches.length === 1 ? matches[0] : undefined;
        if (!answer || !Array.isArray(answer.selected_labels) || !(answer.text === null || typeof answer.text === "string")) lines.push("Answer content unavailable.");
        else {
          const selected = Array.isArray(answer.selected_labels) ? answer.selected_labels.filter((s): s is string => typeof s === "string") : [];
          lines.push("Your answer:", ...selected);
          if (typeof answer.text === "string" && answer.text.length > 0) lines.push(answer.text);
          else if (selected.length === 0) lines.push("No answer text supplied.");
        }
      }
      lines.push("");
    }
    if (shown !== questions.length || shown === 0) lines.push("Some question content is unavailable.");
    if (result.status !== "resolved") lines.push(`Question ${status.toLowerCase()}.`);
  } else {
    lines.push(`Interaction ${result.status === "resolved" ? "resolved" : status.toLowerCase()}.`);
    lines.push("No user-facing content is available for this interaction protocol.");
  }
  return { title, status: !clarification && status === "Answered" ? "Resolved" : status, text: lines.join("\n").trim() };
}
