import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {contextMaterialDigest} from "@agent-anything/context/material";
import {HelarcInspection} from "./HelarcInspection.js";

it("connects retained sources, transfers and reads without claiming that a read was consumed",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-context-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,observer=inspection.contextMaterialObserver!;
    const reference={id:"retained-report",revision:contextMaterialDigest("body")};
    observer.observe({kind:"published",runId:"child",description:{reference,originRunId:"child",source:{owner:"agent-runtime",kind:"run_item",id:"child-item",revision:"1"},
      label:"Report",role:"tool",position:2,bytes:4,format:"text",relationships:[],limitations:[]}});
    observer.observe({kind:"retention",state:"accepted",transfer:{id:"transfer",sourceRunId:"child",recipientRunId:"parent",references:[reference],basis:{kind:"result",id:"ending"}}});
    observer.observe({kind:"access",runId:"parent",invocationId:"read",mode:"read",reused:false,references:[reference],coverage:{byteStart:0,byteEnd:4,nextOffset:null}});
    await r.flush();
    expect(r.health().rejected).toBe(0);
    const selected=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const flow=await queries.query({kind:"get_data_flow",...selected,subject:r.ref("context","contribution",reference.id,null,reference.revision)});
    expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind:"produces",from:expect.objectContaining({owner:"runtime",id:"child-item"})}));
    expect(flow.graph?.links).toContainEqual(expect.objectContaining({kind:"delivers",to:expect.objectContaining({id:"read:material-read:saved",runId:"parent"})}));
    const access=await queries.query({kind:"get_data_flow",...selected,subject:r.ref("context","contribution","read:material-read:saved","parent")});
    expect(access.graph?.links).toContainEqual(expect.objectContaining({kind:"produces",to:expect.objectContaining({owner:"operations",id:"read:context-result"})}));
    expect(access.graph?.links.some(link=>link.to.kind === "request")).toBe(false);
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);

it("records only the explicit previous recording and leaves missing registration visible",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-context-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),queries=new InspectionQueryService(root);
  try {
    const r=inspection.recorder!,previous={sourceId:"previous-source",datasetId:"previous-dataset",runId:"root"};
    await inspection.registerExecutionRecording("root",true,{async registerRecording(current){return {current,previous};}});
    await inspection.registerExecutionRecording("missing",true,{async registerRecording(){throw new Error("unavailable");}});
    await r.flush();
    expect(r.health().rejected).toBe(0);
    const scope=(await queries.query({kind:"get_snapshot",sourceId:r.source.sourceId,datasetId:r.manifest.datasetId})).selection!;
    const facts=await queries.query({...scope,kind:"list_records",recordKind:"recording_link"});
    expect(facts.records.map(item=>item.payload)).toContainEqual({kind:"recording_link",stage:"recovery_prepared",target:previous,limitation:null});
    expect(facts.records.map(item=>item.payload)).toContainEqual({kind:"recording_link",stage:"recovery_prepared",target:null,limitation:"recording_registration_unavailable"});
    expect(facts.records.every(item=>item.links.every(link=>link.from.datasetId===r.manifest.datasetId && link.to.datasetId===r.manifest.datasetId))).toBe(true);
  } finally {await inspection.close();await queries.close();await rm(directory,{recursive:true,force:true});}
},30000);
