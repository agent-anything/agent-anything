import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {snapshotDelegationResult,snapshotRetainedDelegationNarrative,type DelegationResult} from "@agent-anything/agent-runtime/delegation";
import {RunRecoveryError} from "@agent-anything/agent-runtime/execution-coordinator";
import {ActivityChangeWait,ActivityObservationCursor,type ActivityChangeInterest,type ActivityPathState,type ActivityStageState,type ActivityPurposeHandler} from "@agent-anything/agent-runtime/activity";
import {type SourceMaterialPublicationWork,type SourceMaterialPublicationRequest,type PublishedSourceMaterial} from "@agent-anything/agent-runtime/context-representation";
import {CustodyMaterialAccess,materialViewReference,type MaterialRecipient,type MaterialHold,type MaterialAccessDescription} from "@agent-anything/context/custody";
import type {HelarcReportHandoff,HelarcReportHandoffOutcome} from "@agent-anything/helarc/tools";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";

export interface HelarcReportDeliveryContract {
  registration(detail:MaterialHold,version:import("@agent-anything/context/custody").MaterialVersion):readonly import("@agent-anything/agent-runtime/activity").SharedAcceptancePart[];
  withdraw(reference:import("@agent-anything/context/material").ContextMaterialRef,recipient:MaterialRecipient,
    basis:{readonly id:string;readonly revision:string}):Promise<void>;
}

export interface HelarcReportMaterialBinding {
  readonly child:MaterialRecipient;
  readonly parent:MaterialRecipient;
  readonly permissionBasis:string;
  readonly scopeId:string;
  readonly localPoolId:string;
  readonly deadlineAt:string;
  readonly maximumSourceBytes:number;
}

type ReportTransferBasis={readonly parent:MaterialRecipient;readonly root:string;readonly relation:DelegationResult["correlation"]["relation"]["ref"];readonly result:DelegationResult["ref"]};

function transferBasis(result:DelegationResult,binding:HelarcReportMaterialBinding):ReportTransferBasis {
  return {parent:binding.parent,root:result.correlation.origin.root.run.id,relation:result.correlation.relation.ref,result:result.ref};
}

// Attested only after the report owner checks the settled transfer, original
// recipients and exact narrative. This owner's receipt precedes independently scheduled capture.
function captureFact(intent:ActivityPathState["intent"],request:ActivityStageState["request"]){
  const input=request.input as SourceMaterialPublicationRequest&{reportTransfer:ReportTransferBasis};
  return {id:`${intent.id}:capture-authority`,sourceId:`${intent.id}:report-owner`,
    handoff:{...input.reportTransfer,child:input.recipient,version:input.intent.version.ref,pathId:intent.id},
    ref:{owner:"helarc.report-handoff",kind:"accepted_report_capture",id:`${input.intent.version.ref.materialId}:parent:${modelInputValueDigest(input.reportTransfer.parent)}`,revision:modelInputValueDigest({intent,request})}};
}

