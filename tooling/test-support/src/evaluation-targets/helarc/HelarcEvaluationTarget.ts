import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  createCanonicalSha256Digest,
  createCanonicalWorkspaceIdentity,
} from "@agent-anything/canonical-action/subject";
import type {
  ActionRecordPort,
  ActionRetryDecisionPort,
} from "@agent-anything/action-execution/enforcement";
import { Runner } from "@agent-anything/agent-runtime/runner";
import { CurrentValidationCompletionGate } from "@agent-anything/validation/completion";
import { createNoCheckValidationExecutionFactory } from "@agent-anything/validation/execution";
import type { RunResult } from "@agent-anything/agent-runtime/run";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import {
  assembleEvaluationCapture,
  type EvaluationCapture,
  type EvaluationCaptureContribution,
  type EvaluationCapturePort,
  type EvaluationCaptureRequest,
  type EvaluationMeasurement,
} from "@agent-anything/evaluation/capture";
import {
  createEvaluationFailure,
  createEvaluationRecordRef,
  type EvaluationDataValue,
  type EvaluationRecordRef,
} from "@agent-anything/evaluation/definition";
import type {
  EvaluationCleanupOutcome,
  EvaluationEnvironmentLease,
  EvaluationEnvironmentPort,
  EvaluationTargetObservation,
  EvaluationTargetPort,
  EvaluationTrial,
} from "@agent-anything/evaluation/trial";
import { createEvaluationTargetObservation } from "@agent-anything/evaluation/trial";
import { createAllowAllActionPolicyPort } from "@agent-anything/governance";
import type {
  ManagedPermissionConstraints,
  PersistentPolicyAmendmentPort,
} from "@agent-anything/governance";
import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
} from "@agent-anything/host/authority";
import { resolveHostRunPermissionConfig } from "@agent-anything/host/composition";
import {
  createStaticHostIdentityResolver,
  createStaticHostWorkspaceResolver,
  resolveHostRunContext,
} from "@agent-anything/host/context";
import {
  createHostRunManager,
  type HostActiveRun,
} from "@agent-anything/host/run";
import {
  createHelarcProductComposition,
  HELARC_PATCH_REVIEW_PROTOCOL,
  snapshotHelarcPatchReviewPresentation,
  type HelarcProductResult,
  validateHelarcToolInput,
} from "@agent-anything/helarc/composition";
import {
  resolveHelarcPermissionPreset,
  type HelarcPermissionPreset,
} from "@agent-anything/helarc/configuration";
import {
  createHelarcContextProjectionConfiguration,
  type HelarcAgentOutput,
} from "@agent-anything/helarc/controller";
import {
  HELARC_RUN_COMMAND_BINDING,
  HELARC_RUN_COMMAND_OPERATION,
} from "@agent-anything/helarc/tools";
import { createHelarcTask } from "@agent-anything/helarc/task";
import {
  createCodeAgentCanonicalWorkspaceRoots,
  createHelarcLocalFileActionCapability,
  createLocalCodeSourcePort,
} from "@agent-anything/helarc-local-environment/filesystem";
import {
  createHelarcLocalCommandActionCapability,
} from "@agent-anything/helarc-local-environment/command";
import { createHelarcLocalSandboxGateway } from "@agent-anything/helarc-local-environment/sandbox";
import type { ProviderRequest } from "@agent-anything/model-interaction";
import type { RuntimeEvent, RuntimeEventPublisher } from "@agent-anything/observability/events";
import type { RunTrace } from "@agent-anything/observability/tracing";
import type { ToolSelectionRevision } from "@agent-anything/tools/selection";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import type {
  ApprovalReviewInput,
  ApprovalReviewOutcome,
} from "@agent-anything/permission";
import type {
  PermissionEnforcement,
  PermissionProfileDefinition,
} from "@agent-anything/permission/profile";
import { FakeProvider } from "../../FakeProvider.js";
import {
  HELARC_EVALUATION_TIME,
  type HelarcEvaluationCaseDefinition,
  type HelarcEvaluationCorpus,
  type HelarcEvaluationFixtureFile,
} from "./HelarcEvaluationCorpus.js";

const TARGET_LIMITATION = Object.freeze({
  code: "deterministic_system_baseline_only",
  message: "This Target measures deterministic Product and Harness integration, not general model intelligence.",
  metadata: Object.freeze({}),
});

interface WorkspaceSnapshot {
  readonly files: readonly HelarcEvaluationFixtureFile[];
}

interface ApprovalDecisionRecord {
  readonly decision: "decline" | null;
}

interface PatchReviewRecord {
  readonly decision: "accepted" | "rejected" | null;
  readonly operation: "create" | "update" | "delete" | null;
  readonly path: string | null;
}

interface HelarcEvaluationLeaseMaterial {
  readonly trialRef: EvaluationRecordRef;
  readonly caseDefinition: HelarcEvaluationCaseDefinition;
  readonly root: string;
  readonly before: WorkspaceSnapshot;
}

interface HelarcEvaluationCaptureMaterial {
  readonly trialRef: EvaluationRecordRef;
  readonly observationRef: EvaluationRecordRef;
  readonly environmentRef: EvaluationRecordRef;
  readonly caseDefinition: HelarcEvaluationCaseDefinition;
  readonly product: HelarcProductResult;
  readonly runResult: RunResult<HelarcAgentOutput>;
  readonly trace: RunTrace;
  readonly before: WorkspaceSnapshot;
  readonly after: WorkspaceSnapshot;
  readonly patchReview: PatchReviewRecord;
  readonly approval: ApprovalDecisionRecord;
  readonly providerRequests: readonly ProviderRequest[];
  readonly actionNames: readonly string[];
  readonly retryCount: number;
}

