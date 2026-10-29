import type Database from "better-sqlite3";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {custodyToken,containsMaterialRange,type MaterialRange} from "@agent-anything/context/custody";
import type {RepresentationCommand,RepresentationValue,RepresentationRecord,RepresentationRef,RepresentationJudgment,RepresentationReuse} from "@agent-anything/context/representation";
import {ContextFoundationRecords,checkedJson,requireSame} from "./ContextFoundationRecords.js";
import {MaterialCustodyDatabase} from "./MaterialCustodyDatabase.js";
import type {ContextAcceptancePart} from "@agent-anything/context/selection";
import {SharedAcceptanceRejection,type SharedAcceptanceParticipant} from "./SharedAcceptanceDatabase.js";

export const REPRESENTATION_SCHEMA=`
CREATE TABLE context_representations(id TEXT NOT NULL,revision TEXT NOT NULL,run_id TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE context_judgments(id TEXT PRIMARY KEY,value TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE context_reuse_checks(id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,value TEXT NOT NULL,digest TEXT NOT NULL);
`;
export class RepresentationDatabase {
  constructor(private readonly db:Database.Database,private readonly records:ContextFoundationRecords,private readonly materials:MaterialCustodyDatabase,
    private readonly confirmMethod:(record:RepresentationRecord)=>boolean) {}
  participant():SharedAcceptanceParticipant {
    type Part=Extract<ContextAcceptancePart,{owner:"representation"}>;
    return {owner:"representation",kinds:["record","judge"],prepare:(part,acceptance)=>{
      const value=part as Part;
      if(value.proposal.owner!==acceptance.actor || value.kind==="record"&&value.proposal.runId!==acceptance.scope)
        throw new SharedAcceptanceRejection("representation","representation_owner_mismatch");
      this.bound(value.proposal);
      return structuredClone(value);
    },apply:value=>{
      const part=value as Part;
      try {if(part.kind==="record")this.record(part.proposal,false);else this.judge(part.proposal);}
      catch(error){
        if(error instanceof TypeError && error.message.startsWith("representation_"))throw new SharedAcceptanceRejection("representation",error.message);
        throw error;
      }
    },validate:value=>{
      const part=value as Part;
      if(part.kind==="record"&&part.proposal.method&&!this.confirmMethod(part.proposal))
        throw new SharedAcceptanceRejection("representation","representation_method_unconfirmed");
    }};
  }
  private bound(value:unknown):void {
    if(Buffer.byteLength(JSON.stringify(value),"utf8")>262144)throw new TypeError("representation_metadata_bound");
  }
  command(command:RepresentationCommand):RepresentationValue {
    switch(command.kind) {
      case "read":return this.read(command.ref);
      case "read_judgment":return this.judgment(command.id);
      case "record":return this.record(command.record);
      case "judge":return this.judge(command.judgment);
      case "reuse":return this.reuse(command.request);
    }
  }
  read(ref:RepresentationRef):RepresentationRecord|null {
    const row=this.records.sql("SELECT value,digest FROM context_representations WHERE id=? AND revision=?").get(ref.id,ref.revision) as {value:string;digest:string}|undefined;
    return row?checkedJson<RepresentationRecord>(row):null;
  }
  judgment(id:string):RepresentationJudgment|null {
    const row=this.records.sql("SELECT value,digest FROM context_judgments WHERE id=?").get(id) as {value:string;digest:string}|undefined;
    return row?checkedJson<RepresentationJudgment>(row):null;
  }
  private record(record:RepresentationRecord,confirmMethod=true):RepresentationRecord {
    this.bound(record);
    [record.ref.id,record.ref.revision,record.runId,record.owner,record.purpose,record.target].forEach(custodyToken);
    for(const values of [record.inputs,record.declaredCoverage,record.details,record.holds,record.requirements,record.losses,record.restorations]) if(!Array.isArray(values)||values.length>256)throw new TypeError("representation_bound_invalid");
    const previous=this.read(record.ref);if(previous){requireSame(previous,record);return previous;}
    if(record.method&&confirmMethod&&!this.confirmMethod(record))throw new TypeError("representation_method_unconfirmed");
    const reader={runId:record.runId,recipient:record.owner,purpose:record.purpose};
    for(const range of [record.body,...record.details,...record.inputs.map(i=>i.material)]) {
      const hold=record.holds.map(id=>this.materials.hold(id)).find(h=>h&&containsMaterialRange(h.range,range));
      if(!hold)throw new TypeError("representation_material_hold_missing");
      this.materials.requireProtected(hold.instanceId,range,reader,hold.id);
    }
    for(const coverage of record.declaredCoverage) if(!record.inputs.some(i=>i.role==="source"&&containsMaterialRange(i.material,coverage)))throw new TypeError("representation_coverage_outside_input");
    for(const input of record.inputs) if(input.representation) {
      const parent=this.read(input.representation);if(!parent)throw new TypeError("representation_parent_missing");
      if(!containsMaterialRange(parent.body,input.material))throw new TypeError("representation_input_not_parent_body");
      if(input.role==="source")for(const loss of parent.losses) {
        const inherited=record.losses.find(value=>value.id===loss.id);
        if(!inherited)throw new TypeError("representation_inherited_loss_missing");requireSame(inherited,loss);
      }
    }
    for(const restoration of record.restorations) {
      const loss=record.losses.find(value=>value.id===restoration.lossId),judgment=this.judgment(restoration.judgmentId);
      if(!loss || !containsMaterialRange(loss.source,restoration.range) || !judgment || judgment.conclusion!=="supported" ||
        !judgment.coverage.some(range=>containsMaterialRange(range,restoration.range)) ||
        !record.inputs.some(input=>input.role==="source"&&!input.representation&&containsMaterialRange(input.material,restoration.range)))throw new TypeError("representation_restoration_unsubstantiated");
    }
    this.db.transaction(()=>{
      this.records.sql("INSERT INTO context_representations VALUES (?,?,?,?,?)").run(record.ref.id,record.ref.revision,record.runId,JSON.stringify(record),modelInputValueDigest(record));
      this.records.fact(record.runId,"representation",key(record.ref),"recorded",{ref:record.ref,form:record.form,body:record.body,inputs:record.inputs,method:record.method,losses:record.losses,restorations:record.restorations});
    })();
    return record;
  }
  private judge(judgment:RepresentationJudgment):RepresentationJudgment {
    this.bound(judgment);
    for(const values of [judgment.subjects,judgment.inputs,judgment.coverage,judgment.limitations])
      if(!Array.isArray(values)||values.length>256)throw new TypeError("representation_judgment_bound");
    [judgment.id,judgment.owner,judgment.purpose,judgment.target,judgment.methodRevision,judgment.basis].forEach(custodyToken);
    const old=this.judgment(judgment.id);if(old){requireSame(old,judgment);return old;}
    if(!["supported","unsupported","unknown"].includes(judgment.conclusion) || !judgment.subjects.length || judgment.subjects.length>256)throw new TypeError("representation_judgment_invalid");
    const subjects=judgment.subjects.map(ref=>this.read(ref));if(subjects.some(v=>!v))throw new TypeError("representation_judgment_subject_missing");
    for(const range of judgment.coverage)if(!judgment.inputs.some(input=>containsMaterialRange(input,range)))throw new TypeError("representation_judgment_coverage_invalid");
    this.db.transaction(()=>{
      this.records.sql("INSERT INTO context_judgments VALUES (?,?,?)").run(judgment.id,JSON.stringify(judgment),modelInputValueDigest(judgment));
      this.records.fact(subjects[0]!.runId,"representation",judgment.id,"judgment_recorded",{kind:judgment.kind,subjects:judgment.subjects,conclusion:judgment.conclusion,coverage:judgment.coverage,limitations:judgment.limitations,dependencies:judgment.dependencies,basis:judgment.basis});
    })();return judgment;
  }
  private reuse(request:RepresentationReuse):RepresentationValue {
    const digest=modelInputValueDigest(request);
    const previous=this.records.sql("SELECT value,digest,request_digest FROM context_reuse_checks WHERE id=?").get(request.id) as {value:string;digest:string;request_digest:string}|undefined;
    if(previous){if(previous.request_digest!==digest)throw new TypeError("representation_reuse_identity_conflict");return checkedJson(previous);}
    const judgment=this.judgment(request.judgmentId),reasons:string[]=[];
    if(!judgment)reasons.push("judgment_missing");
    else {
      for(const field of ["purpose","target","methodRevision"] as const)if(judgment[field]!==request[field])reasons.push(`${field}_changed`);
      if(judgment.conclusion!=="supported")reasons.push("judgment_not_supported");
      if(modelInputValueDigest(judgment.dependencies)!==modelInputValueDigest(request.dependencies))reasons.push("dependencies_changed");
      if(modelInputValueDigest(judgment.subjects)!==modelInputValueDigest(request.subjects))reasons.push("subjects_changed");
      for(const ref of request.subjects) {
        const record=this.read(ref);if(!record){reasons.push("subject_missing");continue;}
        for(const range of [record.body,...record.details]) {
          const hold=record.holds.map(id=>this.materials.hold(id)).find(h=>h&&containsMaterialRange(h.range,range));
          if(!hold){reasons.push("material_unavailable");continue;}
          try{this.materials.requireProtected(hold.instanceId,range,{runId:record.runId,recipient:record.owner,purpose:record.purpose},hold.id);}
          catch{reasons.push("material_unavailable");}
        }
      }
    }
    const value={id:request.id,judgmentId:request.judgmentId,applicable:reasons.length===0,reasons:[...new Set(reasons)]};
    this.db.transaction(()=>{
      this.records.sql("INSERT INTO context_reuse_checks VALUES (?,?,?,?)").run(request.id,digest,JSON.stringify(value),modelInputValueDigest(value));
      const subject=request.subjects[0]&&this.read(request.subjects[0]);
      if(subject)this.records.fact(subject.runId,"representation",request.id,"reuse_checked",value);
    })();return value;
  }
}
function key(ref:RepresentationRef):string{return JSON.stringify([ref.id,ref.revision]);}
