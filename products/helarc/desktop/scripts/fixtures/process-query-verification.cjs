const assert=require("node:assert/strict");

// Independent original owner records are the oracle, not another Inspector view.
exports.verifyDecisionQuery=async function({queries,recorder,selection,original,inputId}) {
  const manifest=(await queries.query({kind:"open_process_scope",recordings:[{...selection,via:null}]})).process.manifest;
  const decision=original.decision,subject=recorder.ref("context-representation","contribution",decision.id,decision.scope.runId);
  const result=await queries.query({kind:"get_context_decision",manifest,section:"facts",subject});
  const evidence=result.process.entries.find(e=>e.record.payload.kind==="process_evidence");
  assert(evidence,"Original accepted decision must be reachable independently of any physical request");
  const publicDecision=evidence.record.payload;
  assert.deepEqual(publicDecision.recipient,{runId:decision.scope.runId,recipient:decision.scope.recipient,purpose:decision.scope.purpose});
  assert.equal(publicDecision.judgment.foreground,decision.foreground.kind);
  assert.equal(publicDecision.judgment.investment,decision.investment.kind);
  const descriptor=evidence.contents[publicDecision.judgment.detailsContentOrdinal].descriptor;
  const details=await queries.query({kind:"get_process_content",manifest,location:{sourceId:evidence.record.subject.sourceId,datasetId:evidence.record.subject.datasetId,recordId:evidence.record.id,contentId:descriptor.id}});
  const judgment=JSON.parse(details.content.text);assert.equal(judgment.version,"1");
  assert.deepEqual(judgment.excluded,decision.excluded);
  assert.deepEqual(judgment.limitations,decision.limitations);
  assert.deepEqual(judgment.reconsiderOn,decision.investment.kind==="defer"?decision.investment.reconsiderOn:[]);
  assert.equal(evidence.relationCoverage.observedOrdinals,evidence.relationCoverage.declared);
  assert.equal(evidence.relationCoverage.conflictingOrdinals,0);
  assert.equal(evidence.relationCoverage.unexpectedOrdinals,0);
  assert.equal(evidence.relationCoverage.inconsistentTotals,0);
  const q={kind:"get_context_decision",manifest,section:"relationships",evidence:evidence.identity,limit:7};
  let after,links=[];
  do{const page=(await queries.query({...q,...(after?{after}:{})})).process;links.push(...page.relationships);after=page.page.next;assert(links.length<=10000);}while(after);
  assert.equal(links.length,evidence.relationCoverage.declared);
  assert.equal(new Set(links.map(l=>l.ordinal)).size,links.length);
  if(inputId){
    const input=recorder.ref("model-input","contribution",inputId,decision.scope.runId);
    const actual=(await queries.query({kind:"get_actual_input",manifest,section:"facts",subject:input})).process;
    assert(actual.entries.some(e=>e.record.payload.kind==="execution"&&e.record.payload.executionKind==="prepared_model_input"&&e.record.contents.some(c=>c.stage==="encoded")),"Exact prepared input must remain addressable without implying it was sent");
  }
  return {decisionId:decision.id,recipient:publicDecision.recipient,relations:links.length,judgment:publicDecision.judgment};
};
