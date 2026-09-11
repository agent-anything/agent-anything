import { format } from "jsonc-parser";

const DISPLAY_LIMIT = 2 * 1024 * 1024;

export type RecordedJsonFormatting = { kind: "formatted"; text: string } |
  { kind: "unavailable"; reason: "invalid_json" | "display_limit" };

export function formatRecordedContent(text: string, language: string): string {
  if (language === "json") {
    const result = formatRecordedJson(text);
    if (result.kind === "formatted") return result.text;
  }
  return text.slice(0, DISPLAY_LIMIT);
}

export function formatRecordedJson(text: string): RecordedJsonFormatting {
  if (text.length > DISPLAY_LIMIT) return { kind: "unavailable", reason: "display_limit" };
  try {
    JSON.parse(text);
  } catch {
    return { kind: "unavailable", reason: "invalid_json" };
  }
  // Only whitespace edits: preserve numeric literals, key order and string escapes.
  const edits = format(text, undefined, { tabSize: 2, insertSpaces: true });
  const length = edits.reduce((size, edit) => size + edit.content.length - edit.length, text.length);
  if (length > DISPLAY_LIMIT) return { kind: "unavailable", reason: "display_limit" };
  // Apply ordered edits in one pass instead of repeatedly copying a large payload.
  const parts: string[] = [];
  let offset = 0;
  for (const edit of edits) {
    parts.push(text.slice(offset, edit.offset), edit.content);
    offset = edit.offset + edit.length;
  }
  parts.push(text.slice(offset));
  return { kind: "formatted", text: parts.join("") };
}
