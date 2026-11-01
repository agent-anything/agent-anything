import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {snapshotDelegationResult,snapshotRetainedDelegationNarrative,type DelegationResult} from "@agent-anything/agent-runtime/delegation";
import {RunRecoveryError} from "@agent-anything/agent-runtime/execution-coordinator";
import {ActivityChangeWait,type ActivityPathState,type ActivityStageState} from "@agent-anything/agent-runtime/activity";
import {type SourceMaterialPublicationWork,type SourceMaterialPublicationRequest,type PublishedSourceMaterial} from "@agent-anything/agent-runtime/context-representation";
import {CustodyMaterialAccess,type MaterialRecipient,type MaterialHold,type MaterialAccessDescription} from "@agent-anything/context/custody";
import type {HelarcReportHandoff,HelarcReportHandoffOutcome} from "@agent-anything/helarc/tools";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

export interface HelarcReportMaterialBinding {
  readonly child:MaterialRecipient;
  readonly parent:MaterialRecipient;
  readonly permissionBasis:string;
  readonly scopeId:string;
  readonly localPoolId:string;
  readonly deadlineAt:string;
  readonly maximumSourceBytes:number;
}

/** Reads a captured report, never reruns the Product's projection or the Child. */
export async function readRetainedHelarcReport(store:HelarcExecutionStore,candidate:DelegationResult) {
  const result=snapshotDelegationResult(candidate),parentId=result.correlation.origin.parent.run.id;
  const parent=await store.readLatestRun(parentId);
  const transfer=parent?.control.descendantTransfers.find(value=>value.childRunId===result.correlation.child.run.id);
  if(!transfer||transfer.status!=="settled"||transfer.relationId!==result.correlation.relation.ref.id||
    modelInputValueDigest(transfer.result)!==modelInputValueDigest(result)||!transfer.narrative||!result.narrative)
    throw new RunRecoveryError(parentId,"delegation_report_source_unavailable",result.ref.id);
  const record=snapshotRetainedDelegationNarrative(transfer.narrative,result.narrative.source);
  return {result,record};
}

