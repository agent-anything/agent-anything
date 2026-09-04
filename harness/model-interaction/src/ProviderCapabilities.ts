import type {
  ModelContextCapacity,
  ProviderInputPreservationConformance,
  ProviderRequestedOutput,
} from "./context/index.js";
import type { ModelContinuationCapability } from "./continuation/index.js";
import { strictRecord } from "./ModelInteractionContractValidation.js";
import {
  snapshotModelContextCapacity,
  snapshotProviderInputPreservationConformance,
  snapshotProviderRequestedOutput,
} from "./context/index.js";
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
  readonly modelContext: ProviderModelContextCapability;
  readonly continuation: ModelContinuationCapability;
  readonly compaction: ProviderMechanicCapability;
  readonly usageMetering: ProviderUsageMeteringCapability;
}

export interface ProviderModelContextCapability {
  readonly capacity: ModelContextCapacity;
  readonly requestedOutput: ProviderRequestedOutput;
  readonly inputPreservation: ProviderInputPreservationConformance;
}

export type ProviderUsageMeteringQualification =
  | "measured"
  | "conservatively_bounded"
  | "unavailable"
  | "not_applicable";

export interface ProviderUsageMeteringCapability {
  readonly inputTokens: ProviderUsageMeteringQualification;
  readonly outputTokens: ProviderUsageMeteringQualification;
  readonly costUnits: ProviderUsageMeteringQualification;
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
    "modelContext", "continuation", "compaction",
    "usageMetering",
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
    modelContext: snapshotModelContextCapability(input.modelContext),
    continuation: snapshotModelContinuationCapability(input.continuation),
    compaction: snapshotMechanicCapability(
      input.compaction,
      "ProviderCapabilities.compaction",
    ),
    usageMetering: snapshotUsageMetering(input.usageMetering),
  });
}

function snapshotModelContextCapability(
  input: ProviderModelContextCapability,
): ProviderModelContextCapability {
  return Object.freeze({
    capacity: snapshotModelContextCapacity(input.capacity),
    requestedOutput: snapshotProviderRequestedOutput(input.requestedOutput),
    inputPreservation: snapshotProviderInputPreservationConformance(input.inputPreservation),
  });
}

function snapshotUsageMetering(
  input: ProviderUsageMeteringCapability,
): ProviderUsageMeteringCapability {
  strictRecord(input, "ProviderCapabilities.usageMetering", [
    "inputTokens", "outputTokens", "costUnits",
  ]);
  return Object.freeze({
    inputTokens: usageQualification(input.inputTokens, "inputTokens"),
    outputTokens: usageQualification(input.outputTokens, "outputTokens"),
    costUnits: usageQualification(input.costUnits, "costUnits"),
  });
}

function usageQualification(
  input: ProviderUsageMeteringQualification,
  field: string,
): ProviderUsageMeteringQualification {
  if (
    input !== "measured" && input !== "conservatively_bounded" &&
    input !== "unavailable" && input !== "not_applicable"
  ) {
    throw new TypeError(`Provider usage metering ${field} is invalid.`);
  }
  return input;
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
