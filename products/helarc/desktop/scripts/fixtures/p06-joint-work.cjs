const assert=require("node:assert/strict");
const {join}=require("node:path"),{readFileSync}=require("node:fs"),{DatabaseSync}=require("node:sqlite");

// Only the list of original work identities is obtained from execution storage.
// Costs, dependencies and both boundaries are read back through public Inspector queries.
module.exports=async function audit(source){
  const json=name=>JSON.parse(readFileSync(join(source,name+".json"))),{phases,passed}=json("result");
  assert(passed);const last=phases.at(-1),root=last.recording.runId,bg=json("background-compact-received");
  const authority=new DatabaseSync(join(source,"execution","execution.sqlite"),{readOnly:true});
  let activities;try{activities=authority.prepare("SELECT id,run_id AS runId,json_extract(value,'$.activity.scope.purpose.id') AS purpose FROM protocol_activities").all();}
  finally{authority.close();}
  const child=activities.find(x=>x.runId!==root).runId;
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),q=new InspectionQueryService(join(source,"inspection"));
  const samples=[],coverage=[],childDependencies=[],io={metadata:0,detail:0,loaded:0,returned:0};
  try{
    for(const r of [json("work-first-recording"),last.recording]){
      const s=await q.query({kind:"get_snapshot",sourceId:r.sourceId,datasetId:r.datasetId});
      const read=async(input)=>{const v=await q.query({...s.selection,...input}),w=v.readWork;
        if(input.kind==="get_content"){io.detail++;io.loaded+=w.loadedBodyBytes;io.returned+=w.returnedBodyBytes;}
        else{io.metadata++;assert.equal(w.bodyReads,0);}
        return v;};
      assert.equal(s.coverage.rejected,0);assert.equal(s.coverage.dropped,0);
      coverage.push({selection:s.selection,status:s.coverage.status,projection:s.coverage.recording.projection.status,
        rejected:s.coverage.rejected,dropped:s.coverage.dropped});
      for(const a of activities){
        const subject={...r,owner:"protocol-execution",kind:"model-activity",id:a.id,runId:a.runId};
        const graph=(await read({kind:"get_data_flow",subject})).graph;
        const timings=new Map(graph.links.filter(l=>l.kind==="observes"&&l.from.owner==="work-timing"&&l.to.id===a.id).map(l=>[l.from.id,l.from]));
        for(const [id,subject] of timings){
          const start=(await read({kind:"get_record",recordId:"work-timing:"+id+":started"})).records[0];assert(start);
          const latest=(await read({kind:"get_subject",subject})).records[0],desc=latest.contents[0];
          assert.equal(desc.availability,"present");assert(!desc.truncated&&desc.originalBytes<=65536);
          const detail=JSON.parse((await read({kind:"get_content",contentId:desc.id,offset:0,length:desc.retainedBytes})).content.text);
          assert.equal(detail.work.id,a.id);assert.equal(detail.invocation,id);assert.equal(detail.work.runId,a.runId);
          assert.equal(detail.generation,r.datasetId===last.recording.datasetId?last.generation:phases[0].generation);
          if(detail.awaited){const g=(await read({kind:"get_dependencies",subject})).graph;
            assert(g.links.some(l=>l.from.id===detail.awaited.id&&l.to.id===id&&l.condition==="settled"));}
          samples.push({...detail,purpose:a.purpose,datasetId:r.datasetId});
        }
      }
      const g=(await read({kind:"get_execution",subject:{...r,id:child,runId:child}})).graph;
      for(const l of g.links.filter(l=>l.kind==="binding"&&l.from.id===child&&l.to.owner==="runtime")){
        const deps=(await read({kind:"get_dependencies",subject:l.to})).graph.links;
        for(const d of deps.filter(d=>d.operation==="required_child_boundary")){
          const rs=(await read({kind:"list_records",subject:d.to,limit:100})).records;
          assert(rs.some(x=>x.payload.name==="delegation.required_boundary"&&x.payload.code==="opened"));
          assert(rs.some(x=>x.payload.name==="delegation.required_boundary"&&x.payload.code==="resolved"));
          childDependencies.push({child,boundary:l.to.id,branch:d.to.id,condition:d.condition});}
      }
    }
  }finally{await q.close();}
  const headers=samples.filter(s=>s.phase==="http_headers"),task=samples.filter(s=>s.purpose==="helarc.code-agent.turn");
  const count=(xs,field)=>Object.fromEntries([...new Set(xs.map(x=>x[field]))].map(k=>[k,xs.filter(x=>x[field]===k).length]));
  const byPurpose=count(headers,"purpose"),posts=json("requests"),measures=json("measurements");
  assert.equal(byPurpose["helarc.code-agent.turn"],posts.length);assert.equal(byPurpose.context_input_measurement,measures.length);
  assert.equal(byPurpose.context_compaction,1);assert.equal(new Set(headers.map(s=>s.work.id)).size,headers.length);
  assert(headers.every(s=>s.awaited?.owner==="provider-transport"));assert(childDependencies.length);
  assert.equal(task.filter(s=>s.phase==="observation_receipt"&&s.awaited?.owner==="activity"&&s.boundary==="returned").length,posts.length);
  assert.equal(task.filter(s=>s.phase==="commit_observation"&&s.boundary==="returned").length,posts.length);
  const background=samples.filter(s=>s.work.id===bg.activity);assert(background.some(s=>s.phase==="http_headers"&&s.boundary==="threw"));
  assert(background.some(s=>s.phase==="carrier_cleanup"&&s.boundary==="returned"));
  assert(task.every(s=>s.awaited?.id!==bg.activity));assert.equal(bg.decision,last.beforeUse.decision);
  const stages=samples.flatMap(s=>s.stages);assert(stages.some(x=>x.phase==="storage.host.queue"&&x.finished>0));
  assert(stages.some(x=>x.phase.startsWith("storage.worker.")&&x.finished>0));
  assert(stages.some(x=>x.phase==="storage.host.request"&&x.finished>0));
  assert.equal(last.physicalWriteAttempts,1);
  const compactWait=background.find(s=>s.phase==="http_headers"),lastForeground=task.filter(s=>s.phase==="observation_receipt"&&
    s.work.runId===root&&s.generation===compactWait.generation&&s.clock.clockDomain===compactWait.clock.clockDomain)
    .sort((a,b)=>b.clock.monotonicMs-a.clock.monotonicMs)[0];
  const measuredOverlap=lastForeground?Math.max(0,Math.min(compactWait.clock.monotonicMs,lastForeground.clock.monotonicMs)
    -Math.max(compactWait.clock.monotonicMs-compactWait.durationMs,lastForeground.clock.monotonicMs-lastForeground.durationMs)):null;
  return {source,root,child,coverage,childDependencies:[...new Map(childDependencies.map(d=>[JSON.stringify(d),d])).values()],io,generations:phases.map(p=>p.generation),byPurpose,
    lastParentReceiptAndCompactHTTPOverlapMs:measuredOverlap,
    unknownClockStages:[...new Set(stages.filter(s=>s.domain==="unavailable").map(s=>s.phase))],
    beforeUseDecision:bg.decision,physicalWriteAttempts:last.physicalWriteAttempts,phases:count(samples,"phase"),
    unknown:["remote CPU and cost","no remote compact result","no timing where a boundary was not captured"],samples};
};
