import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {RESPONSES_COMPACT_METHOD} from "@agent-anything/provider-integrations/native";
import {activityFactSourceId,type ActivityHandoffPort,type ActivityPathState,type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import type {ContextPreparationCurrentEvidence,ContextPreparationMethodRequest,ContextInputReceptionOption,ProtocolRepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcNativePreparationSupply,HelarcNativePreparationReception} from "./HelarcNativeInputPreparation.js";
import {supplyHelarcResponsesCompactMethod,supplyHelarcResponsesCompactMethods,type HelarcResponsesCompactMethodBasis} from "./HelarcResponsesCompactMethodSupply.js";
import type {HelarcResponsesCompactReceptionWork,HelarcResponsesCompactReceptionPlan} from "./HelarcResponsesCompactReceptionWork.js";
import type {HelarcResponsesCompactWork} from "./HelarcResponsesCompactWork.js";
import type {HelarcResponsesCompactSource} from "./HelarcResponsesCompaction.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";

type Policy=ContextPreparationCurrentEvidence<ContextPreparationMethodRequest>;
type Offer=ReturnType<typeof supplyHelarcResponsesCompactMethod>;
export interface HelarcResponsesCompactPreparationBasis {
  readonly methods:Omit<HelarcResponsesCompactMethodBasis,"addresses">;
  readonly origin:HelarcNativePreparationSupply["origin"];
  readonly reception:{readonly input:Omit<HelarcResponsesCompactReceptionPlan["input"],"inputId"|"selectionId"|"methodPathId">;
    readonly originalInputPathId:string;readonly inputNeed:HelarcResponsesCompactReceptionPlan["inputNeed"];readonly inputSupply:HelarcResponsesCompactReceptionPlan["inputSupply"]};
  readonly rejectedInputs:NonNullable<Policy["rejectedInputs"]>;
}

/** Responses-specific supply participates in shared investment and adoption, without a private policy. */
export function helarcResponsesCompactPreparationSupply(b:HelarcResponsesCompactPreparationBasis,ports:{readonly activities:ActivityHandoffPort;
  readonly methods:HelarcResponsesCompactWork;readonly receiver:HelarcResponsesCompactReceptionWork}):HelarcNativePreparationSupply{
  const {input,inputNeed,inputSupply,originalInputPathId}=b.reception,scope=input.scope;
  if(digest(b.methods.native)!==digest(input.original)||digest(b.methods.publications)!==digest(input.publications)||
    digest(inputNeed.scope)!==digest(scope)||inputSupply.needId!==inputNeed.needId||b.methods.authorityBasis!==scope.authorityBasis||
    b.origin.inputNeedDigest!==digest(inputNeed)||b.origin.inputSupplyDigest!==digest(inputSupply))throw new TypeError("compact_preparation_origin_changed");
  const condition=(path:ActivityPathState):SharedAcceptancePart=>({owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
    expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}});
  return {id:RESPONSES_COMPACT_METHOD.id,origin:b.origin,
    owns:o=>o.request.method==="protocol"&&o.request.execution.owner===RESPONSES_COMPACT_METHOD.id,
    ownsReception:p=>ports.receiver.ownsPurpose(p.intent.purpose.digest),
    collect:async({addresses,producers,receivers:originalReceivers,maximum},signal)=>{
      const supplied=supplyHelarcResponsesCompactMethods({...b.methods,addresses},maximum);
      const reuseOptions:NonNullable<Policy["reuseOptions"]>[number][]=[],originalWork:NonNullable<NonNullable<Policy["methodSupplyReport"]>["originalWork"]>[number][]=[],
        available:{offer:Offer;pathId:string;workId:string;ready:boolean}[]=[];
      for(const producer of producers){
        signal.throwIfAborted();const investment=producer.record.investment!,decision=producer.record.decision.investment;
        if(decision.kind!=="propose")throw new TypeError("compact_original_investment_missing");
        const original=producer.record.input.options.find(o=>o.id===decision.optionId)!;
        const request=original.request as ProtocolRepresentationMethodRequest,source=request.execution.request as HelarcResponsesCompactSource;
        const current=supplyHelarcResponsesCompactMethod({...b.methods,addresses},source.groups.length);
        const identity=(s:HelarcResponsesCompactSource)=>({groups:s.groups,sourceDigest:s.sourceDigest,dependencies:s.dependencies,duties:s.duties,
          dutyBasis:s.dutyBasis,request:s.methodRequest,ancestry:s.ancestry});
        const matches=digest(identity(current.source))===digest(identity(source))&&digest(current.request.bounds)===digest(request.bounds);
        originalWork.push({pathId:investment.pathId,workId:investment.workId,optionId:original.id,available:matches,
          reason:matches?"original_native_prefix_and_duties_revalidated":"original_native_prefix_changed"});
        if(!matches)continue;
        const offer:Offer={...current,pathId:investment.pathId,source,request,option:{...original,request,addresses}};
        reuseOptions.push({pathId:investment.pathId,workId:investment.workId,option:offer.option});
        const result=await ports.methods.result(investment.pathId);
        available.push({offer,pathId:investment.pathId,workId:investment.workId,ready:result?.state==="ready"});
      }
      const receptions:HelarcNativePreparationReception[]=[],restored:string[]=[],returned:string[]=[];
      const add=async(member:typeof available[number],expectedId?:string)=>{
        const originalInput={...input,methodPathId:member.pathId};
        const id=`${inputNeed.needId}:compact-reception:${digest({input:originalInput,inputNeed,inputSupply,originalInputPathId})}`;
        if(expectedId&&id!==expectedId)throw new TypeError("compact_original_receiver_changed");
        if(receptions.some(r=>r.option.id===id))return id;
        const recipe={...originalInput,inputId:`${id}:input`,selectionId:`${id}:selection`},plan=await ports.receiver.readPlan(id);
        if(expectedId&&!plan)throw new TypeError("compact_original_receiver_missing");
        if(plan&&(digest(plan.input)!==digest(recipe)||digest(plan.inputNeed)!==digest(inputNeed)||digest(plan.inputSupply)!==digest(inputSupply)||
          plan.originalInputPathId!==originalInputPathId))throw new TypeError("compact_original_receiver_changed");
        const result=plan?await ports.receiver.result(id):null;
        const checked=result?.kind==="checked"?result.value.readiness:null,outcome=result&&"outcome" in result?result.outcome:null;
        const evidence={owner:scope.owner,kind:"fact" as const,id,revision:result?`${result.path.progressRevision}:${result.path.controlRevision}`:"1"};
        const outcomeEvidence=result?{owner:"activity",kind:"fact" as const,id:`${id}:stage:1`,revision:String(result.path.progressRevision)}:null;
        const option:ContextInputReceptionOption={id,members:[{pathId:member.pathId,workId:member.workId,requestDigest:digest(member.offer.request)}],addresses,comparisons:[],evidence};
        const observeSources=[activityFactSourceId("progress",id),activityFactSourceId("control",id)];
        const rejection=checked?b.rejectedInputs.find(r=>r.targetRevision===scope.target&&r.bodyDigest===checked.bodyDigest):null;
        receptions.push({option,checked,observeSources,state:result?{optionId:id,pathId:id,workId:result.path.intent.scheduledWorkId!,
          state:result.kind==="pending"?"active":result.kind==="checked"?"checked":"unavailable",reason:result.kind==="cancelled"?"receiver_cancelled":
            outcome?.result.kind==="gap"?outcome.result.gap.reason:null,evidence,
          ...outcome?.result.kind==="gap"?{inputGap:{kind:"gap" as const,gap:outcome.result.gap,evidence:outcomeEvidence!}}:{},
          ...outcome?{outcomeEvidence:outcomeEvidence!}:{},...rejection?{providerRejection:rejection}:{}}:null,
          prepareStart:async(acceptanceId,decision,a,signal)=>{
            signal.throwIfAborted();if(await ports.receiver.readPlan(id))throw new TypeError("compact_reception_already_started");
            const producer=await ports.activities.command({kind:"read_path",pathId:member.pathId}) as ActivityPathState|null;
            if(!producer||producer.cancelled||producer.intent.runId!==scope.runId||producer.intent.owner!==scope.owner||
              producer.intent.permissionBasis!==scope.authorityBasis||producer.intent.scheduledWorkId!==member.workId||a.path.id!==id)
              throw new TypeError("compact_reception_producer_changed");
            const plan:HelarcResponsesCompactReceptionPlan={revision:"1",input:recipe,inputNeed,inputSupply,originalInputPathId,binding:{revision:"1",
              pathId:id,workId:a.workId,scope,boundary:input.original.manifest.selection.boundary,
              requirementsDigest:digest(helarcNativeInputRequirements(input.original.workingSources!.groups)),members:option.members}};
            return {observeSources,participants:[condition(producer),{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:{
              id:`${acceptanceId}:receiver`,workId:a.workId,runId:scope.runId,scopeId:a.schedulingScopeId,owner:scope.owner,allowedPathIds:[id],decisionId:decision.id,
              policyRevision:`${decision.policy.id}:${decision.policy.revision}`,reason:decision.investment.kind==="prepare_input"?decision.investment.reason:"necessary",
              delayImpact:"Check the complete compacted native recipient input",resources:a.resources,timing:a.timing}}},
              ...ports.receiver.prepareSubmission({...a.path,scheduledWorkId:a.workId},plan)]};
          },prepareAdoption:(input,signal)=>ports.receiver.prepareAdoption(id,input,signal)});
        return id;
      };
      for(const path of originalReceivers){
        signal.throwIfAborted();const plan=await ports.receiver.readPlan(path.intent.id),member=available.find(m=>m.pathId===plan?.input.methodPathId);
        if(!plan||!member)throw new TypeError("compact_original_reception_source_unavailable");
        restored.push(await add(member,path.intent.id));
      }
      const ready=available.filter(m=>m.ready);
      for(const member of ready.slice(0,maximum))returned.push(await add(member));
      return {offers:supplied.offers.map(({option,pathId,materialAdmissions})=>({option,pathId,materialAdmissions})),reuseOptions,receptions,
        report:{...supplied.report,originalWork},receptionReport:{complete:ready.length<=maximum,examined:ready.length,conflicts:0,returned,restored}};
    }};
}
