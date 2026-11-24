import {expect,it} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {HelarcInspection} from "./HelarcInspection.js";
import {beginExecutionTiming} from "../diagnostics/ExecutionPerformance.js";

it("records correlated request and nested work evidence without sensitive fields",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"helarc-performance-inspection-")),root=join(directory,"inspection");
  const inspection=await HelarcInspection.create(join(directory,"settings.json"),root),query=new InspectionQueryService(root);
  try {
    const recorder=inspection.recorder!,sink=inspection.performanceObserver!;
    for(let requestId=1;requestId<=70;requestId++)beginExecutionTiming(sink,"storage.host.request",{runId:"child",pathId:"path-child",generation:1,requestId,secret:"private-body"})();
    beginExecutionTiming(sink,"storage.worker.content.expand",{runId:"child",requestId:3})();
    sink.flush();await recorder.flush();expect(recorder.health()).toMatchObject({dropped:0,rejected:0});
    const snapshot=await query.query({kind:"get_snapshot",sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId});
    if(!snapshot.selection)throw new Error("missing inspection selection");
    const records=await query.query({...snapshot.selection,kind:"list_records",runId:"child",limit:20});
    expect(records.records).toHaveLength(3);
    const samples=[];
    for(const record of records.records){
      expect(record.links.some(link=>link.to.id==="path-child")).toBe(true);
      const content=await query.query({...snapshot.selection,kind:"get_content",contentId:record.contents[0]!.id,offset:0,length:65536});
      expect(content.content?.text).not.toContain("private-body");
      expect(content.content?.text).toContain("clockDomain");
      samples.push(...JSON.parse(content.content!.text).samples);
    }
    expect(samples.map(sample=>sample.context.requestId)).toEqual([...Array.from({length:70},(_,index)=>index+1),3]);
    expect(samples.at(-1).stage).toBe("storage.worker.content.expand");
    expect(new Set(samples.map(sample=>sample.id)).size).toBe(71);
  }finally{await inspection.close();await query.close();await rm(directory,{recursive:true,force:true});}
},30000);
