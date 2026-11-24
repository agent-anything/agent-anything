import assert from "node:assert/strict";
import {mkdtempSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {InspectionRecorder} from "@agent-anything/inspection/recording";
import {datasetDirectory} from "@agent-anything/inspection/sources";
import {nativePreparationRecords} from "../dist/main/inspection/HelarcNativeInputInspectionProjection.js";
import {readPreparationResult,checkPreparationRecording} from "./fixtures/preparation-recording.mjs";

const directory=process.argv[2];assert(directory,"Supply a retained refusal recovery directory");
const {proof}=JSON.parse(readFileSync(join(directory,"refusal-seed.json"),"utf8"));
const {runId}=proof.scope,exec=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
let stage,raw;
try{
  const rows=exec.prepare("SELECT s.id FROM activity_stages s JOIN activity_paths p ON p.id=s.path_id WHERE p.run_id=? AND json_extract(p.intent,'$.purpose.contract.ref.id')='helarc.native-result-reception' AND s.status='accepted'").all(runId);
  assert.equal(rows.length,1);stage=rows[0].id;raw=readPreparationResult(exec,stage);
}finally{exec.close();}
const stress=structuredClone(raw);stress.id="distinct:raw";
const p=stress.value.preparation;p.inputId="distinct:input";
p.exactInput.manifest.groups=Array.from({length:200},(_,n)=>({...p.exactInput.manifest.groups[0],
  representation:{id:`distinct:representation:${n}`,revision:"1"},holds:[`distinct:hold:${n}:a`,`distinct:hold:${n}:b`]}));
const root=mkdtempSync(join(tmpdir(),"helarc-preparation-projection-")),rec=await InspectionRecorder.create({
  root,application:"helarc-preparation-check",name:"Preparation recording",policy:{revision:"test",enabled:true,agent:true,provider:true,execution:true,definition:true}});
const samples=[[stage,raw],["distinct:stage",stress]];
try{
  for(const [s,result] of samples)for(const accepted of [false,true])for(const record of nativePreparationRecords(rec,runId,s,result,accepted))
    assert(await rec.offerWhenReady(record));
  // A subsequent import of the same durable observation must be idempotent.
  for(const record of nativePreparationRecords(rec,runId,stage,raw,false))assert(await rec.offerWhenReady(record));
}finally{await rec.flush(true);}
const db=new DatabaseSync(join(datasetDirectory(root,rec.source.sourceId,rec.manifest.datasetId),"inspection.sqlite"),{readOnly:true});
try{
  const groups=samples.map(([s,result])=>checkPreparationRecording(db,runId,result.value.preparation.inputId,
    actual=>{assert.equal(actual,s);return result.value.preparation;}));
  assert(groups[1].every(x=>x.relationships===601&&x.holds===400));
  const coverage=JSON.parse(db.prepare("SELECT coverage FROM dataset").get().coverage);
  assert.equal(coverage.dropped+coverage.rejected+coverage.recording.native.rejected,0);
  assert.equal(coverage.recording.native.duplicates,2+groups[0][0].relationships);
  console.log(JSON.stringify({root,groups,captured:coverage.captured,rejected:coverage.rejected,duplicates:coverage.recording.native.duplicates}));
}finally{db.close();}
