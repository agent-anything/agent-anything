import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { ToolDescriptor } from "../catalog/index.js";
import { toolRevisionKey, type ToolRevisionRef } from "../identity/index.js";

const TOOL_INPUT_DIALECT = "json-schema-2020-12";
const MAX_ISSUES = 8;
const MAX_ISSUE_TEXT = 512;
const MAX_CORRECTION_TEXT = 4_096;

export type ToolInputIssueReason =
  | "required"
  | "unexpected"
  | "type"
  | "enum"
  | "const"
  | "constraint";

export type ToolInputValueCategory =
  | "missing"
  | "null"
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean";

export interface ToolInputIssue {
  readonly path: string;
  readonly reason: ToolInputIssueReason;
  readonly expected: string;
  readonly received: ToolInputValueCategory;
  readonly hint: string | null;
}

export interface ToolInputValidationFailure {
  readonly code: "tool_input_invalid";
  readonly issues: readonly ToolInputIssue[];
  readonly omittedIssueCount: number;
}

export type ToolInputSemanticValidation =
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly issues: readonly ToolInputIssue[] };

export interface ToolInputSemanticValidator<TInput = unknown> {
  readonly ref: {
    readonly id: string;
    readonly revision: string;
  };
  readonly tool: ToolRevisionRef;
  validate(input: TInput): ToolInputSemanticValidation;
}

export type ToolInputValidation =
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly failure: ToolInputValidationFailure; readonly message: string };

export class ToolInputSchemaAdmissionError extends TypeError {
  constructor(
    readonly code:
      | "tool_schema_dialect_unsupported"
      | "tool_input_schema_invalid"
      | "tool_input_schema_unbuildable",
    message: string,
  ) {
    super(message);
    this.name = "ToolInputSchemaAdmissionError";
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictSchema: true,
  validateFormats: false,
  allowUnionTypes: false,
});
const validators = new Map<string, ValidateFunction>();

export function admitToolInputSchema(descriptor: ToolDescriptor): void {
  validatorFor(descriptor);
}

export function validateToolInput(input: {
  readonly descriptor: ToolDescriptor;
  readonly value: unknown;
  readonly semanticValidators?: readonly ToolInputSemanticValidator[];
}): ToolInputValidation {
  const validate = validatorFor(input.descriptor);
  if (!(validate(input.value) as boolean)) {
    return invalidValidation(normalizeAjvIssues(validate.errors ?? [], input.value));
  }
  const semantic = input.semanticValidators?.find((candidate) =>
    toolRevisionKey(candidate.tool) === toolRevisionKey(input.descriptor.ref)
  );
  if (semantic === undefined) return Object.freeze({ status: "valid" as const });
  const result = semantic.validate(input.value);
  if (result.status === "valid") return Object.freeze({ status: "valid" as const });
  return invalidValidation(normalizeSemanticIssues(result.issues));
}

export function formatToolInputValidationFailure(
  failure: ToolInputValidationFailure,
): string {
  const details = failure.issues.map((issue) => {
    const location = issue.path.length === 0 ? "/" : issue.path;
    const hint = issue.hint === null ? "" : ` ${issue.hint}`;
    return `${location}: ${issue.reason}; expected ${issue.expected}; received ${issue.received}.${hint}`;
  });
  if (failure.omittedIssueCount > 0) {
    details.push(`${failure.omittedIssueCount} additional issue(s) omitted.`);
  }
  return bounded(
    `The Tool input is invalid. Correct the listed fields and submit a new Tool call. ${details.join(" ")}`,
    MAX_CORRECTION_TEXT,
  );
}

function validatorFor(descriptor: ToolDescriptor): ValidateFunction {
  if (descriptor.schemaRevisions.dialect !== TOOL_INPUT_DIALECT) {
    throw new ToolInputSchemaAdmissionError(
      "tool_schema_dialect_unsupported",
      `Tool '${descriptor.name}' must declare ${TOOL_INPUT_DIALECT}.`,
    );
  }
  const key = [
    toolRevisionKey(descriptor.ref),
    descriptor.schemaRevisions.input,
    descriptor.fingerprint,
  ].join("\u0000");
  const cached = validators.get(key);
  if (cached !== undefined) return cached;
  try {
    const validate = ajv.compile(descriptor.inputSchema);
    validators.set(key, validate);
    return validate;
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON Schema compiler failed.";
    throw new ToolInputSchemaAdmissionError(
      message.includes("schema is invalid")
        ? "tool_input_schema_invalid"
        : "tool_input_schema_unbuildable",
      `Tool '${descriptor.name}' input schema could not be admitted: ${bounded(message, MAX_ISSUE_TEXT)}`,
    );
  }
}

