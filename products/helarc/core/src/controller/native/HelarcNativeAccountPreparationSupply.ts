import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort} from "@agent-anything/agent-runtime/activity";
import {INITIAL_CONTEXT_PREPARATION_POLICY,type ContextPreparationCurrentEvidence,type ContextInputReceptionOption,
  type ContextPreparationMethodRequest,type RepresentationMethodWork} from "@agent-anything/agent-runtime/context-representation";
import {supplyHelarcNativeAccountMethods,resupplyHelarcNativeAccountMethod,type HelarcNativeAccountMethodSupplyInput} from "./HelarcNativeAccountMethodSupply.js";
import {helarcNativeAccountCombinations,validateHelarcNativeAccountMembers} from "./HelarcNativeAccountCombinations.js";
import {HelarcNativeAccountReceptionCatalog,type HelarcNativeAccountReceptionBasis} from "./HelarcNativeAccountReceptionCatalog.js";
import type {HelarcNativeAccountReceptionWork} from "./HelarcNativeAccountReceptionWork.js";
import type {HelarcNativeAccountReceptionMember} from "./HelarcNativeAccountReception.js";
import type {HelarcNativePreparationSupply,HelarcNativePreparationReception} from "./HelarcNativeInputPreparation.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";

type Policy=ContextPreparationCurrentEvidence<ContextPreparationMethodRequest>;
export function helarcNativeAccountPreparationSupply(b:{readonly supply:HelarcNativeAccountMethodSupplyInput;
  readonly reception:Omit<HelarcNativeAccountReceptionBasis,"input">&{readonly input:Omit<HelarcNativeAccountReceptionBasis["input"],"members">};
  readonly rejectedInputs:NonNullable<Policy["rejectedInputs"]>;
},ports:{readonly activities:ActivityHandoffPort;readonly methods:RepresentationMethodWork;readonly receiver:HelarcNativeAccountReceptionWork}):HelarcNativePreparationSupply {
  const receptions=new HelarcNativeAccountReceptionCatalog({activities:ports.activities,work:ports.receiver});
  const scope=b.reception.input.scope;
  if(digest(b.supply.sources)!==digest(b.reception.input.prepared.workingSources)||digest(b.supply.composition)!==digest(b.reception.input.activity.composition))
    throw new TypeError("native_account_preparation_origin_changed");
  return {id:"helarc-native-account",origin:{activityDigest:digest(b.reception.input.activity),preparedDigest:digest(b.reception.input.prepared),
    inputNeedDigest:digest(b.reception.inputNeed),inputSupplyDigest:digest(b.reception.inputSupply),historyDigest:digest(b.reception.input.history)},
    owns:option=>option.request.method==="summarize"&&option.request.combine==="merge"&&option.stableScope?.owner==="helarc-native-input",
    ownsReception:path=>ports.receiver.ownsPurpose(path.intent.purpose.digest),
    collect:async({addresses,producers,receivers:originalReceivers,maximum},signal)=>{
      const supply={...b.supply,addresses},offered=supplyHelarcNativeAccountMethods({...supply,maximum});
      const reuseOptions:NonNullable<Policy["reuseOptions"]>[number][]=[],originalWork:NonNullable<NonNullable<Policy["methodSupplyReport"]>["originalWork"]>[number][]=[],
        available:{member:HelarcNativeAccountReceptionMember;workId:string;ready:boolean}[]=[];
      for(const producer of producers){
        signal.throwIfAborted();const investment=producer.record.investment!,decision=producer.record.decision.investment;
        if(decision.kind!=="propose")throw new TypeError("native_account_investment_missing");
        const option=producer.record.input.options.find(o=>o.id===decision.optionId)!;
        if(option.request.method==="protocol")throw new TypeError("native_account_requires_original_method_owner");
        const resupplied=resupplyHelarcNativeAccountMethod(supply,{...option,request:option.request});
        originalWork.push({workId:investment.workId,pathId:investment.pathId,optionId:option.id,available:resupplied.kind==="available",
          reason:resupplied.kind==="available"?"original_scope_and_request_revalidated":resupplied.reason});
        if(resupplied.kind!=="available")continue;
        reuseOptions.push({workId:investment.workId,pathId:investment.pathId,option:resupplied.supply.option});
        const result=await ports.methods.result(investment.pathId);
        if(result.kind==="ready"&&result.progress.resultIds.length!==1)throw new TypeError("native_account_merged_result_ambiguous");
        available.push({workId:investment.workId,ready:result.kind==="ready",member:{methodPathId:investment.pathId,
          candidateId:result.kind==="ready"?result.progress.resultIds[0]!:"",supply:resupplied.supply}});
      }
      const states:{basis:HelarcNativeAccountReceptionBasis;option:ContextInputReceptionOption;
        state:Awaited<ReturnType<HelarcNativeAccountReceptionCatalog["inspect"]>>}[]=[];
      const add=async(members:readonly HelarcNativeAccountReceptionMember[],expectedId?:string)=>{
        const basis={...b.reception,input:{...b.reception.input,members}},id=receptions.id(basis);
        if(expectedId&&expectedId!==id)throw new TypeError("native_account_original_reception_changed");
        if(states.some(r=>r.option.id===id))return id;
        const state=await receptions.inspect(basis,signal);
        if(expectedId&&state.kind==="not_started")throw new TypeError("native_account_original_reception_missing");
        const option:ContextInputReceptionOption={id,members:members.map(m=>{
          const original=available.find(a=>a.member.methodPathId===m.methodPathId);
          if(!original)throw new TypeError("native_account_original_producer_unavailable");
          return {pathId:m.methodPathId,workId:original.workId,requestDigest:digest(m.supply.request)};
        }).sort((a,b)=>a.pathId.localeCompare(b.pathId)),addresses,comparisons:[],evidence:{owner:scope.owner,kind:"fact",id,revision:"1"}};
        states.push({basis,option,state});return id;
      };
      const restored:string[]=[];
      for(const path of originalReceivers){
        const plan=await ports.receiver.readPlan(path.intent.id);
        if(!plan||digest(plan.inputSupply)!==digest(b.reception.inputSupply))throw new TypeError("native_account_original_reception_changed");
        restored.push(await add(plan.input.members,path.intent.id));
      }
      const enumeration=helarcNativeAccountCombinations({...supply,runId:scope.runId,members:available.filter(m=>m.ready).map(m=>m.member),
        maximum,maximumInspections:INITIAL_CONTEXT_PREPARATION_POLICY.maximumReceptionInspections}),returned:string[]=[];
      for(const members of enumeration.combinations)returned.push(await add(members));
      const receivers:HelarcNativePreparationReception[]=states.map(r=>{
        const s=r.state,outcome=s.kind==="not_started"||s.kind==="waiting"?null:s.outcome;
        const checked=outcome?.result.kind==="checked"?outcome.result.input:null;
        const rejection=checked?b.rejectedInputs.find(r=>r.targetRevision===scope.target&&r.bodyDigest===checked.bodyDigest):undefined;
        const outcomeEvidence=s.kind==="not_started"?null:{owner:"activity",kind:"fact" as const,id:`${s.id}:assess`,revision:String(s.path.progressRevision)};
        return {option:r.option,checked:s.kind==="checked"?checked:null,observeSources:s.observeSources,
          state:s.kind==="not_started"?null:{optionId:r.option.id,workId:s.workId,pathId:s.id,state:s.kind==="waiting"?"active":s.kind==="checked"?"checked":"unavailable",
            reason:s.kind==="unavailable"?s.reason:null,evidence:s.evidence,
            ...(outcome?.result.kind==="gap"?{inputGap:{kind:"gap" as const,gap:outcome.result.gap,evidence:outcomeEvidence!}}:{}),
            ...(rejection?{providerRejection:rejection}:{}),...(outcome?{outcomeEvidence:outcomeEvidence!}:{})},
          prepareStart:(id,decision,a,signal)=>receptions.prepareStart(r.basis,{intent:{...a.path,scheduledWorkId:a.workId},scheduling:{id:`${id}:receiver`,workId:a.workId,
            runId:scope.runId,scopeId:a.schedulingScopeId,owner:scope.owner,reason:decision.investment.kind==="prepare_input"?decision.investment.reason:"necessary",
            decisionId:decision.id,policyRevision:`${decision.policy.id}:${decision.policy.revision}`,delayImpact:"Check this recipient's complete native input",
            resources:a.resources,timing:a.timing}},signal),
          prepareAdoption:(input,signal)=>receptions.prepareAdoption(r.basis,input,signal)};
      });
      const offers=offered.offers.map(offer=>{
        let option={...offer.option,independentReception:{boundary:b.reception.input.prepared.sourceDigest,
          requirementsDigest:digest(helarcNativeInputRequirements(b.supply.sources.groups)),
          evidence:{id:b.reception.inputNeed.needId,owner:scope.owner,kind:"fact" as const,revision:"1"}}};
        for(const r of states){
          const state=receivers.find(i=>i.option.id===r.option.id)?.state,
            evidence=state?.inputGap?.gap.capacity.some(c=>!c.allowed)?state.inputGap.evidence:state?.providerRejection?.evidence;
          if(!evidence)continue;
          try{validateHelarcNativeAccountMembers({...supply,runId:scope.runId},[...r.basis.input.members,{methodPathId:offer.consumerId,candidateId:"proposed",supply:offer}]);}
          catch(error){if(error instanceof TypeError&&["native_account_members_invalid","native_account_replacement_overlap"].includes(error.message))continue;throw error;}
          option={...option,extendsReception:{optionId:r.option.id,evidence}};break;
        }
        return {option,pathId:offer.consumerId,materialAdmissions:offer.materialAdmissions};
      });
      return {offers,reuseOptions,report:{...offered.report,originalWork},receptions:receivers,
        receptionReport:{complete:enumeration.complete,examined:enumeration.examined,conflicts:enumeration.conflicts,returned,restored}};
    }};
}
