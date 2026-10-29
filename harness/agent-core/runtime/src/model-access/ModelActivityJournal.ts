import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ProviderRequest} from "@agent-anything/model-interaction";
import type {ActivityHandoffPort, ActivityExecutorIdentity, ActivityPathState, ActivityStageState, ActivityDispatchReceipt} from "../activity/ActivityHandoff.js";
import type {ModelActivityBinding} from "./ModelActivityBinding.js";
import {ActivityCheckpointError} from "../activity/ActivityCheckpoint.js";

export interface ModelActivityJournalSupport {
  readonly port: ActivityHandoffPort;
  readonly executor: ActivityExecutorIdentity;
  readonly scheduling?:{readonly pool:import("../activity/ActivityScheduling.js").ActivityResourcePool};
}
export class ModelActivityJournal {
  private readonly support: ModelActivityJournalSupport;
  constructor(support: ModelActivityJournalSupport, private readonly now: () => string) {
    this.support = {...support,port:{command:async command => {
      try {return await support.port.command(command);} catch (cause) {
        if(schedulingWait(cause))throw cause;
        throw new ActivityCheckpointError(`activity-handoff:${command.kind}`,{cause});
      }
    }}};
  }

  async bind(request: ProviderRequest, activity: ModelActivityBinding, deadlineAt: string): Promise<ActivityStageState> {
    const id = this.identity(request,activity);
    await this.support.port.command({kind:"open_path",intent:{id,runId:activity.runId,owner:activity.contract.contract.acceptanceOwner,
      purpose:activity.contract,permissionBasis:`model-target:${modelInputValueDigest({provider:request.composition.providerId,model:request.composition.model})}`,
      // This allowance binds one exchange. The caller and RetryExecutor retain
      // the enclosing activity and transport budgets across distinct exchanges.
      resourceScope:id,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt}});
    await this.support.port.command({kind:"submit",request:{id:`${id}:request`,pathId:id,stageKind:"model_request",input:request,
      capabilities:["model_request"],dependencies:[]}});
    return await this.support.port.command({kind:"admit",requestId:`${id}:request`,expectedControlRevision:0}) as ActivityStageState;
  }

  async dispatch(stage:ActivityStageState,signal:AbortSignal,deadlineAt:string):Promise<ActivityDispatchReceipt> {
    for(;;) {
      signal.throwIfAborted();
      if(stage.attempt)return {kind:"dispatch",stage,granted:false};
      if(Date.parse(this.now())>=Date.parse(deadlineAt))throw new ActivityCheckpointError("activity_dispatch_deadline");
      try {
        return await this.support.port.command({kind:"dispatch",attempt:{id:`${stage.request.id}:attempt`,requestId:stage.request.id,
          executor:this.support.executor,inputDigest:modelInputValueDigest(stage.request.input),startedAt:this.now()},expectedControlRevision:0}) as ActivityDispatchReceipt;
      } catch(error) {
        if(!schedulingWait(error))throw error;
        // This only accelerates durable discovery. It neither grants a slot nor repeats dispatch.
        await waitForDispatch(signal,Math.min(100,Math.max(1,Date.parse(deadlineAt)-Date.parse(this.now()))));
        stage=await this.support.port.command({kind:"read_stage",requestId:stage.request.id}) as ActivityStageState;
      }
    }
  }

  async save(stage: ActivityStageState, value: unknown): Promise<void> {
    if (!stage.attempt) throw new TypeError("model_activity_attempt_missing");
    const settlement = value as {kind?:string;response?:{kind?:string;usage?:unknown;turn?:{usage?:unknown}}};
    const usage = settlement.response?.kind === "native_tool_turn" ? settlement.response.turn?.usage : settlement.response?.usage;
    await this.support.port.command({kind:"save_raw",result:{id:`${stage.attempt.id}:raw`,attemptId:stage.attempt.id,
      completeness:"complete",outcome:settlement.kind === "activity_failure" ? "failed" : "returned",value,
      usage:usage && typeof usage === "object" ? usage as Readonly<Record<string,unknown>> : null,recordedAt:this.now()}});
  }

  async accept(request: ProviderRequest, activity: ModelActivityBinding, progress: unknown): Promise<void> {
    const requestId = `${this.identity(request,activity)}:request`;
    const stage = await this.support.port.command({kind:"read_stage",requestId}) as ActivityStageState | null;
    if (!stage?.result) throw new TypeError("model_activity_raw_result_missing");
    if (stage.receipt) return;
    const path = await this.support.port.command({kind:"read_path",pathId:stage.request.pathId}) as ActivityPathState;
    const claimId = `${requestId}:processing:${modelInputValueDigest(this.support.executor)}`;
    if (stage.processing?.id !== claimId) await this.support.port.command({kind:"claim_processing",claim:{id:claimId,requestId,
      previousClaimId:stage.processing?.id ?? null,executor:this.support.executor},expectedControlRevision:path.controlRevision});
    await this.support.port.command({kind:"accept",receipt:{id:`${requestId}:accepted`,requestId,resultId:stage.result.id,
      owner:activity.contract.contract.acceptanceOwner,expectedProgressRevision:path.progressRevision,progress,next:[]},
      executor:this.support.executor,expectedControlRevision:path.controlRevision});
  }

  private identity(request: ProviderRequest, activity: ModelActivityBinding): string {
    return `model-work:${modelInputValueDigest({activity:activity.id,requestId:request.requestId,continuation:request.continuation})}`;
  }
}
function schedulingWait(error:unknown):boolean {
  return !!error&&typeof error==="object"&&"code" in error&&["activity_schedule_not_ready","activity_schedule_turn_waiting","activity_slot_waiting"].includes(String(error.code));
}
function waitForDispatch(signal:AbortSignal,ms:number):Promise<void>{
  signal.throwIfAborted();return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
    signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  });
}
