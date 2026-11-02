import type {InspectionRecord,InspectionWorkMeasurement,InspectionWorkTiming,InspectionMeasurementData} from "../records/index.js";
import {inspectionEvidenceKey} from "../records/index.js";
import type {InspectionMetric,InspectionMetricInterval} from "./InspectionMetricQuery.js";
import {metricDigest} from "./InspectionMetricValidation.js";
import type {InspectionMetricStore} from "./InspectionMetricStore.js";

type Dimensions=InspectionMetric["dimensions"];
interface Item {part:string;variant:string;ordinal:number;value:string;}
interface MeasuredItem {measurement:InspectionWorkMeasurement;at:string|null;}

export function collectMeasurement(store:InspectionMetricStore,record:InspectionRecord):void {
  const p=record.payload;
  if(p.kind!=="work_measurement"&&p.kind!=="work_timing")return;
  const timing=p.kind==="work_timing";
  const key=timing?JSON.stringify(["timing",p.owner,p.runId,p.intervalId]):inspectionEvidenceKey(p.origin);
  const kind=timing?"timing":p.data.kind;
  const part=timing?p.boundary:p.data.kind==="attempt"?p.data.boundary:p.data.kind==="responsibility"?String(p.data.sequence):"quantity";
  const ordinal=!timing&&p.data.kind==="responsibility"?p.data.sequence:0;
  const value=timing?p:{measurement:p,at:p.data.kind==="attempt"?record.occurredAt:null};
  const variant=metricDigest(value),sql=store.db;
  if(sql.prepare("INSERT OR IGNORE INTO identities VALUES(?,?)").run(key,kind).changes)store.state.identities++;
  sql.prepare("UPDATE identities SET kind='conflict' WHERE key=? AND kind<>?").run(key,kind);
  sql.prepare("INSERT OR IGNORE INTO items VALUES(?,?,?,?,?)").run(key,part,variant,ordinal,JSON.stringify(value));
  sql.prepare("INSERT INTO observations(key,part,variant,location) VALUES(?,?,?,?)").run(key,part,variant,JSON.stringify({sourceId:record.subject.sourceId,datasetId:record.subject.datasetId,recordId:record.id,sequence:record.commitSequence}));
}

export function addMetric(store:InspectionMetricStore,metric:string,unit:string,dimensions:Dimensions,value:number|null,
  options:{evidence?:InspectionMetric["evidence"];operation?:"sum"|"range";conflict?:boolean;upper?:number|null}={}):void {
  const evidence=options.evidence??"actual",operation=options.operation??"sum";
  const id=metricDigest([metric,unit,dimensions,evidence,operation]);
  const row=store.db.prepare("SELECT value FROM metrics WHERE id=?").get(id) as {value:string}|undefined;
  const old:InspectionMetric=row?JSON.parse(row.value):{id,metric,unit,dimensions,evidence,operation,value:null,knownValue:null,minimum:null,maximum:null,observed:0,missing:0,conflicts:0,missingUpperBounds:0};
  const valid=value!==null&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER&&!options.conflict;
  const alreadyOverflowed=operation==="sum"&&old.observed>0&&old.knownValue===null;
  const knownValue=operation==="range"||alreadyOverflowed?null:valid?(old.knownValue??0)+value:old.knownValue;
  const overflow=knownValue!==null&&(!Number.isFinite(knownValue)||knownValue>Number.MAX_SAFE_INTEGER);
  const missingUpperBounds=old.missingUpperBounds+Number(operation==="range"&&evidence==="bounds"&&options.upper==null);
  const next={...old,observed:old.observed+Number(valid&&!overflow),missing:old.missing+Number(!valid&&!options.conflict||overflow),conflicts:old.conflicts+Number(!!options.conflict),
    knownValue:overflow?null:knownValue,minimum:valid?Math.min(old.minimum??value,value):old.minimum,
    missingUpperBounds,maximum:missingUpperBounds?null:valid?Math.max(old.maximum??(options.upper??value),options.upper??value):old.maximum,value:null as number|null};
  if(!next.missing&&!next.conflicts&&operation==="sum")next.value=next.knownValue;
  store.db.prepare("INSERT OR REPLACE INTO metrics VALUES(?,?)").run(id,JSON.stringify(next));
  if(store.reducingIdentity)store.db.prepare("INSERT OR IGNORE INTO members(metric_id,identity) VALUES(?,?)").run(id,store.reducingIdentity);
}

