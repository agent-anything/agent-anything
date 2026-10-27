import type { OperationResult, OperationResultContract } from "@agent-anything/operation-catalog/result";
import type { RegisteredOperationDefinition } from "@agent-anything/operation-catalog/catalog";
import type { CodeFileOperationKind } from "./CodeFileOperation.js";
import { snapshotExecutionEvidenceRef } from "@agent-anything/operation-catalog/evidence";

export function codeFileResultContract(registration: RegisteredOperationDefinition, kind: CodeFileOperationKind): OperationResultContract {
  return Object.freeze({operation: registration.operation.ref, revision: registration.operation.resultSchemaRevision,
    validateOutput(result: OperationResult) {
      if (result.status !== "succeeded" && result.status !== "partial") return result.output === null ||
        (kind === "edit" || kind === "write") && isFileFailureSupport(result.output);
      const value = result.output;
      if (!record(value)) return false;
      switch (kind) {
        case "read": return baseline(value) && typeof value.content === "string" && count(value.start_line, 1) &&
          count(value.end_line) && count(value.total_lines) && typeof value.truncated === "boolean" &&
          value.start_line <= value.total_lines + 1 && value.end_line <= value.total_lines &&
          (value.end_line === 0 ? value.start_line === value.total_lines + 1 : value.end_line >= value.start_line) &&
          (value.end_line > 0 && value.end_line < value.total_lines
            ? value.next_offset === value.end_line + 1 && value.truncated === true : value.next_offset === null);
        case "glob": return strings(value.matches) && coverage(value);
        case "grep": return coverage(value) && Array.isArray(value.entries) &&
          ["content", "files_with_matches", "count"].includes(value.output_mode as string) && value.entries.every(entry =>
            record(entry) && text(entry.file_path) && (value.output_mode === "files_with_matches" ||
              (value.output_mode === "count" ? count(entry.count) : count(entry.line, 1) && count(entry.column, 1) &&
                typeof entry.text === "string" && strings(entry.before) && strings(entry.after))));
        case "edit": return target(value) && value.operation === "updated" && count(value.replacement_count, 1) &&
          baseline(value.previous_baseline) && baseline(value.current_baseline);
        case "write": return target(value) && ["created", "replaced"].includes(value.operation as string) &&
          (value.operation === "created" ? value.previous_baseline === null : baseline(value.previous_baseline)) && baseline(value.current_baseline);
      }
    },
  });
}

export function isFileFailureSupport(value: unknown): boolean {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.file_support) ||
      value.file_support.after !== null || !record(value.file_support.material)) return false;
  const material = value.file_support.material;
  try {snapshotExecutionEvidenceRef(material.ref as never, "material");} catch {return false;}
  return count(material.byteLength) && ["available", "not_captured", "unsupported", "expired", "inaccessible", "incomplete"].includes(material.availability as string);
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum; }
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function target(value: Record<string, unknown>): boolean { return text(value.target_id) && text(value.file_path); }
function baseline(value: unknown): boolean { return record(value) && target(value) && count(value.byte_length) && text(value.content_digest); }
function coverage(value: Record<string, unknown>): boolean {
  const scan = value.scan;
  return typeof value.truncated === "boolean" && record(scan) && typeof scan.complete === "boolean" &&
    count(scan.entries_visited) && count(scan.files_searched) && count(scan.bytes_read) && count(scan.skipped_count) &&
    typeof scan.skipped_details_truncated === "boolean" && (scan.stop_reason === null || text(scan.stop_reason)) &&
    Array.isArray(scan.skipped) && scan.skipped.length <= 32 && scan.skipped.length <= scan.skipped_count &&
    scan.files_searched <= scan.entries_visited && scan.skipped_details_truncated === (scan.skipped.length < scan.skipped_count) &&
    scan.skipped.every(item => record(item) && text(item.file_path) && text(item.reason)) &&
    (scan.complete ? count(value.omitted_count) && value.truncated === (value.omitted_count > 0) && scan.skipped_count === 0 && scan.stop_reason === null :
      value.omitted_count === null && value.truncated === true && (scan.skipped_count > 0 || scan.stop_reason !== null));
}
