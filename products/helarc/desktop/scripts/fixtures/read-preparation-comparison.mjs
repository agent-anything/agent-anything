import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";

// The uncovered profile excludes in-request compaction, not an independently admitted background method.
export function checkBackgroundCompact(directory,root,wire){
  const db=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
  try{
    const decisions=db.prepare("SELECT value FROM context_foundation_facts WHERE run_id=? AND kind='decision_accepted'").all(root)
      .map(row=>JSON.parse(row.value).details.decision).filter(d=>d.foreground.kind==="continue"&&d.foreground.adoption==="keep"&&
        d.investment.kind==="propose"&&d.investment.reason==="opportunity"&&d.comparison?.chosenId===d.investment.optionId);
    const matches=[];
    for(const decision of decisions){
      const activity=decision.investment.optionId+":native-compact";
      const row=db.prepare("SELECT value FROM protocol_activities WHERE id=? AND run_id=?").get(activity,root);
      if(!row)continue;const state=JSON.parse(row.value);
      assert.equal(state.activity.scope.purpose.id,"context_compaction");
      const bytes=Buffer.concat(db.prepare("SELECT bytes FROM protocol_content_chunks WHERE id=? ORDER BY offset").all(state.input.id).map(r=>r.bytes));
      const prepared=JSON.parse(bytes).binding.prepared;
      if(wire.equals(Buffer.from(prepared.encoded)))matches.push({activity,decision:decision.id,input:prepared.digest});
    }
    assert.equal(matches.length,1,"background compact must match exactly one original admitted method and request");return matches[0];
  }finally{db.close();}
}

export function readAssessmentAdmissions(directory,{sourceId,datasetId,runId}){
  const db=new DatabaseSync(join(directory,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
  try{return db.prepare("SELECT b.bytes FROM contents c JOIN records r ON r.id=c.record_id JOIN bodies b ON b.id=c.body_id WHERE r.run_id=? AND json_extract(c.value,'$.name')='Auxiliary complete-input admission' AND json_extract(c.value,'$.availability')='present'")
    .all(runId).map(row=>JSON.parse(Buffer.from(row.bytes).toString())).filter(a=>a.scope.runId===runId&&a.scope.purpose.id==="context_compaction_assessment");
  }finally{db.close();}
}

/** Read the final process's own recording, never substitute a later dataset's flush. */
export function readPreparationComparison(directory,recording){
  const {sourceId,datasetId,runId}=recording;
  const execution=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
  const inspection=new DatabaseSync(join(directory,"inspection","sources",sourceId,"datasets",datasetId,"inspection.sqlite"),{readOnly:true});
  try{
    const facts=execution.prepare("SELECT value FROM context_foundation_facts WHERE run_id=? AND kind='decision_accepted' ORDER BY sequence").all(runId);
    const decision=facts.map(row=>JSON.parse(row.value).details.decision).find(d=>d.investment.reason==="necessary"&&d.comparison?.offers.length>1);
    assert(decision,"No accepted competitive method investment in the Parent scope");
    const event=inspection.prepare("SELECT r.value,c.value content,b.bytes FROM contents c JOIN records r ON r.id=c.record_id JOIN bodies b ON b.id=c.body_id WHERE r.run_id=? AND json_extract(c.value,'$.name')=?")
      .all(runId,"context.preparation_method_comparison").find(row=>{
        return JSON.parse(Buffer.from(row.bytes).toString()).chosenId===decision.comparison.chosenId;
      });
    assert(event,"Comparison content absent in the selected recording");
    assert.equal(JSON.parse(event.content).availability,"present");
    assert.deepEqual(JSON.parse(Buffer.from(event.bytes).toString()),decision.comparison);
    const observed=inspection.prepare("SELECT value FROM relations WHERE kind='observes' AND json_extract(value,'$.to.id')=?").all(decision.id+":comparison").map(r=>JSON.parse(r.value));
    for(const id of [decision.id,JSON.parse(event.value).subject.id])
      assert(observed.some(r=>r.from.id===id&&r.from.runId===runId&&r.to.runId===runId&&r.to.datasetId===datasetId));
    const comparison=JSON.parse(Buffer.from(event.bytes).toString());
    const chosen=comparison.offers.find(o=>o.optionId===comparison.chosenId);assert(chosen);
    return {sourceId,datasetId,decisionId:decision.id,candidates:comparison.offers.length,
      chosen:{optionId:chosen.optionId,family:chosen.family,scope:chosen.scope,minimum:chosen.minimum},
      basis:comparison.basis,steps:comparison.steps,extentComparable:comparison.extentComparable};
  }finally{execution.close();inspection.close();}
}
