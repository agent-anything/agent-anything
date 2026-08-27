import {
  modelCallableDefinitionsContentDigest,
  snapshotModelCallableDefinitions,
  type ModelCallableDefinition,
} from "./ModelCallableDefinition.js";
import {
  snapshotModelOutputFormat,
  type StructuredOutputFormat,
} from "./ModelOutputFormat.js";
import { strictRecord } from "./ModelInteractionContractValidation.js";

export type ProviderInteraction =
  | {
      readonly kind: "native_tool_turn";
      readonly callables: readonly ModelCallableDefinition[];
      readonly callableContentDigest: string;
    }
  | {
      readonly kind: "structured_generation";
      readonly outputFormat: StructuredOutputFormat;
    }
  | {
      readonly kind: "text_generation";
    };

export function createNativeToolTurnInteraction(
  callables: readonly ModelCallableDefinition[],
): Extract<ProviderInteraction, { readonly kind: "native_tool_turn" }> {
  const snapshot = snapshotModelCallableDefinitions(callables);
  return Object.freeze({
    kind: "native_tool_turn",
    callables: snapshot,
    callableContentDigest: modelCallableDefinitionsContentDigest(snapshot),
  });
}

export function snapshotProviderInteraction(
  input: ProviderInteraction,
): ProviderInteraction {
  strictRecord(input as unknown, "ProviderInteraction", [
    "kind", "callables", "callableContentDigest", "outputFormat",
  ]);
  if (input.kind === "text_generation") {
    strictRecord(input as unknown, "ProviderInteraction", ["kind"]);
    return Object.freeze({ kind: "text_generation" });
  }
  if (input.kind === "structured_generation") {
    strictRecord(input as unknown, "ProviderInteraction", ["kind", "outputFormat"]);
    const outputFormat = snapshotModelOutputFormat(input.outputFormat);
    if (outputFormat.kind !== "json_schema") {
      throw new TypeError("Structured generation requires a JSON Schema output format.");
    }
    return Object.freeze({ kind: "structured_generation", outputFormat });
  }
  if (input.kind === "native_tool_turn") {
    strictRecord(input as unknown, "ProviderInteraction", [
      "kind", "callables", "callableContentDigest",
    ]);
    const callables = snapshotModelCallableDefinitions(input.callables);
    const digest = modelCallableDefinitionsContentDigest(callables);
    if (input.callableContentDigest !== digest) {
      throw new TypeError("Native Tool callable content digest is inconsistent.");
    }
    return Object.freeze({
      kind: "native_tool_turn",
      callables,
      callableContentDigest: digest,
    });
  }
  throw new TypeError("ProviderInteraction.kind is unsupported.");
}

export function providerInteractionsEqual(
  left: ProviderInteraction,
  right: ProviderInteraction,
): boolean {
  return JSON.stringify(snapshotProviderInteraction(left)) ===
    JSON.stringify(snapshotProviderInteraction(right));
}
