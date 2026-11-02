import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {InspectionRecorder} from "../../dist/recording/index.js";
import {InspectionQueryService} from "../../dist/query/index.js";
import {retireInspectionDatasets} from "../../dist/storage/index.js";
import type {InspectionWorkMeasurement,InspectionWorkTiming} from "../records/index.js";
import type {InspectionMetric,InspectionMetricRead,InspectionMetricScope} from "./InspectionMetricQuery.js";

const cleanups:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const policy={revision:"all",enabled:true,agent:true,provider:true,execution:true,definition:true};
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),"inspection-metrics-"));cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  const abort=new AbortController(),opening=InspectionRecorder.create({root,application:"metrics",name:"Metrics",policy,signal:abort.signal});
  cleanups.push(async()=>{abort.abort();const r=await opening.catch(()=>null);if(r)await r.flush(true);});
  const recorder=await opening,queries=new InspectionQueryService(root);cleanups.push(()=>queries.close());
  const scope=async():Promise<InspectionMetricScope>=>{await recorder.flush();return {manifest:(await queries.query({kind:"open_process_scope",recordings:[{sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId,via:null}]})).process!.manifest,runIds:["root","child"]};};
  return {root,recorder,queries,scope};
}
function measurement(r:InspectionRecorder,id:string,data:InspectionWorkMeasurement["data"],extra:Partial<InspectionWorkMeasurement>={}){
  expect(r.offer({subject:r.ref("meter","contribution",id,"root"),occurredAt:"2026-11-01T00:00:00Z",payload:{kind:"work_measurement",version:"1",origin:{owner:"meter",id,runId:"root",revision:"1"},purpose:"task",target:"target",data,...extra}})).toBe(true);
}
const quantity=(value:number,metric:"material_read"|"capacity"="material_read"):InspectionWorkMeasurement["data"]=>({kind:"quantity",metric,unit:"bytes",evidence:"actual",value,upper:null,method:"exact-range",complete:true});
function attempt(boundary:"bound"|"dispatched"|"settled",requestId="request"):Extract<InspectionWorkMeasurement["data"],{kind:"attempt"}>{return {kind:"attempt",boundary,requestId,providerId:"p",model:"m",status:boundary==="settled"?"succeeded":"pending",
  usage:boundary==="settled"?{inputTokens:100,outputTokens:20,cacheReadTokens:40,cacheWriteTokens:0,cacheRelation:"input_subsets",accountingRevision:"provider-v1",consistent:true}:null,
  price:boundary==="settled"?{revision:"price-v1",providerId:"p",model:"m",currency:"USD",validFrom:"2026-01-01T00:00:00Z",validUntil:"2027-01-01T00:00:00Z",inputPerToken:0.01,outputPerToken:0.02,inputPricing:"cache_partitioned",cachedReadPerToken:0.005,cachedWritePerToken:null}:null};}
