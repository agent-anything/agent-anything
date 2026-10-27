import type { AgentDefinition } from "@agent-anything/agent-core/agent";
import { snapshotToolResultPresenters } from "./ToolResultPresenter.js";
import { publishRunObservation } from "./RunObserver.js";
import { publishRunExecutionObservation } from "./RunExecutionObserver.js";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { RunLineage } from "@agent-anything/agent-core/run-tree";
import type {
  RunTraceObserver,
  RuntimeEventPublisher,
} from "@agent-anything/observability";
import type { ExecutionFlowOccurrenceRef } from "@agent-anything/observability/execution-flow";
import {
  createRunResult,
  createRunCancellationController,
  type RunSettlementCauseRecord,
  type RunResult,
} from "../run/index.js";
import { createRunFailureCause } from "../run/RunFailure.js";
import { createSystemRetryExecutor } from "../retry/createSystemRetryExecutor.js";
import {
  ActiveRunHandle,
  type RunHandle,
} from "./RunHandle.js";
import {
  RunExecution,
  type RuntimeDescendantRunAdmissionInput,
  type RuntimeDescendantRunAdmissionResult,
  type RuntimeDescendantRunLaunchResult,
} from "./RunExecution.js";
import type {
  ResolvedRunConfig,
  RootRunConfig,
  RunConfig,
  ValidatedRunConfig,
} from "./RunConfig.js";
import { projectRunTreeTerminal, RunTreeExecution } from "./RunTreeExecution.js";
import { RunTreeCommitWriter } from "./RunTreeCommitWriter.js";
import { RunRecoveryError, retainedRunResult, type RunRecoveryBindings } from "./RunRecovery.js";
import { restoreRunConfiguration } from "./RunConfigurationCheckpoint.js";
import type { RunCommit } from "./RunCommitPort.js";
import { canonicalEncode } from "@agent-anything/canonical-action/subject";
import type {
  CreateRunIdentityInput,
  ResolvedExecutionCoordinatorDependencies,
  RunInvocationOptions,
  RunExecutionCoordinatorDependencies,
} from "./RunExecutionCoordinatorDependencies.js";
import {
  snapshotContextProjectionRequest,
} from "@agent-anything/context/projection";
import {
  assessDelegationContextConstruction,
} from "../delegation/DelegationContextConstruction.js";
import {
  deriveDelegatedRunConfig,
  projectDelegationRunAuthority,
} from "../delegation/DelegationRunConfiguration.js";
import {
  type RunTreeResourceAmounts,
} from "./RunTreeResourceAccount.js";
import {
  snapshotDelegationExecutionConstraints,
  snapshotDelegationLimitDerivation,
  snapshotDelegationRequest,
  type DelegationContextMaterial,
  type DelegationRequest,
} from "../delegation/index.js";
import { measureDelegationInitialContextBytes } from "../context-contribution/index.js";
import {
  snapshotAgentDefinition,
  snapshotRunConfig,
  snapshotRootRunConfig,
  snapshotRunInput,
} from "./RunnerValidation.js";

export class RunExecutionCoordinator {
  private readonly dependencies: ResolvedExecutionCoordinatorDependencies;
  private readonly activeRunIds = new Set<string>();
  private readonly recoveringRunIds = new Set<string>();

  constructor(dependencies: RunExecutionCoordinatorDependencies) {
    if (!dependencies.taskDecisions || typeof dependencies.taskDecisions.next !== "function") {
      throw new TypeError("Runner requires a Controller.");
    }
    const now = dependencies.now ?? (() => new Date().toISOString());
    if (dependencies.runCommits && dependencies.runTreeCommits) {
      throw new TypeError("Run persistence must use one commit owner.");
    }
    const contextProjection = snapshotRunnerContextProjection(
      dependencies.contextProjection,
    );
    const operations = snapshotRunnerOperationComposition(dependencies.operations);
    this.dependencies = Object.freeze({
      ...dependencies,
      contextProjection,
      operations,
      now,
      createRunId: dependencies.createRunId ?? createDefaultRunIdentity,
      createId: dependencies.createId ?? createDefaultIdentity,
      retryExecutor: dependencies.retryExecutor ?? createSystemRetryExecutor({
        now: () => new Date(now()),
      }),
    });
  }

