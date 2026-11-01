import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {InvocationInterruptionContext} from "@agent-anything/agent-core/control";
import type {AgentStopEvent} from "@agent-anything/agent-hooks/events";
import {ActivityChangeWait,type ActivityHandoffPort,type SharedAcceptancePort,type ActivityPathIntent,type ActivityPathState,
  type ActivitySchedulingIntent,type ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {validateContextInputUnavailability,type ContextInputUnavailability} from "@agent-anything/agent-runtime/context-representation";
import {HELARC_STOP_MODEL_PURPOSE,HelarcStopModelWork,interpretHelarcStopModelOutcome,type HelarcStopModelProgress} from "./HelarcStopModelWork.js";
import {validateHelarcStopModelSource,type HelarcStopExecution,type HelarcStopModelSource} from "./HelarcTaskFulfillmentHook.js";
import type {ProviderCallResult} from "@agent-anything/model-interaction";
import {readCurrentModelInputNeed} from "@agent-anything/agent-runtime/model-access";

interface Ports {
  readonly work:HelarcStopModelWork;
  readonly activities:ActivityHandoffPort;
  readonly acceptance:SharedAcceptancePort;
  readonly arrange:(source:HelarcStopModelSource,pathId:string)=>Promise<{
    readonly identity:Omit<ActivityPathIntent,"purpose"|"owner">;readonly schedule:ActivitySchedulingIntent;
  }>;
  readonly host:{assertAvailable():void;subscribe(listener:()=>void):()=>void;wake():void};
  readonly rediscoveryMs:number;
}

/** Waits for the original Stop work; execution remains with the independent Host service. */
export class HelarcStopModelExecution implements HelarcStopExecution {
  constructor(private readonly ports:Ports) {
    if(!Number.isSafeInteger(ports.rediscoveryMs)||ports.rediscoveryMs<1)throw new TypeError("stop_wait_bound_invalid");
  }
  execute(source:HelarcStopModelSource,interruption:InvocationInterruptionContext) {return this.receive(source,interruption);}
  async recover(event:AgentStopEvent,interruption:InvocationInterruptionContext) {
    const pathId=`${event.ref.id}:stop-work`,receipt=await this.ports.acceptance.query(`${pathId}:submission`);
    if(!receipt) {
      if(await this.path(pathId))throw new TypeError("stop_original_submission_missing");
      return null;
    }
    if(receipt.scope!==event.run.id||receipt.outcome!=="accepted")throw new TypeError("stop_original_submission_not_accepted");
    const stage=await this.stage(`${pathId}:source`),source=stage?.request.input as HelarcStopModelSource;
    validateHelarcStopModelSource(source);
    if(modelInputValueDigest(source.event)!==modelInputValueDigest(event))throw new TypeError("stop_recovery_event_changed");
    return this.receive(source,interruption);
  }
  private async receive(source:HelarcStopModelSource,interruption:InvocationInterruptionContext) {
    validateHelarcStopModelSource(source);
    const pathId=`${source.event.ref.id}:stop-work`,submissionId=`${pathId}:submission`,runId=source.event.run.id;
    this.ports.host.assertAvailable();
    const receipt=await this.ports.acceptance.query(submissionId);
    if(receipt) {
      if(receipt.scope!==runId||receipt.outcome!=="accepted")throw new TypeError("stop_original_submission_not_accepted");
    } else {
      interruption.signal.throwIfAborted();
      if(await this.path(pathId))throw new TypeError("stop_original_submission_missing");
      const arrangement=await this.ports.arrange(source,pathId);
      if(arrangement.identity.id!==pathId||arrangement.identity.runId!==runId||arrangement.schedule.runId!==runId||
        arrangement.schedule.owner!==HELARC_STOP_MODEL_PURPOSE.acceptanceOwner||arrangement.identity.scheduledWorkId!==arrangement.schedule.workId)
        throw new TypeError("stop_arrangement_changed");
      interruption.signal.throwIfAborted();
      const accepted=await this.ports.acceptance.accept({id:submissionId,scope:runId,actor:HELARC_STOP_MODEL_PURPOSE.acceptanceOwner,
        parts:this.ports.work.prepareSubmission(arrangement.identity,source,arrangement.schedule)});
      if(accepted.outcome!=="accepted")throw new TypeError(`stop_submission_rejected:${accepted.rejection?.code}`);
    }
    const originalPath=await this.path(pathId),originalStage=await this.stage(`${pathId}:source`);
    if(!originalPath||originalPath.intent.runId!==runId||originalPath.intent.owner!==HELARC_STOP_MODEL_PURPOSE.acceptanceOwner||
      originalPath.intent.purpose.digest!==modelInputValueDigest(HELARC_STOP_MODEL_PURPOSE)||!originalStage||
      originalStage.request.pathId!==pathId||originalStage.request.stageKind!=="source")throw new TypeError("stop_original_work_unavailable");
    const original=originalStage.request.input as HelarcStopModelSource;validateHelarcStopModelSource(original);
    // Measurement may evolve; recovery uses the accepted request, never a newly measured replacement.
    if(original.id!==source.id||modelInputValueDigest(original.event)!==modelInputValueDigest(source.event)||
      original.request.metadata.stopInstructionsRevision!==source.request.metadata.stopInstructionsRevision||
      modelInputValueDigest(original.request.interaction)!==modelInputValueDigest(source.request.interaction))throw new TypeError("stop_original_source_changed");
    const wake=new ActivityChangeWait(this.ports.host,interruption.signal);
    try {
      this.ports.host.wake();
      while(true) {
        const version=wake.version,path=await this.path(pathId);
        if(!path)throw new TypeError("stop_original_path_missing");
        const need=await readCurrentModelInputNeed(this.ports.activities,path,`${pathId}:input-need`,`${pathId}:source`);
        const model=need?await this.stage(need.stage.id):null,unavailable=need?await this.stage(need.unavailableStage.id):null;
        if(model&&unavailable)throw new TypeError("stop_input_outcomes_conflict");
        if(path.cancelled||interruption.signal.aborted) {
          if(!path.cancelled)await this.ports.activities.command({kind:"cancel",pathId,expectedControlRevision:path.controlRevision});
          this.ports.host.wake();
          throw new Error("stop_original_work_cancelled");
        }
        if(model?.status==="accepted")return this.assessment(path,model,original);
        if(unavailable?.status==="accepted") {
          this.accepted(path,unavailable);
          const limitation=unavailable.request.input as ContextInputUnavailability;validateContextInputUnavailability(limitation);
          const progress=unavailable.receipt!.progress as {kind:string;limitation:ContextInputUnavailability;rawResultId:string;sourceId:string};
          if(progress.kind!=="helarc_stop_input_unavailable"||progress.sourceId!==original.id||progress.rawResultId!==unavailable.result!.id||
            modelInputValueDigest(unavailable.result!.value)!==modelInputValueDigest({kind:"stop_input_limitation",digest:modelInputValueDigest(limitation)})||
            modelInputValueDigest(progress.limitation)!==modelInputValueDigest(limitation)||limitation.needId!==need!.id||
            limitation.supplier!==HELARC_STOP_MODEL_PURPOSE.inputOwner)throw new TypeError("stop_input_limitation_receipt_changed");
          throw new Error(`stop_input_unavailable:${limitation.reason}`);
        }
        const originalSource=await this.stage(`${pathId}:source`);
        if([model,unavailable,originalSource].some(s=>s?.status==="stopped"||s?.status==="settled"))throw new Error("stop_original_consumer_closed");
        this.ports.host.assertAvailable();
        const remaining=Date.parse(path.intent.deadlineAt)-Date.now();
        if(!Number.isFinite(remaining)||remaining<=0) {
          await this.ports.activities.command({kind:"cancel",pathId,expectedControlRevision:path.controlRevision});this.ports.host.wake();
          throw new Error("stop_original_work_deadline_exceeded");
        }
        await wake.wait(version,Math.min(remaining,this.ports.rediscoveryMs));
      }
    } finally {
      wake.close();
      if(interruption.signal.aborted) {
        const path=await this.path(pathId);
        if(path&&!path.cancelled)await this.ports.activities.command({kind:"cancel",pathId,expectedControlRevision:path.controlRevision});
      }
    }
  }
  private assessment(path:ActivityPathState,stage:ActivityStageState,source:HelarcStopModelSource) {
    this.accepted(path,stage);
    const progress=stage.receipt!.progress as HelarcStopModelProgress;
    if(progress?.kind!=="helarc_stop_model_result"||progress.sourceId!==source.id||progress.rawResultId!==stage.result!.id||progress.inputId!==`${stage.request.id}:input`)
      throw new TypeError("stop_original_result_binding_changed");
    const outcome=interpretHelarcStopModelOutcome(source,stage.result!.value as ProviderCallResult,stage.result!.recordedAt);
    if(modelInputValueDigest({assessment:progress.assessment,failure:progress.failure})!==modelInputValueDigest(outcome))throw new TypeError("stop_assessment_receipt_changed");
    if(outcome.failure!==null)throw new Error(`stop_model_result_unavailable:${JSON.stringify(outcome.failure)}`);
    if(!outcome.assessment)throw new TypeError("stop_assessment_missing");
    return outcome.assessment;
  }
  private accepted(path:ActivityPathState,stage:ActivityStageState) {
    if(stage.request.pathId!==path.intent.id||stage.status!=="accepted"||stage.result?.completeness!=="complete"||stage.result.outcome!=="returned"||
      stage.receipt?.owner!==HELARC_STOP_MODEL_PURPOSE.acceptanceOwner||stage.receipt.requestId!==stage.request.id||stage.receipt.resultId!==stage.result.id)
      throw new TypeError("stop_acceptance_receipt_changed");
  }
  private path(pathId:string) {return this.ports.activities.command({kind:"read_path",pathId}) as Promise<ActivityPathState|null>;}
  private stage(requestId:string) {return this.ports.activities.command({kind:"read_stage",requestId}) as Promise<ActivityStageState|null>;}
}
