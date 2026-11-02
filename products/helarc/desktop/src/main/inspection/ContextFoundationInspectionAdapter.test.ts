import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {HelarcInspection} from "./HelarcInspection.js";
import {ContextFoundationInspectionAdapter} from "./ContextFoundationInspectionAdapter.js";
import {contextProcessObject as object,contextProcessRelationship as relation} from "@agent-anything/context/evidence";

it("distinguishes inherited preservation evidence from a new combination check and delivery",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-inherited-check-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=new ContextFoundationInspectionAdapter(r);
    observer.observe({sequence:1,runId:"parent",owner:"representation",subject:"combination",kind:"judgment_recorded",occurredAt:"2026-10-31T00:00:00Z",
      evidence:{revision:"1",category:"representation",subject:object("representation","combination","parent"),state:{phase:"settled",status:"judgment_recorded"},related:[],
        relationships:[["representation","original-check"],["representation","inner-check"],["representation","relationship-local-check"],["activity","producer"],["representation","second-check"],["activity","second-producer"],["activity","combination-stage"],["activity","new-raw"]].map(([owner,id])=>
          relation("observes",object("representation","combination","parent"),object(owner!,id!,"parent")))},
      details:{dependencies:{"inheritedJudgment:0":"original-check","inheritedProducer:0":"producer","inheritedJudgment:1":"second-check",
        "inheritedJudgment:2:1":"inner-check","relationshipSupport:0":"relationship-local-check","combinationProducer:1":"second-producer",stage:"combination-stage",rawResult:"new-raw"},
        coverage:[{materialId:"candidate",version:"1"}],subjects:[{id:"candidate",revision:"1"}]}});
    const materials=Array.from({length:64},(_,i)=>({materialId:`material:${i}:${"x".repeat(100)}`,version:`sha256:${"a".repeat(64)}`}));
    observer.observe({sequence:2,runId:"parent",owner:"representation",subject:"wide-check",kind:"judgment_recorded",occurredAt:"2026-10-31T00:00:00Z",
      evidence:{revision:"1",category:"representation",subject:object("representation","wide-check","parent"),state:{phase:"settled",status:"judgment_recorded"},related:[],
        relationships:materials.map(material=>relation("observes",object("representation","wide-check","parent"),object("material_custody",material.materialId,null,material.version)))},
      details:{dependencies:{stage:"wide-stage"},coverage:materials,subjects:[]}});
    observer.observe({sequence:3,runId:"parent",owner:"context_input_supply",subject:"need",kind:"responsibility_registered",occurredAt:"2026-10-31T00:00:00Z",
      evidence:{revision:"1",category:"responsibility",subject:object("context_input_supply","need","parent"),state:{phase:"pending",status:"responsibility_registered"},related:[],
        relationships:[...["task","task:source","receiver","receiver-work"].map(id=>relation("observes",object("context_input_supply","need","parent"),object("activity",id,"parent"))),
          relation("settles",object("shared_acceptance","atomic-acceptance","parent"),object("context_input_supply","need","parent"))]},
      details:{needId:"need",consumerPathId:"task",sourceStageId:"task:source",acceptanceId:"atomic-acceptance",role:"method_reception",relation:"owned",target:{pathId:"receiver",owner:"context-representation",workId:"receiver-work"}}});
    observer.observe({sequence:4,runId:"parent",owner:"context_input_supply",subject:"receiver-duty",kind:"reception_transferred",occurredAt:"2026-10-31T00:00:00Z",
      evidence:{revision:"1",category:"responsibility",subject:object("context_input_supply","receiver-duty","parent"),state:{phase:"settled",status:"reception_transferred"},related:[],
        relationships:[...["receiver","organization","check","receiver-closed"].map(id=>relation("observes",object("context_input_supply","receiver-duty","parent"),object("activity",id,"parent"))),
          relation("settles",object("shared_acceptance","transfer-acceptance","parent"),object("context_input_supply","receiver-duty","parent")),
          relation("delivers",object("context_input_supply","receiver-duty","parent"),object("activity","receiver:consumer","parent"),"consumer_responsibility_transfer")]},
      details:{needId:"need",target:{pathId:"receiver"},coveredPathIds:["receiver","organization","check"],subscriptionId:"receiver:consumer",
        acceptanceId:"transfer-acceptance",closureAcceptanceId:"receiver-closed"}});
    observer.observe({sequence:5,runId:"parent",owner:"context_preparation_policy",subject:"resupply",kind:"decision_accepted",occurredAt:"2026-10-31T00:00:00Z",
      evidence:{revision:"1",category:"decision",subject:object("context-representation","resupply","parent"),state:{phase:"settled",status:"decision_accepted"},related:[],
        relationships:[["activity","original-path"],["activity-scheduling","original-work"],["activity","unavailable-path"],["activity-scheduling","unavailable-work"]].map(([owner,id])=>
          relation("observes",object("context-representation","resupply","parent"),object(owner!,id!,"parent")))},
      details:{decision:{foreground:{kind:"limited",reason:"input pending"},investment:{kind:"defer"}},
        methodSupplyReport:{offers:[],originalWork:[{workId:"original-work",pathId:"original-path",optionId:"original-option",available:true,reason:"original_scope_and_request_revalidated"},
          {workId:"unavailable-work",pathId:"unavailable-path",optionId:"unavailable-option",available:false,reason:"original_method_scope_changed"}]}}});
    observer.observe({sequence:6,runId:"parent",owner:"context_preparation_policy",subject:"joint-input",kind:"decision_accepted",occurredAt:"2026-11-01T00:00:00Z",
      evidence:{revision:"1",category:"decision",subject:object("context-representation","joint-input","parent"),state:{phase:"settled",status:"decision_accepted"},
        related:[{subject:object("context-reception-option","joint-reception","parent"),name:"context.input_reception_option",occurredAt:null,value:{id:"joint-reception"}}],
        relationships:[relation("observes",object("context-representation","joint-input","parent"),object("context-reception-option","joint-reception","parent")),
          ...["prior-receiver","original-gap"].map(id=>relation("observes",object("context-representation","joint-input","parent"),object("activity",id,"parent"))),
          ...[["activity","producer"],["activity","second-producer"],["activity-scheduling","work-a"],["activity-scheduling","work-b"]].map(([owner,id])=>
            relation("observes",object("context-reception-option","joint-reception","parent"),object(owner!,id!,"parent")))]},
      details:{decision:{foreground:{kind:"limited"},investment:{kind:"prepare_input",optionId:"joint-reception"}},
        receptionSupplyReport:{complete:false,examined:1,conflicts:0,returned:[],restored:["joint-reception"]},
        receptionOptions:[{id:"joint-reception",members:[{pathId:"producer",workId:"work-a",requestDigest:"a"},{pathId:"second-producer",workId:"work-b",requestDigest:"b"}]}],
        inputReceptions:[{pathId:"private-path-must-not-be-projected",optionId:"private-option",inputGap:{evidence:{owner:"activity",id:"private-gap",revision:"1"}}}]}});
    await r.flush();expect(r.health().rejected).toBe(0);
    const selection=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const flow=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("representation","contribution","combination","parent")});
    for(const [owner,id] of [["representation","original-check"],["representation","inner-check"],["representation","relationship-local-check"],["activity","producer"],["representation","second-check"],["activity","second-producer"],["activity","combination-stage"],["activity","new-raw"]])
      expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner,id})}));
    expect(flow.graph?.links.some(link=>link.kind==="delivers")).toBe(false);
    const wide=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("representation","contribution","wide-check","parent")});
    expect(wide.graph?.links.filter(link=>link.kind==="observes"&&link.to.owner==="material_custody")).toHaveLength(64);
    const supply=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("context_input_supply","contribution","need","parent")});
    for(const id of ["task","task:source","receiver","receiver-work"])
      expect(supply.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({id})}));
    const supplyExecution=await queries.query({kind:"get_execution",...selection,subject:r.ref("context_input_supply","contribution","need","parent")});
    expect(supplyExecution.graph?.links).toContainEqual(expect.objectContaining({kind:"settles",from:expect.objectContaining({owner:"shared_acceptance",id:"atomic-acceptance"})}));
    expect(supply.graph?.links.some(link=>link.kind==="delivers")).toBe(false);
    const transfer=await queries.query({kind:"get_data_flow",...selection,subject:r.ref("context_input_supply","contribution","receiver-duty","parent")});
    for(const id of ["receiver","organization","check","receiver-closed"])
      expect(transfer.graph?.links).toContainEqual(expect.objectContaining({kind:"observes",to:expect.objectContaining({owner:"activity",id})}));
    const transferExecution=await queries.query({kind:"get_execution",...selection,subject:r.ref("context_input_supply","contribution","receiver-duty","parent")});
    expect(transferExecution.graph?.links).toContainEqual(expect.objectContaining({kind:"settles",from:expect.objectContaining({owner:"shared_acceptance",id:"transfer-acceptance"})}));
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
    expect(accepted.graph?.links.some(link=>link.to.id.startsWith("private-"))).toBe(false);
    // Corrupt/unversioned records must not silently fall back to private-field inference.
    expect(()=>observer.observe({sequence:7,runId:"parent",owner:"context_preparation_policy",subject:"missing-evidence",kind:"decision_accepted",
      occurredAt:"2026-11-01T00:00:00Z",details:{}} as never)).toThrow("context_process_evidence_missing");
    const events=await queries.query({kind:"list_records",...selection,runId:"parent",limit:500});
    const fact=events.records.find(record=>record.payload.kind==="process_evidence"&&record.payload.name==="context_preparation_policy.decision_accepted"&&record.payload.origin.id==="6")!;
    const detail=await queries.query({kind:"get_subject",...selection,subject:fact.subject});
    expect(detail.records[0]?.payload).toMatchObject({name:"context_preparation_policy.decision_accepted",origin:{id:"6"}});
    expect(detail.records[0]?.contents).toHaveLength(1);
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);
