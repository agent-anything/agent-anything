const assert=require("node:assert/strict"),fs=require("node:fs"),{join}=require("node:path");
const {createHash}=require("node:crypto"),{DatabaseSync}=require("node:sqlite");
const hash=bytes=>"sha256:"+createHash("sha256").update(bytes).digest("hex");
const open=(directory,write=false)=>new DatabaseSync(join(directory,"execution","execution.sqlite"),{readOnly:!write});
const state=(db,id)=>JSON.parse(db.prepare("select value from protocol_activities where id=?").get(id).value);
const journalDigest=(db,id)=>hash(JSON.stringify(db.prepare("select id,revision,digest from protocol_records where activity_id=? order by id,revision").all(id)));

// Only the private copy is writable. Do not rewind an acceptance, reopen the task, or reissue its request.
function prepare(directory,source,mode,verified){
  const {activity,root,stageReceipt,limitation}=verified,b=limitation.metadata.basis;
  assert.equal(verified.reason,"original_response_unavailable");assert.equal(verified.status,"failed");
  const db=open(directory,true),registry=new DatabaseSync(join(directory,"provider-registry","registry.sqlite"),{readOnly:true});
  try{
    const s=state(db,activity),pin=registry.prepare("select binding_id,acceptance_id,state from pins where id=?").get(activity+":connection");
    assert.equal(pin.state,"confirmed");assert.equal(s.activity.scope.runId,root);assert(!s.accepted&&!s.cancelled&&!s.connectionRelease&&!s.retentionReleased);
    assert.equal(pin.binding_id,s.activity.composition.composition.configuration.connectionBinding.id);
    const ev=JSON.parse(db.prepare("select value from protocol_evidence_history where scope_id=? and kind=? and key=? and revision=?").get(b.scopeId,b.kind,b.key,b.revision).value);
    assert.equal(ev.activityId,activity);assert.equal(ev.content.digest,b.digest);assert.equal(ev.metadata.responseId,null);
    assert.equal(ev.metadata.disposition,"unresolved");
    const origin={evidence:source,mode,root,activity,sourceGeneration:verified.generation,pinAcceptance:pin.acceptance_id,
      input:s.input,contextInput:s.contextInput,journalDigest:journalDigest(db,activity),release:{bindingId:pin.binding_id,
        observation:{stageId:activity+":scheduled-observation:observe",receiptId:stageReceipt,
          limitation:{kind:"protocol_observation_unavailable",activityId:activity,reason:verified.reason,basis:b}}}};
    if(mode==="connection-integrity"){
      const row=db.prepare("select bytes from protocol_content_chunks where id=? and offset=0").get(ev.content.id);
      const bytes=Buffer.from(row.bytes);assert.equal(bytes.length,ev.content.bytes);assert.equal(hash(bytes),b.digest);
      bytes[0]^=1;origin.damaged={content:ev.content.id,offset:0,original:b.digest,actual:hash(bytes)};
      assert.equal(db.prepare("update protocol_content_chunks set bytes=? where id=? and offset=0").run(bytes,ev.content.id).changes,1);
    }
    fs.writeFileSync(join(directory,"origin.json"),JSON.stringify(origin,null,2),{flag:"wx"});
  }finally{db.close();registry.close();}
}

function check(directory,origin,released){
  const db=open(directory),id=origin.activity;
  try{
    const s=state(db,id);assert.deepEqual(s.input,origin.input);assert.deepEqual(s.contextInput,origin.contextInput);
    assert(!s.accepted&&!s.cancelled&&!s.retentionReleased&&!s.inputUseSettlement);
    assert.equal(journalDigest(db,id),origin.journalDigest,"original protocol operations changed");
    for(const table of ["protocol_effects","protocol_reconciliations","protocol_deliveries"])
      assert.equal(db.prepare("select count(*) n from "+table+" where activity_id=?").get(id).n,0);
    const facts=db.prepare("select sequence,value from protocol_facts where activity_id=? and json_extract(value,'$.kind')='connection_released'").all(id);
    assert.equal(facts.length,released?1:0);
    const fact=released?JSON.parse(facts[0].value):null;
    if(fact){assert.deepEqual(fact.value,origin.release);assert.deepEqual(s.connectionRelease,origin.release);}
    else assert.equal(s.connectionRelease,undefined);
    const u=db.prepare("select value from protocol_evidence_history where kind='usage' and json_extract(value,'$.activityId')=? order by rowid desc limit 1").get(id);
    const {costCoverage,exposure,inputTokens,outputTokens}=JSON.parse(u.value).metadata;
    assert.deepEqual([costCoverage,exposure,inputTokens,outputTokens],["unknown","unresolved",null,null]);
    return {acceptance:fact?.identity??null,sequence:facts[0]?.sequence??null,release:s.connectionRelease??null,exposure,costCoverage};
  }finally{db.close();}
}
module.exports={prepare,check};