export function reduceMeasurement(store:InspectionMetricStore,key:string,kind:string):void {
  store.reducingIdentity=key;
  if(kind==="conflict"){addMetric(store,"measurement_identity_conflicts","count",{},null,{conflict:true});return;}
  const rows=store.db.prepare(`SELECT part,variant,ordinal,value FROM items WHERE key=? ORDER BY ${kind==="responsibility"?"ordinal DESC,variant":"part,variant"} LIMIT ?`).all(key,kind==="attempt"?4:kind==="timing"?3:2) as Item[];
  if(kind==="timing"){reduceTiming(store,key,rows);return;}
  const values=rows.map(r=>JSON.parse(r.value) as MeasuredItem),first=values[0]!.measurement;
  const dimensions={runId:first.origin.runId,purpose:first.purpose,target:first.target};
  if(kind==="responsibility"){
    const d=first.data as Extract<InspectionMeasurementData,{kind:"responsibility"}>;
    const conflict=rows.length>1&&rows[0]!.ordinal===rows[1]!.ordinal;
    addMetric(store,conflict?"responsibility_conflicts":d.state==="open"?"unsettled_responsibilities":"closed_responsibilities","count",dimensions,conflict?null:1,{conflict});return;
  }
  if(kind==="quantity"){
    const d=first.data as Extract<InspectionMeasurementData,{kind:"quantity"}>;
    addMetric(store,d.metric,d.unit,{...dimensions,method:d.method},d.complete?d.value:null,{evidence:d.evidence,operation:d.metric==="capacity"?"range":"sum",conflict:rows.length>1,upper:d.upper});return;
  }
  const attempts=values.map(v=>({m:v.measurement,d:v.measurement.data as Extract<InspectionMeasurementData,{kind:"attempt"}>,at:v.at}));
  const bindings=new Set(attempts.map(v=>JSON.stringify([v.d.requestId,v.d.providerId,v.d.model,v.m.target])));
  const purposes=new Set(attempts.map(v=>v.m.purpose).filter(p=>p!==null));
  const conflict=rows.length>3||new Set(rows.map(r=>r.part)).size!==rows.length||bindings.size!==1||purposes.size>1;
  const group={...dimensions,purpose:[...purposes][0]??null};
  const started=attempts.find(v=>v.d.boundary==="dispatched"),end=attempts.find(v=>v.d.boundary==="settled");
  addMetric(store,"physical_attempts","count",group,started?1:null,{conflict});
  addMetric(store,"unsettled_attempts","count",group,started&&!end?1:0,{conflict});
  if(end)addMetric(store,"attempt_outcomes","count",{...group,outcome:end.d.status},1,{conflict});
  const usage=end?.d.usage;
  const inconsistent=usage?.consistent===false||usage?.cacheRelation==="input_subsets"&&usage.inputTokens!==null&&
    (usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0)>usage.inputTokens;
  for(const [metric,value] of [["input_tokens",usage?.inputTokens],["output_tokens",usage?.outputTokens],
    ["cache_read_tokens",usage?.cacheRelation==="input_subsets"?usage.cacheReadTokens:null],["cache_write_tokens",usage?.cacheRelation==="input_subsets"?usage.cacheWriteTokens:null]] as const)
    addMetric(store,metric,"tokens",group,value??null,{conflict:conflict||inconsistent});
  const price=end?.d.price;
  let amount:number|null=null;
  if(price&&end&&usage&&usage.inputTokens!==null&&usage.outputTokens!==null&&price.providerId===end.d.providerId&&price.model===end.d.model&&
    started?.at&&Date.parse(started.at)>=Date.parse(price.validFrom)&&Date.parse(started.at)<Date.parse(price.validUntil)){
    const read=usage.cacheReadTokens,write=usage.cacheWriteTokens;
    if(price.inputPricing==="uniform")amount=usage.inputTokens*price.inputPerToken+usage.outputTokens*price.outputPerToken;
    else if(read!==null&&write!==null&&usage.cacheRelation==="input_subsets"&&usage.consistent===true&&read+write<=usage.inputTokens&&
      (read===0||price.cachedReadPerToken!==null)&&(write===0||price.cachedWritePerToken!==null))
      amount=(usage.inputTokens-read-write)*price.inputPerToken+usage.outputTokens*price.outputPerToken+read*(price.cachedReadPerToken??0)+write*(price.cachedWritePerToken??0);
  }
  addMetric(store,"amount",price?.currency??"unknown_currency",{...group,priceRevision:price?.revision??null},amount,{conflict:conflict||inconsistent});
}

