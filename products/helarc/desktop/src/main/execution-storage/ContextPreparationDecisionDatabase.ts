import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {decideContextPreparation,contextPreparationDecisionEvidence,contextPreparationWorkKey,REPRESENTATION_METHOD_PURPOSE,type ContextPreparationMethodProgress,type ContextPreparationDecisionProposal,type ContextPreparationDecisionRecord,
  type ContextPreparationDecisionQuery,type PreparedContextInput,type ContextMethodInputPlan,type ContextInputReceptionBinding} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathIntent,ActivityPathState,ActivityStageRequest,ActivityStageState,ActivitySchedulingIntent,ActivityResourceAllowance,SharedAcceptanceProposal,SharedAcceptanceReceipt} from "@agent-anything/agent-runtime/activity";
import type {ContextUseScope,ContextUseControl} from "@agent-anything/context/selection";
import {ContextFoundationRecords} from "./ContextFoundationRecords.js";
import type {ExecutionContentRoot} from "./ExecutionContent.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";
import {validateModelInputRecoveryStage,type ModelInputRecoveryProgress} from "@agent-anything/agent-runtime/model-access";
import {readContextInputReceptionOutcome} from "@agent-anything/agent-runtime/context-representation";

export const CONTEXT_PREPARATION_DECISION_SCHEMA=`
CREATE TABLE context_policy_decisions(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,run_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,root TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE context_policy_heads(scope_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL);
CREATE TABLE context_policy_observation_heads(scope_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL);
CREATE TABLE context_policy_investments(work_id TEXT PRIMARY KEY,path_id TEXT NOT NULL UNIQUE,scope_id TEXT NOT NULL,decision_id TEXT NOT NULL,exploration_key TEXT,
 UNIQUE(scope_id,exploration_key));
CREATE TABLE context_policy_investment_history(path_id TEXT PRIMARY KEY,work_id TEXT NOT NULL,scope_id TEXT NOT NULL,decision_id TEXT NOT NULL,exploration_key TEXT,
 UNIQUE(scope_id,exploration_key));
`;
interface Prepared {proposal:ContextPreparationDecisionProposal;record:ContextPreparationDecisionRecord;root:ExecutionContentRoot;digest:string;}

/** Policy decisions and original investment identities, never a copy of execution or selection state. */
export class ContextPreparationDecisionDatabase {
  constructor(private readonly records:ContextFoundationRecords,
    private readonly retain:(value:unknown)=>ExecutionContentRoot,private readonly hydrate:(root:ExecutionContentRoot)=>unknown,
    private readonly scope:(id:string)=>{scope:ContextUseScope;control:ContextUseControl},
    private readonly path:(id:string)=>ActivityPathState|null,
    private readonly pathSettled:(id:string)=>boolean,
    private readonly allowance:(id:string)=>ActivityResourceAllowance,
    private readonly confirmInput:(runId:string,input:PreparedContextInput)=>boolean,
    private readonly receipt:(id:string)=>SharedAcceptanceReceipt|null,
    private readonly stage:(id:string)=>ActivityStageState|null,
    private readonly confirmRecipientInput:(input:import("@agent-anything/agent-runtime/context-representation").ContextRecipientInputReadiness)=>boolean=()=>false,
    private readonly confirmRecipientSelection:(input:import("@agent-anything/agent-runtime/context-representation").ContextRecipientInputReadiness)=>boolean=()=>false,
    private readonly confirmRecipientRejection:(input:import("@agent-anything/agent-runtime/model-access").ProtocolInputRejectionEvidence,scope:ContextUseScope)=>boolean=()=>false) {}

