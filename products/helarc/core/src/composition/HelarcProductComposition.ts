import { ProviderBackedController } from "@agent-anything/agent-runtime/controller";
import { createSystemRetryExecutor, systemRetryClock } from "@agent-anything/agent-runtime/retry";
import type { Controller } from "@agent-anything/agent-runtime/controller";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { CodeSourcePort } from "@agent-anything/helarc-code-agent/source";
import type { RetryClock } from "@agent-anything/agent-runtime/retry";
import type {
  SandboxEnforcement,
} from "@agent-anything/action-execution/sandbox";
import {
  buildHelarcProviderRequest,
  HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
  HELARC_PERMISSION_REQUEST_PROTOCOL,
  parseHelarcProviderResponse,
  type HelarcAgentOutput,
} from "../controller/HelarcController.js";
import { createHelarcAgent } from "../agent/HelarcAgent.js";
import { HELARC_ACTION_CONTRACT_VERSION } from "../prompt/HelarcPromptAssembly.js";
import {
  createHelarcToolCatalogMetadata,
  HELARC_TOOL_CATALOG_METADATA_KEY,
} from "../tools/HelarcToolCatalog.js";
import {
  HelarcTracingController,
  projectHelarcControllerTraceForEvent,
  type HelarcControllerTraceProjection,
} from "../observability/index.js";
import {
  HelarcPatchActionController,
  type HelarcPatchActionState,
} from "../review/HelarcPatchActionController.js";
import type { HelarcTaskInput } from "../task/HelarcTaskInput.js";
import type { Provider } from "@agent-anything/model-interaction";
import {
  createInteractionProtocolRegistrySnapshot,
  type InteractionProtocolRegistrySnapshot,
} from "@agent-anything/interaction/coordination";
import {
  snapshotInteractionRequest,
  type InteractionProtocol,
  type InteractionRequestRef,
} from "@agent-anything/interaction/protocol";
import type {
  HelarcPatchReviewBridge,
  HelarcProductPhase,
} from "./HelarcPatchReview.js";
import {
  createHelarcActionComposition,
  type HelarcCommandActionContribution,
  type HelarcFileActionContribution,
} from "./HelarcActionComposition.js";
import {
  projectHelarcProductResult,
  mapRuntimeEventToHelarcActivity,
  type HelarcActivityItem,
  type HelarcProductResult,
} from "./HelarcProductResult.js";
import {
  createHelarcProductRunProjection,
  reduceHelarcProductRunProjection,
  type HelarcProductRunProjection,
  type HelarcProductRunProjectionListener,
  type HelarcProductRunProjectionUpdate,
} from "../run/HelarcRunProjection.js";

type HelarcProductProjectionUpdatePayload =
  HelarcProductRunProjectionUpdate extends infer TUpdate
    ? TUpdate extends HelarcProductRunProjectionUpdate
      ? Omit<TUpdate, "runId" | "sequence">
      : never
    : never;

export type HelarcToolMode = "read-only" | "shell-enabled";

export interface CreateHelarcProductCompositionInput {
  readonly runId: string;
  readonly task: AgentTask<HelarcTaskInput>;
  readonly workspace: WorkspaceSelection;
  readonly provider: Provider;
  readonly toolMode: HelarcToolMode;
  readonly codeSource: CodeSourcePort;
  readonly fileActions: HelarcFileActionContribution;
  readonly commandActions: HelarcCommandActionContribution | null;
  readonly permissionRequests?: HelarcPermissionRequestApplicationPort | null;
  readonly patchReviewBridge?: HelarcPatchReviewBridge;
  readonly now?: () => string;
}

export interface HelarcProductComposition {
  readonly agent: Agent<HelarcAgentOutput>;
  readonly controller: Controller<HelarcAgentOutput>;
  readonly actions: Awaited<ReturnType<typeof createHelarcActionComposition>>;
  readonly interactions: InteractionProtocolRegistrySnapshot;
  readonly runMetadata: Readonly<Record<string, unknown>>;
  getProductProjection(): HelarcProductRunProjection;
  subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void;
  recordRuntimeEvent(event: RuntimeEvent): {
    readonly event: RuntimeEvent;
    readonly activity: HelarcActivityItem;
  };
  projectResult(
    runResult: RunResult<HelarcAgentOutput>,
    selectedEnforcement: SandboxEnforcement,
  ): HelarcProductResult;
}

