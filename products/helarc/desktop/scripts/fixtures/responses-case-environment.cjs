// Durable case definitions describe modes. Original identities come only from a committed Settings receipt.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto"),{pathToFileURL}=require("node:url");
const model="gpt-6.2-sol",cards=["tool-roundtrip","stored-continuation","delegated-material","background-observation","standalone-compaction","in-request-compaction"];
const file="responses-fixture.json",format="responses.isolated-case.v1";
const load=name=>import(pathToFileURL(path.join(__dirname,"../../dist",name)));
const ok=r=>{if(!r.ok)throw Error(r.code);return r.value;};

function paths(caseId,directory,fresh=false){
  assert(cards.includes(caseId)&&directory,"unknown Responses case or missing directory");
  const supplied=path.resolve(directory),root=path.join(fs.realpathSync.native(path.dirname(supplied)),path.basename(supplied));
  const daily=path.resolve(process.env.APPDATA,"Helarc"),relative=path.relative(daily,root);
  assert(relative&&(/^[.][.]([\\/]|$)/.test(relative)||path.isAbsolute(relative)),"daily Desktop profile is not a fixture");
  const profile=path.join(root,"profile","Helarc");
  if(fresh){fs.mkdirSync(root);fs.mkdirSync(profile,{recursive:true});}
  else{
    for(const location of [root,profile,path.join(root,file),path.join(profile,"execution/execution.sqlite"),path.join(profile,"provider-registry/registry.sqlite")]){
      assert.equal(path.relative(location,fs.realpathSync.native(location)),"","refuse redirected fixture path");
    }
  }
  return {root,profile,caseId,attempt:path.join(root,"attempt")};
}
function openCase(caseId,root){
  const env=paths(caseId,root),receipt=JSON.parse(fs.readFileSync(path.join(env.root,file),"utf8"));
  assert(receipt.format===format&&receipt.caseId===caseId&&receipt.target?.model===model&&receipt.updateId,"not the original case receipt");
  return {...env,receipt,target:receipt.target};
}
function openLive(caseId,root,authorization){
  const env=openCase(caseId,root);
  assert(env.receipt.credentialUse==="live-reference","not a live case");
  assert.equal(authorization,liveAuthority(caseId),"explicit case dispatch authorization required");
  return env;
}
function liveAuthority(caseId){
  assert(cards.includes(caseId),"unknown Responses case");
  assert(caseId!=="in-request-compaction","blocked: no complete-input hard-budget evidence");
  return caseId==="stored-continuation"?"--authorize-stored-live":caseId==="background-observation"?"--authorize-background-stored-live":"--authorize-live";
}
const isLiveTarget=target=>typeof target==="string"&&/^Helarc-Responses-Test\/[\w.-]+$/i.test(target);
async function draftFor(caseId){
  const {defaultProviderDraft,defaultProviderCompactionPolicy}=await load("main/provider/ProviderDraftValidation.js");
  const draft=defaultProviderDraft("openai.responses");
  draft.name="Responses-"+caseId;draft.model=model;
  if(caseId==="stored-continuation")Object.assign(draft.native,{store:true,continuity:"stored-response"});
  if(caseId==="background-observation")Object.assign(draft.native,{background:true,store:true,allowTemporaryRetention:true,stream:false});
  if(caseId==="in-request-compaction")draft.native.allowInRequestCompaction=true;
  draft.inRequestCompaction=caseId==="in-request-compaction"?require("./responses-in-request-compaction-use-policy.json"):defaultProviderCompactionPolicy(draft);
  // The reviewed in-request-compaction evidence is exact-target evidence. Never rebase it on a different model/route.
  return draft;
}
function assertMode(c,caseId){
  const n=c.native;
  assert(c.name==="Responses-"+caseId&&c.protocol==="openai.responses"&&c.model===model&&c.baseUrl==="https://api.openai.com/v1"&&
    !c.isDefault&&!c.archived&&!c.capacityDeclaration&&c.credentialBackend==="windows-reference");
  assert(n.protocol===c.protocol&&n.transport==="http"&&n.stream===(caseId!=="background-observation")&&
    n.store===(caseId==="stored-continuation"||caseId==="background-observation")&&n.background===(caseId==="background-observation")&&n.allowTemporaryRetention===(caseId==="background-observation")&&
    n.continuity===(caseId==="stored-continuation"?"stored-response":"replay")&&!n.allowConnectionMemory&&n.allowInRequestCompaction===(caseId==="in-request-compaction")&&
    n.project===null&&n.organization===null&&n.reasoningEffort===null);
}
async function initialize(env,api,credentialTarget,credentialUse){
  assert(credentialUse==="live-reference"?isLiveTarget(credentialTarget):
    credentialUse==="offline-fixture"&&/^Helarc-Custody-Test\/[a-f0-9-]{36}$/.test(credentialTarget),"dedicated external test credential required");
  const listing=await api.list();assert.deepEqual(listing,{configurations:[],defaultSelection:null});
  const updateId=randomUUID(),id="provider-"+randomUUID(),draft=await draftFor(env.caseId);
  const saved=await api.save({configurationId:id,updateId,expectedRevision:null,draft,
    credential:{kind:"reference",target:credentialTarget,encoding:"utf16le"}});
  assert.equal(saved.disposition,"committed");
  const c=saved.configuration;assertMode(c,env.caseId);assert.deepEqual(c.inRequestCompaction,draft.inRequestCompaction);
  const target={id,revision:c.revision,binding:c.connectionBindingId,model:c.model};
  const receipt={format,caseId:env.caseId,updateId,target,semanticRevision:c.semanticRevision,credentialUse};
  fs.writeFileSync(path.join(env.root,file),JSON.stringify(receipt,null,2),{flag:"wx",flush:true});
  return receipt;
}
async function original(env,api){
  const saved=await api.receipt(env.receipt.updateId);
  assert(saved?.disposition==="committed","original settings receipt unavailable");
  const c=saved.configuration;assertMode(c,env.caseId);
  assert.deepEqual({id:c.id,revision:c.revision,binding:c.connectionBindingId,model:c.model},env.target,"original binding changed");
  assert.equal(c.semanticRevision,env.receipt.semanticRevision);
  const reference=(await api.credentialSettings(c.connectionBindingId)).selection;
  assert(reference.source==="windows-reference"&&reference.encoding==="utf16le"&&
    (env.receipt.credentialUse==="live-reference"?isLiveTarget(reference.target):env.receipt.credentialUse==="offline-fixture"&&/^Helarc-Custody-Test\/[a-f0-9-]{36}$/.test(reference.target)),
    "original external test credential reference required");
  return c;
}
// Live ApplicationServices exposes the same receipt and credential observations as result envelopes.
function originalForRun(env,api){
  return original(env,{receipt:async id=>ok(await api.receipt(id)),credentialSettings:async id=>ok(await api.credentialSettings(id))});
}
module.exports={cards,paths,openCase,openLive,initialize,original,originalForRun,liveAuthority,isLiveTarget};
