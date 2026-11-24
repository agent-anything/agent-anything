const assert=require("node:assert/strict"),{readFile,writeFile}=require("node:fs/promises"),{join}=require("node:path");
module.exports=async({store,transport,reportService,load,directory,phase,checkpoint,helarc,built})=>{
  const {activityId}=JSON.parse(await readFile(join(directory,"cancel-original.json"),"utf8"));
  const tree=await store.readRunTree("root"),root=tree.members.find(m=>m.head.state.run.id==="root");
  assert.equal(root.head.state.status,"cancelled");assert.equal(tree.members.length,4);
  assert(tree.members.filter(m=>m!==root).every(m=>m.head.state.status==="completed"));
  const result=root.head.state.items.find(i=>i.payload.kind==="model_call_settlement"&&i.payload.result.content?.output?.report)?.payload.result.content;
  assert(result);const reference=result.output.report.reference,recipient={runId:"root",recipient:built.agent.id,purpose:helarc.HELARC_CONTROLLER_CAPABILITY};
  const {helarcReportDeliveryRef}=await load("context/HelarcNativeReportDelivery.js"),identity=helarcReportDeliveryRef(reference,recipient);
  const handoff=await store.protocolJournal.command({kind:"reconciliation",activityId,id:`${activityId}:responses:reconciliation`});assert(handoff);
  assert.equal(await store.protocolJournal.command({kind:"acceptance",activityId}),null);
  await assert.rejects(()=>reportService.deliveries.reconcileCancellation(identity,activityId,"foreign-handoff"),/unconfirmed/);
  await transport.reconcile(handoff,new AbortController().signal,async()=>{throw new Error("Unsent cancelled Parent must never dispatch");});
  const accepted=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
  store.sharedAcceptance.accept=async proposal=>{
    const receipt=await accepted(proposal);
    if(phase==="cancel-clear"&&receipt.outcome==="accepted"&&proposal.actor==="helarc.report-handoff"&&
      proposal.parts.some(p=>p.owner==="material_delivery"&&p.kind==="evidence"&&p.proposal.kind==="in_flight_resolution"))
      await checkpoint("Native resolution confirmed; crash before report disposition/release",{scope:{activityId}});
    return receipt;
  };
  assert.equal(await reportService.deliveries.reconcileCancellation(identity,activityId,handoff.id),"disposed");
  assert.equal(await reportService.deliveries.reconcileCancellation(identity,activityId,handoff.id),"disposed");
  const state=await store.materialDeliveries.query({kind:"obligation",ref:identity});assert.equal(state.discharged.length,1);
  const facts=await store.materialDeliveryFacts("root",0,128);
  assert.equal(facts.filter(f=>f.kind==="material_delivery.disposition").length,1);
  assert.equal(facts.filter(f=>f.kind==="material_delivery.evidence"&&f.value.kind==="receipt").length,0);
  assert.equal(facts.find(f=>f.kind==="material_delivery.disposition").value.disposition.kind,"non_delivery");
  const original=await store.materialCustody.command({kind:"resolve_reference",reference,recipient});
  const page=await store.materialCustody.command({kind:"read",access:{id:"remaining-detail",holdId:original.hold.id,recipient,range:original.hold.range},offset:0,length:128});
  assert(page.text.includes("8422"),"Detail retention is independent from cancelled delivery");
  await assert.rejects(()=>store.materialCustody.command({kind:"describe",holdId:state.obligation.holdId,recipient}));
  const {ProtocolJournalInspectionAdapter}=await load("inspection/ProtocolJournalInspectionAdapter.js"),offers=[];
  await new ProtocolJournalInspectionAdapter({ref:(owner,kind,id,runId,revision="1")=>({sourceId:"fixture",datasetId:"fixture",owner,kind,id,runId,revision}),offer:r=>offers.push(r)})
    .replay((after,limit)=>store.materialDeliveryFacts("root",after,limit));
  assert(offers.some(o=>JSON.stringify(o).includes("non_delivery")));
  await writeFile(join(directory,"verification.json"),JSON.stringify({profile:"cancelled-parent-report",generation:store.generation,members:4,
    cancelled:1,completedChildren:3,receipts:0,dispositions:1,retainedOriginalDetail:true,inspectorRecords:offers.length},null,2));
};
