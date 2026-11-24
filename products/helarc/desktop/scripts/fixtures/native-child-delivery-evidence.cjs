const assert=require("node:assert/strict"),fs=require("node:fs"),{join}=require("node:path");

// Observe the vault boundary before application composition, including discovery and shutdown.
async function watchCredentials(directory,phase,load){
  const {ProviderCredentialStore}=await load("provider/ProviderCredentialStore.js");
  const proto=ProviderCredentialStore.prototype,original=proto.resolveApiKey;
  const path=join(directory,"credential-"+phase+".ndjson");
  let segment="bootstrap";
  const mark=kind=>fs.appendFileSync(path,JSON.stringify({pid:process.pid,kind,segment})+"\n");
  mark("start");
  proto.resolveApiKey=async function(...args){
    mark("lookup");
    if(phase==="lifetime-deliver"||phase==="lifetime-recover")return {ok:true,apiKey:null,credentialStatus:"missing"};
    return original.apply(this,args);
  };
  return {work(){segment="work";mark("boundary");}};
}
function parentMessage(directory,admission){
  const {aggregates}=JSON.parse(fs.readFileSync(join(directory,"threads.json")));
  const records=Object.values(aggregates).map(a=>a.record).filter(r=>r.thread.id===admission.sessionId);
  assert.equal(records.length,1);
  const messages=records[0].messages;
  assert.deepEqual(messages.map(m=>m.role),["user","assistant"]);
  const {id,sequence,content,correlation}=messages[1];
  assert.equal(correlation.runId,admission.productRunId);assert.equal(content,"Root received 7391");
  return {threadId:admission.sessionId,productRunId:admission.productRunId,id,sequence,content};
}
module.exports={watchCredentials,parentMessage};
