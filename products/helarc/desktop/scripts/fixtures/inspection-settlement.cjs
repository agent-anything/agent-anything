const assert=require("node:assert/strict");

// flush() bounds one wait, not the lifetime of a bulk replay. Verify durable progress
// before freezing the investigation snapshot; a pending barrier is not completion.
exports.settleInspection=async function(recorder,queries) {
  const started=performance.now(),samples=[];
  let lastProgress="",progressAt=started,accepted;
  while(performance.now()-started<60000) {
    const result=await recorder.flush();
    accepted??=result.barrier.accepted;
    assert.equal(result.barrier.accepted,accepted,"Verification must not extend its capture boundary");
    const snapshot=await queries.query({kind:"get_snapshot",sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId});
    const recording=snapshot.coverage.recording;
    const progress=JSON.stringify([recording.native.persisted,recording.native.duplicates,recording.native.rejected,recording.projection.cursor]);
    if(progress!==lastProgress){lastProgress=progress;progressAt=performance.now();}
    samples.push({elapsedMs:performance.now()-started,result,recording});
    assert.equal(recorder.health().rejected,0,JSON.stringify(samples));
    assert.equal(recorder.health().dropped,0,JSON.stringify(samples));
    assert(!["failed","unknown"].includes(result.native),JSON.stringify(samples));
    assert(!["failed","unknown"].includes(result.projection),JSON.stringify(samples));
    if(result.native==="settled"&&result.projection==="settled")return {selection:snapshot.selection,samples};
    assert(performance.now()-progressAt<15000,`Inspector progress stopped: ${JSON.stringify(samples)}`);
  }
  assert.fail(`Inspector replay did not settle within the verification budget: ${JSON.stringify(samples)}`);
};