  start<TOutput>(
    agent: AgentDefinition<TOutput>,
    input: RunInput,
    config: RootRunConfig,
    options: RunInvocationOptions = {},
  ): RunHandle<TOutput> {
    const configuredPublishers = runtimeEventPublishers(
      this.dependencies.runtimeEventPublisher,
      options.runtimeEventPublisher,
    );
    const configuredObservers = runTraceObservers(
      this.dependencies.runTraceObserver,
      options.runTraceObserver,
    );
    const agentSnapshot = snapshotAgentDefinition(agent);
    const inputSnapshot = snapshotRunInput(input);
    const configSnapshot = snapshotRootRunConfig(config);
    if (!configSnapshot.valid) {
      throw new TypeError(configSnapshot.failure.message);
    }
    validateActionComposition(this.dependencies, configSnapshot.config);
    validateRunTreeMetering(
      configSnapshot.config.runTreeResources,
      this.dependencies.taskDecisions.resourceMetering,
    );

    const runId = this.dependencies.createRunId();
    assertNonEmpty(runId, "Runner-created runId");
    if (this.activeRunIds.has(runId)) {
      throw new TypeError(`Runner-created runId '${runId}' is already active.`);
    }
    const startedAt = this.dependencies.now();
    const deadlineAt = localDeadline(startedAt, configSnapshot.config.limits.maxDurationMs);
    const tree = new RunTreeExecution({
      rootRunId: runId,
      startedAt,
      deadlineAt,
      limits: configSnapshot.config.runTreeLimits,
      resources: configSnapshot.config.runTreeResources,
      approvals: configSnapshot.config.runTreeApprovals,
      rootAuthorityRevision: `${runId}:authority`,
      now: this.dependencies.now,
    });
    const ordinaryConfig = snapshotRunConfig(configSnapshot.config);
    if (!ordinaryConfig.valid) {
      throw new TypeError(ordinaryConfig.failure.message);
    }
    return this.startPreparedRun(
      runId,
      agentSnapshot,
      inputSnapshot,
      ordinaryConfig.config,
      inputSnapshot.task,
      ordinaryConfig.config,
      null,
      Object.freeze([]),
      null,
      tree.rootLineage,
      tree,
      measureInitialRunContextBytes(inputSnapshot),
      startedAt,
      deadlineAt,
      configuredPublishers,
      configuredObservers,
      options.actionExecutionObserver,
      options.executionFlow,
      this.dependencies.runCommits ? undefined :
        new RunTreeCommitWriter(tree.checkpoint(), this.dependencies.runTreeCommits ?? null, this.dependencies.now),
    ).handle;
  }

  run<TOutput>(
    agent: AgentDefinition<TOutput>,
    input: RunInput,
    config: RootRunConfig,
    options: RunInvocationOptions = {},
  ): Promise<RunResult<TOutput>> {
    return this.start(agent, input, config, options).wait();
  }

  async recover(rootRunId: string, bindings: RunRecoveryBindings, options: RunInvocationOptions = {}): Promise<RunHandle> {
    if (this.activeRunIds.has(rootRunId) || this.recoveringRunIds.has(rootRunId)) {
      throw new RunRecoveryError(rootRunId, "run_already_active", rootRunId);
    }
    this.recoveringRunIds.add(rootRunId);
    const recoveryId = `${rootRunId}:recovery:${globalThis.crypto.randomUUID()}`;
    const observe = (stage: "requested" | "activated" | "unavailable", code: string | null, checkpointId: string | null = null, revision: number | null = null) =>
      publishRunExecutionObservation(this.dependencies.executionObserver, {kind: "execution_recovery", runId: rootRunId,
        recoveryId, stage, code, checkpointId, revision, occurredAt: this.dependencies.now()});
    observe("requested", null);
    try {
      const {handle, checkpoint} = await this.recoverOwned(rootRunId, bindings, options);
      observe("activated", null, checkpoint.id, checkpoint.revision);
      return handle;
    }
    catch (error) {observe("unavailable", error instanceof RunRecoveryError ? error.code : "recovery_binding_or_storage_unavailable"); throw error;}
    finally { this.recoveringRunIds.delete(rootRunId); }
  }