/** Projection waits for shared work; interruption leaves the retained transfer unacknowledged. */
export function createHelarcReportMaterialHandoff(input:{
  readonly store:HelarcExecutionStore;
  readonly publications:SourceMaterialPublicationWork;
  readonly binding:(result:DelegationResult)=>Promise<HelarcReportMaterialBinding>;
  readonly authorize:(result:DelegationResult,binding:HelarcReportMaterialBinding,signal:AbortSignal)=>Promise<boolean>;
  readonly host:{assertAvailable():void;subscribe(listener:()=>void):()=>void;wake():void};
  readonly rediscoveryMs:number;
  readonly now?:()=>number;
}):HelarcReportHandoff {
  if(!Number.isFinite(input.rediscoveryMs)||input.rediscoveryMs<=0)throw new TypeError("report_rediscovery_bound_invalid");
  const now=input.now??Date.now;
  return {async publish(candidate,signal) {
    let wake:ActivityChangeWait|null=null;
    let stop:((reason:ReportUnavailableReason)=>Promise<HelarcReportHandoffOutcome>)|null=null;
    try {
    const {result,record}=await readRetainedHelarcReport(input.store,candidate),binding=await input.binding(result),source=record.source;
    if(binding.child.runId!==source.runId||binding.parent.runId!==result.correlation.origin.parent.run.id||
      !Number.isSafeInteger(binding.maximumSourceBytes)||binding.maximumSourceBytes<source.bytes||!Number.isFinite(Date.parse(binding.deadlineAt)))
      throw new TypeError("report_material_binding_invalid");
    const pathId=`${source.recordId}:publication:${modelInputValueDigest(binding.child)}`,custodyId=`${pathId}:custody`;
    const request:SourceMaterialPublicationRequest={kind:"source_material_publication",bytesBase64:Buffer.from(record.text,"utf8").toString("base64"),
      recipient:binding.child,purpose:binding.child.purpose,target:"helarc.retained-report.v1",intent:{id:custodyId,instanceId:`${custodyId}:instance`,
        activityId:pathId,owner:"material-source",maximumBytes:binding.maximumSourceBytes,
        version:{ref:{materialId:source.recordId,version:source.digest},origin:{runId:source.runId,owner:"agent-runtime",recordId:source.recordId,
          revision:source.digest,occurredAt:result.createdAt},label:"Child report",format:"utf8",mediaType:"text/plain",bytes:source.bytes,
          digest:source.digest,capture:"complete",limitations:[]}}};
    const accessId=`${source.recordId}:parent:${modelInputValueDigest(binding.parent)}`;
    const stopBasis={result:result.ref,source,child:binding.child,parent:binding.parent};
    const deliver=async(published:PublishedSourceMaterial):Promise<HelarcReportHandoffOutcome>=>{
      const stage=await input.store.activityHandoffs.command({kind:"read_stage",requestId:`${pathId}:capture`}) as ActivityStageState|null;
      if(stage?.status!=="accepted"||published.version.digest!==source.digest||published.version.bytes!==source.bytes)
        throw new RunRecoveryError(binding.parent.runId,"report_publication_unconfirmed",pathId);
      if(signal.aborted)return await stop!("report_publication_cancelled");
      if(!await input.authorize(result,binding,signal))return await stop!("report_access_denied");
      if(signal.aborted)return await stop!("report_publication_cancelled");
      const hold:MaterialHold={id:`${accessId}:hold`,instanceId:request.intent.instanceId,consumer:binding.parent,
        responsibility:"detail",range:published.access.range,basis:result.ref.id,releaseCondition:"Explicit recipient detail retention release"};
      const accepted=await input.store.sharedAcceptance.accept({id:accessId,scope:binding.parent.runId,actor:"helarc.report-handoff",parts:[
        {owner:"material_custody",kind:"admit_access",proposal:{source:published.access,hold,grant:{id:`${accessId}:grant`,
          instanceId:request.intent.instanceId,recipient:binding.parent,range:published.access.range,revision:0,allowed:true,basis:binding.permissionBasis}}}]});
      if(accepted.outcome!=="accepted")throw new RunRecoveryError(binding.parent.runId,"report_access_admission_unconfirmed",accessId);
      if(signal.aborted)return await stop!("report_publication_cancelled");
      const description=await input.store.materialCustody.command({kind:"describe",holdId:hold.id,recipient:binding.parent}) as MaterialAccessDescription;
      if(signal.aborted)return await stop!("report_publication_cancelled");
      return {status:"published",reference:new CustodyMaterialAccess(input.store.materialCustody,binding.parent).reference(description)};
    };
    stop=async reason=>{
      let confirmed=false;
      // One-stage publication can advance or be cancelled while its owner accepts the stop.
      for(let reconsider=0;reconsider<3;reconsider++) {
        const old=await readReportStop(input.store,pathId,stopBasis);
        if(old){reason=old;confirmed=true;break;}
        const path=await input.store.activityHandoffs.command({kind:"read_path",pathId}) as ActivityPathState|null;
        const outcome=path?await input.publications.result(pathId):null;
        if(reason==="report_publication_deadline"&&outcome?.kind==="published_source_material")return await deliver(outcome);
        const expected=path?{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled}:null;
        const parts:import("@agent-anything/agent-runtime/activity").SharedAcceptancePart[]=[
          {owner:"activity",kind:"path_condition",proposal:{pathId,expected,requireSettled:false}}];
        if(path) {
          if(outcome?.kind!=="published_source_material"&&reason!=="report_publication_deadline")parts.push({owner:"activity",kind:"path_cancellation",proposal:{kind:"cancel",pathId,expectedControlRevision:path.controlRevision}});
        }
        await input.store.activityHandoffs.command({kind:"register_fact_source",source:{id:`${pathId}:delivery`,runId:source.runId,owner:"material-source"}});
        parts.push({owner:"activity",kind:"fact_publication",proposal:{id:`${pathId}:stop`,sourceId:`${pathId}:delivery`,
          ref:{owner:"material-source",kind:reason,id:pathId,revision:modelInputValueDigest({basis:stopBasis,reason})}}});
        const accepted=await input.store.sharedAcceptance.accept({id:`${pathId}:stop:${reason}:${modelInputValueDigest(parts)}`,scope:source.runId,actor:"material-source",parts});
        if(accepted.outcome==="accepted"){confirmed=true;break;}
        if(accepted.rejection?.code!=="activity_path_condition_changed")throw new RunRecoveryError(binding.parent.runId,"report_publication_stop_unconfirmed",pathId);
      }
      if(!confirmed)throw new RunRecoveryError(binding.parent.runId,"report_publication_stop_unconfirmed",pathId);
      // Shared recovery owns undisposed capture; consumer cancellation cannot cancel its cleanup.
      input.host.wake();
      const admission=await input.store.sharedAcceptance.query(accessId);
      if(admission?.outcome==="accepted")await input.store.materialCustody.command({kind:"release",holdId:`${accessId}:hold`,basis:`${accessId}:withdrawn`});
      return {status:"unavailable",reason};
    };
    wake=new ActivityChangeWait(input.host,signal);
      if(signal.aborted)return await stop("report_publication_cancelled");
      input.host.assertAvailable();
      const previousStop=await readReportStop(input.store,pathId,stopBasis);
      if(previousStop)return await stop(previousStop);
      if(!await input.authorize(result,binding,signal))return await stop("report_access_denied");
      if(signal.aborted)return await stop("report_publication_cancelled");
      const parts=input.publications.prepareIndependentSubmission({id:pathId,runId:source.runId,permissionBasis:binding.permissionBasis,resourceScope:pathId,
        scheduledWorkId:pathId,maximumStages:1,maximumAttempts:1,maximumConcurrent:1,deadlineAt:binding.deadlineAt},request,
        {id:`${pathId}:schedule`,workId:pathId,runId:source.runId,scopeId:binding.scopeId,owner:"material-source",decisionId:result.ref.id,
          policyRevision:"helarc.report-material.v2",reason:"necessary",delayImpact:"Deliver the retained Child report",timing:{kind:"unknown"},
          allowedPathIds:[pathId],resources:[{capability:"material-write",poolId:binding.localPoolId,units:1}]});
      const originalStage=parts.find(part=>part.kind==="stage_submission")!.proposal;
      const existing=await input.store.activityHandoffs.command({kind:"read_path",pathId}) as ActivityPathState|null;
      if(existing) {
        const stage=await input.store.activityHandoffs.command({kind:"read_stage",requestId:`${pathId}:capture`}) as ActivityStageState|null;
        if(existing.intent.purpose.digest!==input.publications.purpose.digest||existing.intent.permissionBasis!==binding.permissionBasis||
          existing.intent.deadlineAt!==binding.deadlineAt||!stage||modelInputValueDigest(stage.request)!==modelInputValueDigest(originalStage))
          throw new RunRecoveryError(binding.parent.runId,"report_publication_binding_changed",pathId);
      } else {
        if(Date.parse(binding.deadlineAt)<=now())return await stop("report_publication_deadline");
        const accepted=await input.store.sharedAcceptance.accept({id:`${pathId}:admit`,scope:source.runId,actor:"material-source",parts});
        if(accepted.outcome!=="accepted")throw new RunRecoveryError(binding.parent.runId,"report_publication_admission_unconfirmed",pathId);
      }
      input.host.wake();
      while(true) {
        const version=wake.version;
        if(signal.aborted)return await stop("report_publication_cancelled");
        try {input.host.assertAvailable();} catch {throw new RunRecoveryError(binding.parent.runId,"report_publication_host_unavailable",pathId);}
        const path=await input.store.activityHandoffs.command({kind:"read_path",pathId}) as ActivityPathState|null;
        if(!path)throw new RunRecoveryError(binding.parent.runId,"report_publication_unavailable",pathId);
        const published=await input.publications.result(pathId);
        if(published?.kind==="source_material_unavailable")return await stop(published.limitation.kind==="deadline"?"report_publication_deadline":"report_access_denied");
        if(path.cancelled)return await stop("report_publication_cancelled");
        if(published?.kind==="published_source_material")return await deliver(published);
        const remaining=Date.parse(binding.deadlineAt)-now();
        if(remaining<=0)return await stop("report_publication_deadline");
        await wake.wait(version,Math.min(input.rediscoveryMs,remaining));
      }
    } catch(error) {
      if(error instanceof RunRecoveryError)throw error;
      if(signal.aborted&&stop) {
        try {return await stop("report_publication_cancelled");}
        catch(settlementError) {error=new AggregateError([error,settlementError],"Report cancellation could not be confirmed");}
      }
      throw new RunRecoveryError(candidate.correlation.origin.parent.run.id,"report_material_handoff_unconfirmed",candidate.ref.id,{cause:error});
    } finally {wake?.close();}
  }};
}

type ReportUnavailableReason=Extract<HelarcReportHandoffOutcome,{status:"unavailable"}>["reason"];
async function readReportStop(store:HelarcExecutionStore,pathId:string,basis:unknown):Promise<ReportUnavailableReason|null> {
  const fact=await store.activityHandoffs.command({kind:"read_fact",id:`${pathId}:stop`}) as import("@agent-anything/agent-runtime/activity").ActivityPublishedFact|null;
  if(!fact)return null;
  const reason=fact.ref.kind;
  if(fact.id!==`${pathId}:stop`||fact.sourceId!==`${pathId}:delivery`||fact.ref.owner!=="material-source"||fact.ref.id!==pathId||
    !["report_publication_cancelled","report_publication_deadline","report_access_denied"].includes(reason)||
    fact.ref.revision!==modelInputValueDigest({basis,reason}))throw new TypeError("report_stop_fact_invalid");
  return reason as ReportUnavailableReason;
}
