import type { ModelCallRef } from "@agent-anything/model-interaction";
import type { ContextProjection, ProjectionManifest } from "@agent-anything/context/projection";
import type { ActiveContext } from "@agent-anything/context/active-context";
import type { CompositeDefinitionRevision } from "@agent-anything/operation-composition/definition";
import type { CompositeExecutionSnapshot } from "@agent-anything/operation-composition/execution";
import type { DelegationResult } from "../delegation/index.js";
import type { RunResult } from "../run/index.js";
import type { CurrentTurnToolExposure, ToolExposureProof } from "@agent-anything/tools/selection";
import type { ToolRevisionRef } from "@agent-anything/tools/identity";
import type { ControllerDecision } from "../controller/Controller.js";

export type RunExecutionObservation = {
  readonly runId: string;
  readonly occurredAt: string | null;
} & (
  | { readonly kind: "scheduling"; readonly call: ModelCallRef; readonly position: number;
      readonly disposition: "admitted" | "rejected" | "queued" | "dispatched"; readonly rule: string; readonly groupId: string | null; readonly reason: string | null }
  | { readonly kind: "context_projection"; readonly projection: ContextProjection | null; readonly manifest: ProjectionManifest }
  | { readonly kind: "context_committed"; readonly context: ActiveContext }
  | { readonly kind: "context_source"; readonly source: import("@agent-anything/context/contribution").ContextContribution["source"]; readonly value: unknown }
  | { readonly kind: "descendant_result"; readonly parentRunActionId: string; readonly raw: RunResult; readonly projected: DelegationResult }
  | { readonly kind: "composite"; readonly parentRunActionId: string; readonly definition: CompositeDefinitionRevision; readonly snapshot: CompositeExecutionSnapshot }
  | { readonly kind: "tool_exposure"; readonly turnId: string; readonly exposure: CurrentTurnToolExposure; readonly proof: ToolExposureProof; readonly selected: readonly ToolRevisionRef[] }
  | { readonly kind: "controller_decision"; readonly turnId: string; readonly basisRevision: number; readonly decision: ControllerDecision }
  | { readonly kind: "retry_event"; readonly event: import("../retry/index.js").RetryEvent }
  | { readonly kind: "run_input"; readonly input: import("@agent-anything/agent-core/input").RunInput;
      readonly configuration: Pick<import("./RunConfig.js").RunConfig, "limits" | "cancellationLimits" | "audit" | "telemetry"> }
  | { readonly kind: "operation_result"; readonly invocationId: string; readonly result: import("@agent-anything/operation-catalog/result").OperationResult }
  | { readonly kind: "operation_request"; readonly invocationId: string; readonly parentRunActionId: string;
      readonly operation: import("@agent-anything/operation-catalog/identity").OperationRevisionRef; readonly request: unknown; readonly requestOrigin: string }
  | { readonly kind: "operation_binding"; readonly invocationId: string; readonly resolution: import("@agent-anything/operation-catalog/binding").OperationBindingResolution }
);
export interface RunExecutionObserver { observe(observation: RunExecutionObservation): void }
export function publishRunExecutionObservation(observer: RunExecutionObserver | undefined, observation: RunExecutionObservation): void {
  if (!observer) return;
  try {
    const timed = observation.occurredAt === null && (observation.kind === "scheduling" || observation.kind === "tool_exposure")
      ? {...observation, occurredAt: new Date().toISOString()} : observation;
    void Promise.resolve(observer.observe(Object.freeze(timed))).catch(() => {});
  } catch { /* Observation has no execution authority. */ }
}