  private async recoverOwned(rootRunId: string, bindings: RunRecoveryBindings, options: RunInvocationOptions): Promise<{
    readonly handle: RunHandle;
    readonly checkpoint: {readonly id: string; readonly revision: number};
  }> {
    if (!this.dependencies.runTreeCommits) throw new RunRecoveryError(rootRunId, "execution_store_unavailable", rootRunId);
    if (this.activeRunIds.has(rootRunId)) throw new RunRecoveryError(rootRunId, "run_already_active", rootRunId);
    const writer = await RunTreeCommitWriter.recover(rootRunId, this.dependencies.runTreeCommits, this.dependencies.now);
    const records = writer?.getSnapshot();
    if (!writer || !records) throw new RunRecoveryError(rootRunId, "run_not_found", rootRunId);
    const checkpoint = {id: records.commit.id, revision: records.commit.revision};
    const member = records.members.find(entry => entry.head.state.run.id === rootRunId);
    if (!member || member.admission.lineage.kind !== "root") throw new TypeError("Root admission is unavailable.");
    const retainedResult = retainedRunResult(member.head.state);
    if (retainedResult) {
      const handle = new ActiveRunHandle(rootRunId, createRunCancellationController({runId: rootRunId,
        now: this.dependencies.now}), retainedResult, writer.tree.getSnapshot(), () => {});
      handle.start(async () => retainedResult);
      return {handle, checkpoint};
    }
    const rootBinding = await bindings.resolve(member);
    const normalizedRoot = snapshotRunConfig(rootBinding.config);
    if (!normalizedRoot.valid) throw new TypeError(normalizedRoot.failure.message);
    const rootConfig = restoreRunConfiguration(member.admission.rootConfig, normalizedRoot.config);
    const prepared = new Map<string, {handle: RunHandle; execution: RunExecution<unknown> | null;
      getTerminalFlowOccurrence: () => ExecutionFlowOccurrenceRef | null; activate: () => void}>();
    // Construct every owner and route before permitting any member to advance.
    for (const retained of records.members) {
      const {head, admission} = retained;
      const runId = head.state.run.id;
      if (this.activeRunIds.has(runId)) throw new RunRecoveryError(runId, "run_already_active", runId);
      const terminal = retainedRunResult(head.state);
      if (terminal) {
        const handle = new ActiveRunHandle(runId, createRunCancellationController({runId,
          ...(head.control.cancellation ? {retainedRequest: head.control.cancellation} : {}),
          now: this.dependencies.now, createRequestId: () => `${runId}:settled-cancellation`}),
          terminal, writer.tree.getSnapshot(), () => {});
        prepared.set(runId, {handle, execution: null, getTerminalFlowOccurrence: () => null,
          activate: () => handle.start(async () => terminal)});
        continue;
      }
      const trusted = runId === rootRunId ? rootBinding : await bindings.resolve(retained);
      const agent = snapshotAgentDefinition(trusted.agent);
      const {output: _output, ...definition} = agent;
      const expected = canonicalEncode("run-agent-definition.v1", head.control.agentDefinition);
      const actual = canonicalEncode("run-agent-definition.v1", definition);
      if (expected.length !== actual.length || expected.some((value, index) => actual[index] !== value)) {
        throw new RunRecoveryError(runId, "agent_definition_unavailable", agent.id);
      }
      const normalized = snapshotRunConfig(trusted.config);
      if (!normalized.valid) throw new TypeError(normalized.failure.message);
      const config = restoreRunConfiguration(admission.config, normalized.config);
      restoreRunConfiguration(admission.rootConfig, rootConfig);
      validateActionComposition(this.dependencies, config);
      prepared.set(runId, this.startPreparedRun(runId, agent, admission.input, config,
        admission.rootTask, rootConfig, admission.delegationRequest, admission.delegationContextMaterials,
        admission.modelInteractionSeed, admission.lineage, writer.tree, head.control.contextPayloadBytes,
        head.state.startedAt, head.state.deadlineAt,
        runtimeEventPublishers(this.dependencies.runtimeEventPublisher, options.runtimeEventPublisher),
        runTraceObservers(this.dependencies.runTraceObserver, options.runTraceObserver),
        options.actionExecutionObserver, options.executionFlow, writer, true, head));
    }
    for (const retained of records.members) {
      const {lineage, delegationRequest, modelInteractionSeed} = retained.admission;
      if (lineage.kind !== "descendant") continue;
      const parent = prepared.get(lineage.parent.id)!;
      if (!parent.execution) continue;
      const child = prepared.get(retained.head.state.run.id)!;
      const node = records.commit.checkpoint.nodes.find(value => value.runId === child.handle.runId)!;
      if (node.resultTransfer === "not_required") continue;
      const parentHead = records.members.find(value => value.head.state.run.id === lineage.parent.id)!.head;
      const action = parentHead.state.items.flatMap(item => item.payload.kind === "run_action" &&
        item.payload.action.ref.id === lineage.parentRunAction.id ? [item.payload.action] : [])[0];
      if (!action || !delegationRequest || !node.dispatch || !node.relationKind) {
        throw new RunRecoveryError(lineage.parent.id, "descendant_route_incomplete", child.handle.runId);
      }
      const resourceSettlement = child.handle.wait().then(() => {
        const value = writer.tree.getResourceSettlement(child.handle.runId);
        if (!value) throw new RunRecoveryError(child.handle.runId, "descendant_resources_unsettled", child.handle.runId);
        return value;
      });
      void resourceSettlement.catch(() => {});
      parent.execution.restoreDescendant({relation: {ref: lineage.relation, kind: node.relationKind,
        root: lineage.root, parent: lineage.parent, child: {id: child.handle.runId}, parentRunAction: lineage.parentRunAction,
        depth: lineage.depth}, request: delegationRequest, dispatch: node.dispatch, action, handle: child.handle,
        getTerminalFlowOccurrence: child.getTerminalFlowOccurrence, resourceSettlement, modelInteractionSeed});
    }
    const cancellations: Promise<unknown>[] = [];
    for (const retained of [...records.members].sort((a, b) => a.admission.lineage.depth - b.admission.lineage.depth)) {
      if (options.recoveryCancellation && prepared.get(retained.head.state.run.id)!.execution) {
        // cancel() requests synchronously; its receipt waits for startup's durable
        // cancellation transition. Awaiting it before activation would deadlock.
        cancellations.push(prepared.get(retained.head.state.run.id)!.handle.cancel(retained.admission.lineage.kind === "root"
          ? options.recoveryCancellation : {origin: "parent_run", reasonCode: "parent_run_cancelled", parentRunId: retained.admission.lineage.parent.id}));
      }
    }
    for (const retained of [...records.members].sort((a, b) => a.admission.lineage.depth - b.admission.lineage.depth)) {
      prepared.get(retained.head.state.run.id)!.activate();
    }
    await Promise.all(cancellations);
    return {handle: prepared.get(rootRunId)!.handle, checkpoint};
  }

