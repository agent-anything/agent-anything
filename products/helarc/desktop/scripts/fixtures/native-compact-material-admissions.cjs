module.exports=function({source,sources,owner,purpose,digest}){
  const reader={runId:source.manifest.scope.runId,recipient:owner,purpose};
  return sources.flatMap(s=>s.holds).filter(h=>digest(h.consumer)!==digest(reader)).map(original=>{
    const id=`compact-source-admission:${digest({source:source.sourceDigest,original:original.id,reader})}`;
    const hold={...original,id:`${id}:hold`,consumer:reader,responsibility:"checkpoint",basis:source.sourceDigest,
      releaseCondition:"Original compact publication and dependent consumers settled"};
    return {source:{id:`${id}:access`,holdId:original.id,recipient:original.consumer,range:original.range},hold,
      grant:{id:`${id}:grant`,instanceId:hold.instanceId,recipient:reader,range:hold.range,revision:0,allowed:true,basis:source.dependencies.authority}};
  });
};