export interface HelarcEvaluationTargetAdapter {
  readonly environment: EvaluationEnvironmentPort;
  readonly target: EvaluationTargetPort;
  readonly capture: EvaluationCapturePort;
}

export function createHelarcEvaluationTargetAdapter(
  corpus: HelarcEvaluationCorpus,
): HelarcEvaluationTargetAdapter {
  const cases = new Map(corpus.cases.map((item) => [refKey(item.definition.ref), item]));
  const leases = new Map<string, HelarcEvaluationLeaseMaterial>();
  const captures = new Map<string, HelarcEvaluationCaptureMaterial>();

  const environment: EvaluationEnvironmentPort = Object.freeze({
    async prepare(input: Parameters<EvaluationEnvironmentPort["prepare"]>[0]) {
      const caseDefinition = cases.get(refKey(input.trial.caseRef));
      if (caseDefinition === undefined) {
        return Object.freeze({
          status: "invalid" as const,
          failure: evaluationFailure(
            "evaluation_definition_invalid",
            "definition",
            "The Trial references an unknown Helarc Evaluation Case.",
            "evaluation.target.helarc",
          ),
        });
      }
      if (input.signal.aborted) {
        return Object.freeze({
          status: "failed" as const,
          failure: evaluationFailure(
            "evaluation_cancelled",
            "cancellation",
            "Helarc Evaluation environment preparation was cancelled.",
            "evaluation.environment",
          ),
        });
      }
      let root: string | null = null;
      try {
        root = await mkdtemp(join(tmpdir(), "agent-anything-helarc-eval-"));
        for (const file of caseDefinition.fixture.files) {
          const target = resolveFixturePath(root, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, "utf8");
        }
        const before = await snapshotWorkspace(root);
        const leaseRef = createEvaluationRecordRef({
          id: `${input.trial.ref.id}.environment`,
          revision: input.trial.ref.revision,
        });
        leases.set(refKey(leaseRef), Object.freeze({
          trialRef: input.trial.ref,
          caseDefinition,
          root,
          before,
        }));
        const lease: EvaluationEnvironmentLease = Object.freeze({
          ref: leaseRef,
          environmentFingerprint: sha256([
            caseDefinition.fixture.ref.id,
            caseDefinition.fixture.ref.revision,
            input.trial.seed,
          ].join("@")),
          metadata: Object.freeze({
            adapter: "helarc-phase26",
            isolated: true,
          }),
        });
        return Object.freeze({ status: "prepared" as const, lease });
      } catch {
        if (root !== null) {
          await rm(root, { recursive: true, force: true }).catch(() => undefined);
        }
        return Object.freeze({
          status: "failed" as const,
          failure: evaluationFailure(
            "evaluation_environment_failed",
            "environment",
            "The isolated Helarc Evaluation environment could not be prepared.",
            "evaluation.environment",
          ),
        });
      }
    },
    async cleanup(
      input: Parameters<EvaluationEnvironmentPort["cleanup"]>[0],
    ): Promise<EvaluationCleanupOutcome> {
      const key = refKey(input.lease.ref);
      const material = leases.get(key);
      if (material === undefined) {
        return Object.freeze({
          status: "failed" as const,
          failure: evaluationFailure(
            "evaluation_cleanup_failed",
            "cleanup",
            "The isolated Helarc Evaluation lease is unavailable for cleanup.",
            "evaluation.environment",
          ),
        });
      }
      leases.delete(key);
      try {
        await rm(material.root, { recursive: true, force: true });
        return Object.freeze({ status: "cleaned" as const });
      } catch {
        return Object.freeze({
          status: "failed" as const,
          failure: evaluationFailure(
            "evaluation_cleanup_failed",
            "cleanup",
            "The isolated Helarc Evaluation workspace could not be removed.",
            "evaluation.environment",
          ),
        });
      }
    },
  });

  const target: EvaluationTargetPort = Object.freeze({
    async invoke(input: Parameters<EvaluationTargetPort["invoke"]>[0]) {
      const lease = leases.get(refKey(input.leaseRef));
      if (
        lease === undefined ||
        refKey(lease.trialRef) !== refKey(input.trial.ref)
      ) {
        return Object.freeze({
          status: "failed" as const,
          failure: evaluationFailure(
            "evaluation_invocation_failed",
            "invocation",
            "The Helarc Target received an unknown or mismatched environment lease.",
            "evaluation.target.helarc",
          ),
        });
      }
      try {
        const material = await invokeHelarcTarget(input.trial, lease, input.signal);
        captures.set(refKey(material.observationRef), material);
        return Object.freeze({
          status: "observed" as const,
          observation: targetObservation(material, input.trial),
        });
      } catch (error) {
        return Object.freeze({
          status: "failed" as const,
          failure: evaluationFailure(
            "evaluation_invocation_failed",
            "invocation",
            `The Helarc Target adapter failed before returning measured behavior: ${safeAdapterError(error, lease.root)}`,
            "evaluation.target.helarc",
          ),
        });
      }
    },
  });

  const capture: EvaluationCapturePort = Object.freeze({
    async capture(request: EvaluationCaptureRequest) {
      const material = captures.get(refKey(request.targetObservationRef));
      if (
        material === undefined ||
        refKey(material.trialRef) !== refKey(request.trialRef) ||
        refKey(material.environmentRef) !== refKey(request.environmentRef)
      ) {
        return assembleEvaluationCapture({
          ref: request.captureRef,
          trialRef: request.trialRef,
          targetSnapshotRef: request.targetSnapshotRef,
          caseRef: request.caseRef,
          policy: corpus.capturePolicy,
          environmentRef: request.environmentRef,
          contributions: [],
          measurements: [],
          startedAt: HELARC_EVALUATION_TIME,
          completedAt: HELARC_EVALUATION_TIME,
          limitations: [TARGET_LIMITATION],
          metadata: { adapter: "helarc-phase26" },
        });
      }
      captures.delete(refKey(request.targetObservationRef));
      return captureHelarcMaterial(request, corpus, material);
    },
  });

  return Object.freeze({ environment, target, capture });
}

