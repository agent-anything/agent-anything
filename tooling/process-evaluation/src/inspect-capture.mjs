import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {InspectionQueryService} from "@agent-anything/inspection/query";
import {observedCaptureQuery} from "./capture-query.mjs";
const directory=resolve(process.argv[2]),input=JSON.parse(await readFile(join(directory,"target-input.json"),"utf8"));
const actual=JSON.parse(await readFile(join(directory,"target-execution.json"),"utf8"));
const events=(await readFile(join(directory,"recordings.jsonl"),"utf8")).trim().split("\n").map(JSON.parse),recordings=[...new Map(events.map(r=>[r.datasetId,r])).values()];
const service=new InspectionQueryService(input.input.inspectionRoot??join(directory,"inspection")),q=observedCaptureQuery(service,directory);
try{for(const r of recordings){const snapshot=await q.query({kind:"get_snapshot",sourceId:r.sourceId,datasetId:r.datasetId});let after,count=0;
  do{const result=await q.query({kind:"list_records",...snapshot.selection,runId:actual.runId,includeDescendants:true,limit:Number(process.argv[3]??500),...(after?{after}:{})});count+=result.records.length;after=result.next;}while(after);
  console.log(JSON.stringify({datasetId:r.datasetId,count}));}
}finally{await service.close();}
