import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry} from "./ActivityPurpose.js";
import type {ActivityAttempt, ActivityDispatchReceipt, ActivityExecutorIdentity, ActivityHandoffItem, ActivityHandoffPort,
  ActivityPathState, ActivityRawResult, ActivityStageRequest, ActivityStageState} from "./ActivityHandoff.js";

export interface ActivityPurposeHandler {
  /** Current permissions and environment, not a replay of historical authorization. */
  authorize(path: ActivityPathState, stage: ActivityStageState, signal: AbortSignal): Promise<void>;
  execute(path: ActivityPathState, stage: ActivityStageState, attempt: ActivityAttempt, signal: AbortSignal): Promise<ActivityRawResult>;
  /** Inspect original work only. Null means unresolved, never permission to execute again. */
  reconcile(path: ActivityPathState, stage: ActivityStageState, signal: AbortSignal): Promise<ActivityRawResult | null>;
  interpret(path: ActivityPathState, stage: ActivityStageState, signal: AbortSignal, acceptance: {readonly id:string}): Promise<{
    readonly progress: unknown; readonly next: readonly ActivityStageRequest[];
    readonly participants?:readonly import("./SharedAcceptance.js").SharedAcceptancePart[];
  }>;
}
export interface ActivityDrainResult {
  readonly progressed: readonly string[];
  readonly pending: readonly {readonly requestId: string; readonly reason: string}[];
}

/** Drains durable responsibilities. Professional handlers, not this coordinator, choose stages. */
export class ActivityHandoffProcessor {
  private readonly cursors = new Map<string,number>();
  constructor(private readonly port: ActivityHandoffPort,
    private readonly purposes: ActivityPurposeRegistry<ActivityPurposeHandler>,
    private readonly executor: ActivityExecutorIdentity,
    private readonly now: () => string) {}

  async drain(runId: string, signal: AbortSignal, maximum = 64): Promise<ActivityDrainResult> {
    const progressed: string[] = [], pending: {requestId:string;reason:string}[] = [];
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) throw new TypeError("activity_drain_bound_invalid");
    let items = await this.port.command({kind:"pending",runId,after:this.cursors.get(runId) ?? 0,limit:maximum}) as readonly ActivityHandoffItem[];
    if (!items.length && this.cursors.get(runId)) items = await this.port.command({kind:"pending",runId,after:0,limit:maximum}) as readonly ActivityHandoffItem[];
    this.cursors.set(runId,items.at(-1)?.sequence ?? 0);
    for (const item of items) {
      signal.throwIfAborted();
      const stage = await this.port.command({kind:"read_stage",requestId:item.requestId}) as ActivityStageState | null;
      const path = await this.port.command({kind:"read_path",pathId:item.pathId}) as ActivityPathState | null;
      if (!stage || !path || path.intent.runId !== runId) throw new TypeError("activity_handoff_scope_invalid");
      if (path.cancelled && item.kind!=="reconciliation") {pending.push({requestId:item.requestId,reason:"cancelled"}); continue;}
      const handler = this.purposes.resolve(path.intent.purpose);
      await handler.authorize(path,stage,signal);
      signal.throwIfAborted();
      try {
        switch (item.kind) {
          case "admission":
            await this.port.command({kind:"admit",requestId:item.requestId,expectedControlRevision:path.controlRevision});
            break;
          case "execution": {
            if (stage.status !== "admitted") break;
            const attempt:ActivityAttempt = {id:`${stage.request.id}:attempt:1`,requestId:stage.request.id,
              executor:this.executor,inputDigest:modelInputValueDigest(stage.request.input),startedAt:this.now()};
            const dispatched = await this.port.command({kind:"dispatch",attempt,expectedControlRevision:path.controlRevision}) as ActivityDispatchReceipt;
            if (!dispatched.granted) {pending.push({requestId:item.requestId,reason:"dispatch_already_accepted"}); continue;}
            const result = await handler.execute(path,dispatched.stage,attempt,signal);
            this.resultMatches(result,attempt.id);
            // Saving a late raw response is allowed even when cancellation prevents interpretation.
            await this.port.command({kind:"save_raw",result});
            break;
          }
          case "reconciliation": {
            const result = await handler.reconcile(path,stage,signal);
            if (!result) {pending.push({requestId:item.requestId,reason:"external_result_unknown"}); continue;}
            this.resultMatches(result,stage.attempt!.id);
            await this.port.command({kind:"save_raw",result});
            break;
          }
          case "interpretation": {
            if (stage.status === "accepted") break;
            const claimId = `${stage.request.id}:processing:${modelInputValueDigest(this.executor)}`;
            const claimed = stage.processing?.id === claimId ? stage : await this.port.command({kind:"claim_processing",
              claim:{id:claimId,requestId:stage.request.id,previousClaimId:stage.processing?.id ?? null,executor:this.executor},expectedControlRevision:path.controlRevision}) as ActivityStageState;
            const acceptanceId=`${stage.request.id}:processing-receipt:${path.progressRevision}`;
            const outcome = await handler.interpret(path,claimed,signal,{id:acceptanceId});
            signal.throwIfAborted();
            await this.port.command({kind:"accept",receipt:{id:acceptanceId,requestId:stage.request.id,
              resultId:claimed.result!.id,owner:path.intent.owner,expectedProgressRevision:path.progressRevision,
              progress:outcome.progress,next:outcome.next},executor:this.executor,expectedControlRevision:path.controlRevision,
              ...(outcome.participants?{participants:outcome.participants}:{})});
            break;
          }
        }
        progressed.push(item.requestId);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (code === "activity_dependency_waiting" || code === "activity_slot_waiting") pending.push({requestId:item.requestId,reason:code});
        else throw error;
      }
    }
    return {progressed,pending};
  }
  private resultMatches(result: ActivityRawResult, attemptId: string): void {
    if (result.attemptId !== attemptId) throw new TypeError("activity_raw_result_scope_invalid");
  }
}