async function invokeHelarcTarget(
  trial: EvaluationTrial,
  lease: HelarcEvaluationLeaseMaterial,
  signal: AbortSignal,
): Promise<HelarcEvaluationCaptureMaterial> {
  const caseDefinition = lease.caseDefinition;
  const taskResult = createHelarcTask({
    taskId: `${trial.ref.id}.task`,
    prompt: readTaskText(caseDefinition),
    createdAt: HELARC_EVALUATION_TIME,
    metadata: { evaluationCaseRef: caseDefinition.definition.ref.id },
  });
  if (!taskResult.ok) throw new TypeError(taskResult.error.message);

  const workspace: WorkspaceSelection = Object.freeze({
    primary: Object.freeze({
      id: `${trial.ref.id}.workspace`,
      name: "Phase26 fixture",
      rootRef: lease.root,
      trustState: "trusted" as const,
      source: "evaluation",
      policyRefs: Object.freeze([]),
      metadata: Object.freeze({ fixtureRef: caseDefinition.fixture.ref.id }),
    }),
    additional: Object.freeze([]),
  });
  const productRunId = `${trial.ref.id}.product-run`;
  const runContext = await resolveHostRunContext({
    sessionId: `${trial.ref.id}.session`,
    runId: productRunId,
    taskId: taskResult.task.id,
    metadata: { product: "helarc", evaluation: true },
    workspaceResolver: createStaticHostWorkspaceResolver(workspace),
    identityResolver: createStaticHostIdentityResolver({
      id: `${trial.ref.id}.identity`,
      kind: "service",
      displayName: "Phase26 Evaluation",
      metadata: {},
    }),
    workspaceSelection: {
      kind: "references",
      primaryRef: workspace.primary.id,
      additionalRefs: [],
    },
    identitySelection: {
      kind: "reference",
      identityRef: `${trial.ref.id}.identity`,
    },
    workspaceRequirement: "required",
  });
  if (runContext.workspace === null) throw new TypeError("Helarc Evaluation requires a Workspace.");

  const clock = createLogicalClock(trial.repetitionOrdinal);
  const canonicalRoots = await createCodeAgentCanonicalWorkspaceRoots({
    workspace: runContext.workspace,
    platform: process.platform === "win32" ? "win32" : "posix",
  });
  const actionWorkspace = createCanonicalWorkspaceIdentity({
    workspaceId: workspace.primary.id,
    trustState: workspace.primary.trustState,
    roots: canonicalRoots,
  });
  const approval = new DeterministicApprovalReviewer(caseDefinition.expectedClaim.approvalDecision);
  const permissions = await createEvaluationPermissionConfig({
    preset: caseDefinition.script.permissionPreset,
    productRunId,
    sessionId: `${trial.ref.id}.session`,
    workspace: runContext.workspace,
    workspaceRoots: canonicalRoots.map((root) => ({
      rootId: root.rootId,
      path: root.resolvedPath,
    })),
    platform: process.platform === "win32" ? "win32" : "posix",
    identityId: runContext.identity.id,
    automaticReviewer: approval,
  });
  const patchReviews = new DeterministicPatchReviewResponder(
    caseDefinition.script.patchReviewDecision,
  );
  const provider = new FakeProvider({
    descriptor: {
      id: "helarc-phase26-scripted-provider",
      name: "Helarc Phase26 scripted Provider",
      metadata: { evaluation: true },
    },
    results: [...caseDefinition.script.responses],
  });
  const fileActions = createHelarcLocalFileActionCapability({
    workspace: runContext.workspace,
    now: clock.now,
  });
  const commandActions = caseDefinition.script.toolMode === "shell-enabled"
    ? await createHelarcLocalCommandActionCapability({
        workspace: runContext.workspace,
        operation: HELARC_RUN_COMMAND_OPERATION,
        binding: HELARC_RUN_COMMAND_BINDING,
        now: clock.now,
      })
    : null;
  const product = await createHelarcProductComposition({
    runId: productRunId,
    task: taskResult.task,
    workspace: runContext.workspace,
    provider,
    toolMode: caseDefinition.script.toolMode,
    codeSource: createLocalCodeSourcePort(clock.now),
    fileActions,
    commandActions,
    now: clock.now,
  });
  const gateway = createHelarcLocalSandboxGateway({
    executors: product.actions.executors,
    providers: [],
  });
  let trace: RunTrace | null = null;
  const runtimePublisher: RuntimeEventPublisher = Object.freeze({
    publish(event: RuntimeEvent) {
      product.recordRuntimeEvent(event);
    },
  });
  const runner = new Runner({
    controller: product.controller,
    contextProjection: createHelarcContextProjectionConfiguration(
      provider.inputAccounting,
    ),
    operations: {
      catalog: product.actions.operationCatalog,
      bindings: product.actions.operationBindings,
      validateToolInput: validateHelarcToolInput,
      internalHandlers: [],
      actionExecution: {
        registrations: product.actions.registrations,
        adapters: product.actions.adapters,
        policy: createAllowAllActionPolicyPort(clock.now),
        sandbox: gateway,
        records: createEvaluationActionRecordPort(trial.ref.id),
        retry: createEvaluationActionRetryPort(),
      },
    },
    validation: {
      executionFactory: createNoCheckValidationExecutionFactory({ now: clock.now }),
      completionGate: new CurrentValidationCompletionGate(clock.now),
    },
    interactions: product.interactions,
    runtimeEventPublisher: runtimePublisher,
    runTraceObserver: {
      observe(candidate) {
        trace = candidate;
      },
    },
    now: clock.now,
    createRunId: () => `${trial.ref.id}.harness-run`,
    createId: ({ runId, kind, sequence }) => `${runId}.${kind}.${sequence}`,
  });
  const manager = createHostRunManager({ runner, now: clock.now });
  const configurationFingerprint = await createCanonicalSha256Digest(
    "agent-anything.helarc.phase26-environment.v1",
    {
      platform: process.platform === "win32" ? "win32" : "posix",
      enforcement: "disabled",
      registrationFingerprints: product.actions.registrations.registrations.map(
        (registration) => registration.registrationFingerprint,
      ),
      operationCatalogId: product.actions.operationCatalog.id,
      operationCatalogRevision: product.actions.operationCatalog.revision,
      operationBindingRevision: product.actions.operationBindings.revision,
      toolSelectionRevision: product.actions.toolSelection.revision,
      workspaceRootFingerprints: canonicalRoots.map((root) => root.resolutionFingerprint),
    },
  );
  const runMetadata = Object.freeze({ ...product.runMetadata, enforcement: "disabled" });
  const active = manager.start({
    sessionId: `${trial.ref.id}.session`,
    agent: product.agent,
    runInput: {
      task: taskResult.task,
      items: [],
      metadata: runMetadata,
    },
    runConfig: {
      workspace: runContext.workspace,
      identity: runContext.identity,
      permissions,
      tools: product.actions.toolSelection,
      actionExecution: {
        policySnapshotId: "helarc-evaluation-policy-v1",
        securityContext: {
          workspace: actionWorkspace,
          actor: {
            identityId: runContext.identity.id,
            kind: runContext.identity.kind,
          },
          environment: {
            environmentId: permissions.permissionProfile.environmentId,
            platform: process.platform === "win32" ? "win32" : "posix",
            configurationFingerprint,
          },
        },
        enforcement: "disabled",
        metadata: {},
      },
      validation: createEvaluationValidationConfig(),
      limits: {
        maxIterations: 5,
        maxActions: 8,
        maxConsecutiveActionFailures: 1,
        maxDurationMs: 30_000,
        maxPendingInteractions: 4,
        maxDescendantRuns: 0,
        maxDescendantDepth: 0,
        plan: {
          maxSteps: 12,
          maxStepLength: 300,
          maxExplanationLength: 1_000,
        },
      },
      audit: "optional",
      telemetry: "optional",
      cancellationLimits: {
        operationSettlementTimeoutMs: 10_000,
        processGracePeriodMs: 1_000,
        processForceKillTimeoutMs: 2_000,
        finalizationTimeoutMs: 5_000,
      },
      retry: {
        providerRequest: {
          maxRetries: 2,
          delay: {
            kind: "exponential_jitter",
            baseDelayMs: 0,
            maxDelayMs: 0,
            multiplier: 2,
            jitterRatio: 0.1,
          },
          retryableCategories: ["transport", "timeout", "rate_limit", "server_error"],
          serverDelay: { mode: "ignore" },
        },
        structuredOutput: {
          maxRetries: 1,
          delay: {
            kind: "exponential_jitter",
            baseDelayMs: 0,
            maxDelayMs: 0,
            multiplier: 2,
            jitterRatio: 0.1,
          },
          retryableCategories: [
            "structured_output_syntax",
            "structured_output_schema",
            "structured_output_semantic",
            "agent_output_contract",
            "structured_output_size",
          ],
          serverDelay: { mode: "ignore" },
        },
        action: { maxAttempts: 1 },
      },
      metadata: runMetadata,
    },
  });
  const unsubscribePatchReviews = patchReviews.attach(active);
  const onAbort = () => {
    active.cancel({
      origin: "host",
      reasonCode: "host_requested",
      reason: "Evaluation Trial cancelled the active Helarc Run.",
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const hostResult = await active.wait();
  unsubscribePatchReviews();
  signal.removeEventListener("abort", onAbort);
  patchReviews.assertHealthy();
  const terminalProjection = active.getProjection();
  const productResult = product.projectResult(
    hostResult.runResult,
    "disabled",
    terminalProjection.validation,
  );
  if (trace === null) throw new TypeError("Helarc Evaluation requires one complete RunTrace.");
  const observationRef = createEvaluationRecordRef({
    id: `${trial.ref.id}.observation`,
    revision: trial.ref.revision,
  });
  return Object.freeze({
    trialRef: trial.ref,
    observationRef,
    environmentRef: createEvaluationRecordRef({
      id: `${trial.ref.id}.environment`,
      revision: trial.ref.revision,
    }),
    caseDefinition,
    product: productResult,
    runResult: hostResult.runResult,
    trace,
    before: lease.before,
    after: await snapshotWorkspace(lease.root),
    patchReview: patchReviews.record,
    approval: approval.record,
    providerRequests: Object.freeze(provider.requests()),
    actionNames: collectObservedToolNames(
      hostResult.runResult,
      product.actions.toolSelection,
    ),
    retryCount: terminalProjection.retry?.scheduledCount ?? 0,
  });
}

function createEvaluationValidationConfig() {
  const owner = (id: string) => Object.freeze({
    owner: "helarc-evaluation",
    kind: "validation",
    id,
    revision: "1",
  });
  return Object.freeze({
    profile: Object.freeze({
      ref: owner("empty-profile"),
      specification: Object.freeze({ id: "empty-specification", revision: "1" }),
      source: Object.freeze({ ...owner("profile-source"), sourceKind: "run_invocation" as const }),
      admittedBy: owner("profile-admission"),
      requirements: Object.freeze([]),
    }),
    completion: Object.freeze({
      policy: owner("current-validation-gate"),
      outputContract: owner("helarc-output-contract"),
      conditions: Object.freeze([]),
      maximumDurationMs: 1_000,
    }),
  });
}

function targetObservation(
  material: HelarcEvaluationCaptureMaterial,
  trial: EvaluationTrial,
): EvaluationTargetObservation {
  const status = material.product.status === "completed"
    ? "succeeded"
    : material.product.status === "cancelled"
      ? "cancelled"
      : material.product.status === "blocked" || material.product.status === "rejected"
        ? "blocked"
        : "failed";
  const artifactRefs = material.runResult.artifactRefs.map((artifactRef, index) => ({
    id: `${trial.ref.id}.artifact.${index + 1}.${sha256(artifactRef).slice(0, 12)}`,
    revision: trial.ref.revision,
  }));
  return createEvaluationTargetObservation({
    ref: material.observationRef,
    trialRef: trial.ref,
    targetSnapshotRef: trial.targetSnapshotRef,
    caseRef: trial.caseRef,
    outcome: Object.freeze({
      status,
      owner: targetOutcomeOwner(material),
      code: targetOutcomeCode(material),
      summary: `Helarc Product settled as ${material.product.status}.`,
      data: Object.freeze({
        productStatus: material.product.status,
        runtimeStatus: material.runResult.status,
        patchStatus: material.product.output.patchStatus,
        enforcementStatus: material.product.output.enforcement.status,
        activityCount: material.runResult.items.length,
      }),
    }),
    childRuns: Object.freeze([{
      runId: material.runResult.runId,
      status: material.runResult.status,
    }]),
    artifactRefs: Object.freeze(artifactRefs),
    observedAt: HELARC_EVALUATION_TIME,
    limitations: Object.freeze([TARGET_LIMITATION]),
    metadata: Object.freeze({ adapter: "helarc-phase26", scenario: material.caseDefinition.scenario }),
  });
}

function targetOutcomeCode(
  material: HelarcEvaluationCaptureMaterial,
): string | null {
  if (material.runResult.failure !== null) {
    return material.runResult.failure.failure.code;
  }
  if (material.runResult.status === "cancelled") {
    return material.runResult.code;
  }
  if (material.runResult.status === "blocked") {
    return blockedRunOutcomeCode(material.runResult.items) ?? material.runResult.code;
  }
  return material.product.output.safeErrors[0]?.code ?? material.runResult.code;
}

function targetOutcomeOwner(
  material: HelarcEvaluationCaptureMaterial,
): string {
  if (material.runResult.failure !== null) {
    return material.runResult.failure.kind;
  }
  if (material.runResult.status === "cancelled") {
    return "runtime";
  }
  if (material.runResult.status === "blocked") {
    return blockedRunOutcomeOwner(material.runResult.items) ?? "runtime";
  }
  return "helarc.product";
}

function blockedRunOutcomeOwner(
  items: RunResult<HelarcAgentOutput>["items"],
): string | null {
  for (const item of [...items].reverse()) {
    if (item.payload.kind !== "observation") continue;
    const payload = item.payload.observation.payload;
    if (payload.kind === "operation_rejected") return payload.owner;
    if (payload.kind === "operation") return payload.result.failure?.owner ?? null;
    if (payload.kind === "interaction") return payload.owner;
  }
  return null;
}

function blockedRunOutcomeCode(
  items: RunResult<HelarcAgentOutput>["items"],
): string | null {
  for (const item of [...items].reverse()) {
    if (item.payload.kind !== "observation") continue;
    const payload = item.payload.observation.payload;
    if (payload.kind === "operation_rejected") return payload.code;
    if (payload.kind === "operation") return payload.result.failure?.code ?? null;
    if (payload.kind === "interaction" && payload.status !== "resolved") {
      return `interaction_${payload.status}`;
    }
  }
  return null;
}

function collectObservedToolNames(
  result: RunResult<HelarcAgentOutput>,
  selection: ToolSelectionRevision,
): readonly string[] {
  const namesByOperation = new Map(selection.tools.map((selected) => [
    operationRevisionKey(selected.registration.operation.operation.ref),
    selected.registration.descriptor.name,
  ]));
  return Object.freeze(result.items.flatMap((item) => {
    if (
      item.payload.kind !== "observation" ||
      item.payload.observation.payload.kind !== "operation"
    ) {
      return [];
    }
    const name = namesByOperation.get(operationRevisionKey(
      item.payload.observation.payload.result.ref.invocation.operation,
    ));
    return name === undefined ? [] : [name];
  }).sort());
}

function operationRevisionKey(input: {
  readonly operation: { readonly namespace: string; readonly name: string };
  readonly revision: string;
}): string {
  return `${input.operation.namespace}:${input.operation.name}@${input.revision}`;
}

function createEvaluationActionRecordPort(prefix: string): ActionRecordPort {
  let sequence = 0;
  const next = (kind: string): { readonly recordId: string } => Object.freeze({
    recordId: `${prefix}.action-${kind}-${++sequence}`,
  });
  return Object.freeze({
    async recordPreEffect() {
      return next("pre-effect");
    },
    async recordPostEffect() {
      return next("post-effect");
    },
  });
}

function createEvaluationActionRetryPort(): ActionRetryDecisionPort {
  return Object.freeze({
    async decide() {
      return Object.freeze({
        status: "stop" as const,
        code: "evaluation_action_retry_disabled",
      });
    },
    async wait() {
      return "elapsed" as const;
    },
  });
}

function captureHelarcMaterial(
  request: EvaluationCaptureRequest,
  corpus: HelarcEvaluationCorpus,
  material: HelarcEvaluationCaptureMaterial,
) {
  const runItems = material.runResult.items;
  const actionNames = material.actionNames;
  const retryCount = material.retryCount;
  const totalUsage = material.caseDefinition.script.responses
    .slice(0, material.providerRequests.length)
    .reduce((totals, result) => {
      const usage = result.kind === "succeeded" ? result.response.usage : null;
      return {
        input: totals.input + (usage?.inputTokens ?? 0),
        output: totals.output + (usage?.outputTokens ?? 0),
        total: totals.total + (usage?.totalTokens ?? 0),
      };
    }, { input: 0, output: 0, total: 0 });
  const traceDuration = material.trace.startedAt !== null && material.trace.completedAt !== null
    ? Math.max(0, Date.parse(material.trace.completedAt) - Date.parse(material.trace.startedAt))
    : 0;
  const contributions: EvaluationCaptureContribution[] = [
    captured("product-outcome", "helarc.product", {
      status: material.product.status,
      runtimeStatus: material.product.output.runtimeStatus,
      patchStatus: material.product.output.patchStatus,
      appliedPath: material.product.output.appliedPath,
      agentSummary: material.product.output.agentSummary,
      enforcement: {
        selected: material.product.output.enforcement.selected,
        status: material.product.output.enforcement.status,
        code: material.product.output.enforcement.code,
      },
      errorCodes: material.product.output.safeErrors.map((item) => item.code).sort(),
    }),
    captured("run-terminal", "agent-core", {
      status: material.runResult.status,
      code: material.runResult.code,
      itemKinds: runItems.map((item) => item.payload.kind),
      itemCount: runItems.length,
      evidenceCount: material.runResult.evidenceRefs.length,
      artifactCount: material.runResult.artifactRefs.length,
      actionNames,
      retryCount,
    }),
    captured("workspace-before", "workspace", workspaceCapture(material.before)),
    captured("workspace-after", "workspace", workspaceCapture(material.after)),
    captured("artifact-observations", "agent-core", {
      artifacts: material.runResult.artifactRefs.map((item) => sha256(item)),
    }),
    captured("interaction-review", "helarc.product", {
      patchDecision: material.patchReview.decision,
      patchOperation: material.patchReview.operation,
      patchPath: material.patchReview.path,
      approvalDecision: material.approval.decision,
    }),
    captured("trace-summary", "observability", {
      status: material.trace.status,
      spans: material.trace.spans.map((span) => ({
        owner: span.owner,
        operation: span.operation,
        status: span.status,
        code: span.code,
      })),
      issues: material.trace.issues.map((issue) => issue.code),
    }),
    unavailable("validation-summary", "validation"),
  ];
  const measurements: EvaluationMeasurement[] = [
    measurement("latency_ms", "runtime", "run-trace", "ms", traceDuration),
    measurement("input_tokens", "provider", "provider-usage", "tokens", totalUsage.input),
    measurement("output_tokens", "provider", "provider-usage", "tokens", totalUsage.output),
    measurement("total_tokens", "provider", "provider-usage", "tokens", totalUsage.total),
    measurement("cost", "provider", "scripted-provider", "currency_units", 0),
    measurement("tool_count", "agent-core", "run-items", "count", actionNames.length),
    measurement("action_count", "agent-core", "run-items", "count", actionNames.length),
    measurement(
      "observation_count",
      "agent-core",
      "run-items",
      "count",
      runItems.filter((item) => item.payload.kind === "observation").length,
    ),
    measurement("retry_count", "agent-core", "run-items", "count", retryCount),
    measurement("artifact_count", "agent-core", "run-result", "count", material.runResult.artifactRefs.length),
    measurement("trace_issue_count", "observability", "run-trace", "count", material.trace.issues.length),
  ];
  return assembleEvaluationCapture({
    ref: request.captureRef,
    trialRef: request.trialRef,
    targetSnapshotRef: request.targetSnapshotRef,
    caseRef: request.caseRef,
    policy: corpus.capturePolicy,
    environmentRef: request.environmentRef,
    contributions,
    measurements,
    startedAt: HELARC_EVALUATION_TIME,
    completedAt: HELARC_EVALUATION_TIME,
    limitations: [
      TARGET_LIMITATION,
      Object.freeze({
        code: "validation_not_realized",
        message: "Validation capture is unavailable because its owning component is not realized.",
        metadata: Object.freeze({}),
      }),
    ],
    metadata: {
      adapter: "helarc-phase26",
      scenario: material.caseDefinition.scenario,
      expectedClaimRef: material.caseDefinition.expectedClaim.ref.id,
    },
  });
}

function captured(
  slotId: string,
  owner: string,
  value: EvaluationDataValue,
): EvaluationCaptureContribution {
  return Object.freeze({
    slotId,
    owner,
    schemaRef: { schemaId: `helarc.phase26.capture.${slotId}`, revision: "v1" },
    sensitivity: "internal" as const,
    status: "captured" as const,
    content: Object.freeze({ kind: "inline" as const, value }),
    reason: null,
  });
}

function unavailable(slotId: string, owner: string): EvaluationCaptureContribution {
  return Object.freeze({
    slotId,
    owner,
    schemaRef: { schemaId: `helarc.phase26.capture.${slotId}`, revision: "v1" },
    sensitivity: "public" as const,
    status: "unavailable" as const,
    content: null,
    reason: Object.freeze({
      code: "owner_not_realized",
      message: "The Validation owner is not available in Phase26.",
      sourceOwner: owner,
      details: Object.freeze({}),
    }),
  });
}

function measurement(
  id: string,
  owner: string,
  source: string,
  unit: string,
  value: number,
): EvaluationMeasurement {
  return Object.freeze({
    id,
    owner,
    source,
    unit,
    value,
    valid: true,
    limitation: null,
  });
}

function workspaceCapture(snapshot: WorkspaceSnapshot) {
  return Object.freeze({
    files: Object.freeze(snapshot.files.map((file) => Object.freeze({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
    }))),
  });
}

async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files: HelarcEvaluationFixtureFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError("Evaluation fixtures cannot contain symbolic links.");
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        const info = await lstat(target);
        const content = await readFile(target, "utf8");
        files.push(Object.freeze({
          path: relative(root, target).split(sep).join("/"),
          content,
          sha256: sha256(content),
          bytes: info.size,
        }));
      }
    }
  };
  await visit(root);
  return Object.freeze({
    files: Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path))),
  });
}

