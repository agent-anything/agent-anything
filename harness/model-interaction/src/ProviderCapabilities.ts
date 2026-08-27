import type { ModelInputCapability } from "./input/index.js";
import type { ModelContinuationCapability } from "./continuation/index.js";
import { strictRecord } from "./ModelInteractionContractValidation.js";
import { snapshotModelInputCapability } from "./input/index.js";
import { snapshotModelContinuationCapability } from "./continuation/index.js";

export interface ProviderDescriptor {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
  requestRetryScheduler: RetrySchedulerOwnership;
  metadata: Readonly<Record<string, unknown>>;
}

export type RetrySchedulerOwnership =
  | { readonly kind: "harness" }
  | {
      readonly kind: "sdk";
      readonly sdkName: string;
      readonly maxAttempts: number;
      readonly exposesAttemptEvents: boolean;
      readonly supportsCancellation: boolean;
    };

export interface ProviderCapabilities {
  readonly nativeToolInteraction: ProviderNativeToolInteractionCapability;
  readonly structuredGeneration: ProviderMechanicCapability;
  readonly streaming: ProviderMechanicCapability;
  readonly modelInput: ModelInputCapability;
  readonly continuation: ModelContinuationCapability;
  readonly compaction: ProviderMechanicCapability;
}

export type ProviderMechanicCapability =
  | { readonly supported: false }
  | { readonly supported: true };

export type ProviderNativeToolInteractionCapability =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly callableDefinitions: true;
      readonly modelCalls: true;
      readonly resultMessages: true;
      readonly multipleCalls: boolean;
      readonly callCorrelation: "provider_supplied" | "adapter_assigned";
    };

export function snapshotProviderCapabilities(
  input: ProviderCapabilities,
): ProviderCapabilities {
  strictRecord(input, "ProviderCapabilities", [
    "nativeToolInteraction", "structuredGeneration", "streaming",
    "modelInput", "continuation", "compaction",
  ]);
  return Object.freeze({
    nativeToolInteraction: snapshotNativeToolCapability(input.nativeToolInteraction),
    structuredGeneration: snapshotMechanicCapability(
      input.structuredGeneration,
      "ProviderCapabilities.structuredGeneration",
    ),
    streaming: snapshotMechanicCapability(
      input.streaming,
      "ProviderCapabilities.streaming",
    ),
    modelInput: snapshotModelInputCapability(input.modelInput),
    continuation: snapshotModelContinuationCapability(input.continuation),
    compaction: snapshotMechanicCapability(
      input.compaction,
      "ProviderCapabilities.compaction",
    ),
  });
}

function snapshotNativeToolCapability(
  input: ProviderNativeToolInteractionCapability,
): ProviderNativeToolInteractionCapability {
  strictRecord(input, "ProviderCapabilities.nativeToolInteraction", [
    "supported", "callableDefinitions", "modelCalls", "resultMessages",
    "multipleCalls", "callCorrelation",
  ]);
  if (input.supported === false) {
    strictRecord(input, "ProviderCapabilities.nativeToolInteraction", ["supported"]);
    return Object.freeze({ supported: false });
  }
  if (
    input.supported !== true ||
    input.callableDefinitions !== true ||
    input.modelCalls !== true ||
    input.resultMessages !== true ||
    typeof input.multipleCalls !== "boolean" ||
    (input.callCorrelation !== "provider_supplied" &&
      input.callCorrelation !== "adapter_assigned")
  ) {
    throw new TypeError("Provider native Tool interaction capability is invalid.");
  }
  return Object.freeze({
    supported: true,
    callableDefinitions: true,
    modelCalls: true,
    resultMessages: true,
    multipleCalls: input.multipleCalls,
    callCorrelation: input.callCorrelation,
  });
}

function snapshotMechanicCapability(
  input: ProviderMechanicCapability,
  path: string,
): ProviderMechanicCapability {
  strictRecord(input, path, ["supported"]);
  if (typeof input.supported !== "boolean") {
    throw new TypeError(`${path}.supported must be boolean.`);
  }
  return Object.freeze({ supported: input.supported });
}
