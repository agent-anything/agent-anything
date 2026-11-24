const {app}=require("electron"),assert=require("node:assert/strict"),{join}=require("node:path"),{pathToFileURL}=require("node:url");
const {mkdir,writeFile,readFile}=require("node:fs/promises");
const [execution,output,phase="capture"]=process.argv.slice(2);
app.setPath("userData",join(output,`electron-${phase}`));app.disableHardwareAcceleration();
let store,recorder,queries;
async function main(){
  const started=performance.now();
  await mkdir(output,{recursive:true});
  const load=path=>import(pathToFileURL(join(__dirname,"../../dist/main",path)));
  const {HelarcExecutionStore}=await load("execution-storage/HelarcExecutionStore.js");
  const {ProtocolJournalInspectionAdapter}=await load("inspection/ProtocolJournalInspectionAdapter.js");
  const {InspectionRecorder}=await import("@agent-anything/inspection/recording");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  const {InspectionDatabase}=await import("@agent-anything/inspection/storage");
  const {datasetDirectory}=await import("@agent-anything/inspection/sources");
  const {createHelarcNativePresentationReader}=await import("@agent-anything/helarc/run");
  const presentation=await import(pathToFileURL(join(__dirname,"../../node_modules/@agent-anything/helarc/dist/run/presentation/HelarcRunPresentation.js")));
  const {createRunTranscriptRecord}=await import("@agent-anything/agent-runtime/transcript");
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {presentConversationWork}=await load("workbench/ConversationPresentation.js");
  let selection,expected;
  queries=new InspectionQueryService(output);
  if(phase==="capture"){
    store=await HelarcExecutionStore.open(join(execution,"execution"));
    const tree=await store.readRunTree("root");assert(tree.members.length>=4);
    const original=digest(tree.members.map(m=>({state:m.head.state,lineage:m.admission.lineage})));
    recorder=await InspectionRecorder.create({root:output,application:"native-batch9",name:"Native protocol investigation",
      policy:{revision:"1",enabled:true,definition:true,agent:true,provider:true,execution:true}});
    const adapter=new ProtocolJournalInspectionAdapter(recorder);adapter.bindContentReader(store.protocolJournal,store.contextSelections);
    const reader=createHelarcNativePresentationReader(store.protocolJournal);
    let projected=presentation.createHelarcRunPresentation(),accepted=0,settled=0;
    const root=recorder.ref("runtime","run","root","root");
    for(const member of tree.members){
      const runId=member.head.state.run.id,lineage=member.admission.lineage;
      projected=presentation.labelHelarcRunPresentation(projected,runId,lineage,"Root assignment");
      const subject=recorder.ref("runtime","run",runId,runId);
      recorder.offer({subject,occurredAt:null,payload:{kind:"snapshot",status:member.head.state.status,revision:member.head.state.revision,
        agentId:member.head.state.activeAgent.id,parentRunId:lineage.kind==="descendant"?lineage.parent.id:null,taskId:null}});
      await adapter.replay((after,limit)=>store.protocolJournal.command({kind:"facts",runId,after,limit}));
      await adapter.replay((after,limit)=>store.materialDeliveryFacts(runId,after,limit));
      for(const item of member.head.state.items){
        const record=createRunTranscriptRecord(item),evidence=item.payload.kind==="controller_turn"?item.payload.modelItems.find(m=>m.kind==="native_purpose_evidence")?.evidence:null;
        const native=evidence?await reader.read(evidence):undefined;
        projected=presentation.appendHelarcRunPresentation(projected,record,native);
        assert.equal(presentation.appendHelarcRunPresentation(projected,record,native),projected,"replay must not duplicate Product entries");
        if(evidence)accepted++;if(item.payload.kind==="model_call_settlement")settled++;
      }
    }
    await adapter.flush();const flushed=await recorder.flush();
    assert.equal(flushed.native,"settled",JSON.stringify({flushed,health:recorder.health()}));
    assert.equal(recorder.health().dropped,0,JSON.stringify(recorder.health()));
    const snapshot=await queries.query({kind:"get_snapshot",sourceId:root.sourceId,datasetId:root.datasetId});selection=snapshot.selection;assert(selection);
    assert(projected.records.some(r=>r.origin?.nativeSource));assert(projected.records.every(r=>!r.origin?.nativeSource||r.origin.turnId===null));
    assert(!projected.records.some(r=>r.content.title==="Response display unavailable"));
    assert(projected.labels.filter(l=>l.parentRunId!==null).every(l=>l.parentOrigin?.nativeSource),"actual Agent calls must own each Child");
    const groups=[];
    const projection={productRunId:"product",harnessRunId:"root",host:{runId:"root",sequence:1,status:"completed",pendingInteractions:[],runTree:{nodes:tree.members.map(m=>({runId:m.head.state.run.id,status:m.head.state.status,parentRunId:m.admission.lineage.kind==="descendant"?m.admission.lineage.parent.id:null}))}},
      product:{sequence:1,presentation:projected,commands:[],responses:{attempts:[],revision:0,omittedAttempts:0,retainedBytes:0}}};
    for(const member of tree.members){
      const work=presentConversationWork({thread:{id:"thread"},messages:[]},"product",1,projection,false,member.head.state.run.id);
      groups.push(work);
    }
    assert.equal(digest((await store.readRunTree("root")).members.map(m=>({state:m.head.state,lineage:m.admission.lineage}))),original,"inspection must not change execution progress");
    expected={original,accepted,settled,projection:digest(projected),groups:digest(groups),members:tree.members.length};
    await writeFile(join(output,"product.json"),JSON.stringify({projection,groups},null,2));
    await writeFile(join(output,"selection.json"),JSON.stringify({selection,expected},null,2));
    const closure=await recorder.flush(true);assert.equal(closure.native,"settled");assert.equal(closure.unpersisted,0);assert.equal(closure.unconfirmed,0);assert.equal(closure.code,null);
    assert(["settled","incomplete"].includes(closure.projection));
    const captureHealth=recorder.health();recorder=null;await store.close();store=null;
    await writeFile(join(output,"capture.json"),JSON.stringify({phase,pid:process.pid,electron:process.versions.electron,selection,expected,closure,captureHealth,elapsedMs:performance.now()-started},null,2));
    return;
  }else({selection,expected}=JSON.parse(await readFile(join(output,"selection.json"),"utf8")));
  const read=async query=>queries.query({...selection,...query});
  let after,entries=[],listPages=0;
  do{const page=await read({kind:"list_native_interactions",limit:2,runId:"root",includeDescendants:true,...(after?{after}: {})});
    assert.equal(page.readWork.bodyReads,0);entries.push(...page.records);after=page.next;listPages++;}while(after);
  assert(entries.length>=expected.accepted);assert.equal(new Set(entries.map(r=>r.id)).size,entries.length);
  const rootOnly=await read({kind:"list_native_interactions",limit:100,runId:"root"});assert(rootOnly.records.length<entries.length);
  assert(rootOnly.records.every(r=>r.subject.runId==="root"));
  let bodies=0,loadedBytes=0,returnedBytes=0,contentPages=0,nativeItems=0,inputs=0,gaps=[];
  const ids=[];
  const sampled=new Set();
  for(const entry of entries){let cursor;
    do{const page=await read({kind:"get_native_interaction",subject:entry.subject,limit:37,...(cursor?{after:cursor}:{})});
      assert.equal(page.readWork.bodyReads,0);ids.push(...page.records.map(r=>r.id));
      for(const fact of page.records){
        if(fact.payload.kind!=="native_fact")continue;
        if(fact.payload.category==="output")nativeItems++;
        if(fact.payload.category==="input")inputs++;
        if(fact.payload.limitation)gaps.push(fact.payload.limitation);
        for(const c of fact.contents.slice(0,1)){
          if(c.availability!=="present")continue;
          const sampleKey=`${entry.id}:${fact.payload.category}:${c.name}`;
          if(sampled.has(sampleKey))continue;sampled.add(sampleKey);
          const body=await read({kind:"get_content",contentId:c.id,length:4096});
          assert.equal(body.content.descriptor.availability,"present");assert(body.readWork.loadedBodyBytes<=2*65536);
          bodies++;loadedBytes+=body.readWork.loadedBodyBytes;returnedBytes+=body.readWork.returnedBodyBytes;contentPages++;
        }
      }cursor=page.next;
    }while(cursor);
  }
  assert(nativeItems>0);assert(inputs>0);assert(!gaps.includes("native_capture_unavailable"));
  if(phase==="repair-start"){
    const db=new InspectionDatabase(datasetDirectory(output,selection.sourceId,selection.datasetId),undefined,{writable:true});
    db.resetProcessProjection();const target=db.process.progress().target;db.rebuildProcessProjection(target,1);db.close();
  }
  if(phase==="repair-finish"){
    const db=new InspectionDatabase(datasetDirectory(output,selection.sourceId,selection.datasetId),undefined,{writable:true});
    const target=db.process.progress().target;
    while(db.process.progress().status!=="live")db.rebuildProcessProjection(target,100);db.close();
    const original=JSON.parse(await readFile(join(output,"repair-start.json"),"utf8"));assert.equal(digest(ids),original.recordIds);
    const first=entries[0],page=await read({kind:"get_native_interaction",subject:first.subject,limit:100});
    const c=page.records.flatMap(r=>r.contents).find(c=>c.availability==="present");assert(c);
    const policy=join(output,"sources",selection.sourceId,"read-policy.json"),old=await readFile(policy,"utf8");
    try{await writeFile(policy,JSON.stringify({...JSON.parse(old),revision:"revoked",provider:false}));
      await assert.rejects(()=>read({kind:"get_content",contentId:c.id}),/inspection_access_denied/);
      assert((await read({kind:"get_native_interaction",subject:first.subject,limit:100})).records.length>0);
    }finally{await writeFile(policy,old);}
  }
  const report={phase,pid:process.pid,electron:process.versions.electron,selection,expected,activities:entries.length,listPages,contentPages,bodies,loadedBytes,returnedBytes,nativeItems,inputs,gaps:[...new Set(gaps)],recordIds:digest(ids),elapsedMs:performance.now()-started};
  await writeFile(join(output,`${phase}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
app.whenReady().then(main).then(async()=>{await queries?.close();app.exit(0);}).catch(async error=>{
  await mkdir(output,{recursive:true});await writeFile(join(output,`failure-${phase}.txt`),String(error.stack??error));
  try{await queries?.close();await recorder?.flush(true);await store?.close();}finally{app.exit(1);}
});
