// Historical input and real saved blind answers, with explicitly controlled source-side grading.
const {app}=require("electron"),{DatabaseSync}=require("node:sqlite"),fs=require("node:fs"),assert=require("node:assert/strict");
const {join,resolve}=require("node:path"),{tmpdir}=require("node:os"),{pathToFileURL}=require("node:url"),{createHash}=require("node:crypto");
const {rubric,annotations}=require("./responses-standalone-compaction-fact-rubric.cjs"),dir=process.argv[2];
const dest=fs.mkdtempSync(join(tmpdir(),"helarc-source-use-"));app.setPath("userData",dest);app.disableHardwareAcceleration();
globalThis.fetch=()=>{throw Error("offline only");};
const read=n=>JSON.parse(fs.readFileSync(join(dir,n))),load=n=>import(pathToFileURL(resolve(__dirname,"../../dist/main",n+".js")));
let inspection,query;
async function run(){
  const {assessHelarcResponsesCompactByProbe,assessHelarcResponsesCompact}=await import("@agent-anything/helarc/controller");
  const history=JSON.parse(read("generate-6.wire").input[0].content),{root}=read("evidence.json");
  const original=history.oracle.map(o=>{const a=history.answers.find(a=>a.checkId===o.checkId);return [o.question,a.answer,a.limitations];});
  assert.equal(createHash("sha256").update(JSON.stringify(original)).digest("hex"),"17f9cbaf3fe97fbb0e9efb937a57deff002ac1742f2522bb681dec1ae83fe1a6");
  const db=new DatabaseSync(resolve(dir,"../profile/Helarc/execution/execution.sqlite"),{readOnly:true});let source,outcome;
  try{
    const [row]=db.prepare("select value from activity_raw_results where id like ?").all(root+":native-compact-method:%:stage:4%");
    const m=(await load("execution-storage/ExecutionContent")).unpackExecutionContent(JSON.parse(row.value),id=>({id,text:db.prepare("select value from execution_content where id=?").get(id).value})).value;
    source=m.request.execution.request;outcome=m.compact;assert.equal(m.assessment.quality.allowed,false);
  }finally{db.close();}
  const groups=source.manifest.groups.slice(0,source.groups.length),facts=rubric(groups,history.duties,read("case.json").truth).filter(f=>f.required);
  const alias=g=>"g"+(1+groups.findIndex(x=>x.id===g)),reports=[];
  const inspectionRoot=join(dest,"inspection"),{HelarcInspection}=await load("inspection/HelarcInspection");
  const {helarcNativeInputRecords}=await load("inspection/HelarcNativeInputInspectionProjection");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");
  inspection=await HelarcInspection.create(join(dest,"settings.json"),inspectionRoot);
  query=new InspectionQueryService(inspectionRoot);
  const independent={created:["/result/output/operation",'"created"'],extent:["/result/output/truncated","false"]};
  for(const variant of ["continuation","effect-mismatch","recipient-must-distinguish-effect","contradicted-correction","missing-scope"]){
    const steps=[],selected=new Map();
    const findings=await assessHelarcResponsesCompactByProbe({procedure:"source_and_use.v1",source,outcome,execute:async(step,items)=>{
      steps.push(step);let value;const req=JSON.parse(items.at(-1).content);
      if(step==="oracle")value={requirements:facts.map((f,i)=>{
        const rule=variant==="recipient-must-distinguish-effect"&&f.key==="created"?null:independent[f.key];
        const q=annotations.findIndex(row=>row.some(([k])=>k===f.key));selected.set("r"+(i+1),q);
        const sources=f.sources.map(a=>({group:alias(a.groupId),excerpt:a.excerpt}));
        return {duties:f.dutyIds.map(id=>"d"+(1+history.duties.findIndex(d=>d.dutyId===id))),claim:f.claim,necessity:f.necessity,sources,
          use:rule?"original_receipt":"recipient",question:rule?"":original[q][0],resultGroup:rule?sources[0].group:"",
          pointer:rule?.[0]??"",expectedJson:variant==="effect-mismatch"&&f.key==="created"?'"overwritten"':rule?.[1]??""};
      })};
      if(step==="probe"){
        assert.deepEqual(items.slice(0,-1),read("generate-5.wire").input.slice(0,-1));assert(!req.requirements&&!req.groups&&!req.duties);
        value={answers:req.questions.map(q=>{assert.deepEqual(Object.keys(q).sort(),["id","question"]);const n=selected.get(q.id);
          assert.equal(original[n][0],q.question);
          return {id:q.id,answer:variant==="contradicted-correction"&&facts[Number(q.id.slice(1))-1].key==="correction"?"The draft remains current.":original[n][1]};
        })};
      }
      if(step==="judgment")value={reviews:req.requirements.map(r=>{
        const f=facts[Number(r.id.slice(1))-1],receipt=r.use==="original_receipt",neg=f.key==="correction"&&variant==="contradicted-correction";
        return {id:r.id,source:"supported",sourceReason:"Compared with the frozen original.",coverage:receipt?"not_applicable":"asked",
          quality:receipt?"not_assessed":neg?"contradicted":annotations[selected.get(r.id)].find(([k])=>k===f.key)[1],
          reason:"Historical answer assessed for this purpose.",answerExcerpt:req.answers.find(a=>a.id===r.id)?.answer??""};
      }),duties:req.duties.map((d,i)=>({id:d.id,complete:variant!=="missing-scope"||i!==0,reason:"Reviewed assigned purpose."})),
      publicClaims:{conclusion:"supported",reason:"Isolate each per-requirement verdict."}};
      return {evidence:{acceptance:{id:"offline:"+variant+":"+step,revision:"1"}},assessment:{outcome:"valid",value}};
    }});
    assert.deepEqual(steps,["oracle","probe","judgment"]);
    const assessment=assessHelarcResponsesCompact({source,candidate:outcome.candidate,findings}),quality=assessment.quality;
    assert.equal(quality.allowed,variant==="continuation",JSON.stringify(findings.map(f=>f.limitations)));
    const created=findings.flatMap(f=>f.factAssessments??[]).find(f=>f.claim===facts.find(r=>r.key==="created").claim);
    if(variant==="continuation")assert(created.receiptWitness.callId&&created.status==="demonstrated"&&!created.checks.length);
    if(variant==="effect-mismatch")assert.equal(created.status,"contradicted");
    if(variant==="recipient-must-distinguish-effect")assert.equal(created.status,"insufficient");
    if(variant==="continuation"||variant==="effect-mismatch"){
      const rec=inspection.recorder;
      const records=[...helarcNativeInputRecords(rec,{intent:{runId:root,purpose:{contract:{ref:{id:"helarc.responses-compact"}}}}},
        {request:{id:"offline:"+variant,stageKind:"assessment"},result:{id:"offline:raw:"+variant,recordedAt:new Date().toISOString(),value:{assessment}}})];
      for(const record of records)assert(await rec.offerWhenReady(record));await inspection.flushRecording();
      const {sourceId,datasetId}=records[0].subject,snapshot=await query.query({kind:"get_snapshot",sourceId,datasetId});
      assert.equal(snapshot.coverage.dropped,0);assert.equal(snapshot.coverage.rejected,0);
      let found=false;
      for(const row of records.filter(r=>r.payload.executionKind==="preservation_fact")){
        const saved=(await query.query({...snapshot.selection,kind:"get_record",recordId:row.id})).records[0];
        const value=JSON.parse((await query.query({...snapshot.selection,kind:"get_content",contentId:saved.contents[0].id,length:65536})).content.text);
        if(value.fact.id===created.id){assert.deepEqual(value.fact,created);assert(created.receiptWitness.observedDigest);found=true;}
      }
      assert(found,"Receipt evidence was not readable through Inspector.");
    }
    reports.push({variant,allowed:quality.allowed,created:created.status});
  }
  console.log(JSON.stringify({root,dest,reports}));fs.writeFileSync(join(dest,"result.json"),JSON.stringify(reports));
}
app.whenReady().then(async()=>{let code=0;try{await run();}catch(e){console.error(e);code=1;}finally{await query?.close();await inspection?.close();app.exit(code);}});
