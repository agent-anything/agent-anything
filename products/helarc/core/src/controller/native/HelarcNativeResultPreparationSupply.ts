import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityHandoffPort,type ActivityPathState,type SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import type {ContextPreparationCurrentEvidence,ContextPreparationMethodRequest,ContextInputReceptionOption,RepresentationMethodWork} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcNativePreparationSupply,HelarcNativePreparationReception} from "./HelarcNativeInputPreparation.js";
import {supplyHelarcNativeResultMethod,type HelarcNativeResultMethodBasis} from "./HelarcNativeResultMethodSupply.js";
import type {HelarcNativeResultBodySource} from "./HelarcNativeResultPublications.js";
import type {HelarcNativeResultReceptionWork,HelarcNativeResultReceptionPlan} from "./HelarcNativeResultReceptionWork.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";

type Policy=ContextPreparationCurrentEvidence<ContextPreparationMethodRequest>;
type Offer=ReturnType<typeof supplyHelarcNativeResultMethod>;
export interface HelarcNativeResultPreparationBasis {
  readonly methods:Omit<HelarcNativeResultMethodBasis,"source"|"addresses">;
  readonly sources:readonly HelarcNativeResultBodySource[];
  readonly exclusions:readonly {readonly id:string;readonly reason:string}[];
  readonly reception:{readonly input:Omit<HelarcNativeResultReceptionPlan["input"],"inputId"|"selectionId"|"methodPathId"|"callId"|"candidateId"|"sourceHold">;
    readonly inputNeed:HelarcNativeResultReceptionPlan["inputNeed"];readonly inputSupply:HelarcNativeResultReceptionPlan["inputSupply"]};
  readonly rejectedInputs:NonNullable<Policy["rejectedInputs"]>;
}

