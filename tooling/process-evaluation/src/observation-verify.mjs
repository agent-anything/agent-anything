import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import assert from "node:assert/strict";
import {processPlan,runDesktopProcessTrial} from "./process-runner.mjs";
const root=await mkdtemp(join(tmpdir(),"helarc-observation-isolation-"));console.log(root);
for(const mode of ["enabled","disabled","metadata"]){
  const directory=join(root,mode),settings={enabled:mode!=="disabled",definition:mode!=="metadata",agent:mode!=="metadata",provider:mode!=="metadata",execution:mode!=="metadata"};
  const plan=processPlan(`observation-${mode}`,{inspectionSettings:settings});
  const interrupted=await runDesktopProcessTrial({directory,plan,interruptAfterEffect:true});
  assert.equal(interrupted.report.execution,"interrupted",JSON.stringify(interrupted.report.failures));
  const resumed=await runDesktopProcessTrial({directory,plan});
  assert.equal(resumed.report.execution,"completed",JSON.stringify(resumed.report.failures));assert.equal(resumed.report.cleanup.status,"cleaned");
  const capture=JSON.parse(await readFile(join(directory,resumed.report.capture.ref.id.replace(":","-")+".json"),"utf8"));
  assert.equal(capture.effects.bytes,"x");assert.equal(capture.requests.length,2,"No repeated accepted command after recovery");
  assert(capture.execution.members.every(m=>m.status==="completed"));
  if(mode==="disabled"){
    assert(capture.inspections.every(i=>i.records.length===0));
    assert.equal(resumed.report.capture.sources.find(s=>s.owner==="inspector").reason,"recording_disabled");
    assert.equal(resumed.report.conclusions.find(c=>c.claim==="effect_once").verdict,"conforms");
  }else{
    assert(capture.inspections.every(i=>i.records.length>0));
    if(mode==="metadata"){
      const contents=capture.inspections.flatMap(i=>i.records.flatMap(r=>r.contents));assert(contents.length>0);
      assert(contents.every(c=>c.availability==="not_captured"),"Content policy is independent of structural facts");
    }
  }
  const requests=await readFile(join(directory,"provider-requests.jsonl"),"utf8");
  const repeated=await runDesktopProcessTrial({directory,plan});assert.equal(repeated.report.execution,"completed");
  assert.equal(await readFile(join(directory,"provider-requests.jsonl"),"utf8"),requests);
  console.log(JSON.stringify({mode,execution:resumed.report.execution,effects:capture.effects,requests:capture.requests.length,
    inspector:resumed.report.capture.sources.find(s=>s.owner==="inspector")}));
}
console.log(JSON.stringify({status:"passed",root,checks:["observation policy cannot govern recovery","recording disabled is not complete observation","metadata and payload capture are distinct","completed report read does not execute"]}));
