import {test} from "node:test";
import assert from "node:assert/strict";
import {comparisonMetricScope} from "./comparison-metrics.mjs";
const recording=(id,previous=null)=>({selection:{sourceId:"source",datasetId:id,watermark:20,projectionRevision:"1"},
  records:previous?[{id:`link-${id}`,payload:{kind:"recording_link",target:{sourceId:"source",datasetId:previous}}}]:[]});
test("whole-trial metrics use explicit original recovery links and fixed watermarks",()=>{
  const result=comparisonMetricScope([recording("one"),recording("two","one"),recording("three","two")]);
  assert.deepEqual(result.recordings.map(r=>r.datasetId),["three","two","one"]);assert.deepEqual(result.limitations,[]);
  assert.equal(result.recordings[1].via.recordId,"link-three");assert(result.recordings.every(r=>r.watermark===20));
});
test("a same-source recording without an introducing fact is not silently merged",()=>{
  const result=comparisonMetricScope([recording("one"),recording("two")]);
  assert.equal(result.recordings.length,1);assert.deepEqual(result.limitations,["metric_recordings_not_linked:1"]);
});
test("missing original scopes and bounded manifests remain explicit",()=>{
  assert.deepEqual(comparisonMetricScope([recording("two","one")]).limitations,["metric_linked_recordings_unavailable:1"]);
  const result=comparisonMetricScope(Array.from({length:17},(_,i)=>recording(String(i),i?String(i-1):null)));
  assert.equal(result.recordings.length,16);assert(result.limitations.length>0);
  assert.equal(comparisonMetricScope([]).recordings.length,0);
});
