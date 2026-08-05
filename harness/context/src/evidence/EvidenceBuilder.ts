
import type { ToolResult } from "@agent-anything/tools";
import type { Evidence, EvidenceSensitivity } from "./Evidence.js";

export type EvidenceEligibleToolResult<TOutput = unknown> = Extract<
  ToolResult<TOutput>,
  { readonly status: "succeeded" | "partial" }
>;

export type ConservativeEvidenceSensitivity = Exclude<EvidenceSensitivity, "public">;

export interface EvidenceSensitivityPolicy {
  readonly unclassifiedSensitivity: ConservativeEvidenceSensitivity;
}

export interface BuildEvidenceInput {
  readonly toolResult: EvidenceEligibleToolResult;
  readonly id?: string;
  readonly summary?: string;
  readonly sensitivity?: EvidenceSensitivity;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EvidenceBuilderPort {
  buildFromToolResult(input: BuildEvidenceInput): readonly Evidence[];
}

export class EvidenceBuilder implements EvidenceBuilderPort {
  readonly #sensitivityPolicy: EvidenceSensitivityPolicy;

  constructor(
    sensitivityPolicy: EvidenceSensitivityPolicy = {
      unclassifiedSensitivity: "restricted",
    },
  ) {
    if (!isConservativeSensitivity(sensitivityPolicy?.unclassifiedSensitivity)) {
      throw new TypeError(
        "EvidenceSensitivityPolicy requires a conservative unclassified sensitivity.",
      );
    }
    this.#sensitivityPolicy = Object.freeze({
      unclassifiedSensitivity: sensitivityPolicy.unclassifiedSensitivity,
    });
  }

  buildFromToolResult(input: BuildEvidenceInput): readonly Evidence[] {
    const { toolResult } = input;
    const sensitivity = input.sensitivity === undefined
      ? this.#sensitivityPolicy.unclassifiedSensitivity
      : requireSensitivity(input.sensitivity);
    return Object.freeze([
      Object.freeze({
        id: input.id ?? createEvidenceId(toolResult),
        source: Object.freeze({
          kind: "toolResult" as const,
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          metadata: Object.freeze({ ...toolResult.metadata }),
        }),
        summary: input.summary ?? createSummary(toolResult),
        content: toolResult.output,
        sensitivity,
        metadata: Object.freeze({
          ...input.metadata,
          createdFrom: toolResult.toolCallId,
        }),
      }),
    ]);
  }
}

function createEvidenceId(toolResult: EvidenceEligibleToolResult): string {
  return `evidence_${toolResult.toolCallId}`;
}

function createSummary(toolResult: EvidenceEligibleToolResult): string {
  return toolResult.status === "partial"
    ? `Partial evidence from ${toolResult.toolName}.`
    : `Evidence from ${toolResult.toolName}.`;
}

function requireSensitivity(value: EvidenceSensitivity): EvidenceSensitivity {
  if (!isEvidenceSensitivity(value)) {
    throw new TypeError("BuildEvidenceInput.sensitivity is invalid.");
  }
  return value;
}

function isEvidenceSensitivity(value: unknown): value is EvidenceSensitivity {
  return (
    value === "public" ||
    value === "private" ||
    value === "secret" ||
    value === "restricted"
  );
}

function isConservativeSensitivity(
  value: unknown,
): value is ConservativeEvidenceSensitivity {
  return value === "private" || value === "secret" || value === "restricted";
}