  private async admitDescendant(
    input: RuntimeDescendantRunAdmissionInput,
    parentRunId: string,
    parentLineage: RunLineage,
    parentDeadlineAt: string,
    parentTask: AgentTask,
    parentConfig: RunConfig,
    rootTask: AgentTask,
    rootConfig: RunConfig,
    tree: RunTreeExecution,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: RunInvocationOptions["actionExecutionObserver"],
    treeCommits?: RunTreeCommitWriter,
  ): Promise<RuntimeDescendantRunAdmissionResult> {
    let request: DelegationRequest;
    let agent: AgentDefinition;
    let config: ValidatedRunConfig;
    let contextMaterials: readonly DelegationContextMaterial[];
    let contextBytes: number;
    let rejectionCode:
      | "delegation_request_invalid"
      | "delegation_authority_invalid"
      | "delegation_context_invalid" = "delegation_request_invalid";
    try {
      request = snapshotDelegationRequest(input.request);
      agent = snapshotAgentDefinition(input.agent);
      if (!sameAgentRevision(agent, request.childAgent)) {
        throw new TypeError("Delegation child Agent does not match the trusted request.");
      }
      if (
        request.origin.root.run.id !== tree.rootLineage.root.id ||
        request.origin.root.task.id !== rootTask.id ||
        request.origin.parent.run.id !== parentRunId ||
        request.origin.parent.task.id !== parentTask.id ||
        request.origin.parent.action.id !== input.parentRunAction.id ||
        request.origin.parent.action.sequence !== input.parentRunAction.sequence ||
        request.origin.parent.lineage.root.id !== parentLineage.root.id ||
        request.origin.parent.lineage.depth !== parentLineage.depth
      ) {
        throw new TypeError("Delegation origin does not match the authoritative Run Tree edge.");
      }
      rejectionCode = "delegation_authority_invalid";
      const authority = snapshotDelegationExecutionConstraints(input.authority);
      const limits = snapshotDelegationLimitDerivation(input.limits);
      if (
        request.authorityDerivation.id !== authority.ref.id ||
        request.authorityDerivation.revision !== authority.ref.revision ||
        request.limitDerivation.id !== limits.ref.id ||
        request.limitDerivation.revision !== limits.ref.revision ||
        request.limits.revision !== limits.effective.revision
      ) {
        throw new TypeError("Delegation request does not match its trusted derivations.");
      }
      const derivedConfig = deriveDelegatedRunConfig({
        parent: parentConfig,
        request,
        authority,
      });
      rejectionCode = "delegation_context_invalid";
      const contextAssessment = assessDelegationContextConstruction({
        request,
        materials: input.contextMaterials,
      });
      contextMaterials = contextAssessment.selected;
      contextBytes = measureDelegationInitialContextBytes({
        childTask: request.task,
        materials: contextAssessment.selected,
      });
      if (contextBytes > request.limits.maxContextBytes) {
        throw new TypeError("Delegation initial Context exceeds its effective limit.");
      }
      rejectionCode = "delegation_authority_invalid";
      const configSnapshot = snapshotRunConfig(Object.freeze({
        ...derivedConfig,
        metadata: Object.freeze({
          ...derivedConfig.metadata,
          omittedContextMaterials: contextAssessment.omitted.map((material) =>
            Object.freeze({ ...material })),
        }),
      }));
      if (!configSnapshot.valid) {
        throw new TypeError(configSnapshot.failure.message);
      }
      config = configSnapshot.config;
      validateActionComposition(this.dependencies, config);
    } catch {
      return Object.freeze({
        status: "rejected" as const,
        code: rejectionCode,
        treeRevision: tree.getSnapshot().revision,
      });
    }

    const startedAt = this.dependencies.now();
    if (treeCommits) {
      return treeCommits.transaction<RuntimeDescendantRunAdmissionResult>(({tree: draft}) => {
        const reservation = draft.reserveDescendant({
          relationId: input.relationId, relationKind: input.relationKind,
          createChildRunId: () => this.dependencies.createRunId(), parentRunId, parentLineage,
          parentRunAction: input.parentRunAction, parentDeadlineAt,
          childLocalDeadlineAt: localDeadline(startedAt, config.limits.maxDurationMs),
          resourceAllocation: delegationResourceAllocation(request.limits),
          authorityRevision: request.authorityDerivation.revision, dispatch: input.dispatch,
        });
        if (reservation.status === "rejected") return {runs: [], value: reservation};
        const childRunId = reservation.relation.child.id;
        const prepared = this.startPreparedRun(childRunId, agent,
          snapshotRunInput(createDelegatedRunInput({request, childRunId, startedAt})),
          config, rootTask, rootConfig, request, contextMaterials, input.modelInteractionSeed,
          reservation.lineage, tree, contextBytes, startedAt, reservation.deadlineAt,
          runtimeEventPublishers, runTraceObservers, actionExecutionObserver, input.executionFlow,
          treeCommits, true);
        const admission = prepared.execution.prepareAdmission(draft);
        let consumed = false;
        const activate = () => {
          if (consumed) throw new TypeError("A descendant admission can be consumed only once.");
          consumed = true;
          prepared.execution.acceptAdmission();
          prepared.activate();
        };
        const launch = (): RuntimeDescendantRunLaunchResult => {
          activate();
          const resourceSettlement = prepared.handle.wait().then(() => {
            const value = treeCommits.tree.getResourceSettlement(childRunId);
            if (!value) throw new TypeError("Descendant resources are not settled.");
            return value;
          });
          void resourceSettlement.catch(() => {});
          return {status: "started", relation: reservation.relation, handle: prepared.handle,
            getTerminalFlowOccurrence: prepared.getTerminalFlowOccurrence, resourceSettlement,
            reservedTreeRevision: reservation.treeRevision, treeRevision: treeCommits.tree.getSnapshot().revision};
        };
        const cancelBeforeLaunch = async (): Promise<RuntimeDescendantRunLaunchResult> => {
          const cancelled = prepared.handle.cancel({origin: "parent_run", reasonCode: "parent_run_cancelled", parentRunId});
          activate();
          await cancelled;
          await prepared.handle.wait();
          await treeCommits.transaction(({tree}) => {
            tree.settleDescendantTransfer(childRunId, "not_required");
            return {runs: [], value: undefined};
          });
          return {status: "rejected", code: "descendant_run_start_cancelled", relation: reservation.relation,
            reservedTreeRevision: reservation.treeRevision, treeRevision: treeCommits.tree.getSnapshot().revision};
        };
        return {runs: [admission], value: {status: "admitted" as const, relation: reservation.relation,
          reservedTreeRevision: reservation.treeRevision, treeRevision: draft.getSnapshot().revision, launch, cancelBeforeLaunch}};
      });
    }
    let reservation: ReturnType<RunTreeExecution["reserveDescendant"]>;
    try {
      reservation = tree.reserveDescendant({
        relationId: input.relationId,
        relationKind: input.relationKind,
        createChildRunId: () => {
          const childRunId = this.dependencies.createRunId();
          assertNonEmpty(childRunId, "Runner-created descendant runId");
          if (this.activeRunIds.has(childRunId)) {
            throw new TypeError("Runner-created descendant runId is already active.");
          }
          return childRunId;
        },
        parentRunId,
        parentLineage,
        parentRunAction: input.parentRunAction,
        parentDeadlineAt,
        childLocalDeadlineAt: localDeadline(
          startedAt,
          config.limits.maxDurationMs,
        ),
        resourceAllocation: delegationResourceAllocation(request.limits),
        authorityRevision: request.authorityDerivation.revision,
        dispatch: input.dispatch,
      });
    } catch {
      return Object.freeze({
        status: "rejected" as const,
        code: "descendant_run_start_failed" as const,
        treeRevision: tree.getSnapshot().revision,
      });
    }
    if (reservation.status === "rejected") {
      return Object.freeze({
        ...reservation,
      });
    }

    let disposition: "pending" | "launched" | "cancelled" = "pending";
    const rejectAfterReservation = (
      code: "descendant_run_start_cancelled" | "descendant_run_start_failed",
    ): RuntimeDescendantRunLaunchResult => Object.freeze({
      status: "rejected" as const,
      code,
      relation: reservation.relation,
      reservedTreeRevision: reservation.treeRevision,
      treeRevision: tree.getSnapshot().revision,
    });
    const cancelBeforeLaunch = (): RuntimeDescendantRunLaunchResult => {
      if (disposition !== "pending") {
        throw new TypeError("A descendant admission can be consumed only once.");
      }
      disposition = "cancelled";
      tree.cancelBeforeStart(reservation.relation.child.id, this.dependencies.now());
      return rejectAfterReservation("descendant_run_start_cancelled");
    };
    const launch = (): RuntimeDescendantRunLaunchResult => {
      if (disposition !== "pending") {
        throw new TypeError("A descendant admission can be consumed only once.");
      }
      disposition = "launched";
      try {
        const childRunId = reservation.relation.child.id;
        const launchStartedAt = this.dependencies.now();
        const runInput = snapshotRunInput(createDelegatedRunInput({
          request,
          childRunId,
          startedAt: launchStartedAt,
        }));
        const { handle, getTerminalFlowOccurrence } = this.startPreparedRun(
          childRunId,
          agent,
          runInput,
          config,
          rootTask,
          rootConfig,
          request,
          contextMaterials,
          input.modelInteractionSeed,
          reservation.lineage,
          tree,
          contextBytes,
          launchStartedAt,
          reservation.deadlineAt,
          runtimeEventPublishers,
          runTraceObservers,
          actionExecutionObserver,
          input.executionFlow,
        );
        const resourceSettlement = handle.wait().then(() => {
          const settlement = tree.getResourceSettlement(childRunId);
          if (settlement === null) {
            throw new TypeError("Descendant Run resources did not settle with the Run.");
          }
          return settlement;
        });
        // The Parent may still be awaiting the initial Child boundary.
        void resourceSettlement.catch(() => {});
        return Object.freeze({
          status: "started" as const,
          relation: reservation.relation,
          handle,
          getTerminalFlowOccurrence,
          resourceSettlement,
          reservedTreeRevision: reservation.treeRevision,
          treeRevision: tree.getSnapshot().revision,
        });
      } catch {
        tree.settleResources(reservation.relation.child.id);
        tree.failStart(reservation.relation.child.id, this.dependencies.now());
        return rejectAfterReservation("descendant_run_start_failed");
      }
    };
    return Object.freeze({
      status: "admitted" as const,
      relation: reservation.relation,
      reservedTreeRevision: reservation.treeRevision,
      treeRevision: tree.getSnapshot().revision,
      launch,
      cancelBeforeLaunch,
    });
  }