export function reportCaptureAuthorization(store:HelarcExecutionStore,scope:ReturnType<typeof import("./HelarcRunActivityScope.js").createHelarcRunActivityScope>):ActivityPurposeHandler["authorize"] {
  const verify=scope.authorizeLocalHandoff(async(path,stage,signal,action)=>{
    const basis=(stage.request.input as {reportTransfer:ReportTransferBasis}).reportTransfer;
    if(!basis?.parent||!basis.relation||!basis.result)return {kind:"denied",code:"report_transfer_invalid",message:"Missing report transfer identity.",
      decision:{owner:"helarc.report-handoff",id:path.intent.id,revision:"1"}};
    const expected=captureFact(path.intent,stage.request);
    const fact=await store.activityHandoffs.command({kind:"read_fact",id:expected.id});
    const denied=(code:string,message:string)=>({kind:"denied" as const,code,message,decision:{owner:"helarc.report-handoff",id:path.intent.id,revision:expected.ref.revision}});
    if(!fact)return {kind:"temporary",code:"report_capture_basis_unavailable",message:"The report owner's original acceptance cannot be confirmed."};
    if(modelInputValueDigest(fact)!==modelInputValueDigest(expected))return denied("report_capture_basis_unconfirmed","The report owner has not accepted this exact source, recipient and capture.");
    const child=await scope.original(path.intent.runId),lineage=child.admission!.lineage;
    if(!basis||lineage.kind!=="descendant"||lineage.root.id!==basis.root||lineage.parent.id!==basis.parent.runId||lineage.relation.id!==basis.relation.id)
      return denied("report_delegation_changed","The original delegation does not identify this recipient.");
    if(action==="admission"||action==="execution"){
      const stop=await store.activityHandoffs.command({kind:"read_fact",id:`${path.intent.id}:stop`}) as import("@agent-anything/agent-runtime/activity").ActivityPublishedFact|null;
      if(stop&&stop.ref.kind!=="report_publication_deadline")return denied("report_publication_withdrawn","The original handoff was withdrawn.");
      const current=await store.readRunControl(basis.parent.runId);
      if(!current)throw new TypeError("report_recipient_control_unavailable");
      if(current.cancelled||current.terminal)return {kind:"denied",code:"report_recipient_closed",message:"The original Parent no longer accepts a new report delivery.",
        decision:{owner:"runtime",id:current.commitId,revision:String(current.revision)}};
    }
    signal.throwIfAborted();return {kind:"allowed"};
  });
  return (path,stage,signal,action)=>Object.hasOwn(stage.request.input as object,"reportTransfer")
    ?verify(path,stage,signal,action):scope.authorize(path,stage,signal,action);
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
  readonly host:{assertAvailable():void;subscribe(listener:()=>void,interest?:ActivityChangeInterest):()=>void;wake():void};
  readonly rediscoveryMs:number;
  readonly now?:()=>number;
  readonly deliveryContracts?:HelarcReportDeliveryContract;
  readonly assertNewDeliveryAllowed?:()=>void;
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
    const request:SourceMaterialPublicationRequest&{reportTransfer:ReportTransferBasis}={kind:"source_material_publication",reportTransfer:transferBasis(result,binding),bytesBase64:Buffer.from(record.text,"utf8").toString("base64"),
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
      if(!(await input.store.sharedAcceptance.query(accessId)))input.assertNewDeliveryAllowed?.();
      const accepted=await input.store.sharedAcceptance.accept({id:accessId,scope:binding.parent.runId,actor:"helarc.report-handoff",parts:[
        {owner:"report_recipient",kind:"require_open",proposal:{pathId,accessId,recipient:binding.parent}},
        {owner:"material_custody",kind:"admit_access",proposal:{source:published.access,hold,grant:{id:`${accessId}:grant`,
          instanceId:request.intent.instanceId,recipient:binding.parent,range:published.access.range,revision:0,allowed:true,basis:binding.permissionBasis}}},
        ...(input.deliveryContracts?.registration(hold,published.version)??[])]});
      if(accepted.rejection?.code==="report_recipient_closed")return await stop!("report_recipient_closed");
      if(accepted.rejection?.code==="report_publication_withdrawn"){
        const reason=await readReportStop(input.store,pathId,stopBasis);
        if(reason)return await stop!(reason);
      }
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
        parts.push({owner:"report_recipient",kind:"withdraw_access",proposal:{pathId,accessId,recipient:binding.parent}});
        const accepted=await input.store.sharedAcceptance.accept({id:`${pathId}:stop:${reason}:${modelInputValueDigest(parts)}`,scope:source.runId,actor:"material-source",parts});
        if(accepted.outcome==="accepted"){confirmed=true;break;}
        if(accepted.rejection?.code!=="activity_path_condition_changed")throw new RunRecoveryError(binding.parent.runId,"report_publication_stop_unconfirmed",pathId);
      }
      if(!confirmed)throw new RunRecoveryError(binding.parent.runId,"report_publication_stop_unconfirmed",pathId);
      // Shared recovery owns undisposed capture; consumer cancellation cannot cancel its cleanup.
      input.host.wake();
      const admission=await input.store.sharedAcceptance.query(accessId);
      if(admission?.outcome==="accepted"){
        if(input.deliveryContracts){
          const published=await input.publications.result(pathId);
          if(published?.kind!=="published_source_material")throw new RunRecoveryError(binding.parent.runId,"report_publication_unavailable",pathId);
          await input.deliveryContracts.withdraw(materialViewReference(published.access.range,published.version),binding.parent,
            {id:`${pathId}:stop`,revision:modelInputValueDigest({basis:stopBasis,reason})});
        }
        await input.store.materialCustody.command({kind:"release",holdId:`${accessId}:hold`,basis:`${accessId}:withdrawn`});
      }
      return {status:"unavailable",reason};
    };
    wake=new ActivityChangeWait(input.host,signal,{pathIds:[pathId]});
    const cursor=new ActivityObservationCursor(input.store.activityHandoffs,[pathId]);
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
        input.assertNewDeliveryAllowed?.();
        const intent=parts.find(part=>part.kind==="path_opening")!.proposal as ActivityPathState["intent"];
        const attestation=captureFact(intent,originalStage as ActivityStageState["request"]);
        await input.store.activityHandoffs.command({kind:"register_fact_source",source:{id:attestation.sourceId,runId:source.runId,owner:attestation.ref.owner}});
        const authority=await input.store.sharedAcceptance.accept({id:attestation.id,scope:source.runId,actor:attestation.ref.owner,
          parts:[{owner:"activity",kind:"fact_publication",proposal:attestation}]});
        if(authority.outcome!=="accepted")throw new RunRecoveryError(binding.parent.runId,"report_capture_basis_unconfirmed",attestation.id);
        const accepted=await input.store.sharedAcceptance.accept({id:`${pathId}:admit`,scope:source.runId,actor:"material-source",parts});
        if(accepted.outcome!=="accepted")throw new RunRecoveryError(binding.parent.runId,"report_publication_admission_unconfirmed",pathId);
      }
      input.host.wake();
      while(true) {
        const version=wake.version;
        if(signal.aborted)return await stop("report_publication_cancelled");
        try {input.host.assertAvailable();} catch {throw new RunRecoveryError(binding.parent.runId,"report_publication_host_unavailable",pathId);}
        if(!await cursor.changed()&&now()<Date.parse(binding.deadlineAt)) {
          await wake.wait(version,Math.max(0,Math.min(input.rediscoveryMs,Date.parse(binding.deadlineAt)-now())));continue;
        }
        const path=await input.store.activityHandoffs.command({kind:"read_path",pathId}) as ActivityPathState|null;
        if(!path)throw new RunRecoveryError(binding.parent.runId,"report_publication_unavailable",pathId);
        const published=await input.publications.result(pathId);
        if(published?.kind==="source_material_unavailable")return await stop(published.limitation.kind==="deadline"?"report_publication_deadline":
          published.limitation.kind==="authorization"&&published.limitation.refusal.code==="report_recipient_closed"?"report_recipient_closed":"report_access_denied");
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
    !["report_publication_cancelled","report_publication_deadline","report_access_denied","report_recipient_closed"].includes(reason)||
    fact.ref.revision!==modelInputValueDigest({basis,reason}))throw new TypeError("report_stop_fact_invalid");
  return reason as ReportUnavailableReason;
}
