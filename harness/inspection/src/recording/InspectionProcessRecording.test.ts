import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,relative,resolve} from "node:path";
import {InspectionRecorder} from "../../dist/recording/index.js";
import {InspectionDatabase} from "../../dist/storage/index.js";
import {InspectionQueryService} from "../../dist/query/index.js";
import {datasetDirectory,registerInspectionSource,INSPECTION_SOURCE_FORMAT_VERSION} from "../sources/index.js";
import {DEFAULT_INSPECTION_CAPTURE_POLICY} from "../content/index.js";
import type {InspectionRecordInput} from "../records/index.js";

const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),"inspection-process-recording-"));
  cleanups.push(async()=>{if(!relative(tmpdir(),resolve(root)).startsWith("inspection-process-recording-"))throw new Error("unsafe_cleanup");rmSync(root,{recursive:true,force:true});});
  const recorder=await InspectionRecorder.create({root,application:"process-recording",name:"Test",policy:{...DEFAULT_INSPECTION_CAPTURE_POLICY,agent:true}});
  cleanups.push(()=>recorder.flush(true));
  const query=new InspectionQueryService(root);cleanups.push(()=>query.close());
  const subject=recorder.ref("decision","event","accepted","child");
  const input:InspectionRecordInput={subject,occurredAt:null,payload:{kind:"process_evidence",version:"1",origin:{owner:"decision",id:"accepted",runId:"child",revision:"1"},digest:"owner-basis",category:"decision",subject,
    name:"decision_accepted",status:"accepted",purpose:"task",recipient:{runId:"parent",recipient:"parent",purpose:"task"},relationCount:1},
    contents:[{name:"Protected original evidence",class:"agent",stage:"source",mediaType:"application/json",value:{apiKey:"must-not-leak",body:"retained original"}}]};
  return {root,recorder,query,input,async snapshot(){await recorder.flush();return (await query.query({kind:"get_snapshot",sourceId:recorder.source.sourceId,datasetId:recorder.manifest.datasetId})).selection!;}};
}
it("keeps typed structure separate from protected bodies, current revocation and disabled capture",async()=>{
  const f=await fixture();expect(f.recorder.offer(f.input)).toBe(true);const scope=await f.snapshot();
  const record=(await f.query.query({kind:"list_records",...scope})).records[0]!;
  expect(JSON.stringify(record)).not.toContain("must-not-leak");expect(record.payload.kind).toBe("process_evidence");
  const content=(await f.query.query({kind:"get_content",...scope,contentId:record.contents[0]!.id})).content!;
  expect(content.text).toContain("retained original");expect(content.text).not.toContain("must-not-leak");
  f.recorder.setPolicy({...DEFAULT_INSPECTION_CAPTURE_POLICY,revision:"revoked",enabled:false});
  expect(f.recorder.offer(f.input)).toBe(false);const after=await f.snapshot();
  await expect(f.query.query({kind:"get_content",...scope,contentId:record.contents[0]!.id})).rejects.toThrow("inspection_access_denied");
  const snapshot=await f.query.query({kind:"get_snapshot",...after});
  expect(snapshot.coverage?.capture).toEqual({enabled:false,policyRevision:"revoked"});
  expect((await f.query.query({kind:"list_records",...scope})).records).toHaveLength(1);
  const db=new InspectionDatabase(datasetDirectory(f.root,f.recorder.source.sourceId,f.recorder.manifest.datasetId));
  try {expect(db.process.evidence({watermark:scope.watermark})).toHaveLength(1);expect(db.snapshotAt(scope.watermark).capture?.enabled).toBe(true);}
  finally{db.close();}
});
it("preserves not-captured and unavailable bodies independently of structural relationship coverage",async()=>{
  const f=await fixture();f.recorder.setPolicy({...DEFAULT_INSPECTION_CAPTURE_POLICY,revision:"off"});
  f.recorder.offer(f.input);const first=await f.snapshot();
  f.recorder.setPolicy({...DEFAULT_INSPECTION_CAPTURE_POLICY,revision:"on",agent:true});
  f.recorder.offer({...f.input,contents:[{name:"missing",class:"agent",stage:"source",mediaType:"text/plain",value:null,unavailableReason:"source_missing"}]});
  const second=await f.snapshot();
  const records=(await f.query.query({kind:"list_records",...second})).records;
  expect(records.map(r=>r.contents[0]!.availability)).toEqual(["not_captured","unavailable"]);
  expect(records.every(r=>r.payload.kind==="process_evidence"&&r.payload.relationCount===1&&r.links.length===0)).toBe(true);
  expect((await f.query.query({kind:"list_records",...first})).records).toHaveLength(1);
});
it("keeps Source metadata stable while new datasets adopt a separate format",async()=>{
  const f=await fixture(),source=f.recorder.source,path=join(f.root,"sources",source.sourceId,"source.json"),before=readFileSync(path,"utf8");
  expect(source.formatVersion).toBe(INSPECTION_SOURCE_FORMAT_VERSION);expect(f.recorder.manifest.formatVersion).not.toBe(source.formatVersion);
  expect(registerInspectionSource(f.root,"process-recording","Changed display name")).toEqual(source);
  expect(readFileSync(path,"utf8")).toBe(before);
  const directory=datasetDirectory(f.root,source.sourceId,f.recorder.manifest.datasetId),manifest=JSON.parse(readFileSync(join(directory,"manifest.json"),"utf8"));
  writeFileSync(join(directory,"manifest.json"),JSON.stringify({...manifest,formatVersion:4}));
  const result=await f.query.query({kind:"list_datasets",sourceId:source.sourceId});
  expect(result.limitations).toContain("unsupported_dataset");expect(result.datasets).toHaveLength(0);
  writeFileSync(join(directory,"manifest.json"),JSON.stringify(manifest));
});
