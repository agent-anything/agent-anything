import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {snapshotProviderFailure, type ProviderCallResult} from "@agent-anything/model-interaction";
import type {ActivityHandoffPort, ActivityPathIntent, ActivityPathState} from "../activity/ActivityHandoff.js";
import type {ActivitySchedulingIntent} from "../activity/ActivityScheduling.js";
import type {SharedAcceptancePort, SharedAcceptanceProposal} from "../activity/SharedAcceptance.js";
import type {AgentActivityExecutionContext, TaskDecisionActivity, TaskDecisionInputSources, TaskDecisionProposal, TaskDecisionResourceMetering} from "./TaskDecisionActivity.js";
import {retainTaskDecisionSource} from "./TaskDecisionSourceRecord.js";
import {TaskResponseBindingError} from "./TaskResponseBindingError.js";
import {createTaskModelResponseHandoff, readTaskModelResponseHandoff, type TaskModelResponseHandoff, type TaskModelResponseObservation} from "./TaskModelResponseHandoff.js";
import {TaskModelResponseWork, type TaskModelSource} from "./TaskModelResponsePath.js";
import {TaskDecisionActivityError} from "./TaskDecisionActivityError.js";
import {RetryInvocationInvalidatedError} from "../retry/RetryWaitControl.js";
import {ActivityChangeWait as ResultWake} from "../activity/ActivityChangeWait.js";

export interface TaskModelResponseSubmission {
  readonly identity: Omit<ActivityPathIntent, "purpose" | "owner">;
  readonly source: TaskModelSource;
  readonly schedule: ActivitySchedulingIntent;
}
interface RetainedTaskSubmission {
  readonly version: 1;
  readonly handoff: TaskModelResponseHandoff;
  readonly proposal: SharedAcceptanceProposal;
  readonly digest: string;
}
export interface TaskModelResponseActivityPorts<T> {
  readonly work: TaskModelResponseWork<T>;
  readonly activities: ActivityHandoffPort;
  readonly acceptance: SharedAcceptancePort;
  readonly resourceMetering: TaskDecisionResourceMetering;
  /** Pure original-source binding. It must not dispatch work or decide context representation. */
  readonly prepare: (input: TaskDecisionInputSources<T>, context: AgentActivityExecutionContext) => TaskModelResponseSubmission | Promise<TaskModelResponseSubmission>;
  readonly host: {assertAvailable(): void; subscribe(listener: () => void): () => void; wake(): void};
  readonly rediscoveryMs: number;
  readonly settlementWaitMs: number;
}
const CHECKPOINT = "task-model-response-submission.v1";

