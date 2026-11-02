import {test} from "node:test";
import assert from "node:assert/strict";
import {assessSubsequentUse,assessCapturedSubsequentUse} from "./comparison-assessment.mjs";
const expected={image5:3,image6:5,alpha:"preserved",version:"unverified"};
test("independent grader rejects a deliberate scope violation",()=>assert.equal(assessSubsequentUse(JSON.stringify({...expected,image5:5}),expected).verdict,"violated"));
test("independent grader accepts a legitimate different presentation",()=>assert.equal(assessSubsequentUse('```json\n'+JSON.stringify({explanation:"The correction applies only after image 5",version:"unverified",alpha:"preserved",image6:5,image5:3})+'\n```',expected).verdict,"conforms"));
test("missing or ambiguous evidence remains unknown, not negative",()=>{for(const text of [null,"Some answer",'{}'])assert.equal(assessSubsequentUse(text,expected).verdict,"insufficient_evidence");});
test("a known contradiction is not hidden by other missing fields",()=>assert.equal(assessSubsequentUse('{"version":"verified"}',expected).verdict,"violated"));
test("wrong shapes and undeclared prose are not inferred to be contradictory facts",()=>{
  for(const text of ['null','[]','{"image5":{"radius":null},"image6":null,"alpha":"not found in evidence","version":"not found in evidence"}'])
    assert.equal(assessSubsequentUse(text,expected).verdict,"insufficient_evidence");
  assert.equal(assessSubsequentUse('{"image5":null,"version":"verified"}',expected).verdict,"violated");
});
test("reassessment uses original capture and case facts, not an earlier grade",()=>{
  const plan={trial:{caseRef:{id:"scoped-correction"}}};
  const evidence={taskOutput:{summary:JSON.stringify(expected)},conclusions:[{verdict:"violated"}]};
  assert.equal(assessCapturedSubsequentUse(evidence,plan).verdict,"conforms");
  assert.equal(assessCapturedSubsequentUse(evidence,{trial:{caseRef:{id:"scoped-correction-heldout"}}}).verdict,"violated");
  assert.equal(evidence.conclusions[0].verdict,"violated");
});