function resolveFixturePath(root: string, candidate: string): string {
  if (
    candidate.length === 0 ||
    isAbsolute(candidate) ||
    candidate.includes("\\") ||
    candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError("Evaluation fixture path must be a normalized relative path.");
  }
  const target = resolve(root, ...candidate.split("/"));
  const relativePath = relative(root, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new TypeError("Evaluation fixture path escapes its isolated Workspace.");
  }
  return target;
}

function readTaskText(caseDefinition: HelarcEvaluationCaseDefinition): string {
  const targetInput = caseDefinition.definition.targetInput;
  const value = isDataObject(targetInput)
    ? targetInput.taskText
    : null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Helarc Evaluation Case requires taskText.");
  }
  return value;
}

interface EvaluationPermissionInput {
  readonly preset: HelarcPermissionPreset;
  readonly productRunId: string;
  readonly sessionId: string;
  readonly workspace: WorkspaceSelection;
  readonly workspaceRoots: readonly { readonly rootId: string; readonly path: string }[];
  readonly platform: "win32" | "posix";
  readonly identityId: string;
  readonly automaticReviewer: DeterministicApprovalReviewer;
}

async function createEvaluationPermissionConfig(input: EvaluationPermissionInput) {
  const preset = resolveHelarcPermissionPreset(input.preset);
  const sessionAuthority: SessionAuthorityPort = createInMemoryHostSessionAuthorityStore({ maxRecords: 64 });
  const policyAmendments: PersistentPolicyAmendmentPort = createInMemoryHostPolicyAmendmentStore({ maxRecords: 64 });
  const managedConstraints: ManagedPermissionConstraints = Object.freeze({
    constraintSetId: `helarc-evaluation-${input.preset}`,
    selectableProfiles: Object.freeze({
      allowedProfileIds: null,
      deniedProfileIds: Object.freeze([]),
    }),
    fileSystem: Object.freeze([]),
    network: Object.freeze({
      enabled: null,
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze([]),
    }),
    allowUnenforcedExecution: true,
  });
  const profileId = `helarc-evaluation-${input.preset}`;
  const profile: PermissionProfileDefinition = Object.freeze({
    id: profileId,
    extends: preset.baseProfileId,
    enforcement: "disabled" as PermissionEnforcement,
    unrestrictedFileSystem: false,
    fileSystem: Object.freeze([]),
    process: Object.freeze({ unrestricted: false }),
    network: Object.freeze({
      enabled: false,
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze([]),
    }),
    metadata: Object.freeze({ product: "helarc", evaluation: true }),
  });
  const interruption = new AbortController();
  return resolveHostRunPermissionConfig({
    profile: {
      profileId,
      profiles: [profile],
      environment: {
        environmentId: "helarc-evaluation",
        platform: input.platform,
        workspaceRoots: input.workspaceRoots,
      },
    },
    approvalPolicy: preset.approvalPolicy,
    reviewer: preset.reviewerKind === "auto_review"
      ? Object.freeze({
          bindingId: `${input.productRunId}.reviewer.auto`,
          kind: "auto_review" as const,
          reviewer: input.automaticReviewer,
          descriptor: input.automaticReviewer.descriptor,
          reviewTimeoutMs: 1_000,
        })
      : null,
    rules: [],
    networkRules: [],
    managedConstraints,
    sessionAuthority: {
      context: {
        hostSessionId: input.sessionId,
        authorityContextKey: "helarc-evaluation-authority-v1",
        workspaceId: input.workspace.primary.id,
        identityId: input.identityId,
        environmentId: "helarc-evaluation",
      },
      port: sessionAuthority,
      maxInitialRecords: 64,
    },
    persistentPolicyAmendments: policyAmendments,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 5_000 },
    interruption: Object.freeze({ signal: interruption.signal, interruption: null }),
  });
}