function reduceTiming(store:InspectionMetricStore,key:string,rows:Item[]):void {
  const values=rows.map(r=>JSON.parse(r.value) as InspectionWorkTiming),first=values[0]!;
  const start=values.find(v=>v.boundary==="started"),end=values.find(v=>v.boundary==="finished");
  const group={runId:first.runId,purpose:first.purposeDigest,phase:first.phase,clock:first.clock.domain};
  const binding=(v:InspectionWorkTiming)=>JSON.stringify([v.owner,v.runId,v.pathId,v.stageId,v.attemptId,v.workId,v.phase,v.purposeDigest,v.clock.domain,v.category??"work"]);
  const conflict=rows.length>2||new Set(rows.map(r=>r.part)).size!==rows.length||new Set(values.map(binding)).size!==1||
    !!(start&&end&&(end.clock.monotonicMs<start.clock.monotonicMs||end.durationMs!==null&&Math.abs(end.durationMs-(end.clock.monotonicMs-start.clock.monotonicMs))>0.001));
  const duration=start&&end&&!conflict?end.clock.monotonicMs-start.clock.monotonicMs:null;
  addMetric(store,"stage_duration","ms",group,duration,{conflict});
  if(!start||!end)addMetric(store,"unclosed_intervals","count",group,1);
  if(duration===null||!start||!end)return;
  const category=first.category??"work";
  const interval:InspectionMetricInterval={identity:key,runId:first.runId,phase:first.phase,clock:first.clock.domain,start:start.clock.monotonicMs,end:end.clock.monotonicMs,durationMs:duration,category};
  store.db.prepare("INSERT INTO intervals VALUES(?,?)").run(key,JSON.stringify(interval));
  for(const dimensions of [{clock:first.clock.domain,category},{...group,category}]){
    const groupKey=JSON.stringify(dimensions);
    store.db.prepare("INSERT INTO interval_order VALUES(?,?,?,?)").run(groupKey,interval.start,key,interval.end);
  }
}

export function scanIntervals(store:InspectionMetricStore,limit:number):boolean {
  store.reducingIdentity=null;
  const a=store.state.intervalAfter;
  const rows=store.db.prepare(`SELECT group_key,start,id,end FROM interval_order ${a?"WHERE (group_key,start,id)>(?,?,?)":""} ORDER BY group_key,start,id LIMIT ?`).all(...(a?[a.group,a.start,a.id]:[]),limit) as {group_key:string;start:number;id:string;end:number}[];
  for(const row of rows){
    for(const metric of ["observed_interval_union","observed_interval_span"]){
      const id=metricDigest([metric,"ms",JSON.parse(row.group_key),"actual","sum"]);
      store.db.prepare("INSERT OR IGNORE INTO members(metric_id,identity) VALUES(?,?)").run(id,row.id);
    }
    if(store.state.union?.group!==row.group_key){flushUnion(store);store.state.union={group:row.group_key,start:row.start,end:row.end,first:row.start,last:row.end,duration:0};}
    else {const u=store.state.union;if(row.start>u.end){u.duration+=u.end-u.start;u.start=row.start;u.end=row.end;}else u.end=Math.max(u.end,row.end);u.last=Math.max(u.last,row.end);}
    store.state.intervalAfter={group:row.group_key,start:row.start,id:row.id};
  }
  if(rows.length<limit){flushUnion(store);return true;}return false;
}
function flushUnion(store:InspectionMetricStore):void {
  const u=store.state.union;if(!u)return;
  const group=JSON.parse(u.group) as Dimensions;
  addMetric(store,"observed_interval_union","ms",group,u.duration+u.end-u.start);
  addMetric(store,"observed_interval_span","ms",group,u.last-u.first);
  store.state.union=null;
}
