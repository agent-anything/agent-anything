import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {spawnSync} from "node:child_process";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const require=createRequire(import.meta.url),workspace=fileURLToPath(new URL("../../../",import.meta.url));
const directory=mkdtempSync(join(tmpdir(),"inspection-metric-process-"));
const imports=`const {InspectionRecorder}=await import(${JSON.stringify(new URL("../dist/recording/index.js",import.meta.url).href)});
const {InspectionQueryService}=await import(${JSON.stringify(new URL("../dist/query/index.js",import.meta.url).href)});
const {InspectionDatabase}=await import(${JSON.stringify(new URL("../dist/storage/index.js",import.meta.url).href)});
const {datasetDirectory}=await import(${JSON.stringify(new URL("../dist/sources/index.js",import.meta.url).href)});
const {writeFileSync,readFileSync}=await import('node:fs');const {join}=await import('node:path');const assert=(await import('node:assert/strict')).default;`;
try{
  for(const executable of [process.execPath,require(resolve(workspace,"products/helarc/desktop/node_modules/electron"))]){
    const root=join(directory,executable===process.execPath?"node":"electron"),checkpoint=join(root,"checkpoint.json");
    const launch=(body,exit=0)=>{const result=spawnSync(executable,["-e",`(async()=>{${imports}const root=${JSON.stringify(root)},checkpoint=${JSON.stringify(checkpoint)};${body}})().catch(e=>{console.error(e);process.exitCode=1});`],
      {encoding:"utf8",timeout:20000,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}});assert.equal(result.status,exit,result.stderr||String(result.error));return result.stdout;};
    launch(`const r=await InspectionRecorder.create({root,application:'metric-verification',name:'Metrics'}),q=new InspectionQueryService(root);
      const offer=(id,data)=>assert(r.offer({subject:r.ref('owner','contribution',id,'root'),occurredAt:'2026-11-01T00:00:00Z',payload:{kind:'work_measurement',version:'1',origin:{owner:'owner',id,runId:'root',revision:'1'},purpose:'task',target:'target',data}}));
      for(let i=0;i<257;i++){offer('read:'+i,{kind:'quantity',metric:'material_read',unit:'bytes',evidence:'actual',value:2,upper:null,method:'logical-range',complete:true});if(i%64===63)await r.flush();}
      for(const id of ['a','a','b'])for(const boundary of ['bound','dispatched','settled'])offer(id,{kind:'attempt',boundary,requestId:'request:'+id,providerId:'p',model:'m',status:boundary==='settled'?(id==='a'?'succeeded':'failed'):'pending',price:null,
        usage:boundary==='settled'&&id==='a'?{inputTokens:100,outputTokens:20,cacheReadTokens:40,cacheWriteTokens:null,cacheRelation:'input_subsets',accountingRevision:'1',consistent:true}:null});
      for(const [id,start,end] of [['parent',0,100],['child',20,40],['parallel',80,150]])for(const boundary of ['started','finished'])assert(r.offer({subject:r.ref('work','event',id,'root'),occurredAt:null,payload:{kind:'work_timing',version:'1',intervalId:id,owner:'work',runId:'root',pathId:id,stageId:id,attemptId:null,workId:null,purposeDigest:'task',phase:id,boundary,clock:{domain:'original-clock',monotonicMs:boundary==='started'?start:end},durationMs:boundary==='started'?null:end-start,outcome:boundary==='started'?null:'returned'}}));
      await r.flush();const selection={sourceId:r.source.sourceId,datasetId:r.manifest.datasetId};
      const scope={manifest:(await q.query({kind:'open_process_scope',recordings:[{...selection,via:null}]})).process.manifest,runIds:['root']};
      const first=(await q.query({kind:'advance_process_metrics',...scope,limit:7})).measurement;
      offer('after-watermark',{kind:'quantity',metric:'material_read',unit:'bytes',evidence:'actual',value:99999,upper:null,method:'logical-range',complete:true});await r.flush();
      writeFileSync(checkpoint,JSON.stringify({scope,cursor:first.cursor,selection}));await q.close();process.exit(73);`,73);
    const output=launch(`const {scope,cursor:original,selection}=JSON.parse(readFileSync(checkpoint,'utf8')),q=new InspectionQueryService(root);
      const native=()=>{const db=new InspectionDatabase(datasetDirectory(root,selection.sourceId,selection.datasetId));try{return {snapshot:db.snapshot(),records:db.records({watermark:db.snapshot().watermark})};}finally{db.close();}};
      const before=native();let cursor=original,result,calls=0;const overhead=[];
      do{result=(await q.query({kind:'advance_process_metrics',...scope,cursor,limit:31})).measurement;cursor=result.cursor;overhead.push(result.overhead);assert(++calls<100);}while(!['complete','limited'].includes(result.status));
      assert.equal(result.status,'complete');assert.equal(result.scanned,272);const metrics=[];let after;
      do{const page=(await q.query({kind:'read_process_metrics',...scope,cursor,section:'metrics',limit:100,...(after?{after}:{})})).measurement;metrics.push(...page.metrics);after=page.next;}while(after);
      assert.equal(metrics.find(m=>m.metric==='material_read').value,514);assert.equal(metrics.find(m=>m.metric==='physical_attempts').value,2);
      assert.equal(metrics.find(m=>m.metric==='input_tokens').value,null);assert.equal(metrics.find(m=>m.metric==='input_tokens').knownValue,100);
      assert.equal(metrics.find(m=>m.metric==='observed_interval_union'&&!m.dimensions.runId).value,150);assert.equal(metrics.find(m=>m.metric==='amount').value,null);
      assert.deepEqual(native(),before);await q.query({kind:'release_process_metrics',...scope,cursor});await q.close();
      process.stdout.write(JSON.stringify({electron:process.versions.electron??null,node:process.versions.node,scanned:result.scanned,identities:result.identities,calls,overhead,crossProcessResume:true,originalRecordsUnchanged:true,lateWriteExcluded:true,duplicateAttemptCount:1,physicalAttempts:2,unionMs:150,unknownUsageAndPrice:true}));`);
    console.log(output);
  }
}finally{rmSync(directory,{recursive:true,force:true});}
