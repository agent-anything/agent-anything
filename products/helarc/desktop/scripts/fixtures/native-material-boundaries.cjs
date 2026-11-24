const assert=require("node:assert/strict"),{createHash}=require("node:crypto");
const {join,resolve,relative}=require("node:path"),{writeFile,unlink}=require("node:fs/promises");

module.exports=async({store,directory,origin})=>{
  const {CustodyMaterialAccess,materialViewReference}=await import("@agent-anything/context/custody");
  const recipient={runId:"root",recipient:"material-boundary-reader",purpose:"detail"};
  const port=new CustodyMaterialAccess(store.materialCustody,recipient),signal=new AbortController().signal;
  const path=resolve(directory,"mutable-child-result.txt");
  assert.equal(relative(resolve(directory),path),"mutable-child-result.txt");
  await writeFile(path,"ORIGINAL_FILE_BODY");
  const cases=[{id:"mutable-path",format:"locator",bytes:Buffer.from(path),type:"text/plain"},
    {id:"provider-file",format:"locator",bytes:Buffer.from("file-original-provider-id"),type:"text/plain"},
    {id:"remote-url",format:"locator",bytes:Buffer.from("https://invalid.example/report"),type:"text/plain"},
    {id:"binary-artifact",format:"opaque",bytes:Buffer.from([0,255,128,15]),type:"application/octet-stream"},
    {id:"native-compact",format:"opaque",bytes:Buffer.from("native-encrypted-content"),type:"application/vnd.openai.compaction"}];
  for(const c of cases){
    const id=`boundary:${c.id}`,revision=`sha256:${createHash("sha256").update(c.bytes).digest("hex")}`;
    const version={ref:{materialId:id,version:revision},origin:{...origin,recordId:id},label:c.id,format:c.format,mediaType:c.type,
      bytes:c.bytes.length,digest:revision,capture:"complete",limitations:c.format==="locator"?["Only the locator bytes are retained; target bytes/version/access are not established."]:["Native/binary source; generic text access unsupported."]};
    const range={materialId:id,version:revision,coordinate:"bytes",start:0,end:c.bytes.length};
    const hold={id:`id:${c.id}:hold`,instanceId:id,consumer:recipient,responsibility:"detail",range,basis:id,releaseCondition:"explicit detail release"};
    await store.materialCustody.command({kind:"begin",intent:{id,instanceId:id,activityId:id,owner:"boundary-owner",maximumBytes:c.bytes.length,version}});
    await store.materialCustody.command({kind:"append",id:`${id}:bytes`,intentId:id,offset:0,bytesBase64:c.bytes.toString("base64")});
    await store.materialCustody.command({kind:"complete",intentId:id});
    const accepted=await store.sharedAcceptance.accept({id:`${id}:scoped-publication`,scope:origin.runId,actor:"boundary-owner",parts:[{owner:"material_custody",kind:"publish",proposal:{intentId:id,holds:[hold],
      grants:[{id:`${id}:grant`,instanceId:id,recipient,range,revision:0,allowed:true,basis:"explicit boundary test"}]}}]});assert.equal(accepted.outcome,"accepted",JSON.stringify(accepted));
    const reference=materialViewReference(range,version);
    if(c.format==="opaque"){
      await assert.rejects(()=>port.read("root",{reference},signal,id),/format_unsupported/);
      await assert.rejects(()=>port.search("root",{references:[reference],query:"content"},signal,id),/format_unsupported/);
    }else{
      if(c.id==="mutable-path")await writeFile(path,"CHANGED_FILE_BODY");
      const read=await port.read("root",{reference},signal,id);assert.equal(read.text,c.bytes.toString());assert.equal(read.description.limitations.length,1);
      const search=await port.search("root",{references:[reference],query:"FILE_BODY"},signal,id);assert.equal(search.matches.length,0);
      if(c.id==="mutable-path"){
        await unlink(path);
        assert.equal((await port.read("root",{reference},signal,id)).text,path,"Reading a locator does not fetch, snapshot or restore the target");
      }
    }
    const retained=await store.materialCustody.command({kind:"resolve_reference",reference,recipient});
    assert.equal(retained.version.format,c.format);assert.equal(retained.version.mediaType,c.type);
  }
  await writeFile(join(directory,"material-boundaries.json"),JSON.stringify({cases:cases.map(c=>c.id),nativeOrBinaryTextAccessRejected:2,
    locatorsNotDereferenced:3,mutablePathNotClaimedAsSnapshot:true,sourceClassesRetained:true},null,2));
};
