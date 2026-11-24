// Independent P06 probes. The source Run is opened read-only; each probe owns its output.
const {app}=require("electron");
const assert=require("node:assert/strict");
const {join,resolve}=require("node:path");
const {pathToFileURL}=require("node:url");
const {mkdtempSync,writeFileSync,readFileSync,mkdirSync}=require("node:fs");
const {tmpdir}=require("node:os");
const {randomUUID,createHash}=require("node:crypto");
const {DatabaseSync,backup}=require("node:sqlite");
const [card,source]=process.argv.slice(2);
const directory=mkdtempSync(join(tmpdir(),"helarc-p06-"+card+"-"));
app.setPath("userData",join(directory,"electron"));app.disableHardwareAcceleration();
const moduleAt=rel=>import(pathToFileURL(resolve(__dirname,rel)).href);
const emit=(name,data)=>writeFileSync(join(directory,name+".json"),JSON.stringify(data,null,2));
async function configuration(){
  const {ProviderRegistryClient}=await moduleAt("../../dist/main/provider/ProviderRegistryClient.js");
  const {ProviderConfigurationService}=await moduleAt("../../dist/main/provider/ProviderConfigurationService.js");
  const {defaultProviderDraft}=await moduleAt("../../dist/main/provider/ProviderDraftValidation.js");
  const observed=[],result={},configs=[],path=join(directory,"registry.sqlite");
  const client=await ProviderRegistryClient.open(path,e=>observed.push(e));
  let vault=0;const forbidden=new Proxy({},{get(){vault++;throw Error("unexpected credential dependency");}});
  const service=new ProviderConfigurationService(client,forbidden,forbidden);
  async function add(){configs.push((await service.save({configurationId:"provider-"+randomUUID(),updateId:randomUUID(),
    expectedRevision:null,draft:defaultProviderDraft("ollama.chat","fixture"),credential:{kind:"none"}})).configuration);}
  async function sample(name,count){observed.length=0;const rows=await service.list();assert.equal(rows.configurations.length,count);
    assert.deepEqual(observed.map(o=>o.operation),["list"]);assert.equal(vault,0);
    return result[name]={returned:count,...observed[0].work,vault};}
  try{await add();await sample("one",1);
    for(let i=1;i<48;i++)await add();
    await sample("active",48);
    for(const c of configs.slice(1))await service.archive(c.id,c.revision);
    const archived=await sample("archived",1);
    // Change only the independent execution history. No test double for registry SQL.
    mkdirSync(join(directory,"execution"));
    const orig=new DatabaseSync(join(source,"execution","execution.sqlite"),{readOnly:true});
    try{result.unrelatedFacts=orig.prepare("SELECT count(*) n FROM protocol_facts").get().n;
      assert(result.unrelatedFacts>0);await backup(orig,join(directory,"execution","execution.sqlite"));}finally{orig.close();}
    const withHistory=await sample("withHistory",1);
    assert.deepEqual(withHistory,archived);
    const sql=new DatabaseSync(path,{readOnly:true});
    try{result.plan=sql.prepare("EXPLAIN QUERY PLAN SELECT id,revision FROM configurations WHERE archived=0 ORDER BY id").all().map(r=>r.detail);}
    finally{sql.close();}
    return result;
  }finally{await client.close();}
}
async function trace(){
  const [normal,joint,readback]=process.argv.slice(4),json=(dir,name)=>JSON.parse(readFileSync(join(dir,name+".json"),"utf8"));
  const publicRead=json(readback,"investigations"),sha=x=>createHash("sha256").update(x).digest("hex");
  const n=json(normal,"siblings-audit"),seed=json(normal,"siblings-seed"),wire=json(normal,"peer-wire-hashes");
  const bytes=Buffer.from(seed.adoptedBody);
  assert.equal(n.sha256,sha(bytes));assert.equal(bytes.length,n.peerBytes);assert.equal(n.sha256,wire.at(-1));
  assert.equal(wire.length,new Set(wire).size);assert.equal(wire.length,n.parentRequests+n.alphaRequests+n.betaRequests);
  assert.equal(n.transfer.source.runId,n.transfer.beta);assert.equal(n.transfer.alphaStatus,"running");
  assert(seed.adoptedBody.includes(n.transfer.source.digest));
  const v=json(source,"verified"),scope=v.recording;
  const registry=new DatabaseSync(join(source,"provider-registry","registry.sqlite"),{readOnly:true});
  let pin,fact,registryId;
  try{pin=registry.prepare("SELECT * FROM pins WHERE id=?").get(v.activity+":connection");assert.equal(pin.binding_id,v.localReleaseBasis.bindingId);
    assert.equal(pin.state,"released");fact=registry.prepare("SELECT sequence FROM events WHERE kind='pin_released' AND subject_id=?").get(pin.id);
    registryId=registry.prepare("SELECT identity FROM registry").get().identity;}finally{registry.close();}
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),service=new InspectionQueryService(join(source,"inspection"));
  let exception;
  try{const {selection}=await service.query({kind:"get_snapshot",sourceId:scope.sourceId,datasetId:scope.datasetId});
    async function record(id){const r=await service.query({...selection,kind:"get_record",recordId:id});assert.equal(r.records.length,1);return r.records[0];}
    const logical=await record("protocol-execution:"+v.root+":"+v.inspectionEvidence.releaseEvent.split(":").at(-1));
    const physical=await record("provider-custody:"+registryId+":"+fact.sequence);
    assert(logical.links.some(l=>l.from.id===v.localReleaseBasis.observation.receiptId));
    assert(physical.links.some(l=>l.from.id===pin.id));
    const h=new DatabaseSync(join(source,"inspection","sources",scope.sourceId,"datasets",scope.datasetId,"inspection.sqlite"),{readOnly:true});
    let boundaries;try{boundaries=h.prepare("SELECT json_extract(from_key,'$[2]') AS src,json_extract(to_key,'$[2]') AS dst,kind,count(*) AS n FROM relations WHERE src='provider-custody' OR dst='provider-custody' GROUP BY 1,2,3").all();}finally{h.close();}
    exception={selection,logical:logical.id,physical:physical.id,pin:pin.id,logicalLinks:logical.links.length,physicalLinks:physical.links.length,boundaries,
      observation:v.localReleaseBasis.observation.receiptId,exposure:v.exposure,costCoverage:v.costCoverage};
  }finally{await service.close();}
  const bg=json(joint,"background-compact-received"),end=json(joint,"result").phases.at(-1),io=publicRead.find(x=>x.root===end.beforeUse.runId);
  assert(io);assert.equal(bg.decision,end.beforeUse.decision);
  const e=new DatabaseSync(join(joint,"execution","execution.sqlite"),{readOnly:true});let kinds;
  try{assert.equal(e.prepare("SELECT run_id FROM protocol_activities WHERE id=?").get(bg.activity).run_id,io.root);
    kinds=e.prepare("SELECT json_extract(value,'$.kind') AS kind,count(*) AS n FROM protocol_facts WHERE activity_id=? GROUP BY 1").all(bg.activity);
    assert.equal(kinds.find(k=>k.kind==="dispatch_intent").n,1);}finally{e.close();}
  const timings=["execution-performance.previous","execution-performance"].map(name=>{
    const s=json(joint,name);return {pid:s.processId,retained:s.requestEvidence.requests.length,evicted:s.requestEvidence.evictedRequests,
      containingBackgroundIdentity:s.requestEvidence.requests.filter(r=>JSON.stringify(r).includes(bg.activity)).length};});
  return {normal:{tree:n.transfer.commit,child:n.transfer.beta,report:n.transfer.source.digest,reportBytes:n.transfer.source.bytes,
    adopted:seed.acceptance,sentSHA256:n.sha256,sentBytes:bytes.length,peerCreates:wire.length,measures:json(normal,"measurements").length,
    effectAttempts:seed.physicalWriteAttempts,investigation:publicRead.find(x=>x.root===n.transfer.root)},
    exception,joint:{root:io.root,decision:bg.decision,background:bg.activity,compactInput:bg.input,backgroundFactCounts:kinds,
      taskPosts:json(joint,"requests").length,measurements:json(joint,"measurements").length,physicalWriteAttempts:end.physicalWriteAttempts,
      inspection:io,timings}};
}
async function recorderEnvironment(){
  const {InspectionRecorder}=await import("@agent-anything/inspection/recording");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  const {DEFAULT_INSPECTION_CAPTURE_POLICY:policy}=await import("@agent-anything/inspection/content");
  const root=join(directory,"inspection");
  const rec=await InspectionRecorder.create({root,application:"p06-proof",name:"P06 proof",policy:{...policy,agent:true,provider:true}});
  const query=new InspectionQueryService(root);
  const scope={sourceId:rec.source.sourceId,datasetId:rec.manifest.datasetId};
  const snap=()=>query.query({...scope,kind:"get_snapshot"});
  return {root,rec,query,policy,snap,close:async()=>{try{await rec.flush(true);}finally{await query.close();}}};
}
async function release(){
  const {activity}=JSON.parse(readFileSync(join(source,"verified.json")));
  const pinId=activity+":connection",regPath=join(directory,"registry.sqlite"),ex=join(directory,"execution");
  mkdirSync(ex);
  for(const [relative,dest] of [["execution/execution.sqlite",join(ex,"execution.sqlite")],["provider-registry/registry.sqlite",regPath]]){
    const db=new DatabaseSync(join(source,relative),{readOnly:true});try{await backup(db,dest);}finally{db.close();}
  }
  const {HelarcExecutionStore}=await moduleAt("../../dist/main/execution-storage/HelarcExecutionStore.js");
  const {ProviderRegistryClient}=await moduleAt("../../dist/main/provider/ProviderRegistryClient.js");
  const {ProtocolJournalInspectionAdapter}=await moduleAt("../../dist/main/inspection/ProtocolJournalInspectionAdapter.js");
  const {ProviderCustodyInspectionAdapter}=await moduleAt("../../dist/main/inspection/ProviderCustodyInspectionAdapter.js");
  const {connectionReleaseReader,releaseBasisSubject}=await moduleAt("../../dist/main/inspection/ConnectionReleaseInspection.js");
  const store=await HelarcExecutionStore.open(ex),registry=await ProviderRegistryClient.open(regPath);
  const {rec,query,snap,close}=await recorderEnvironment();
  try{
    const journal=store.protocolJournal,readPin=id=>registry.request({kind:"read_pin",id}),read=connectionReleaseReader(journal,readPin);
    const basis=await read(pinId);assert.equal(basis.activityId,activity);
    const pin=await readPin(pinId);await assert.rejects(connectionReleaseReader(journal,async()=>({...pin,bindingId:"different"}))(pinId),/release_scope_changed/);
    const all=async(fn)=>{const a=[];for(;;){const page=await fn(a.at(-1)?.sequence??0);if(!page.length)return a;a.push(...page);}};
    const facts=()=>all(after=>journal.command({kind:"facts",runId:basis.runId,after,limit:100}));
    const events=()=>all(after=>registry.request({kind:"events",after,limit:100}));
    const f=await facts(),e=await events(),logical=f.filter(x=>x.kind==="connection_released"&&x.activityId===activity),
      physical=e.filter(x=>x.kind==="pin_released"&&x.subjectId===pinId);assert.equal(logical.length,1);assert.equal(physical.length,1);
    assert.deepEqual(basis.release,logical[0].value);
    const registryId=await registry.request({kind:"identity"}),physicalSubject=rec.ref("provider-custody","event",registryId+":"+physical[0].sequence,null);
    const b=releaseBasisSubject(rec,basis),logicalSubject=rec.ref("protocol-execution","event","protocol-execution:"+logical[0].sequence,basis.runId);
    const project=new ProtocolJournalInspectionAdapter({ref:rec.ref.bind(rec),offer:rec.offer.bind(rec)});
    const importReceipt=()=>new ProviderCustodyInspectionAdapter(rec,registryId,read).replay(async after=>physical.filter(x=>x.sequence>after));
    const graph=async(kind,subject)=>{await rec.flush();return (await query.query({...(await snap()).selection,kind,subject})).graph.links;};
    project.observe(logical[0],"import");assert(!(await graph("get_execution",b)).some(x=>x.kind==="settles"));
    await importReceipt();
    const edges=[...(await graph("get_data_flow",logicalSubject)),...(await graph("get_execution",physicalSubject))];
    assert(edges.some(x=>x.from.id===logicalSubject.id&&x.to.id===b.id&&x.operation==="authorizes_local_release"));
    assert(edges.some(x=>x.from.id===b.id&&x.to.id===physicalSubject.id&&x.operation==="physical_pin_release"));
    assert((await graph("get_execution",b)).some(x=>x.to.id===physicalSubject.id));
    assert((await graph("get_data_flow",b)).some(x=>x.from.id===logicalSubject.id));
    assert.deepEqual(await facts(),f);assert.deepEqual(await events(),e);assert.deepEqual(await readPin(pinId),pin);
    assert.equal(rec.health().rejected,0);assert.equal(rec.health().dropped,0);
    return {source,run:basis.runId,logical:logicalSubject.id,basis:b.id,physical:physicalSubject.id,logicalOnlyHadNoReceipt:true,
      wrongBindingRejected:true,factsUnchanged:f.length,registryEventsUnchanged:e.length,watermark:(await snap()).selection};
  }finally{await close();await registry.close();await store.close();}
}
async function gap(){
  const {ProviderCustodyInspectionAdapter}=await moduleAt("../../dist/main/inspection/ProviderCustodyInspectionAdapter.js");
  const ref=JSON.parse(readFileSync(join(source,"verified.json"),"utf8"));
  const sql=new DatabaseSync(join(source,"provider-registry","registry.sqlite"),{readOnly:true});
  const pin=()=>sql.prepare("SELECT * FROM pins WHERE id=?").get(ref.activity+":connection");
  const event=sql.prepare("SELECT sequence,kind,subject_id subjectId,occurred_at occurredAt FROM events WHERE kind='pin_released' AND subject_id=?").get(ref.activity+":connection");
  const registryId=sql.prepare("SELECT identity FROM registry").get().identity;
  const before=pin();assert.equal(before.state,"released");assert(event);
  const {rec,query,snap,close}=await recorderEnvironment();
  let inject=true;
  // Simulate a damaged inspection envelope after the source commit, not an execution failure.
  const endpoint={ref:rec.ref.bind(rec),confirmNativeWork:rec.confirmNativeWork.bind(rec),
    offerWhenReady:input=>rec.offerWhenReady(inject?{...input,occurredAt:"not-an-instant",payload:{...input.payload,kind:"not-an-inspection-payload"}}:input)};
  const projection=new ProviderCustodyInspectionAdapter(endpoint,registryId);
  const reader=async(after)=>after<event.sequence?[event]:[];
  async function view(){await rec.flush();const s=await snap(),recordId="provider-custody:"+registryId+":"+event.sequence;
    const page=await query.query({...s.selection,kind:"get_record",recordId});
    return {scope:s.selection,recordId,present:page.records.length,commit:page.records[0]?.commitSequence??null,
      accepted:s.coverage.recording.ingress.accepted,rejected:s.coverage.rejected,dropped:s.coverage.dropped,
      issues:s.coverage.recording.ingress.issues,status:s.coverage.status};}
  try{
    await assert.rejects(projection.replay(reader),/provider_custody_replay_rejected/);
    const absent=await view();assert.equal(absent.present,0);assert.equal(absent.rejected,1);assert.deepEqual(pin(),before);
    inject=false;await projection.replay(reader);const repaired=await view();
    assert.equal(repaired.present,1);assert.equal(repaired.rejected,1);
    await projection.replay(reader);const again=await view();assert.equal(again.present,1);
    assert.equal(again.commit,repaired.commit);assert.equal(again.accepted,repaired.accepted);assert.deepEqual(pin(),before);
    return {eventSequence:event.sequence,absent,repaired,repeatedCommit:again.commit,pin:before.state};
  }finally{sql.close();await close();}
}
async function waitEdges(){
  const {rec,query,snap,close}=await recorderEnvironment();
  const {ExecutionPerformanceInspectionAdapter}=await moduleAt("../../dist/main/inspection/ExecutionPerformanceInspectionAdapter.js");
  const {IdentifiedWorkTiming}=await moduleAt("../../dist/main/diagnostics/IdentifiedWorkTiming.js");
  const {RunTranscriptInspectionAdapter}=await import("@agent-anything/inspection/adapters");
  try{
    const parent="parent",child="child",adapter=new ExecutionPerformanceInspectionAdapter(rec);
    const timing=new IdentifiedWorkTiming(s=>adapter.workBoundary(s));
    const work={owner:"protocol-execution",kind:"model-activity",id:"original",runId:parent},awaited={owner:"activity",kind:"contribution",id:"receipt",runId:parent};
    await timing.measure(1,{work,phase:"observation_receipt",awaited},async()=>null);
    const transcript=new RunTranscriptInspectionAdapter(rec);
    for(const [i,transition] of ["opened","resolved"].entries())transcript.observe({runId:parent,item:{ref:{id:"pending-"+i,sequence:i+1},createdAt:new Date().toISOString(),
      payload:{kind:"pending_transition",transition,pending:{kind:"descendant_run",required:true,relationId:"delegation",childRunId:child,branchId:"call"},recordRef:null}}});
    await rec.flush();const s=await snap();
    assert.equal(s.coverage.rejected,0);assert.equal(s.coverage.dropped,0);
    const deps=subject=>query.query({...s.selection,kind:"get_dependencies",subject});
    assert((await deps(rec.ref(awaited.owner,awaited.kind,awaited.id,parent))).graph.links.some(l=>l.operation==="awaited_by_this_invocation"&&l.condition==="settled"));
    assert((await deps(rec.ref("runtime","action","call",parent))).graph.links.some(l=>l.from.id==="delegation:required-boundary"&&l.condition==="settled"));
    return {selection:s.selection,rejected:s.coverage.rejected};
  }finally{await close();}
}
async function views(){
  const {root,rec,query,policy,snap,close}=await recorderEnvironment();
  const {startInspectorServer}=await moduleAt("../../../../../tooling/inspector/dist/server/InspectorServer.js");
  const server=await startInspectorServer({root,assets:directory});
  const sample=[],work=[],scope=rec.ref("runtime","run","chosen","chosen");
  async function add(id,selected=false,bytes=0){
    const subject=selected?scope:rec.ref("runtime","run","unrelated","unrelated");
    assert(await rec.offerWhenReady({id,subject,occurredAt:null,payload:{kind:"event",name:"probe",sequence:null,code:null},
      contents:bytes?[{class:"agent",stage:"received",mediaType:"text/plain",name:id,value:"x".repeat(bytes)}]:[]}));
  }
  const list=async()=>{await rec.flush();const s=await snap();const page=await query.query({...s.selection,kind:"list_records",subject:scope,limit:2});
    assert.deepEqual(page.records.map(r=>r.id),["first","second"]);assert.equal(page.readWork.bodyReads,0);
    work.push({watermark:s.selection.watermark,ids:page.records.map(r=>r.id),...page.readWork});return {s,page};};
  const post=(route,value,cookie)=>fetch(server.url+route,{method:"POST",headers:{"Content-Type":"application/json",Origin:server.url,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(value)});
  try{
    await add("first",true,32);await add("second",true,20);await add("third",true);
    const bytes=card==="views-large"?96*1024:32;
    await add("size-control",false,bytes);const first=await list();
    const desc=(await query.query({...first.s.selection,kind:"get_record",recordId:"size-control"})).records[0].contents[0];
    assert.equal(desc.retainedBytes,bytes);
    const database=new DatabaseSync(join(root,"sources",scope.sourceId,"datasets",scope.datasetId,"inspection.sqlite"),{readOnly:true});
    let plan;try{plan=database.prepare("EXPLAIN QUERY PLAN SELECT value FROM records WHERE subject_key=? AND sequence<=? AND sequence>? ORDER BY sequence LIMIT ?").all("",4,0,3).map(r=>r.detail);}finally{database.close();}
    if(card==="views-large")return {work,unrelatedRetainedBytes:bytes,plan};
    for(let i=0;i<128;i++)await add("history-"+i);
    const {s,page}=await list();
    const login=await post("/api/session",{token:new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get("bootstrap")});
    assert.equal(login.status,200);const cookie=login.headers.get("set-cookie").split(";")[0];
    const q={...s.selection,kind:"get_content",contentId:page.records[0].contents[0].id};
    const route="/api/inspection/content/"+encodeURIComponent(q.contentId)+"?"+new URLSearchParams(s.selection);
    const get=()=>fetch(server.url+route,{headers:{Cookie:cookie}});
    async function check(res,status,code){const body=await res.json();assert.equal(res.status,status);
      if(code){assert.equal(body.code,code);assert.equal(body.content,undefined);}sample.push([status,code??"permitted"]);}
    await check(await get(),200);
    rec.setPolicy({...policy,agent:false,revision:"p06-revoked"});
    await check(await post("/api/inspection/query",q,cookie),403,"inspection_access_denied");
    await check(await get(),403,"inspection_access_denied");
    const other={...q,contentId:page.records[1].contents[0].id};
    await check(await post("/api/inspection/query",other,cookie),403,"inspection_access_denied");
    await check(await post("/api/inspection/query",{...s.selection,kind:"list_records",limit:2},cookie),200);
    const revoked=await fetch(server.url+"/api/session",{method:"DELETE",headers:{Cookie:cookie,Origin:server.url}});
    assert.equal(revoked.status,200);await check(await get(),401,"inspection_session_required");
    await check(await post("/api/inspection/query",{...s.selection,kind:"list_records",limit:2},cookie),401,"inspection_session_required");
    return {work,unrelatedRetainedBytes:bytes,plan,requests:sample};
  }finally{await server.close();await close();}
}
app.whenReady().then(async()=>{
  const run={configuration,gap,views,"views-large":views,trace,release,"wait-edges":waitEdges,"joint-work":()=>require("./p06-joint-work.cjs")(source)}[card];assert(run);
  const evidence=await run();emit("result",{electron:process.versions.electron,...evidence});app.exit(0);
}).catch(error=>{emit("failure",{error:String(error.stack??error)});app.exit(1);});
console.log("P06 evidence: "+directory);