  private startPreparedRun<TOutput>(
    runId: string,
    agent: AgentDefinition<TOutput>,
    input: RunInput,
    config: RunConfig,
    rootTask: AgentTask,
    rootConfig: RunConfig,
    delegationRequest: DelegationRequest | null,
    delegationContextMaterials: readonly DelegationContextMaterial[],
    modelInteractionSeed: RuntimeDescendantRunAdmissionInput["modelInteractionSeed"],
    lineage: RunLineage,
    tree: RunTreeExecution,
    initialContextBytes: number,
    startedAt: string,
    deadlineAt: string,
    runtimeEventPublishers: readonly RuntimeEventPublisher[],
    runTraceObservers: readonly RunTraceObserver[],
    actionExecutionObserver: RunInvocationOptions["actionExecutionObserver"],
    executionFlow?: RunInvocationOptions["executionFlow"],
    treeCommits?: RunTreeCommitWriter,
    deferStart = false,
    restored?: RunCommit,
  ): {
    readonly handle: RunHandle<TOutput>;
    readonly getTerminalFlowOccurrence: () => ExecutionFlowOccurrenceRef | null;
    readonly execution: RunExecution<TOutput>;
    readonly activate: () => void;
  } {
    if (this.activeRunIds.has(runId)) {
      throw new TypeError(`Runner-created runId '${runId}' is already active.`);
    }
    const cancellation = createRunCancellationController({
      runId,
      ...(restored?.control.cancellation ? {retainedRequest: restored.control.cancellation} : {}),
      now: this.dependencies.now,
      createRequestId: (acceptedRunId) => this.dependencies.createId({
        kind: "run_cancellation_request",
        runId: acceptedRunId,
        sequence: 1,
      }),
    });
    const resolvedConfig: ResolvedRunConfig = Object.freeze({
      ...config,
      cancellation,
    });
    const emergencyResult = createEmergencyRunResult<TOutput>(runId, input.task.id);
    let unsubscribeTree = (): void => undefined;
    const handle = new ActiveRunHandle<TOutput>(
      runId,
      cancellation,
      emergencyResult,
      tree.getSnapshot(),
      (result) => {
        try {
          if (!treeCommits) tree.settleRun(
            runId,
            result.status,
            projectRunTreeTerminal(result.cause),
            result.completedAt,
          );
          handle.publishRunTree((treeCommits?.tree ?? tree).getSnapshot());
        } finally {
          this.activeRunIds.delete(runId);
          treeCommits?.unregisterCancellation(runId);
          unsubscribeTree();
        }
      },
    );
    if (this.dependencies.runObserver) {
      handle.subscribe((snapshot) => publishRunObservation(this.dependencies.runObserver, {
        snapshot, agent: Object.freeze({ id: agent.id, revision: agent.revision }),
        task: Object.freeze({ id: input.task.id }), lineage, startedAt,
      }));
    }
    const execution = new RunExecution<TOutput>(
      runId,
      this.dependencies,
      agent,
      input,
      resolvedConfig,
      rootTask,
      rootConfig,
      delegationRequest,
      delegationContextMaterials,
      modelInteractionSeed,
      lineage,
      runtimeEventPublishers,
      runTraceObservers,
      actionExecutionObserver,
      startedAt,
      deadlineAt,
      (descendant) => this.admitDescendant(
        descendant,
        runId,
        lineage,
        deadlineAt,
        input.task,
        config,
        rootTask,
        rootConfig,
        treeCommits?.tree ?? tree,
        runtimeEventPublishers,
        runTraceObservers,
        actionExecutionObserver,
        treeCommits,
      ),
      initialContextBytes,
      tree,
      (update) => {
        if (!treeCommits) tree.updateLifecycle(runId, update.status);
        handle.publish(update, (treeCommits?.tree ?? tree).getSnapshot());
      },
      executionFlow,
      treeCommits,
      restored,
    );
    handle.bindCancellationAcceptance(() => execution.confirmCancellation());
    handle.bindInteractionSubmission((submission) =>
      execution.submitInteraction(submission)
    );
    handle.bindSteering((steering) => execution.submitSteering(steering));
    handle.bindResume((resume) => execution.submitResume(resume));
    handle.bindSuspend((suspend) => execution.submitSuspend(suspend));
    handle.bindDescendantSteering((route) =>
      execution.submitDescendantSteering(route)
    );
    handle.bindDescendantResume((route) =>
      execution.submitDescendantResume(route)
    );
    const activate = () => {
      this.activeRunIds.add(runId);
      if (treeCommits) treeCommits.registerCancellation(runId, cancellation);
      else {
        tree.registerCancellation(runId, cancellation);
        tree.markStarted(runId, startedAt);
      }
      if (lineage.kind === "root") {
        unsubscribeTree = treeCommits
          ? treeCommits.subscribe(() => handle.publishRunTree(treeCommits.tree.getSnapshot()))
          : tree.subscribe((snapshot) => handle.publishRunTree(snapshot));
      }
      handle.start(async () => {
        try { return await execution.run(); }
        catch (error) {
          this.activeRunIds.delete(runId);
          treeCommits?.unregisterCancellation(runId);
          unsubscribeTree();
          throw error;
        }
      });
    };
    if (!deferStart) activate();
    return {
      handle,
      getTerminalFlowOccurrence: () => execution.getTerminalFlowOccurrence(),
      execution, activate,
    };
  }
}