  query(query:ContextPreparationDecisionQuery):ContextPreparationDecisionRecord|null {
    let id:string|null=null;
    if(query.kind==="decision")id=query.id;
    if(query.kind==="latest")id=(this.records.sql("SELECT decision_id FROM context_policy_heads WHERE scope_id=?").get(query.scopeId) as {decision_id:string}|undefined)?.decision_id??null;
    if(query.kind==="latest_observation") {
      id=(this.records.sql("SELECT decision_id FROM context_policy_observation_heads WHERE scope_id=?").get(query.scopeId) as {decision_id:string}|undefined)?.decision_id??null;
    }
    if(query.kind==="exploration")id=(this.records.sql("SELECT decision_id FROM context_policy_investment_history WHERE scope_id=? AND exploration_key=?").get(query.scopeId,query.key) as {decision_id:string}|undefined)?.decision_id??null;
    if(!id)return null;
    const row=this.records.sql("SELECT root,digest,acceptance_id,scope_id,run_id FROM context_policy_decisions WHERE id=?").get(id) as {root:string;digest:string;acceptance_id:string;scope_id:string;run_id:string}|undefined;
    if(!row){if(query.kind==="latest_observation")throw new Error("context_policy_observation_corrupt");return null;}
    const value=this.hydrate(JSON.parse(row.root) as ExecutionContentRoot) as ContextPreparationDecisionRecord;
    if(modelInputValueDigest(value)!==row.digest||value.decision.id!==id||value.acceptanceId!==row.acceptance_id||value.decision.scope.id!==row.scope_id||value.decision.scope.runId!==row.run_id)throw new Error("context_policy_record_corrupt");
    if(query.kind==="latest_observation"&&(!value.input.observationReport||value.input.scope.id!==query.scopeId||value.decision.scope.id!==query.scopeId))
      throw new Error("context_policy_observation_corrupt");
    return value;
  }

