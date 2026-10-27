import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import type { ProviderRequest } from "@agent-anything/model-interaction";
export type ModelActivityOwner = {
  readonly kind: "task_decision";
  readonly inputOwner: "context_representation";
} | {
  readonly kind: "context_generation" | "context_assessment" | "agent_extension";
  readonly inputOwner: "activity";
};
/** Ownership comes from the accepted activity, never from model-generated text. */
export interface ModelActivityBinding {
  readonly version: 1;
  readonly id: string;
  readonly runId: string;
  readonly activityId: string;
  readonly purpose: string;
  readonly owner: ModelActivityOwner;
}
export function createModelActivityBinding(input: Omit<ModelActivityBinding, "version" | "id">): ModelActivityBinding {
  for (const value of [input.runId, input.activityId, input.purpose]) {
    if (typeof value !== "string" || value.trim().length === 0)
      throw new TypeError("Model activity identity is required.");
  }
  if (input.owner.kind === "task_decision" ? input.owner.inputOwner !== "context_representation"
    : !["context_generation", "context_assessment", "agent_extension"].includes(input.owner.kind) || input.owner.inputOwner !== "activity") {
    throw new TypeError("Model activity input ownership does not match its purpose.");
  }
  const value = {
    version: 1 as const, runId: input.runId, activityId: input.activityId,
    purpose: input.purpose, owner: Object.freeze({ ...input.owner })
  };
  return Object.freeze({ ...value, id: `model-activity:${modelInputValueDigest(value)}` });
}
export function assertModelActivityRequest(binding: ModelActivityBinding, request: ProviderRequest): void {
  const expected = createModelActivityBinding(binding);
  if (binding.version !== 1 || binding.id !== expected.id || request.purpose !== binding.purpose ||
    request.composition.workingView.recipientRunId !== null && request.composition.workingView.recipientRunId !== binding.runId) {
    throw new TypeError("Model request does not match its accepted activity binding.");
  }
  const auxiliary = request.composition.lineage.auxiliary;
  if (binding.owner.kind === "task_decision" ? !!auxiliary
    : binding.owner.kind === "agent_extension" ? !!auxiliary : auxiliary?.purpose !== binding.owner.kind) {
    throw new TypeError("Model request crosses an activity interpretation boundary.");
  }
}