/** The waiting task owns a durable handoff, not the producer's execution or model slot. */
export class TaskModelResponseActivity<T = unknown> implements TaskDecisionActivity<T> {
  readonly resourceMetering: TaskDecisionResourceMetering;
  constructor(private readonly ports: TaskModelResponseActivityPorts<T>) {
    for (const value of [ports.rediscoveryMs, ports.settlementWaitMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("task_response_wait_bound_invalid");
    }
    this.resourceMetering = ports.resourceMetering;
  }
  async next(input: TaskDecisionInputSources<T>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<T>> {
    const checkpoints = this.checkpoints(context);
    let retained = this.read(input, context);
    if (!retained) {
      context.cancellation.signal.throwIfAborted();
      this.ports.host.assertAvailable();
      const prepared = await this.ports.prepare(input, context);
      if (prepared.source.record.id !== retainTaskDecisionSource(input).id || prepared.schedule.runId !== input.runId ||
          prepared.schedule.owner !== this.ports.work.purpose.contract.acceptanceOwner || prepared.identity.scheduledWorkId !== prepared.schedule.workId)
        throw new TaskResponseBindingError("task_response_submission_scope_changed");
      const handoff = createTaskModelResponseHandoff(prepared.identity.id, prepared.source);
      if(prepared.schedule.delegatedPathOwners?.length||prepared.schedule.allowedPathIds&&
        (prepared.schedule.allowedPathIds.length!==1||prepared.schedule.allowedPathIds[0]!==prepared.identity.id))
        throw new TaskResponseBindingError("task_response_schedule_scope_changed");
      const schedule={...prepared.schedule,allowedPathIds:[prepared.identity.id]};
      const proposal: SharedAcceptanceProposal = {id: `${handoff.pathId}:submission`, scope: input.runId,
        actor: this.ports.work.purpose.contract.acceptanceOwner, parts: [
          {owner: "activity", kind: "scheduling_acceptance", proposal: {kind: "schedule_work", intent: schedule, expectedRevision: 0}},
          ...this.ports.work.prepareSubmission(prepared.identity, prepared.source),
        ]};
      retained = structuredClone({version: 1 as const, handoff, proposal, digest: modelInputValueDigest(proposal)});
      await checkpoints.commit(CHECKPOINT, retained);
    }
    return this.continue(retained, input, context);
  }
  async recover(input: TaskDecisionInputSources<T>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<T>> {
    const retained = this.read(input, context);
    // No retained delegate means interruption preceded preparation; no external work could have begun.
    return retained ? this.continue(retained, input, context) : this.next(input, context);
  }
  async interrupt(input: TaskDecisionInputSources<T>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<T> | null> {
    const retained = this.read(input, context);
    if (!retained) return null;
    const receipt = await this.ports.acceptance.query(retained.proposal.id);
    if (!receipt) return null;
    if (receipt.digest !== retained.digest || receipt.scope !== input.runId) throw new TaskResponseBindingError("task_response_submission_changed");
    if (receipt.outcome === "rejected") return null;
    await readTaskModelResponseHandoff(this.ports.activities, retained.handoff);
    const path = await this.ports.activities.command({kind: "read_path", pathId: retained.handoff.pathId}) as ActivityPathState | null;
    if (!path || path.intent.runId !== input.runId) throw new TaskResponseBindingError("task_response_original_path_unavailable");
    if (!path.cancelled) {
      // Compare-and-set failure is not success; the caller can recover the original handoff again.
      await this.ports.activities.command({kind: "cancel", pathId: path.intent.id, expectedControlRevision: path.controlRevision});
    }
    this.ports.host.wake();
    return this.observe(retained, context, true);
  }
  private async continue(retained: RetainedTaskSubmission, input: TaskDecisionInputSources<T>, context: AgentActivityExecutionContext): Promise<TaskDecisionProposal<T>> {
    if (context.cancellation.signal.aborted) {
      const received = await this.interrupt(input, context);
      if (received) return received;
      context.cancellation.signal.throwIfAborted();
    }
    this.ports.host.assertAvailable();
    const receipt = await this.ports.acceptance.accept(retained.proposal);
    if (receipt.outcome !== "accepted") throw new TaskResponseBindingError(`task_response_submission_rejected:${receipt.rejection?.code}`);
    this.ports.host.wake();
    try {
      const result = await this.observe(retained, context, false);
      if (!result) throw new RetryInvocationInvalidatedError();
      return result;
    } catch (error) {
      if (!context.cancellation.signal.aborted) throw error;
      const received = await this.interrupt(input, context);
      if (received) return received;
      throw error;
    }
  }
  private async observe(retained: RetainedTaskSubmission, context: AgentActivityExecutionContext, interrupting: boolean): Promise<TaskDecisionProposal<T> | null> {
    const deadline = interrupting ? Date.now() + this.ports.settlementWaitMs : Date.parse(context.retry.deadlineAt);
    if (!Number.isFinite(deadline)) throw new TypeError("task_response_deadline_invalid");
    const wake = new ResultWake(this.ports.host, interrupting ? null : context.cancellation.signal);
    try {
      while (true) {
        const version = wake.version;
        const observed = await readTaskModelResponseHandoff<T>(this.ports.activities, retained.handoff);
        if(observed.kind==="input_unavailable") {
          if(interrupting)return null;
          throw new TaskDecisionActivityError({kind:"input_preparation",failure:{code:"context_input_unavailable",
            message:`The original input need could not be supplied: ${observed.progress.limitation.reason}.`,retryable:false,
            metadata:{pathId:retained.handoff.pathId,stageId:observed.stage.request.id,rawResultId:observed.progress.rawResultId,
              acceptanceId:observed.stage.receipt!.id,limitation:observed.progress.limitation}}},"settled_failure");
        }
        if (observed.kind === "accepted" || observed.kind === "settled_response") {
          if (interrupting && observed.progress.state !== "interpreted" && !observed.progress.exchange) return null;
          return this.proposal(observed);
        }
        if (observed.kind === "consumer_closed" && observed.stage?.status !== "raw_result") return null;
        this.ports.host.assertAvailable();
        if (!interrupting) context.cancellation.signal.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new TaskDecisionActivityError({kind: "model", failure: {
          code: "model_operation_deadline_exceeded", message: "Original task response handoff is still pending; retained work was not repeated.", retryable: false, metadata: {pathId: retained.handoff.pathId},
        }});
        await wake.wait(version, Math.min(remaining, this.ports.rediscoveryMs));
      }
    } finally {wake.close();}
  }
  private proposal(observed: Extract<TaskModelResponseObservation<T>, {readonly kind: "accepted" | "settled_response"}>): TaskDecisionProposal<T> {
    if (observed.progress.state === "interpreted" && observed.progress.proposal) return observed.progress.proposal;
    if (observed.progress.state === "transport_result") {
      const result = observed.progress.failure as Exclude<ProviderCallResult, {kind: "succeeded"}>;
      if (result.kind === "failed" || result.kind === "cancellation_unconfirmed") {
        const original = snapshotProviderFailure(result.failure);
        const code = result.kind === "cancellation_unconfirmed" ? "provider_cancellation_unconfirmed" : original.code === "provider_context_window_exceeded" ?
          "provider_context_window_exceeded" : original.category === "timeout" ? "provider_timeout" : "provider_request_failed";
        throw new TaskDecisionActivityError({kind: "provider", failure: {...original, code,
          metadata: {...original.metadata, originalCode: original.code}}}, result.kind === "cancellation_unconfirmed" ? "unsettled" : "settled_failure");
      }
      throw new TaskResponseBindingError(`task_response_transport_${result.kind}`);
    }
    throw new TaskDecisionActivityError({kind: "model", failure: {code: observed.progress.state === "response_incomplete" ? "model_output_incomplete" : "model_output_invalid",
      message: "The original task response has no accepted decision. Its result and failure remain retained.", retryable: false, metadata: {state: observed.progress.state, originalFailure: observed.progress.failure}}}, "settled_failure", null,
      observed.progress.exchange ? {exchange: observed.progress.exchange} : undefined);
  }
  private checkpoints(context: AgentActivityExecutionContext) {
    if (!context.checkpoints) throw new TaskResponseBindingError("task_response_checkpoint_required");
    return context.checkpoints;
  }
  private read(input: TaskDecisionInputSources<T>, context: AgentActivityExecutionContext): RetainedTaskSubmission | null {
    const retained = this.checkpoints(context).read(CHECKPOINT) as RetainedTaskSubmission | null;
    if (retained === null) return null;
    const source = retained.proposal?.parts.find(part => part.owner === "activity" && part.kind === "stage_submission")?.proposal as {input?: TaskModelSource} | undefined;
    if (retained.version !== 1 || !source?.input || retained.digest !== modelInputValueDigest(retained.proposal) ||
        retained.proposal.scope !== input.runId || retained.proposal.id !== `${retained.handoff.pathId}:submission` ||
        source.input.record.id !== retainTaskDecisionSource(input).id ||
        modelInputValueDigest(createTaskModelResponseHandoff(retained.handoff.pathId, source.input)) !== modelInputValueDigest(retained.handoff))
      throw new TaskResponseBindingError("task_response_checkpoint_binding_changed");
    return retained;
  }
}

