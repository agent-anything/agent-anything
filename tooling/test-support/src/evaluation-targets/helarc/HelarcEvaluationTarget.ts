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
import { Runner, type RunTreeLimits } from "@agent-anything/agent-runtime/runner";
import { CurrentVerificationCompletionGate } from "@agent-anything/verification/completion";
import type {
  VerificationExecutionFactory,
  VerificationExecutionPort,
} from "@agent-anything/verification/execution";
import type { VerificationEvaluationProjection } from "@agent-anything/verification/projection";
import { createRunFailureCause, type RunFinalizationContext, type RunResult } from "@agent-anything/agent-runtime/run";
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
  snapshotEvaluationData,
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
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
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
  type HostRunStatusProjection,
} from "@agent-anything/host/run";
import {
  createHelarcProductComposition,
  type HelarcProductResult,
  validateHelarcToolInput,
} from "@agent-anything/helarc/composition";
import type { CreateHelarcAgentInput } from "@agent-anything/helarc/agent";
import type { HelarcProductRunProjection } from "@agent-anything/helarc/run";
import {
  createHelarcProviderProfile,
  resolveHelarcPermissionPreset,
  type HelarcPermissionPreset,
} from "@agent-anything/helarc/configuration";
import {
  createHelarcContextProjectionConfiguration,
  type HelarcAgentOutput,
} from "@agent-anything/helarc/controller";
import {
  HELARC_SHELL_BINDING,
  HELARC_SHELL_OPERATION,
  HELARC_TASK_STOP_BINDING,
  HELARC_TASK_STOP_OPERATION,
} from "@agent-anything/helarc/tools";
import { bindHelarcVerificationCompletionGate } from "@agent-anything/helarc/verification";
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
import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import { providerResponseUsage } from "@agent-anything/model-interaction";
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
import { FakeNativeToolProvider } from "../../provider/FakeNativeToolProvider.js";
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

type HelarcMainInstructionTarget = CreateHelarcAgentInput["target"];

export interface HelarcEvaluationWorkspaceSnapshot {
  readonly files: readonly HelarcEvaluationFixtureFile[];
}

interface ApprovalDecisionRecord {
  readonly decision: "decline" | null;
}

interface HelarcEvaluationLeaseMaterial {
  readonly trialRef: EvaluationRecordRef;
  readonly caseDefinition: HelarcEvaluationCaseDefinition;
  readonly root: string;
  readonly before: HelarcEvaluationWorkspaceSnapshot;
}

export interface HelarcEvaluationExecutableCase {
  readonly scenario: string;
  readonly definition: HelarcEvaluationCaseDefinition["definition"];
  readonly fixture: HelarcEvaluationCaseDefinition["fixture"];
  readonly script: HelarcEvaluationCaseDefinition["script"];
  readonly expectedClaim: HelarcEvaluationCaseDefinition["expectedClaim"];
  readonly verificationTargets: HelarcEvaluationCaseDefinition["verificationTargets"];
}

export interface HelarcEvaluationRunOptions {
  readonly instructionTarget?: HelarcMainInstructionTarget;
  readonly provider?: Provider;
  readonly interactionAnswers?: Readonly<Record<string, string>>;
  readonly now?: () => string;
  readonly maxDurationMs?: number;
  readonly maxIterations?: number;
  readonly maxActions?: number;
  readonly runTreeLimits?: RunTreeLimits;
}

export interface HelarcEvaluationRunMaterial<
  TCase extends HelarcEvaluationExecutableCase = HelarcEvaluationCaseDefinition,
