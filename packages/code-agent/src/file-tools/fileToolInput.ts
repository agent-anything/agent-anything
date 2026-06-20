import type {
  ListFilesInput,
  SearchFilesInput,
  WorkspaceFileInput,
  WriteFileInput,
} from "./FileToolContracts.js";
import { FileToolError } from "./FileToolError.js";

export function parseWorkspaceFileInput(input: unknown): WorkspaceFileInput {
  const value = requireRecord(input);
  return {
    path: requireString(value, "path"),
    ...readOptionalRootName(value),
  };
}

export function parseListFilesInput(input: unknown): ListFilesInput {
  const value = requireRecord(input);
  const recursive = value.recursive;
  if (recursive !== undefined && typeof recursive !== "boolean") {
    throw invalidInput("recursive", "must be a boolean");
  }
  return {
    path: requireString(value, "path"),
    ...readOptionalRootName(value),
    ...(recursive === undefined ? {} : { recursive }),
  };
}

export function parseSearchFilesInput(input: unknown): SearchFilesInput {
  const value = requireRecord(input);
  const query = requireString(value, "query");
  if (query.length === 0) {
    throw invalidInput("query", "must not be empty");
  }
  return {
    path: requireString(value, "path"),
    query,
    ...readOptionalRootName(value),
  };
}

export function parseWriteFileInput(input: unknown): WriteFileInput {
  const value = requireRecord(input);
  const overwrite = value.overwrite;
  if (overwrite !== undefined && typeof overwrite !== "boolean") {
    throw invalidInput("overwrite", "must be a boolean");
  }
  return {
    path: requireString(value, "path"),
    content: requireString(value, "content"),
    ...readOptionalRootName(value),
    ...(overwrite === undefined ? {} : { overwrite }),
  };
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FileToolError(
      "file_tool_invalid_input",
      "File tool input must be an object.",
    );
  }
  return input as Record<string, unknown>;
}

function requireString(
  input: Record<string, unknown>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw invalidInput(field, "must be a string");
  }
  return value;
}

function readOptionalRootName(
  input: Record<string, unknown>,
): { rootName?: string } {
  const rootName = input.rootName;
  if (rootName === undefined) {
    return {};
  }
  if (typeof rootName !== "string") {
    throw invalidInput("rootName", "must be a string");
  }
  return { rootName };
}

function invalidInput(field: string, rule: string): FileToolError {
  return new FileToolError(
    "file_tool_invalid_input",
    "File tool input field '" + field + "' " + rule + ".",
    { field },
  );
}
