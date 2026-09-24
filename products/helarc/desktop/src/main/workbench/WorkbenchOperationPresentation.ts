import type { HelarcRunPresentationRecord, HelarcRunProjection } from "@agent-anything/helarc/run";
import type { WorkbenchOperationDetail, WorkbenchOperationSection, WorkbenchItemQuery } from "../../shared/HelarcWorkbench.js";
import { textPage, validOffset } from "./WorkbenchReadLimits.js";

type Call = Extract<HelarcRunPresentationRecord["content"], { kind: "tool_call" }>;
type ContentSection = Omit<WorkbenchOperationSection, "nextOffset">;
const labels: Readonly<Record<string, string>> = {
  Agent: "Delegated task", SendMessage: "Message to delegated task",
  Read: "Read file", Glob: "Find files", Grep: "Search contents",
  Write: "Write file", Edit: "Edit file", Bash: "Bash command", PowerShell: "PowerShell command",
  AskUserQuestion: "Question", TaskOutput: "Read command output", TaskStop: "Stop command",
};

export function isWorkbenchOperation(record: HelarcRunPresentationRecord): record is HelarcRunPresentationRecord & { content: Call } {
  return record.content.kind === "tool_call" &&
    (record.content.callableKind === "unresolved" ||
      (record.content.callableKind === "tool" && record.content.toolBindingKind !== "interaction"));
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function heading(c: Call) {
  return c.callableKind === "tool" && c.resolvedName ? labels[c.resolvedName] ?? c.resolvedName : "Model call";
}
function summary(c: Call): string | null {
  const input = object(c.input);
  const fields = c.resolvedName === "Agent" ? ["description"]
    : c.resolvedName === "SendMessage" ? []
    : ["command", "file_path", "path", "pattern", "description"];
  const value = fields.map(key => string(input[key])).find(Boolean);
  if (!value) return null;
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 180 ? line.slice(0, 180) + "..." : line;
}
export function workbenchOperationTitle(c: Call): string {
  const label = summary(c);
  return label ? `${heading(c)}: ${label}` : heading(c);
}

function callStatus(value: string | null, live: boolean): string {
  if (!value) return live ? "In progress" : "Not active";
  return ({ succeeded: "Returned", partial: "Partially returned", failed: "Failed",
    cancelled: "Cancelled", invalid: "Not executed", invalidated: "Invalidated",
    denied: "Not approved", timed_out: "Timed out", unknown_effect: "Outcome uncertain" } as Record<string, string>)[value]
    ?? value.replaceAll("_", " ");
}

export function workbenchOperationDetail(
  record: HelarcRunPresentationRecord,
  projection: HelarcRunProjection,
  live: boolean,
  query: WorkbenchItemQuery,
): WorkbenchOperationDetail | null {
  if (!isWorkbenchOperation(record)) return null;
  const c = record.content;
  const sections: ContentSection[] = [];
  const facts: { label: string; value: string }[] = [];
  const add = (id: string, label: string, value: unknown, format: ContentSection["format"] = "text") => {
    if (value === null || value === undefined) return;
    const text = typeof value === "string" ? value : JSON.stringify(value, redact, 2);
    sections.push({ id, label, format: typeof value === "string" ? format : "json", text });
  };
  const input = object(c.input);
  if (c.resolvedName === "Agent" || c.resolvedName === "SendMessage") {
    // Delegation instructions and Agent communication are not end-user work content.
  } else if (c.resolvedName === "Write" || c.resolvedName === "Edit") {
    add("path", "File", input.file_path);
    if (c.resolvedName === "Write") add("content", "Content to write", input.content);
    else {
      add("old", "Text to replace", input.old_string);
      add("new", "Replacement", input.new_string);
      if (input.replace_all === true) facts.push({ label: "Replacement scope", value: "All matches" });
    }
  } else if (c.resolvedName === "Bash" || c.resolvedName === "PowerShell") {
    add("command", "Command", input.command);
    add("cwd", "Working directory", input.cwd);
  } else add("input", "Input", c.input);

  const result = object(c.result);
  const childResult = ["descendant_run", "descendant_progress", "descendant_result_transfer"].includes(String(result.kind));
  // Resolve relationships from owned records, never from names or model prose.
  const label = projection.product.presentation.labels.find(item =>
    item.parentRunId === record.runId && c.runActionId !== null && item.parentRunActionId === c.runActionId);
  const childId = label?.runId ?? (childResult ? string(result.childRunId) : null);
  const node = projection.host.runTree.nodes.find(item => item.runId === childId && item.parentRunId === record.runId);
  const child = node ? {
    runId: node.runId,
    label: projection.product.presentation.labels.find(item => item.runId === node.runId)?.label ?? "Delegated task",
    status: !live && !["completed", "failed", "cancelled"].includes(node.status) ? "inactive" : node.status,
  } : null;
  if (childResult) {
    const output = object(result.output);
    add("reply", "Subtask findings", output.summary, "markdown");
    if (string(output.status)) facts.push({ label: "Child state at return", value: String(output.status).replaceAll("_", " ") });
    if (string(output.effect_status)) facts.push({ label: "Reported effects", value: String(output.effect_status).replaceAll("_", " ") });
    if (Array.isArray(output.uncertainty) && output.uncertainty.length)
      facts.push({ label: "Reported limitations", value: output.uncertainty.map(String).join("\n") });
    if (Array.isArray(output.artifact_refs) && output.artifact_refs.length)
      facts.push({ label: "Returned artifacts", value: String(output.artifact_refs.length) });
  } else if (result.kind === "operation") add("output", "Output", result.output);
  else if (result.kind === "interaction") add("answer", "Answer", result.value);
  else if (c.result !== null && !["tool_rejected", "operation_rejected", "model_call_rejected"].includes(String(result.kind))) {
    // Unrecognized runtime envelopes belong in Inspector, not in the work detail.
    add("availability", "Result", "No user-facing result content was recorded.");
  }
  const failure = object(result.failure);
  const failureMessage = string(failure.message) ?? string(result.message);
  const failureCode = string(failure.code) ?? string(result.code);
  if (failureMessage || failureCode) add("failure", "Problem", failureMessage ?? failureCode);
  if (failureCode) facts.push({ label: "Error code", value: failureCode });
  if (Array.isArray(result.issues) && result.issues.length) add("issues", "Input issues", result.issues);
  if (c.result === null) add("availability", "Result", c.settlement === null
    ? live ? "No result yet." : "No result was recorded before this work became inactive."
    : "Result content is not available.");

  const selected = query.section === undefined ? sections : sections.filter(s => s.id === query.section);
  if (query.section !== undefined && selected.length !== 1) return null;
  const pages: WorkbenchOperationSection[] = [];
  for (const section of selected) {
    const offset = query.section === undefined ? 0 : query.offset ?? 0;
    if (!validOffset(section.text, offset)) return null;
    const page = textPage(section.text, offset, 8 * 1024, 16 * 1024);
    pages.push({ ...section, text: page.text, nextOffset: page.end < section.text.length ? page.end : null });
  }
  return { title: heading(c), summary: summary(c), status: callStatus(c.settlement, live), child, facts, sections: pages };
}

function redact(key: string, value: unknown): unknown {
  return /^(authorization|credentials?|apiKey|accessToken|refreshToken|password|secret|headers|environment|__proto__|constructor|prototype)$/i.test(key)
    ? undefined : value;
}
