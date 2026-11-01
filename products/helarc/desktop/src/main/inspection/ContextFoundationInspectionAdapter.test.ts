import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {HelarcInspection} from "./HelarcInspection.js";
import {ContextFoundationInspectionAdapter} from "./ContextFoundationInspectionAdapter.js";

it("distinguishes inherited preservation evidence from a new combination check and delivery",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-inherited-check-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ContextFoundationInspectionAdapter(r);
    observer.observe({sequence:1,runId:"parent",owner:"representation",subject:"combination",kind:"judgment_recorded",occurredAt:"2026-10-31T00:00:00Z",
      details:{dependencies:{"inheritedJudgment:0":"original-check","inheritedProducer:0":"producer","inheritedJudgment:1":"second-check",
        "inheritedJudgment:2:1":"inner-check","relationshipSupport:0":"relationship-local-check","combinationProducer:1":"second-producer",stage:"combination-stage",rawResult:"new-raw"},
        coverage:[{materialId:"candidate",version:"1"}],subjects:[{id:"candidate",revision:"1"}]}});
    const materials=Array.from({length:64},(_,i)=>({materialId:`material:${i}:${"x".repeat(100)}`,version:`sha256:${"a".repeat(64)}`}));
    observer.observe({sequence:2,runId:"parent",owner:"representation",subject:"wide-check",kind:"judgment_recorded",occurredAt:"2026-10-31T00:00:00Z",
      details:{dependencies:{stage:"wide-stage"},coverage:materials,subjects:[]}});
    observer.observe({sequence:3,runId:"parent",owner:"context_input_supply",subject:"need",kind:"responsibility_registered",occurredAt:"2026-10-31T00:00:00Z",
      details:{needId:"need",consumerPathId:"task",sourceStageId:"task:source",acceptanceId:"atomic-acceptance",role:"method_reception",relation:"owned",target:{pathId:"receiver",owner:"context-representation",workId:"receiver-work"}}});
    observer.observe({sequence:4,runId:"parent",owner:"context_input_supply",subject:"receiver-duty",kind:"reception_transferred",occurredAt:"2026-10-31T00:00:00Z",
      details:{needId:"need",target:{pathId:"receiver"},coveredPathIds:["receiver","organization","check"],subscriptionId:"receiver:consumer",
        acceptanceId:"transfer-acceptance",closureAcceptanceId:"receiver-closed"}});
    observer.observe({sequence:5,runId:"parent",owner:"context_preparation_policy",subject:"resupply",kind:"decision_accepted",occurredAt:"2026-10-31T00:00:00Z",
      details:{decision:{foreground:{kind:"limited",reason:"input pending"},investment:{kind:"defer"}},
        methodSupplyReport:{offers:[],originalWork:[{workId:"original-work",pathId:"original-path",optionId:"original-option",available:true,reason:"original_scope_and_request_revalidated"},
          {workId:"unavailable-work",pathId:"unavailable-path",optionId:"unavailable-option",available:false,reason:"original_method_scope_changed"}]}}});
    observer.observe({sequence:6,runId:"parent",owner:"context_preparation_policy",subject:"joint-input",kind:"decision_accepted",occurredAt:"2026-11-01T00:00:00Z",
      details:{decision:{foreground:{kind:"limited"},investment:{kind:"prepare_input",optionId:"joint-reception"}},
        receptionSupplyReport:{complete:false,examined:1,conflicts:0,returned:[],restored:["joint-reception"]},
        receptionOptions:[{id:"joint-reception",members:[{pathId:"producer",workId:"work-a",requestDigest:"a"},{pathId:"second-producer",workId:"work-b",requestDigest:"b"}]}],
        inputReceptions:[{pathId:"prior-receiver",optionId:"prior-option",inputGap:{evidence:{owner:"activity",id:"original-gap",revision:"1"}}}]}});
    await r.flush();expect(r.health().rejected).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const flow=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("representation","contribution","combination","parent")});
    for(const [owner,id] of [["representation","original-check"],["representation","inner-check"],["representation","relationship-local-check"],["activity","producer"],["representation","second-check"],["activity","second-producer"],["activity","combination-stage"],["activity","new-raw"]])
      expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner,id})}));
    expect(flow.graph?.links.some(link=>link.kind==="delivers")).toBe(false);
    const wide=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("representation","contribution","wide-check","parent")});
    expect(wide.graph?.links.filter(link=>link.kind==="observes"&&link.to.owner==="material_custody")).toHaveLength(64);
    const supply=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("context_input_supply","contribution","need","parent")});
    for(const id of ["task","task:source","receiver","receiver-work","atomic-acceptance"])
      expect(supply.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id})}));
    expect(supply.graph?.links.some(link=>link.kind==="delivers")).toBe(false);
    const transfer=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("context_input_supply","contribution","receiver-duty","parent")});
    for(const id of ["receiver","organization","check"])
      expect(transfer.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner:"activity",id})}));
    for(const id of ["transfer-acceptance","receiver-closed"])
      expect(transfer.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner:"shared_acceptance",id})}));
    expect(transfer.graph?.links.filter(link=>link.kind==="delivers")).toEqual([
      expect.objectContaining({to:expect.objectContaining({owner:"activity",id:"receiver:consumer"})})]);
    expect(transfer.graph?.links.some(link=>link.to.owner==="shared-acceptance")).toBe(false);
    const resupply=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("context-representation","contribution","resupply","parent")});
    for(const [owner,id] of [["activity","original-path"],["activity-scheduling","original-work"],["activity","unavailable-path"],["activity-scheduling","unavailable-work"]])
      expect(resupply.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner,id})}));
    expect(resupply.graph?.links.some(link=>["delivers","produces"].includes(link.kind))).toBe(false);
    const reception=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("context-reception-option","contribution","joint-reception","parent")});
    for(const [owner,id] of [["activity","producer"],["activity","second-producer"],["activity-scheduling","work-a"],["activity-scheduling","work-b"]])
      expect(reception.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner,id})}));
    expect(reception.graph?.links.some(link=>["delivers","produces"].includes(link.kind))).toBe(false);
    const accepted=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("context-representation","contribution","joint-input","parent")});
    for(const id of ["prior-receiver","original-gap"])expect(accepted.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id})}));
    const events=await queries.query({kind:"list_records",...selection,runId:"parent",limit:500});
    const fact=events.records.find(record=>record.payload.kind==="event"&&record.payload.name==="context_preparation_policy.decision_accepted"&&record.payload.sequence===6)!;
    const detail=await queries.query({kind:"get_subject",...selection,subject:fact.subject});
    expect(detail.records[0]?.payload).toMatchObject({name:"context_preparation_policy.decision_accepted",sequence:6});
    expect(detail.records[0]?.contents).toHaveLength(1);
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);
