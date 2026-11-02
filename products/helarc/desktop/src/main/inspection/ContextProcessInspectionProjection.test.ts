import {expect,it} from "vitest";
import {contextProcessObject as object,contextProcessRelationship as relation} from "@agent-anything/context/evidence";
import type {ContextFoundationFact} from "../execution-storage/ContextFoundationRecords.js";
import type {InspectionProjectionSink} from "./InspectionReplay.js";
import {recordContextProcessEvidence} from "./ContextProcessInspectionProjection.js";

function fixture(){
  const records:Parameters<InspectionProjectionSink["offer"]>[0][]=[];
  const sink:InspectionProjectionSink={ref:(owner,kind,id,runId=null,revision=null)=>({sourceId:"source",datasetId:"dataset",owner,kind,id,runId,revision}),
    offer:value=>{records.push(value);return true;}};
  const subject=object("material_custody","instance","child");
  const fact:ContextFoundationFact={sequence:2,owner:"material_custody",subject:subject.id,runId:"child",kind:"read",occurredAt:"2026-11-01T00:00:00Z",
    details:{instanceId:"must-not-infer-from-details"},evidence:{revision:"1",category:"material",subject,state:null,relationships:[],
      related:[{subject:object("material_custody","retained-hold","parent"),name:"material.access_basis",occurredAt:null,value:{basis:"original grant"}}]}};
  return {records,sink,fact};
}
it("records read evidence without overwriting the lifecycle of the material or its observed hold",()=>{
  const {records,sink,fact}=fixture();recordContextProcessEvidence(fact,sink);
  expect(records.every(record=>record.payload.kind!=="execution")).toBe(true);
  expect(records.some(record=>record.subject.id==="instance"||record.subject.id==="retained-hold")).toBe(false);
  expect(records.find(record=>record.payload.kind==="event"&&record.payload.name==="material.access_basis")?.occurredAt).toBeNull();
  expect(records.flatMap(record=>record.links??[])).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id:"retained-hold",runId:"parent"})}));
});
it("measures only declared reuse boundaries, without treating applicability or private data as consumption",()=>{
  const {records,sink,fact}=fixture();
  recordContextProcessEvidence({...fact,details:{reuse:{content:99}},evidence:{...fact.evidence!,reuse:{eligibility:1,basis:"checked_not_consumed"}}},sink);
  const quantities=records.filter(r=>r.payload.kind==="work_measurement");
  expect(quantities).toHaveLength(1);expect(quantities[0]?.payload).toMatchObject({data:{metric:"reuse_eligibility",value:1,method:"checked_not_consumed"}});
});
it("projects every explicitly supplied relation without truncating a wide evidence group",()=>{
  const {records,sink,fact}=fixture();
  const relationships=Array.from({length:180},(_,i)=>relation("observes",fact.evidence!.subject,object("material_custody",`material-${i}`,null,"version")));
  recordContextProcessEvidence({...fact,evidence:{...fact.evidence!,relationships}},sink);
  const links=records.flatMap(record=>record.links??[]).filter(link=>link.to.id.startsWith("material-"));
  expect(links).toHaveLength(180);expect(new Set(links.map(link=>link.to.id)).size).toBe(180);
  expect(links.every(link=>link.to.revision==="version")).toBe(true);
});
it("forwards owner judgment without classifying private details",()=>{
  const {records,sink,fact}=fixture();
  const judgment={foreground:"continue",investment:"defer",adoption:"keep",reason:"original_outcome_unknown",reconsiderOn:["original_resolved"],limitations:["unmeasured"],excluded:[{optionId:"option",reasons:["not_supported"]}]};
  recordContextProcessEvidence({...fact,details:{investment:"propose",reason:"must-not-be-parsed"},evidence:{...fact.evidence!,category:"decision",judgment}},sink);
  const item=records.find(r=>r.payload.kind==="process_evidence");
  expect(item?.payload.kind==="process_evidence"&&item.payload.judgment).toEqual({foreground:"continue",investment:"defer",adoption:"keep",detailsContentOrdinal:1});
  expect(item?.contents?.[1]?.value).toEqual({version:"1",...judgment});
});
it("keeps a wide public judgment in protected content rather than enlarging the structure header",()=>{
  const {records,sink,fact}=fixture();
  const judgment={foreground:"limited",investment:"defer",adoption:null,reason:"no_applicable_option",reconsiderOn:["evidence_changed"],limitations:[],excluded:Array.from({length:2000},(_,i)=>({optionId:"option-"+i,reasons:["cannot_use","unknown_boundary"]}))};
  recordContextProcessEvidence({...fact,evidence:{...fact.evidence!,category:"decision",judgment}},sink);
  const item=records.find(r=>r.payload.kind==="process_evidence")!;
  expect(Buffer.byteLength(JSON.stringify(item.payload))).toBeLessThan(2048);
  expect(Buffer.byteLength(JSON.stringify(item.contents?.[1]?.value))).toBeGreaterThan(65536);
  expect(item.contents?.[1]?.value).toEqual({version:"1",...judgment});
});
