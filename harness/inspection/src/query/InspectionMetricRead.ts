import {performance} from "node:perf_hooks";
import type {InspectionReadResult} from "./InspectionQuery.js";
import type {InspectionMetricQuery,InspectionMetricRead,InspectionMetric,InspectionMetricEvidence,InspectionMetricInterval} from "./InspectionMetricQuery.js";
import {InspectionManifestReader} from "./InspectionReadManifest.js";
import {InspectionMetricStore} from "./InspectionMetricStore.js";
import {metricDigest,metricScope} from "./InspectionMetricValidation.js";
import {collectMeasurement,reduceMeasurement,scanIntervals} from "./InspectionMetricReduction.js";

export function executeMetricQuery(root:string,query:InspectionMetricQuery,base:InspectionReadResult):InspectionReadResult {
  const began=performance.now(),overhead={readMs:0,storeOpenMs:0,verifyMs:0,reduceMs:0,transactionMs:0,closeMs:0,resultMs:0,contentExpansionMs:0,totalMs:0};
  let response:InspectionReadResult;
  try{response=readMetrics(root,query,base,began,overhead);}catch(error){
    if(["SQLITE_BUSY","SQLITE_LOCKED"].includes(String((error as NodeJS.ErrnoException).code)))throw new Error("inspection_query_busy");throw error;
  }
  return {...response,measurement:{...response.measurement!,overhead:{...overhead,totalMs:performance.now()-began}}};
}
function readMetrics(root:string,query:InspectionMetricQuery,base:InspectionReadResult,began:number,overhead:{-readonly [K in keyof InspectionMetricRead["overhead"]]:number}):InspectionReadResult {
  const reader=new InspectionManifestReader(root,query.manifest),scope=metricScope(query);
  let store:InspectionMetricStore|undefined;
  try{
    overhead.readMs=performance.now()-began;
    const readings=reader.recordings.map(r=>r.read),policy=metricDigest(reader.recordings.map(r=>({policy:r.policy,availability:r.read.availability,index:r.read.index})));
    const opening=performance.now();store=new InspectionMetricStore(root,scope,policy,query.cursor);overhead.storeOpenMs=performance.now()-opening;
    if(readings.some(r=>r.availability!=="available")){store.erase();throw new Error("inspection_aggregation_scope_changed");}
    const db=store.db,limit="limit" in query?query.limit??100:100;
    const limitations=[...(store.state.limitation?[store.state.limitation]:[]),"critical_path_not_established","exclusive_time_not_established","cross_clock_wall_time_not_established","capacity_samples_are_not_cost","owner_measurement_coverage_not_certified","physical_storage_not_measured","resource_wait_coverage_not_certified","dependency_wait_coverage_not_certified",
      ...readings.flatMap(r=>[...(r.index!=="complete"?["projection_incomplete"]:[]),...(r.coverage?.status!=="closed"?["recording_tail_unknown"]:[]),
        ...(r.coverage?.dropped||r.coverage?.rejected?["capture_incomplete"]:[]),...(r.coverage?.capture?.enabled===false?["capture_disabled"]:[])])];
    const result=():InspectionMetricRead=>({version:"1",calculationVersion:"1",scope,status:store!.state.phase,cursor:store!.cursor(),expiresAt:new Date(store!.state.expires).toISOString(),
      scanned:store!.state.scanned,identities:store!.state.identities,recordings:readings,metrics:[],members:[],evidence:[],intervals:[],next:null,limitations:[...new Set(limitations)],overhead:{...overhead,totalMs:performance.now()-began}});
    if(query.kind==="release_process_metrics"){store.erase();return {...base,measurement:result()};}
    if(query.kind==="read_process_metrics"){
      store.check(query.cursor,scope);
      if(store.state.phase!=="complete"&&store.state.phase!=="limited")return {...base,measurement:result()};
      const t=performance.now();
      let after=0;
      if(query.after){try{const p=JSON.parse(Buffer.from(query.after,"base64url").toString("utf8"));
        if(p.id!==store.state.id||p.scope!==store.state.scope||p.section!==query.section||p.metricId!==query.metricId||p.identity!==query.identity||p.limit!==limit||!Number.isSafeInteger(p.after)||p.after<0)throw new Error();after=p.after;
      }catch{throw new Error("inspection_cursor_invalid");}}
      const table=query.section==="evidence"?"observations":query.section;
      const filter=query.metricId?"AND metric_id=?":query.identity?"AND key=?":"",bindings=query.metricId?[query.metricId]:query.identity?[query.identity]:[];
      const rows=db.prepare(`SELECT rowid AS ordinal,* FROM ${table} WHERE rowid>? ${filter} ORDER BY rowid LIMIT ?`).all(after,...bindings,limit+1) as Record<string,string|number>[];
      const kept:typeof rows=[];let bytes=0;
      for(const row of rows.slice(0,limit)){const size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>768*1024)break;bytes+=size;kept.push(row);}
      if(rows.length&&!kept.length)throw new Error("inspection_query_too_large");
      const next=rows.length>kept.length?Buffer.from(JSON.stringify({id:store.state.id,scope:store.state.scope,section:query.section,metricId:query.metricId,identity:query.identity,limit,after:kept.at(-1)!.ordinal})).toString("base64url"):null;
      const metrics=query.section==="metrics"?kept.map(row=>JSON.parse(String(row.value)) as InspectionMetric):[];
      const intervals=query.section==="intervals"?kept.map(row=>JSON.parse(String(row.value)) as InspectionMetricInterval):[];
      const evidence=query.section==="evidence"?kept.map(row=>({ordinal:Number(row.ordinal),identity:String(row.key),variant:String(row.variant),part:String(row.part),location:JSON.parse(String(row.location))} as InspectionMetricEvidence)):[];
      const members=query.section==="members"?kept.map(row=>({metricId:String(row.metric_id),identity:String(row.identity)})):[];
      overhead.resultMs=performance.now()-t;
      return {...base,measurement:{...result(),metrics,members,intervals,evidence,next}};
    }
    if(query.cursor){const position=store.check(query.cursor,scope);if(position.step===store.state.step-1&&store.state.lastResponse)return {...base,measurement:{...result(),...store.state.lastResponse}};}
    if(store.state.phase==="complete"||store.state.phase==="limited")return {...base,measurement:result()};
    const current=store;
    const transaction=performance.now();try{db.transaction(()=>{
      // Another query Worker may have accepted the same cursor while this one was opening its scope.
      const persisted=JSON.parse((db.prepare("SELECT value FROM state WHERE singleton=1").get() as {value:string}).value) as typeof current.state;
      if(persisted.id!==current.state.id||persisted.expires<Date.now())throw new Error("inspection_aggregation_expired");
      if(persisted.step!==current.state.step){
        current.state=persisted;
        if(query.cursor&&current.check(query.cursor,scope).step===persisted.step-1&&persisted.lastResponse)return;
        throw new Error("inspection_cursor_invalid");
      }
      if(current.state.phase==="collecting"){
        let remaining=limit,bytes=0;
        while(remaining>0&&current.state.recording<reader.recordings.length&&performance.now()-began<650){
          const index=current.state.recording,opened=reader.recordings[index]!,watermark=query.manifest.recordings[index]!.projectionWatermark;
          if((opened.read.coverage?.processProjection?.cursor??0)<watermark)throw new Error("inspection_aggregation_scope_changed");
          const t=performance.now(),records=opened.db!.measurementRecords(watermark,current.state.sequence,scope.runIds,remaining+1);
          overhead.readMs+=performance.now()-t;
          let consumed=0;
          for(const record of records.slice(0,remaining)){
            const size=Buffer.byteLength(JSON.stringify(record));if(bytes+size>768*1024||performance.now()-began>=650)break;
            bytes+=size;const verify=performance.now();opened.db!.verifiedRecord(record.id,watermark);overhead.verifyMs+=performance.now()-verify;
            collectMeasurement(current,record);current.state.sequence=record.commitSequence;current.state.scanned++;consumed++;
          }
          remaining-=consumed;
          if(records.length<=consumed){current.state.recording++;current.state.sequence=0;}else if(!consumed||consumed<records.length)break;
        }
        if(current.state.recording===reader.recordings.length)current.state.phase="reducing";
      }else if(current.state.phase==="reducing"){
        const t=performance.now(),rows=db.prepare("SELECT key,kind FROM identities WHERE key>? ORDER BY key LIMIT ?").all(current.state.key,limit) as {key:string;kind:string}[];
        let processed=0;
        for(const row of rows){if(performance.now()-began>=650)break;reduceMeasurement(current,row.key,row.kind);current.state.key=row.key;processed++;}
        overhead.reduceMs=performance.now()-t;
        if(rows.length<limit&&processed===rows.length)current.state.phase="intervals";
      }else if(current.state.phase==="intervals"){
        const t=performance.now();if(scanIntervals(current,limit))current.state.phase="complete";overhead.reduceMs=performance.now()-t;
      }
      current.state.step++;
      const {status,cursor,expiresAt,scanned,identities}=result();
      current.state.lastResponse={status,cursor,expiresAt,scanned,identities};current.save();
    }).immediate();}catch(error){
      if((error as NodeJS.ErrnoException).code!=="SQLITE_FULL")throw error;
      // The transaction rolled back. Never expose uncommitted counters or an invented total.
      current.state=JSON.parse((db.prepare("SELECT value FROM state WHERE singleton=1").get() as {value:string}).value);
      current.limitStorage();limitations.push("aggregation_storage_limit");
      return {...base,measurement:result()};
    }finally{overhead.transactionMs=performance.now()-transaction;}
    return {...base,measurement:{...result(),...current.state.lastResponse!}};
  }finally{const closing=performance.now();store?.close();reader.close();overhead.closeMs=performance.now()-closing;}
}
