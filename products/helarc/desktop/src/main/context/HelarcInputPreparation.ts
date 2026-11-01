import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {MaterialCustodyPort} from "@agent-anything/context/custody";
import type {ContextSelectionPort,ContextUseHead} from "@agent-anything/context/selection";
import {contextPreparationReconsideration,readContextPreparationHistory,readContextPreparationEvidence,decideContextPreparation,inputSupplyResponsibility,
  prepareOriginalInputSelection,OriginalInputRepresentationReception,
  originalInputReceptionCombinations,originalInputReceptionExtension,originalInputReceptionTemplate,
  type OriginalInputSource,type ContextPreparationDecisionStore,type ContextPreparationCurrentEvidence,type ContextPreparationExecutionArrangement,
  type RepresentationMethodWork,type ContextMethodInputSupply,type ContextMethodInputConsumer,
  type OriginalInputRepresentationReceptionBasis,type ContextInputReceptionOption,type InputSupplyHead,type InputSupplyResponsibilityPage,
  type ContextInputUnavailability,type OriginalInputSupplyDecision,type ContextPreparationDecisionProposal} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityReconsiderationPreparation,SharedAcceptancePart} from "@agent-anything/agent-runtime/activity";
import {createHelarcOriginalInputSupply,supplyHelarcOriginalInputRepresentationMethods,resupplyHelarcOriginalInputRepresentationMethod,type HelarcOriginalInputSupplyPorts} from "./HelarcOriginalInputSupply.js";

