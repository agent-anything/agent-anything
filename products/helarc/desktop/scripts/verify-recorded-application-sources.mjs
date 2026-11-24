// Independent P06 reader for a completed, isolated P05 formal application recording.
import assert from "node:assert/strict";
import {readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {InspectionQueryService} from "@agent-anything/inspection/query";

const directory=process.argv[2],read=async name=>JSON.parse(await readFile(join(directory,name+".json")));
const pageBytes=Number(process.argv[3]??4096);assert([4096,65536].includes(pageBytes));
const marker=process.argv[4]??"root";assert(["root","cancel-cut"].includes(marker));
const {root}=await read(marker),inspection=join(directory,"inspection"),sourceDir=join(inspection,"sources");
const run=Object.values((await read("threads")).aggregates).flatMap(a=>a.record.runs).find(r=>r.harnessRunId===root);
assert(run?.terminal);const presentation=run.lastProjection.product.presentation;
const native=presentation.records.filter(r=>r.origin?.nativeSource);
assert(native.some(r=>r.runId===root)&&native.some(r=>r.runId!==root));
const db=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
const service=new InspectionQueryService(inspection),seen=new Set(),edges=new Set(),coverage=[];
const recovered=[];
let pages=0,details=0,bodyReads=0,loadedBytes=0,returnedBytes=0;
async function metadata(input){const r=await service.query(input);assert.equal(r.readWork.bodyReads,0);pages++;return r;}
async function allRecords(input){
  let after;const rows=[],ids=new Set();
  do{const page=await metadata({...input,limit:3,...(after?{after}:{})});
    for(const row of page.records){assert(!ids.has(row.id));ids.add(row.id);rows.push(row);}after=page.next;
  }while(after);return rows;
}
try{
  const labels=presentation.labels.filter(l=>l.parentRunId);
  assert(labels.length);
  for(const label of labels){
    assert(label.parentOrigin?.nativeSource);
    assert(native.some(r=>r.runId===label.parentRunId&&r.origin.nativeSource.scope.activityId===label.parentOrigin.nativeSource.scope.activityId&&
      r.origin.nativeSource.nativeIdentity?.id===label.parentOrigin.nativeSource.nativeIdentity?.id));
  }
  for(const sourceId of (await readdir(sourceDir)).sort())for(const datasetId of (await readdir(join(sourceDir,sourceId,"datasets"))).sort()){
    const snap=await metadata({kind:"get_snapshot",sourceId,datasetId}),s=snap.selection;assert(s);
    const c=snap.coverage;coverage.push({datasetId,watermark:s.watermark,status:c.status,rejected:c.rejected,dropped:c.dropped});
    const scope={...s,kind:"list_native_interactions",runId:root};
    const own=await allRecords(scope),tree=await allRecords({...scope,includeDescendants:true});
    assert(own.every(r=>r.subject.runId===root));assert(own.every(r=>tree.some(t=>t.id===r.id)));
    for(const parent of new Set(labels.map(l=>l.parentRunId))){
      const runSubject={sourceId,datasetId,owner:"runtime",kind:"run",id:parent,runId:parent,revision:null};
      const graph=await metadata({...s,kind:"get_hierarchy",subject:runSubject});
      for(const l of graph.graph.links)if(l.kind==="descendant"&&l.from.id===parent)edges.add(JSON.stringify([parent,l.to.id]));
    }
    for(const record of tree){
      const refs=native.filter(r=>!seen.has(r.id)&&r.runId===record.subject.runId&&r.origin.nativeSource.scope.activityId===record.subject.id);
      if(!refs.length)continue;
      const facts=await allRecords({...s,kind:"get_native_interaction",subject:record.subject,nativeCategories:["observation"]});
      for(const fact of facts)for(const content of fact.contents.filter(c=>c.name==="response"&&c.availability==="present"&&!c.truncated)){
        let offset=0,text="";
        do{const response=await service.query({...s,kind:"get_content",contentId:content.id,offset,length:pageBytes});
          assert(response.content);assert(response.readWork.loadedBodyBytes<=2*65536);
          text+=response.content.text;bodyReads+=response.readWork.bodyReads;loadedBytes+=response.readWork.loadedBodyBytes;
          returnedBytes+=response.readWork.returnedBodyBytes;offset=response.content.nextOffset;
        }while(offset!==null);
        const observed=JSON.parse(text);
        for(const r of refs){const src=r.origin.nativeSource;if(seen.has(r.id))continue;
          const match=/^\/output\/(\d+)$/.exec(src.position.value);assert(match);
          const item=observed.output?.[Number(match[1])];if(!item||item.id!==src.nativeIdentity.id)continue;
          const row=db.prepare("SELECT value FROM protocol_records WHERE activity_id=? AND id=? AND revision=?").get(src.scope.activityId,src.record.id,src.record.revision);
          assert(row);const ref=JSON.parse(row.value).content;
          const bytes=Buffer.concat(db.prepare("SELECT bytes FROM protocol_content_chunks WHERE id=? ORDER BY offset").all(ref.id).map(c=>c.bytes));
          assert.equal("sha256:"+createHash("sha256").update(bytes).digest("hex"),ref.digest);
          assert.deepEqual(observed,JSON.parse(bytes));if(r.content.kind==="final_response")assert.equal(JSON.parse(item.arguments).response,r.content.text);
          recovered.push([r.id,src.record,src.position,item.id,ref.digest,content.id,s.watermark]);
          seen.add(r.id);details++;
        }
      }
    }
  }
  assert.equal(seen.size,native.length,"not every Desktop source has a readable, matching native response");
  assert(labels.every(l=>edges.has(JSON.stringify([l.parentRunId,l.runId]))),"recorded Parent/Child hierarchy is not reachable");
  assert(coverage.every(c=>c.rejected===0&&c.dropped===0));
  console.log(JSON.stringify({root,coverage,nativeSources:details,children:labels.length,metadataPages:pages,pageBytes,bodyReads,loadedBytes,returnedBytes,
    sourcesDigest:createHash("sha256").update(JSON.stringify(recovered)).digest("hex")}));
}finally{db.close();await service.close();}
