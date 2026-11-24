// Offline re-analysis. Source is read-only. Semantic annotations are not historical model receipts.
const {app}=require("electron"),{DatabaseSync}=require("node:sqlite"),{createHash}=require("node:crypto"),fs=require("node:fs"),os=require("node:os");
const {join,resolve}=require("node:path"),{pathToFileURL}=require("node:url"),assert=require("node:assert/strict");
const {rubric,annotations}=require("./responses-standalone-compaction-fact-rubric.cjs"),dir=process.argv[2];assert(dir);
const dest=fs.mkdtempSync(join(os.tmpdir(),"helarc-standalone-compaction-fact-review-")),inspectionRoot=join(dest,"inspection");
app.setPath("userData",dest);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
globalThis.fetch=()=>{throw Error("No network allowed in offline review");};
const load=s=>import(pathToFileURL(resolve(__dirname,"../../dist/main",s+".js")));
const read=n=>JSON.parse(fs.readFileSync(join(dir,n))),wire=n=>read("generate-"+n+".wire").input;
let inspection,query;
async function main(){
  const e=read("evidence.json"),root=e.root,truth=read("case.json").truth,h=JSON.parse(wire(6)[0].content);
  const originals=h.oracle.map(o=>{const a=h.answers.find(a=>a.checkId===o.checkId);return [o.question,a.answer,a.limitations];});
  assert.equal(createHash("sha256").update(JSON.stringify(originals)).digest("hex"),"17f9cbaf3fe97fbb0e9efb937a57deff002ac1742f2522bb681dec1ae83fe1a6");
  const db=new DatabaseSync(resolve(dir,"../profile/Helarc/execution/execution.sqlite"),{readOnly:true});
  let m;
  try{const rows=db.prepare("select value from activity_raw_results where id like ?").all(root+":native-compact-method:%:stage:4%");
    assert.equal(rows.length,1);m=(await load("execution-storage/ExecutionContent")).unpackExecutionContent(JSON.parse(rows[0].value),
      id=>({id,text:db.prepare("select value from execution_content where id=?").get(id).value})).value;
  }finally{db.close();}
  const source=m.request.execution.request,outcome=m.compact,{assessHelarcResponsesCompactByProbe,assessHelarcResponsesCompact}=await import("@agent-anything/helarc/controller");
  assert.deepEqual(wire(5).slice(0,-1),outcome.candidate.items);assert.equal(m.assessment.quality.allowed,false);
  const groups=source.manifest.groups.slice(0,source.groups.length),material=groups.flatMap(g=>g.items),originalInput=read("count-4.wire").input;
  assert.deepEqual(material,h.material);assert.deepEqual(originalInput.slice(0,material.length),material);
  const suffix=originalInput.slice(material.length);assert.equal(suffix.length,2);assert.equal(suffix[0].call_id,suffix[1].call_id);
  assert.equal(JSON.parse(suffix[0].arguments).file_path,"bench.txt");
  assert(JSON.parse(suffix[1].output).result.output.content.includes("None of these readings changes the signed calibration record."));
  assert(!material.some(i=>i.type==="function_call"&&JSON.parse(i.arguments).file_path==="bench.txt"));
  const facts=rubric(groups,h.duties,truth),questions=originals.map(([question],i)=>({question,factKeys:annotations[i].map(([k])=>k)}));
  inspection=await (await load("inspection/HelarcInspection")).HelarcInspection.create(join(dest,"settings.json"),inspectionRoot);
  const {helarcNativeInputRecords}=await load("inspection/HelarcNativeInputInspectionProjection");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query");const rec=inspection.recorder,reports=[];
  for(const variant of ["original-15","changed-answer-14"]){
    const receipts=[],findings=await assessHelarcResponsesCompactByProbe({procedure:"preservation_facts.v1",source,outcome,execute:async(step,items)=>{
      const req=JSON.parse(items.at(-1).content);assert.equal(req.format,"preservation_facts.v1");let value;
      if(step==="oracle"){assert.deepEqual(req.groups.flatMap(g=>g.items),material);assert.deepEqual(req.duties,h.duties);value={facts,questions};}
      if(step==="probe"){
        assert.deepEqual(items.slice(0,-1),wire(5).slice(0,-1));assert.deepEqual(req.questions.map(q=>q.question),originals.map(x=>x[0]));
        assert(req.questions.every(q=>Object.keys(q).sort().join()==="question,questionId"));assert(!req.facts&&!req.groups);
        value={answers:req.questions.map(({questionId},i)=>({questionId,answer:variant==="changed-answer-14"&&i===13?"The withdrawn draft remains current.":originals[i][1],limitations:originals[i][2]}))};
      }
      if(step==="judgment"){
        assert.deepEqual(req.facts,facts);assert.deepEqual(req.duties,h.duties);
        assert.equal(req.answers.filter((a,i)=>a.answer!==originals[i][1]).length,variant==="original-15"?0:1);
        value={gaps:[],checks:req.questions.flatMap((q,i)=>annotations[i].map(([factKey,status,note])=>{
          const neg=variant==="changed-answer-14"&&factKey==="correction";
          return {questionId:q.questionId,factKey,coverage:status==="not_asked"?"not_asked":"asked",quality:neg?"contradicted":status==="not_asked"?"not_assessed":status,
            reason:neg?"The answer keeps the draft current, contrary to the signed replacement.":note??"The saved answer establishes the stated distinction.",
            answerExcerpt:status==="not_asked"?"":req.answers[i].answer};
        }))};
      }
      receipts.push(step);return {evidence:{acceptance:{id:"offline-fact-review:"+variant+":"+step,revision:"1"}},assessment:{outcome:"valid",value}};
    }});
    assert.deepEqual(receipts,["oracle","probe","judgment"]);const assessment=assessHelarcResponsesCompact({source,candidate:outcome.candidate,findings});
    assert(!assessment.quality.allowed);assert.equal(findings.filter(f=>f.kind==="direct"&&f.conclusion==="supported").length,2);
    const all=new Map(findings.flatMap(f=>(f.factAssessments??[]).map(x=>[x.claim,x])));assert.equal(all.size,facts.length);
    const factByKey=key=>all.get(facts.find(f=>f.key===key).claim);
    for(const [i,list] of annotations.entries())for(const [key,status]of list){
      const annotated=factByKey(key).checks.find(c=>c.question===originals[i][0]);assert(annotated);
      assert.equal(annotated.coverage,status==="not_asked"?"not_asked":"asked");
      assert.equal(annotated.quality,variant==="changed-answer-14"&&key==="correction"?"contradicted":status==="not_asked"?"not_assessed":status);
    }
    assert.equal(factByKey("extent").status,"not_asked");assert.equal(factByKey("created").status,"insufficient");
    assert.equal(factByKey("auth").required,false);assert.equal(factByKey("correction").status,variant==="original-15"?"demonstrated":"contradicted");
    assert.equal(factByKey("mode").status,"demonstrated");assert.equal(findings.some(f=>f.conclusion==="unsupported"),variant!=="original-15");
    const records=[...helarcNativeInputRecords(rec,{intent:{runId:root,purpose:{contract:{ref:{id:"helarc.responses-compact"}}}}},
      {request:{id:"offline:"+variant,stageKind:"assessment"},result:{id:"offline:raw:"+variant,recordedAt:new Date().toISOString(),value:{assessment}}})];
    for(const record of records)assert(await rec.offerWhenReady(record));await inspection.flushRecording();
    query??=new InspectionQueryService(inspectionRoot);const {sourceId,datasetId}=records[0].subject;
    const snapshot=await query.query({kind:"get_snapshot",sourceId,datasetId});assert.equal(snapshot.coverage.dropped,0);assert.equal(snapshot.coverage.rejected,0);
    const factRows=records.filter(r=>r.payload.executionKind==="preservation_fact");assert.equal(factRows.length,all.size);
    for(const row of factRows){
      const r=(await query.query({...snapshot.selection,kind:"get_record",recordId:row.id})).records[0];assert.equal(r.payload.status,row.payload.status);
      const d=r.contents[0];assert.equal(d.availability,"present");const content=JSON.parse((await query.query({...snapshot.selection,kind:"get_content",contentId:d.id,length:65536})).content.text);
      assert.deepEqual(content.fact,all.get(content.fact.claim));assert.equal(r.payload.code,content.fact.required?"required":"detail");
    }
    reports.push({variant,selection:snapshot.selection,dropped:0,rejected:0,questions:originals.length,
      facts:[...all.values()],candidate:outcome.candidate.digest,allowed:assessment.quality.allowed});
  }
  fs.writeFileSync(join(dest,"review.json"),JSON.stringify({root,mode:"offline rubric and controlled grading; no new model use or adoption",reports},null,2));
  console.log(JSON.stringify({dest,root,cases:reports.map(r=>({variant:r.variant,questions:r.questions,facts:r.facts.length,statuses:r.facts.map(f=>f.status),selection:r.selection}))}));
}
app.whenReady().then(async()=>{let code=0;try{await main();}catch(e){console.error(e);code=1;}finally{await query?.close();await inspection?.close();app.exit(code);}});
