import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {decideContextPreparation,REPRESENTATION_METHOD_PURPOSE,type ContextPreparationDecisionProposal,type ContextPreparationDecisionRecord,
  type ContextPreparationDecisionQuery,type PreparedContextInput} from "@agent-anything/agent-runtime/context-representation";
import type {ActivityPathIntent,ActivityPathState,ActivityStageRequest,ActivitySchedulingIntent,ActivityResourceAllowance,SharedAcceptanceProposal,SharedAcceptanceReceipt} from "@agent-anything/agent-runtime/activity";
import type {ContextUseScope,ContextUseControl} from "@agent-anything/context/selection";
import {ContextFoundationRecords} from "./ContextFoundationRecords.js";
import type {ExecutionContentRoot} from "./ExecutionContent.js";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";

export const CONTEXT_PREPARATION_DECISION_SCHEMA=`
CREATE TABLE context_policy_decisions(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,run_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,root TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE context_policy_heads(scope_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL);
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
    private readonly receipt:(id:string)=>SharedAcceptanceReceipt|null) {}

  query(query:ContextPreparationDecisionQuery):ContextPreparationDecisionRecord|null {
    let id:string|null=null;
    if(query.kind==="decision")id=query.id;
    if(query.kind==="latest")id=(this.records.sql("SELECT decision_id FROM context_policy_heads WHERE scope_id=?").get(query.scopeId) as {decision_id:string}|undefined)?.decision_id??null;
    if(query.kind==="exploration")id=(this.records.sql("SELECT decision_id FROM context_policy_investment_history WHERE scope_id=? AND exploration_key=?").get(query.scopeId,query.key) as {decision_id:string}|undefined)?.decision_id??null;
    if(!id)return null;
    const row=this.records.sql("SELECT root,digest,acceptance_id,scope_id,run_id FROM context_policy_decisions WHERE id=?").get(id) as {root:string;digest:string;acceptance_id:string;scope_id:string;run_id:string}|undefined;
    if(!row)return null;
    const value=this.hydrate(JSON.parse(row.root) as ExecutionContentRoot) as ContextPreparationDecisionRecord;
    if(modelInputValueDigest(value)!==row.digest||value.decision.id!==id||value.acceptanceId!==row.acceptance_id||value.decision.scope.id!==row.scope_id||value.decision.scope.runId!==row.run_id)throw new Error("context_policy_record_corrupt");
    return value;
  }

  participant():SharedAcceptanceParticipant {
    return {owner:"context_preparation_policy",kinds:["decision"],prepare:(part,acceptance)=>{
      const proposal=part.proposal as ContextPreparationDecisionProposal,decision=decideContextPreparation(proposal.input);
      if(acceptance.scope!==decision.scope.runId||acceptance.actor!=="context-representation")reject("decision_actor_invalid");
      for(const limitation of proposal.input.admissionLimitations??[]) {
        const receipt=this.receipt(limitation.acceptanceId);
        if(receipt?.outcome!=="rejected"||receipt.scope!==acceptance.scope||receipt.rejection?.owner!=="activity"||receipt.rejection.code!==limitation.code)
          reject("decision_admission_limitation_unconfirmed");
      }
      for(const item of [proposal.input.current,...proposal.input.alternatives.map(a=>a.input)])if(item.kind==="prepared"&&!this.confirmInput(decision.scope.runId,item.prepared))reject("decision_input_unconfirmed");
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
      const current=this.scope(decision.scope.id);
      if(modelInputValueDigest(current.scope)!==modelInputValueDigest(decision.scope))reject("decision_scope_changed");
      if(current.control.revision!==proposal.expectedControlRevision||!current.control.allowed&&proposal.input.consumerActive)reject("decision_control_changed");
      const head=this.records.sql("SELECT decision_id FROM context_policy_heads WHERE scope_id=?").get(decision.scope.id) as {decision_id:string}|undefined;
      if((head?.decision_id??null)!==proposal.expectedDecisionId)reject("decision_head_conflict");
      if(decision.investment.kind==="reuse") {
        const path=this.path(decision.investment.pathId);
        const progress=(path?.progress as {method?:{state:string}}|null)?.method;
        const original=this.records.sql("SELECT decision_id FROM context_policy_investments WHERE work_id=? AND path_id=? AND scope_id=?")
          .get(decision.investment.workId,decision.investment.pathId,decision.scope.id) as {decision_id:string}|undefined;
        const producer=original?this.query({kind:"decision",id:original.decision_id}):null;
        if(!path||path.cancelled||progress&&progress.state!=="working"||path.intent.runId!==decision.scope.runId||
          path.intent.scheduledWorkId!==decision.investment.workId||producer?.decision.applicabilityKey!==decision.applicabilityKey)reject("producer_binding_changed");
      }
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
      this.records.fact(decision.scope.runId,"context_preparation_policy",decision.id,"decision_accepted",{decision,acceptanceId:acceptance.id,investment:record.investment});
    }};
  }
  investments(input:{scopeId:string;afterWorkId:string|null;limit:number}):readonly ContextPreparationDecisionRecord[] {
    if(!input.scopeId||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>256)throw new TypeError("context_policy_query_invalid");
    const rows=this.records.sql("SELECT decision_id FROM context_policy_investments WHERE scope_id=? AND work_id>? ORDER BY work_id LIMIT ?")
      .all(input.scopeId,input.afterWorkId??"",input.limit) as {decision_id:string}[];
    return rows.map(row=>{const record=this.query({kind:"decision",id:row.decision_id});if(!record?.investment)throw new Error("context_policy_investment_corrupt");return record;});
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
    if(!schedule||!path||!stage||(!investment.previousPathId&&schedule.expectedRevision!==0)||schedule.intent.workId!==investment.workId||schedule.intent.runId!==decision.scope.runId||
      schedule.intent.scopeId!==decision.scope.runId||schedule.intent.decisionId!==decision.id||schedule.intent.owner!=="context-representation"||
      schedule.intent.reason!==decision.investment.reason||path.scheduledWorkId!==investment.workId||path.id!==investment.pathId||path.runId!==decision.scope.runId||
      stage.pathId!==path.id||!methodRequest||modelInputValueDigest(methodRequest)!==decision.investment.quotation.requestDigest||
      path.owner!=="context-representation"||modelInputValueDigest(path.purpose.contract)!==modelInputValueDigest(REPRESENTATION_METHOD_PURPOSE))reject("investment_handoff_mismatch");
    const replaces=decision.investment.replaces;
    if(Boolean(replaces)!==Boolean(investment.previousPathId))reject("investment_predecessor_missing");
    if(replaces) {
      if(!this.pathSettled(replaces.pathId))reject("investment_predecessor_unsettled");
      const original=this.path(replaces.pathId),progress=(original?.progress as {method?:{state:string;request:unknown}}|null)?.method;
      if(!original||!progress||!original.cancelled&&progress.state!=="gap"||replaces.pathId!==investment.previousPathId||replaces.workId!==investment.workId||
        original.intent.scheduledWorkId!==investment.workId||original.intent.runId!==decision.scope.runId||
        original.intent.resourceScope!==path.resourceScope||original.intent.deadlineAt!==path.deadlineAt||
        original.intent.permissionBasis!==path.permissionBasis||original.intent.maximumStages!==path.maximumStages||original.intent.maximumAttempts!==path.maximumAttempts||original.intent.maximumConcurrent!==path.maximumConcurrent||
        modelInputValueDigest(original.intent.resourceLimits)!==modelInputValueDigest(path.resourceLimits)||modelInputValueDigest(progress.request)===modelInputValueDigest(methodRequest))
        reject("investment_revision_invalid");
      const remaining=this.allowance(replaces.pathId),minimum=decision.investment.quotation.minimum;
      if(minimum.stages>original.intent.maximumStages-original.resourceUse.admittedStages||
        minimum.attempts>original.intent.maximumAttempts-original.resourceUse.dispatchedAttempts||
        minimum.modelCalls>(remaining.limits.modelCalls??0)-(remaining.reserved.modelCalls??0)||
        minimum.readBytes>(remaining.limits.readBytes??0)-(remaining.reserved.readBytes??0))reject("investment_remaining_resources_insufficient");
    }
  }
}
function reject(code:string):never {throw new SharedAcceptanceRejection("context_preparation_policy",code);}
