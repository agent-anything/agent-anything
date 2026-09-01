import type { RuntimeEvent } from "@agent-anything/observability/events";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import type {
  RunFailureCause,
  RunResult,
  RunResultStatus,
} from "@agent-anything/agent-runtime/run";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import type {
  SandboxEnforcement,
} from "@agent-anything/action-execution/sandbox";
import { projectRuntimeEventForHost } from "@agent-anything/host/projection";
import type { HelarcAgentOutput } from "../controller/HelarcController.js";
import type { HelarcControllerTraceProjection } from "../observability/index.js";
import type { VerificationHostProjection, VerificationStateCount } from "@agent-anything/verification/projection";
import type {
  HelarcModelQualificationSafeProjection,
} from "../model-qualification/index.js";

export type HelarcProductStatus =
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

export interface HelarcActivityItem {
  readonly id: string;
  readonly sequence: number;
  readonly source: HelarcActivitySource;
  readonly timestamp: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface HelarcActivitySource {
  readonly runId: string;
  readonly eventSequence: number;
  readonly lineage: RunLineage;
}

export interface HelarcProductOutput {
  readonly taskId: string;
  readonly workspace: {
    readonly primaryId: string;
    readonly additionalIds: readonly string[];
  };
  readonly agentSummary: string | null;
  readonly runtimeStatus: RunResultStatus;
  readonly enforcement: HelarcEnforcementSummary;
  readonly safeErrors: readonly { readonly code: string; readonly message: string }[];
}

export interface HelarcRunResultSummary {
  readonly runId: string;
  readonly status: RunResultStatus;
  readonly code: RunResult<unknown>["code"];
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface HelarcEffectSummary {
  readonly operationInvocationId: string;
  readonly operationResultId: string;
  readonly semanticOwner: string;
  readonly status: OperationResult["status"];
  readonly bindingRevision: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly effectCertainty: string | null;
  readonly completionExtent: string | null;
  readonly lowerRefs: readonly {
    readonly owner: string;
    readonly kind: string;
    readonly id: string;
    readonly revision: string | null;
  }[];
}

export type HelarcRunActionSettlementStatus =
  | OperationResult["status"]
  | "applied"
  | "no_change"
  | "rejected"
  | "resolved"
  | "expired"
  | "invalidated"
  | "started";

export interface HelarcRunActionSummary {
  readonly runActionId: string;
  readonly sequence: number;
  readonly subjectKind: "state_transition" | "operation" | "tool" | "interaction" | "model_call_rejection";
  readonly operationInvocationId: string | null;
  readonly interactionRequestId: string | null;
  readonly status: HelarcRunActionSettlementStatus;
  readonly observationId: string | null;
}

export interface HelarcCanonicalActionSummary {
  readonly actionSettlementId: string;
  readonly actionSettlementRevision: string | null;
  readonly operationResultId: string;
  readonly status: OperationResult["status"];
  readonly effectCertainty: string | null;
  readonly completionExtent: string | null;
}

export interface HelarcCompositeWorkSummary {
  readonly compositeId: string;
  readonly operationResultId: string;
  readonly status: OperationResult["status"];
  readonly childCount: number;
  readonly settledChildCount: number;
  readonly unresolvedChildCount: number;
  readonly childOperationResultIds: readonly string[];
}

export interface HelarcChildWorkSummary {
  readonly refId: string;
  readonly owner: string;
  readonly status: OperationResult["status"];
}

export interface HelarcInteractionSummary {
  readonly observationId: string;
  readonly owner: string;
  readonly status: "resolved" | "expired" | "cancelled" | "invalidated" | "failed";
}

export interface HelarcVerificationCommunication {
  readonly status:
    | "not_required"
    | "pending"
    | "satisfied"
    | "attention_required"
    | "unavailable";
  readonly snapshotRevision: number | null;
  readonly counts: readonly VerificationStateCount[];
  readonly activeChecks: number;
  readonly gateStatus: NonNullable<VerificationHostProjection["gate"]>["status"] | null;
  readonly waiting: boolean;
  readonly recoveryNeeded: boolean;
  readonly safeReasons: readonly string[];
  readonly updatedAt: string | null;
}

export interface HelarcEnforcementSummary {
  readonly selected: SandboxEnforcement;
  readonly status:
    | "not_exercised"
    | "unisolated"
    | "enforced"
    | "unavailable"
    | "denied"
    | "interrupted"
    | "failed";
  readonly code: string | null;
}

export interface HelarcProductResult {
  readonly status: HelarcProductStatus;
  readonly qualification: HelarcModelQualificationSafeProjection;
  readonly runResult: HelarcRunResultSummary;
  readonly output: HelarcProductOutput;
  readonly runActions: readonly HelarcRunActionSummary[];
  readonly effects: readonly HelarcEffectSummary[];
  readonly actions: readonly HelarcCanonicalActionSummary[];
  readonly composites: readonly HelarcCompositeWorkSummary[];
  readonly children: readonly HelarcChildWorkSummary[];
  readonly interactions: readonly HelarcInteractionSummary[];
  readonly verification: HelarcVerificationCommunication;
  readonly uncertainty: readonly string[];
  readonly residualRisk: readonly string[];
  readonly incompleteWork: readonly string[];
  readonly nextActions: readonly string[];
  readonly artifactRefs: readonly string[];
}

export function projectHelarcProductResult(
  task: AgentTask,
  workspace: WorkspaceSelection,
  runResult: RunResult<HelarcAgentOutput>,
  selectedEnforcement: SandboxEnforcement,
  verification: VerificationHostProjection | null,
  qualification: HelarcModelQualificationSafeProjection,
): HelarcProductResult {
  const agentOutput = runResult.status === "succeeded" ? runResult.finalOutput : null;
  const safeErrors = collectSafeRunErrors(runResult);
  const effects = collectEffects(runResult);
  const runActions = collectRunActions(runResult);
  const actions = collectCanonicalActions(effects);
  const composites = collectComposites(runResult);
  const children = collectChildren(runResult, effects);
  const interactions = collectInteractions(runResult);
  const uncertainty = collectUncertainty(runResult, effects);
  const incompleteWork = collectIncompleteWork(runResult, effects, runActions, composites);

  return Object.freeze({
    status: mapRunStatus(runResult.status),
    qualification,
    runResult: Object.freeze({
      runId: runResult.runId,
      status: runResult.status,
      code: runResult.code,
      startedAt: runResult.startedAt,
      completedAt: runResult.completedAt,
    }),
    output: Object.freeze({
      taskId: task.id,
      workspace: Object.freeze({
        primaryId: workspace.primary.id,
        additionalIds: Object.freeze(workspace.additional.map(({ id }) => id)),
      }),
      agentSummary: agentOutput?.summary ?? null,
      runtimeStatus: runResult.status,
      enforcement: Object.freeze(createEnforcementSummary(runResult, selectedEnforcement)),
      safeErrors: Object.freeze(safeErrors.map((error) => Object.freeze({ ...error }))),
    }),
    runActions,
    effects,
    actions,
    composites,
    children,
    interactions,
    verification: projectVerificationCommunication(verification),
    uncertainty,
    residualRisk: Object.freeze(uncertainty.length === 0 ? [] : [
      "One or more effects could not be confirmed from the terminal Run record.",
    ]),
    incompleteWork,
    nextActions: Object.freeze(incompleteWork.length === 0 ? [] : [
      "Inspect the recorded failure or unresolved effect before continuing.",
    ]),
    artifactRefs: Object.freeze([...runResult.artifactRefs]),
  });
}

function projectVerificationCommunication(
  verification: VerificationHostProjection | null,
): HelarcVerificationCommunication {
  if (verification === null) {
    return Object.freeze({
      status: "unavailable" as const,
      snapshotRevision: null,
      counts: Object.freeze([]),
      activeChecks: 0,
      gateStatus: null,
      waiting: false,
      recoveryNeeded: false,
      safeReasons: Object.freeze(["verification_projection_unavailable"]),
      updatedAt: null,
    });
  }
  const count = (state: VerificationStateCount["state"]) =>
    verification.counts.find((entry) => entry.state === state)?.count ?? 0;
  const total = verification.counts.reduce((sum, entry) => sum + entry.count, 0);
  const status: HelarcVerificationCommunication["status"] = total === 0
    ? "not_required"
    : count("violated") > 0 || count("inconclusive") > 0 || count("stale") > 0
      ? "attention_required"
      : verification.waiting || verification.activeAttempts.length > 0 || count("pending") > 0
        ? "pending"
        : count("satisfied") > 0
          ? "satisfied"
          : verification.gate?.status === "completion_eligible"
            ? "not_required"
            : "pending";
  return Object.freeze({
    status,
    snapshotRevision: verification.snapshot.revision,
    counts: Object.freeze(verification.counts.map((entry) => Object.freeze({ ...entry }))),
    activeChecks: verification.activeAttempts.length,
    gateStatus: verification.gate?.status ?? null,
    waiting: verification.waiting,
    recoveryNeeded: verification.recoveryNeeded,
    safeReasons: Object.freeze([...verification.safeReasons]),
    updatedAt: verification.updatedAt,
  });
}

export function mapRuntimeEventToHelarcActivity(
  event: RuntimeEvent,
  activitySequence: number,
  controllerTrace: HelarcControllerTraceProjection | null = null,
): HelarcActivityItem {
  if (!Number.isSafeInteger(activitySequence) || activitySequence < 1) {
    throw new TypeError("Helarc activity sequence must be a positive integer.");
  }
  const projectedEvent = projectRuntimeEventForHost(event);
  const payload = isRecord(projectedEvent.payload) ? projectedEvent.payload : {};
  const metadata = Object.freeze({
    ...payload,
    ...controllerTraceMetadata(controllerTrace),
  });
  return Object.freeze({
    id: projectedEvent.id,
    sequence: activitySequence,
    source: Object.freeze({
      runId: projectedEvent.runId,
      eventSequence: projectedEvent.sequence,
      lineage: snapshotActivityLineage(projectedEvent.lineage),
    }),
    timestamp: projectedEvent.occurredAt,
    kind: projectedEvent.name,
    title: titleForEvent(projectedEvent.name, metadata),
    detail: detailForEvent(projectedEvent.name, metadata),
    metadata,
  });
}

function snapshotActivityLineage(lineage: RunLineage): RunLineage {
  if (lineage.kind === "root") {
    return Object.freeze({
      kind: "root" as const,
      root: Object.freeze({ id: lineage.root.id }),
      depth: 0 as const,
    });
  }
  return Object.freeze({
    kind: "descendant" as const,
    root: Object.freeze({ id: lineage.root.id }),
    parent: Object.freeze({ id: lineage.parent.id }),
    parentRunAction: Object.freeze({
      run: Object.freeze({ id: lineage.parentRunAction.run.id }),
      id: lineage.parentRunAction.id,
      sequence: lineage.parentRunAction.sequence,
    }),
    relation: Object.freeze({ id: lineage.relation.id }),
    depth: lineage.depth,
  });
}

function controllerTraceMetadata(
  trace: HelarcControllerTraceProjection | null,
): Readonly<Record<string, unknown>> {
  if (trace === null) return {};
  return {
    ...(trace.source === null ? {} : { source: trace.source }),
    ...(trace.controllerProtocol === null
      ? {}
      : { controllerProtocol: trace.controllerProtocol }),
    ...(trace.promptArchitectureVersion === null
      ? {}
      : { promptArchitectureVersion: trace.promptArchitectureVersion }),
    ...(trace.modelCallableCatalogRevision === null
      ? {}
      : { modelCallableCatalogRevision: trace.modelCallableCatalogRevision }),
    ...(trace.modelCallableDefinitionsDigest === null
      ? {}
      : { modelCallableDefinitionsDigest: trace.modelCallableDefinitionsDigest }),
    ...(trace.toolGuidanceId === null
      ? {}
      : { toolGuidanceId: trace.toolGuidanceId }),
    ...(trace.toolGuidanceContentDigest === null
      ? {}
      : { toolGuidanceContentDigest: trace.toolGuidanceContentDigest }),
    ...(trace.controllerControlGuidanceRevision === null
      ? {}
      : { controllerControlGuidanceRevision: trace.controllerControlGuidanceRevision }),
    ...(trace.modelTurnId === null ? {} : { modelTurnId: trace.modelTurnId }),
    ...(trace.modelFinishKind === null
      ? {}
      : { modelFinishKind: trace.modelFinishKind }),
    ...(trace.modelResponseId === null
      ? {}
      : { modelResponseId: trace.modelResponseId }),
    ...(trace.toolExposureVersion === null
      ? {}
      : { toolExposureVersion: trace.toolExposureVersion }),
    ...(trace.toolSelectionRevision === null
      ? {}
      : { toolSelectionRevision: trace.toolSelectionRevision }),
    ...(trace.toolExposureContentRevision === null
      ? {}
      : { toolExposureContentRevision: trace.toolExposureContentRevision }),
    ...(trace.toolExposureBasisRevision === null
      ? {}
      : { toolExposureBasisRevision: trace.toolExposureBasisRevision }),
    ...(trace.toolExposureProofId === null
      ? {}
      : { toolExposureProofId: trace.toolExposureProofId }),
    ...(trace.exposedToolCount === null
      ? {}
      : { exposedToolCount: trace.exposedToolCount }),
    ...(trace.omittedToolCount === null
      ? {}
      : { omittedToolCount: trace.omittedToolCount }),
    ...(trace.toolExposureOmissionReasons.length === 0
      ? {}
      : { toolExposureOmissionReasons: trace.toolExposureOmissionReasons }),
  };
}

function createEnforcementSummary(
  runResult: RunResult<HelarcAgentOutput>,
  selected: SandboxEnforcement,
): HelarcEnforcementSummary {
  const operation = [...runResult.items].reverse().find(
    (candidate) => candidate.payload.kind === "observation" &&
      candidate.payload.observation.payload.kind === "operation",
  );
  if (operation?.payload.kind !== "observation" ||
    operation.payload.observation.payload.kind !== "operation") {
    return { selected, status: "not_exercised", code: null };
  }
  const result = operation.payload.observation.payload.result;
  const status: HelarcEnforcementSummary["status"] = result.status === "succeeded" || result.status === "partial"
    ? selected === "disabled" ? "unisolated" : "enforced"
    : result.status === "denied" ? "denied"
      : result.status === "cancelled" ? "interrupted"
        : result.status === "unavailable" ? "unavailable"
          : "failed";
  return {
    selected,
    status,
    code: status === "unisolated" || status === "enforced"
      ? null
      : result.failure?.code ?? result.status,
  };
}

function collectSafeRunErrors(
  runResult: RunResult<HelarcAgentOutput>,
): Array<{ code: string; message: string }> {
  const errors: Array<{ code: string; message: string }> = [];
  if (runResult.failure !== null) {
    appendSafeRunFailure(errors, runResult.failure);
  }
  for (const failure of runResult.relatedFailures) {
    appendSafeRunFailure(errors, failure);
  }
  for (const item of runResult.items) {
    if (item.payload.kind !== "observation") continue;
    const payload = item.payload.observation.payload;
    if (payload.kind === "operation_rejected") appendSafeError(errors, payload.code);
    if (payload.kind === "operation" && payload.result.failure !== null) {
      appendSafeError(errors, payload.result.failure.code);
    }
  }
  return errors;
}

function appendSafeRunFailure(
  errors: Array<{ code: string; message: string }>,
  failure: RunFailureCause,
): void {
  if (failure.kind === "provider") {
    const providerErrorCode = failure.failure.metadata.providerErrorCode;
    if (isSafeProviderErrorCode(providerErrorCode)) {
      appendSafeError(errors, providerErrorCode);
    }
  }
  appendSafeError(errors, failure.failure.code);
}

function isSafeProviderErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^provider_[a-z0-9_]{1,119}$/.test(value);
}

function appendSafeError(
  errors: Array<{ code: string; message: string }>,
  code: string,
  message = safeProductErrorMessage(code),
): void {
  if (!errors.some((error) => error.code === code)) {
    errors.push({ code, message: sanitizeMessage(message, safeProductErrorMessage(code)) });
  }
}

function collectEffects(runResult: RunResult<HelarcAgentOutput>): readonly HelarcEffectSummary[] {
  return Object.freeze(runResult.items.flatMap((item) => {
    if (item.payload.kind !== "observation" || item.payload.observation.payload.kind !== "operation") return [];
    const result = item.payload.observation.payload.result;
    return [Object.freeze({
      operationInvocationId: result.ref.invocation.id,
      operationResultId: result.ref.id,
      semanticOwner: result.semanticOwner,
      status: result.status,
      bindingRevision: result.binding.revision,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      effectCertainty: metadataString(result.metadata, "effectCertainty"),
      completionExtent: metadataString(result.metadata, "completionExtent"),
      lowerRefs: Object.freeze(result.lowerRefs.map((reference) => Object.freeze({ ...reference }))),
    })];
  }));
}

function collectRunActions(
  runResult: RunResult<HelarcAgentOutput>,
): readonly HelarcRunActionSummary[] {
  const observations = new Map(runResult.items.flatMap((item) =>
    item.payload.kind === "observation"
      ? [[item.payload.observation.actionId, item.payload.observation] as const]
      : []
  ));
  return Object.freeze(runResult.items.flatMap((item) => {
    if (item.payload.kind !== "run_action") return [];
    const action = item.payload.action;
    const observation = observations.get(action.ref.id) ?? null;
    return [Object.freeze({
      runActionId: action.ref.id,
      sequence: action.ref.sequence,
      subjectKind: action.subject.kind,
      operationInvocationId: action.subject.kind === "operation"
        ? action.subject.invocationId
        : null,
      interactionRequestId: action.subject.kind === "interaction"
        ? action.subject.request?.id ?? null
        : null,
      status: runActionStatus(observation),
      observationId: observation?.id ?? null,
    })];
  }));
}

function collectCanonicalActions(
  effects: readonly HelarcEffectSummary[],
): readonly HelarcCanonicalActionSummary[] {
  return Object.freeze(effects.flatMap((effect) => effect.lowerRefs
    .filter((reference) => reference.kind === "action_settlement")
    .map((reference) => Object.freeze({
      actionSettlementId: reference.id,
      actionSettlementRevision: reference.revision,
      operationResultId: effect.operationResultId,
      status: effect.status,
      effectCertainty: effect.effectCertainty,
      completionExtent: effect.completionExtent,
    }))));
}

function collectComposites(
  runResult: RunResult<HelarcAgentOutput>,
): readonly HelarcCompositeWorkSummary[] {
  return Object.freeze(runResult.items.flatMap((item) => {
    if (
      item.payload.kind !== "observation" ||
      item.payload.observation.payload.kind !== "operation"
    ) return [];
    const result = item.payload.observation.payload.result;
    const compositeId = metadataString(result.metadata, "compositeId");
    const childCount = metadataNonNegativeInteger(result.metadata, "childCount");
    if (compositeId === null || childCount === null) return [];
    const children = result.lowerRefs.filter(({ kind }) => kind === "operation_result");
    return [Object.freeze({
      compositeId,
      operationResultId: result.ref.id,
      status: result.status,
      childCount,
      settledChildCount: children.length,
      unresolvedChildCount: Math.max(0, childCount - children.length),
      childOperationResultIds: Object.freeze(children.map(({ id }) => id)),
    })];
  }));
}

function collectChildren(
  runResult: RunResult<HelarcAgentOutput>,
  effects: readonly HelarcEffectSummary[],
): readonly HelarcChildWorkSummary[] {
  const direct = runResult.items.flatMap((item) => {
    if (
      item.payload.kind !== "observation" ||
      item.payload.observation.payload.kind !== "descendant_run"
    ) return [];
    const payload = item.payload.observation.payload;
    return [Object.freeze({
      refId: payload.childRunId ?? item.payload.observation.id,
      owner: "agent-runtime",
      status: payload.status,
    })];
  });
  const operationBound = effects.flatMap((effect) => effect.lowerRefs
    .filter((reference) => reference.kind.includes("descendant"))
    .map((reference) => Object.freeze({
      refId: reference.id,
      owner: reference.owner,
      status: effect.status,
    })));
  return Object.freeze([...direct, ...operationBound]);
}

function collectInteractions(runResult: RunResult<HelarcAgentOutput>): readonly HelarcInteractionSummary[] {
  return Object.freeze(runResult.items.flatMap((item) => {
    if (item.payload.kind !== "observation") return [];
    const observation = item.payload.observation;
    const payload = observation.payload;
    if (payload.kind !== "interaction") return [];
    return [Object.freeze({
      observationId: observation.id,
      owner: payload.owner,
      status: payload.status,
    })];
  }));
}

function collectUncertainty(
  runResult: RunResult<HelarcAgentOutput>,
  effects: readonly HelarcEffectSummary[],
): readonly string[] {
  const values: string[] = [];
  if (effects.some(({ status }) => status === "unknown_effect")) {
    values.push("At least one external effect has unknown settlement.");
  }
  if (runResult.status === "cancelled") {
    values.push("Cancellation does not prove that every previously started effect was rolled back.");
  }
  return Object.freeze(values);
}

function collectIncompleteWork(
  runResult: RunResult<HelarcAgentOutput>,
  effects: readonly HelarcEffectSummary[],
  runActions: readonly HelarcRunActionSummary[],
  composites: readonly HelarcCompositeWorkSummary[],
): readonly string[] {
  const values: string[] = [];
  if (runResult.status !== "succeeded") values.push(`Run ended with status '${runResult.status}'.`);
  if (effects.some(({ status }) => status === "partial" || status === "unknown_effect")) {
    values.push("One or more Operation effects remain partial or unresolved.");
  }
  if (runActions.some(({ status }) => status === "started")) {
    values.push("One or more Run Actions have no terminal Observation.");
  }
  if (composites.some(({ unresolvedChildCount }) => unresolvedChildCount > 0)) {
    values.push("One or more composite Operations have unresolved child work.");
  }
  return Object.freeze(values);
}

function runActionStatus(
  observation: import("@agent-anything/agent-runtime/run").RunObservation | null,
): HelarcRunActionSettlementStatus {
  if (observation === null) return "started";
  switch (observation.payload.kind) {
    case "operation": return observation.payload.result.status;
    case "operation_rejected": return "rejected";
    case "tool_rejected": return "rejected";
    case "model_call_rejected": return "rejected";
    case "interaction": return observation.payload.status;
    case "descendant_run": return observation.payload.status;
    case "plan_update": return observation.payload.result.status;
    case "handoff": return observation.payload.status;
  }
}

function metadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function metadataNonNegativeInteger(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = metadata[key];
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function sanitizeMessage(message: string, fallback: string): string {
  if (typeof message !== "string" || message.trim().length === 0) return fallback;
  const value = message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]+/g, "[path]");
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function safeProductErrorMessage(code: string): string {
  if (code === "provider_context_window_exceeded") {
    return "The model context window is too small for the current request.";
  }
  if (code === "provider_response_empty") {
    return "The model returned no usable response.";
  }
  if (
    code === "provider_response_malformed" ||
    code === "provider_structured_output_malformed"
  ) {
    return "The model returned a response that could not be understood.";
  }
  if (code.startsWith("model_") || code.startsWith("provider_")) {
    return "The model request could not be completed.";
  }
  if (code.startsWith("approval_") || code.startsWith("granted_permissions_")) {
    return "Approval could not be completed.";
  }
  if (code.startsWith("session_authority_") || code.startsWith("policy_amendment_")) {
    return "Permission state could not be updated.";
  }
  if (
    code.startsWith("action_") ||
    code.startsWith("file_") ||
    code.startsWith("filesystem_")
  ) {
    return "The requested file operation could not be completed.";
  }
  if (code === "command_exit_nonzero") {
    return "A command exited with a non-zero status.";
  }
  if (code.startsWith("command_")) {
    return "A command attempt could not be completed.";
  }
  if (code.startsWith("sandbox_") || code.startsWith("tool_")) {
    return "The requested action could not be completed.";
  }
  if (
    code.startsWith("storage_") ||
    code.startsWith("audit_") ||
    code.startsWith("telemetry_")
  ) {
    return "Run finalization could not be completed.";
  }
  return "The run could not be completed.";
}

function mapRunStatus(status: RunResultStatus): HelarcProductStatus {
  return status === "succeeded" ? "completed" : status;
}

function titleForEvent(name: string, payload: Readonly<Record<string, unknown>>): string {
  switch (name) {
    case "run.started": return "Run started";
    case "run.completed": return "Run completed";
    case "run.blocked": return "Run blocked";
    case "run.failed": return "Run failed";
    case "run.cancelled": return "Run cancelled";
    case "controller.started":
      return `Controller iteration ${payload.iteration ?? ""} started`.trim();
    case "controller.finished": return `Controller ${payload.status ?? "finished"}`;
    case "run.item.appended": return `Run item appended: ${payload.itemKind ?? "unknown"}`;
    case "run.stop.reviewed":
      return `Run stop review ${payload.decision ?? "recorded"}`;
    case "run.stop.feedback_requested":
      return `Run stop feedback ${payload.round ?? "requested"}`;
    case "run.descendant.reserved": return "Descendant Run reserved";
    case "run.descendant.started": return "Descendant Run started";
    case "run.descendant.rejected": return "Descendant Run rejected";
    case "run.descendant.settled": return `Descendant Run ${payload.status ?? "settled"}`;
    case "context.projection.completed":
      return payload.outcome === "blocked"
        ? "Context projection blocked"
        : "Context projection completed";
    case "approval.requested": return `Approval requested: ${payload.category ?? "action"}`;
    case "approval.resolved":
      return `Approval ${payload.decisionKind ?? payload.resolutionKind ?? "resolved"}`;
    case "tool.started": return `Tool started: ${payload.toolName ?? "unknown"}`;
    case "tool.finished":
      return `Tool ${payload.status ?? "finished"}: ${payload.toolName ?? "unknown"}`;
    case "action.prepared": return "Action prepared";
    case "action.assessed": return `Action ${payload.status ?? "assessed"}`;
    case "action.invalidated": return "Action invalidated";
    case "sandbox.attempt.started":
      return payload.enforcement === "disabled"
        ? "Unisolated execution started"
        : `${payload.enforcement ?? "Sandbox"} enforcement started`;
    case "sandbox.attempt.resolved":
      return payload.enforcement === "disabled" && payload.outcome === "executed"
        ? "Unisolated execution completed"
        : `${payload.enforcement ?? "Sandbox"} enforcement ${payload.outcome ?? "resolved"}`;
    case "sandbox.escalation.proposed": return "Sandbox escalation proposed";
    case "retry.attempt.started":
      return `Retry attempt ${payload.attemptNumber ?? ""} started`.trim();
    case "retry.attempt.finished":
      return `Retry attempt ${payload.attemptNumber ?? ""} ${payload.outcome ?? "finished"}`.trim();
    case "retry.scheduled": return `Retry ${payload.nextAttemptNumber ?? ""} scheduled`.trim();
    case "retry.exhausted": return "Retry exhausted";
    case "retry.cancelled": return "Retry cancelled";
    case "retry.fallback.selected": return "Retry fallback selected";
    default: return name;
  }
}

function detailForEvent(name: string, payload: Readonly<Record<string, unknown>>): string | null {
  if (
    (name === "tool.started" || name === "tool.finished")
    && (payload.toolName === "Bash" || payload.toolName === "PowerShell")
    && typeof payload.command === "string"
  ) {
    return payload.command;
  }
  if (name === "tool.started" || name === "tool.finished") {
    return typeof payload.actionId === "string" ? payload.actionId : null;
  }
  if (name.startsWith("action.") || name.startsWith("sandbox.")) {
    return typeof payload.actionId === "string"
      ? payload.actionId
      : typeof payload.attemptId === "string" ? payload.attemptId : null;
  }
  if (name === "controller.finished") {
    return typeof payload.decisionKind === "string" ? payload.decisionKind : null;
  }
  if (name === "context.projection.completed") {
    return typeof payload.manifestId === "string" ? payload.manifestId : null;
  }
  if (name === "run.stop.reviewed" || name === "run.stop.feedback_requested") {
    return typeof payload.code === "string"
      ? payload.code
      : typeof payload.decision === "string" ? payload.decision : null;
  }
  if (name === "approval.requested" || name === "approval.resolved") {
    return typeof payload.requestId === "string" ? payload.requestId : null;
  }
  if (name.startsWith("retry.")) {
    return typeof payload.operationId === "string" ? payload.operationId : null;
  }
  if (name.startsWith("run.descendant.")) {
    return typeof payload.childRunId === "string"
      ? payload.childRunId
      : typeof payload.code === "string" ? payload.code : null;
  }
  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
