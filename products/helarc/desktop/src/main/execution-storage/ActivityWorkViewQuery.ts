import type Database from "better-sqlite3";
import {activityToken,activityCount,validateActivityPath,type ActivityPathIntent,type ActivityWorkView,type ActivitySchedulingAcceptance} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

/** Metadata-only observation: no source hydration, scheduling review or authority mutation. */
export class ActivityWorkViewQuery {
  private readonly statements=new Map<string,Database.Statement>();
  constructor(private readonly db:Database.Database,private readonly schedule:(id:string)=>ActivitySchedulingAcceptance|null) {}
  private sql(text:string){let statement=this.statements.get(text);if(!statement){statement=this.db.prepare(text);this.statements.set(text,statement);}return statement;}
  read(scopeId:string,limit:number):ActivityWorkView {
    activityToken(scopeId);activityCount(limit);if(limit>128)throw new TypeError("activity_view_bound_invalid");
    const revision=(this.sql("SELECT COALESCE(MAX(sequence),0) AS n FROM activity_facts").get() as {n:number}).n;
    const rows=this.sql(`SELECT p.id,w.run_id,p.intent,p.digest,p.cancelled,w.work_id FROM activity_scheduled_work w
      LEFT JOIN activity_paths p ON json_extract(p.intent,'$.scheduledWorkId')=w.work_id
      WHERE w.scope_id=? AND (w.closed=0 OR w.settlement_confirmed=0) ORDER BY w.work_id,p.id LIMIT ?`).all(scopeId,limit+1) as
      {id:string|null;run_id:string;intent:string|null;digest:string|null;cancelled:number|null;work_id:string}[];
    const items=rows.slice(0,limit).map(row=>{
      const work=this.schedule(row.work_id);if(!work||work.intent.scopeId!==scopeId)throw new TypeError("activity_view_schedule_corrupt");
      if(row.id===null)return {workId:row.work_id,runId:row.run_id,pathId:null,purpose:null,owner:work.intent.owner,reason:work.intent.reason,service:work.service,
        cancelled:false,closed:work.closed,pathsSealed:work.pathsSealed,settlementConfirmed:work.settlementConfirmed,pendingInputs:0,updatedAt:work.acceptedAt,hasMoreStages:false,stages:[]};
      const intent=JSON.parse(row.intent!) as ActivityPathIntent;validateActivityPath(intent);
      if(modelInputValueDigest(intent)!==row.digest||intent.id!==row.id||intent.runId!==row.run_id||intent.scheduledWorkId!==row.work_id)throw new TypeError("activity_view_path_corrupt");
      const stages=this.sql(`SELECT id,status,scheduling_metadata,scheduling_digest,dispatch_restriction,authorization_restrictions
        FROM activity_stages WHERE path_id=? AND status NOT IN ('accepted','settled','stopped') ORDER BY id LIMIT 65`).all(row.id) as
        {id:string;status:ActivityWorkView["items"][number]["stages"][number]["status"];scheduling_metadata:string;scheduling_digest:string;dispatch_restriction:string|null;authorization_restrictions:string|null}[];
      const pendingInputs=(this.sql(`SELECT COUNT(*) AS n FROM activity_input_needs n LEFT JOIN activity_stages s ON s.id=n.request_id
        LEFT JOIN activity_stages u ON u.id=n.unavailable_request_id WHERE n.path_id=? AND s.id IS NULL AND u.id IS NULL`).get(row.id) as {n:number}).n;
      const latest=this.sql("SELECT occurred_at FROM activity_facts WHERE run_id=? AND path_id IN (?,?) ORDER BY sequence DESC LIMIT 1").get(row.run_id,row.id,row.work_id) as {occurred_at:string}|undefined;
      return {workId:row.work_id,runId:row.run_id,pathId:row.id,purpose:intent.purpose.contract.ref,owner:work.intent.owner,reason:work.intent.reason,service:work.service,
        cancelled:row.cancelled===1,closed:work.closed,pathsSealed:work.pathsSealed,settlementConfirmed:work.settlementConfirmed,pendingInputs,updatedAt:latest?.occurred_at??work.acceptedAt,
        hasMoreStages:stages.length>64,stages:stages.slice(0,64).map(stage=>{
          const metadata=JSON.parse(stage.scheduling_metadata) as {capabilities:string[]};
          if(modelInputValueDigest(metadata)!==stage.scheduling_digest||!Array.isArray(metadata.capabilities))throw new TypeError("activity_view_stage_corrupt");
          const waiting=stage.status==="admitted"?this.sql(`SELECT value,digest FROM activity_facts WHERE run_id=? AND path_id=? AND kind='scheduling_wait'
            AND json_extract(value,'$.details.requestId')=? ORDER BY sequence DESC LIMIT 1`).get(row.run_id,row.work_id,stage.id) as {value:string;digest:string}|undefined:undefined;
          let schedulingWait:"resource_occupied"|"service_turn"|null=null;
          if(waiting){const fact=JSON.parse(waiting.value);if(modelInputValueDigest(fact)!==waiting.digest)throw new TypeError("activity_view_wait_corrupt");
            if(fact.details.reason==="resource_occupied"||fact.details.reason==="service_turn")schedulingWait=fact.details.reason;}
          return {requestId:stage.id,status:stage.status,capabilities:metadata.capabilities,
            dispatchRestriction:stage.dispatch_restriction?JSON.parse(stage.dispatch_restriction):null,
            authorizationRestrictions:stage.authorization_restrictions?JSON.parse(stage.authorization_restrictions):{},schedulingWait};
        })};
    });
    return {scopeId,revision,items,hasMore:rows.length>limit};
  }
}
