import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {ActivityCancellationError} from "./ActivityCancellation.js";
import {createActivityWorkTiming,measureActivityWork,type ActivityWorkTiming,type ActivityTimingObservation} from "./ActivityWorkTiming.js";
import {isActivityDispatchWaitCode} from "./ActivityDispatchWait.js";
import type {ActivityPurposeResolver} from "./ActivityPurpose.js";
import {activityStageEvidence,type ActivityProfessionalLimitation} from "./ActivityProfessionalStop.js";
import {validateActivityAuthorizationResult,type ActivityAuthorizationResult,type ActivityAuthorizationRefusal} from "./ActivityAuthorization.js";
import type {ActivityAttempt, ActivityDispatchReceipt, ActivityExecutorIdentity, ActivityHandoffItem, ActivityHandoffPort,
  ActivityPathState, ActivityRawResult, ActivityStageRequest, ActivityStageState} from "./ActivityHandoff.js";

export interface ActivityPurposeHandler {
  /** Current permissions and environment, not a replay of historical authorization. */
  authorize(path: ActivityPathState, stage: ActivityStageState, signal: AbortSignal, action: ActivityHandoffItem["kind"]): Promise<ActivityAuthorizationResult>;
  /** Interprets a recorded restriction, never substitutes a fabricated execution result. */
  handleLimitation?(path:ActivityPathState,stage:ActivityStageState,limitation:ActivityProfessionalLimitation,signal:AbortSignal,
    acceptance:{readonly id:string}):Promise<{readonly kind:"stop";readonly progress:unknown}|{readonly kind:"wait"}>;
  execute(path: ActivityPathState, stage: ActivityStageState, attempt: ActivityAttempt, signal: AbortSignal,timing?:ActivityWorkTiming): Promise<ActivityRawResult>;
  /** Inspect original work only. Null means unresolved, never permission to execute again. */
  reconcile(path: ActivityPathState, stage: ActivityStageState, signal: AbortSignal): Promise<ActivityRawResult | null>;
  prepareRetry?(path:ActivityPathState,stage:ActivityStageState,signal:AbortSignal):Promise<import("./ActivityHandoff.js").ActivityAttemptRetryReceipt|null>;
  interpret(path: ActivityPathState, stage: ActivityStageState, signal: AbortSignal, acceptance: {readonly id:string}): Promise<{
    readonly progress: unknown; readonly next: readonly ActivityStageRequest[];
    readonly participants?:readonly import("./SharedAcceptance.js").SharedAcceptancePart[];
  }>;
  /** No further execution. Missing support leaves a visible durable responsibility. */
  settle?(path: ActivityPathState, stage: ActivityStageState, signal: AbortSignal, acceptance: {readonly id:string}): Promise<{
    readonly disposition: unknown;
    readonly participants?: readonly import("./SharedAcceptance.js").SharedAcceptancePart[];
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
  private dispatchOpen=true;
  constructor(private readonly port: ActivityHandoffPort,
    private readonly purposes: ActivityPurposeResolver<ActivityPurposeHandler>,
    private readonly executor: ActivityExecutorIdentity,
    private readonly now: () => string,
    private readonly acceptedPurposeIds?:readonly string[],private readonly observeTiming?:(event:ActivityTimingObservation)=>void) {}

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
  stopDispatch():void {this.dispatchOpen=false;}
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
      // Capture local ownership before asynchronous reads: completion can remove it during those reads.
      const inFlight=this.executing.get(item.requestId);
      let stage = await this.port.command({kind:"read_stage",requestId:item.requestId}) as ActivityStageState | null;
      const path = await this.port.command({kind:"read_path",pathId:item.pathId}) as ActivityPathState | null;
      if (!stage || !path || path.intent.runId !== runId) throw new TypeError("activity_handoff_scope_invalid");
      if(inFlight) {
        if(path.cancelled)inFlight.controller.abort(new ActivityCancellationError(path));
        pending.push({requestId:item.requestId,reason:"execution_in_flight"});continue;
      }
      if(this.acceptedPurposeIds&&!this.acceptedPurposeIds.includes(path.intent.purpose.contract.ref.id))continue;
      const expectedStatus={admission:"submitted",execution:"admitted",reconciliation:"dispatched",interpretation:"raw_result",settlement:"raw_result"} as const;
      if(stage.status!==expectedStatus[item.kind]) {
        pending.push({requestId:item.requestId,reason:"handoff_already_progressed"});continue;
      }
      if(!this.dispatchOpen&&(item.kind==="admission"||item.kind==="execution")) {
        pending.push({requestId:item.requestId,reason:"host_dispatch_closed"});continue;
      }
      if(item.kind==="execution"&&stage.retry&&Date.parse(this.now())<Date.parse(stage.retry.notBefore)) {
        pending.push({requestId:item.requestId,reason:"attempt_retry_waiting"});continue;
      }
      if (path.cancelled && item.kind!=="reconciliation" && item.kind!=="settlement") {pending.push({requestId:item.requestId,reason:"cancelled"}); continue;}
      let handler:ActivityPurposeHandler;
      try {
        handler=await this.purposes.resolve(path.intent.purpose,{runId,pathId:path.intent.id});
      }
      catch(error) {
        if(signal.aborted)throw error;
        failures.push({requestId:item.requestId,error});pending.push({requestId:item.requestId,reason:"purpose_not_resolved"});continue;
      }
      signal.throwIfAborted();
      try {
        const timing=createActivityWorkTiming(path,stage,this.observeTiming);
        const recorded=stage.authorizationRestrictions?.[item.kind];
        const limitation:ActivityProfessionalLimitation|null=!path.cancelled&&recorded?.kind==="denied"?
          {kind:"authorization",action:item.kind,refusal:recorded}:!path.cancelled&&!stage.attempt&&Date.parse(this.now())>=Date.parse(path.intent.deadlineAt)?
          {kind:"deadline",deadlineAt:path.intent.deadlineAt,observedAt:this.now()}:null;
        if(limitation&&handler.handleLimitation) {
          if(await this.handleLimitation(handler,path,stage,limitation,signal))progressed.push(item.requestId);
          else pending.push({requestId:item.requestId,reason:"professional_limitation_waiting"});
          continue;
        }
        if(!path.cancelled&&recorded?.kind==="denied") {
          pending.push({requestId:item.requestId,reason:"professional_limitation_handler_unavailable"});continue;
        }
        let refusal:ActivityAuthorizationRefusal|null=null;
        try {
          const authorization=await measureActivityWork(timing,"authorization",()=>handler.authorize(path,stage!,signal,item.kind));
          validateActivityAuthorizationResult(authorization);
          if(authorization.kind!=="allowed")refusal=authorization;
        }
        catch(error) {
          if(signal.aborted)throw error;
          refusal={kind:"temporary",code:"authorization_not_established",message:(error instanceof Error?error.message:String(error)).slice(0,4096)||"Authorization failed"};
          failures.push({requestId:item.requestId,error});
        }
        signal.throwIfAborted();
        if(refusal||recorded)stage=await this.port.command({kind:"record_authorization_restriction",requestId:stage.request.id,
          expectedControlRevision:path.controlRevision,expectedStageEvidence:activityStageEvidence(stage),action:item.kind,refusal:refusal??null}) as ActivityStageState;
        if(refusal) {
          if(!path.cancelled&&refusal.kind==="denied"&&handler.handleLimitation&&
            await this.handleLimitation(handler,path,stage,{kind:"authorization",action:item.kind,refusal},signal))progressed.push(item.requestId);
          else pending.push({requestId:item.requestId,reason:refusal.kind==="denied"?"authorization_denied":"authorization_not_established"});
          continue;
        }
        if(stage.dispatchRestriction&&!path.cancelled&&!stage.attempt)stage=await this.port.command({kind:"restrict_dispatch",requestId:stage.request.id,expectedControlRevision:path.controlRevision,restriction:null}) as ActivityStageState;
        switch (item.kind) {
          case "admission":
            await measureActivityWork(timing,"admission.persistence",()=>this.port.command({kind:"admit",requestId:item.requestId,expectedControlRevision:path.controlRevision}));
            break;
          case "execution": {
            const attempt:ActivityAttempt = {id:`${stage.request.id}:attempt:${(stage.attemptCount??0)+1}`,requestId:stage.request.id,
              executor:this.executor,inputDigest:modelInputValueDigest(stage.request.input),startedAt:this.now()};
            const dispatched = await this.port.command({kind:"dispatch",attempt,expectedControlRevision:path.controlRevision}) as ActivityDispatchReceipt;
            if (!dispatched.granted) {pending.push({requestId:item.requestId,reason:"dispatch_already_accepted"}); continue;}
            const controller=new AbortController(),executionSignal=AbortSignal.any([signal,controller.signal]);
            const execution=async()=>{
              const executionTiming=createActivityWorkTiming(path,dispatched.stage,this.observeTiming);
              const result=await measureActivityWork(executionTiming,"execution",()=>handler.execute(path,dispatched.stage,attempt,executionSignal,executionTiming));
              this.resultMatches(result,attempt.id);
              // Raw persistence is not cancelled when the consumer no longer needs the result.
              await measureActivityWork(executionTiming,"raw.persistence",()=>this.port.command({kind:"save_raw",result}));
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
            const result = await measureActivityWork(timing,"reconciliation",()=>handler.reconcile(path,stage!,signal));
            if (!result) {pending.push({requestId:item.requestId,reason:"external_result_unknown"}); continue;}
            this.resultMatches(result,stage.attempt!.id);
            await this.port.command({kind:"save_raw",result});
            break;
          }
          case "interpretation": {
            const retry=await handler.prepareRetry?.(path,stage,signal);
            if(retry) {
              await this.port.command({kind:"retry_attempt",receipt:retry,expectedControlRevision:path.controlRevision,executor:this.executor});
              break;
            }
            const claimId = `${stage.request.id}:processing:${modelInputValueDigest(this.executor)}`;
            const claimed = stage.processing?.id === claimId ? stage : await this.port.command({kind:"claim_processing",
              claim:{id:claimId,requestId:stage.request.id,previousClaimId:stage.processing?.id ?? null,executor:this.executor},expectedControlRevision:path.controlRevision}) as ActivityStageState;
            const acceptanceId=`${stage.request.id}:processing-receipt:${path.progressRevision}`;
            const interpretationStarted=performance.now();
            const outcome = await measureActivityWork(timing,"interpretation",()=>handler.interpret(path,claimed,signal,{id:acceptanceId}));
            const interpretationMs=performance.now()-interpretationStarted;
            signal.throwIfAborted();
            await measureActivityWork(timing,"acceptance.persistence",()=>this.port.command({kind:"accept",receipt:{id:acceptanceId,requestId:stage!.request.id,
              resultId:claimed.result!.id,owner:path.intent.owner,expectedProgressRevision:path.progressRevision,
              progress:outcome.progress,next:outcome.next,interpretationMs},executor:this.executor,expectedControlRevision:path.controlRevision,
              ...(outcome.participants?{participants:outcome.participants}:{})}));
            break;
          }
          case "settlement": {
            if (!handler.settle) {pending.push({requestId:item.requestId,reason:"settlement_handler_unavailable"});continue;}
            const acceptanceId=`${stage.request.id}:settlement:${path.controlRevision}`;
            const outcome=await measureActivityWork(timing,"settlement.interpretation",()=>handler.settle!(path,stage!,signal,{id:acceptanceId}));
            signal.throwIfAborted();
            await measureActivityWork(timing,"settlement.persistence",()=>this.port.command({kind:"settle",receipt:{id:acceptanceId,requestId:stage!.request.id,
              resultId:stage!.result!.id,owner:path.intent.purpose.contract.recoveryOwner,disposition:outcome.disposition},
              executor:this.executor,expectedControlRevision:path.controlRevision,
              ...(outcome.participants?{participants:outcome.participants}:{})}));
            break;
          }
        }
        progressed.push(item.requestId);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (isActivityDispatchWaitCode(code)) pending.push({requestId:item.requestId,reason:code});
        else if(signal.aborted)throw error;
        else if(["activity_stage_evidence_changed","activity_stop_evidence_changed","activity_stop_limitation_changed"].includes(String(code)))pending.push({requestId:item.requestId,reason:"stage_evidence_changed"});
        else if(await this.controlChanged(path,code))pending.push({requestId:item.requestId,reason:"control_changed"});
        else failures.push({requestId:item.requestId,error});
      }
    }
    return {progressed,pending,failures};
  }
  private async handleLimitation(handler:ActivityPurposeHandler,path:ActivityPathState,stage:ActivityStageState,limitation:ActivityProfessionalLimitation,signal:AbortSignal):Promise<boolean> {
    const expectedStageEvidence=activityStageEvidence(stage),id=`${stage.request.id}:professional-stop:${modelInputValueDigest({control:path.controlRevision,progress:path.progressRevision,expectedStageEvidence,limitation})}`;
    const outcome=await handler.handleLimitation!(path,stage,limitation,signal,{id});
    signal.throwIfAborted();if(outcome.kind==="wait")return false;
    await this.port.command({kind:"stop_professional_path",receipt:{id,requestId:stage.request.id,owner:path.intent.owner,
      expectedControlRevision:path.controlRevision,expectedProgressRevision:path.progressRevision,expectedStageEvidence,limitation,progress:outcome.progress}});
    return true;
  }
  private async controlChanged(original:ActivityPathState,code:unknown):Promise<boolean> {
    if(code!=="activity_cancelled"&&code!=="activity_control_conflict")return false;
    const current=await this.port.command({kind:"read_path",pathId:original.intent.id}) as ActivityPathState|null;
    return current!==null&&modelInputValueDigest(current.intent)===modelInputValueDigest(original.intent)&&
      current.controlRevision>original.controlRevision&&(code!=="activity_cancelled"||current.cancelled);
  }
  private outcome(runId:string):{progressed:string[];pending:{requestId:string;reason:string}[];errors:{requestId:string;error:unknown}[]} {
    let result=this.completed.get(runId);if(!result){result={progressed:[],pending:[],errors:[]};this.completed.set(runId,result);}return result;
  }
  private resultMatches(result: ActivityRawResult, attemptId: string): void {
    if (result.attemptId !== attemptId) throw new TypeError("activity_raw_result_scope_invalid");
  }
}
