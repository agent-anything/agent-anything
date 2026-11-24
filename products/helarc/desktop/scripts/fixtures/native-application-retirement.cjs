const assert=require("node:assert/strict"),fs=require("node:fs"),{join}=require("node:path");
const read=(d,name)=>JSON.parse(fs.readFileSync(join(d,name+".json")));
const save=(d,name,value)=>fs.writeFileSync(join(d,name+".json"),JSON.stringify(value,null,2));
const {DatabaseSync}=require("node:sqlite");
const connection=require("./native-connection-retirement.cjs");
const scoped=()=>["connection-retire","connection-integrity"].includes(process.env.HELARC_P05_LIFETIME);
function pins(directory){
  const d=new DatabaseSync(join(directory,"provider-registry","registry.sqlite"),{readOnly:true});
  try{return d.prepare("select id,state from pins order by id").all();}finally{d.close();}
}
// Observe the real retirement pass. Neither the discovery result nor the pin decision is supplied by the fixture.
async function observeOpenHandoff(store,load){
  const seen=new Map(),finished=new Map(),command=store.protocolJournal.command.bind(store.protocolJournal);
  store.protocolJournal.command=async input=>{
    const value=await command(input);
    if(input.kind==="retention_status"&&value?.pendingHandoffs>0)
      seen.set(input.activityId+":connection",{activity:input.activityId,pendingHandoffs:value.pendingHandoffs});
    return value;
  };
  const {ProviderConfigurationService}=await load("provider/ProviderConfigurationService.js"),settle=ProviderConfigurationService.prototype.settlePin;
  ProviderConfigurationService.prototype.settlePin=async function(pin,...args){
    const discovery=seen.get(pin),result=await settle.call(this,pin,...args);
    if(discovery)finished.set(pin,{...discovery,pin,decision:args[1]});
    return result;
  };
  return pin=>finished.get(pin);
}
// Stop before entering SQLite acceptance; the independent follow-up and Inspector can still finish.
function beforeRelease(store,activity){
  const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
  let pending=null;
  store.sharedAcceptance.accept=async proposal=>{
    if(proposal.parts.some(p=>p.owner==="protocol_execution"&&p.kind==="release_retention"&&p.proposal.fence.activityId===activity)){
      pending=proposal.id;return new Promise(()=>{});
    }
    return accept(proposal);
  };
  return ()=>pending;
}
async function install({directory,store,phase,load,inspection,app}){
  const cut=read(directory,scoped()?"origin":"cut");const pin=cut.activity+":connection";
  const stamp=()=>({pid:process.pid,generation:store.generation,activity:cut.activity,pins:pins(directory),
    recording:inspection.recorder.ref("runtime","run",cut.root,cut.root)});
  const halt=(name,detail)=>{save(directory,name,{...stamp(),...detail});app.exit(73);return new Promise(()=>{});};
  if(phase==="lifetime-logical"){
    const accept=store.sharedAcceptance.accept.bind(store.sharedAcceptance);
    store.sharedAcceptance.accept=async proposal=>{
      const receipt=await accept(proposal);
      if(receipt.outcome==="accepted"&&proposal.parts.some(p=>p.owner==="protocol_execution"&&
        p.kind===(scoped()?"release_connection":"release_retention")&&p.proposal.fence.activityId===cut.activity)){
        assert.equal(pins(directory).find(p=>p.id===pin).state,"confirmed");
        if(scoped()){
          const proof=connection.check(directory,cut,true);assert.equal(proof.acceptance,proposal.id);
          const flush=await inspection.flushRecording();assert.equal(flush.unconfirmed,0);assert.equal(flush.unpersisted,0);
          return halt("logical",{...proof,flush});
        }
        return halt("logical",{acceptance:proposal.id});
      }
      return receipt;
    };
  }
  if(phase==="lifetime-physical"){
    const {ProviderConfigurationService}=await load("provider/ProviderConfigurationService.js"),orig=ProviderConfigurationService.prototype.settlePin;
    ProviderConfigurationService.prototype.settlePin=async function(id,acceptance,state){
      const result=await orig.call(this,id,acceptance,state);
      if(id===pin&&state==="released"){
        if(scoped()){
          const proof=connection.check(directory,cut,true);
          assert.equal(proof.acceptance,read(directory,"logical").acceptance);assert.equal(acceptance,cut.pinAcceptance);
          return halt("physical",{...proof,pinAcceptance:acceptance});
        }
        return halt("physical",{acceptance});
      }
      return result;
    };
  }
}
async function inspect({directory,store,phase,inspection}){
  const cut=read(directory,scoped()?"origin":"cut"),pin=cut.activity+":connection",deadline=Date.now()+15000;
  const state=()=>store.protocolJournal.command({kind:"state",activityId:cut.activity});
  if(phase==="lifetime-check-integrity"){
    let issue;
    while(!issue&&Date.now()<deadline){
      try{issue=read(directory,phase+"-diagnostics").find(d=>d.stage==="native_retirement_blocked"&&d.context.pinId===pin);}catch{}
      if(!issue)await new Promise(r=>setTimeout(r,50));
    }
    assert(issue,"no scoped retirement diagnostic");
    assert(/integrity|digest|corrupt/i.test(JSON.stringify(issue.error)),JSON.stringify(issue.error));
    const retained=await state(),all=pins(directory);
    assert(!retained.retentionReleased);assert.equal(all.find(p=>p.id===pin).state,"confirmed");
    assert(all.some(p=>p.id!==pin&&p.state==="released"));
    if(scoped()){
      assert.equal(issue.error.message,"protocol_content_corrupt");
      const proof=connection.check(directory,cut,false);
      save(directory,"verified",{...proof,activity:cut.activity,reason:issue.error.message,damaged:cut.damaged,
        pins:all,generation:store.generation,electron:process.versions.electron,flush:await inspection.flushRecording(true)});
      return;
    }
    const previous=await store.protocolJournal.command({kind:"reconciliation",activityId:cut.activity,id:cut.handoff});
    assert.equal(previous.disposition.outcome,"resolved");
    save(directory,"verified",{activity:cut.activity,generation:store.generation,pins:all,reason:issue.error.message,flush:await inspection.flushRecording(true)});
    return;
  }
  if(phase!=="lifetime-retired"){
    while(Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
    throw Error("Retirement did not reach "+phase);
  }
  const retained=await state(),all=pins(directory);
  if(scoped()){
    const logical=read(directory,"logical"),physical=read(directory,"physical"),proof=connection.check(directory,cut,true);
    assert.equal(proof.acceptance,logical.acceptance);assert.equal(proof.acceptance,physical.acceptance);
    assert.equal((await store.sharedAcceptance.query(proof.acceptance))?.outcome,"accepted");
    assert(cut.sourceGeneration<logical.generation&&logical.generation<physical.generation&&physical.generation<store.generation);
    for(const [list,expected] of [[logical.pins,"confirmed"],[physical.pins,"released"],[all,"released"]])
      assert.equal(list.find(p=>p.id===pin).state,expected);
    save(directory,"verified",{...proof,activity:cut.activity,pins:all,generations:[logical.generation,physical.generation,store.generation],
      electron:process.versions.electron,flush:await inspection.flushRecording(true)});return;
  }
  assert(retained.retentionReleased&&retained.retentionBasis);
  assert.equal(all.find(p=>p.id===pin).state,"released");assert(read(directory,"logical").generation<read(directory,"physical").generation);
  const db=new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:true});
  try{
    const ids=db.prepare("select id from protocol_records where activity_id=?").all(cut.activity);
    assert.equal(ids.filter(x=>x.id.includes(":dependency-discharge:")).length,1);assert.equal(db.prepare("select count(*) as n from protocol_effects").get().n,0);
  }finally{db.close();}
  save(directory,"verified",{activity:cut.activity,generation:store.generation,basis:retained.retentionBasis,pins:all,flush:await inspection.flushRecording(true)});
}
module.exports={install,inspect,beforeRelease,observeOpenHandoff};
