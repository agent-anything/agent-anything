import {
  snapshotModelJsonValue,
  type ModelJsonValue,
} from "@agent-anything/model-interaction";

export type StructuredGenerationDecodeResult =
  | {
      readonly kind: "decoded";
      readonly output: ModelJsonValue;
    }
  | {
      readonly kind: "failed";
      readonly causeName: string | null;
    };

export function decodeStructuredGenerationOutput(
  encoded: string,
): StructuredGenerationDecodeResult {
  try {
    return Object.freeze({
      kind: "decoded" as const,
      output: snapshotModelJsonValue(
        JSON.parse(encoded) as unknown,
        "Provider structured-generation output",
      ),
    });
  } catch (error) {
    return Object.freeze({
      kind: "failed" as const,
      causeName: error instanceof Error ? error.name : null,
    });
  }
}