> {
  readonly trialRef: EvaluationRecordRef;
  readonly instructionTarget: HelarcMainInstructionTarget;
  readonly observationRef: EvaluationRecordRef;
  readonly environmentRef: EvaluationRecordRef;
  readonly caseDefinition: TCase;
  readonly product: HelarcProductResult;
  readonly productProjection: HelarcProductRunProjection;
  readonly runResult: RunResult<HelarcAgentOutput>;
  readonly hostProjection: HostRunStatusProjection;
  readonly verificationEvaluationProjection: VerificationEvaluationProjection;
  readonly runtimeEvents: readonly RuntimeEvent[];
  readonly trace: RunTrace;
  readonly before: HelarcEvaluationWorkspaceSnapshot;
  readonly after: HelarcEvaluationWorkspaceSnapshot;
  readonly approval: ApprovalDecisionRecord;
  readonly providerRequests: readonly ProviderRequest[];
  readonly providerResults: readonly ProviderCallResult[];
  readonly providerWasScripted: boolean;
  readonly actionNames: readonly string[];
  readonly retryCount: number;
  readonly interactionSubmissionCount: number;
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
  const captures = new Map<string, HelarcEvaluationRunMaterial>();

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

export async function executeHelarcEvaluationCase<
  TCase extends HelarcEvaluationExecutableCase,
>(input: {
  readonly trial: EvaluationTrial;
  readonly caseDefinition: TCase;
  readonly provider?: Provider;
  readonly instructionTarget?: HelarcMainInstructionTarget;
  readonly signal: AbortSignal;
  readonly interactionAnswers?: Readonly<Record<string, string>>;
  readonly now?: () => string;
  readonly maxDurationMs?: number;
  readonly maxIterations?: number;
  readonly maxActions?: number;
  readonly runTreeLimits?: RunTreeLimits;
}): Promise<HelarcEvaluationRunMaterial<TCase>> {
  let root: string | null = null;
  try {
    root = await mkdtemp(join(tmpdir(), "agent-anything-helarc-product-eval-"));
    for (const file of input.caseDefinition.fixture.files) {
      const target = resolveFixturePath(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const before = await snapshotWorkspace(root);
    return await invokeHelarcTarget(
      input.trial,
      Object.freeze({
        trialRef: input.trial.ref,
        caseDefinition: input.caseDefinition,
        root,
        before,
      }),
      input.signal,
      {
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.instructionTarget === undefined
          ? {}
          : { instructionTarget: input.instructionTarget }),
        ...(input.interactionAnswers === undefined
          ? {}
          : { interactionAnswers: input.interactionAnswers }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.maxDurationMs === undefined
          ? {}
          : { maxDurationMs: input.maxDurationMs }),
        ...(input.maxIterations === undefined
          ? {}
          : { maxIterations: input.maxIterations }),
        ...(input.maxActions === undefined ? {} : { maxActions: input.maxActions }),
        ...(input.runTreeLimits === undefined
          ? {}
          : { runTreeLimits: input.runTreeLimits }),
      },
    );
  } finally {
    if (root !== null) await rm(root, { recursive: true, force: true });
  }
}

async function invokeHelarcTarget<TCase extends HelarcEvaluationExecutableCase>(
  trial: EvaluationTrial,
  lease: Omit<HelarcEvaluationLeaseMaterial, "caseDefinition"> & {
    readonly caseDefinition: TCase;
  },
  signal: AbortSignal,
  options: HelarcEvaluationRunOptions = {},
): Promise<HelarcEvaluationRunMaterial<TCase>> {
  const caseDefinition = lease.caseDefinition;
  const providerWasScripted = options.provider === undefined;
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
      name: providerWasScripted ? "Phase26 fixture" : "Helarc Evaluation fixture",
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
      displayName: providerWasScripted ? "Phase26 Evaluation" : "Helarc Evaluation",
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

  const clock = options.now === undefined
    ? createLogicalClock(trial.repetitionOrdinal)
    : Object.freeze({ now: options.now });
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
  const selectedProvider = options.provider ?? new FakeNativeToolProvider({
    descriptor: {
      id: "helarc-deterministic-scripted-provider",
      name: "Helarc deterministic scripted Provider",
      metadata: { evaluation: true },
    },
    steps: caseDefinition.script.steps,
  });
  const providerRequests: ProviderRequest[] = [];
  const providerResults: ProviderCallResult[] = [];
  const provider: Provider = Object.freeze({
    descriptor: selectedProvider.descriptor,
    inputAccounting: selectedProvider.inputAccounting,
    async send(
      request: ProviderRequest,
      context: Parameters<Provider["send"]>[1],
    ) {
      providerRequests.push(request);
      const result = await selectedProvider.send(request, context);
      providerResults.push(result);
      return result;
    },
  });
  const fileActions = createHelarcLocalFileActionCapability({
    workspace: runContext.workspace,
    now: clock.now,
  });
  const commandActions = await createHelarcLocalCommandActionCapability({
    workspace: runContext.workspace,
    platform: process.platform === "win32" ? "win32" : "posix",
    shellOperation: HELARC_SHELL_OPERATION,
    shellBinding: HELARC_SHELL_BINDING,
    taskStopOperation: HELARC_TASK_STOP_OPERATION,
    taskStopBinding: HELARC_TASK_STOP_BINDING,
    now: clock.now,
  });
  const providerProfile = createHelarcProviderProfile({
    id: "helarc-evaluation-provider",
    providerKind: selectedProvider.descriptor.id === "ollama.api"
      ? "ollama"
      : "openai-compatible",
    displayName: "Helarc Evaluation Provider",
    baseUrl: "https://evaluation-provider.local/v1",
    model: provider.inputAccounting.model,
    timeoutMs: 30_000,
    credentialStatus: "empty_allowed",
    qualificationPolicy: "allow_experimental",
    isActive: true,
  });
  if (!providerProfile.ok) {
    throw new TypeError("Helarc Evaluation Provider profile is invalid.");
  }
  const product = await createHelarcProductComposition({
    instructionTarget: options.instructionTarget ?? "production",
    runId: productRunId,
    task: taskResult.task,
    workspace: runContext.workspace,
    provider,
    providerProfile: providerProfile.profile,
    codeSource: createLocalCodeSourcePort(clock.now),
    fileActions,
    commandActions,
    verificationTargets: bindVerificationTargets(
      caseDefinition.verificationTargets,
      workspace.primary.id,
    ),
    now: clock.now,
  });
  const gateway = createHelarcLocalSandboxGateway({
    executors: product.actions.executors,
    providers: [],
  });
  let trace: RunTrace | null = null;
  const runtimeEvents: RuntimeEvent[] = [];
  const runtimePublisher: RuntimeEventPublisher = Object.freeze({
    publish(event: RuntimeEvent) {
      runtimeEvents.push(event);
      product.recordRuntimeEvent(event);
    },
  });
  let allocatedRunCount = 0;
  const verificationExecutions = new Map<string, VerificationExecutionPort>();
  const verification = bindHelarcVerificationCompletionGate(
    product.verification,
    new CurrentVerificationCompletionGate(clock.now),
  );
  const verificationFactory: VerificationExecutionFactory = Object.freeze({
    async create(input: Parameters<VerificationExecutionFactory["create"]>[0]) {
      const execution = await verification.executionFactory.create(input);
      verificationExecutions.set(input.run.id, execution);
      return execution;
    },
  });
  const runner = new Runner({
    controller: product.controller,
    contextProjection: createHelarcContextProjectionConfiguration(
      provider.inputAccounting,
      product.controllerProtocol,
    ),
    completion: {
      taskFulfillment: product.taskFulfillment,
      maximumDurationMs: 15_000,
    },
    operations: {
      catalog: product.actions.operationCatalog,
      bindings: product.actions.operationBindings,
      validateToolInput: validateHelarcToolInput,
      delegation: product.delegation,
      internalHandlers: [],
      availability: product.actions.operationAvailability,
      actionExecution: {
        registrations: product.actions.registrations,
        adapters: product.actions.adapters,
        policy: createAllowAllActionPolicyPort(clock.now),
        sandbox: gateway,
        records: createEvaluationActionRecordPort(trial.ref.id),
        retry: createEvaluationActionRetryPort(),
      },
    },
    verification: Object.freeze({
      ...verification,
      executionFactory: verificationFactory,
    }),
    interactions: product.interactions,
    runtimeEventPublisher: runtimePublisher,
    runTraceObserver: {
      observe(candidate) {
        trace = candidate;
      },
    },
    resourceFinalizers: Object.freeze([Object.freeze({
      async finalize(context: RunFinalizationContext) {
        return await commandActions.processTasks.finalizeRun(context.runId)
          ? null
          : createRunFailureCause("runtime", Object.freeze({
              code: "runtime_process_cleanup_failed",
              message: "Evaluation Run process cleanup could not be confirmed.",
              retryable: false,
              metadata: Object.freeze({ runId: context.runId }),
            }));
      },
    })]),
    now: clock.now,
    createRunId: () => {
      allocatedRunCount += 1;
      return allocatedRunCount === 1
        ? `${trial.ref.id}.harness-run`
        : `${trial.ref.id}.harness-run.${allocatedRunCount}`;
    },
    createId: ({ runId, kind, sequence }) => `${runId}.${kind}.${sequence}`,
  });
  const manager = createHostRunManager({ runner, now: clock.now });
  const configurationFingerprint = await createCanonicalSha256Digest(
    providerWasScripted
      ? "agent-anything.helarc.phase26-environment.v1"
      : "agent-anything.helarc.product-effectiveness-environment.v1",
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
      verification: Object.freeze({
        profile: product.verification.profile,
        completion: createEvaluationVerificationCompletionConfig(),
      }),
      limits: {
        maxIterations: options.maxIterations ?? 8,
        maxActions: options.maxActions ?? 8,
        maxConsecutiveActionFailures: 1,
        maxDurationMs: options.maxDurationMs ?? 30_000,
        maxPendingInteractions: 4,
        plan: {
          maxSteps: 12,
          maxStepLength: 300,
          maxExplanationLength: 1_000,
        },
        progress: {
          checkpointWindowSize: 6,
          nonAdvancingCheckpointThreshold: 3,
          maxCorrectionRounds: 2,
        },
      },
      runTreeLimits: options.runTreeLimits ?? {
        maxTotalDescendantRuns: 0,
        maxActiveDescendantRuns: 0,
        maxDescendantDepth: 0,
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
  const onAbort = () => {
    active.cancel({
      origin: "host",
      reasonCode: "host_requested",
      reason: "Evaluation Trial cancelled the active Helarc Run.",
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let interactionSubmissionCount = 0;
  const submittedInteractions = new Set<string>();
  const submitConfiguredInteractions = (
    projection: ReturnType<typeof active.getProjection>,
  ): void => {
    if (options.interactionAnswers === undefined) return;
    for (const pending of projection.pendingInteractions) {
      if (pending.phase !== "pending" || submittedInteractions.has(pending.request.id)) continue;
      const payload = createEvaluationInteractionSubmission(
        pending.presentation,
        options.interactionAnswers,
      );
      if (payload === null) continue;
      submittedInteractions.add(pending.request.id);
      const outcome = active.submitInteraction({
        request: pending.request,
        submissionId: `${trial.ref.id}.interaction.${pending.request.id}`,
        payload,
      });
      if (outcome.status === "accepted_for_resolution") interactionSubmissionCount += 1;
    }
  };
  const unsubscribeInteractions = options.interactionAnswers === undefined
    ? () => undefined
    : active.subscribe(submitConfiguredInteractions);
  submitConfiguredInteractions(active.getProjection());
  const hostResult = await active.wait().finally(() => {
    signal.removeEventListener("abort", onAbort);
    unsubscribeInteractions();
  });
  const terminalProjection = active.getProjection();
  const verificationExecution = verificationExecutions.get(hostResult.runResult.runId);
  if (verificationExecution === undefined) {
    throw new TypeError("Helarc Evaluation requires the root Verification execution.");
  }
  const productResult = product.projectResult(
    hostResult.runResult,
    "disabled",
    terminalProjection.verification,
  );
  if (trace === null) throw new TypeError("Helarc Evaluation requires one complete RunTrace.");
  const observationRef = createEvaluationRecordRef({
    id: `${trial.ref.id}.observation`,
    revision: trial.ref.revision,
  });
  return Object.freeze({
    trialRef: trial.ref,
    instructionTarget: options.instructionTarget ?? "production",
    observationRef,
    environmentRef: createEvaluationRecordRef({
      id: `${trial.ref.id}.environment`,
      revision: trial.ref.revision,
    }),
    caseDefinition,
    product: productResult,
    productProjection: product.getProductProjection(),
    runResult: hostResult.runResult,
    hostProjection: terminalProjection,
    verificationEvaluationProjection: await verificationExecution.projectEvaluation(),
    runtimeEvents: Object.freeze([...runtimeEvents]),
    trace,
    before: lease.before,
    after: await snapshotWorkspace(lease.root),
    approval: approval.record,
    providerRequests: Object.freeze([...providerRequests]),
    providerResults: Object.freeze([...providerResults]),
    providerWasScripted,
    actionNames: collectObservedToolNames(
      hostResult.runResult,
      product.actions.toolSelection,
    ),
    retryCount: terminalProjection.retry?.scheduledCount ?? 0,
    interactionSubmissionCount,
  });
}

function createEvaluationInteractionSubmission(
  presentation: unknown,
  answers: Readonly<Record<string, string>>,
): unknown | null {
  if (!isPlainRecord(presentation) || !Array.isArray(presentation.questions)) return null;
  const normalized = presentation.questions.map((candidate) => {
    if (!isPlainRecord(candidate) || typeof candidate.id !== "string") return null;
    const answer = answers[candidate.id];
    if (typeof answer !== "string" || answer.trim().length === 0) return null;
    return Object.freeze({
      question_id: candidate.id,
      selected_labels: Object.freeze([]),
      text: answer.trim(),
    });
  });
  if (normalized.some((answer) => answer === null)) return null;
  return Object.freeze({ answers: Object.freeze(normalized) });
}

function bindVerificationTargets(
  targets: HelarcEvaluationCaseDefinition["verificationTargets"],
  primaryWorkspaceId: string,
): HelarcEvaluationCaseDefinition["verificationTargets"] {
  return Object.freeze(targets.map((requirement) => Object.freeze({
    ...requirement,
    target: Object.freeze({
      ...requirement.target,
      expected: Object.freeze({
        ...requirement.target.expected,
        target: Object.freeze({
          ...requirement.target.expected.target,
          rootName: primaryWorkspaceId,
          workspaceId: primaryWorkspaceId,
        }),
      }),
    }),
  })));
}

function createEvaluationVerificationCompletionConfig() {
  const owner = (id: string) => Object.freeze({
    owner: "helarc-evaluation",
    kind: "verification",
    id,
    revision: "1",
  });
  return Object.freeze({
    policy: owner("current-verification-gate"),
    outputContract: owner("helarc-output-contract"),
    conditions: Object.freeze([]),
    maximumDurationMs: 1_000,
  });
}

function targetObservation(
  material: HelarcEvaluationRunMaterial,
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
  material: HelarcEvaluationRunMaterial,
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
  material: HelarcEvaluationRunMaterial,
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
    if (payload.kind === "tool_rejected") return "tools";
    if (payload.kind === "operation") return payload.result.failure?.owner ?? null;
    if (payload.kind === "interaction") return payload.owner;
    if (payload.kind === "descendant_run") return payload.failure?.owner ?? "agent-runtime";
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
    if (payload.kind === "tool_rejected") return payload.code;
    if (payload.kind === "operation") return payload.result.failure?.code ?? null;
    if (payload.kind === "interaction" && payload.status !== "resolved") {
      return `interaction_${payload.status}`;
    }
    if (payload.kind === "descendant_run" && payload.status !== "succeeded") {
      return payload.failure?.code ?? `descendant_run_${payload.status}`;
    }
  }
  return null;
}

function collectObservedToolNames(
  result: RunResult<HelarcAgentOutput>,
  selection: ToolSelectionRevision,
): readonly string[] {
  const namesByTool = new Map(selection.tools.map((selected) => [
    `${selected.registration.descriptor.ref.tool.namespace}:${selected.registration.descriptor.ref.tool.name}@${selected.registration.descriptor.ref.revision}`,
    selected.registration.descriptor.name,
  ]));
  const namesByOperation = new Map(selection.tools.flatMap((selected) =>
    selected.registration.binding.kind === "operation"
      ? [[
          operationRevisionKey(selected.registration.binding.operation.operation.ref),
          selected.registration.descriptor.name,
        ] as const]
      : []
  ));
  const observedNames = new Set<string>();

  for (const item of result.items) {
    if (item.payload.kind !== "observation") continue;
    const payload = item.payload.observation.payload;
    if (payload.kind === "operation") {
      const name = namesByOperation.get(operationRevisionKey(payload.result.binding.operation));
      if (name !== undefined) observedNames.add(name);
    }
    const toolResult = payload.kind === "operation" ||
        payload.kind === "interaction" || payload.kind === "descendant_run"
      ? payload.toolResult
      : null;
    if (toolResult === null) continue;
    const ref = toolResult.toolCall.toolRevision;
    const name = namesByTool.get(`${ref.tool.namespace}:${ref.tool.name}@${ref.revision}`);
    if (name !== undefined) observedNames.add(name);
  }

  return Object.freeze([...observedNames].sort());
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
  material: HelarcEvaluationRunMaterial,
) {
  const runItems = material.runResult.items;
  const actionNames = material.actionNames;
  const retryCount = material.retryCount;
  const totalUsage = material.providerResults
    .reduce((totals, result) => {
      const usage = result.kind === "succeeded"
        ? providerResponseUsage(result.response)
        : null;
      return {
        input: totals.input + (usage?.inputTokens ?? 0),
        output: totals.output + (usage?.outputTokens ?? 0),
        total: totals.total + (usage?.totalTokens ?? 0),
      };
    }, { input: 0, output: 0, total: 0 });
  const traceDuration = material.trace.startedAt !== null && material.trace.completedAt !== null
    ? Math.max(0, Date.parse(material.trace.completedAt) - Date.parse(material.trace.startedAt))
    : 0;
  const exposureTurns = runItems.flatMap(({ payload }) => payload.kind === "controller_turn"
    ? [Object.freeze({
        status: payload.status,
        decisionKind: payload.decisionKind,
        selectionRevision: payload.toolExposure.selectionRevision,
        contentRevision: payload.toolExposure.contentRevision,
        basisRevision: payload.toolExposure.basisRevision,
        proofId: payload.toolExposure.proofId,
        manifestId: payload.toolExposure.manifestId,
        catalogRevision: payload.toolExposure.catalogRevision,
        exposedTools: payload.toolExposure.exposedTools.map((ref) =>
          `${ref.tool.namespace}.${ref.tool.name}@${ref.revision}`
        ),
        exposedToolCount: payload.toolExposure.exposedToolCount,
        omittedToolCount: payload.toolExposure.omittedToolCount,
        omissionReasons: payload.toolExposure.omissionReasons,
      })]
    : []);
  const contributions: EvaluationCaptureContribution[] = [
    captured("product-outcome", "helarc.product", {
      status: material.product.status,
      runtimeStatus: material.product.output.runtimeStatus,
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
    captured(
      "verification-summary",
      "verification",
      snapshotEvaluationData(material.verificationEvaluationProjection),
    ),
    captured("tool-exposure-summary", "agent-core", {
      turns: exposureTurns,
      turnCount: exposureTurns.length,
      minimumExposedToolCount: exposureTurns.length === 0
        ? 0
        : Math.min(...exposureTurns.map(({ exposedToolCount }) => exposedToolCount)),
      maximumExposedToolCount: exposureTurns.length === 0
        ? 0
        : Math.max(...exposureTurns.map(({ exposedToolCount }) => exposedToolCount)),
      omittedToolCount: exposureTurns.reduce(
        (count, { omittedToolCount }) => count + omittedToolCount,
        0,
      ),
    }),
  ];
  const measurements: EvaluationMeasurement[] = [
    measurement("latency_ms", "runtime", "run-trace", "ms", traceDuration),
    measurement("input_tokens", "provider", "provider-usage", "tokens", totalUsage.input),
    measurement("output_tokens", "provider", "provider-usage", "tokens", totalUsage.output),
    measurement("total_tokens", "provider", "provider-usage", "tokens", totalUsage.total),
    ...(material.providerWasScripted
      ? [measurement("cost", "provider", "scripted-provider", "currency_units", 0)]
      : []),
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
    measurement("controller_turn_count", "agent-core", "controller-turns", "count", exposureTurns.length),
    measurement(
      "exposed_tool_count",
      "agent-core",
      "controller-turns",
      "count",
      exposureTurns.reduce((count, { exposedToolCount }) => count + exposedToolCount, 0),
    ),
    measurement(
      "omitted_tool_count",
      "agent-core",
      "controller-turns",
      "count",
      exposureTurns.reduce((count, { omittedToolCount }) => count + omittedToolCount, 0),
    ),
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
    limitations: [TARGET_LIMITATION],
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

function workspaceCapture(snapshot: HelarcEvaluationWorkspaceSnapshot) {
  return Object.freeze({
    files: Object.freeze(snapshot.files.map((file) => Object.freeze({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
    }))),
  });
}

async function snapshotWorkspace(root: string): Promise<HelarcEvaluationWorkspaceSnapshot> {
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

function readTaskText(caseDefinition: HelarcEvaluationExecutableCase): string {
  const targetInput = caseDefinition.definition.targetInput;
  const value = isDataObject(targetInput)
    ? targetInput.taskText ?? targetInput.task
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

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