function timing(r:InspectionRecorder,id:string,start:number,end:number|null,clock="clock",category:InspectionWorkTiming["category"]="work"){
  for(const boundary of end===null?["started"] as const:["started","finished"] as const){
    expect(r.offer({subject:r.ref("timing","event",id,"root"),occurredAt:null,payload:{kind:"work_timing",version:"1",intervalId:id,owner:"work",runId:"root",pathId:"path",stageId:id,
      attemptId:null,workId:null,purposeDigest:"task",phase:id,boundary,clock:{domain:clock,monotonicMs:boundary==="started"?start:end!},durationMs:boundary==="started"?null:end!-start,outcome:boundary==="started"?null:"returned",category}})).toBe(true);
  }
}
async function finish(q:InspectionQueryService,scope:InspectionMetricScope,cursor?:string,limit=7){
  let result:InspectionMetricRead;let n=0;
  do{const started=performance.now();result=(await q.query({kind:"advance_process_metrics",...scope,...(cursor?{cursor}:{}),limit})).measurement!;
    if(process.env.INSPECTION_METRIC_DIAGNOSTICS==="1")console.info(JSON.stringify({phase:result.status,scanned:result.scanned,wallMs:performance.now()-started,...result.overhead}));
    cursor=result.cursor;expect(++n).toBeLessThan(2000);}while(result.status!=="complete"&&result.status!=="limited");
  expect(result.status).toBe("complete");return result;
}
async function metrics(q:InspectionQueryService,scope:InspectionMetricScope,cursor:string){
  let after:string|null=null;const all:InspectionMetric[]=[];
  do{const result=(await q.query({kind:"read_process_metrics",...scope,cursor,section:"metrics",limit:7,...(after?{after}:{})})).measurement!;all.push(...result.metrics);after=result.next;}while(after);
  return all;
}
describe("Evidence-bound process metrics",{timeout:20000},()=>{
  it("counts physical work once, preserves failed/missing attempts, and never adds cache subsets",async()=>{
    const f=await fixture();
    for(const boundary of ["bound","dispatched","settled"] as const){measurement(f.recorder,"a",attempt(boundary));measurement(f.recorder,"a",attempt(boundary));}
    measurement(f.recorder,"b",attempt("dispatched"));measurement(f.recorder,"b",{...attempt("settled"),status:"failed",usage:null,price:null});
    const scope=await f.scope(),done=await finish(f.queries,scope),m=await metrics(f.queries,scope,done.cursor);
    expect(m.find(m=>m.metric==="physical_attempts")?.value).toBe(2);
    expect(m.find(m=>m.metric==="input_tokens")).toMatchObject({value:null,knownValue:100,observed:1,missing:1});
    expect(m.find(m=>m.metric==="cache_read_tokens")).toMatchObject({knownValue:40,missing:1});
    expect(m.find(m=>m.metric==="amount"&&m.unit==="USD")?.value).toBeCloseTo(1.2);
    expect(m.find(m=>m.metric==="amount"&&m.unit==="unknown_currency")?.value).toBeNull();
    expect(m.some(m=>m.metric==="attempt_outcomes"&&m.dimensions.outcome==="failed"&&m.value===1)).toBe(true);
    expect(done.scanned).toBe(8);expect(done.identities).toBe(2);expect(done.limitations).toContain("recording_tail_unknown");
  });
  it("separates capacity samples, estimates and conflicts instead of summing incompatible measurements",async()=>{
    const f=await fixture();measurement(f.recorder,"a",quantity(10));measurement(f.recorder,"b",quantity(20));measurement(f.recorder,"b",quantity(21));
    measurement(f.recorder,"c",quantity(100,"capacity"));measurement(f.recorder,"d",quantity(200,"capacity"));
    measurement(f.recorder,"e",{...quantity(999,"capacity"),evidence:"estimate"});
    const scope=await f.scope(),done=await finish(f.queries,scope),m=await metrics(f.queries,scope,done.cursor);
    expect(m.find(m=>m.metric==="material_read")).toMatchObject({value:null,knownValue:10,conflicts:1});
    expect(m.find(m=>m.metric==="capacity"&&m.evidence==="actual")).toMatchObject({operation:"range",value:null,knownValue:null,minimum:100,maximum:200,observed:2});
    expect(m.find(m=>m.metric==="capacity"&&m.evidence==="estimate")?.minimum).toBe(999);
  });
  it("uses ordered same-clock unions, does not double count nesting, and leaves open/cross-clock time unknown",async()=>{
    const f=await fixture();timing(f.recorder,"parent",0,100);timing(f.recorder,"child",20,40);timing(f.recorder,"parallel",80,150);
    timing(f.recorder,"gap",170,180);timing(f.recorder,"open",200,null);timing(f.recorder,"other",1000,1100,"other");
    timing(f.recorder,"resource",0,15,"clock","resource_wait");timing(f.recorder,"dependency",20,30,"clock","dependency_wait");
    const scope=await f.scope(),done=await finish(f.queries,scope,undefined,2),m=await metrics(f.queries,scope,done.cursor);
    const main=m.find(m=>m.metric==="observed_interval_union"&&m.dimensions.clock==="clock"&&m.dimensions.category==="work"&&!m.dimensions.runId);
    expect(main?.value).toBe(160);
    expect(m.find(m=>m.metric==="observed_interval_span"&&m.dimensions.clock==="clock"&&m.dimensions.category==="work"&&!m.dimensions.runId)?.value).toBe(180);
    expect(m.find(m=>m.metric==="stage_duration"&&m.dimensions.phase==="open")).toMatchObject({value:null,missing:1});
    expect(done.limitations).toContain("cross_clock_wall_time_not_established");
    expect(m.filter(m=>m.metric==="observed_interval_union"&&!m.dimensions.runId).map(m=>m.value).sort((a,b)=>a!-b!)).toEqual([10,15,100,160]);
  });
  it("freezes the range, resumes in a fresh Worker, and makes repeated progress idempotent",async()=>{
    const f=await fixture();for(let i=0;i<31;i++)measurement(f.recorder,String(i),quantity(2));
    const scope=await f.scope();const first=(await f.queries.query({kind:"advance_process_metrics",...scope,limit:3})).measurement!;
    const next=(await f.queries.query({kind:"advance_process_metrics",...scope,cursor:first.cursor,limit:3})).measurement!;
    const repeated=(await f.queries.query({kind:"advance_process_metrics",...scope,cursor:first.cursor,limit:3})).measurement!;
    expect({...repeated,overhead:null}).toEqual({...next,overhead:null});
    measurement(f.recorder,"late",quantity(10000));await f.recorder.flush();await f.queries.close();
    const q=new InspectionQueryService(f.root);cleanups.push(()=>q.close());
    const done=await finish(q,scope,next.cursor,3),m=await metrics(q,scope,done.cursor);expect(done.scanned).toBe(31);expect(m[0]?.value).toBe(62);
    await expect(q.query({kind:"advance_process_metrics",...scope,runIds:["root"],cursor:done.cursor})).rejects.toThrow("inspection_cursor_invalid");
    const page=(await q.query({kind:"read_process_metrics",...scope,cursor:done.cursor,section:"evidence",limit:7})).measurement!;expect(page.evidence).toHaveLength(7);expect(page.next).not.toBeNull();
    await expect(q.query({kind:"read_process_metrics",...scope,cursor:done.cursor,section:"metrics",limit:7,after:page.next!})).rejects.toThrow("inspection_cursor_invalid");
  });
  it("deduplicates explicit recovery recordings, while distinct recipients still pay their own requests",async()=>{
    const f=await fixture();for(const b of ["bound","dispatched","settled"] as const)measurement(f.recorder,"shared",attempt(b));await f.recorder.flush();
    const second=await InspectionRecorder.create({root:f.root,application:"metrics",name:"Metrics",policy});cleanups.push(()=>second.flush(true).then(()=>{}));
    for(const b of ["bound","dispatched","settled"] as const){measurement(second,"shared",attempt(b));measurement(second,"own",attempt(b,"other-request"));}
    const here={sourceId:second.source.sourceId,datasetId:second.manifest.datasetId},prior={sourceId:f.recorder.source.sourceId,datasetId:f.recorder.manifest.datasetId};
    second.offer({id:"link",subject:second.ref("host","event","link","root"),occurredAt:null,payload:{kind:"recording_link",stage:"recovery_prepared",target:{...prior,runId:"root"},limitation:null}});await second.flush();
    const scope:InspectionMetricScope={runIds:["root"],manifest:(await f.queries.query({kind:"open_process_scope",recordings:[{...here,via:null},{...prior,via:{...here,recordId:"link",linkId:null}}]})).process!.manifest};
    const done=await finish(f.queries,scope),m=await metrics(f.queries,scope,done.cursor);expect(done.scanned).toBe(9);expect(done.identities).toBe(2);
    expect(m.find(m=>m.metric==="input_tokens")?.value).toBe(200);
  });
  it("chooses responsibility state by owner sequence, not the later replay of an earlier fact",async()=>{
    const f=await fixture();measurement(f.recorder,"closed",{kind:"responsibility",sequence:5,state:"closed"});measurement(f.recorder,"closed",{kind:"responsibility",sequence:1,state:"open"});
    measurement(f.recorder,"outliving-root",{kind:"responsibility",sequence:6,state:"open"});
    const scope=await f.scope(),done=await finish(f.queries,scope),m=await metrics(f.queries,scope,done.cursor);
    expect(m.find(m=>m.metric==="closed_responsibilities")?.value).toBe(1);expect(m.find(m=>m.metric==="unsettled_responsibilities")?.value).toBe(1);
  });
  it("rechecks current policy and invalidates cached reports after revocation",async()=>{
    const f=await fixture();measurement(f.recorder,"value",quantity(10));const scope=await f.scope(),done=await finish(f.queries,scope);
    writeFileSync(join(f.root,"sources",f.recorder.source.sourceId,"read-policy.json"),JSON.stringify({...policy,revision:"revoked",provider:false}));
    await expect(f.queries.query({kind:"read_process_metrics",...scope,cursor:done.cursor,section:"metrics"})).rejects.toThrow("inspection_aggregation_scope_changed");
  });
  it("bounds disposable storage, reports expiry, releases slots, and isolates cancellation",async()=>{
    const f=await fixture();for(let i=0;i<20;i++)measurement(f.recorder,String(i),quantity(1));const scope=await f.scope();
    const first=(await f.queries.query({kind:"advance_process_metrics",...scope,limit:2})).measurement!;
    const abort=new AbortController(),pending=f.queries.query({kind:"advance_process_metrics",...scope,cursor:first.cursor,limit:2},abort.signal);abort.abort();await expect(pending).rejects.toThrow("inspection_query_cancelled");
    const done=await finish(f.queries,scope,first.cursor,2);expect((await metrics(f.queries,scope,done.cursor))[0]?.value).toBe(20);
    const ref=JSON.parse(Buffer.from(done.cursor,"base64url").toString("utf8")),file=join(f.root,"query-aggregates",String(ref.slot),"aggregate.sqlite");
    const db=new Database(file);expect(db.pragma("page_count",{simple:true})).toBeLessThan(8192);const row=db.prepare("SELECT value FROM state").get() as {value:string};const state=JSON.parse(row.value);state.expires=0;
    db.prepare("UPDATE state SET expires=0,value=?").run(JSON.stringify(state));db.close();
    await expect(f.queries.query({kind:"read_process_metrics",...scope,cursor:done.cursor,section:"metrics"})).rejects.toThrow("inspection_aggregation_expired");
    for(let i=0;i<10;i++){const next=await finish(f.queries,scope);await f.queries.query({kind:"release_process_metrics",...scope,cursor:next.cursor});}
    expect((await f.queries.query({kind:"get_snapshot",sourceId:f.recorder.source.sourceId,datasetId:f.recorder.manifest.datasetId})).coverage?.captured).toBe(20);
  });
  it("does not disclose a cached aggregate after its original recording is retired",async()=>{
    const f=await fixture();measurement(f.recorder,"retained",quantity(10));const scope=await f.scope(),done=await finish(f.queries,scope);
    await f.recorder.flush(true);
    expect(retireInspectionDatasets(f.root,f.recorder.source.sourceId,{datasetId:f.recorder.manifest.datasetId,before:new Date().toISOString(),apply:true})[0]?.status).toBe("removed");
    await expect(f.queries.query({kind:"read_process_metrics",...scope,cursor:done.cursor,section:"metrics"})).rejects.toThrow("inspection_aggregation_scope_changed");
  });
  it("keeps every metric traceable to bounded original identity and observation pages",async()=>{
    const f=await fixture();for(let i=0;i<2048;i++){measurement(f.recorder,`item:${i}`,quantity(2));if(i%64===63)await f.recorder.flush();}
    const scope=await f.scope(),done=await finish(f.queries,scope,undefined,100),m=await metrics(f.queries,scope,done.cursor);
    const total=m.find(v=>v.metric==="material_read")!;expect(total.value).toBe(4096);expect(done.scanned).toBe(2048);
    let after:string|null=null,count=0,first:string|null=null;
    do{const page=(await f.queries.query({kind:"read_process_metrics",...scope,cursor:done.cursor,section:"members",metricId:total.id,limit:100,...(after?{after}:{})})).measurement!;
      expect(page.members.length).toBeLessThanOrEqual(100);count+=page.members.length;first??=page.members[0]?.identity??null;after=page.next;
      expect(page.overhead.contentExpansionMs).toBe(0);expect(page.cursor.length).toBeLessThan(1024);
    }while(after);expect(count).toBe(2048);
    const evidence=(await f.queries.query({kind:"read_process_metrics",...scope,cursor:done.cursor,section:"evidence",identity:first!})).measurement!.evidence;
    expect(evidence).toHaveLength(1);expect(evidence[0]?.location.sourceId).toBe(f.recorder.source.sourceId);
  });
  it("requires matching price target, date and cache accounting, and never prices missing usage as zero",async()=>{
    const f=await fixture();
    for(const [id,change] of [["target",{model:"other"}],["expired",{validUntil:"2025-01-01T00:00:00Z"}]] as const){
      measurement(f.recorder,id,attempt("dispatched"));const end=attempt("settled");measurement(f.recorder,id,{...end,price:{...end.price!,...change}});
    }
    measurement(f.recorder,"bad-cache",attempt("dispatched"));const end=attempt("settled");measurement(f.recorder,"bad-cache",{...end,usage:{...end.usage!,cacheReadTokens:101}});
    const scope=await f.scope(),done=await finish(f.queries,scope),m=await metrics(f.queries,scope,done.cursor);
    expect(m.find(m=>m.metric==="amount")).toMatchObject({value:null,knownValue:null,missing:2,conflicts:1});
  });
  it("preserves unknown upper bounds and cannot resurrect an overflowed subtotal",async()=>{
    const f=await fixture();measurement(f.recorder,"a",quantity(Number.MAX_SAFE_INTEGER));measurement(f.recorder,"b",quantity(1));measurement(f.recorder,"c",quantity(1));
    measurement(f.recorder,"lower",{...quantity(100,"capacity"),evidence:"bounds"});
    const scope=await f.scope(),done=await finish(f.queries,scope),m=await metrics(f.queries,scope,done.cursor);
    expect(m.find(v=>v.metric==="material_read")).toMatchObject({value:null,knownValue:null,missing:1});
    expect(m.find(v=>v.metric==="capacity")).toMatchObject({minimum:100,maximum:null,missingUpperBounds:1});
  });
  it("requires declared billing coverage instead of treating missing cache prices or counters as zero",async()=>{
    const f=await fixture(),end=attempt("settled");
    for(const id of ["missing-rate","missing-count","uniform"])measurement(f.recorder,id,attempt("dispatched"));
    measurement(f.recorder,"missing-rate",{...end,price:{...end.price!,cachedReadPerToken:null}});
    measurement(f.recorder,"missing-count",{...end,usage:{...end.usage!,cacheWriteTokens:null}});
    measurement(f.recorder,"uniform",{...end,usage:{...end.usage!,cacheWriteTokens:null},price:{...end.price!,revision:"uniform",inputPricing:"uniform",cachedReadPerToken:null}});
    const scope=await f.scope(),done=await finish(f.queries,scope),values=await metrics(f.queries,scope,done.cursor);
    expect(values.find(v=>v.metric==="amount"&&v.dimensions.priceRevision==="price-v1")).toMatchObject({value:null,missing:2});
    expect(values.find(v=>v.metric==="amount"&&v.dimensions.priceRevision==="uniform")?.value).toBeCloseTo(1.4);
  });
  it("reports incompatible original identity kinds instead of interpreting one as another",async()=>{
    const f=await fixture();measurement(f.recorder,"collision",quantity(1));measurement(f.recorder,"collision",attempt("dispatched"));
    const scope=await f.scope(),done=await finish(f.queries,scope),m=await metrics(f.queries,scope,done.cursor);
    expect(m).toHaveLength(1);expect(m[0]).toMatchObject({metric:"measurement_identity_conflicts",value:null,conflicts:1});
  });
  it("serializes concurrent advancement of the same cursor without repeating reduction",async()=>{
    const f=await fixture();for(let i=0;i<24;i++)measurement(f.recorder,String(i),quantity(2));const scope=await f.scope();
    let state=(await f.queries.query({kind:"advance_process_metrics",...scope,limit:100})).measurement!;
    expect(state.status).toBe("reducing");
    const query={kind:"advance_process_metrics" as const,...scope,cursor:state.cursor,limit:7};
    const responses=await Promise.allSettled([f.queries.query(query),f.queries.query(query)]);
    for(const response of responses)if(response.status==="fulfilled")state=response.value.measurement!;else expect(response.reason.message).toBe("inspection_query_busy");
    const done=await finish(f.queries,scope,state.cursor,7);expect((await metrics(f.queries,scope,done.cursor))[0]?.value).toBe(48);
  });
  it("persists a bounded storage failure using reserved metadata space without changing native records",async()=>{
    const f=await fixture();for(let i=0;i<120;i++)measurement(f.recorder,`item:${i}`,quantity(2));const scope=await f.scope();
    const first=(await f.queries.query({kind:"advance_process_metrics",...scope,limit:1})).measurement!;
    const ref=JSON.parse(Buffer.from(first.cursor,"base64url").toString("utf8")),db=new Database(join(f.root,"query-aggregates",String(ref.slot),"aggregate.sqlite"));
    db.pragma("max_page_count=8192");
    try{for(let i=0;i<600;i++)db.prepare("INSERT INTO reserve VALUES(zeroblob(65536))").run();throw new Error("test_did_not_fill_storage");}
    catch(error){expect((error as NodeJS.ErrnoException).code).toBe("SQLITE_FULL");}finally{db.close();}
    const limited=(await f.queries.query({kind:"advance_process_metrics",...scope,cursor:first.cursor,limit:100})).measurement!;
    expect(limited.status).toBe("limited");expect(limited.limitations).toContain("aggregation_storage_limit");
    const reopened=(await f.queries.query({kind:"read_process_metrics",...scope,cursor:limited.cursor,section:"metrics"})).measurement!;
    expect(reopened.status).toBe("limited");expect(reopened.limitations).toContain("aggregation_storage_limit");expect(reopened.metrics).toHaveLength(0);
    expect((await f.queries.query({kind:"get_snapshot",sourceId:f.recorder.source.sourceId,datasetId:f.recorder.manifest.datasetId})).coverage?.captured).toBe(120);
  });
});
