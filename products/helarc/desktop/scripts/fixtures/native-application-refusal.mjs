import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {join} from "node:path";
import ordinary from "./native-application-ordinary.cjs";
import {checkPreparationRecording,readPreparationResult} from "./preparation-recording.mjs";

export function verifyReplacementFindings(items){
  const calls=items.filter(i=>i.type==="function_call"),outputs=items.filter(i=>i.type==="function_call_output");
  assert.deepEqual(calls.map(c=>c.name.split("_")[0]),["Write","Agent"]);
  assert.deepEqual(outputs.map(o=>o.call_id),calls.map(c=>c.call_id));
  assert.equal(JSON.parse(outputs[0].output).settlement,"succeeded");
  const report=JSON.parse(outputs[1].output).result.output.summary;
  assert(report.includes("7391")&&report.includes("unverified")&&report.includes("no changes"));
  assert(report===ordinary.report||report.includes("60"),"Repetition count lost in the replacement");
}

export function checkRefusalRecovery({directory,seed,resume,requests,wireHashes,refused}){
  const {sourceId,datasetId,runId}=resume.recording;
  const exec=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
  const inspector=new DatabaseSync(join(directory,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
  try{
    const {evidence,proof}=seed;
    assert.equal(runId,proof.scope.runId);assert.notEqual(seed.pid,resume.pid);assert(resume.generation>seed.generation);
    const states=exec.prepare("SELECT value FROM protocol_activities WHERE run_id=?").all(runId).map(r=>JSON.parse(r.value));
    const original=states.find(s=>s.activity.scope.activityId===evidence.activityId);assert(original);
    assert.deepEqual(original.inputRefusal,evidence);assert(!original.accepted);
    assert.deepEqual(original.input,proof.originalInput);
    const body=ref=>JSON.parse(Buffer.concat(exec.prepare("SELECT bytes FROM protocol_content_chunks WHERE id=? ORDER BY offset").all(ref.id).map(r=>Buffer.from(r.bytes))).toString());
    const wire=state=>body(state.input).wire.body;
    const sha=text=>createHash("sha256").update(text).digest("hex");
    assert.equal(wireHashes.filter(h=>h===sha(wire(original))).length,1);
    assert.equal(refused.length,1);assert.equal(sha(wire(original)),refused[0].sha256);
    const observed=JSON.parse(exec.prepare("SELECT value FROM protocol_records WHERE activity_id=? AND id=? AND revision=?").get(evidence.activityId,proof.observation.id,proof.observation.revision).value);
    assert.equal(body(observed.content).error.code,"context_length_exceeded");
    const replacements=states.filter(s=>s.accepted&&s.contextInput&&s.contextInput.id!==evidence.inputId&&
      s.activity.scope.purpose.id===original.activity.scope.purpose.id&&sha(wire(s))===wireHashes.at(-1));
    assert.equal(replacements.length,1,"Expected one accepted task input matching the final Parent request");
    const [replacement]=replacements;
    assert.deepEqual(JSON.parse(wire(replacement)),requests.at(-1));
    assert.equal(proof.boundary,evidence.boundary);
    assert.deepEqual(replacement.activity.composition,original.activity.composition);
    assert.deepEqual(replacement.activity.conditions.authority,original.activity.conditions.authority);
    assert.equal(replacement.activity.scope.recipientId,original.activity.scope.recipientId);
    assert.deepEqual(replacement.activity.scope.purpose,original.activity.scope.purpose);
    assert(requests.every(r=>r.model==="controlled"&&r.context_management===undefined));
    assert.equal(requests.filter(r=>r.tools&&!JSON.stringify(r.input).includes("HOST_ROOT")&&JSON.stringify(r.input).includes("HOST_CHILD")).length,1);
    const rows=inspector.prepare("SELECT value FROM records WHERE run_id=? AND json_extract(value,'$.payload.name')='execution.input_refused'").all(runId);
    assert.equal(rows.length,1);const record=JSON.parse(rows[0].value);
    for(const id of [evidence.activityId,evidence.inputId,evidence.evidence.id])assert(record.links.some(l=>l.to.id===id||l.from.id===id));
    const edge=inspector.prepare("SELECT json_extract(value,'$.from.id') AS decision FROM relations WHERE kind='observes' AND json_extract(value,'$.to.id')=? AND json_extract(value,'$.from.runId')=?");
    const decisions=new Set(edge.all(evidence.inputId,runId).map(r=>r.decision));
    const proofDecisions=new Set(edge.all(evidence.evidence.id,runId).map(r=>r.decision));
    const linked=edge.all(replacement.contextInput.id,runId).find(r=>decisions.has(r.decision)&&proofDecisions.has(r.decision)&&r.decision.startsWith("context-decision:"));
    assert(linked,"No recorded preparation decision tied to refused input, proof and accepted replacement");
    const coverage=JSON.parse(inspector.prepare("SELECT coverage FROM dataset WHERE id=1").get().coverage);
    assert.equal(resume.inspection.native,"settled");
    assert.equal(resume.inspection.unpersisted+resume.inspection.unconfirmed,0);
    const preparations=checkPreparationRecording(inspector,runId,replacement.contextInput.id,id=>readPreparationResult(exec,id).value.preparation);
    return {original:evidence.inputId,refusedHttp:refused[0],replacement:replacement.contextInput.id,
      replacementSha256:wireHashes.at(-1),decision:linked.decision,refusalRecord:record.id,projection:resume.inspection.projection,
      preparations,captured:coverage.captured,dropped:coverage.dropped,rejected:coverage.rejected,issues:coverage.recording.ingress.issues,
      nativeRejected:coverage.recording.native.rejected,duplicates:coverage.recording.native.duplicates,history:coverage.recording.ingress.history};
  }finally{inspector.close();exec.close();}
}

export function assertRefusalCoverage(report){
  assert.equal(report.dropped,0,"Inspector dropped records");
  assert.equal(report.rejected,0,`Inspector rejected records: ${JSON.stringify(report.issues)}`);
  assert.equal(report.nativeRejected,0);
  assert.deepEqual(report.history,{started:2,confirmed:2,incomplete:0});
}
