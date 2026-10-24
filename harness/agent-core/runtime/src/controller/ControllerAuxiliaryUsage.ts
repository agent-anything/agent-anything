import {snapshotProviderUsage, type ProviderUsage} from "@agent-anything/model-interaction";

export interface ControllerAuxiliaryUsage {
  readonly attemptId: string;
  readonly requestId: string;
  readonly purpose: "context_generation" | "context_assessment";
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly usage: ProviderUsage | null;
}

export function snapshotControllerAuxiliaryUsage(value: ControllerAuxiliaryUsage): ControllerAuxiliaryUsage {
  if (!value || Object.keys(value).some(key => !["attemptId", "requestId", "purpose", "outcome", "usage"].includes(key)) ||
      ![value.attemptId, value.requestId].every(id => typeof id === "string" && id.length > 0) ||
      !["context_generation", "context_assessment"].includes(value.purpose) ||
      !["succeeded", "failed", "cancelled"].includes(value.outcome)) throw new TypeError("Invalid auxiliary usage record.");
  return Object.freeze({...value, usage: snapshotProviderUsage(value.usage)});
}

export const AUXILIARY_USAGE_KEY = "controller-auxiliary-usage.v1:";

/** The runtime owns this namespace; arbitrary Controller checkpoint values are not usage. */
export function controllerAuxiliaryUsage(entries: readonly (readonly [string, unknown])[], runId: string): readonly ControllerAuxiliaryUsage[] {
  return entries.flatMap(([key, value]) => {
    const identity = JSON.parse(key) as readonly string[];
    if (identity[0] !== runId || identity[1] !== "run" || !identity[2]?.startsWith(AUXILIARY_USAGE_KEY)) return [];
    const record = snapshotControllerAuxiliaryUsage(value as ControllerAuxiliaryUsage);
    if (identity[2] !== `${AUXILIARY_USAGE_KEY}${record.attemptId}`) throw new TypeError("Auxiliary usage identity changed.");
    return [record];
  });
}