function snapshotRunnerContextProjection(
  input: RunExecutionCoordinatorDependencies["contextProjection"],
): RunExecutionCoordinatorDependencies["contextProjection"] {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Runner requires explicit Context projection configuration.");
  }
  if (typeof input.allocate !== "function") {
    throw new TypeError("Runner requires a Context projection allocation operation.");
  }
  if (
    input.policy === null ||
    typeof input.policy !== "object" ||
    typeof input.policy.decide !== "function"
  ) {
    throw new TypeError("Runner requires a Context projection policy operation.");
  }
  const request = snapshotContextProjectionRequest({
    id: "runner-context-projection-verification",
    activeContext: Object.freeze({
      id: "runner-context-verification",
      runId: "runner-context-verification",
      version: 0,
    }),
    consumer: Object.freeze({
      owner: "agent-core",
      kind: "controller",
      id: "runner-context-verification",
    }),
    purpose: input.purpose,
    profile: input.profile,
    budget: Object.freeze({ unit: "bytes", maximum: 0 }),
    policy: input.policy.ref,
    estimator: Object.freeze({
      id: "runner-context-estimator-verification",
      revision: "1",
      unit: "bytes",
      accuracy: "exact",
    }),
    audiences: input.audiences,
    mandatoryItems: Object.freeze([]),
    requestedAt: "2026-01-01T00:00:00.000Z",
  });
  if (
    !Number.isSafeInteger(input.maxContributionPayloadBytes) ||
    input.maxContributionPayloadBytes < 0
  ) {
    throw new TypeError("Runner Context contribution payload limit is invalid.");
  }
  if (
    input.manifestPersistence !== undefined &&
    typeof input.manifestPersistence.persistManifest !== "function"
  ) {
    throw new TypeError("Runner Context Manifest persistence port is invalid.");
  }
  return Object.freeze({
    purpose: request.purpose,
    profile: request.profile,
    policy: Object.freeze({
      ref: request.policy,
      decide: input.policy.decide.bind(input.policy),
    }),
    audiences: request.audiences,
    maxContributionPayloadBytes: input.maxContributionPayloadBytes,
    allocate: input.allocate.bind(input),
    ...(input.manifestPersistence === undefined
      ? {}
      : {
          manifestPersistence: Object.freeze({
            persistManifest:
              input.manifestPersistence.persistManifest.bind(
                input.manifestPersistence,
              ),
          }),
        }),
  });
}