  participant():SharedAcceptanceParticipant {
    return {owner:"context_preparation_policy",kinds:["decision"],prepare:(part,acceptance)=>{
      const proposal=part.proposal as ContextPreparationDecisionProposal;
      if((proposal.policyRevision===undefined)!==(proposal.decisionId===undefined))reject("decision_policy_binding_incomplete");
      if(proposal.policyRevision!==undefined&&(!["10","11","12","13","14","15"].includes(proposal.policyRevision)||typeof proposal.decisionId!=="string"))reject("decision_policy_binding_invalid");
      const decision=decideContextPreparation(proposal.input,proposal.policyRevision??"legacy");
      if(proposal.decisionId!==undefined&&proposal.decisionId!==decision.id)reject("decision_policy_binding_changed");
      if(acceptance.scope!==decision.scope.runId||acceptance.actor!=="context-representation")reject("decision_actor_invalid");
      this.validateInputRejections(proposal);
      for(const limitation of proposal.input.admissionLimitations??[]) {
        const receipt=this.receipt(limitation.acceptanceId);
        if(receipt?.outcome!=="rejected"||receipt.scope!==acceptance.scope||receipt.rejection?.owner!=="activity"||receipt.rejection.code!==limitation.code)
          reject("decision_admission_limitation_unconfirmed");
      }
      for(const item of [proposal.input.current,...proposal.input.alternatives.map(a=>a.input)])if(item.kind==="prepared"&&!this.confirmInput(decision.scope.runId,item.prepared))reject("decision_input_unconfirmed");
      for(const item of [proposal.input.current,...proposal.input.alternatives.map(a=>a.input),
        ...(proposal.input.receptionOptions??[]).flatMap(o=>o.sourceInput?[o.sourceInput]:[])])
        if(item.kind==="recipient_prepared"&&!this.confirmRecipientInput(item))reject("decision_input_unconfirmed");
      if(decision.investment.kind==="propose") {
        if(!proposal.investment)reject("investment_handoff_missing");
        this.validateHandoff(proposal,decision,acceptance);
      } else if(proposal.investment)reject("investment_without_decision");
      const original=this.query({kind:"decision",id:decision.id});
      if(original&&modelInputValueDigest(original.input)!==modelInputValueDigest(proposal.input))reject("decision_identity_conflict");
      const record=original??{decision,input:proposal.input,investment:proposal.investment,acceptanceId:acceptance.id};
      return {proposal,record,root:this.retain(record),digest:modelInputValueDigest(record)} satisfies Prepared;
    },apply:(prepared,acceptance)=>{
      const {proposal,record,root,digest}=prepared as Prepared,{decision}=record;
      const head=this.records.sql("SELECT decision_id FROM context_policy_heads WHERE scope_id=?").get(decision.scope.id) as {decision_id:string}|undefined;
      if((head?.decision_id??null)!==proposal.expectedDecisionId)reject("decision_head_conflict");
      if(decision.investment.kind==="reuse") {
        const {workId,pathId}=decision.investment;
        const path=this.path(decision.investment.pathId);
        const progress=(path?.progress as {method?:ContextPreparationMethodProgress}|null)?.method;
        const original=this.records.sql("SELECT decision_id FROM context_policy_investments WHERE work_id=? AND path_id=? AND scope_id=?")
          .get(decision.investment.workId,decision.investment.pathId,decision.scope.id) as {decision_id:string}|undefined;
        const producer=original?this.query({kind:"decision",id:original.decision_id}):null;
        const chosen=producer?.decision.investment.kind==="propose"?producer.input.options.find(o=>producer.decision.investment.kind==="propose"&&o.id===producer.decision.investment.optionId):null;
        const reusable=proposal.input.reuseOptions?.filter(work=>work.workId===workId&&work.pathId===pathId).map(work=>work.option)??[];
        if(!path||path.cancelled||(progress&&progress.state!=="working")||path.intent.runId!==decision.scope.runId||
          path.intent.scheduledWorkId!==decision.investment.workId||!chosen||!producer||![...proposal.input.options,...reusable].some(option=>
            contextPreparationWorkKey(decision.scope,option.request)===contextPreparationWorkKey(producer.input.scope,chosen.request)))reject("producer_binding_changed");
      }
      this.validateReceptionHandoff(proposal,decision,acceptance);
      const old=this.records.sql("SELECT digest FROM context_policy_decisions WHERE id=?").get(decision.id) as {digest:string}|undefined;
      if(old&&old.digest!==digest)reject("decision_identity_conflict");
      if(record.investment) {
        // Recheck execution responsibility inside the joint transaction, not only during preparation.
        this.validateHandoff(proposal,decision,acceptance);
        const key=decision.investment.kind==="propose"?decision.investment.explorationKey:null;
        if(key&&this.records.sql("SELECT 1 FROM context_policy_investment_history WHERE scope_id=? AND exploration_key=?").get(decision.scope.id,key))reject("exploration_already_accepted");
        const predecessor=record.investment.previousPathId;
        if(predecessor) {
          const original=this.records.sql("SELECT path_id,scope_id FROM context_policy_investments WHERE work_id=?").get(record.investment.workId) as {path_id:string;scope_id:string}|undefined;
          if(original?.path_id!==predecessor||original.scope_id!==decision.scope.id)reject("investment_predecessor_changed");
          this.records.sql("UPDATE context_policy_investments SET path_id=?,decision_id=?,exploration_key=? WHERE work_id=?")
            .run(record.investment.pathId,decision.id,key,record.investment.workId);
        } else {
          if(this.records.sql("SELECT 1 FROM context_policy_investments WHERE work_id=? OR path_id=?").get(record.investment.workId,record.investment.pathId))reject("investment_identity_conflict");
          this.records.sql("INSERT INTO context_policy_investments VALUES (?,?,?,?,?)").run(record.investment.workId,record.investment.pathId,decision.scope.id,decision.id,key);
        }
        this.records.sql("INSERT INTO context_policy_investment_history VALUES (?,?,?,?,?)").run(record.investment.pathId,record.investment.workId,decision.scope.id,decision.id,key);
      }
      if(!old)this.records.sql("INSERT INTO context_policy_decisions VALUES (?,?,?,?,?,?)").run(decision.id,decision.scope.id,decision.scope.runId,acceptance.id,JSON.stringify(root),digest);
      this.records.sql("INSERT INTO context_policy_heads VALUES (?,?) ON CONFLICT(scope_id) DO UPDATE SET decision_id=excluded.decision_id").run(decision.scope.id,decision.id);
      if(record.input.observationReport)this.records.sql("INSERT INTO context_policy_observation_heads VALUES (?,?) ON CONFLICT(scope_id) DO UPDATE SET decision_id=excluded.decision_id")
        .run(decision.scope.id,decision.id);
      const admissionRejections=(proposal.input.admissionLimitations??[]).map(limitation=>this.receipt(limitation.acceptanceId)!);
      this.records.fact(decision.scope.runId,"context_preparation_policy",decision.id,"decision_accepted",{decision,acceptanceId:acceptance.id,investment:record.investment,
        record:{owner:"context_preparation_policy",id:decision.id,revision:digest},
        observationReport:proposal.input.observationReport??null,
        methodSupplyReport:proposal.input.methodSupplyReport??null,
        receptionOptions:proposal.input.receptionOptions??[],receptionSupplyReport:proposal.input.receptionSupplyReport??null,
        inputReceptions:proposal.input.inputReceptions??[],
        currentInputEvidence:proposal.input.current.evidence,
        rejectedInputs:proposal.input.rejectedInputs??[],
        admissionRejections},contextPreparationDecisionEvidence(record,admissionRejections));
    },validate:(prepared,acceptance)=>{
      // A scope may be established by another participant in this same atomic acceptance.
      const {proposal,record:{decision}}=prepared as Prepared;
      const current=this.scope(decision.scope.id);
      if(modelInputValueDigest(current.scope)!==modelInputValueDigest(decision.scope))reject("decision_scope_changed");
      if(current.control.revision!==proposal.expectedControlRevision||!current.control.allowed&&proposal.input.consumerActive)reject("decision_control_changed");
      if(decision.foreground.kind==="continue"){
        const id=decision.foreground.preparedInputId;
        const selected=[proposal.input.current,...proposal.input.alternatives.map(a=>a.input)].find(v=>v.kind==="recipient_prepared"&&v.inputId===id);
        if(selected?.kind==="recipient_prepared"&&!this.confirmRecipientSelection(selected))reject("decision_selected_input_unconfirmed");
      }
      this.validateInputRejections(proposal);
      this.validateReceptionHandoff(proposal,decision,acceptance);
      if(decision.investment.kind==="propose")this.validateHandoff(proposal,decision,acceptance);
    }};
  }
  investments(input:{scopeId:string;afterWorkId:string|null;limit:number}):readonly ContextPreparationDecisionRecord[] {
    if(!input.scopeId||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>256)throw new TypeError("context_policy_query_invalid");
    const rows=this.records.sql("SELECT decision_id FROM context_policy_investments WHERE scope_id=? AND work_id>? ORDER BY work_id LIMIT ?")
      .all(input.scopeId,input.afterWorkId??"",input.limit) as {decision_id:string}[];
    return rows.map(row=>{const record=this.query({kind:"decision",id:row.decision_id});if(!record?.investment)throw new Error("context_policy_investment_corrupt");return record;});
  }
  private validateReception(proposal:ContextPreparationDecisionProposal,option:NonNullable<ContextPreparationDecisionProposal["input"]["receptionOptions"]>[number],plan:ContextMethodInputPlan|ContextInputReceptionBinding):void {
    const scope=proposal.input.scope,members=[...option.members].sort((a,b)=>a.pathId<b.pathId?-1:a.pathId>b.pathId?1:0);
    if(!members.length&&!option.sourceInput)reject("input_reception_binding_changed");
    if(option.sourceInput&&(!option.sourceInput.allowed||!this.confirmRecipientInput(option.sourceInput)))reject("input_reception_source_unconfirmed");
    if("materialization" in plan){
      // Previously retained generic plans preserve their recorded meaning; new native owners do not use this shape.
      if(option.sourceInput||plan.revision!=="5"||plan.materialization.intent.id!==option.id||modelInputValueDigest(plan.scope)!==modelInputValueDigest(scope)||
        plan.materialization.request.demand.historyBoundary!==proposal.input.boundary||plan.producers.length!==members.length||
        members.some((m,i)=>plan.producers[i]!.pathId!==m.pathId||plan.materialization.request.demand.dependencies[`representationProducer:${i}:producerRequest`]!==m.requestDigest))
        reject("input_reception_binding_changed");
    }else if(plan.revision!==(option.sourceInput?"2":"1")||modelInputValueDigest(plan.sourceInput??null)!==modelInputValueDigest(option.sourceInput??null)||
      !plan.workId||plan.pathId!==option.id||modelInputValueDigest(plan.scope)!==modelInputValueDigest(scope)||
      plan.boundary!==proposal.input.boundary||plan.requirementsDigest!==proposal.input.requirementsDigest||!Array.isArray(plan.members)||
      modelInputValueDigest([...plan.members].sort((a,b)=>a.pathId<b.pathId?-1:a.pathId>b.pathId?1:0))!==modelInputValueDigest(members))
      reject("input_reception_binding_changed");
    for(const member of members) {
      const row=this.records.sql("SELECT decision_id FROM context_policy_investments WHERE work_id=? AND path_id=? AND scope_id=?")
        .get(member.workId,member.pathId,scope.id) as {decision_id:string}|undefined;
      const original=row?this.query({kind:"decision",id:row.decision_id}):null;
      const chosen=original?.decision.investment.kind==="propose"?original.input.options.find(o=>original.decision.investment.kind==="propose"&&o.id===original.decision.investment.optionId):null;
      const path=this.path(member.pathId),progress=(path?.progress as {method?:ContextPreparationMethodProgress}|null)?.method;
      if(!chosen||modelInputValueDigest(chosen.request)!==member.requestDigest||!path||path.cancelled||progress?.state!=="ready"||
        modelInputValueDigest(progress.request)!==member.requestDigest||path.intent.runId!==scope.runId||path.intent.owner!==scope.owner||
        path.intent.permissionBasis!==scope.authorityBasis||path.intent.scheduledWorkId!==member.workId)reject("producer_binding_changed");
    }
  }
  private validateInputRejections(proposal:ContextPreparationDecisionProposal):void {
    for(const rejected of proposal.input.rejectedInputs??[]) {
      if(!("stageId" in rejected)) {
        if(!this.confirmRecipientRejection(rejected,proposal.input.scope))reject("provider_input_rejection_unconfirmed");
        continue;
      }
      const stage=this.stage(rejected.stageId),path=stage?this.path(stage.request.pathId):null;
      const progress=stage?.receipt?.progress as ModelInputRecoveryProgress|undefined;
      if(!stage||!path||!progress?.sourceStageId||path.intent.runId!==proposal.input.scope.runId||path.intent.permissionBasis!==proposal.input.scope.authorityBasis)
        reject("provider_input_rejection_unconfirmed");
      let original:ModelInputRecoveryProgress;
      try {original=validateModelInputRecoveryStage(path,stage,progress.sourceStageId);}catch {reject("provider_input_rejection_unconfirmed");}
      const prepared=stage.request.input as PreparedContextInput,scope=proposal.input.scope;
      if(original.rejected.rawResultId!==rejected.evidence.id||original.rejected.acceptanceId!==rejected.evidence.revision||rejected.evidence.owner!=="model-access"||
        original.rejected.targetDigest!==rejected.targetRevision||original.rejected.bodyDigest!==rejected.bodyDigest||
        prepared.demand.recipient!==scope.recipient||prepared.demand.purpose!==scope.purpose||prepared.demand.historyBoundary!==proposal.input.boundary)
        reject("provider_input_rejection_scope_changed");
    }
  }
  private validateReceptionHandoff(proposal:ContextPreparationDecisionProposal,decision:ContextPreparationDecisionRecord["decision"],acceptance:SharedAcceptanceProposal):void {
    for(const receiving of proposal.input.inputReceptions??[])if(receiving.checkedInput){
      const option=proposal.input.receptionOptions?.find(o=>o.id===receiving.optionId),path=this.path(receiving.pathId),
        first=this.stage(`${receiving.pathId}:stage:1`),binding=receptionBinding(first?.request.input),
        stage=receiving.outcomeEvidence?this.stage(receiving.outcomeEvidence.id):null;
      if(!option||!path||path.cancelled||!stage||!binding||"materialization" in binding||!receiving.outcomeEvidence||
        receiving.workId!==path.intent.scheduledWorkId||receiving.evidence.owner!==proposal.input.scope.owner||
        receiving.evidence.kind!=="fact"||receiving.evidence.id!==path.intent.id||
        receiving.evidence.revision!==`${path.progressRevision}:${path.controlRevision}`||
        receiving.outcomeEvidence.owner!=="activity"||receiving.outcomeEvidence.kind!=="fact"||
        receiving.outcomeEvidence.id!==stage.request.id||receiving.outcomeEvidence.revision!==String(path.progressRevision))
        reject("checked_reception_input_unconfirmed");
      let outcome:ReturnType<typeof readContextInputReceptionOutcome>;
      try{outcome=readContextInputReceptionOutcome(binding,path,stage);}catch{reject("checked_reception_input_unconfirmed");}
      if(outcome.result.kind!=="checked"||outcome.result.input.inputId!==receiving.checkedInput.inputId||
        outcome.result.input.exactInputDigest!==receiving.checkedInput.exactInputDigest)reject("checked_reception_input_unconfirmed");
      this.validateReception(proposal,option,binding);
    }
    if(decision.investment.kind==="prepare_input") {
      const id=decision.investment.optionId,option=proposal.input.receptionOptions?.find(o=>o.id===id);
      const entries=acceptance.parts.filter(p=>p.owner==="activity"&&p.kind==="stage_submission")
        .map(p=>p.proposal as ActivityStageRequest).filter(s=>s.id===`${id}:stage:1`);
      const plan=receptionBinding(entries[0]?.input);
      if(entries.length!==1||!option||!plan)reject("input_reception_handoff_missing");
      this.validateReception(proposal,option,plan);
      const schedule=acceptance.parts.filter(p=>p.owner==="activity"&&p.kind==="scheduling_acceptance")
        .map(p=>(p.proposal as {intent:ActivitySchedulingIntent}).intent).filter(s=>s.workId===("materialization" in plan?plan.materialization.intent.scheduledWorkId:plan.workId));
      if(schedule.length!==1||schedule[0]!.decisionId!==decision.id||schedule[0]!.reason!==decision.investment.reason)
        reject("input_reception_handoff_changed");
    }
    if(decision.investment.kind==="reuse_input") {
      const {pathId,workId}=decision.investment,path=this.path(pathId),stage=this.stage(`${pathId}:stage:1`);
      const reception=proposal.input.inputReceptions?.find(r=>r.pathId===pathId&&r.workId===workId);
      const plan=receptionBinding(stage?.request.input);
      if(!path||path.cancelled||path.intent.runId!==decision.scope.runId||path.intent.owner!==decision.scope.owner||
        path.intent.permissionBasis!==decision.scope.authorityBasis||path.intent.scheduledWorkId!==workId||
        !plan||("materialization" in plan?plan.materialization.intent.id!==pathId||plan.materialization.intent.scheduledWorkId!==workId:
          plan.pathId!==pathId||plan.workId!==workId)||!reception||reception.state!=="active")
        reject("input_reception_binding_changed");
      const option=proposal.input.receptionOptions?.find(o=>o.id===reception.optionId);
      if(!option)reject("input_reception_binding_changed");
      this.validateReception(proposal,option,plan);
    }
  }
  private validateHandoff(proposal:ContextPreparationDecisionProposal,decision:ContextPreparationDecisionRecord["decision"],acceptance:SharedAcceptanceProposal):void {
    const investment=proposal.investment!;
    if(decision.investment.kind!=="propose")reject("investment_decision_missing");
    const schedules=acceptance.parts.filter(p=>p.owner==="activity"&&p.kind==="scheduling_acceptance").map(p=>p.proposal as {intent:ActivitySchedulingIntent;expectedRevision:number}).filter(p=>p.intent.workId===investment.workId);
    const paths=acceptance.parts.filter(p=>p.owner==="activity"&&p.kind==="path_opening").map(p=>p.proposal as ActivityPathIntent).filter(p=>p.id===investment.pathId);
    const stages=acceptance.parts.filter(p=>p.owner==="activity"&&p.kind==="stage_submission").map(p=>p.proposal as ActivityStageRequest).filter(p=>p.pathId===investment.pathId);
    if(schedules.length!==1||paths.length!==1||stages.length!==1)reject("investment_handoff_ambiguous");
    const schedule=schedules[0],path=paths[0],stage=stages[0];
    const methodRequest=(stage?.input as {method?:{request?:unknown}}|undefined)?.method?.request;
    const selected=proposal.input.options.find(o=>decision.investment.kind==="propose"&&o.id===decision.investment.optionId)!;
    const purpose=path?.purpose.contract;
    const purposeMatches=selected.request.method==="protocol"?
      purpose?.executionOwner===selected.request.execution.owner&&purpose.inputOwner==="context-representation"&&
        purpose.acceptanceOwner==="context-representation"&&purpose.recoveryOwner===selected.request.execution.owner:
      modelInputValueDigest(purpose)===modelInputValueDigest(REPRESENTATION_METHOD_PURPOSE);
    if(!schedule||!path||!stage||(!investment.previousPathId&&schedule.expectedRevision!==0)||schedule.intent.workId!==investment.workId||schedule.intent.runId!==decision.scope.runId||
      !investment.schedulingScopeId?.trim()||schedule.intent.scopeId!==investment.schedulingScopeId||schedule.intent.decisionId!==decision.id||schedule.intent.owner!=="context-representation"||
      schedule.intent.reason!==decision.investment.reason||path.scheduledWorkId!==investment.workId||path.id!==investment.pathId||path.runId!==decision.scope.runId||
      stage.pathId!==path.id||!methodRequest||modelInputValueDigest(methodRequest)!==decision.investment.quotation.requestDigest||
      path.owner!=="context-representation"||!purposeMatches)reject("investment_handoff_mismatch");
    const replaces=decision.investment.replaces;
    if(selected.extendsReception) {
      const receiver=proposal.input.inputReceptions?.find(r=>r.optionId===selected.extendsReception!.optionId);
      const option=proposal.input.receptionOptions?.find(o=>o.id===selected.extendsReception!.optionId);
      const receiverPath=receiver?this.path(receiver.pathId):null;
      const first=receiver?this.stage(`${receiver.pathId}:stage:1`):null;
      if(receiver?.outcomeEvidence){
        const binding=receptionBinding(first?.request.input),evidence=receiver.outcomeEvidence,accepted=this.stage(evidence.id);
        if(!receiverPath||!option||!binding||"materialization" in binding||!accepted||receiver.evidence.id!==receiver.pathId||
          receiver.evidence.revision!==`${receiverPath.progressRevision}:${receiverPath.controlRevision}`||evidence.revision!==String(receiverPath.progressRevision))
          reject("reception_extension_outcome_unconfirmed");
        let outcome:ReturnType<typeof readContextInputReceptionOutcome>;
        try{outcome=readContextInputReceptionOutcome(binding,receiverPath,accepted);}catch{reject("reception_extension_outcome_unconfirmed");}
        if(receiver.providerRejection){
          const received=outcome.result.kind==="checked"?outcome.result.input:null,rejection=receiver.providerRejection;
          if(!received||!this.confirmRecipientInput(received)||received.bodyDigest!==rejection.bodyDigest||received.scope.target!==rejection.targetRevision||
            !("inputId" in rejection)||received.inputId!==rejection.inputId)reject("reception_extension_rejection_unconfirmed");
        }else if(outcome.result.kind!=="gap"||!receiver.inputGap||modelInputValueDigest(receiver.inputGap.evidence)!==modelInputValueDigest(evidence)||
          modelInputValueDigest(outcome.result.gap)!==modelInputValueDigest(receiver.inputGap.gap)||!outcome.result.gap.capacity.some(c=>!c.allowed))
          reject("reception_extension_gap_unconfirmed");
        this.validateReception(proposal,option,binding);
      }else{
        const plan=(first?.request.input as {methodInputPlan?:ContextMethodInputPlan}|undefined)?.methodInputPlan;
        const gap=receiver?.inputGap,assessment=gap?this.stage(gap.evidence.id):null;
        const organization=plan?this.path(plan.materialization.request.preparationIntent.id):null;
        const progress=organization?.progress as {state?:string;stageRequestId?:string;rawResultId?:string;gap?:unknown}|null;
        if(!receiver||!receiverPath||!option||!plan||!organization||receiver.evidence.id!==receiver.pathId||
          receiver.evidence.revision!==`${receiverPath.progressRevision}:${receiverPath.controlRevision}`)reject("reception_extension_gap_unconfirmed");
        if(receiver.providerRejection) {
          const current=organization.progress as {state?:string;prepared?:PreparedContextInput};
          if(current.state!=="prepared"||current.prepared?.encoded.bodyDigest!==receiver.providerRejection.bodyDigest||
            current.prepared.encoded.targetDigest!==receiver.providerRejection.targetRevision)reject("reception_extension_rejection_unconfirmed");
        } else if(!gap||!assessment||progress?.state!=="gap"||
          assessment.request.pathId!==organization.intent.id||assessment.request.id!==progress.stageRequestId||assessment.status!=="accepted"||
          assessment.result?.completeness!=="complete"||assessment.result.outcome!=="returned"||assessment.result.id!==progress.rawResultId||
          assessment.receipt?.resultId!==assessment.result.id||assessment.receipt.requestId!==assessment.request.id||
          assessment.receipt.owner!==decision.scope.owner||assessment.receipt.expectedProgressRevision+1!==organization.progressRevision||
          modelInputValueDigest(assessment.receipt.progress)!==modelInputValueDigest(organization.progress)||
          gap.evidence.owner!=="activity"||gap.evidence.kind!=="fact"||gap.evidence.revision!==String(organization.progressRevision)||
          modelInputValueDigest(progress.gap)!==modelInputValueDigest(gap.gap)||
          gap.gap.demandId!==plan.materialization.request.demand.id||!gap.gap.capacity.some(c=>!c.allowed))
          reject("reception_extension_gap_unconfirmed");
        this.validateReception(proposal,option,plan);
      }
    }
    if(Boolean(replaces)!==Boolean(investment.previousPathId))reject("investment_predecessor_missing");
    if(replaces) {
      if(!this.pathSettled(replaces.pathId))reject("investment_predecessor_unsettled");
      const original=this.path(replaces.pathId),progress=(original?.progress as {method?:ContextPreparationMethodProgress}|null)?.method;
      if(!original||!progress||!original.cancelled&&progress.state!=="gap"||replaces.pathId!==investment.previousPathId||replaces.workId!==investment.workId||
        original.intent.scheduledWorkId!==investment.workId||original.intent.runId!==decision.scope.runId||
        original.intent.resourceScope!==path.resourceScope||original.intent.deadlineAt!==path.deadlineAt||
        original.intent.permissionBasis!==path.permissionBasis||original.intent.maximumStages!==path.maximumStages||original.intent.maximumAttempts!==path.maximumAttempts||original.intent.maximumConcurrent!==path.maximumConcurrent||
        modelInputValueDigest(original.intent.resourceLimits)!==modelInputValueDigest(path.resourceLimits)||modelInputValueDigest(progress.request)===modelInputValueDigest(methodRequest))
        reject("investment_revision_invalid");
      const remaining=this.allowance(replaces.pathId),minimum=decision.investment.quotation.minimum;
      if((decision.policy.revision==="14"||decision.policy.revision==="15")&&(!progress.limitationEvidence||!replaces.observedLimitation||
        modelInputValueDigest(progress.limitationEvidence)!==modelInputValueDigest(replaces.observedLimitation)||
        decision.investment.quotation.costs.storedBytes.minimum>(remaining.limits.storedBytes??0)-(remaining.reserved.storedBytes??0)))
        reject("investment_revision_basis_unconfirmed");
      if(minimum.stages>original.intent.maximumStages-original.resourceUse.admittedStages||
        minimum.attempts>original.intent.maximumAttempts-original.resourceUse.dispatchedAttempts||
        minimum.modelCalls>(remaining.limits.modelCalls??0)-(remaining.reserved.modelCalls??0)||
        minimum.readBytes>(remaining.limits.readBytes??0)-(remaining.reserved.readBytes??0))reject("investment_remaining_resources_insufficient");
    }
  }
}
function receptionBinding(input:unknown):ContextMethodInputPlan|ContextInputReceptionBinding|null {
  if(!input||typeof input!=="object")return null;
  if("inputReception" in input)return input.inputReception as ContextInputReceptionBinding;
  return "methodInputPlan" in input?input.methodInputPlan as ContextMethodInputPlan:null;
}
function reject(code:string):never {throw new SharedAcceptanceRejection("context_preparation_policy",code);}
