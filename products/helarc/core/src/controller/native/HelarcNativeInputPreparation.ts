import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {MaterialAccessAdmission} from "@agent-anything/context/custody";
import type {ContextSelectionPort,ContextUseHead} from "@agent-anything/context/selection";
import type {ActivityHandoffPort,ActivityPathState,ActivityInputNeed,ActivityReconsiderationSnapshot,SharedAcceptancePart,SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import {INITIAL_CONTEXT_PREPARATION_POLICY,readContextPreparationEvidence,readContextPreparationHistory,contextPreparationReconsideration,
  decideContextPreparation,inputSupplyResponsibility,originalInputLimitationFacts,type ContextPreparationMethodRequest,type ContextPreparationCurrentEvidence,
  type ContextPreparationOption,type ContextPreparationDecisionStore,type ContextPreparationDecisionProposal,type ContextInputReceptionOption,
  type ContextPreparationExecutionArrangement,type ContextRecipientInputReadiness,type InputSupplyBinding,type InputSupplyResponsibilityStore,
  type InputSupplyHead,type InputSupplyResponsibilityPage,type OriginalInputSupplyDecision} from "@agent-anything/agent-runtime/context-representation";
import type {HelarcNativeInputDemandWork} from "./HelarcNativeInputDemandWork.js";
import type {HelarcNativeOriginalInputWork} from "./HelarcNativeOriginalInputWork.js";
import type {HelarcNativePreparationMethods} from "./HelarcNativePreparationMethods.js";
import {helarcNativeInputRequirements} from "./HelarcNativeInputRequirements.js";

type Policy=ContextPreparationCurrentEvidence<ContextPreparationMethodRequest>;
type History=Awaited<ReturnType<typeof readContextPreparationHistory>>;
type Adoption={readonly id:string;readonly need:ActivityInputNeed;readonly expectedSelectionId:string|null;readonly expectedControlRevision:number};
export interface HelarcNativePreparationReception {
  readonly option:ContextInputReceptionOption;
  readonly state:NonNullable<Policy["inputReceptions"]>[number]|null;
  readonly checked:ContextRecipientInputReadiness|null;
  readonly observeSources:readonly string[];
  readonly prepareStart:(id:string,decision:ReturnType<typeof decideContextPreparation>,execution:ContextPreparationExecutionArrangement,signal:AbortSignal)=>Promise<{
    readonly participants:readonly SharedAcceptancePart[];readonly observeSources:readonly string[]}>;
  readonly prepareAdoption:(input:Adoption,signal:AbortSignal)=>Promise<SharedAcceptanceProposal>;
}
export interface HelarcNativePreparationSupply {
  readonly id:string;
  readonly origin:{readonly activityDigest:string;readonly preparedDigest:string;readonly inputNeedDigest:string;
    readonly inputSupplyDigest:string;readonly historyDigest:string};
  readonly owns:(option:ContextPreparationOption<ContextPreparationMethodRequest>)=>boolean;
  readonly ownsReception:(path:ActivityPathState)=>boolean;
  readonly collect:(input:{readonly addresses:readonly string[];readonly producers:History["producers"];
    readonly receivers:readonly ActivityPathState[];readonly maximum:number},signal:AbortSignal)=>Promise<{
    readonly offers:readonly {readonly option:ContextPreparationOption<ContextPreparationMethodRequest>;readonly pathId:string;readonly materialAdmissions:readonly MaterialAccessAdmission[]}[];
    readonly reuseOptions:NonNullable<Policy["reuseOptions"]>;
    readonly report:NonNullable<Policy["methodSupplyReport"]>;
    readonly receptions:readonly HelarcNativePreparationReception[];
    readonly receptionReport:NonNullable<Policy["receptionSupplyReport"]>;
  }>;
}
export interface HelarcNativeInputPreparationBasis {
  readonly demand:Extract<Awaited<ReturnType<HelarcNativeInputDemandWork["result"]>>,{kind:"needed"}>;
  readonly originalPathId:string;
  readonly inputSupply:InputSupplyBinding;
  readonly observation:{readonly settingsRevision:string;readonly sequence:number;readonly inputRevision:number;readonly representationContinuity:string};
  readonly autoPrepare:boolean;
  readonly methodComparisonRevision?:"13"|"14"|"15"|"legacy";
  readonly rejectedInputs:NonNullable<Policy["rejectedInputs"]>;
  readonly supplies:readonly HelarcNativePreparationSupply[];
  readonly execution:(id:string,limits:{maximumStages:number;maximumAttempts:number})=>ContextPreparationExecutionArrangement;
}

/** One policy decision across professional supplies; neither a model protocol nor a receiving implementation. */
export class HelarcNativeInputPreparation {
  constructor(private readonly ports:{readonly activities:ActivityHandoffPort;readonly decisions:ContextPreparationDecisionStore;
    readonly selections:ContextSelectionPort;readonly responsibilities:InputSupplyResponsibilityStore;
    readonly methods:Pick<HelarcNativePreparationMethods,"describe"|"prepareSubmission"|"prepareClosure">;readonly original:HelarcNativeOriginalInputWork}){}
  async prepare(b:HelarcNativeInputPreparationBasis,snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<OriginalInputSupplyDecision>{
    const {demand}=b,scope=demand.plan.inputNeed.scope,policy=INITIAL_CONTEXT_PREPARATION_POLICY;
    if(b.inputSupply.source.requestDigest!==digest(demand.source.request)||b.inputSupply.needId!==demand.need.id||
      b.inputSupply.consumerPathId!==demand.path.intent.id||new Set(b.supplies.map(s=>s.id)).size!==b.supplies.length)
      throw new TypeError("native_preparation_origin_changed");
    const original=await this.ports.original.result(b.originalPathId);
    if(original.kind!=="prepared"||digest(original.value.preparation.scope)!==digest(scope))throw new TypeError("native_original_preparation_unavailable");
    const originalPlan=(original.stage.request.input as {plan:{inputSupply:unknown;history:unknown}}).plan;
    if(digest(originalPlan.inputSupply)!==digest(b.inputSupply))throw new TypeError("native_original_preparation_changed");
    const origin={activityDigest:digest(demand.plan.activity),preparedDigest:digest(demand.plan.prepared),inputNeedDigest:digest(demand.plan.inputNeed),
      inputSupplyDigest:digest(b.inputSupply),historyDigest:digest(originalPlan.history)};
    if(b.supplies.some(s=>digest(s.origin)!==digest(origin)))throw new TypeError("native_preparation_supply_origin_changed");
    const head=await this.ports.selections.command({kind:"lookup_scope",scopeId:scope.id}) as ContextUseHead|null;
    if(head&&digest(head.scope)!==digest(scope))throw new TypeError("native_preparation_selection_scope_changed");
    const observed=await readContextPreparationEvidence({scope,...b.observation,observedAt:demand.source.result!.recordedAt,
      recipient:original.value.preparation.capacity,evidence:original.value.readiness.evidence,
      decisions:this.ports.decisions,methods:this.ports.methods,activities:this.ports.activities},signal);
    const current:Policy={scope,boundary:demand.plan.prepared.sourceDigest,
      requirementsDigest:digest(helarcNativeInputRequirements(demand.plan.prepared.workingSources!.groups)),current:original.value.readiness,currentRejectedInputId:null,
      rejectedInputs:b.rejectedInputs,alternatives:[],pressure:observed.pressure,observationReport:observed.report,
      options:[],autoPrepare:b.autoPrepare,consumerActive:!demand.path.cancelled};
    const history=await readContextPreparationHistory({current,decisions:this.ports.decisions,methods:this.ports.methods},signal);
    const receiverPaths:ActivityPathState[]=[],supplyHead=await this.ports.responsibilities.query({kind:"head",needId:demand.need.id}) as InputSupplyHead|null;
    if(supplyHead){
      if(digest(supplyHead.binding)!==digest(b.inputSupply))throw new TypeError("native_preparation_supply_binding_changed");
      let afterId:string|null=null;
      do{
        signal.throwIfAborted();const page=await this.ports.responsibilities.query({kind:"page",needId:demand.need.id,revision:supplyHead.revision,afterId,limit:128}) as InputSupplyResponsibilityPage;
        if(page.kind!=="page")throw new TypeError("native_preparation_supply_membership_changed");
        for(const entry of page.entries)if(entry.role==="method_reception"){
          const path=await this.ports.activities.command({kind:"read_path",pathId:entry.target.pathId}) as ActivityPathState|null;
          if(!path)throw new TypeError("native_preparation_original_reception_missing");receiverPaths.push(path);
        }
        afterId=page.next;
      }while(afterId!==null);
    }
    const ownerOf=(matches:readonly HelarcNativePreparationSupply[])=>{
      if(matches.length!==1)throw new TypeError("native_preparation_supply_owner_not_unique");return matches[0]!;
    };
    const producerOwners=history.producers.map(p=>{
      const decision=p.record.decision.investment;
      if(decision.kind!=="propose")throw new TypeError("native_preparation_investment_missing");
      const option=p.record.input.options.find(o=>o.id===decision.optionId);
      if(!option)throw new TypeError("native_preparation_original_option_missing");
      return ownerOf(b.supplies.filter(s=>s.owns(option))).id;
    });
    const receiverOwners=receiverPaths.map(p=>ownerOf(b.supplies.filter(s=>s.ownsReception(p))).id);
    const collected:Awaited<ReturnType<HelarcNativePreparationSupply["collect"]>>[]=[];
    const addresses=[original.value.readiness.evidence.id,...observed.pressure.map(p=>p.evidence.id)];
    for(const supply of b.supplies){
      signal.throwIfAborted();
      const producers=history.producers.filter((_,i)=>producerOwners[i]===supply.id),receivers=receiverPaths.filter((_,i)=>receiverOwners[i]===supply.id);
      const value=await supply.collect({addresses,producers,receivers,maximum:policy.maximumOptions},signal);
      const originals=value.report.originalWork??[];
      if(producers.some(p=>originals.filter(o=>o.pathId===p.record.investment!.pathId&&o.workId===p.record.investment!.workId).length!==1)||
        originals.some(o=>!producers.some(p=>p.record.investment!.pathId===o.pathId&&p.record.investment!.workId===o.workId))||
        receivers.some(p=>!value.receptionReport.restored.includes(p.intent.id))||value.offers.length>policy.maximumOptions||value.offers.some(o=>!supply.owns(o.option)))
        throw new TypeError("native_preparation_supply_evidence_incomplete");
      collected.push(value);
    }
    // Bound new opportunities across families; never truncate original accepted work.
    const offered:typeof collected[number]["offers"][number][]=[];
    for(let i=0;i<policy.maximumOptions&&offered.length<policy.maximumOptions;i++)for(const value of collected){
      if(value.offers[i]&&offered.length<policy.maximumOptions)offered.push(value.offers[i]!);
    }
    const receivers=collected.flatMap(v=>v.receptions);
    if(new Set(offered.map(o=>o.option.id)).size!==offered.length||new Set(receivers.map(r=>r.option.id)).size!==receivers.length)
      throw new TypeError("native_preparation_offer_identity_conflict");
    const reports=collected.map(c=>c.report),receiverReports=collected.map(c=>c.receptionReport);
    const preparedPolicy:Policy={...current,options:offered.map(o=>o.option),reuseOptions:collected.flatMap(v=>v.reuseOptions),
      methodSupplyReport:{owner:scope.owner,revision:"1",sourceBoundary:demand.plan.prepared.sourceDigest,
        enumeration:{complete:reports.every(r=>r.enumeration.complete)&&collected.reduce((n,c)=>n+c.offers.length,0)===offered.length,
          eligible:reports.reduce((n,r)=>n+r.enumeration.eligible,0),returned:offered.length},unavailable:reports.flatMap(r=>r.unavailable),
        offers:reports.flatMap(r=>r.offers).filter(r=>offered.some(o=>o.option.id===r.optionId)),originalWork:reports.flatMap(r=>r.originalWork??[]),
        ...(reports.some(r=>r.admissionEvidence)?{admissionEvidence:reports.flatMap(r=>r.admissionEvidence??[])}:{})},
      receptionOptions:receivers.map(r=>r.option),receptionSupplyReport:{complete:receiverReports.every(r=>r.complete),
        examined:receiverReports.reduce((n,r)=>n+r.examined,0),conflicts:receiverReports.reduce((n,r)=>n+r.conflicts,0),
        returned:receiverReports.flatMap(r=>r.returned),restored:receiverReports.flatMap(r=>r.restored)},
      inputReceptions:receivers.flatMap(r=>r.state?[r.state]:[]),alternatives:receivers.flatMap(r=>r.checked?[{input:r.checked,comparisons:[]}]:[])};
    const handler=contextPreparationReconsideration<ContextPreparationMethodRequest>({...this.ports,resolve:async()=>({policy:preparedPolicy,...b.methodComparisonRevision?{methodComparisonRevision:b.methodComparisonRevision}:{},expectedControlRevision:head?.control.revision??0,
      inputObservationSources:receivers.flatMap(r=>r.state?r.observeSources:[]),
      execution:decision=>{
        const investment=decision.investment,chosen=investment.kind==="propose"?offered.find(o=>o.option.id===investment.optionId):null;
        if(!chosen)throw new TypeError("native_preparation_method_offer_missing");
        return {...b.execution(chosen.pathId,chosen.option.limits),materialAdmissions:chosen.materialAdmissions};
      },
      prepareInputReception:async(id,decision,signal)=>{
        const investment=decision.investment,chosen=investment.kind==="prepare_input"?receivers.find(r=>r.option.id===investment.optionId):null;
        if(!chosen)throw new TypeError("native_preparation_receiver_offer_missing");
        return chosen.prepareStart(id,decision,b.execution(chosen.option.id,policy.method),signal);
      },
      prepareInputAcceptance:async(id,decision,signal)=>{
        if(decision.foreground.kind!=="continue")throw new TypeError("native_preparation_input_not_selected");
        const acceptance={id,need:demand.need,expectedSelectionId:head?.selection?.id??null,expectedControlRevision:head?.control.revision??0};
        if(decision.foreground.preparedInputId===original.value.readiness.inputId)return this.ports.original.prepareAdoption(b.originalPathId,acceptance,signal);
        const inputId=decision.foreground.preparedInputId,r=receivers.find(r=>r.checked?.inputId===inputId);
        if(!r)throw new TypeError("native_preparation_checked_input_missing");return r.prepareAdoption(acceptance,signal);
      },
      prepareInputUnavailability:async(_id,decision)=>{
        const failed=history.producers.filter(({description,record})=>description.state==="failed"&&description.limitations?.includes("compact_preservation_not_established")&&
          record.decision.applicabilityKey===decision.applicabilityKey&&decision.evidence.some(e=>
            (e.kind==="fact"&&e.owner==="context-representation"&&e.id===record.investment?.pathId&&e.revision===String(description.revision))||
            (description.limitationEvidence&&digest(e)===digest(description.limitationEvidence))));
        const issues=[...new Set(failed.flatMap(p=>p.description.assessmentIssues??[]))];
        return [{owner:"activity",kind:"stage_submission",proposal:{...demand.need.unavailableStage,input:{
        kind:"context_input_unavailable",needId:demand.need.id,supplier:scope.owner,boundary:current.boundary,
        ...originalInputLimitationFacts(current.current),...(failed.length?{preservationUnconfirmed:true}:{}),...(issues.length?{assessmentIssues:issues}:{}),
        reason:decision.investment.kind==="defer"||decision.investment.kind==="none"?decision.investment.reason:
          decision.foreground.kind==="limited"?decision.foreground.reason:"input_unavailable",evidence:decision.evidence}}}];}
    })});
    const finish=async(value:Awaited<ReturnType<typeof handler.prepare>>):Promise<OriginalInputSupplyDecision>=>{
      const accepted=value.participants.find(p=>p.owner==="context_preparation_policy"&&p.kind==="decision")?.proposal as ContextPreparationDecisionProposal|undefined;
      if(!accepted)throw new TypeError("native_preparation_decision_missing");
      const decision=decideContextPreparation(accepted.input,accepted.policyRevision??"legacy"),investment=decision.investment;
      const targets=new Map<string,"method_production"|"method_reception">();
      if(investment.kind==="reuse")targets.set(investment.pathId,"method_production");
      for(const r of receivers)if((investment.kind==="prepare_input"&&investment.optionId===r.option.id)||
        (investment.kind==="reuse_input"&&investment.pathId===r.option.id)||
        (decision.foreground.kind==="continue"&&r.checked?.inputId===decision.foreground.preparedInputId)){
        for(const member of r.option.members)targets.set(member.pathId,"method_production");
        if(r.state)targets.set(r.state.pathId,"method_reception");
      }
      const dependencies=[];
      for(const [pathId,role] of targets){
        const path=await this.ports.activities.command({kind:"read_path",pathId}) as ActivityPathState|null;
        if(!path)throw new TypeError("native_preparation_dependency_missing");dependencies.push(inputSupplyResponsibility(role,path.intent));
      }
      return {...value,supplyDependencies:dependencies,participants:value.participants.some(p=>p.owner==="context_selection"&&p.kind==="scope")?
        value.participants:[{owner:"context_selection",kind:"scope",proposal:scope},...value.participants],
        ...(value.rejected?{rejected:async receipt=>{const next=await value.rejected!(receipt);return next?finish(next):null;}}:{})};
    };
    return finish(await handler.prepare(snapshot,signal));
  }
}