function snapshotRunnerOperationComposition(
  input: RunExecutionCoordinatorDependencies["operations"],
): RunExecutionCoordinatorDependencies["operations"] {
  if (input === null || typeof input !== "object" || !Array.isArray(input.availability)) {
    throw new TypeError("Runner requires explicit Operation Tool availability participants.");
  }
  if (!input.resultContracts || input.resultContracts.catalogId !== input.catalog.id ||
      input.resultContracts.catalogRevision !== input.catalog.revision || typeof input.resultContracts.validate !== "function") {
    throw new TypeError("Runner requires result contracts bound to its Operation catalog.");
  }
  const availability = input.availability.map((participant) => {
    if (
      participant === null ||
      typeof participant !== "object" ||
      typeof participant.assess !== "function"
    ) {
      throw new TypeError("Runner Operation Tool availability participant is invalid.");
    }
    return Object.freeze({
      binding: participant.binding,
      scheduling: participant.scheduling === undefined ? undefined : Object.freeze({ ...participant.scheduling }),
      assess: participant.assess.bind(participant),
    });
  });
  const delegation = input.delegation === undefined
    ? undefined
    : snapshotRunnerDelegationComposition(input.delegation);
  return Object.freeze({
    ...input,
    resultPresenters: snapshotToolResultPresenters(input.resultPresenters ?? []),
    internalHandlers: Object.freeze([...input.internalHandlers]),
    availability: Object.freeze(availability),
    ...(delegation === undefined ? {} : { delegation }),
  });
}

function snapshotRunnerDelegationComposition(
  input: NonNullable<RunExecutionCoordinatorDependencies["operations"]["delegation"]>,
): NonNullable<RunExecutionCoordinatorDependencies["operations"]["delegation"]> {
  if (
    input === null ||
    typeof input !== "object" ||
    input.preparation === null ||
    typeof input.preparation !== "object" ||
    typeof input.preparation.assessAvailability !== "function" ||
    typeof input.preparation.prepare !== "function" ||
    input.continuation === null ||
    typeof input.continuation !== "object" ||
    typeof input.continuation.prepare !== "function" ||
    input.narrativeProjection === null ||
    typeof input.narrativeProjection !== "object" ||
    typeof input.narrativeProjection.project !== "function" ||
    input.progressProjection === null ||
    typeof input.progressProjection !== "object" ||
    typeof input.progressProjection.project !== "function" ||
    input.resultProjection === null ||
    typeof input.resultProjection !== "object" ||
    typeof input.resultProjection.project !== "function"
  ) {
    throw new TypeError("Runner delegation composition is invalid.");
  }
  return Object.freeze({
    preparation: Object.freeze({
      assessAvailability:
        input.preparation.assessAvailability.bind(input.preparation),
      prepare: input.preparation.prepare.bind(input.preparation),
    }),
    continuation: Object.freeze({
      prepare: input.continuation.prepare.bind(input.continuation),
    }),
    narrativeProjection: Object.freeze({
      project: input.narrativeProjection.project.bind(input.narrativeProjection),
    }),
    progressProjection: Object.freeze({
      project: input.progressProjection.project.bind(input.progressProjection),
    }),
    resultProjection: Object.freeze({
      project: input.resultProjection.project.bind(input.resultProjection),
    }),
  });
}

function createEmergencyRunResult<TOutput>(
  runId: string,
  taskId: string,
): RunResult<TOutput> {
  const unknownAgent = Object.freeze({ id: "unknown", revision: "unknown" });
  const unknownInstructionBinding = Object.freeze({
    id: `${runId}:agent-instruction-binding:unknown`,
    revision: `sha256:${"0".repeat(64)}`,
  });
  const completedAt = new Date().toISOString();
  const failure = createRunFailureCause("runtime", Object.freeze({
    code: "runtime_execution_failed",
    message: "Agent Core execution could not settle its failure path.",
    retryable: false,
    metadata: Object.freeze({}),
  }));
  const cause: RunSettlementCauseRecord = Object.freeze({
    ref: Object.freeze({
      run: Object.freeze({ id: runId }),
      id: `${runId}:run-settlement-cause:emergency`,
      revision: "1",
    }),
    kind: "failure" as const,
    failure,
    source: Object.freeze({
      owner: "agent-runtime",
      kind: "emergency_settlement",
      id: `${runId}:emergency-settlement`,
      revision: null,
      run: Object.freeze({ id: runId }),
    }),
    underlying: Object.freeze([]),
    omittedUnderlyingCount: 0,
    recordedAt: completedAt,
  });
  return createRunResult<TOutput>({
    runId,
    taskId,
    startingAgent: unknownAgent,
    finalActiveAgent: unknownAgent,
    startingInstructionBinding: unknownInstructionBinding,
    finalInstructionBinding: unknownInstructionBinding,
    startedAt: completedAt,
    settlement: Object.freeze({
      status: "failed" as const,
      completedAt,
      cause: cause.ref,
    }),
    cause,
    settlementCauses: Object.freeze([cause]),
    items: Object.freeze([]),
    metadata: Object.freeze({ emergencySettlement: true }),
  });
}

