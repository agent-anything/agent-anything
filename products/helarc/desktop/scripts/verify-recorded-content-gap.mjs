import assert from "node:assert/strict";
import {copyFile,mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {InspectionQueryService} from "@agent-anything/inspection/query";

// Damage only an independent Inspector snapshot. The reader never opens the execution store.
const original=process.argv[2],{selection}=JSON.parse(await readFile(join(original,"selection.json")));
const {sourceId,datasetId}=selection,work=await mkdtemp(join(tmpdir(),"helarc-p06-content-gap-"));
const source=root=>join(root,"sources",sourceId),dataset=root=>join(source(root),"datasets",datasetId);
await mkdir(dataset(work),{recursive:true});
for(const file of ["source.json","read-policy.json"])await copyFile(join(source(original),file),join(source(work),file));
await copyFile(join(dataset(original),"manifest.json"),join(dataset(work),"manifest.json"));
const target=join(dataset(work),"inspection.sqlite"),db=new DatabaseSync(join(dataset(original),"inspection.sqlite"),{readOnly:true});
try{db.prepare("VACUUM INTO ?").run(target);}finally{db.close();}
const copy=new DatabaseSync(target);let row,hash;
try{
  row=copy.prepare("SELECT c.id,c.record_id,c.body_id,b.digest,b.bytes FROM contents c JOIN bodies b ON b.id=c.body_id WHERE c.sequence<=? AND json_extract(c.value,'$.name')='response' AND b.byte_length BETWEEN 1 AND 4096 ORDER BY c.sequence LIMIT 1").get(selection.watermark);
  assert(row);const bytes=Buffer.from(row.bytes);hash=createHash("sha256").update(bytes).digest("hex");assert.equal(hash,row.digest);
  bytes[0]^=1;assert.equal(copy.prepare("UPDATE bodies SET bytes=? WHERE id=?").run(bytes,row.body_id).changes,1);
}finally{copy.close();}
async function investigate(root,damaged){
  const service=new InspectionQueryService(root);
  try{const meta=await service.query({...selection,kind:"get_record",recordId:row.record_id});
    assert.equal(meta.readWork.bodyReads,0);assert(meta.records[0].contents.some(c=>c.id===row.id&&c.availability==="present"));
    const {content}=await service.query({...selection,kind:"get_content",contentId:row.id,length:4096});
    if(damaged){assert.equal(content.descriptor.unavailableReason,"content_integrity_failed");assert.equal(content.descriptor.availability,"unavailable");assert.equal(content.text,"");}
    else{assert.equal(content.descriptor.availability,"present");assert.equal(createHash("sha256").update(content.text).digest("hex"),hash);}
    return {record:meta.records[0].id,content:content.descriptor.id,availability:content.descriptor.availability,reason:content.descriptor.unavailableReason??null};
  }finally{await service.close();}
}
const unavailable=await investigate(work,true),unchanged=await investigate(original,false);
const report={selection,unavailable,unchanged};await writeFile(join(work,"result.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify({work,...report}));