class DeterministicApprovalReviewer {
  readonly descriptor = Object.freeze({
    id: "helarc-phase26-auto-reviewer",
    kind: "auto_review" as const,
    displayName: "Helarc Phase26 automatic reviewer",
    source: "evaluation",
    metadata: Object.freeze({}),
  });
  #record: ApprovalDecisionRecord = Object.freeze({ decision: null });

  constructor(private readonly expectedDecision: "decline" | null) {}

  get record(): ApprovalDecisionRecord {
    return this.#record;
  }

  async review(input: ApprovalReviewInput): Promise<ApprovalReviewOutcome> {
    if (this.expectedDecision !== "decline") {
      throw new TypeError("The deterministic reviewer was invoked for a Case without an approval claim.");
    }
    const option = input.request.decisionOptions.find((candidate) => candidate.kind === "decline");
    if (option === undefined) throw new TypeError("Approval request does not offer decline.");
    this.#record = Object.freeze({ decision: "decline" });
    return Object.freeze({
      status: "decided" as const,
      submission: Object.freeze({
        submissionId: `${input.request.id}.evaluation-decline`,
        runId: input.request.runId,
        requestId: input.request.id,
        pendingVersion: input.pendingVersion,
        optionId: option.id,
        grantedPermissions: null,
        reason: "Declined by the deterministic Phase26 reviewer.",
      }),
      rationale: null,
    });
  }
}

