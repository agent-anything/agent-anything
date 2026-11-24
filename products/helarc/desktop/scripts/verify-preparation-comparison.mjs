import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {decideContextPreparation,contextPreparationDecisionEvidence} from "@agent-anything/agent-runtime/context-representation";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {unpackExecutionContent} from "../dist/main/execution-storage/ExecutionContent.js";

// Accept the recorded decision's identity, never a row ordinal or a newly simulated input.
const [file,id]=process.argv.slice(2);assert(file&&id,"Supply the isolated SQLite file and decision ID");
const db=new DatabaseSync(file,{readOnly:true});
try{
  const row=db.prepare("SELECT root,digest FROM context_policy_decisions WHERE id=?").get(id);assert(row);
  const block=db.prepare("SELECT id,value AS text FROM execution_content WHERE id=?");
  const record=unpackExecutionContent(JSON.parse(row.root),id=>block.get(id));
  assert.equal(digest(record),row.digest);assert.equal(record.decision.id,id);
  assert.deepEqual(decideContextPreparation(record.input,record.decision.policy.revision),record.decision);
  const {input}=record,d=decideContextPreparation(input),c=d.comparison;
  assert.equal(input.options.length,8);assert.equal(c.offers.length,8);assert.equal(d.investment.kind,"propose");
  assert.equal(c.chosenId,d.investment.optionId);assert.equal(c.basis,"bounded_exploration");
  assert.deepEqual(new Set(c.offers.map(o=>o.optionId)),new Set(input.options.map(o=>o.id)));
  assert(c.offers.every(o=>o.quotationId&&o.sources.length&&o.requirements.length&&o.unknown.length&&(o.cut||o.optionId===c.chosenId)));
  assert(c.offers.some(o=>o.costs.modelCalls.maximum===null));assert(c.offers.some(o=>o.costs.modelCalls.maximum===4));
  assert.deepEqual(decideContextPreparation({...input,options:input.options.toReversed()}).comparison,c);
  assert(contextPreparationDecisionEvidence({...record,decision:d},[]).related.some(r=>r.name==="context.preparation_method_comparison"&&digest(r.value)===digest(c)));
  for(const i of [1,2]){
    const ready={...input.current,inputId:"checked:"+i,bodyDigest:"body:"+i,exactInputDigest:"selected:"+i,judgmentId:"judgment:"+i,allowed:true,risks:[]};
    delete ready.capacity;
    const next=decideContextPreparation({...input,alternatives:[{input:ready,comparisons:[]}]});
    assert.equal(next.foreground.preparedInputId,ready.inputId);assert.notEqual(next.investment.kind,"propose");
  }
  console.log(JSON.stringify({old:record.decision.investment.optionId,new:c.chosenId,basis:c.basis,steps:c.steps,coverage:c.offers.length,priorDecision:id},null,2));
}finally{db.close();}
