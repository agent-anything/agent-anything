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
  readonly failures:readonly {readonly requestId:string;readonly error:unknown}[];
}

/** Drains durable responsibilities. Professional handlers, not this coordinator, choose stages. */
export class ActivityHandoffProcessor {
  private readonly cursors = new Map<string,number>();
  private readonly executing=new Map<string,{runId:string;completion:Promise<void>;controller:AbortController}>();
  private readonly completed=new Map<string,{progressed:string[];pending:{requestId:string;reason:string}[];errors:{requestId:string;error:unknown}[]}>();
  constructor(private readonly port: ActivityHandoffPort,
    private readonly purposes: ActivityPurposeRegistry<ActivityPurposeHandler>,
    private readonly executor: ActivityExecutorIdentity,
    private readonly now: () => string,
    private readonly acceptedPurposeIds?:readonly string[]) {}

  /** Bounded discovery/dispatch never waits for a long external execution. */
  async scan(runId:string,signal:AbortSignal,maximum=64):Promise<ActivityDrainResult> {
    const result=await this.process(runId,signal,maximum,false);
    return this.collect(runId,result);
  }
  /** Explicit completion wait for callers that own no other runnable work. */
  async drain(runId:string,signal:AbortSignal,maximum=64):Promise<ActivityDrainResult> {
    const result=await this.process(runId,signal,maximum,true);
    await Promise.all([...this.executing.values()].filter(work=>work.runId===runId).map(work=>work.completion));
    const collected=this.collect(runId,result);
    if(collected.failures.length)throw new AggregateError(collected.failures.map(f=>f.error),"Activity handoff processing failed");
    return collected;
  }
  async settled():Promise<void>{await Promise.all([...this.executing.values()].map(work=>work.completion));}
  get inFlight():number{return this.executing.size;}
  private collect(runId:string,result:ActivityDrainResult):ActivityDrainResult {
    const completed=this.completed.get(runId);this.completed.delete(runId);
    return {progressed:[...result.progressed,...(completed?.progressed??[])],pending:[...result.pending,...(completed?.pending??[])],failures:[...result.failures,...(completed?.errors??[])]};
  }
  private async process(runId: string, signal: AbortSignal, maximum:number,wait:boolean): Promise<ActivityDrainResult> {
    const progressed: string[] = [], pending: {requestId:string;reason:string}[] = [];
    const failures:{requestId:string;error:unknown}[]=[];
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) throw new TypeError("activity_drain_bound_invalid");
    await this.port.command({kind:"review_scheduling"});
    let items = await this.port.command({kind:"pending",runId,after:this.cursors.get(runId) ?? 0,limit:maximum}) as readonly ActivityHandoffItem[];
    if (!items.length && this.cursors.get(runId)) items = await this.port.command({kind:"pending",runId,after:0,limit:maximum}) as readonly ActivityHandoffItem[];
    this.cursors.set(runId,items.at(-1)?.sequence ?? 0);
    for (const item of items) {
      signal.throwIfAborted();
      const stage = await this.port.command({kind:"read_stage",requestId:item.requestId}) as ActivityStageState | null;
      const path = await this.port.command({kind:"read_path",pathId:item.pathId}) as ActivityPathState | null;
      if (!stage || !path || path.intent.runId !== runId) throw new TypeError("activity_handoff_scope_invalid");
      const inFlight=this.executing.get(item.requestId);
      if(inFlight) {
        if(path.cancelled)inFlight.controller.abort(new Error("activity_cancelled"));
        pending.push({requestId:item.requestId,reason:"execution_in_flight"});continue;
      }
      if(this.acceptedPurposeIds&&!this.acceptedPurposeIds.includes(path.intent.purpose.contract.ref.id))continue;
      if (path.cancelled && item.kind!=="reconciliation") {pending.push({requestId:item.requestId,reason:"cancelled"}); continue;}
      const handler = this.purposes.resolve(path.intent.purpose);
      try {await handler.authorize(path,stage,signal);}
      catch(error) {
        if(!stage.attempt&&!signal.aborted)await this.port.command({kind:"restrict_dispatch",requestId:stage.request.id,expectedControlRevision:path.controlRevision,
          restriction:{code:"authorization_not_established",message:(error instanceof Error?error.message:String(error)).slice(0,4096)||"Authorization failed"}});
        if(signal.aborted)throw error;
        failures.push({requestId:item.requestId,error});pending.push({requestId:item.requestId,reason:"authorization_not_established"});continue;
      }
      if(stage.dispatchRestriction)await this.port.command({kind:"restrict_dispatch",requestId:stage.request.id,expectedControlRevision:path.controlRevision,restriction:null});
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
            const controller=new AbortController(),executionSignal=AbortSignal.any([signal,controller.signal]);
            const execution=async()=>{
              const result=await handler.execute(path,dispatched.stage,attempt,executionSignal);
              this.resultMatches(result,attempt.id);
              // Raw persistence is not cancelled when the consumer no longer needs the result.
              await this.port.command({kind:"save_raw",result});
            };
            if(wait)await execution();
            else {
              const completion=execution().then(()=>this.outcome(runId).progressed.push(item.requestId),error=>this.outcome(runId).errors.push({requestId:item.requestId,error}))
                .then(()=>{this.executing.delete(item.requestId);});
              this.executing.set(item.requestId,{runId,completion,controller});
              pending.push({requestId:item.requestId,reason:"execution_in_flight"});continue;
            }
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
            const interpretationStarted=performance.now();
            const outcome = await handler.interpret(path,claimed,signal,{id:acceptanceId});
            const interpretationMs=performance.now()-interpretationStarted;
            signal.throwIfAborted();
            await this.port.command({kind:"accept",receipt:{id:acceptanceId,requestId:stage.request.id,
              resultId:claimed.result!.id,owner:path.intent.owner,expectedProgressRevision:path.progressRevision,
              progress:outcome.progress,next:outcome.next,interpretationMs},executor:this.executor,expectedControlRevision:path.controlRevision,
              ...(outcome.participants?{participants:outcome.participants}:{})});
            break;
          }
        }
        progressed.push(item.requestId);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (code === "activity_dependency_waiting" || code === "activity_slot_waiting" || code === "activity_schedule_turn_waiting" || code === "activity_schedule_not_ready") pending.push({requestId:item.requestId,reason:code});
        else throw error;
      }
    }
    return {progressed,pending,failures};
  }
  private outcome(runId:string):{progressed:string[];pending:{requestId:string;reason:string}[];errors:{requestId:string;error:unknown}[]} {
    let result=this.completed.get(runId);if(!result){result={progressed:[],pending:[],errors:[]};this.completed.set(runId,result);}return result;
  }
  private resultMatches(result: ActivityRawResult, attemptId: string): void {
    if (result.attemptId !== attemptId) throw new TypeError("activity_raw_result_scope_invalid");
  }
}
