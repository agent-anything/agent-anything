import type { ModelCallRef } from "@agent-anything/model-interaction";
import type { ContextProjection, ProjectionManifest } from "@agent-anything/context/projection";
import type { ActiveContext } from "@agent-anything/context/active-context";
import type { CompositeDefinitionRevision } from "@agent-anything/operation-composition/definition";
import type { CompositeExecutionSnapshot } from "@agent-anything/operation-composition/execution";
import type { DelegationResult } from "../delegation/index.js";
import type { RunResult } from "../run/index.js";
import type { CurrentTurnToolExposure, ToolExposureProof } from "@agent-anything/tools/selection";
import type { ToolRevisionRef } from "@agent-anything/tools/identity";

export type RunExecutionObservation = {
  readonly runId: string;
  readonly occurredAt: string | null;
} & (
  | { readonly kind: "scheduling"; readonly call: ModelCallRef; readonly position: number;
      readonly disposition: "admitted" | "rejected" | "queued" | "dispatched"; readonly rule: string; readonly groupId: string | null; readonly reason: string | null }
  | { readonly kind: "context_projection"; readonly projection: ContextProjection | null; readonly manifest: ProjectionManifest }
  | { readonly kind: "context_committed"; readonly context: ActiveContext }
  | { readonly kind: "descendant_result"; readonly parentRunActionId: string; readonly raw: RunResult; readonly projected: DelegationResult }
  | { readonly kind: "composite"; readonly parentRunActionId: string; readonly definition: CompositeDefinitionRevision; readonly snapshot: CompositeExecutionSnapshot }
  | { readonly kind: "tool_exposure"; readonly turnId: string; readonly exposure: CurrentTurnToolExposure; readonly proof: ToolExposureProof; readonly selected: readonly ToolRevisionRef[] }
);
export interface RunExecutionObserver { observe(observation: RunExecutionObservation): void }
export function publishRunExecutionObservation(observer: RunExecutionObserver | undefined, observation: RunExecutionObservation): void {
  if (!observer) return;
  try { void Promise.resolve(observer.observe(Object.freeze(observation))).catch(() => {}); } catch { /* Observation has no execution authority. */ }
}
