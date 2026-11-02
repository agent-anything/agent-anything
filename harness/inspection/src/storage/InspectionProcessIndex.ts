import type Database from "better-sqlite3";
import {createHash} from "node:crypto";
import {inspectionMeasurementObservationOrigin} from "../records/InspectionWorkMeasurement.js";
import {inspectionEvidenceKey,inspectionSubjectKey,type InspectionEvidenceBasis,type InspectionRecord,type InspectionSubjectRef,type InspectionContentLocation} from "../records/index.js";

export const INSPECTION_PROCESS_SCHEMA=`
CREATE TABLE process_projection(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,cursor INTEGER NOT NULL,status TEXT NOT NULL,target INTEGER);
INSERT INTO process_projection VALUES(1,'1',0,'live',NULL);
CREATE TABLE process_evidence(sequence INTEGER PRIMARY KEY,record_id TEXT NOT NULL,evidence_key TEXT NOT NULL,basis_digest TEXT NOT NULL,variant TEXT NOT NULL,category TEXT NOT NULL,subject_key TEXT NOT NULL,run_id TEXT,purpose TEXT,recipient_key TEXT);
CREATE INDEX process_evidence_key ON process_evidence(evidence_key,sequence);
CREATE INDEX process_evidence_subject ON process_evidence(subject_key,sequence);
CREATE INDEX process_evidence_scope ON process_evidence(run_id,category,sequence);
CREATE INDEX process_evidence_category ON process_evidence(category,sequence);
CREATE INDEX process_evidence_purpose ON process_evidence(purpose,sequence);
CREATE INDEX process_evidence_recipient ON process_evidence(recipient_key,sequence);
CREATE TABLE process_variants(evidence_key TEXT NOT NULL,variant TEXT NOT NULL,first_sequence INTEGER NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(evidence_key,variant));
CREATE TABLE process_relationships(sequence INTEGER PRIMARY KEY,record_id TEXT NOT NULL,evidence_key TEXT NOT NULL,basis_digest TEXT NOT NULL,ordinal INTEGER NOT NULL,total INTEGER NOT NULL,variant TEXT NOT NULL,from_key TEXT NOT NULL,to_key TEXT NOT NULL,kind TEXT NOT NULL);
CREATE INDEX process_relationships_evidence ON process_relationships(evidence_key,basis_digest,ordinal,sequence);
CREATE INDEX process_relationships_from ON process_relationships(from_key,sequence);
CREATE INDEX process_relationships_to ON process_relationships(to_key,sequence);
CREATE TABLE process_relationship_variants(evidence_key TEXT NOT NULL,basis_digest TEXT NOT NULL,ordinal INTEGER NOT NULL,variant TEXT NOT NULL,first_sequence INTEGER NOT NULL,PRIMARY KEY(evidence_key,basis_digest,ordinal,variant));
CREATE TABLE work_timings(sequence INTEGER PRIMARY KEY,record_id TEXT NOT NULL,interval_id TEXT NOT NULL,boundary TEXT NOT NULL,run_id TEXT NOT NULL,path_id TEXT NOT NULL,stage_id TEXT NOT NULL,attempt_id TEXT,work_id TEXT,phase TEXT NOT NULL,clock_domain TEXT NOT NULL);
CREATE INDEX work_timings_interval ON work_timings(interval_id,boundary,sequence);
CREATE INDEX work_timings_scope ON work_timings(run_id,phase,sequence);
CREATE INDEX work_timings_attempt ON work_timings(attempt_id,sequence);
CREATE INDEX work_timings_stage ON work_timings(stage_id,sequence);
`;
export const INSPECTION_PROCESS_TABLES=["process_projection","process_evidence","process_variants","process_relationships","process_relationship_variants","work_timings"];
export interface InspectionProcessFilter {readonly watermark:number;readonly after?:number;readonly limit?:number;readonly runId?:string;readonly category?:string;readonly purpose?:string;readonly recipient?:{readonly runId:string;readonly recipient:string;readonly purpose:string};readonly evidenceKey?:string;readonly subjectKey?:string;}
export interface InspectionProcessReadFilter extends InspectionProcessFilter {
  readonly recordId?:string;
  readonly runIds?:readonly string[];readonly fromSequence?:number;readonly throughSequence?:number;
  readonly categories?:readonly string[]; readonly basisDigest?:string;
  readonly afterKey?:string; readonly recordingLinks?:boolean;
}

