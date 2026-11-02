import {afterEach,expect,it,vi} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,relative,resolve} from "node:path";
import {createHash} from "node:crypto";
import {InspectionDatabase} from "./InspectionDatabase.js";
import {INSPECTION_FORMAT_VERSION,inspectionEvidenceKey,initialInspectionProgress,type InspectionRecord,type InspectionPayloadMap} from "../records/index.js";

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const dispose of cleanup.splice(0).reverse())dispose();});
function fixture(){
  const path=mkdtempSync(join(tmpdir(),"inspection-process-"));
  cleanup.push(()=>{if(!relative(tmpdir(),resolve(path)).startsWith("inspection-process-"))throw new Error("unsafe_cleanup");rmSync(path,{recursive:true,force:true});});
  let db=new InspectionDatabase(path,{formatVersion:INSPECTION_FORMAT_VERSION,sourceId:"source",datasetId:"dataset",producerInstanceId:"producer",createdAt:new Date().toISOString(),status:"open"});
  cleanup.push(()=>db.close());
  const raw=new Database(join(path,"inspection.sqlite"));cleanup.push(()=>raw.close());
  return {get db(){return db;},raw,reopen(){db.close();db=new InspectionDatabase(path,undefined,{writable:true});}};
}
function evidence(id:string,change:Partial<InspectionPayloadMap["process_evidence"]>={}):InspectionRecord{
  const subject={sourceId:"source",datasetId:"dataset",owner:"decision",kind:"event" as const,id:"original",runId:"child",revision:"1"};
  return {id,subject,occurredAt:null,capturedAt:"2026-11-01T00:00:00Z",ownerSequence:null,captureSequence:1,commitSequence:0,policyRevision:"1",contents:[],links:[],
    payload:{kind:"process_evidence",version:"1",origin:{owner:"decision",id:"original",runId:"child",revision:"1"},digest:"original-basis",category:"decision",subject,
      name:"decision_accepted",status:"accepted",purpose:"task",recipient:{runId:"parent",recipient:"root",purpose:"task"},relationCount:2,...change}};
}
function relationship(id:string,ordinal:number,total=2):InspectionRecord {
  const record=evidence(id),p=record.payload as InspectionPayloadMap["process_evidence"];
  return {...record,payload:{kind:"process_relationship",version:"1",evidence:{origin:p.origin,digest:p.digest},ordinal,total},
    links:[{id:`${id}:link`,from:record.subject,to:{...record.subject,id:`material-${ordinal}`,runId:"parent"},kind:"delivers",condition:null,operation:null,sourceLocation:null,targetLocation:null,establishedBy:id}]};
}
it("retains observation positions, stable original variants and conflicts at a fixed boundary",()=>{
  const {db}=fixture(),first=db.write(evidence("first"),[]).record;
  db.write(evidence("replayed"),[]);
  db.write(evidence("conflict",{digest:"different-basis"}),[]);
  db.write(evidence("projection-conflict",{status:"rejected"}),[]);
  const key=inspectionEvidenceKey((first.payload as InspectionPayloadMap["process_evidence"]).origin),watermark=db.snapshot().watermark;
  expect(db.process.evidence({watermark,runId:"child",category:"decision",purpose:"task",recipient:{runId:"parent",recipient:"root",purpose:"task"}})).toHaveLength(4);
  expect(db.process.variants({watermark,evidenceKey:key})).toHaveLength(3);
  expect(db.process.variants({watermark:first.commitSequence,evidenceKey:key})).toHaveLength(1);
  expect(db.process.evidence({watermark:first.commitSequence})).toHaveLength(1);
  expect(db.snapshot().recording?.projection.cursor).toBe(0);
  expect(db.snapshot().processProjection).toMatchObject({cursor:watermark,status:"live",version:"1"});
});
it("does not merge a different original scope or revision and bounds every index page",()=>{
  const {db}=fixture();db.write(evidence("one"),[]);
  db.write(evidence("revised",{origin:{owner:"decision",id:"original",runId:"child",revision:"2"}}),[]);
  const watermark=db.snapshot().watermark;
  expect(db.process.variants({watermark,evidenceKey:inspectionEvidenceKey({owner:"decision",id:"original",runId:"child",revision:"1"})})).toHaveLength(1);
  const first=db.process.evidence({watermark,limit:1});expect(first).toHaveLength(1);
  expect(db.process.evidence({watermark,after:first[0]!.commitSequence,limit:1})[0]!.id).toBe("revised");
  expect(()=>db.process.evidence({watermark,limit:502})).toThrow("inspection_process_page_invalid");
});
it("keeps wide relations independent and a missing ordinal visible without invented edges",()=>{
  const {db,raw}=fixture(),count=320;
  const original=evidence("decision",{relationCount:count});db.write(original,[]);
  for(let i=0;i<count;i++)if(i!==19)db.write(relationship(`edge-${i}`,i,count),[]);
  db.write(relationship("repeat-edge",1,count),[]);
  const p=original.payload as InspectionPayloadMap["process_evidence"],basis={origin:p.origin,digest:p.digest},watermark=db.snapshot().watermark;
  const records=db.process.relationships({watermark,evidence:basis,limit:501});expect(records).toHaveLength(count);
  expect(new Set(records.map(r=>(r.payload as InspectionPayloadMap["process_relationship"]).ordinal)).size).toBe(count-1);
  expect(raw.prepare("SELECT COUNT(*) n FROM process_relationship_variants").get()).toEqual({n:count-1});
  expect(records.every(r=>r.links.length===1)).toBe(true);
  expect(records.flatMap(r=>r.links).some(l=>l.to.id==="material-19")).toBe(false);
});
it("commits native evidence, indexes and acknowledgements together or rolls them all back",()=>{
  const {db,raw}=fixture(),offers=[evidence("one"),evidence("two")].map((record,i)=>({record:{...record,captureSequence:i+1},contents:[],bytes:1000}));
  const digest=createHash("sha256").update(JSON.stringify(offers)).digest("hex"),health={...initialInspectionProgress().ingress,accepted:2};
  const accept=db.process.accept.bind(db.process),fault=vi.spyOn(db.process,"accept").mockImplementation(record=>{if(record.id==="two")throw new Error("projection_write_failed");accept(record);});
  expect(()=>db.writeNativeBatch("batch",digest,offers,health)).toThrow("projection_write_failed");
  expect(db.receipt("batch")).toBeNull();expect(db.snapshot().captured).toBe(0);expect(db.process.progress().cursor).toBe(0);
  expect(raw.prepare("SELECT COUNT(*) n FROM process_variants").get()).toEqual({n:0});fault.mockRestore();
  const receipt=db.writeNativeBatch("batch",digest,offers,health);
  expect(db.writeNativeBatch("batch",digest,offers,health)).toEqual(receipt);
  expect(db.process.evidence({watermark:receipt.watermark})).toHaveLength(2);
});
it("separates capture-specific content locators from conflicting original relationship meaning",()=>{
  const {db,raw}=fixture();
  for(const [id,contentId,jsonPointer] of [["one","captured-one","/messages/0"],["again","captured-two","/messages/0"],["conflict","captured-three","/messages/1"]]){
    const record=relationship(id!,0);db.write({...record,links:record.links.map(link=>({...link,targetLocation:{contentId:contentId!,partId:"task",jsonPointer:jsonPointer!,stage:"semantic" as const}}))},[]);
  }
  expect(raw.prepare("SELECT COUNT(*) n FROM process_relationship_variants").get()).toEqual({n:2});
  expect(db.records({watermark:db.snapshot().watermark}).flatMap(r=>r.links).map(l=>l.targetLocation?.contentId))
    .toEqual(["captured-one","captured-two","captured-three"]);
});
it("resumes a bounded projection rebuild after close using immutable original records only",()=>{
  const f=fixture();f.db.write(evidence("one"),[]);f.db.write(relationship("edge",0),[]);f.db.write(evidence("replay"),[]);
  const boundary=f.db.snapshot().watermark,before=f.db.records({watermark:boundary});f.db.resetProcessProjection();
  expect(f.db.snapshot().processProjection).toMatchObject({status:"rebuilding",target:boundary,cursor:0});
  expect(()=>f.db.write(evidence("must-not-skip-backlog"),[])).toThrow("inspection_process_projection_mode_mismatch");
  f.db.rebuildProcessProjection(boundary,1);f.reopen();
  expect(f.db.process.evidence({watermark:boundary})).toHaveLength(1);
  expect(()=>f.db.rebuildProcessProjection(boundary-1)).toThrow("inspection_process_projection_boundary_invalid");
  while(f.db.process.progress().status==="rebuilding")f.db.rebuildProcessProjection(boundary,1);
  expect(f.db.records({watermark:boundary})).toEqual(before);
  expect(f.db.process.evidence({watermark:boundary})).toHaveLength(2);
  expect(f.db.process.variants({watermark:boundary,evidenceKey:inspectionEvidenceKey((evidence("unused").payload as InspectionPayloadMap["process_evidence"]).origin)})).toHaveLength(1);
});
it("refuses changed original records without advancing the rebuild cursor or erasing evidence",()=>{
  const {db,raw}=fixture();db.write(evidence("one"),[]);db.write(evidence("two"),[]);const boundary=db.snapshot().watermark;
  db.resetProcessProjection();db.rebuildProcessProjection(boundary,1);
  raw.prepare("UPDATE records SET value=json_set(value,'$.payload.status','forged') WHERE id='two'").run();
  expect(()=>db.rebuildProcessProjection(boundary,1)).toThrow("inspection_process_source_corrupt");
  expect(db.process.progress()).toMatchObject({cursor:1,status:"rebuilding"});
  expect(db.process.evidence({watermark:boundary})).toHaveLength(1);
  expect(raw.prepare("SELECT COUNT(*) n FROM records").get()).toEqual({n:2});
});
it("keeps clock domains and incomplete original intervals rather than synthesizing a finish",()=>{
  const {db}=fixture();const record=evidence("timing");
  db.write({...record,payload:{kind:"work_timing",version:"1",intervalId:"original",owner:"task",runId:"child",pathId:"path",stageId:"stage",attemptId:null,workId:null,purposeDigest:"purpose",
    phase:"provider",boundary:"started",clock:{domain:"process-one",monotonicMs:12},durationMs:null,outcome:null}},[]);
  const records=db.process.timings({runId:"child",intervalId:"original",watermark:db.snapshot().watermark});
  expect(records).toHaveLength(1);expect(records[0]!.payload).toMatchObject({clock:{domain:"process-one",monotonicMs:12},durationMs:null});
});
it("rejects an incompatible dataset without migrating or deleting it",()=>{
  const f=fixture();f.db.write(evidence("one"),[]);f.raw.exec("UPDATE dataset SET version=4");
  expect(()=>new InspectionDatabase(f.db.directory)).toThrow("inspection_dataset_unsupported");
  expect(f.raw.prepare("SELECT COUNT(*) n FROM records").get()).toEqual({n:1});
});
