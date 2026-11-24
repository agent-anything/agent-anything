import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {activityToken,activityCount,type ActivityPathIntent,type ActivityResourceAllowance,type ActivityResourceReservation} from "@agent-anything/agent-runtime/activity";

export const ACTIVITY_RESOURCE_SCHEMA=`
CREATE TABLE activity_resource_allowances(scope_key TEXT PRIMARY KEY,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE activity_resource_reservations(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE INDEX activity_resource_scope ON activity_resource_reservations(scope_key);
`;

/** Conservatively consumed execution allowance, not observed cost or a professional method's progress. */
export class ActivityResourceDatabase {
  constructor(private readonly db:Database.Database,private readonly path?:(id:string)=>ActivityPathIntent|null) {}
  allowance(path:ActivityPathIntent):ActivityResourceAllowance {
    const own=this.localAllowance(path),reserved={...own.reserved};
    for(const dimension of Object.keys(path.resourceBudgetSources??{})){
      const source=this.source(path,dimension),value=this.localAllowance(source);
      reserved[dimension]=value.reserved[dimension]??0;
    }
    return {limits:own.limits,reserved};
  }
  validate(path:ActivityPathIntent):void {
    for(const dimension of Object.keys(path.resourceBudgetSources??{}))this.source(path,dimension);
  }
  private localAllowance(path:ActivityPathIntent):ActivityResourceAllowance {
    const row=this.db.prepare("SELECT value,digest FROM activity_resource_allowances WHERE scope_key=?").get(this.key(path)) as {value:string;digest:string}|undefined;
    if(!row)return {limits:path.resourceLimits??{},reserved:{}};
    const value=this.checked<ActivityResourceAllowance>(row);
    if(modelInputValueDigest(value.limits)!==modelInputValueDigest(path.resourceLimits??{}))fail("binding_conflict");
    return value;
  }
  original(id:string):ActivityResourceReservation|null {
    activityToken(id);
    const row=this.db.prepare("SELECT value,digest FROM activity_resource_reservations WHERE id=?").get(id) as {value:string;digest:string}|undefined;
    return row?this.checked<ActivityResourceReservation>(row):null;
  }
  reserve(path:ActivityPathIntent,reservation:ActivityResourceReservation):ActivityResourceAllowance {
    [reservation.id,reservation.pathId,reservation.requestId].forEach(activityToken);
    const old=this.original(reservation.id);
    if(old) {
      if(modelInputValueDigest(old)!==modelInputValueDigest(reservation))fail("identity_conflict");
      return this.allowance(path);
    }
    if(reservation.pathId!==path.id||!Object.keys(reservation.amounts).length||Object.keys(reservation.amounts).length>32)fail("reservation_invalid");
    const writes=new Map<string,{limits:Readonly<Record<string,number>>;reserved:Record<string,number>}>();
    for(const [key,amount] of Object.entries(reservation.amounts)) {
      activityToken(key);activityCount(amount,true);
      const source=this.source(path,key),scopeKey=this.key(source);
      let pending=writes.get(scopeKey);
      if(!pending){const value=this.localAllowance(source);pending={limits:value.limits,reserved:{...value.reserved}};writes.set(scopeKey,pending);}
      const prior=pending,reserved=pending.reserved;
      const limit=prior.limits[key],total=(reserved[key]??0)+amount;
      if(limit===undefined||!Number.isSafeInteger(total)||total>limit)fail("limit_exceeded");
      reserved[key]=total;
    }
    this.db.prepare("INSERT INTO activity_resource_reservations VALUES (?,?,?,?)").run(reservation.id,this.key(path),JSON.stringify(reservation),modelInputValueDigest(reservation));
    for(const [key,value] of writes)this.db.prepare("INSERT INTO activity_resource_allowances VALUES (?,?,?) ON CONFLICT(scope_key) DO UPDATE SET value=excluded.value,digest=excluded.digest")
      .run(key,JSON.stringify(value),modelInputValueDigest(value));
    return this.allowance(path);
  }
  private source(path:ActivityPathIntent,dimension:string):ActivityPathIntent {
    const id=path.resourceBudgetSources?.[dimension];if(!id)return path;
    const source=this.path?.(id);
    if(!source||source.id===path.id||source.runId!==path.runId||source.owner!==path.owner||source.permissionBasis!==path.permissionBasis||
      source.resourceBudgetSources?.[dimension]!==undefined||source.resourceScope===path.resourceScope||
      source.resourceLimits?.[dimension]!==path.resourceLimits?.[dimension]||source.resourceLimits?.[dimension]===undefined||
      Date.parse(path.deadlineAt)>Date.parse(source.deadlineAt))fail("budget_source_invalid");
    return source;
  }
  private key(path:ActivityPathIntent):string{return JSON.stringify([path.runId,path.resourceScope]);}
  private checked<T>(row:{value:string;digest:string}):T {
    const value=JSON.parse(row.value) as T;if(modelInputValueDigest(value)!==row.digest)throw new Error("activity_resource_record_corrupt");return value;
  }
}
function fail(code:string):never {throw Object.assign(new Error(`activity_resource_${code}`),{code:`activity_resource_${code}`});}