/** Source-specific offers and exact body reception, under the same policy as other method families. */
export function helarcNativeResultPreparationSupply(b:HelarcNativeResultPreparationBasis,ports:{readonly activities:ActivityHandoffPort;
  readonly methods:RepresentationMethodWork;readonly receiver:HelarcNativeResultReceptionWork}):HelarcNativePreparationSupply {
  const {input,inputNeed,inputSupply}=b.reception,scope=input.scope;
  if(digest(b.methods.activity)!==digest(input.activity)||digest(inputNeed.scope)!==digest(scope)||inputSupply.needId!==inputNeed.needId||
    b.methods.authorizationBasis!==scope.authorityBasis||new Set(b.sources.map(s=>s.delivery.result.modelCallRef.id)).size!==b.sources.length)
    throw new TypeError("native_result_preparation_origin_changed");
  const condition=(path:ActivityPathState):SharedAcceptancePart=>({owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
    expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}});
  return {id:"helarc-native-result",origin:{activityDigest:digest(input.activity),preparedDigest:digest(input.prepared),inputNeedDigest:digest(inputNeed),
    inputSupplyDigest:digest(inputSupply),historyDigest:digest(input.history)},
    owns:o=>o.request.method==="summarize"&&o.request.combine==="keep"&&o.stableScope?.owner==="helarc-native-result",
    ownsReception:p=>ports.receiver.ownsPurpose(p.intent.purpose.digest),
    collect:async({addresses,producers,receivers:originalReceivers,maximum},signal)=>{
      const offers=b.sources.slice(0,maximum).map(source=>{
        const offer=supplyHelarcNativeResultMethod({...b.methods,source,addresses});
        return {...offer,option:{...offer.option,independentReception:{boundary:input.prepared.sourceDigest,
          requirementsDigest:digest(helarcNativeInputRequirements(input.prepared.workingSources!.groups)),
          evidence:{id:inputNeed.needId,owner:scope.owner,kind:"fact" as const,revision:"1"}}}};
      });
      const reuseOptions:NonNullable<Policy["reuseOptions"]>[number][]=[],originalWork:NonNullable<NonNullable<Policy["methodSupplyReport"]>["originalWork"]>[number][]=[],
        available:{offer:Offer;source:HelarcNativeResultBodySource;pathId:string;workId:string;candidateId:string|null}[]=[];
      for(const producer of producers){
        signal.throwIfAborted();const investment=producer.record.investment!,decision=producer.record.decision.investment;
        if(decision.kind!=="propose")throw new TypeError("native_result_original_investment_missing");
        const original=producer.record.input.options.find(o=>o.id===decision.optionId)!;
        const source=b.sources.find(s=>digest(s.delivery.result)===original.request.sourceBoundary);
        const offer=source?supplyHelarcNativeResultMethod({...b.methods,source,addresses}):null;
        const matches=offer?.option.id===original.id&&digest(offer.request)===digest(original.request);
        originalWork.push({pathId:investment.pathId,workId:investment.workId,optionId:original.id,available:!!matches,
          reason:matches?"original_declared_body_and_method_revalidated":"original_result_body_unavailable_or_changed"});
        if(!matches)continue;
        reuseOptions.push({pathId:investment.pathId,workId:investment.workId,option:offer!.option});
        const result=await ports.methods.result(investment.pathId);
        if(result.kind==="ready"&&result.progress.resultIds.length!==1)throw new TypeError("native_result_candidate_ambiguous");
        available.push({offer:offer!,source:source!,pathId:investment.pathId,workId:investment.workId,candidateId:result.kind==="ready"?result.progress.resultIds[0]!:null});
      }
      const receptions:HelarcNativePreparationReception[]=[],restored:string[]=[],returned:string[]=[];
      const add=async(member:typeof available[number],expectedId?:string)=>{
        if(!member.candidateId)throw new TypeError("native_result_original_candidate_unavailable");
        const originalInput={...input,methodPathId:member.pathId,candidateId:member.candidateId,callId:member.source.delivery.result.modelCallRef.id,sourceHold:member.offer.sourceHold};
        const id=`${inputNeed.needId}:result-reception:${digest({input:originalInput,inputNeed,inputSupply})}`;
        if(expectedId&&id!==expectedId)throw new TypeError("native_result_original_receiver_changed");
        if(receptions.some(r=>r.option.id===id))return id;
        const recipe={...originalInput,inputId:`${id}:input`,selectionId:`${id}:selection`},plan=await ports.receiver.readPlan(id);
        if(expectedId&&!plan)throw new TypeError("native_result_original_receiver_missing");
        if(plan&&(digest(plan.input)!==digest(recipe)||digest(plan.inputNeed)!==digest(inputNeed)||digest(plan.inputSupply)!==digest(inputSupply)))
          throw new TypeError("native_result_original_receiver_changed");
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
            signal.throwIfAborted();if(await ports.receiver.readPlan(id))throw new TypeError("native_result_reception_already_started");
            const producer=await ports.activities.command({kind:"read_path",pathId:member.pathId}) as ActivityPathState|null;
            if(!producer||producer.cancelled||producer.intent.runId!==scope.runId||producer.intent.owner!==scope.owner||
              producer.intent.permissionBasis!==scope.authorityBasis||producer.intent.scheduledWorkId!==member.workId||a.path.id!==id)
              throw new TypeError("native_result_reception_producer_changed");
            const plan:HelarcNativeResultReceptionPlan={revision:"1",input:recipe,inputNeed,inputSupply,binding:{revision:"1",pathId:id,workId:a.workId,scope,
              boundary:input.prepared.sourceDigest,requirementsDigest:digest(helarcNativeInputRequirements(input.prepared.workingSources!.groups)),members:option.members}};
            return {observeSources,participants:[condition(producer),{owner:"activity",kind:"scheduling_acceptance",proposal:{kind:"schedule_work",expectedRevision:0,intent:{
              id:`${acceptanceId}:receiver`,workId:a.workId,runId:scope.runId,scopeId:a.schedulingScopeId,owner:scope.owner,allowedPathIds:[id],decisionId:decision.id,
              policyRevision:`${decision.policy.id}:${decision.policy.revision}`,reason:decision.investment.kind==="prepare_input"?decision.investment.reason:"necessary",
              delayImpact:"Check declared body substitution in the complete recipient input",resources:a.resources,timing:a.timing}}},
              ...ports.receiver.prepareSubmission({...a.path,scheduledWorkId:a.workId},plan)]};
          },prepareAdoption:(input,signal)=>ports.receiver.prepareAdoption(id,input,signal)});
        return id;
      };
      for(const path of originalReceivers){
        signal.throwIfAborted();const plan=await ports.receiver.readPlan(path.intent.id);
        const member=available.find(m=>m.pathId===plan?.input.methodPathId);
        if(!plan||!member)throw new TypeError("native_result_original_reception_source_unavailable");
        restored.push(await add(member,path.intent.id));
      }
      const ready=available.filter(m=>m.candidateId!==null);
      for(const member of ready.slice(0,maximum))returned.push(await add(member));
      return {offers:offers.map(({option,pathId,materialAdmissions})=>({option,pathId,materialAdmissions})),reuseOptions,receptions,
        report:{owner:"helarc-native-result",revision:"1",sourceBoundary:input.prepared.sourceDigest,
          enumeration:{complete:offers.length===b.sources.length,eligible:b.sources.length,returned:offers.length},originalWork,
          unavailable:b.exclusions.map(e=>({groupId:e.id,reasons:[e.reason]})),offers:offers.map(o=>({optionId:o.option.id,scopeId:o.option.stableScope!.id,
            requirementIds:o.request.requirements.map(r=>r.id),sources:o.request.sources.map(s=>({role:"source" as const,materialId:s.access.range.materialId,version:s.access.range.version}))}))},
        receptionReport:{complete:ready.length<=maximum,examined:ready.length,conflicts:0,returned,restored}};
    }};
}
