import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {contextProcessObject as object,contextProcessRelationship as relationship} from "@agent-anything/context/evidence";
import {activityToken,activityCount,type SharedAcceptanceProposal,type ActivityInputNeed,type ActivityPathState,type ActivityStageState,
  type ActivitySchedulingAcceptance,type ActivityReconsiderationState} from "@agent-anything/agent-runtime/activity";
import {ContextMethodInputSupply,type InputSupplyHead,type AcceptedInputSupplyResponsibility,type InputSupplyExit,
  type InputSupplyExitProposal,type InputSupplyExitDisposition,type InputSupplyExitPending,type ContextMethodInputPlan} from "@agent-anything/agent-runtime/context-representation";
import {ContextFoundationRecords,checkedJson} from "./ContextFoundationRecords.js";
import {SharedAcceptanceRejection} from "./SharedAcceptanceDatabase.js";

export const INPUT_SUPPLY_EXIT_SCHEMA=`
CREATE TABLE context_input_supply_exits(need_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE context_input_supply_dispositions(need_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(need_id,id));
CREATE TABLE context_input_supply_schedules(work_id TEXT PRIMARY KEY,need_id TEXT NOT NULL UNIQUE);
CREATE TABLE context_input_supply_exit_coverage(need_id TEXT NOT NULL,path_id TEXT NOT NULL,responsibility_id TEXT NOT NULL,PRIMARY KEY(need_id,path_id));
`;
export interface InputSupplyPaths {
  readonly need:(id:string)=>ActivityInputNeed|null;
  readonly path:(id:string)=>ActivityPathState|null;
  readonly stage:(id:string)=>ActivityStageState|null;
  readonly subscription:(id:string)=>ActivityReconsiderationState|null;
  readonly scheduling:(id:string)=>ActivitySchedulingAcceptance|null;
  readonly settled:(id:string)=>boolean;
  readonly closure:(id:string)=>import("@agent-anything/agent-runtime/activity").ActivityReconsiderationReceipt|null;
}
const OWNER="context_input_supply";
type Row={value:string;digest:string};

/** Durable original-need exit; professional consumers retain their own cleanup responsibility. */
export class InputSupplyExitDatabase {
  constructor(private readonly records:ContextFoundationRecords,private readonly paths:InputSupplyPaths,
    private readonly head:(id:string)=>InputSupplyHead|null,
    private readonly entry:(needId:string,id:string)=>AcceptedInputSupplyResponsibility|null,
    private readonly changed:(exit:InputSupplyExit)=>void) {}