export async function createHelarcProductComposition(
  input: CreateHelarcProductCompositionInput,
): Promise<HelarcProductComposition> {
  if (input.toolMode === "shell-enabled" && input.commandActions === null) {
    throw new TypeError("Shell-enabled Helarc composition requires a command Action contribution.");
  }
  const admittedAt = (input.now ?? (() => new Date().toISOString()))();
  const actions = createHelarcActionComposition({
    admittedAt,
    file: input.fileActions,
    command: input.toolMode === "shell-enabled" ? input.commandActions : null,
  });
  const interactions = createHelarcInteractionComposition(input.permissionRequests ?? null);
  const retryClock = createHelarcRetryClock(input.now);
  const controllerTraceByOperationId = new Map<
    string,
    HelarcControllerTraceProjection
  >();
  let productProjection = createHelarcProductRunProjection(input.runId);
  let productSequence = 0;
  const productListeners = new Set<HelarcProductRunProjectionListener>();
  const publishProductUpdate = (
    update: HelarcProductProjectionUpdatePayload,
  ): void => {
    productSequence += 1;
    const reduction = reduceHelarcProductRunProjection(productProjection, {
      ...update,
      runId: input.runId,
      sequence: productSequence,
    } as Parameters<typeof reduceHelarcProductRunProjection>[1]);
    if (reduction.status === "rejected") {
      throw new Error(`Helarc product projection update was rejected: ${reduction.code}.`);
    }
    productProjection = reduction.projection;
    for (const listener of [...productListeners]) {
      try {
        listener(productProjection);
      } catch {
        // Product projection delivery is non-authoritative.
      }
    }
  };
  const providerController = new HelarcTracingController(
    new ProviderBackedController<HelarcAgentOutput>({
      provider: input.provider,
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
      structuredOutputContractId: HELARC_ACTION_CONTRACT_VERSION,
      maxProviderOutputLength: HELARC_CONTROLLER_OUTPUT_MAX_LENGTH,
      retryExecutor: createSystemRetryExecutor(retryClock),
      retryClock,
    }),
    controllerTraceByOperationId,
  );
  const patchController = new HelarcPatchActionController({
    controller: providerController,
    codeSource: input.codeSource,
    patchReviewPort: input.patchReviewBridge,
    onStateChanged: (state) => {
      const phase = productPhaseForPatchState(state);
      if (phase !== null) {
        publishProductUpdate({ kind: "phase_changed", phase });
      }
    },
    now: input.now,
  });
  const unsubscribePatchReview = input.patchReviewBridge?.subscribe((review) => {
    if (review !== null) {
      if (productProjection.phase.kind !== "patch_action_submitted") {
        publishProductUpdate({
          kind: "phase_changed",
          phase: Object.freeze({ kind: "waiting_for_patch_review", review }),
        });
      }
      return;
    }
    if (productProjection.phase.kind === "waiting_for_patch_review") {
      publishProductUpdate({ kind: "phase_changed", phase: Object.freeze({ kind: "none" }) });
    }
  }) ?? (() => undefined);
  const runMetadata = Object.freeze({
    product: "helarc",
    toolMode: input.toolMode,
    [HELARC_TOOL_CATALOG_METADATA_KEY]: createHelarcToolCatalogMetadata({
      mode: input.toolMode,
    }),
  });

  return Object.freeze({
    agent: createHelarcAgent(),
    controller: patchController,
    actions,
    interactions,
    runMetadata,
    getProductProjection(): HelarcProductRunProjection {
      return productProjection;
    },
    subscribeProductProjection(listener: HelarcProductRunProjectionListener): () => void {
      if (typeof listener !== "function") {
        throw new TypeError("Helarc product projection listener must be a function.");
      }
      productListeners.add(listener);
      return () => {
        productListeners.delete(listener);
      };
    },
    recordRuntimeEvent(event: RuntimeEvent) {
      const controllerTrace = projectHelarcControllerTraceForEvent(
        event,
        controllerTraceByOperationId,
      );
      const activity = mapRuntimeEventToHelarcActivity(event, controllerTrace);
      publishProductUpdate({ kind: "activity_appended", activity });
      return Object.freeze({ event, activity });
    },
    projectResult(
      runResult: RunResult<HelarcAgentOutput>,
      selectedEnforcement: SandboxEnforcement,
    ): HelarcProductResult {
      const result = projectHelarcProductResult(
        input.task,
        input.workspace,
        runResult,
        patchController.getPatchOutcome(),
        selectedEnforcement,
      );
      publishProductUpdate({ kind: "result_settled", result });
      unsubscribePatchReview();
      return result;
    },
  });
}

