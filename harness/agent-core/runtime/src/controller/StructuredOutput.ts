export type StructuredOutputFailureCategory =
  | "structured_output_syntax"
  | "structured_output_schema"
  | "structured_output_semantic"
  | "agent_output_contract"
  | "structured_output_size";

export interface StructuredOutputFailure {
  readonly category: StructuredOutputFailureCategory;
  readonly code: string;
  readonly correctionFeedback: string;
}

export interface ProviderRequestBuildContext {
  readonly attemptNumber: number;
  readonly correction: StructuredOutputCorrection | null;
}

export interface StructuredOutputCorrection {
  readonly previousAttemptNumber: number;
  readonly failure: StructuredOutputFailure;
}

export class StructuredOutputError extends Error {
  readonly failure: StructuredOutputFailure;

  constructor(failure: StructuredOutputFailure) {
    const snapshot = snapshotStructuredOutputFailure(failure);
    super(snapshot.correctionFeedback);
    this.name = "StructuredOutputError";
    this.failure = snapshot;
  }
}

export function snapshotStructuredOutputFailure(
  failure: StructuredOutputFailure,
): StructuredOutputFailure {
  if (!isRecord(failure)) {
    throw new TypeError("StructuredOutputFailure must be an object.");
  }
  if (![
    "structured_output_syntax",
    "structured_output_schema",
    "structured_output_semantic",
    "agent_output_contract",
    "structured_output_size",
  ].includes(failure.category)) {
    throw new TypeError("StructuredOutputFailure.category is unsupported.");
  }
  const code = boundedText(failure.code, "StructuredOutputFailure.code", 128);
  const correctionFeedback = boundedText(
    failure.correctionFeedback,
    "StructuredOutputFailure.correctionFeedback",
    500,
  );
  return Object.freeze({
    category: failure.category,
    code,
    correctionFeedback,
  });
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TypeError(`${field} must not exceed ${maxLength} characters.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