class DeterministicPatchReviewResponder {
  #record: PatchReviewRecord = Object.freeze({ decision: null, operation: null, path: null });
  #failure: Error | null = null;
  readonly #submittedRequests = new Set<string>();

  constructor(private readonly decision: "accepted" | "rejected" | null) {}

  get record(): PatchReviewRecord {
    return this.#record;
  }

  attach(active: HostActiveRun): () => void {
    const respond = (projection: ReturnType<HostActiveRun["getProjection"]>): void => {
      for (const pending of projection.pendingInteractions) {
        if (
          pending.phase !== "pending" ||
          pending.request.protocol.owner !== HELARC_PATCH_REVIEW_PROTOCOL.owner ||
          pending.request.protocol.kind !== HELARC_PATCH_REVIEW_PROTOCOL.kind ||
          pending.request.protocol.revision !== HELARC_PATCH_REVIEW_PROTOCOL.revision
        ) {
          continue;
        }
        const requestKey = `${pending.request.id}@${pending.request.requestVersion}`;
        if (this.#submittedRequests.has(requestKey)) continue;
        this.#submittedRequests.add(requestKey);
        try {
          if (this.decision === null) {
            throw new TypeError("The deterministic evaluation Case did not define a Patch review decision.");
          }
          const presentation = snapshotHelarcPatchReviewPresentation(pending.presentation as never);
          const outcome = active.submitInteraction({
            request: pending.request,
            submissionId: `${pending.request.id}.evaluation-${this.decision}`,
            payload: Object.freeze({
              decision: this.decision,
              reason: this.decision === "accepted"
                ? "Accepted by the deterministic Phase26 reviewer."
                : "Rejected by the deterministic Phase26 reviewer.",
            }),
          });
          if (outcome.status === "rejected") {
            throw new TypeError(`Deterministic Patch review submission was rejected: ${outcome.code}.`);
          }
          this.#record = Object.freeze({
            decision: this.decision,
            operation: presentation.operation,
            path: presentation.path,
          });
        } catch (error) {
          this.#failure = error instanceof Error
            ? error
            : new TypeError("Deterministic Patch review submission failed.");
          active.cancel({
            origin: "host",
            reasonCode: "host_requested",
            reason: "Evaluation Patch review automation failed.",
          });
        }
      }
    };
    const unsubscribe = active.subscribe(respond);
    respond(active.getProjection());
    return unsubscribe;
  }

  assertHealthy(): void {
    if (this.#failure !== null) throw this.#failure;
  }
}

function createLogicalClock(repetitionOrdinal: number) {
  let sequence = repetitionOrdinal * 10_000;
  return Object.freeze({
    now(): string {
      const value = new Date(Date.parse(HELARC_EVALUATION_TIME) + sequence).toISOString();
      sequence += 1;
      return value;
    },
  });
}

function evaluationFailure(
  code: Parameters<typeof createEvaluationFailure>[0]["code"],
  stage: Parameters<typeof createEvaluationFailure>[0]["stage"],
  message: string,
  causeOwner: string,
) {
  return createEvaluationFailure({
    code,
    stage,
    message,
    retryable: false,
    causeOwner,
    details: {},
  });
}

function refKey(ref: EvaluationRecordRef): string {
  return `${ref.id}@${ref.revision}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeAdapterError(error: unknown, physicalRoot: string): string {
  const message = error instanceof Error ? error.message : "unknown adapter error";
  return message.split(physicalRoot).join("<workspace>").slice(0, 1_000);
}

function isDataObject(value: EvaluationDataValue): value is Readonly<Record<string, EvaluationDataValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
