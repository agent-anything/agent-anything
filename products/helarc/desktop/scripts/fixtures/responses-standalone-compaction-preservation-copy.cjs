// Offline adjudication on a retained standalone-compaction copy. Controlled judge outputs are not new provider receipts.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),{join,resolve}=require("node:path");
const {pathToFileURL}=require("node:url"),{DatabaseSync}=require("node:sqlite"),{app}=require("electron");
const [dir,dbFile,runId]=process.argv.slice(2);
assert(dir&&dbFile&&runId);
const resultDir=fs.mkdtempSync(join(os.tmpdir(),"helarc-standalone-compaction-preservation-")),inspectionRoot=join(resultDir,"inspection");
app.setPath("userData",resultDir);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
globalThis.fetch=()=>{throw Error("No network permitted in offline assessment");};
const load=s=>import(pathToFileURL(resolve(__dirname,"../../dist/main",s+".js")));
let inspection,query;
async function run(){
  const {modelInputValueDigest:digest}=await import("@agent-anything/model-interaction/input");
  const {assessHelarcResponsesCompactByProbe,assessHelarcResponsesCompact,bindHelarcResponsesCompactSource}=await import("@agent-anything/helarc/controller");
  const db=new DatabaseSync(resolve(dbFile),{readOnly:true});
  let m;
  try{
    const raw=db.prepare("select value from activity_raw_results where id like ?").all(runId+":native-compact-method:%:stage:4%");
    assert.equal(raw.length,1);const v=JSON.parse(raw[0].value);
    m=(await load("execution-storage/ExecutionContent")).unpackExecutionContent(v,id=>({id,text:db.prepare("select value from execution_content where id=?").get(id).value})).value;
  }finally{db.close();}
  const original=m.request.execution.request,outcome=m.compact;
  const input=n=>JSON.parse(fs.readFileSync(join(dir,"generate-"+n+".wire"),"utf8")).input;
  const historic=JSON.parse(input(6)[0].content),priorProbe=input(5);
  assert.deepEqual(priorProbe.slice(0,-1),outcome.candidate.items);
  const duties=original.duties.map((d,i)=>i<2?{...d,revision:digest([d.revision,"offline-visible-contract"]),
    permittedEvidence:["direct",...d.permittedEvidence]}:d);
  const dutyBasis=original.dutyBasis.map((d,i)=>i===0?{...d,description:"Original workspace and permission background at issue; not subsequent changes."}:
    i===1?{...d,description:"Original user assignment, constraints and scope."}:d);
  // This is a new counterfactual quality judgment over the same bytes, not a revision of the historical Run.
  const source=bindHelarcResponsesCompactSource({...original,throughGroups:original.groups.length,receipts:original.groups.map(g=>({groupId:g.id,basis:g.deliveredBasis})),
    purpose:original.methodRequest.purpose,duties,dutyBasis,dependencies:{...original.dependencies,requirements:digest(duties)}});
  assert.equal(source.sourceDigest,original.sourceDigest);assert.equal(original.duties.length,6);
  const visible=duties.slice(0,2).map(d=>d.id),blind=duties.slice(2).map(d=>d.id),steps=[];
  const findingFor=(a,id)=>a.find(f=>f.dutyId===id);
  const findings=await assessHelarcResponsesCompactByProbe({source,outcome,procedure:"scoped_checks.v1",execute:async(step,items)=>{
    const request=JSON.parse(items.at(-1).content);assert.equal(request.format,"scoped_checks.v1");steps.push(step);
    const queries=historic.oracle.filter(q=>blind.includes(q.dutyId));let value;
    if(step==="oracle"){
      assert.deepEqual(request.duties.map(b=>b.dutyId),blind);
      assert.deepEqual(request.material,historic.material);
      value={queries:queries.map(({dutyId,question,expectedAnswer,basis})=>({dutyId,established:true,checks:[{question,expectedAnswer,basis}]}))};
    }else if(step==="probe"){
      assert.deepEqual(items.slice(0,-1),priorProbe.slice(0,-1));
      assert.deepEqual(request.questions.map(q=>q.question),queries.map(q=>q.question));
      assert(request.questions.every(q=>Object.keys(q).sort().join()==="checkId,question"));assert(!request.material&&!request.oracle);
      value={answers:request.questions.map(({checkId,question})=>{
        const id=queries.find(q=>q.question===question).dutyId,a=historic.answers.find(x=>x.dutyId===id);return {checkId,answer:a.answer,limitations:a.limitations};
      })};
    }else{
      assert.deepEqual(request.material,historic.material);assert.equal(request.answers.length,4);
      const q0=queries[0],q1=queries[1],writeCall=request.material.find(i=>i.type==="function_call"),created='"operation":"created"';
      assert(writeCall.call_id&&q0.expectedAnswer.includes(writeCall.call_id));assert(!/identifier|call.id|verbatim/i.test(q0.question));
      const answerExcerpt="the result cannot distinguish a new file from an overwrite";
      assert(request.answers[1].limitations.some(v=>v.includes(answerExcerpt)));
      assert(request.material.some(i=>i.type==="function_call_output"&&i.call_id===writeCall.call_id&&i.output.includes(created)));
      assert(q1.question.includes("receipt-write result"));
      value={coverage:queries.map(q=>({dutyId:q.dutyId,complete:q===q1,reason:q===q0?"Exact call identifier was not requested.":q===q1?"Write result explicitly requested.":"Not independently adjudicated in this replay."})),
        findings:request.oracle.map(({checkId,dutyId})=>({checkId,status:dutyId===q0.dutyId?"outside_question":dutyId===q1.dutyId?"contradicted":"not_established",
          reason:dutyId===q0.dutyId?"Identifier in private key but not in public question.":dutyId===q1.dutyId?"Recorded creation conflicts with inability to distinguish creation from overwrite.":"Outside the replay claims.",
          sourceExcerpt:dutyId===q1.dutyId?created:"",answerExcerpt:dutyId===q1.dutyId?answerExcerpt:""}))};
    }
    return {evidence:{acceptance:{id:"offline-controlled:"+step,revision:"1"}},assessment:{outcome:"valid",value}};
  }});
  assert.deepEqual(steps,["oracle","probe","judgment"]);
  for(const id of visible){const f=findingFor(findings,id);assert.equal(f.kind,"direct");assert.equal(f.conclusion,"supported");assert.equal(f.purposeReceipts.length,1);}
  assert.equal(findingFor(findings,blind[0]).conclusion,"unknown");assert.equal(findingFor(findings,blind[1]).conclusion,"unsupported");
  const assessment=assessHelarcResponsesCompact({source,candidate:outcome.candidate,findings});assert.equal(assessment.quality.allowed,false);
  inspection=await (await load("inspection/HelarcInspection")).HelarcInspection.create(join(resultDir,"settings.json"),inspectionRoot);
  const r=inspection.recorder,{helarcNativeInputRecords}=await load("inspection/HelarcNativeInputInspectionProjection");
  const stageId="offline-controlled:standalone-compaction-stage",records=[...helarcNativeInputRecords(r,{intent:{runId,purpose:{contract:{ref:{id:"helarc.responses-compact"}}}}},
    {request:{id:stageId,stageKind:"assessment"},result:{id:"offline-controlled:standalone-compaction-raw",recordedAt:new Date().toISOString(),value:{assessment}}})];
  assert.equal(records.length,6);
  for(const row of records)assert(await r.offerWhenReady(row));
  await inspection.flushRecording();
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");query=new InspectionQueryService(inspectionRoot);
  const subject=records[0].subject,snapshot=await query.query({kind:"get_snapshot",sourceId:subject.sourceId,datasetId:subject.datasetId});
  assert.equal(snapshot.coverage.rejected,0);assert.equal(snapshot.coverage.dropped,0);
  for(const row of records){
    const page=await query.query({...snapshot.selection,kind:"get_record",recordId:row.id}),saved=page.records[0],desc=saved.contents[0];
    assert.equal(desc.availability,"present");
    const detail=JSON.parse((await query.query({...snapshot.selection,kind:"get_content",contentId:desc.id,length:65536})).content.text);
    assert.equal(detail.admissible,false);assert.equal(detail.source,original.sourceDigest);
    assert.deepEqual(detail.finding,findingFor(findings,detail.finding.dutyId));
    for(const p of detail.finding.purposeReceipts)assert(saved.links.some(l=>l.to.id===p.id&&l.to.revision===p.revision));
  }
  const report={mode:"controlled offline adjudication, not model use or adoption",runId,source:source.sourceDigest,candidate:outcome.candidate.digest,
    outcomes:findings.map(f=>[f.dutyId,f.kind,f.conclusion]),admitted:false,inspector:{...snapshot.selection,rejected:0,dropped:0},resultDir};
  fs.writeFileSync(join(resultDir,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
app.whenReady().then(async()=>{let code=0;try{await run();}catch(e){console.error(e);code=1;}
  finally{await query?.close();await inspection?.close();app.exit(code);}});

