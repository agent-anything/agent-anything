import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry, type ActivityPurposeBinding} from "../activity/ActivityPurpose.js";
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
  readonly version: 2;
  readonly id: string;
  readonly runId: string;
  readonly activityId: string;
  readonly purpose: string;
  readonly owner: ModelActivityOwner;
  readonly contract: ActivityPurposeBinding;
}
const purposes = new ActivityPurposeRegistry<ModelActivityOwner["kind"]>();
const contracts = new Map<ModelActivityOwner["kind"], ActivityPurposeBinding>();
for (const kind of ["task_decision", "context_generation", "context_assessment", "agent_extension"] as const) {
  contracts.set(kind,purposes.register({ref:{id:kind,revision:"1"},inputOwner:kind === "task_decision" ? "context_representation" : "activity",
    executionOwner:"model_access",interpretationOwner:kind,acceptanceOwner:kind,recoveryOwner:kind,
    stageKinds:["model_request"],capabilities:["model_request"],continuationKinds:["stage_request"]},kind));
}
export function createModelActivityBinding(input: Omit<ModelActivityBinding, "version" | "id" | "contract">): ModelActivityBinding {
  for (const value of [input.runId, input.activityId, input.purpose]) {
    if (typeof value !== "string" || value.trim().length === 0)
      throw new TypeError("Model activity identity is required.");
  }
  if (input.owner.kind === "task_decision" ? input.owner.inputOwner !== "context_representation"
    : !["context_generation", "context_assessment", "agent_extension"].includes(input.owner.kind) || input.owner.inputOwner !== "activity") {
    throw new TypeError("Model activity input ownership does not match its purpose.");
  }
  const value = {
    version: 2 as const, runId: input.runId, activityId: input.activityId,
    purpose: input.purpose, owner: Object.freeze({ ...input.owner }), contract: structuredClone(contracts.get(input.owner.kind)!)
  };
  return Object.freeze({ ...value, id: `model-activity:${modelInputValueDigest(value)}` });
}
export function assertModelActivityRequest(binding: ModelActivityBinding, request: ProviderRequest): void {
  const expected = createModelActivityBinding(binding);
  if (binding.version !== 2 || binding.id !== expected.id || purposes.resolve(binding.contract) !== binding.owner.kind || request.purpose !== binding.purpose ||
    request.composition.workingView.recipientRunId !== null && request.composition.workingView.recipientRunId !== binding.runId) {
    throw new TypeError("Model request does not match its accepted activity binding.");
  }
  const auxiliary = request.composition.lineage.auxiliary;
  if (binding.owner.kind === "task_decision" ? !!auxiliary
    : binding.owner.kind === "agent_extension" ? !!auxiliary : auxiliary?.purpose !== binding.owner.kind) {
    throw new TypeError("Model request crosses an activity interpretation boundary.");
  }
}