function normalizeAjvIssues(
  errors: readonly ErrorObject[],
  input: unknown,
): readonly ToolInputIssue[] {
  return errors.map((error) => {
    const keyword = error.keyword;
    const path = errorPath(error);
    const reason = issueReason(keyword);
    return snapshotIssue({
      path,
      reason,
      expected: expectedForm(error),
      received: keyword === "required" ? "missing" : valueCategory(valueAtPointer(input, path)),
      hint: correctionHint(error),
    });
  }).sort(compareIssues);
}

function normalizeSemanticIssues(
  issues: readonly ToolInputIssue[],
): readonly ToolInputIssue[] {
  if (!Array.isArray(issues) || issues.length === 0) {
    throw new TypeError("Invalid semantic Tool input requires at least one issue.");
  }
  return issues.map(snapshotIssue).sort(compareIssues);
}

function invalidValidation(issues: readonly ToolInputIssue[]): ToolInputValidation {
  const selected = Object.freeze(issues.slice(0, MAX_ISSUES));
  const failure = Object.freeze({
    code: "tool_input_invalid" as const,
    issues: selected,
    omittedIssueCount: Math.max(0, issues.length - selected.length),
  });
  return Object.freeze({
    status: "invalid" as const,
    failure,
    message: formatToolInputValidationFailure(failure),
  });
}

function errorPath(error: ErrorObject): string {
  if (error.keyword === "required") {
    return `${error.instancePath}/${escapePointer(String(error.params.missingProperty))}`;
  }
  if (error.keyword === "additionalProperties") {
    return `${error.instancePath}/${escapePointer(String(error.params.additionalProperty))}`;
  }
  return error.instancePath;
}

function issueReason(keyword: string): ToolInputIssueReason {
  if (keyword === "required") return "required";
  if (keyword === "additionalProperties" || keyword === "unevaluatedProperties") return "unexpected";
  if (keyword === "type") return "type";
  if (keyword === "enum") return "enum";
  if (keyword === "const") return "const";
  return "constraint";
}

function expectedForm(error: ErrorObject): string {
  switch (error.keyword) {
    case "required":
      return "a required field";
    case "additionalProperties":
    case "unevaluatedProperties":
      return "no undeclared field";
    case "type":
      return bounded(String(error.params.type), MAX_ISSUE_TEXT);
    case "enum":
      return "one declared enum member";
    case "const":
      return "the declared constant";
    case "minLength":
      return `a string with at least ${String(error.params.limit)} characters`;
    case "maxLength":
      return `a string with at most ${String(error.params.limit)} characters`;
    case "minimum":
      return `a number greater than or equal to ${String(error.params.limit)}`;
    case "maximum":
      return `a number less than or equal to ${String(error.params.limit)}`;
    case "minItems":
      return `an array with at least ${String(error.params.limit)} items`;
    case "maxItems":
      return `an array with at most ${String(error.params.limit)} items`;
    default:
      return bounded(`the declared ${error.keyword} constraint`, MAX_ISSUE_TEXT);
  }
}

function correctionHint(error: ErrorObject): string | null {
  if (error.keyword === "required") return "Add this field.";
  if (error.keyword === "additionalProperties" || error.keyword === "unevaluatedProperties") {
    return "Remove this field or use the supported Tool operation for that intent.";
  }
  return "Correct this field and retry in a later Controller turn.";
}

function snapshotIssue(issue: ToolInputIssue): ToolInputIssue {
  if (!isJsonPointer(issue.path)) throw new TypeError("Tool input issue path must be a JSON Pointer.");
  if (!isIssueReason(issue.reason)) throw new TypeError("Tool input issue reason is invalid.");
  if (!isValueCategory(issue.received)) throw new TypeError("Tool input issue value category is invalid.");
  return Object.freeze({
    path: issue.path,
    reason: issue.reason,
    expected: boundedNonEmpty(issue.expected, MAX_ISSUE_TEXT),
    received: issue.received,
    hint: issue.hint === null ? null : boundedNonEmpty(issue.hint, MAX_ISSUE_TEXT),
  });
}

function compareIssues(left: ToolInputIssue, right: ToolInputIssue): number {
  return left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason);
}

function valueAtPointer(input: unknown, pointer: string): unknown {
  if (pointer.length === 0) return input;
  let current = input;
  for (const segment of pointer.slice(1).split("/").map(unescapePointer)) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function valueCategory(value: unknown): ToolInputValueCategory {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

function isJsonPointer(value: unknown): value is string {
  return typeof value === "string" && (value.length === 0 || value.startsWith("/"));
}

function isIssueReason(value: unknown): value is ToolInputIssueReason {
  return value === "required" || value === "unexpected" || value === "type" ||
    value === "enum" || value === "const" || value === "constraint";
}

function isValueCategory(value: unknown): value is ToolInputValueCategory {
  return value === "missing" || value === "null" || value === "object" ||
    value === "array" || value === "string" || value === "integer" ||
    value === "number" || value === "boolean";
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function boundedNonEmpty(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Tool input issue text must be non-empty.");
  }
  return bounded(value.trim(), maximum);
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}
