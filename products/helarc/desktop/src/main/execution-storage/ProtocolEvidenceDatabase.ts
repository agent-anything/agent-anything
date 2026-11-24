import type Database from "better-sqlite3";
import type {ProtocolContentRef, ProtocolEvidenceCommand, ProtocolEvidenceKind, ProtocolEvidencePart,
  ProtocolEvidenceRevision, ProtocolEvidenceScope, ProtocolEvidenceWrite, ProtocolUsageMergeProposal, ProtocolUsageMerge, ProtocolUsageRetirement,
  ProtocolExecutionState, ProtocolJournalRecord,
  ProtocolJournalValue} from "@agent-anything/agent-runtime/model-access";
import type {SharedAcceptanceProposal} from "@agent-anything/agent-runtime/activity";
import type {ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {checkedJson} from "./ContextFoundationRecords.js";
import {SharedAcceptanceRejection} from "./SharedAcceptanceDatabase.js";

export const PROTOCOL_EVIDENCE_SCHEMA = `
CREATE TABLE protocol_evidence_scopes(id TEXT PRIMARY KEY,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE protocol_evidence_activities(scope_id TEXT NOT NULL,activity_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(scope_id,activity_id));
CREATE TABLE protocol_evidence_history(scope_id TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(scope_id,kind,key,revision));
CREATE TABLE protocol_evidence_slots(scope_id TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(scope_id,kind,key));
CREATE TABLE protocol_evidence_memberships(scope_id TEXT NOT NULL,membership TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(scope_id,membership,key));
CREATE INDEX protocol_evidence_membership_work ON protocol_evidence_memberships(scope_id,key);
CREATE TABLE protocol_evidence_retirements(scope_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(scope_id,key));
CREATE TABLE protocol_evidence_merges(scope_id TEXT NOT NULL,merge_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(scope_id,merge_id));
CREATE TABLE protocol_evidence_versions(scope_id TEXT PRIMARY KEY,version INTEGER NOT NULL,digest TEXT NOT NULL);
`;
export const PROTOCOL_EVIDENCE_OBJECTS = ["protocol_evidence_scopes", "protocol_evidence_activities", "protocol_evidence_history", "protocol_evidence_slots",
  "protocol_evidence_memberships", "protocol_evidence_membership_work", "protocol_evidence_retirements", "protocol_evidence_merges", "protocol_evidence_versions"];
export const PROTOCOL_USAGE_ACCESS_SCHEMA=`
CREATE INDEX protocol_evidence_membership_run ON protocol_evidence_memberships(membership,scope_id,key);
CREATE INDEX protocol_records_operation_kind ON protocol_records(activity_id,json_extract(value,'$.kind'),id,revision);
CREATE INDEX protocol_evidence_measurement_key ON protocol_evidence_slots(kind,key,scope_id);
CREATE INDEX protocol_evidence_scope_recipient ON protocol_evidence_scopes(json_extract(value,'$.runId'),json_extract(value,'$.recipientId'),json_extract(value,'$.compositionDigest'));
`;
export const PROTOCOL_USAGE_ACCESS_OBJECTS=["protocol_evidence_membership_run","protocol_records_operation_kind","protocol_evidence_measurement_key","protocol_evidence_scope_recipient"];
interface EvidenceAccess {
  state(id:string):ProtocolExecutionState|null;
  content(ref:ProtocolContentRef):void;
  record(activityId:string,ref:ProtocolRevisionRef):ProtocolJournalRecord|null;
  fence(state:ProtocolExecutionState,fence:Extract<ProtocolEvidencePart,{kind:"evidence"}>["proposal"]["fence"],reconciliation:boolean):void;
  fact(state:ProtocolExecutionState,kind:string,identity:string,value:unknown):void;
}
type Row={scope_id:string;kind:ProtocolEvidenceKind;key:string;revision:number;value:string;digest:string};

/** Scoped immutable evidence and CAS indexes only; professional content remains owner-defined. */
export class ProtocolEvidenceDatabase {
  private readonly statements=new Map<string,Database.Statement>();
  constructor(private readonly db:Database.Database,private readonly access:EvidenceAccess) {}
  private sql(text:string):Database.Statement {
    let statement=this.statements.get(text);
    if(!statement){statement=this.db.prepare(text);this.statements.set(text,statement);}
    return statement;
  }
  apply(part:ProtocolEvidencePart,shared:SharedAcceptanceProposal):void {
    if(part.kind==="evidence_scope") {
      const {activityId,scope}=part.proposal;
      this.checkScope(scope);
      if(shared.actor!=="execution-coordinator"||shared.scope!==scope.runId)fail("scope_owner_invalid");
      this.checkActivity(scope,activityId,false);
      const old=this.scope(scope.id);
      if(old)same(old,scope);
      else {
        this.sql("INSERT INTO protocol_evidence_scopes VALUES (?,?,?)").run(scope.id,JSON.stringify(scope),modelInputValueDigest(scope));
        this.sql("INSERT INTO protocol_evidence_versions VALUES (?,?,?)").run(scope.id,0,modelInputValueDigest({scopeId:scope.id,version:0}));
      }
      const bound=this.sql("SELECT digest FROM protocol_evidence_activities WHERE scope_id=? AND activity_id=?").get(scope.id,activityId) as {digest:string}|undefined;
      const digest=modelInputValueDigest({scopeId:scope.id,activityId});
      if(bound){if(bound.digest!==digest)fail("activity_binding_corrupt");return;}
      this.sql("INSERT INTO protocol_evidence_activities VALUES (?,?,?)").run(scope.id,activityId,digest);
      this.access.fact(this.access.state(activityId)!,"evidence_scope",shared.id,{scope,activityId});
      return;
    }
    if(part.kind==="usage_merge"){this.merge(part.proposal,shared);return;}
    const state=this.validateWrite(part.proposal,shared);
    this.write(part.proposal,state,shared);
    if(part.proposal.evidence.kind==="usage")this.advanceVersion(part.proposal.evidence.scopeId);
  }
  private validateWrite(write:ProtocolEvidenceWrite,shared:SharedAcceptanceProposal):ProtocolExecutionState {
    exact(write,["evidence","expectedRevision","fence"]);
    const {evidence:value,expectedRevision,fence}=write;
    this.checkRevision(value);
    if(expectedRevision!==null)count(expectedRevision);
    if(value.revision!==(expectedRevision===null?0:expectedRevision+1))fail("revision_invalid");
    const scope=this.requireScope(value.scopeId),state=this.checkActivity(scope,value.activityId);
    if(shared.scope!==scope.runId||shared.actor!==scope.owner||value.owner!==scope.owner)fail("owner_invalid");
    this.access.fence(state,fence,value.kind==="usage"||value.kind==="transport"||value.kind==="transformation");
    if((value.kind==="transport"||value.kind==="transformation")&&state.retentionReleased)fail("retained_dependencies_released");
    if(value.kind==="usage"&&this.retirement(value.scopeId,value.key))fail("key_retired");
    const prior=this.current(value.scopeId,value.kind,value.key);
    if((prior?.revision??null)!==expectedRevision)fail("revision_conflict");
    // Only immutable references are checked here. Native interpretation and material authority have their own participants.
    for(const ref of [value.content,...value.references]) {
      this.checkActivity(scope,ref.activityId);
      this.access.content(ref);
    }
    if(value.content.activityId!==value.activityId)fail("content_scope_invalid");
    for(const dependency of value.dependencies) {
      this.checkActivity(scope,dependency.activityId);
      const record=this.access.record(dependency.activityId,dependency.ref);
      if(!record)fail("dependency_missing");
      this.access.content(record.content);
    }
    return state;
  }
  private write({evidence:value,expectedRevision}:ProtocolEvidenceWrite,state:ProtocolExecutionState,shared:SharedAcceptanceProposal):void {
    this.sql("INSERT INTO protocol_evidence_history VALUES (?,?,?,?,?,?)").run(value.scopeId,value.kind,value.key,value.revision,
      JSON.stringify(value),modelInputValueDigest(value));
    const digest=slotDigest(value.scopeId,value.kind,value.key,value.revision);
    if(expectedRevision===null) {
      this.sql("INSERT INTO protocol_evidence_slots VALUES (?,?,?,?,?)").run(value.scopeId,value.kind,value.key,value.revision,digest);
    } else {
      const result=this.sql("UPDATE protocol_evidence_slots SET revision=?,digest=? WHERE scope_id=? AND kind=? AND key=? AND revision=?")
        .run(value.revision,digest,value.scopeId,value.kind,value.key,expectedRevision);
      if(result.changes!==1)fail("revision_conflict");
    }
    if(value.kind==="usage") {
      this.sql("DELETE FROM protocol_evidence_memberships WHERE scope_id=? AND key=?").run(value.scopeId,value.key);
      for(const membership of value.memberships)
        this.sql("INSERT INTO protocol_evidence_memberships VALUES (?,?,?)").run(value.scopeId,membership,value.key);
    }
    this.access.fact(state,"evidence",shared.id,value);
  }
  private merge(proposal:ProtocolUsageMergeProposal,shared:SharedAcceptanceProposal):void {
    exact(proposal,["scopeId","mergeId","survivor","retired"]);token(proposal.scopeId);token(proposal.mergeId);
    const value=proposal.survivor.evidence;
    if(value.scopeId!==proposal.scopeId||value.kind!=="usage")fail("merge_scope_invalid");
    if(!Array.isArray(proposal.retired)||!proposal.retired.length||proposal.retired.length>128)fail("merge_bound");
    const keys=proposal.retired.map(item=>item.key);
    if(new Set(keys).size!==keys.length||keys.includes(value.key))fail("merge_keys_invalid");
    const survivorState=this.validateWrite(proposal.survivor,shared),scope=this.requireScope(proposal.scopeId);
    if(this.readMerge(scope.id,proposal.mergeId))fail("merge_identity_conflict");
    const retired=proposal.retired.map(item=>{
      exact(item,["key","fence","expectedRevision"]);token(item.key);
      if(item.expectedRevision!==null)count(item.expectedRevision);
      const state=this.checkActivity(scope,item.fence.activityId);this.access.fence(state,item.fence,true);
      if(this.retirement(scope.id,item.key))fail("key_retired");
      const previous=this.current(scope.id,"usage",item.key);
      if((previous?.revision??null)!==item.expectedRevision)fail("revision_conflict");
      if(!previous&&this.sql("SELECT 1 FROM protocol_evidence_history WHERE scope_id=? AND kind='usage' AND key=? LIMIT 1").get(scope.id,item.key))fail("slot_corrupt");
      const retirement:ProtocolUsageRetirement={scopeId:scope.id,key:item.key,owner:scope.owner,activityId:state.activity.scope.activityId,
        mergeId:proposal.mergeId,acceptanceId:shared.id,previous:previous?{revision:previous.revision,content:previous.content}:null,
        survivor:{key:value.key,revision:value.revision,content:value.content}};
      return {state,retirement};
    });
    // SharedAcceptance supplies the enclosing transaction. Validate every participant before any index mutation.
    this.write(proposal.survivor,survivorState,shared);
    for(const {state,retirement} of retired){
      this.sql("INSERT INTO protocol_evidence_retirements VALUES (?,?,?,?)").run(scope.id,retirement.key,JSON.stringify(retirement),modelInputValueDigest(retirement));
      this.sql("DELETE FROM protocol_evidence_slots WHERE scope_id=? AND kind='usage' AND key=?").run(scope.id,retirement.key);
      this.sql("DELETE FROM protocol_evidence_memberships WHERE scope_id=? AND key=?").run(scope.id,retirement.key);
      this.access.fact(state,"usage_retired",shared.id,retirement);
    }
    const merged:ProtocolUsageMerge={scopeId:scope.id,mergeId:proposal.mergeId,owner:scope.owner,acceptanceId:shared.id,
      version:this.advanceVersion(scope.id),proposal,survivor:value,retired:retired.map(item=>item.retirement)};
    this.sql("INSERT INTO protocol_evidence_merges VALUES (?,?,?,?)").run(scope.id,proposal.mergeId,JSON.stringify(merged),modelInputValueDigest(merged));
    this.access.fact(survivorState,"usage_merge",shared.id,merged);
  }
  command(command:ProtocolEvidenceCommand):ProtocolJournalValue {
    token(command.scopeId);
    const scope=this.scope(command.scopeId);
    if(!scope){if(!this.access.state(command.activityId))fail("activity_scope_invalid");return null;}
    this.checkActivity(scope,command.activityId);
    if(command.kind==="evidence_scope")return scope;
    if(command.kind==="usage_retirement"){token(command.key);return this.retirement(scope.id,command.key);}
    if(command.kind==="usage_merge"){token(command.mergeId);return this.readMerge(scope.id,command.mergeId);}
    kind(command.evidenceKind);
    if(command.kind==="evidence") {
      token(command.key);
      if(command.revision!==undefined){count(command.revision);return this.history(command.scopeId,command.evidenceKind,command.key,command.revision);}
      return this.current(command.scopeId,command.evidenceKind,command.key);
    }
    return this.db.transaction(()=>this.page(command))();
  }
  usageForRun(runId:string,limit:number,after:{scopeId:string;key:string}|null=null):{
    entries:ProtocolEvidenceRevision[];complete:boolean;next:{scopeId:string;key:string}|null}{
    token(runId);count(limit,4096);if(!limit)fail("page_invalid");
    if(after){token(after.scopeId);token(after.key);}
    const rows=this.sql("SELECT m.scope_id,'usage' AS kind,m.key,s.revision,s.digest AS slot_digest,h.value,h.digest FROM protocol_evidence_memberships m LEFT JOIN protocol_evidence_slots s ON s.scope_id=m.scope_id AND s.kind='usage' AND s.key=m.key LEFT JOIN protocol_evidence_history h ON h.scope_id=s.scope_id AND h.kind=s.kind AND h.key=s.key AND h.revision=s.revision WHERE m.membership=? AND (m.scope_id,m.key)>(?,?) ORDER BY m.scope_id,m.key LIMIT ?")
      .all(runId,after?.scopeId??"",after?.key??"",limit+1) as (Row&{slot_digest:string})[];
    const entries:ProtocolEvidenceRevision[]=[];
    for(const row of rows.slice(0,limit)){
      this.checkSlot(row,row.slot_digest);
      const value=this.decode(row),scope=this.requireScope(value.scopeId);
      if(!value.memberships.includes(runId)||value.kind!=="usage"||this.retirement(value.scopeId,value.key))fail("usage_index_corrupt");
      const state=this.checkActivity(scope,value.activityId);
      if(state.activity.scope.runId!==scope.runId)fail("usage_index_scope_invalid");
      if(scope.runId===runId)entries.push(value);
    }
    const last=rows[Math.min(rows.length,limit)-1];
    return {entries,complete:rows.length<=limit,next:rows.length>limit?{scopeId:last!.scope_id,key:last!.key}:null};
  }
  measurementCandidates(input:{runId:string;recipientId:string;compositionDigest:string;key:string;limit:number}):ProtocolJournalValue {
    [input.runId,input.recipientId,input.compositionDigest,input.key].forEach(token);
    count(input.limit,128);if(!input.limit)fail("page_invalid");
    const rows=this.sql("SELECT s.scope_id,s.kind,s.key,s.revision,s.digest AS slot_digest,h.value,h.digest FROM protocol_evidence_slots s JOIN protocol_evidence_scopes c ON c.id=s.scope_id LEFT JOIN protocol_evidence_history h ON h.scope_id=s.scope_id AND h.kind=s.kind AND h.key=s.key AND h.revision=s.revision WHERE s.kind='measurement' AND s.key=? AND json_extract(c.value,'$.runId')=? AND json_extract(c.value,'$.recipientId')=? AND json_extract(c.value,'$.compositionDigest')=? ORDER BY s.scope_id LIMIT ?")
      .all(input.key,input.runId,input.recipientId,input.compositionDigest,input.limit+1) as (Row&{slot_digest:string})[];
    const entries=rows.slice(0,input.limit).map(row=>{
      this.checkSlot(row,row.slot_digest);
      const value=this.decode(row),scope=this.requireScope(value.scopeId);
      if(scope.runId!==input.runId||scope.recipientId!==input.recipientId||scope.compositionDigest!==input.compositionDigest||
        value.kind!=="measurement"||value.key!==input.key)fail("measurement_index_scope_invalid");
      this.checkActivity(scope,value.activityId);return value;
    });
    return {entries,next:rows.length>input.limit?entries.at(-1)!.scopeId:null,version:null};
  }
  usageSamples(input:{runId:string;recipientId:string;compositionDigest:string;purpose:ProtocolRevisionRef;limit:number}):ProtocolJournalValue {
    [input.runId,input.recipientId,input.compositionDigest,input.purpose.id,input.purpose.revision].forEach(token);
    count(input.limit,128);if(!input.limit)fail("page_invalid");
    // Sample latest publications, not a complete accounting total or an execution ordering claim.
    const rows=this.sql("SELECT s.scope_id,s.kind,s.key,s.revision,s.digest AS slot_digest,h.value,h.digest FROM protocol_evidence_scopes c JOIN protocol_evidence_slots s ON s.scope_id=c.id AND s.kind='usage' LEFT JOIN protocol_evidence_history h ON h.scope_id=s.scope_id AND h.kind=s.kind AND h.key=s.key AND h.revision=s.revision WHERE json_extract(c.value,'$.runId')=? AND json_extract(c.value,'$.recipientId')=? AND json_extract(c.value,'$.compositionDigest')=? AND json_extract(c.value,'$.purpose.id')=? AND json_extract(c.value,'$.purpose.revision')=? ORDER BY h.rowid DESC LIMIT ?")
      .all(input.runId,input.recipientId,input.compositionDigest,input.purpose.id,input.purpose.revision,input.limit+1) as (Row&{slot_digest:string})[];
    const entries=rows.slice(0,input.limit).map(row=>{
      this.checkSlot(row,row.slot_digest);const value=this.decode(row),scope=this.requireScope(value.scopeId);
      if(scope.runId!==input.runId||scope.recipientId!==input.recipientId||scope.compositionDigest!==input.compositionDigest||
        modelInputValueDigest(scope.purpose)!==modelInputValueDigest(input.purpose)||value.kind!=="usage"||
        !value.memberships.includes(input.runId)||this.retirement(value.scopeId,value.key))fail("usage_sample_scope_invalid");
      this.checkActivity(scope,value.activityId);return value;
    });
    return {entries,next:rows.length>input.limit?entries.at(-1)!.key:null,version:null};
  }
  private page(command:Extract<ProtocolEvidenceCommand,{kind:"evidence_list"}>):ProtocolJournalValue {
    count(command.limit,128);if(!command.limit)fail("page_invalid");
    if(command.afterKey!==null)token(command.afterKey);
    if(command.membership!==undefined){token(command.membership);if(command.evidenceKind!=="usage")fail("membership_kind_invalid");}
    const version=command.evidenceKind==="usage"?this.version(command.scopeId):null;
    if(command.expectedVersion!==undefined){count(command.expectedVersion);if(version!==command.expectedVersion)fail("page_version_conflict");}
    if(command.evidenceKind==="usage"&&command.afterKey!==null&&command.expectedVersion===undefined)fail("page_version_required");
    const rows=command.membership===undefined
      ?this.sql("SELECT s.scope_id,s.kind,s.key,s.revision,s.digest AS slot_digest,h.value,h.digest FROM protocol_evidence_slots s LEFT JOIN protocol_evidence_history h ON h.scope_id=s.scope_id AND h.kind=s.kind AND h.key=s.key AND h.revision=s.revision WHERE s.scope_id=? AND s.kind=? AND s.key>? ORDER BY s.key LIMIT ?")
        .all(command.scopeId,command.evidenceKind,command.afterKey??"",command.limit+1)
      :this.sql("SELECT m.scope_id,'usage' AS kind,m.key,s.revision,s.digest AS slot_digest,h.value,h.digest FROM protocol_evidence_memberships m LEFT JOIN protocol_evidence_slots s ON s.scope_id=m.scope_id AND s.kind='usage' AND s.key=m.key LEFT JOIN protocol_evidence_history h ON h.scope_id=s.scope_id AND h.kind=s.kind AND h.key=s.key AND h.revision=s.revision WHERE m.scope_id=? AND m.membership=? AND m.key>? ORDER BY m.key LIMIT ?")
        .all(command.scopeId,command.membership,command.afterKey??"",command.limit+1);
    const values=(rows as (Row&{slot_digest:string})[]).map(row=>{
      this.checkSlot(row,row.slot_digest);
      const value=this.decode(row);
      if(value.kind==="usage"&&this.retirement(value.scopeId,value.key))fail("retired_slot_corrupt");
      if(command.membership!==undefined&&!value.memberships.includes(command.membership))fail("membership_corrupt");
      return value;
    });
    const entries=values.slice(0,command.limit);
    return {entries,next:values.length>command.limit?entries.at(-1)!.key:null,version};
  }
  private version(scopeId:string):number {
    const row=this.sql("SELECT version,digest FROM protocol_evidence_versions WHERE scope_id=?").get(scopeId) as {version:number;digest:string}|undefined;
    if(!row)fail("version_missing");count(row.version);
    if(row.digest!==modelInputValueDigest({scopeId,version:row.version}))fail("version_corrupt");
    return row.version;
  }
  private advanceVersion(scopeId:string):number {
    const previous=this.version(scopeId),version=previous+1;count(version);
    const result=this.sql("UPDATE protocol_evidence_versions SET version=?,digest=? WHERE scope_id=? AND version=?")
      .run(version,modelInputValueDigest({scopeId,version}),scopeId,previous);
    if(result.changes!==1)fail("page_version_conflict");return version;
  }
  private retirement(scopeId:string,key:string):ProtocolUsageRetirement|null {
    const row=this.sql("SELECT value,digest FROM protocol_evidence_retirements WHERE scope_id=? AND key=?").get(scopeId,key) as {value:string;digest:string}|undefined;
    if(!row)return null;
    const value=checkedJson<ProtocolUsageRetirement>(row);
    exact(value,["scopeId","key","owner","activityId","mergeId","acceptanceId","previous","survivor"]);
    [value.scopeId,value.key,value.owner,value.activityId,value.mergeId,value.acceptanceId].forEach(token);
    if(value.scopeId!==scopeId||value.key!==key||value.owner!==this.requireScope(scopeId).owner)fail("retirement_corrupt");
    exact(value.survivor,["key","revision","content"]);token(value.survivor.key);count(value.survivor.revision);contentRef(value.survivor.content);
    if(value.survivor.key===key)fail("retirement_corrupt");
    const survivor=this.history(scopeId,"usage",value.survivor.key,value.survivor.revision);
    if(!survivor||modelInputValueDigest(survivor.content)!==modelInputValueDigest(value.survivor.content))fail("retirement_corrupt");
    if(value.previous!==null){
      exact(value.previous,["revision","content"]);count(value.previous.revision);contentRef(value.previous.content);
      const previous=this.history(scopeId,"usage",key,value.previous.revision);
      if(!previous||modelInputValueDigest(previous.content)!==modelInputValueDigest(value.previous.content))fail("retirement_corrupt");
    }
    return value;
  }
  private readMerge(scopeId:string,mergeId:string):ProtocolUsageMerge|null {
    const row=this.sql("SELECT value,digest FROM protocol_evidence_merges WHERE scope_id=? AND merge_id=?").get(scopeId,mergeId) as {value:string;digest:string}|undefined;
    if(!row)return null;
    const value=checkedJson<ProtocolUsageMerge>(row);
    exact(value,["scopeId","mergeId","owner","acceptanceId","version","proposal","survivor","retired"]);
    token(value.acceptanceId);count(value.version);this.checkRevision(value.survivor);
    if(value.scopeId!==scopeId||value.mergeId!==mergeId||value.owner!==this.requireScope(scopeId).owner||value.version===0||
      value.survivor.scopeId!==scopeId||value.survivor.kind!=="usage"||!Array.isArray(value.retired)||!value.retired.length||value.retired.length>128)fail("merge_corrupt");
    if(modelInputValueDigest(this.history(scopeId,"usage",value.survivor.key,value.survivor.revision))!==modelInputValueDigest(value.survivor))fail("merge_corrupt");
    if(new Set(value.retired.map(item=>item.key)).size!==value.retired.length)fail("merge_corrupt");
    exact(value.proposal,["scopeId","mergeId","survivor","retired"]);
    if(value.proposal.scopeId!==scopeId||value.proposal.mergeId!==mergeId||
      modelInputValueDigest(value.proposal.survivor.evidence)!==modelInputValueDigest(value.survivor)||
      value.proposal.retired.length!==value.retired.length)fail("merge_corrupt");
    for(const retirement of value.retired){
      const original=value.proposal.retired.find(item=>item.key===retirement.key);
      if(retirement.mergeId!==mergeId||retirement.acceptanceId!==value.acceptanceId||retirement.scopeId!==scopeId||
        retirement.survivor.key!==value.survivor.key||retirement.survivor.revision!==value.survivor.revision||
        !original||original.expectedRevision!==(retirement.previous?.revision??null)||original.fence.activityId!==retirement.activityId||
        modelInputValueDigest(retirement)!==modelInputValueDigest(this.retirement(scopeId,retirement.key)))fail("merge_corrupt");
    }
    return value;
  }
  private scope(id:string):ProtocolEvidenceScope|null {
    token(id);
    const row=this.sql("SELECT value,digest FROM protocol_evidence_scopes WHERE id=?").get(id) as {value:string;digest:string}|undefined;
    if(!row)return null;
    const value=checkedJson<ProtocolEvidenceScope>(row);this.checkScope(value);
    if(value.id!==id)fail("scope_corrupt");return value;
  }
  private requireScope(id:string):ProtocolEvidenceScope {const scope=this.scope(id);if(!scope)fail("scope_missing");return scope;}
  private checkActivity(scope:ProtocolEvidenceScope,id:string,requireBinding=true):ProtocolExecutionState {
    token(id);const state=this.access.state(id);if(!state)fail("activity_scope_invalid");
    const original=state.activity.scope;
    if(original.runId!==scope.runId||original.recipientId!==scope.recipientId||original.compositionDigest!==scope.compositionDigest||
      modelInputValueDigest(original.purpose)!==modelInputValueDigest(scope.purpose))fail("activity_scope_invalid");
    if(requireBinding){
      const binding=this.sql("SELECT digest FROM protocol_evidence_activities WHERE scope_id=? AND activity_id=?").get(scope.id,id) as {digest:string}|undefined;
      if(!binding||binding.digest!==modelInputValueDigest({scopeId:scope.id,activityId:id}))fail("activity_binding_invalid");
    }
    return state;
  }
  private checkScope(value:ProtocolEvidenceScope):void {
    exact(value,["id","runId","recipientId","purpose","compositionDigest","owner"]);
    [value.id,value.runId,value.recipientId,value.compositionDigest,value.owner].forEach(token);revisionRef(value.purpose);
  }
  private current(scopeId:string,kind:ProtocolEvidenceKind,key:string):ProtocolEvidenceRevision|null {
    const slot=this.sql("SELECT scope_id,kind,key,revision,digest FROM protocol_evidence_slots WHERE scope_id=? AND kind=? AND key=?")
      .get(scopeId,kind,key) as {scope_id:string;kind:ProtocolEvidenceKind;key:string;revision:number;digest:string}|undefined;
    if(!slot)return null;this.checkSlot(slot,slot.digest);
    const value=this.history(scopeId,kind,key,slot.revision);if(!value)fail("slot_corrupt");return value;
  }
  private checkSlot(row:{scope_id:string;kind:ProtocolEvidenceKind;key:string;revision:number},digest:string):void {
    count(row.revision);if(digest!==slotDigest(row.scope_id,row.kind,row.key,row.revision))fail("slot_corrupt");
  }
  private history(scopeId:string,kind:ProtocolEvidenceKind,key:string,revision:number):ProtocolEvidenceRevision|null {
    const row=this.sql("SELECT scope_id,kind,key,revision,value,digest FROM protocol_evidence_history WHERE scope_id=? AND kind=? AND key=? AND revision=?")
      .get(scopeId,kind,key,revision) as Row|undefined;
    return row?this.decode(row):null;
  }
  private decode(row:Row):ProtocolEvidenceRevision {
    if(row.value===null||row.digest===null)fail("slot_corrupt");
    const value=checkedJson<ProtocolEvidenceRevision>(row);this.checkRevision(value);
    if(value.scopeId!==row.scope_id||value.kind!==row.kind||value.key!==row.key||value.revision!==row.revision)fail("identity_corrupt");
    if(value.owner!==this.requireScope(value.scopeId).owner)fail("owner_corrupt");
    return value;
  }
  private checkRevision(value:ProtocolEvidenceRevision):void {
    exact(value,["scopeId","kind","key","owner","activityId","revision","content","references","dependencies","metadata","memberships"]);
    [value.scopeId,value.key,value.owner,value.activityId].forEach(token);kind(value.kind);count(value.revision);contentRef(value.content);
    if(!Array.isArray(value.references)||value.references.length>128||!Array.isArray(value.dependencies)||value.dependencies.length>128||
      !Array.isArray(value.memberships)||value.memberships.length>128)fail("references_bound");
    value.references.forEach(contentRef);
    for(const ref of value.dependencies){exact(ref,["activityId","ref"]);token(ref.activityId);revisionRef(ref.ref);}
    value.memberships.forEach(token);
    if(new Set(value.memberships).size!==value.memberships.length||(value.kind!=="usage"&&value.memberships.length))fail("memberships_invalid");
    if(!value.metadata||typeof value.metadata!=="object"||Array.isArray(value.metadata))fail("metadata_invalid");
    const fields=Object.entries(value.metadata);
    if(fields.length>32||Buffer.byteLength(JSON.stringify(value.metadata),"utf8")>4096)fail("metadata_bound");
    for(const [key,field] of fields) {
      if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)||!(field===null||typeof field==="boolean"||
        typeof field==="number"&&Number.isFinite(field)||typeof field==="string"&&Buffer.byteLength(field,"utf8")<=1024))fail("metadata_invalid");
    }
  }
}
function exact(value:unknown,keys:readonly string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||
    Object.keys(value).some(key=>!keys.includes(key)))fail("shape_invalid");
}
function token(value:unknown):asserts value is string {if(typeof value!=="string"||!value.trim()||value.length>2048)fail("identity_invalid");}
function count(value:number,max=Number.MAX_SAFE_INTEGER):void {if(!Number.isSafeInteger(value)||value<0||value>max)fail("bound_invalid");}
function kind(value:ProtocolEvidenceKind):void {if(!["continuation","measurement","usage","transport","transformation"].includes(value))fail("kind_invalid");}
function revisionRef(value:ProtocolRevisionRef):void {exact(value,["id","revision"]);token(value.id);token(value.revision);}
function contentRef(value:ProtocolContentRef):void {
  exact(value,["id","activityId","bytes","digest"]);token(value.id);token(value.activityId);count(value.bytes,8*1024*1024*1024);
  if(!/^sha256:[a-f0-9]{64}$/.test(value.digest))fail("content_digest_invalid");
}
function same(a:unknown,b:unknown):void {if(modelInputValueDigest(a)!==modelInputValueDigest(b))fail("scope_conflict");}
function slotDigest(scopeId:string,kind:ProtocolEvidenceKind,key:string,revision:number):string {return modelInputValueDigest({scopeId,kind,key,revision});}
function fail(code:string):never {throw new SharedAcceptanceRejection("protocol_execution",`protocol_evidence_${code}`);}
