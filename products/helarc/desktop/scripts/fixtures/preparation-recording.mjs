import assert from "node:assert/strict";
import {unpackExecutionContent} from "../../dist/main/execution-storage/ExecutionContent.js";

export function readPreparationResult(exec,stageId){
  const row=exec.prepare("SELECT raw.value FROM activity_stages s JOIN activity_raw_results raw ON raw.id=s.result_id WHERE s.id=?").get(stageId);
  assert(row,"Missing durable stage result");
  const block=exec.prepare("SELECT value FROM execution_content WHERE id=?");
  return unpackExecutionContent(JSON.parse(row.value),id=>({id,text:block.get(id).value}));
}

export function checkPreparationRecording(db,runId,inputId,expected){
  const records=db.prepare("SELECT value FROM records WHERE run_id=? AND json_extract(value,'$.subject.id')=? AND json_extract(value,'$.payload.executionKind')='native_input_preparation'")
    .all(runId,inputId).map(x=>JSON.parse(x.value));
  assert.deepEqual(records.map(r=>r.payload.status).sort(),["preparation_accepted","preparation_observed"]);
  return records.map(record=>{
    const details=db.prepare("SELECT c.value,b.bytes FROM contents c JOIN bodies b ON b.id=c.body_id WHERE c.record_id=?").all(record.id);
    const detail=new Map(details.map(d=>{const v=JSON.parse(d.value);assert(!v.truncated&&v.availability==="present");return [v.stage,Buffer.from(d.bytes).toString()];}));
    assert.deepEqual([...detail.keys()].sort(),["capacity","encoded","source"]);
    const groupRefs=g=>[g.representation.id,g.representation.revision,g.holds];
    const groups=JSON.parse(detail.get("source")).manifest.groups;
    const head=db.prepare("SELECT value FROM records WHERE kind='process_evidence' AND json_extract(value,'$.payload.origin.id')=?").get(record.id);
    assert(head);const basis=JSON.parse(head.value);
    assert.equal(basis.payload.subject.id,inputId);assert.equal(basis.payload.status,record.payload.status);
    const children=db.prepare("SELECT value FROM records WHERE kind='process_relationship' AND json_extract(value,'$.payload.evidence.origin.id')=? ORDER BY json_extract(value,'$.payload.ordinal')")
      .all(record.id).map(r=>JSON.parse(r.value));
    assert.equal(basis.payload.relationCount,children.length);
    children.forEach((c,n)=>{assert.equal(c.payload.ordinal,n);assert.equal(c.payload.total,children.length);
      assert.deepEqual(c.payload.evidence,{origin:basis.payload.origin,digest:basis.payload.digest});assert.equal(c.links.length,1);});
    const links=children.map(c=>c.links[0]),stages=links.filter(l=>l.kind==="produces"&&l.to.id===inputId);
    assert.equal(stages.length,1);
    const preparation=expected(stages[0].from.id);
    assert.equal(preparation.inputId,inputId);assert.equal(detail.get("encoded"),preparation.encoded.body);
    assert.deepEqual(groups.map(groupRefs),preparation.exactInput.manifest.groups.map(groupRefs));
    const repr=[...new Set(groups.map(g=>JSON.stringify([g.representation.id,g.representation.revision])))].sort();
    const holds=[...new Set(groups.flatMap(g=>g.holds))].sort();
    assert.deepEqual(links.filter(l=>l.kind==="includes"&&l.from.id===inputId).map(l=>l.to.id).sort(),repr);
    assert.deepEqual(links.filter(l=>l.kind==="binding"&&l.to.id===inputId).map(l=>l.from.id).sort(),holds);
    assert.equal(children.length,1+repr.length+holds.length);
    return {status:record.payload.status,groups:groups.length,relationships:children.length,holds:holds.length};
  });
}