/** Product composition of source supply, common policy and recipient input work, not another policy. */
export function createHelarcInputPreparation<TSource extends OriginalInputSource>(ports:Omit<HelarcOriginalInputSupplyPorts<TSource>,"decide">&{
  readonly decisions:ContextPreparationDecisionStore;readonly selections:ContextSelectionPort;readonly materials:MaterialCustodyPort;
  readonly methods:RepresentationMethodWork;readonly methodInputs:ContextMethodInputSupply;readonly methodConsumers:ContextMethodInputConsumer;
}) {
  const reception=new OriginalInputRepresentationReception({activities:ports.activities,materials:ports.materials,inputs:ports.methodInputs,
    consumers:ports.methodConsumers,methods:ports.methods});
  return createHelarcOriginalInputSupply({...ports,receivers:ports.methodConsumers,decide:async(basis,binding,result,snapshot,signal)=>{
    const unavailable=(reason:string,evidence:ContextInputUnavailability["evidence"]):SharedAcceptancePart=>({owner:"activity",kind:"stage_submission",
      proposal:{...basis.need.unavailableStage,input:{kind:"context_input_unavailable",needId:basis.need.id,supplier:basis.need.supplier,
        boundary:binding.sources.boundary,reason,evidence} satisfies ContextInputUnavailability}});
    if(result.kind!=="available") {
      if(result.kind==="pending"||result.kind==="changed")throw new TypeError("helarc_unsettled_input_evidence");
      const path=await ports.activities.command({kind:"read_path",pathId:binding.preparation.id}) as import("@agent-anything/agent-runtime/activity").ActivityPathState;
      if(!path||(result.kind==="unassessed"?path.progressRevision!==result.origin.progressRevision:!path.cancelled))throw new TypeError("helarc_input_limitation_changed");
      const evidence={owner:"activity",kind:"fact",id:binding.preparation.id,revision:String(path.progressRevision)};
      return {decision:{...evidence,owner:basis.need.supplier,kind:"input_unavailable"},participants:[{owner:"activity",kind:"path_condition",proposal:{pathId:path.intent.id,
        expected:{controlRevision:path.controlRevision,progressRevision:path.progressRevision,cancelled:path.cancelled},requireSettled:false}},
        unavailable(result.kind==="unassessed"?result.reason:"input_preparation_cancelled",[evidence])],close:true};
    }
    const {scope,sources}=binding,host=await ports.binding(basis),{policy}=host.context;
    const head=await ports.selections.command({kind:"lookup_scope",scopeId:scope.id}) as ContextUseHead|null;
    if(head&&modelInputValueDigest(head.scope)!==modelInputValueDigest(scope))throw new TypeError("helarc_task_preparation_scope_changed");
    const observed=result.current.kind==="prepared"&&binding.observation?await readContextPreparationEvidence({scope,settingsRevision:host.context.id,
      sequence:binding.observation.sequence,observedAt:basis.sourceStage.result!.recordedAt,
      inputRevision:binding.rejectedInputs.length,
      representationContinuity:binding.observation.representationContinuity,
      prepared:result.current.prepared,evidence:result.current.evidence,decisions:ports.decisions,methods:ports.methods,activities:ports.activities},signal):null;
    const methodSupply={policy,addresses:[result.current.evidence.id,...observed?.pressure.map(p=>p.evidence.id)??[]]};
    const offered=supplyHelarcOriginalInputRepresentationMethods(binding,methodSupply);
    const current:ContextPreparationCurrentEvidence={scope,boundary:sources.boundary,
      requirementsDigest:modelInputValueDigest(sources.groups.map(g=>g.occurrences.map(o=>o.section.preservation??null))),
      current:result.current,currentRejectedInputId:null,rejectedInputs:binding.rejectedInputs.map(r=>({stageId:r.stageId,targetRevision:r.targetDigest,bodyDigest:r.bodyDigest,
        evidence:{owner:"model-access",kind:"fact" as const,id:r.rawResultId,revision:r.acceptanceId}})),alternatives:[],pressure:observed?.pressure??[],
      ...(observed?{observationReport:observed.report}:{}),options:offered.offers.map(o=>o.option),methodSupplyReport:offered.report,
      autoPrepare:host.context.settings.settings.autoRepresentation,consumerActive:!basis.consumer.cancelled};
    const history=await readContextPreparationHistory({current,decisions:ports.decisions,methods:ports.methods},signal);
    const reuseOptions:NonNullable<ContextPreparationCurrentEvidence["reuseOptions"]>[number][]=[];
    const originalWork:NonNullable<NonNullable<ContextPreparationCurrentEvidence["methodSupplyReport"]>["originalWork"]>[number][]=[];
    const suppliedMembers:{supply:Extract<ReturnType<typeof resupplyHelarcOriginalInputRepresentationMethod>,{kind:"available"}>["supply"];
      original:NonNullable<(typeof history.producers)[number]["record"]["investment"]>;ready:boolean}[]=[];
    const receivers:{use:OriginalInputRepresentationReceptionBasis;option:ContextInputReceptionOption;
      state:Awaited<ReturnType<OriginalInputRepresentationReception["inspect"]>>}[]=[];
    for(const producer of history.producers) {
      const original=producer.record.investment!,selected=producer.record.decision.investment;
      if(selected.kind!=="propose")throw new TypeError("helarc_task_preparation_original_investment_missing");
      const option=producer.record.input.options.find(o=>o.id===selected.optionId);
      if(!option)throw new TypeError("helarc_task_preparation_original_option_missing");
      signal.throwIfAborted();
      const supplied=resupplyHelarcOriginalInputRepresentationMethod(binding,methodSupply,option);
      originalWork.push({workId:original.workId,pathId:original.pathId,optionId:option.id,available:supplied.kind==="available",
        reason:supplied.kind==="available"?"original_scope_and_request_revalidated":supplied.reason});
      if(supplied.kind!=="available")continue;
      const offer=supplied.supply;
      reuseOptions.push({workId:original.workId,pathId:original.pathId,option:offer.option});
      if(original.schedulingScopeId!==host.treeScopeId)throw new TypeError("helarc_task_preparation_scheduling_scope_changed");
      suppliedMembers.push({supply:offer,original,ready:producer.description.state==="ready"});
    }
    const inputSupply={needId:basis.need.id,runId:basis.consumer.intent.runId,owner:basis.need.supplier,consumerPathId:basis.consumer.intent.id,
      source:{stageId:basis.sourceStage.request.id,requestDigest:modelInputValueDigest(basis.sourceStage.request)},configuration:binding.configuration};
    const common={sources,scope,checkTemplate:originalInputReceptionTemplate(sources),preparation:binding.input,inputSupply};
    const add=async(members:OriginalInputRepresentationReceptionBasis["members"],originalId?:string)=>{
      const use={...common,members},id=reception.id(use);
      if(originalId&&id!==originalId)throw new TypeError("helarc_original_reception_changed");
      if(receivers.some(r=>r.option.id===id))return id;
      const option:ContextInputReceptionOption={id,members:members.map(m=>{
        const original=suppliedMembers.find(p=>p.original.pathId===m.pathId)!.original;
        return {pathId:m.pathId,workId:original.workId,requestDigest:modelInputValueDigest(m.supply.request)};
      }).sort((a,b)=>a.pathId<b.pathId?-1:a.pathId>b.pathId?1:0),addresses:methodSupply.addresses,comparisons:[],
        evidence:{owner:"helarc-task-input",kind:"fact",id,revision:"1"}};
      const state=await reception.inspect(use,signal);
      if(originalId&&state.kind==="not_started")throw new TypeError("helarc_original_reception_missing");
      receivers.push({use,option,state});return id;
    };
    // Restore accepted consumers independently of the bounded search for new combinations.
    const restored:string[]=[],supplyHead=await ports.responsibilities.query({kind:"head",needId:basis.need.id}) as InputSupplyHead|null;
    if(supplyHead){
      if(modelInputValueDigest(supplyHead.binding)!==modelInputValueDigest(inputSupply))throw new TypeError("helarc_task_supply_binding_changed");
      let afterId:string|null=null;
      do {
        signal.throwIfAborted();
        const page=await ports.responsibilities.query({kind:"page",needId:basis.need.id,revision:supplyHead.revision,afterId,limit:128}) as InputSupplyResponsibilityPage;
        if(page.kind!=="page")throw new TypeError("helarc_task_supply_membership_changed");
        for(const entry of page.entries)if(entry.role==="method_reception") {
          const plan=await ports.methodInputs.readPlan(entry.target.pathId);
          if(!plan||modelInputValueDigest(plan.inputSupply)!==modelInputValueDigest(inputSupply))throw new TypeError("helarc_original_reception_plan_changed");
          const members=plan.producers.map(p=>{
            const found=suppliedMembers.find(s=>s.original.pathId===p.pathId);
            if(!found)throw new TypeError("helarc_original_reception_source_unavailable");
            return {pathId:p.pathId,supply:found.supply};
          });
          restored.push(await add(members,entry.target.pathId));
        }
        afterId=page.next;
      }while(afterId!==null);
    }
    const enumeration=originalInputReceptionCombinations({sources,members:suppliedMembers.filter(m=>m.ready).map(m=>({pathId:m.original.pathId,supply:m.supply})),
      maximum:policy.maximumOptions,maximumInspections:policy.maximumReceptionInspections});
    const returned:string[]=[];
    for(const members of enumeration.combinations)returned.push(await add(members));
    const inputReceptions=receivers.flatMap(r=>{
      const state=r.state;if(state.kind==="not_started")return [];
      const providerRejection=state.kind==="unavailable"?state.providerRejection:state.kind==="checked"?current.rejectedInputs?.find(f=>f.targetRevision===state.prepared.encoded.targetDigest&&f.bodyDigest===state.prepared.encoded.bodyDigest):undefined;
      if(!state.workId)throw new TypeError("helarc_input_reception_schedule_missing");
      return [{optionId:r.option.id,workId:state.workId,pathId:state.id,state:state.kind==="waiting"?"active" as const:state.kind==="checked"?"checked" as const:"unavailable" as const,
        ...(state.kind==="unavailable"&&state.inputGap?{inputGap:state.inputGap}:{}),
        ...(providerRejection?{providerRejection}:{}),
        reason:state.kind==="unavailable"?state.reason:null,evidence:{id:state.id,revision:state.revision,owner:scope.owner,kind:"fact" as const}}];
    });
    const options=offered.offers.map(offer=>{
      const extendsReception=originalInputReceptionExtension({sources,proposed:{pathId:offer.consumerId,supply:offer},
        receptions:receivers.flatMap(r=>{
          const received=inputReceptions.find(i=>i.optionId===r.option.id);
          return received?.inputGap||received?.providerRejection?[{optionId:r.option.id,members:r.use.members,
            ...(received.inputGap?{inputGap:received.inputGap}:{}),...(received.providerRejection?{providerRejection:received.providerRejection}:{})}]:[];
        })});
      return extendsReception?{...offer.option,extendsReception}:offer.option;
    });
    const preparedPolicy={...current,options,reuseOptions,methodSupplyReport:{...offered.report,originalWork},receptionOptions:receivers.map(r=>r.option),
      receptionSupplyReport:{complete:enumeration.complete,examined:enumeration.examined,conflicts:enumeration.conflicts,returned,restored},inputReceptions,alternatives:receivers.flatMap(r=>r.state.kind==="checked"?[{input:{kind:"prepared" as const,prepared:r.state.prepared,
      evidence:{owner:scope.owner,kind:"judgment" as const,id:r.state.progress.assessments.at(-1)!.id,revision:"1"}},comparisons:[]}]:[])};
    const execution=(id:string):ContextPreparationExecutionArrangement=>({
      path:{id,runId:scope.runId,permissionBasis:scope.authorityBasis,resourceScope:id,maximumStages:policy.method.maximumStages,
        maximumAttempts:policy.method.maximumAttempts,maximumConcurrent:1,deadlineAt:basis.consumer.intent.deadlineAt},
      workId:`${id}:work`,schedulingScopeId:host.treeScopeId,timing:{kind:"unknown"},resources:[
        ...["material-read","material-write"].map(capability=>({poolId:host.localPoolId,capability,units:1})),
        ...["model-access","model-measurement"].map(capability=>({poolId:host.modelPoolId,capability,units:1}))]});
    const handler=contextPreparationReconsideration({activities:ports.activities,decisions:ports.decisions,methods:ports.methods,resolve:async()=>({
      policy:preparedPolicy,expectedControlRevision:head?.control.revision??0,
      inputObservationSources:receivers.flatMap(r=>r.state.kind==="not_started"?[]:r.state.observeSources),
      prepareInputUnavailability:async(_id,decision)=>[unavailable(decision.investment.kind==="defer"||decision.investment.kind==="none"?
        decision.investment.reason:decision.foreground.kind==="limited"?decision.foreground.reason:"input_unavailable",
        [...decision.evidence,{owner:scope.owner,kind:"context_preparation_decision",id:decision.id,revision:decision.policy.revision}])],
      execution:decision=>{
        const investment=decision.investment;
        if(investment.kind!=="propose")throw new TypeError("helarc_task_method_investment_missing");
        const offer=offered.offers.find(o=>o.option.id===investment.optionId);
        if(!offer)throw new TypeError("helarc_task_method_offer_missing");
        return {...execution(offer.consumerId),materialAdmissions:offer.materialAdmissions};
      },
      prepareInputReception:async(id,decision,signal)=>{
        const investment=decision.investment;if(investment.kind!=="prepare_input")throw new TypeError("helarc_task_input_investment_missing");
        const receiver=receivers.find(r=>r.option.id===investment.optionId);
        if(!receiver)throw new TypeError("helarc_task_input_producer_changed");
        if(receiver.state.kind!=="not_started")return {participants:[],observeSources:receiver.state.observeSources};
        const arrangement=execution(reception.id(receiver.use));
        return reception.prepareStart(receiver.use,{intent:{...arrangement.path,scheduledWorkId:arrangement.workId},
          checkCapacity:{limits:binding.input.limits,reservations:binding.input.reservations,policy:{...binding.input.policy,purpose:common.checkTemplate.purpose},
            maximumCombinations:policy.input.maximumCombinations,maximumMeasurements:policy.input.maximumExternalMeasurements},checkBounds:policy.method.bounds,
          scheduling:{id:`${id}:input-consumer`,workId:arrangement.workId,runId:scope.runId,scopeId:host.treeScopeId,owner:scope.owner,
            reason:investment.reason,decisionId:decision.id,policyRevision:`${policy.id}@${policy.revision}`,
            delayImpact:"Prepare the selected original results for this recipient's complete input",timing:arrangement.timing,resources:arrangement.resources}},signal);
      },
      prepareInputAcceptance:async(id,decision,signal)=>{
        const foreground=decision.foreground;if(foreground.kind!=="continue")throw new TypeError("helarc_task_input_not_selected");
        const accept={id,scope,need:basis.need,sources,publications:binding.publications,expectedSelectionId:head?.selection?.id??null,
          expectedControlRevision:head?.control.revision??0,selectionId:`${basis.need.id}:selection`,inputId:`${basis.need.stage.id}:input`,releaseHolds:[]};
        if(result.current.kind==="prepared"&&foreground.preparedInputId===result.current.prepared.encoded.id)
          return prepareOriginalInputSelection({...accept,prepared:result.current.prepared}).acceptance;
        const receiver=receivers.find(r=>r.state.kind==="checked"&&r.state.prepared.encoded.id===foreground.preparedInputId);
        if(!receiver)throw new TypeError("helarc_task_checked_input_missing");
        return reception.prepareAdoption(receiver.use,accept,signal);
      }
    })});
    const proposal=await handler.prepare(snapshot,signal);
    const withScope=async(value:ActivityReconsiderationPreparation):Promise<OriginalInputSupplyDecision>=>{
      const accepted=value.participants.find(p=>p.owner==="context_preparation_policy"&&p.kind==="decision")?.proposal as ContextPreparationDecisionProposal|undefined;
      if(!accepted)throw new TypeError("helarc_task_preparation_decision_missing");
      const decision=decideContextPreparation(accepted.input),selected=decision.investment;
      const targets=new Map<string,"method_production"|"method_reception">();
      if(selected.kind==="reuse")targets.set(selected.pathId,"method_production");
      for(const receiver of receivers)if((selected.kind==="prepare_input"&&selected.optionId===receiver.option.id)||(selected.kind==="reuse_input"&&selected.pathId===receiver.state.id)||
        (decision.foreground.kind==="continue"&&receiver.state.kind==="checked"&&receiver.state.prepared.encoded.id===decision.foreground.preparedInputId)) {
        for(const member of receiver.option.members)targets.set(member.pathId,"method_production");
        if(receiver.state.kind!=="not_started")targets.set(receiver.state.id,"method_reception");
      }
      const supplyDependencies=[];
      for(const [pathId,role] of targets) {
        signal.throwIfAborted();const path=await ports.activities.command({kind:"read_path",pathId}) as import("@agent-anything/agent-runtime/activity").ActivityPathState|null;
        if(!path)throw new TypeError("helarc_task_supply_dependency_missing");
        supplyDependencies.push(inputSupplyResponsibility(role,path.intent));
      }
      return {...value,supplyDependencies,
        participants:value.participants.some(p=>p.owner==="context_selection"&&p.kind==="scope")?value.participants:
          [{owner:"context_selection",kind:"scope",proposal:scope},...value.participants],
        ...(value.rejected?{rejected:async receipt=>{const next=await value.rejected!(receipt);return next?withScope(next):null;}}:{})};
    };
    return withScope(proposal);
  }});
}
