const assert=require("node:assert/strict");

module.exports=async function({queries,recorder,runIds,replay,methodTotals=[]}){
  const selection={sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId};
  const sample=async()=>{
    await require("./inspection-settlement.cjs").settleInspection(recorder,queries);
    const manifest=(await queries.query({kind:"open_process_scope",recordings:[{...selection,via:null}]})).process.manifest;
    const scope={manifest,runIds},durations=[];let cursor,result,steps=0;
    do{result=(await queries.query({kind:"advance_process_metrics",...scope,...(cursor?{cursor}:{}),limit:100})).measurement;
      cursor=result.cursor;durations.push(result.overhead.totalMs);assert(++steps<2000);
    }while(!["complete","limited"].includes(result.status));
    assert.equal(result.status,"complete");const metrics=[];let after;
    do{const page=(await queries.query({kind:"read_process_metrics",...scope,cursor,section:"metrics",limit:100,...(after?{after}:{})})).measurement;
      metrics.push(...page.metrics);after=page.next;
    }while(after);
    assert(metrics.some(m=>m.metric==="capacity"));assert(metrics.some(m=>m.metric==="closed_responsibilities"));
    assert(metrics.every(m=>m.conflicts===0),JSON.stringify(metrics.filter(m=>m.conflicts)));
    for(const expected of methodTotals)for(const [name,value] of [["material_read",expected.readBytes],["material_stored",expected.storedBytes]]){
      const measured=metrics.filter(m=>m.metric===name&&m.dimensions.target===expected.pathId);
      assert.equal(measured.length,1);assert.equal(measured[0].value,value,"Stage deltas must equal the independent retained final method counter");
    }
    const member=(await queries.query({kind:"read_process_metrics",...scope,cursor,section:"members",metricId:metrics[0].id,limit:1})).measurement.members[0];assert(member);
    const evidence=(await queries.query({kind:"read_process_metrics",...scope,cursor,section:"evidence",identity:member.identity,limit:1})).measurement.evidence[0];assert(evidence);
    await queries.query({kind:"release_process_metrics",...scope,cursor});
    return {metrics:metrics.sort((a,b)=>a.id.localeCompare(b.id)),scanned:result.scanned,identities:result.identities,steps,maxQueryMs:Math.max(...durations),limitations:result.limitations};
  };
  const first=await sample();await replay();const repeated=await sample();
  assert.deepEqual(repeated.metrics,first.metrics,"Replaying retained owner facts must not repeat physical costs or change accepted responsibility states");
  assert.equal(repeated.identities,first.identities);
  return {runIds,scanned:first.scanned,replayedScanned:repeated.scanned,identities:first.identities,metrics:first.metrics.length,
    stages:first.steps+repeated.steps,methodCountersVerified:methodTotals.length,maxQueryMs:Math.max(first.maxQueryMs,repeated.maxQueryMs),replayMetricsIdentical:true,originalEvidenceAddressable:true,limitations:first.limitations};
};
