import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,relative} from "node:path";
import {InspectionRecorder} from "../dist/recording/InspectionRecorder.js";
import {InspectionDatabase} from "../dist/storage/InspectionDatabase.js";
import {datasetDirectory} from "../dist/sources/index.js";

const root=mkdtempSync(join(tmpdir(),"inspection-ingress-"));
const count=Number(process.argv.find(a=>a.startsWith("--records="))?.slice(10)??25000);
assert(Number.isSafeInteger(count)&&count>0&&count<=25000);
let recorder;
const abort=new AbortController(),deadline=setTimeout(()=>abort.abort(),60000);
try {
  recorder=await InspectionRecorder.create({root,application:"ingress-qualification",name:"Ingress",policy:{revision:"qualification",enabled:true,definition:true,agent:true,provider:true,execution:true},signal:abort.signal});
  const started=performance.now(),cpu=process.cpuUsage();let bodyBytes=0;
  for(let i=0;i<count;i++){
    const text=i%3===0?`${i%18000}:`+"x".repeat(i%9===0?42*1024:4*1024):null;
    bodyBytes+=text?.length??0;
    assert(await recorder.offerWhenReady({id:`burst-${i}`,subject:recorder.ref(i%2?"runtime":"model-interaction","event",`fact-${i}`,`run-${i%8}`),occurredAt:new Date().toISOString(),
      payload:{kind:"event",name:"owner_fact",sequence:i,code:null},contents:text===null?[]:[{name:"body",class:"agent",stage:"received",mediaType:"text/plain",value:text}]},{signal:abort.signal}));
    if((i+1)%5000===0){const usage=process.cpuUsage(cpu);console.log(JSON.stringify({admitted:i+1,elapsedMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000,health:recorder.health()}));}
  }
  const admissionMs=performance.now()-started;
  let settled;
  do {settled=await recorder.flush();assert(!["failed","unknown"].includes(settled.native));assert(!["failed","unknown"].includes(settled.projection));assert(performance.now()-started<60000,JSON.stringify({code:"ingress_budget",admissionMs,elapsedMs:performance.now()-started,health:recorder.health()}));}
  while(settled.native==="pending"||settled.projection==="pending");
  const directory=datasetDirectory(root,recorder.source.sourceId,recorder.manifest.datasetId),db=new InspectionDatabase(directory);
  try {
    const coverage=db.snapshot();assert.equal(coverage.captured,count);assert.equal(coverage.dropped,0);assert.equal(coverage.rejected,0);assert.equal(coverage.telemetryDropped,0);
    assert(coverage.recording.timings.projectionConversion.count>0);assert(coverage.recording.timings.projectionWrite.count>0);
    assert(coverage.processProjection.cursor>=coverage.recording.native.target);
    assert(!readdirSync(directory).some(name=>name==="content"||name==="staging"));
    console.log(JSON.stringify({records:coverage.captured,bodyBytes,admissionMs,elapsedMs:performance.now()-started,health:recorder.health(),coverage,databaseBytes:db.size()}));
  }finally{db.close();}
} finally {
  clearTimeout(deadline);abort.abort();
  await recorder?.flush(true);
  if(!relative(tmpdir(),root).startsWith("inspection-ingress-"))throw new Error("Unsafe cleanup");
  rmSync(root,{recursive:true,force:true});
}
