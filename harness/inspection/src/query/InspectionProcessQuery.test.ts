import {afterEach, describe, expect, it} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {join, relative, resolve} from "node:path";
import {tmpdir} from "node:os";
import {InspectionRecorder} from "../../dist/recording/index.js";
import {InspectionQueryService, executeInspectionQuery} from "../../dist/query/index.js";
import {InspectionDatabase,retireInspectionDatasets} from "../../dist/storage/index.js";
import {datasetDirectory} from "../../dist/sources/index.js";
import {inspectionLink} from "../../dist/adapters/ProviderInspectionAdapter.js";
import type {InspectionEvidenceBasis, InspectionProcessEvidence,InspectionRecordInput} from "../records/index.js";
import type {InspectionProcessQuery, InspectionReadManifest} from "./InspectionProcessQuery.js";

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const policy={revision:"all",enabled:true,definition:true,agent:true,provider:true,execution:true};
async function recorder(root:string){
  const abort=new AbortController(),opening=InspectionRecorder.create({root,application:"test",name:"Process",policy,signal:abort.signal});
  cleanups.push(async()=>{abort.abort();const created=await opening.catch(()=>null);if(created)await created.flush(true);});
  return opening;
}
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),"inspection-process-query-"));
  cleanups.push(async()=>{if(!relative(tmpdir(),resolve(root)).startsWith("inspection-process-query-"))throw new Error("Unsafe cleanup");rmSync(root,{recursive:true,force:true});});
  const r=await recorder(root);
  const queries=new InspectionQueryService(root);cleanups.push(async()=>queries.close());
  const selection={sourceId:r.source.sourceId,datasetId:r.manifest.datasetId};
  const manifest=async():Promise<InspectionReadManifest>=>{await r.flush();return (await queries.query({kind:"open_process_scope",recordings:[{...selection,via:null}]})).process!.manifest;};
  return {root,recorder:r,queries,selection,manifest};
}
function evidence(r:InspectionRecorder,id:string,category:InspectionProcessEvidence["category"]="decision",extra:Partial<InspectionProcessEvidence>={},contents?:InspectionRecordInput["contents"]){
  const subject=r.ref("owner","contribution",id,"root","v1");
  const basis:InspectionEvidenceBasis={origin:{owner:"owner",id,runId:"root",revision:"v1"},digest:"basis-"+id};
  expect(r.offer({id,subject,occurredAt:null,payload:{kind:"process_evidence",version:"1",...basis,subject,category,name:id,status:"accepted",purpose:"task",recipient:{runId:"root",recipient:"root",purpose:"task"},relationCount:0,...extra},contents:contents??[{name:"Owner evidence",class:"agent",stage:"accepted",mediaType:"application/json",value:{secret:"hidden",text:"retained"}}]})).toBe(true);
  return {subject,basis};
}