function createHelarcRetryClock(
  now: CreateHelarcProductCompositionInput["now"],
): RetryClock {
  return now === undefined
    ? systemRetryClock
    : Object.freeze({ now: () => new Date(now()) });
}

function productPhaseForPatchState(
  state: HelarcPatchActionState,
): HelarcProductPhase | null {
  if (state.kind === "reviewing") {
    return null;
  }
  if (state.kind === "none") {
    return Object.freeze({ kind: "none" });
  }
  return Object.freeze({
    kind: "patch_action_submitted",
    runId: state.runId,
    proposalId: state.proposalId,
    proposalRevision: state.proposalRevision,
    reviewId: state.reviewId,
    pendingVersion: state.pendingVersion,
  });
}

export interface HelarcPermissionRequestSubject {
  readonly runId: string;
  readonly rootId: string;
  readonly permissions: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

export interface HelarcPermissionRequestApplicationPort {
  apply(input: {
    readonly request: InteractionRequestRef<"permission_request">;
    readonly subject: HelarcPermissionRequestSubject;
    readonly accepted: boolean;
    readonly reason: string | null;
  }): Promise<unknown> | unknown;
}

function createHelarcInteractionComposition(
  application: HelarcPermissionRequestApplicationPort | null,
): InteractionProtocolRegistrySnapshot {
  type Submission = { readonly accepted: boolean; readonly reason: string | null };
  type Resolution = Submission;
  const subjects = new Map<string, HelarcPermissionRequestSubject>();
  const protocolImplementation: InteractionProtocol<
    "permission_request",
    HelarcPermissionRequestSubject,
    Readonly<Record<string, unknown>>,
    Submission,
    Resolution,
    unknown
  > = {
    ref: HELARC_PERMISSION_REQUEST_PROTOCOL,
    createRequest(requestInput) {
      const subject = snapshotPermissionSubject(requestInput.subject);
      const request = snapshotInteractionRequest({
        ref: {
          id: requestInput.requestId,
          protocol: HELARC_PERMISSION_REQUEST_PROTOCOL,
          requestVersion: requestInput.requestVersion,
          subject: requestInput.subjectRef,
        },
        subject,
        correlation: requestInput.correlation,
        parentRunAction: requestInput.parentRunAction,
        presentation: snapshotData(requestInput.presentation) as Readonly<Record<string, unknown>>,
        expiresAt: requestInput.expiresAt,
        createdAt: requestInput.createdAt,
      }, snapshotPermissionSubject, (value) => snapshotData(value) as Readonly<Record<string, unknown>>);
      subjects.set(request.ref.id, subject);
      return request;
    },
    validateSubmission(_request, candidate) {
      if (!isRecord(candidate) || typeof candidate.accepted !== "boolean") {
        throw new TypeError("Helarc permission request submission requires accepted.");
      }
      if (candidate.reason !== undefined && candidate.reason !== null && typeof candidate.reason !== "string") {
        throw new TypeError("Helarc permission request reason must be text or null.");
      }
      return Object.freeze({
        accepted: candidate.accepted,
        reason: typeof candidate.reason === "string" ? candidate.reason : null,
      });
    },
    resolve({ submission }) {
      return submission;
    },
    async apply({ request, resolution }) {
      const subject = subjects.get(request.id);
      subjects.delete(request.id);
      if (subject === undefined) {
        return Object.freeze({ status: "failed", code: "permission_request_subject_missing" });
      }
      if (application === null) {
        return Object.freeze({ status: "unavailable", code: "permission_request_application_unavailable" });
      }
      return application.apply({
        request,
        subject,
        accepted: resolution.accepted,
        reason: resolution.reason,
      });
    },
  };
  const protocol = Object.freeze(protocolImplementation);
  return createInteractionProtocolRegistrySnapshot(
    "helarc.interactions.v1",
    [{ ref: HELARC_PERMISSION_REQUEST_PROTOCOL, protocol }],
  );
}

function snapshotPermissionSubject(input: HelarcPermissionRequestSubject): HelarcPermissionRequestSubject {
  if (!isRecord(input) || typeof input.runId !== "string" || typeof input.rootId !== "string" ||
    !isRecord(input.permissions) || typeof input.reason !== "string") {
    throw new TypeError("Helarc permission request subject is invalid.");
  }
  return Object.freeze({
    runId: input.runId,
    rootId: input.rootId,
    permissions: snapshotData(input.permissions) as Readonly<Record<string, unknown>>,
    reason: input.reason,
  });
}

function snapshotData<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