/** Derived lookup only. No private owner payload is interpreted here. */
export class InspectionProcessIndex {
  private readonly statements=new Map<string,Database.Statement>();
  constructor(private readonly db:Database.Database){}
  private sql(text:string):Database.Statement {let stmt=this.statements.get(text);if(!stmt){stmt=this.db.prepare(text);this.statements.set(text,stmt);}return stmt;}
  facts(input:InspectionProcessReadFilter):InspectionRecord[] {
    const limit=page(input), args:(string|number)[]=[input.watermark,input.after??0];
    const where=["r.sequence<=?","r.sequence>?"];
    scopeFilter(input,where,args,"r.run_id","r.sequence");
    if(input.recordId){where.push("r.id=?");args.push(input.recordId);}
    for(const [column,value] of [["r.run_id",input.runId],["p.category",input.category],["p.purpose",input.purpose],["p.recipient_key",input.recipient?recipientKey(input.recipient):undefined],["p.basis_digest",input.basisDigest]])
      if(value!==undefined){where.push(`${column}=?`);args.push(value);}
    if(input.categories?.length){where.push(`(p.category IN (${input.categories.map(()=>"?").join(",")})${input.recordingLinks?" OR r.kind='recording_link'":""})`);args.push(...input.categories);}
    const select=(projected:boolean,condition:string,bindings:(string|number)[])=>this.sql(`SELECT r.sequence,r.value FROM ${projected?"process_evidence p JOIN records r":"records r LEFT JOIN process_evidence p"} ON p.sequence=r.sequence WHERE ${where.join(" AND ")} AND ${condition} ORDER BY r.sequence LIMIT ?`).all(...args,...bindings,limit) as {sequence:number;value:string}[];
    // Each indexed branch applies all filters before its limit; the merge is at most two pages.
    const rows=input.subjectKey?[...select(false,"r.subject_key=?",[input.subjectKey]),...select(true,"p.subject_key=?",[input.subjectKey])]:
      input.evidenceKey?select(true,"p.evidence_key=?",[input.evidenceKey]):
      [...select(true,"1=1",[]),...(input.recordingLinks?select(false,"r.kind='recording_link'",[]):[])];
    return [...new Map(rows.map(row=>[row.sequence,row])).values()].sort((a,b)=>a.sequence-b.sequence).slice(0,limit).map(row=>JSON.parse(row.value));
  }
  relationPage(input:InspectionProcessReadFilter):{record:InspectionRecord;link:import("../records/index.js").InspectionLink}[] {
    const limit=page(input),where=["l.sequence<=?","(l.sequence>? OR (l.sequence=? AND l.id>?))"],args:(string|number)[]=[input.watermark,input.after??0,input.after??0,input.afterKey??""];
    if(input.subjectKey){where.push("(l.from_key=? OR l.to_key=?)");args.push(input.subjectKey,input.subjectKey);}
    if(input.evidenceKey){where.push("p.evidence_key=?");args.push(input.evidenceKey);}
    if(input.basisDigest){where.push("p.basis_digest=?");args.push(input.basisDigest);}
    if(input.runId){where.push("r.run_id=?");args.push(input.runId);}
    scopeFilter(input,where,args,"r.run_id","r.sequence");
    const scoped:string[]=[],scopeArgs:(string|number)[]=[];
    if(input.categories?.length){scoped.push(`e.category IN (${input.categories.map(()=>"?").join(",")})`);scopeArgs.push(...input.categories);}
    for(const [column,value] of [["category",input.category],["purpose",input.purpose],["recipient_key",input.recipient?recipientKey(input.recipient):undefined]])
      if(value!==undefined){scoped.push(`e.${column}=?`);scopeArgs.push(value);}
    if(scoped.length){where.push(`EXISTS(SELECT 1 FROM process_evidence e WHERE e.evidence_key=p.evidence_key AND e.basis_digest=p.basis_digest AND e.sequence<=? AND ${scoped.join(" AND ")})`);args.push(input.watermark,...scopeArgs);}
    return (this.sql(`SELECT r.value AS record,l.value AS link FROM relations l JOIN records r ON r.id=l.record_id LEFT JOIN process_relationships p ON p.sequence=l.sequence WHERE ${where.join(" AND ")} ORDER BY l.sequence,l.id LIMIT ?`).all(...args,limit) as {record:string;link:string}[]).map(r=>({record:JSON.parse(r.record),link:JSON.parse(r.link)}));
  }
  relationCoverage(input:{watermark:number;evidence:InspectionEvidenceBasis&{relationCount:number}}):{observedOrdinals:number;conflictingOrdinals:number;unexpectedOrdinals:number;inconsistentTotals:number} {
    const row=this.sql(`SELECT COUNT(*) AS observed,COALESCE(SUM(variants>1),0) AS conflicts FROM (SELECT ordinal,COUNT(*) AS variants FROM process_relationship_variants WHERE evidence_key=? AND basis_digest=? AND first_sequence<=? GROUP BY ordinal)`).get(inspectionEvidenceKey(input.evidence.origin),input.evidence.digest,input.watermark) as {observed:number;conflicts:number};
    const expected=input.evidence.relationCount;
    const bounds=this.sql(`SELECT COUNT(DISTINCT CASE WHEN ordinal<? AND total=? THEN ordinal END) AS observed,COUNT(DISTINCT CASE WHEN ordinal>=? THEN ordinal END) AS unexpected,COUNT(DISTINCT CASE WHEN total!=? THEN ordinal END) AS inconsistent FROM process_relationships WHERE evidence_key=? AND basis_digest=? AND sequence<=?`).get(expected,expected,expected,expected,inspectionEvidenceKey(input.evidence.origin),input.evidence.digest,input.watermark) as {observed:number;unexpected:number;inconsistent:number};
    return {observedOrdinals:bounds.observed,conflictingOrdinals:row.conflicts,unexpectedOrdinals:bounds.unexpected,inconsistentTotals:bounds.inconsistent};
  }
  progress():{version:"1";cursor:number;status:"live"|"rebuilding";target:number|null}{const row=this.sql("SELECT version,cursor,status,target FROM process_projection WHERE id=1").get() as {version:string;cursor:number;status:"live"|"rebuilding";target:number|null};if(row?.version!=="1")throw new Error("inspection_process_projection_unsupported");return {...row,version:"1"};}
  reset(target:number):void {for(const table of INSPECTION_PROCESS_TABLES.slice(1))this.db.exec(`DELETE FROM ${table}`);this.sql("UPDATE process_projection SET cursor=0,status='rebuilding',target=? WHERE id=1").run(target);}
  accept(record:InspectionRecord,rebuilding=false):void {
    if((this.progress().status==="rebuilding")!==rebuilding)throw new Error("inspection_process_projection_mode_mismatch");
    const p=record.payload,sequence=record.commitSequence;
    if(p.kind==="process_evidence") {
      const key=inspectionEvidenceKey(p.origin),variant=inspectionProcessVariantDigest(record)!;
      this.sql("INSERT OR IGNORE INTO process_evidence VALUES(?,?,?,?,?,?,?,?,?,?)").run(sequence,record.id,key,p.digest,variant,p.category,inspectionSubjectKey(p.subject),record.subject.runId,p.purpose,p.recipient?recipientKey(p.recipient):null);
      this.sql("INSERT OR IGNORE INTO process_variants VALUES(?,?,?,?)").run(key,variant,sequence,record.id);
    } else if(p.kind==="process_relationship") {
      const key=inspectionEvidenceKey(p.evidence.origin),link=record.links[0]!;
      const variant=digest({basis:p.evidence,total:p.total,ordinal:p.ordinal,from:originalRef(link.from),to:originalRef(link.to),kind:link.kind,condition:link.condition,operation:link.operation,sourceLocation:originalLocation(link.sourceLocation),targetLocation:originalLocation(link.targetLocation)});
      this.sql("INSERT OR IGNORE INTO process_relationships VALUES(?,?,?,?,?,?,?,?,?,?)").run(sequence,record.id,key,p.evidence.digest,p.ordinal,p.total,variant,inspectionSubjectKey(link.from),inspectionSubjectKey(link.to),link.kind);
      this.sql("INSERT OR IGNORE INTO process_relationship_variants VALUES(?,?,?,?,?)").run(key,p.evidence.digest,p.ordinal,variant,sequence);
    } else if(p.kind==="work_measurement") {
      const key=inspectionEvidenceKey(inspectionMeasurementObservationOrigin(p)),variant=inspectionProcessVariantDigest(record)!;
      this.sql("INSERT OR IGNORE INTO process_evidence VALUES(?,?,?,?,?,?,?,?,?,?)").run(sequence,record.id,key,variant,variant,"measurement",inspectionSubjectKey(record.subject),p.origin.runId,p.purpose,null);
      this.sql("INSERT OR IGNORE INTO process_variants VALUES(?,?,?,?)").run(key,variant,sequence,record.id);
    } else if(p.kind==="work_timing") {
      this.sql("INSERT OR IGNORE INTO work_timings VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(sequence,record.id,p.intervalId,p.boundary,p.runId,p.pathId,p.stageId,p.attemptId,p.workId,p.phase,p.clock.domain);
      const key=inspectionEvidenceKey({owner:p.owner,id:JSON.stringify([p.intervalId,p.boundary]),runId:p.runId,revision:"1"}),variant=inspectionProcessVariantDigest(record)!;
      this.sql("INSERT OR IGNORE INTO process_evidence VALUES(?,?,?,?,?,?,?,?,?,?)").run(sequence,record.id,key,variant,variant,"timing",inspectionSubjectKey(record.subject),p.runId,null,null);
      this.sql("INSERT OR IGNORE INTO process_variants VALUES(?,?,?,?)").run(key,variant,sequence,record.id);
    }
    this.sql("UPDATE process_projection SET cursor=MAX(cursor,?) WHERE id=1").run(sequence);
  }
  evidence(input:InspectionProcessFilter):InspectionRecord[] {
    const limit=page(input),where=["p.sequence<=?","p.sequence>?"];const args:(number|string)[]=[input.watermark,input.after??0];
    for(const [key,value] of [["run_id",input.runId],["category",input.category],["purpose",input.purpose],["recipient_key",input.recipient?recipientKey(input.recipient):undefined],["evidence_key",input.evidenceKey],["subject_key",input.subjectKey]])
      if(value!==undefined){where.push(`p.${key}=?`);args.push(value);}
    return (this.sql(`SELECT r.value FROM process_evidence p JOIN records r ON r.sequence=p.sequence WHERE ${where.join(" AND ")} ORDER BY p.sequence LIMIT ?`).all(...args,limit) as {value:string}[]).map(r=>JSON.parse(r.value));
  }
  variants(input:InspectionProcessReadFilter&{evidenceKey:string}):{digest:string;firstSequence:number;recordId:string}[] {
    const limit=page(input),where=["v.evidence_key=?","v.first_sequence>?","v.first_sequence<=?"],args:(string|number)[]=[input.evidenceKey,input.after??0,input.watermark];
    scopeFilter(input,where,args,"p.run_id","v.first_sequence");
    if(input.categories?.length){where.push(`p.category IN (${input.categories.map(()=>"?").join(",")})`);args.push(...input.categories);}
    for(const [column,value] of [["run_id",input.runId],["purpose",input.purpose],["category",input.category],["recipient_key",input.recipient?recipientKey(input.recipient):undefined]])if(value!==undefined){where.push(`p.${column}=?`);args.push(value);}
    return (this.sql(`SELECT v.variant,v.first_sequence,v.record_id FROM process_variants v JOIN process_evidence p ON p.sequence=v.first_sequence WHERE ${where.join(" AND ")} ORDER BY v.first_sequence LIMIT ?`).all(...args,limit) as {variant:string;first_sequence:number;record_id:string}[])
      .map(r=>({digest:r.variant,firstSequence:r.first_sequence,recordId:r.record_id}));
  }
  relationships(input:{watermark:number;after?:number;limit?:number;evidence:InspectionEvidenceBasis}):InspectionRecord[] {
    const limit=page(input);
    return (this.sql("SELECT r.value FROM process_relationships p JOIN records r ON r.sequence=p.sequence WHERE p.evidence_key=? AND p.basis_digest=? AND p.sequence>? AND p.sequence<=? ORDER BY p.sequence LIMIT ?")
      .all(inspectionEvidenceKey(input.evidence.origin),input.evidence.digest,input.after??0,input.watermark,limit) as {value:string}[]).map(r=>JSON.parse(r.value));
  }
  timings(input:{watermark:number;after?:number;limit?:number;runId:string;intervalId?:string}):InspectionRecord[] {
    const limit=page(input);
    return (this.sql(`SELECT r.value FROM work_timings t JOIN records r ON r.sequence=t.sequence WHERE t.run_id=? AND t.sequence>? AND t.sequence<=?${input.intervalId?" AND t.interval_id=?":""} ORDER BY t.sequence LIMIT ?`)
      .all(input.runId,input.after??0,input.watermark,...(input.intervalId?[input.intervalId]:[]),limit) as {value:string}[]).map(r=>JSON.parse(r.value));
  }
}
export function inspectionProcessVariantDigest(record:InspectionRecord):string|null {
  const p=record.payload;
  return p.kind==="process_evidence"?digest({...p,subject:originalRef(p.subject),...(p.executionPath?{executionPath:originalRef(p.executionPath)}:{})}):p.kind==="work_timing"||p.kind==="work_measurement"?digest(p):null;
}
function originalRef(ref:InspectionSubjectRef){const {sourceId:_,datasetId:__,...original}=ref;return original;}
function originalLocation(ref:InspectionContentLocation|null){if(!ref)return null;const {contentId:_,...original}=ref;return original;}
function scopeFilter(input:InspectionProcessReadFilter,where:string[],args:(string|number)[],run:string,sequence:string):void {
  if(input.runIds?.length){where.push(`${run} IN (${input.runIds.map(()=>"?").join(",")})`);args.push(...input.runIds);}
  if(input.fromSequence!==undefined){where.push(`${sequence}>=?`);args.push(input.fromSequence);}
  if(input.throughSequence!==undefined){where.push(`${sequence}<=?`);args.push(input.throughSequence);}
}
function recipientKey(ref:{runId:string;recipient:string;purpose:string}):string{return JSON.stringify([ref.runId,ref.recipient,ref.purpose]);}
function digest(value:unknown):string{return createHash("sha256").update(JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest("hex");}
function page(input:{watermark:number;after?:number;limit?:number}):number {const limit=input.limit??100;if(!Number.isSafeInteger(input.watermark)||input.watermark<0||!Number.isSafeInteger(input.after??0)||(input.after??0)<0||!Number.isSafeInteger(limit)||limit<1||limit>501)throw new TypeError("inspection_process_page_invalid");return limit;}