// Each case starts/joins real recorder and query Workers; individual reads retain their 2s deadline.
describe("Fixed process investigation",{timeout:15000},()=>{
  it("filters explicit Run sets, categories and commit bounds before paging and binds every filter",async()=>{
    const f=await fixture();
    evidence(f.recorder,"first","decision"); evidence(f.recorder,"second","input"); evidence(f.recorder,"third","source"); evidence(f.recorder,"fourth","decision");
    const manifest=await f.manifest();
    const original=(await f.queries.query({kind:"list_context_process",manifest,section:"facts",runId:"root",categories:["decision","input","source"]})).process!.entries;
    const start=original.find(e=>e.record.id==="second")!.record.commitSequence, end=original.find(e=>e.record.id==="fourth")!.record.commitSequence;
    const q:InspectionProcessQuery={kind:"list_context_process",manifest,section:"facts",runIds:["root","child"],categories:["decision","input"],fromSequence:start,throughSequence:end,limit:1};
    const first=(await f.queries.query(q)).process!;
    expect(first.entries.map(e=>e.record.id)).toEqual(["second"]);
    expect((await f.queries.query({...q,after:first.page.next!})).process!.entries.map(e=>e.record.id)).toEqual(["fourth"]);
    for(const changed of [{runIds:["root"]},{categories:["decision"]},{fromSequence:1},{throughSequence:end-1}])await expect(f.queries.query({...q,...changed,after:first.page.next!})).rejects.toThrow("inspection_cursor_invalid");
    const subject=f.recorder.ref("owner","contribution","fourth","root","v1");
    expect((await f.queries.query({kind:"list_context_process",manifest,subject,recordId:"fourth",section:"facts"})).process!.entries.map(e=>e.record.id)).toEqual(["fourth"]);
    expect(()=>f.queries.query({...q,runId:"root"})).toThrow("inspection_query_invalid");
    expect(()=>f.queries.query({...q,fromSequence:end+1})).toThrow("inspection_query_invalid");
  });
  it("has seven independent entry families, no-model decisions and explicit recipients",async()=>{
    const f=await fixture();
    const kinds=["source","demand","decision","method","selection","input","delivery","material","responsibility","recovery","measurement","timing"] as const;
    await expect(f.queries.query({kind:"open_process_scope",recordings:[{sourceId:"missing-source",datasetId:"missing-dataset",via:null}]})).rejects.toThrow("inspection_dataset_unavailable");
    for(const kind of kinds)evidence(f.recorder,kind,kind);
    evidence(f.recorder,"child-decision","decision",{recipient:{runId:"child",recipient:"child",purpose:"assessment"},purpose:"assessment"});
    const manifest=await f.manifest();
    const directory=(await f.queries.query({kind:"list_context_process",manifest,section:"facts",runId:"root",purpose:"task"})).process!;
    expect(directory.entries.map(e=>e.record.id)).toEqual(["source","demand","decision","method","input","responsibility"]);
    expect(directory.entries.every(e=>e.identity&&e.contents[0]?.availability==="available")).toBe(true);
    for(const [kind,id] of [["get_context_decision","decision"],["get_actual_input","input"],["get_context_path","method"],["get_source_reception","delivery"],["get_recovery_review","recovery"],["get_process_observations","measurement"]] as const){
      const result=(await f.queries.query({kind,manifest,section:"facts",subject:f.recorder.ref("owner","contribution",id,"root","v1")})).process!;
      expect(result.family).toBe(kind);expect(result.entries.map(e=>e.record.id)).toEqual([id]);
      expect(result.anchor?.availability).toBe("recorded");
    }
    expect((await f.queries.query({kind:"list_context_process",manifest,section:"facts",recipient:{runId:"child",recipient:"child",purpose:"assessment"}})).process!.entries.map(e=>e.record.id)).toEqual(["child-decision"]);
  });

  it("keeps declared path identity independent of recording identity across recovery observations",async()=>{
    const f=await fixture(); const first=evidence(f.recorder,"path-stage","method",{executionPath:f.recorder.ref("activity","contribution","original-path","root",null)});
    const old=await f.manifest(),next=await recorder(f.root);
    evidence(next,"path-stage","method",{executionPath:next.ref("activity","contribution","original-path","root",null)});
    next.offer({id:"resume-path",subject:next.ref("host","event","resume-path","root"),occurredAt:null,payload:{kind:"recording_link",stage:"recovery_prepared",target:{...f.selection,runId:"root"},limitation:null}});await next.flush();
    const manifest=(await f.queries.query({kind:"open_process_scope",recordings:[{sourceId:next.source.sourceId,datasetId:next.manifest.datasetId,via:null},{...f.selection,watermark:old.recordings[0]!.watermark,via:{sourceId:next.source.sourceId,datasetId:next.manifest.datasetId,recordId:"resume-path",linkId:null}}]})).process!.manifest;
    const variants=(await f.queries.query({kind:"get_context_path",manifest,section:"variants",evidence:first.basis})).process!.variants;
    expect(variants).toHaveLength(2);expect(new Set(variants.map(v=>v.digest)).size).toBe(1);
  });

  it("freezes pages across concurrent writes, binds all scope fields and reads historical revisions",async()=>{
    const f=await fixture();for(let i=0;i<5;i++)evidence(f.recorder,"fact-"+i);
    const manifest=await f.manifest();const q:InspectionProcessQuery={kind:"list_context_process",manifest,section:"facts",runId:"root",limit:2};
    const first=(await f.queries.query(q)).process!;expect(first.page.reason).toBe("page_limit");
    evidence(f.recorder,"new-fact");const refreshed=await f.manifest();
    const seen=first.entries.map(e=>e.record.id);let after=first.page.next;
    while(after){const page=(await f.queries.query({...q,after})).process!;seen.push(...page.entries.map(e=>e.record.id));after=page.page.next;}
    expect(seen).toEqual(["fact-0","fact-1","fact-2","fact-3","fact-4"]);
    for(const change of [{manifest:refreshed},{purpose:"task"},{limit:3},{recipient:{runId:"root",recipient:"root",purpose:"task"}}])await expect(f.queries.query({...q,...change,after:first.page.next!})).rejects.toThrow("inspection_cursor_invalid");
    const missing=(await f.queries.query({kind:"get_context_decision",manifest,section:"facts",subject:f.recorder.ref("owner","contribution","fact-0","root","v2")})).process!;
    expect(missing.entries).toEqual([]);expect(missing.anchor?.availability).toBe("referenced_only");
  });

  it("introduces only explicit recording branches and keeps duplicate observations and conflicts",async()=>{
    const f=await fixture(), original=evidence(f.recorder,"original");
    const old=await f.manifest();
    const next=await recorder(f.root);
    const newSelection={sourceId:next.source.sourceId,datasetId:next.manifest.datasetId};
    evidence(next,"original");evidence(next,"conflict","decision",{origin:original.basis.origin,digest:"different-basis"});
    next.offer({id:"resume",subject:next.ref("host","event","resume","root"),occurredAt:null,payload:{kind:"recording_link",stage:"recovery_prepared",target:{...f.selection,runId:"root"},limitation:null}});await next.flush();
    const opened=await f.queries.query({kind:"open_process_scope",recordings:[{...newSelection,via:null},{...f.selection,via:{...newSelection,recordId:"resume",linkId:null}}]});
    const manifest=opened.process!.manifest;
    const q:InspectionProcessQuery={kind:"get_context_decision",manifest,section:"facts",evidence:original.basis,limit:1};
    const first=(await f.queries.query(q)).process!, second=(await f.queries.query({...q,after:first.page.next!})).process!;
    expect([first.entries[0]!.identity,second.entries[0]!.identity]).toEqual([original.basis,original.basis]);
    expect(first.entries[0]!.record.subject.datasetId).not.toBe(second.entries[0]!.record.subject.datasetId);
    const variants=(await f.queries.query({...q,section:"variants",limit:10})).process!.variants;
    expect(variants).toHaveLength(3);expect(new Set(variants.map(v=>v.digest)).size).toBe(2);
    expect(()=>f.queries.query({kind:"open_process_scope",recordings:[{...newSelection,via:null},{...f.selection,via:null}]} as never)).toThrow();
    await expect(f.queries.query({kind:"open_process_scope",recordings:[{...f.selection,via:null},{...newSelection,via:{...f.selection,recordId:"original",linkId:null}}]})).rejects.toThrow("inspection_access_denied");
    expect((await f.queries.query({...q,manifest:old})).process!.entries).toHaveLength(1);
  });

  it("pages a wide typed catalog at its byte boundary without losing or repeating evidence",async()=>{
    const f=await fixture();
    for(let i=0;i<140;i++)evidence(f.recorder,"wide-"+i,"decision",{},Array.from({length:32},(_,j)=>({name:j+"x".repeat(250),stage:"x".repeat(250),class:"agent" as const,mediaType:"text/plain",value:"retained"})));
    const manifest=await f.manifest(),q:InspectionProcessQuery={kind:"list_context_process",manifest,section:"facts",runId:"root",limit:100};
    const first=(await f.queries.query(q)).process!;expect(first.page.reason).toBe("byte_limit");
    const seen=first.entries.map(e=>e.record.id);let after=first.page.next;
    while(after){const page=(await f.queries.query({...q,after})).process!;seen.push(...page.entries.map(e=>e.record.id));after=page.page.next;}
    expect(seen).toEqual(Array.from({length:140},(_,i)=>"wide-"+i));
  });

  it("pages multiple edges at one sequence, preserves exact body locations and missing/external targets",async()=>{
    const f=await fixture(), origin=evidence(f.recorder,"decision","decision",{relationCount:3});
    const exact=f.recorder.ref("model-interaction","request","physical","root","request-v1"),missing=f.recorder.ref("owner","contribution","missing","root","v1");
    f.recorder.offer({id:"physical",subject:exact,occurredAt:null,payload:{kind:"request",purpose:"task",providerId:"p",model:"m",compositionId:null,messageCount:2,toolCount:1}});
    const external={...missing,datasetId:"other-dataset"};
    expect(f.recorder.offer({id:"edges",subject:origin.subject,occurredAt:null,payload:{kind:"event",name:"explicit",sequence:null,code:null},links:[exact,missing,external].map(to=>inspectionLink("includes",origin.subject,to,{targetLocation:{contentId:null,partId:"call-result-1",jsonPointer:"/messages/1/content",stage:"provider_request"}}))})).toBe(true);
    const manifest=await f.manifest(),q:InspectionProcessQuery={kind:"get_context_decision",manifest,section:"relationships",subject:origin.subject,limit:1};
    expect((await f.queries.query({...f.selection,watermark:manifest.recordings[0]!.watermark,kind:"get_record",recordId:"edges"})).records).toHaveLength(1);
    const links=[];let after:string|undefined;
    do{const page=(await f.queries.query({...q,...(after?{after}:{})})).process!;links.push(...page.relationships);after=page.page.next??undefined;}while(after);
    expect(links).toHaveLength(3);expect(new Set(links.map(r=>r.link.id)).size).toBe(3);
    expect(new Set(links.map(r=>r.target.availability))).toEqual(new Set(["recorded","referenced_only","external"]));
    expect(links.every(r=>r.link.targetLocation?.jsonPointer==="/messages/1/content")).toBe(true);
    const detail=(await f.queries.query({kind:"get_context_decision",manifest,section:"facts",evidence:origin.basis})).process!;
    expect(detail.entries[0]!.relationCoverage).toEqual({declared:3,observedOrdinals:0,conflictingOrdinals:0,unexpectedOrdinals:0,inconsistentTotals:0});
  });

  it("rechecks body permission on every access without confusing capture absence or corrupt bytes",async()=>{
    const f=await fixture(),e=evidence(f.recorder,"private");const manifest=await f.manifest();
    const q:InspectionProcessQuery={kind:"get_context_decision",manifest,section:"facts",evidence:e.basis};
    const row=(await f.queries.query(q)).process!.entries[0]!;
    const contentQuery={kind:"get_process_content" as const,manifest,location:{...f.selection,recordId:"private",contentId:row.contents[0]!.descriptor.id}};
    const body=await f.queries.query(contentQuery);expect(body.content?.text).toContain("retained");expect(body.content?.text).not.toContain("hidden");
    f.recorder.setPolicy({...policy,revision:"revoked",agent:false});
    const denied=await f.queries.query(contentQuery);expect(denied.content).toBeNull();expect(denied.process?.contentAccess?.availability).toBe("denied");
    expect((await f.queries.query(q)).process!.entries[0]!.contents[0]!.availability).toBe("denied");
    f.recorder.setPolicy(policy);await f.recorder.flush();
    const db=new InspectionDatabase(datasetDirectory(f.root,f.selection.sourceId,f.selection.datasetId),undefined,{writable:true});
    (db as unknown as {db:{prepare(sql:string):{run():void}}}).db.prepare("UPDATE bodies SET bytes=X'0000'").run();db.close();
    const damaged=await f.queries.query(contentQuery);expect(damaged.content?.text).toBe("");expect(damaged.process?.contentAccess?.descriptor.unavailableReason).toBe("content_integrity_failed");
    await expect(f.queries.query({...contentQuery,location:{...contentQuery.location,datasetId:"outside"}})).rejects.toThrow("inspection_access_denied");
  });

  it("keeps a large public judgment readable in authorized pages without indexing its variable detail",async()=>{
    const f=await fixture();
    const judgment={version:"1",foreground:"limited",investment:"defer",adoption:null,reason:"no_applicable_option",reconsiderOn:["evidence_changed"],limitations:[],excluded:Array.from({length:2000},(_,i)=>({optionId:"option-"+i,reasons:["cannot_use","unknown_boundary"]}))};
    const e=evidence(f.recorder,"wide-judgment","decision",{judgment:{foreground:"limited",investment:"defer",adoption:null,detailsContentOrdinal:0}},[{name:"Public judgment",class:"agent",stage:"context_judgment",mediaType:"application/json",value:judgment}]);
    const manifest=await f.manifest();
    const entry=(await f.queries.query({kind:"get_context_decision",manifest,section:"facts",evidence:e.basis})).process!.entries[0]!;
    expect(JSON.stringify(entry)).not.toContain("cannot_use");
    const q={kind:"get_process_content" as const,manifest,location:{...f.selection,recordId:entry.record.id,contentId:entry.contents[0]!.descriptor.id},length:16384};
    let offset:number|null=0,text="",pages=0;
    do{const read=(await f.queries.query({...q,offset})).content!;text+=read.text;offset=read.nextOffset;pages++;}while(offset!==null);
    expect(pages).toBeGreaterThan(1);expect(JSON.parse(text)).toEqual(judgment);
    f.recorder.setPolicy({...policy,agent:false,revision:"revoked"});
    expect((await f.queries.query(q)).process?.contentAccess?.availability).toBe("denied");
  });

  it("freezes index progress, reports missing observations separately, and does not upgrade an old manifest after repair",async()=>{
    const f=await fixture();for(let i=0;i<4;i++)evidence(f.recorder,"record-"+i);
    const complete=await f.manifest();const db=new InspectionDatabase(datasetDirectory(f.root,f.selection.sourceId,f.selection.datasetId),undefined,{writable:true});
    db.resetProcessProjection();db.rebuildProcessProjection(complete.recordings[0]!.watermark,1);db.close();
    const partial=executeInspectionQuery(f.root,{kind:"open_process_scope",recordings:[{...f.selection,via:null}]}).process!.manifest;
    const q={kind:"list_context_process" as const,section:"facts" as const,manifest:partial,runId:"root"};
    const first=await f.queries.query(q);expect(first.process?.scan).toBe("incomplete");expect(first.process?.entries).toHaveLength(1);
    const repair=new InspectionDatabase(datasetDirectory(f.root,f.selection.sourceId,f.selection.datasetId),undefined,{writable:true});
    while(repair.process.progress().status!=="live")repair.rebuildProcessProjection(complete.recordings[0]!.watermark,1);repair.close();
    expect((await f.queries.query(q)).process!.entries).toHaveLength(1);
    expect((await f.queries.query({...q,manifest:complete})).process!.entries).toHaveLength(4);
    expect(()=>f.queries.query({...q,manifest:{...partial,projectionVersion:"999"}} as never)).toThrow("inspection_process_projection_unsupported");
  });

  it("cancels only readers and permits following queries and native writes",async()=>{
    const f=await fixture();evidence(f.recorder,"before");const manifest=await f.manifest();
    const abort=new AbortController();const pending=f.queries.query({kind:"list_context_process",manifest,section:"facts",runId:"root"},abort.signal);abort.abort();
    await expect(pending).rejects.toThrow("inspection_query_cancelled");
    evidence(f.recorder,"after");const next=await f.manifest();
    expect((await f.queries.query({kind:"list_context_process",manifest:next,section:"facts",runId:"root"})).process!.entries).toHaveLength(2);
  });
  it("retains retired branches, unavailable targets and explicitly missing capture without inventing execution absence",async()=>{
    const started=performance.now(),timings:Record<string,number>={};
    const f=await fixture();evidence(f.recorder,"old");const old=await f.manifest();
    timings.firstRecording=performance.now()-started;
    const r=await recorder(f.root);
    const here={sourceId:r.source.sourceId,datasetId:r.manifest.datasetId};
    r.offer({id:"restore",subject:r.ref("host","event","restore","root"),occurredAt:null,payload:{kind:"recording_link",stage:"recovery_prepared",target:{...f.selection,runId:"root"},limitation:null}});
    r.setPolicy({...policy,revision:"no-body",agent:false});evidence(r,"not-captured");await r.flush();
    timings.secondRecording=performance.now()-started-timings.firstRecording;
    const scope=(await f.queries.query({kind:"open_process_scope",recordings:[{...here,via:null},{...f.selection,watermark:old.recordings[0]!.watermark,via:{...here,recordId:"restore",linkId:null}}]})).process!.manifest;
    await f.recorder.flush(true);
    timings.readAndClose=performance.now()-started-timings.firstRecording-timings.secondRecording;
    expect(retireInspectionDatasets(f.root,f.selection.sourceId,{before:"2100-01-01T00:00:00Z",apply:true,datasetId:f.selection.datasetId})[0]?.status).toBe("removed");
    const review=(await f.queries.query({kind:"get_recovery_review",manifest:scope,section:"facts",runId:"root"})).process!;
    expect(review.entries.map(e=>e.record.id)).toEqual(["restore"]);expect(review.recordings[1]?.availability).toBe("retired");expect(review.scan).toBe("incomplete");
    const facts=(await f.queries.query({kind:"list_context_process",manifest:scope,section:"facts",runId:"root"})).process!;
    expect(facts.entries[0]!.contents[0]?.availability).toBe("not_captured");
    if(performance.now()-started>2000)console.info("process-query fixture timings",{...timings,total:performance.now()-started});
  });
  it("returns original relation coverage and variants; forged asserted relations fail integrity checks",async()=>{
    const f=await fixture(),e=evidence(f.recorder,"basis","decision",{relationCount:2});
    const to=f.recorder.ref("owner","contribution","output","root","v1");
    for(const [i,kind] of ["produces","produces","observes"].entries()){
      expect(f.recorder.offer({id:"relation-"+i,subject:e.subject,occurredAt:null,payload:{kind:"process_relationship",version:"1",evidence:e.basis,ordinal:0,total:2},links:[inspectionLink(kind as "produces"|"observes",e.subject,to)]})).toBe(true);
    }
    expect(f.recorder.offer({id:"inconsistent-relation",subject:e.subject,occurredAt:null,payload:{kind:"process_relationship",version:"1",evidence:e.basis,ordinal:2,total:3},links:[inspectionLink("produces",e.subject,to)]})).toBe(true);
    const manifest=await f.manifest();
    const facts=(await f.queries.query({kind:"get_context_decision",manifest,section:"facts",evidence:e.basis})).process!;
    expect(facts.entries[0]!.relationCoverage).toEqual({declared:2,observedOrdinals:1,conflictingOrdinals:1,unexpectedOrdinals:1,inconsistentTotals:1});
    const db=new InspectionDatabase(datasetDirectory(f.root,f.selection.sourceId,f.selection.datasetId),undefined,{writable:true});
    (db as unknown as {db:{prepare(sql:string):{run():void}}}).db.prepare("UPDATE relations SET value=json_set(value,'$.operation','forged')").run();db.close();
    await expect(f.queries.query({kind:"get_context_decision",manifest,section:"relationships",evidence:e.basis})).rejects.toThrow("inspection_dataset_corrupt");
    const variants=new InspectionDatabase(datasetDirectory(f.root,f.selection.sourceId,f.selection.datasetId),undefined,{writable:true});
    (variants as unknown as {db:{prepare(sql:string):{run():void}}}).db.prepare("UPDATE process_variants SET variant='forged'").run();variants.close();
    await expect(f.queries.query({kind:"get_context_decision",manifest,section:"variants",evidence:e.basis})).rejects.toThrow("inspection_dataset_corrupt");
  });
});
