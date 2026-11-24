import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";

export function checkBeforeUseRecording(directory,{sourceId,datasetId,runId},accepted,wire,{members=2,responseId="resp_5"}={}){
  const db=new DatabaseSync(join(directory,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
  const execution=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
  try{
    const contents=name=>db.prepare("SELECT b.bytes FROM records r JOIN contents c ON c.record_id=r.id JOIN bodies b ON b.id=c.body_id WHERE r.run_id=? AND json_extract(c.value,'$.name')=? AND json_extract(c.value,'$.availability')='present'").all(runId,name).map(row=>Buffer.from(row.bytes).toString());
    const admissions=contents("context.method_use_admission").map(s=>JSON.parse(s).value);
    const decisions=execution.prepare("SELECT value FROM context_foundation_facts WHERE run_id=? AND kind='decision_accepted' ORDER BY sequence")
      .all(runId).map(row=>JSON.parse(row.value).details);
    const pressured=decisions.find(v=>v.observationReport?.growth?.length&&(!accepted||
      v.decision.investment.kind==="prepare_input"&&v.methodSupplyReport.admissionEvidence.some(a=>a.id===accepted.eligibilityId)));
    assert(pressured,"No supported growth scenario in this Parent's own measurements");
    const growth=pressured.observationReport.growth.find(g=>g.current+g.reserved<=g.maximum&&g.projectedNext>g.maximum);
    assert(growth);
    const admission=pressured.methodSupplyReport.admissionEvidence.find(a=>a.value?.use?.enabled);
    assert(admission);assert.equal(admission.accepted,Boolean(accepted));
    if(accepted){assert.equal(pressured.decision.investment.kind,"prepare_input");assert.equal(admission.id,accepted.eligibilityId);}
    const reasons=admissions.filter(e=>e.id===admission.id);
    assert(reasons.length,"No Parent method admission in restored Inspector recording");
    for(const e of reasons){
      assert.equal(e.allowed,Boolean(accepted));assert(e.content.includes("function_calls"));assert(e.use.enabled);
      if(accepted){assert.equal(e.profileId,"controlled-calibration");assert.deepEqual(e.reasons,[]);}
      else assert.deepEqual(e.reasons,["joint_use_profile_unavailable"]);
      assert.deepEqual(e,admission.value);
      assert(db.prepare("SELECT 1 FROM relations WHERE kind='observes' AND json_extract(value,'$.to.id')=? AND json_extract(value,'$.from.runId')=? AND json_extract(value,'$.from.id')=? LIMIT 1").get(e.id,runId,pressured.decision.id));
    }
    const bodies=contents("Prepared native request (not dispatch)").map(JSON.parse);
    const {context_management,...original}=wire;
    assert(bodies.some(body=>{try{assert.deepEqual(body,original);return true;}catch{return false;}}),"Original Parent input differs beyond context_management");
    let adoptionId=null;
    if(accepted){
      const registry=new DatabaseSync(join(directory,"provider-registry","registry.sqlite"),{readOnly:true});
      try{
        const expected=registry.prepare("SELECT sequence,kind,subject_id AS subjectId,occurred_at AS occurredAt FROM events ORDER BY sequence").all().map(row=>({...row}));
        const recorded=db.prepare("SELECT b.bytes FROM contents c JOIN bodies b ON b.id=c.body_id WHERE json_extract(c.value,'$.name')='Durable connection custody'").all()
          .map(row=>JSON.parse(Buffer.from(row.bytes).toString())).map(({sequence,kind,subjectId,occurredAt})=>({sequence,kind,subjectId,occurredAt})).sort((a,b)=>a.sequence-b.sequence);
        assert(expected.length);assert.deepEqual(recorded,expected);
        const ranges=db.prepare("SELECT run_id,value FROM records WHERE json_extract(value,'$.payload.name')='inspection.history_range'").all();
        assert.equal(new Set(ranges.map(row=>row.run_id)).size,members);
        for(const row of ranges)assert.equal(JSON.parse(row.value).payload.code,null);
        assert.equal(ranges.length,4*members);
      }finally{registry.close();}
      const reception=contents("Original method-use policy and reception (not dispatch or conversion)").map(JSON.parse).find(v=>v.agreement?.id===accepted.agreementId);
      assert(reception);assert.equal(reception.actualConversionObserved,false);assert.equal(reception.eligibility.id,accepted.eligibilityId);
      assert.equal(reception.agreement.requestDigest,accepted.wire);
      const adoption=decisions.find(v=>v.acceptanceId===accepted.acceptance&&v.decision.foreground.preparedInputId===accepted.inputId);
      assert(adoption);assert.equal(adoption.decision.foreground.adoption,"propose");
      assert(adoption.decision.evidence.some(e=>e.id===admission.id));
      adoptionId=adoption.decision.id;
      for(const to of [accepted.inputId,accepted.acceptance,admission.id]){
        assert(db.prepare("SELECT 1 FROM relations WHERE kind='observes' AND json_extract(value,'$.to.id')=? AND json_extract(value,'$.from.runId')=? AND json_extract(value,'$.from.id')=? LIMIT 1").get(to,runId,adoptionId),"Inspector lacks adoption link to "+to);
      }
      assert(db.prepare("SELECT 1 FROM relations WHERE kind='binding' AND json_extract(value,'$.from.id')=? AND json_extract(value,'$.to.runId')=? AND json_extract(value,'$.to.owner')='protocol-execution' LIMIT 1").get(accepted.inputId,runId));
      const path=pressured.decision.investment.optionId;
      const attempts=execution.prepare("SELECT s.status,a.id FROM activity_stages s LEFT JOIN activity_attempts a ON a.request_id=s.id WHERE s.path_id=?").all(path);
      assert.equal(attempts.length,1);assert(attempts[0].id);assert.equal(attempts[0].status,"accepted");
      const observed=contents("Observed in-request compaction item").map(JSON.parse).find(item=>item.id==="cmp_before_use"&&item.responseId===responseId);
      assert(observed);assert.equal(observed.actualConversionObserved,true);assert.equal(observed.internalSourceCoverage,"unknown");
      assert.equal(observed.semanticPreservation,"not_established_by_observation");
    }
    return {sourceId,datasetId,runId,admissions:[...new Set(reasons.map(e=>e.id))],profile:reasons[0].profileId,reasons:reasons[0].reasons,
      threshold:reasons[0].trigger?.tokens,decision:pressured.decision.id,adoptionId,current:growth.current,reserved:growth.reserved,projected:growth.projectedNext,window:growth.maximum,originalMatches:true};
  }finally{execution.close();db.close();}
}