  read(needId:string):InputSupplyExit|null {
    activityToken(needId);const row=this.records.sql("SELECT revision,value,digest FROM context_input_supply_exits WHERE need_id=?").get(needId) as (Row&{revision:number})|undefined;
    if(!row)return null;
    const exit=checkedJson<InputSupplyExit>(row);
    if(exit.origin.needId!==needId||exit.revision!==row.revision)throw new Error("input_supply_exit_corrupt");
    return exit;
  }
  pending(needId:string,revision:number,limit:number):InputSupplyExitPending {
    activityCount(revision);activityCount(limit);if(limit>128)throw new TypeError("input_supply_page_limit_invalid");
    const exit=this.read(needId);if(!exit||exit.revision!==revision)return {kind:"changed",revision:exit?.revision??null};
    const rows=this.pendingRows(needId,limit+1);
    return {kind:"exit_pending",exit,entries:rows.slice(0,limit).map(row=>this.entry(needId,row.id)!),more:rows.length>limit,
      uncoveredPathId:rows.length?null:this.uncoveredPath(exit)};
  }
  prepare(proposal:InputSupplyExitProposal):InputSupplyExitProposal {
    const value=structuredClone(proposal);
    if(value.kind==="begin") {
      const o=value.origin;[o.needId,o.runId,o.owner,o.consumerPathId,o.source.stageId,o.source.requestDigest,value.subscriptionId].forEach(activityToken);
      activityCount(value.expectedMembershipRevision,true);activityCount(value.expectedConsumerControlRevision,true);
      if(value.basis.kind==="returned")[value.basis.stageId,value.basis.requestDigest].forEach(activityToken);
      else if(value.basis.kind==="cancelled")activityCount(value.basis.controlRevision,true);
      else throw new TypeError("input_supply_exit_basis_invalid");
    } else {
      activityToken(value.needId);activityCount(value.expectedRevision);
      if(value.kind==="dispose") {
        if(!value.dispositions.length||value.dispositions.length>16||new Set(value.dispositions.map(v=>v.responsibilityId)).size!==value.dispositions.length)
          throw new TypeError("input_supply_exit_dispositions_invalid");
        for(const item of value.dispositions){activityToken(item.responsibilityId);
          if(!["dependency_withdrawn","owned_settled","reception_transferred"].includes(item.kind))throw new TypeError("input_supply_exit_disposition_invalid");}
      } else if(value.kind!=="complete")throw new TypeError("input_supply_exit_command_invalid");
    }
    return value;
  }
  apply(value:InputSupplyExitProposal,acceptance:SharedAcceptanceProposal):void {
    if(value.kind==="begin") {
      if(this.read(value.origin.needId))reject("already_started");
      const head=this.head(value.origin.needId);
      if((head?.revision??0)!==value.expectedMembershipRevision||head&&!same(withoutConfiguration(head),value.origin))reject("membership_changed");
      const consumer=this.paths.path(value.origin.consumerPathId);
      if(!consumer||consumer.controlRevision!==value.expectedConsumerControlRevision)reject("consumer_control_changed");
      const exit:InputSupplyExit={origin:value.origin,subscriptionId:value.subscriptionId,membershipRevision:value.expectedMembershipRevision,
        scheduling:head?.scheduling??null,basis:value.basis,revision:1,status:"closing",acceptanceId:acceptance.id};
      this.origin(exit,acceptance);if(this.paths.subscription(exit.subscriptionId)!.closed)reject("subscription_closed");
      this.save(exit,"exit_started",acceptance);
      return;
    }
    const exit=this.read(value.needId);
    if(!exit||exit.revision!==value.expectedRevision||exit.status!=="closing")reject("revision_changed");
    this.origin(exit,acceptance);
    if(this.paths.subscription(exit.subscriptionId)!.closed)reject("subscription_closed");
    if(value.kind==="dispose")for(const disposition of value.dispositions) {
      const row=this.records.sql("SELECT value,digest FROM context_input_supply_dispositions WHERE need_id=? AND id=?").get(value.needId,disposition.responsibilityId) as Row|undefined;
      if(row) {
        const original=checkedJson<{disposition:InputSupplyExitDisposition}>(row);
        if(!same(original.disposition,disposition))reject("disposition_changed");
        continue;
      }
      const entry=this.entry(value.needId,disposition.responsibilityId);if(!entry)reject("responsibility_missing");
      const closure=disposition.kind==="reception_transferred"?this.paths.closure(`${entry.target.pathId}:consumer`):null;
      const coveredPathIds=this.coveredPaths(entry,disposition);
      const recorded={disposition,acceptanceId:acceptance.id,closureAcceptanceId:closure?.id??null,coveredPathIds};
      this.records.sql("INSERT INTO context_input_supply_dispositions VALUES(?,?,?,?)").run(value.needId,entry.id,JSON.stringify(recorded),digest(recorded));
      for(const pathId of coveredPathIds) {
        const existing=this.records.sql("SELECT responsibility_id FROM context_input_supply_exit_coverage WHERE need_id=? AND path_id=?").get(value.needId,pathId) as {responsibility_id:string}|undefined;
        if(existing&&existing.responsibility_id!==entry.id)reject("responsibility_coverage_conflict");
        this.records.sql("INSERT OR IGNORE INTO context_input_supply_exit_coverage VALUES(?,?,?)").run(value.needId,pathId,entry.id);
      }
      const subject=object(OWNER,entry.id,exit.origin.runId),subscriptionId=`${entry.target.pathId}:consumer`;
      this.records.fact(exit.origin.runId,OWNER,entry.id,disposition.kind,{needId:value.needId,exitRevision:exit.revision+1,target:entry.target,
        coveredPathIds,...(disposition.kind==="reception_transferred"?{subscriptionId,closureAcceptanceId:closure?.id??null}:{}),acceptanceId:acceptance.id},
        {revision:"1",category:"responsibility",subject,state:{phase:"settled",status:disposition.kind},related:[],relationships:[
          relationship("observes",subject,object("activity",value.needId,exit.origin.runId)),
          ...coveredPathIds.map(id=>{const path=this.paths.path(id);if(!path)reject("covered_path_missing");
            return relationship("observes",subject,object("activity",id,path.intent.runId));}),
          ...(entry.target.workId?[relationship("observes",subject,object("activity",entry.target.workId,exit.origin.runId))]:[]),
          ...(disposition.kind==="reception_transferred"?[relationship("delivers",subject,object("activity",subscriptionId,exit.origin.runId),"consumer_responsibility_transfer")]:[]),
          ...(closure?[relationship("observes",subject,object("activity",closure.id,exit.origin.runId))]:[]),
          relationship("settles",object("shared_acceptance",acceptance.id,acceptance.scope),subject),
        ]});
    }
    if(value.kind==="complete"&&this.pendingRows(value.needId,1).length)reject("responsibilities_unsettled");
    this.save({...exit,revision:exit.revision+1,status:value.kind==="complete"?"closed":"closing",acceptanceId:acceptance.id},
      value.kind==="complete"?"exit_completed":"exit_progressed",acceptance);
  }
  validate(value:InputSupplyExitProposal,acceptance:SharedAcceptanceProposal):void {
    const exit=this.read(value.kind==="begin"?value.origin.needId:value.needId)!;
    this.origin(exit,acceptance);
    const head=this.head(exit.origin.needId);
    if((head?.revision??0)!==exit.membershipRevision||!same(head?.scheduling??null,exit.scheduling))reject("membership_changed");
    if(value.kind==="begin") {
      const consumer=this.paths.path(exit.origin.consumerPathId)!;
      if(consumer.controlRevision!==value.expectedConsumerControlRevision)reject("consumer_control_changed");
    }
    if(value.kind==="dispose")for(const disposition of value.dispositions)this.disposition(exit,disposition);
    const subscription=this.paths.subscription(exit.subscriptionId)!;
    if(subscription.closed!==(value.kind==="complete"))reject("subscription_closure_not_joint");
    if(exit.scheduling) {
      const work=this.paths.scheduling(exit.scheduling.workId);
      if(!work||!sameSupplySchedulingBinding(exit.scheduling,work.intent)||!work.pathsSealed)reject("schedule_not_sealed");
      if(value.kind==="complete"&&(!work.closed||!work.settlementConfirmed))reject("schedule_not_settled");
      if(value.kind==="complete"&&this.uncoveredPath(exit))reject("schedule_responsibility_missing");
    }
  }
  private origin(exit:InputSupplyExit,acceptance:SharedAcceptanceProposal):void {
    const o=exit.origin,need=this.paths.need(o.needId),consumer=this.paths.path(o.consumerPathId),source=this.paths.stage(o.source.stageId),sub=this.paths.subscription(exit.subscriptionId);
    if(o.runId!==acceptance.scope||o.owner!==acceptance.actor)reject("actor_mismatch");
    if(!need||need.supplier!==o.owner||need.stage.pathId!==o.consumerPathId||!consumer||consumer.intent.runId!==o.runId||
      !source||source.status!=="accepted"||source.request.pathId!==o.consumerPathId||digest(source.request)!==o.source.requestDigest||
      !sub||exit.subscriptionId!==`${need.id}:supply`||sub.subscription.owner!==o.owner||sub.subscription.runId!==o.runId||
      sub.subscription.binding?.kind!=="input_need"||sub.subscription.binding.id!==need.id)reject("original_need_unconfirmed");
    const supplied=this.paths.stage(need.stage.id),unavailable=this.paths.stage(need.unavailableStage.id);
    if(supplied&&unavailable)reject("outcome_conflict");
    if(exit.basis.kind==="cancelled") {
      if(!consumer.cancelled||consumer.controlRevision<exit.basis.controlRevision)reject("cancellation_unconfirmed");
    } else {
      const returned=supplied??unavailable;
      if(!returned||returned.request.id!==exit.basis.stageId||digest(returned.request)!==exit.basis.requestDigest)reject("return_unconfirmed");
    }
  }
  private disposition(exit:InputSupplyExit,item:InputSupplyExitDisposition):void {
    const entry=this.entry(exit.origin.needId,item.responsibilityId),path=entry&&this.paths.path(entry.target.pathId);
    if(!entry||!path||digest(path.intent)!==entry.target.intentDigest)reject("target_changed");
    if(item.kind==="dependency_withdrawn") {
      if(entry.relation!=="dependency")reject("disposition_role_invalid");return;
    }
    if(entry.relation!=="owned"||!path.cancelled)reject("owned_exit_unconfirmed");
    if(item.kind==="owned_settled") {
      if(entry.role!=="input_preparation"||!this.paths.settled(path.intent.id))reject("owned_work_unsettled");return;
    }
    if(entry.role!=="method_reception")reject("disposition_role_invalid");
    const head=this.head(exit.origin.needId)!,first=this.paths.stage(`${path.intent.id}:stage:1`),sub=this.paths.subscription(`${path.intent.id}:consumer`);
    if(!first)reject("reception_plan_missing");
    try {ContextMethodInputSupply.validateInputSupply(head.binding,path.intent,first,sub,false,
      path.intent.scheduledWorkId?this.paths.scheduling(path.intent.scheduledWorkId):null);}
    catch {reject("reception_transfer_unconfirmed");}
    if(sub!.closed) {
      const receipt=this.paths.closure(sub!.subscription.id);
      if(!receipt||receipt.decision.kind!=="method_input_closed"||receipt.decision.id!==path.intent.id||!this.paths.settled(path.intent.id))
        reject("reception_closure_unconfirmed");
      const recorded=checkedJson<{closureAcceptanceId:string|null}>(this.records.sql("SELECT value,digest FROM context_input_supply_dispositions WHERE need_id=? AND id=?")
        .get(exit.origin.needId,entry.id) as Row);
      if(recorded.closureAcceptanceId!==receipt.id)reject("reception_closure_changed");
    } else if(!sub!.observedSources.includes(`activity-source:control:${path.intent.id}`))reject("reception_discovery_missing");
  }
  private pendingRows(needId:string,limit:number):{id:string}[] {
    return this.records.sql(`SELECT r.id FROM context_input_supply_responsibilities r
      LEFT JOIN context_input_supply_dispositions d ON d.need_id=r.need_id AND d.id=r.id
      JOIN activity_paths p ON p.id=r.path_id
      WHERE r.need_id=? AND d.id IS NULL ORDER BY
        CASE WHEN json_extract(r.value,'$.role')='input_preparation' AND p.cancelled=1 THEN
          CASE WHEN EXISTS(SELECT 1 FROM activity_handoffs h WHERE h.path_id=p.id AND h.pending=1) THEN 2 ELSE 1 END
        ELSE 0 END,r.id LIMIT ?`).all(needId,limit) as {id:string}[];
  }
  private coveredPaths(entry:AcceptedInputSupplyResponsibility,item:InputSupplyExitDisposition):readonly string[] {
    if(item.kind!=="reception_transferred")return [entry.target.pathId];
    const stage=this.paths.stage(`${entry.target.pathId}:stage:1`);
    const plan=(stage?.request.input as {methodInputPlan?:ContextMethodInputPlan}|undefined)?.methodInputPlan;
    if(!plan)reject("reception_plan_missing");
    return [...new Set([entry.target.pathId,plan.materialization.request.preparationIntent.id,plan.check.intent.id])].sort();
  }
  private uncoveredPath(exit:InputSupplyExit):string|null {
    if(!exit.scheduling)return null;
    const row=this.records.sql(`SELECT p.id FROM activity_paths p
      WHERE json_extract(p.intent,'$.scheduledWorkId')=? AND NOT EXISTS
        (SELECT 1 FROM context_input_supply_exit_coverage c WHERE c.need_id=? AND c.path_id=p.id)
      ORDER BY p.id LIMIT 1`).get(exit.scheduling.workId,exit.origin.needId) as {id:string}|undefined;
    return row?.id??null;
  }
  private save(exit:InputSupplyExit,kind:string,acceptance:SharedAcceptanceProposal):void {
    this.records.sql("INSERT INTO context_input_supply_exits VALUES(?,?,?,?) ON CONFLICT(need_id) DO UPDATE SET revision=excluded.revision,value=excluded.value,digest=excluded.digest")
      .run(exit.origin.needId,exit.revision,JSON.stringify(exit),digest(exit));
    const subject=object(OWNER,exit.origin.needId,exit.origin.runId);
    this.records.fact(exit.origin.runId,OWNER,exit.origin.needId,kind,{exit,acceptanceId:acceptance.id},
      {revision:"1",category:"responsibility",subject,state:{phase:exit.status==="closed"?"settled":"pending",status:kind},related:[],relationships:[
        ...[exit.origin.needId,exit.origin.consumerPathId,exit.origin.source.stageId,exit.subscriptionId,
          ...(exit.basis.kind==="returned"?[exit.basis.stageId]:[]),...(exit.scheduling?[exit.scheduling.workId]:[])]
          .map(id=>relationship("observes",subject,object("activity",id,exit.origin.runId))),
        relationship("settles",object("shared_acceptance",acceptance.id,acceptance.scope),subject),
      ]});this.changed(exit);
  }
}
export function sameSupplySchedulingBinding(a:NonNullable<InputSupplyHead["scheduling"]>,b:NonNullable<InputSupplyHead["scheduling"]>):boolean {
  const binding=(v:typeof a)=>({workId:v.workId,runId:v.runId,owner:v.owner,scopeId:v.scopeId,resources:v.resources,
    delegatedPathOwners:v.delegatedPathOwners??[],allowedPathIds:v.allowedPathIds?[...v.allowedPathIds].sort():null});
  return same(binding(a),binding(b));
}
function withoutConfiguration(head:InputSupplyHead):InputSupplyExit["origin"] {const {configuration:_,...origin}=head.binding;return origin;}
function same(a:unknown,b:unknown):boolean {return digest(a)===digest(b);}
function reject(code:string):never {throw new SharedAcceptanceRejection(OWNER,`input_supply_exit_${code}`);}