function createDelegatedRunInput(input: {
  readonly request: DelegationRequest;
  readonly childRunId: string;
  readonly startedAt: string;
}): RunInput {
  const taskId = `${input.request.ref.id}:task`;
  return Object.freeze({
    task: Object.freeze({
      id: taskId,
      kind: input.request.task.kind,
      input: input.request.task.input,
      createdAt: input.startedAt,
      metadata: Object.freeze({
        ...input.request.task.metadata,
        delegationRequestId: input.request.ref.id,
        delegationRequestRevision: input.request.ref.revision,
        rootTaskId: input.request.origin.root.task.id,
        parentTaskId: input.request.origin.parent.task.id,
      }),
    }),
    items: Object.freeze([Object.freeze({
      id: `${input.request.ref.id}:objective`,
      kind: "message" as const,
      role: "user" as const,
      content: input.request.objective.text,
      createdAt: input.startedAt,
      metadata: Object.freeze({
        source: "delegation_objective",
        delegationRequestId: input.request.ref.id,
        parentRunId: input.request.origin.parent.run.id,
        delegationRequestRevision: input.request.ref.revision,
      }),
    })]),
    metadata: Object.freeze({
      delegationRequestId: input.request.ref.id,
      delegationRequestRevision: input.request.ref.revision,
      childRunId: input.childRunId,
    }),
  });
}

function delegationResourceAllocation(
  limits: DelegationRequest["limits"],
): RunTreeResourceAmounts {
  return Object.freeze({
    controllerTurns: limits.maxControllerTurns,
    actions: limits.maxActions,
    modelInputTokens: limits.maxModelInputTokens,
    modelOutputTokens: limits.maxModelOutputTokens,
    costUnits: limits.maxCostUnits,
    contextBytes: limits.maxContextBytes,
    resultBytes: limits.maxResultBytes,
  });
}

function measureInitialRunContextBytes(input: RunInput): number {
  return encodedJsonBytes({ task: input.task, items: input.items });
}

function encodedJsonBytes(input: unknown): number {
  const encoded = JSON.stringify(input);
  if (encoded === undefined) {
    throw new TypeError("Run Tree resource material is not JSON-serializable.");
  }
  return new TextEncoder().encode(encoded).byteLength;
}

function validateRunTreeMetering(
  resources: RootRunConfig["runTreeResources"],
  metering: ResolvedExecutionCoordinatorDependencies["taskDecisions"]["resourceMetering"],
): void {
  for (const dimension of [
    "modelInputTokens",
    "modelOutputTokens",
    "costUnits",
  ] as const) {
    if (resources[dimension].enforcement !== "hard") continue;
    const qualification = metering[dimension];
    if (
      qualification !== "measured" &&
      qualification !== "conservatively_bounded" &&
      qualification !== "not_applicable"
    ) {
      throw new TypeError(
        `Hard Run Tree ${dimension} enforcement requires a measured, conservatively bounded, or not-applicable Controller path.`,
      );
    }
  }
}

function sameAgentRevision(
  left: Pick<AgentDefinition, "id" | "revision">,
  right: Pick<AgentDefinition, "id" | "revision">,
): boolean {
  return left.id === right.id && left.revision === right.revision;
}


function validateActionComposition(
  dependencies: ResolvedExecutionCoordinatorDependencies,
  config: ValidatedRunConfig,
): void {
  if (
    (dependencies.operations.actionExecution === undefined) !==
      (config.actionExecution === null)
  ) {
    throw new TypeError(
      "Runner Operation Action composition and RunConfig.actionExecution must be configured together.",
    );
  }
}

function runtimeEventPublishers(
  configured: RuntimeEventPublisher | undefined,
  invocation: RuntimeEventPublisher | undefined,
): readonly RuntimeEventPublisher[] {
  return Object.freeze(
    [invocation, configured].filter(
      (publisher, index, publishers): publisher is RuntimeEventPublisher =>
        publisher !== undefined && publishers.indexOf(publisher) === index,
    ),
  );
}

function runTraceObservers(
  configured: RunTraceObserver | undefined,
  invocation: RunTraceObserver | undefined,
): readonly RunTraceObserver[] {
  const observers = [invocation, configured].filter(
    (observer, index, candidates): observer is RunTraceObserver =>
      observer !== undefined && candidates.indexOf(observer) === index,
  );
  for (const observer of observers) {
    if (
      typeof observer !== "object" ||
      observer === null ||
      typeof observer.observe !== "function"
    ) {
      throw new TypeError(
        "RunTrace observer must implement observe(trace).",
      );
    }
  }
  return Object.freeze(observers);
}

function createDefaultIdentity(input: CreateRunIdentityInput): string {
  return `${input.runId}:${input.kind}:${input.sequence}`;
}

function createDefaultRunIdentity(): string {
  return `run_${globalThis.crypto.randomUUID()}`;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function localDeadline(startedAt: string, maxDurationMs: number): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new TypeError("Runner time source returned an invalid date-time.");
  }
  return new Date(startedAtMs + maxDurationMs).toISOString();
}
