// Offline contract review, never a new judgment about the historical model's unobserved answer.
const {app}=require("electron"),{DatabaseSync}=require("node:sqlite"),fs=require("node:fs"),assert=require("node:assert/strict");
const {join,resolve}=require("node:path"),{tmpdir}=require("node:os"),{pathToFileURL}=require("node:url");
const dir=resolve(process.argv[2]),dest=fs.mkdtempSync(join(tmpdir(),"helarc-standalone-compaction-plan-boundary-"));
app.setPath("userData",dest);app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
globalThis.fetch=()=>{throw Error("offline only");};
const read=n=>JSON.parse(fs.readFileSync(join(dir,n))),load=n=>import(pathToFileURL(resolve(__dirname,"../../dist/main",n+".js")));
let inspection,query;
async function run(){
  const {root}=read("evidence.json"),{truth}=read("case.json"),oldInput=JSON.parse(read("generate-4.wire").input[0].content);
  const {restoreResponsesCompactedWindow,compileNativeSchema}=await import("@agent-anything/provider-integrations/native");
  const {OPENAI_RESPONSES}=await import("@agent-anything/model-interaction/protocol");
  const {assessHelarcResponsesCompactByProbe,assessHelarcResponsesCompact}=await import("@agent-anything/helarc/controller");
  const db=new DatabaseSync(resolve(dir,"../profile/Helarc/execution/execution.sqlite"),{readOnly:true});
  let original,source,outcome;
  try{
    const x=db.prepare("select value from activity_raw_results where id like ?").get(root+":native-compact-method:%:stage:4%");
    const raw=(await load("execution-storage/ExecutionContent")).unpackExecutionContent(JSON.parse(x.value),id=>db.prepare("select id,value as text from execution_content where id=?").get(id)).value;
    assert.equal(raw.assessment.quality.allowed,false);source=raw.request.execution.request;outcome=raw.compact;
    const {id}=db.prepare("select id from protocol_contents where activity_id like ? and id like ? and complete=1").get(root+"%:oracle","%:oracle:result:%");
    original=JSON.parse(Buffer.concat(db.prepare("select bytes from protocol_content_chunks where id=? order by offset").all(id).map(c=>Buffer.from(c.bytes)))).assessment.value.requirements;
    assert.equal(original.length,7);assert(original[6].claim.includes(truth.current)&&original[6].claim.includes(truth.condition));
  }finally{db.close();}
  const compact=read("compact-1.wire").input,full=read("count-4.wire").input;
  assert.deepEqual(full.slice(0,compact.length),compact);
  const [bench,receipt]=full.slice(compact.length);
  assert.equal(JSON.parse(bench.arguments).file_path,"bench.txt");assert.equal(bench.call_id,receipt.call_id);assert.equal(JSON.parse(receipt.output).settlement,"succeeded");
  const {HelarcInspection}=await load("inspection/HelarcInspection"),{helarcNativeInputRecords}=await load("inspection/HelarcNativeInputInspectionProjection");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),inspectionRoot=join(dest,"inspection");
  inspection=await HelarcInspection.create(join(dest,"settings.json"),inspectionRoot);query=new InspectionQueryService(inspectionRoot);
  const reports=[],objective=source.dutyBasis.find(d=>d.dutyId.endsWith(":objective")).dutyId;
  const disposition=process.argv.includes("--disposition");
  for(const variant of disposition?["corrected","still-invalid","corrected-but-contradicted","no-correction-allowance"]:
      ["original-owners","full-progress","unanswered","answer-conflict","question-overreaches","original-removed","supported-control"]){
    const changed=variant==="original-removed",candidate=changed?restoreResponsesCompactedWindow({...outcome.candidate.raw,
      output:outcome.candidate.raw.output.filter((_,i)=>i!==1)}):outcome.candidate;
    if(changed)assert.notEqual(candidate.digest,outcome.candidate.digest);
    let objectiveAlias,probed7=false;const steps=[];
    const supportsAnswer=variant==="supported-control"||variant==="corrected";
    const findings=await assessHelarcResponsesCompactByProbe({procedure:disposition?"source_and_use.v3":"source_and_use.v2",
      source:disposition&&variant!=="no-correction-allowance"?{...source,assessmentModelCalls:4}:source,outcome:{...outcome,candidate},execute:async(step,items,schema)=>{
      steps.push(step);const msg=JSON.parse(items.at(-1).content);let value;
      if(step==="oracle"){
        assert.equal(msg.observedRange,"frozen_prefix");assert.equal(msg.currentParentProgress,"not_observed");
        assert.deepEqual(msg.groups,oldInput.groups);assert.equal(msg.duties.length,source.duties.length);
        const obj=msg.duties.find(d=>d.sourceGroups.includes("g2"));objectiveAlias=obj.id;
        assert.equal(obj.witness,changed?"none":"ordered_original_text");
        const oldOwners=ids=>ids.map(id=>msg.duties.find(d=>d.sourceGroups[0]===oldInput.duties.find(o=>o.id===id).sourceGroups[0]).id);
        const rows=original.flatMap((r,i)=>{
          // With the scoped direct witness, row 6 has no new check unless this is the ownership or removal control.
          if(i===5&&!disposition&&!["original-owners","original-removed"].includes(variant))return [];
          const scopedProgress=i===4&&variant!=="question-overreaches";
          return [{...r,duties:i===5&&changed?[obj.id]:oldOwners(r.duties),boundary:i===4&&variant==="full-progress"?"complete_recipient_input":"frozen_prefix",
            sources:r.sources.map(a=>({...a,supports:a.group==="g2"?"The user's required order or constraint.":a.group==="g6"?"What the first ledger read returned.":"The recorded call or its outcome."})),
            ...(scopedProgress?{necessity:"Establish progress at the prefix boundary, not subsequent progress.",
              question:"As of the end of this prefix, what steps have confirmed results and what does the receipt establish?"}:{})}];
        });
        value={requirements:rows};
      }else if(step==="plan-ownership"){
        assert(disposition&&!msg.answers&&!msg.questions&&!msg.candidate);
        assert.equal(msg.issues.length,1);assert.equal(msg.issues[0].id,"r6");assert(msg.issues[0].eligible.includes(objectiveAlias));
        value={assignments:[{id:"r6",duties:variant==="still-invalid"?[]:[objectiveAlias]}]};
      }else if(step==="probe"){
        assert.deepEqual(items.slice(0,-1),candidate.items);assert(!msg.duties&&!msg.groups&&!msg.requirements);
        assert(!JSON.stringify(msg.questions).includes(truth.current)&&!JSON.stringify(msg.questions).includes(truth.condition));
        probed7=msg.questions.some(q=>q.question===original[6].question);assert(probed7);
        if(changed)assert(msg.questions.some(q=>q.question===original[5].question));
        if(["unanswered","original-removed"].includes(variant))return {evidence:{acceptance:{id:"offline:"+variant+":"+step,revision:"1"}},assessment:{outcome:"unavailable"}};
        value={answers:msg.questions.map(q=>({id:q.id,answer:q.question===original[6].question?
          supportsAnswer?truth.current+" only in mode "+truth.condition+"; omit the draft and raw samples.":"The draft identifier still applies.":
          "The write opened the review and the first read succeeded as of the prefix boundary."}))};
      }else{
        value={reviews:msg.requirements.map(({id,...r})=>{
          const wrong=r.question===original[6].question&&!supportsAnswer,badScope=r.question===original[4].question,receipt=r.use==="original_receipt";
          return {id,plan:badScope?"scope_mismatch":"valid",source:"supported",sourceReason:"Controlled review of the recorded sources.",
            coverage:receipt?"not_applicable":"asked",quality:receipt?"not_assessed":wrong?"contradicted":"demonstrated",
            reason:badScope?"The original question asks what remains now, but the suffix is not visible.":wrong?"The draft is explicitly withdrawn.":"Bound prefix evidence.",
            answerExcerpt:msg.answers.find(a=>a.id===id)?.answer??""};
        }),duties:msg.duties.map(d=>({id:d.id,complete:true,reason:"Controlled boundary review."})),
        publicClaims:{conclusion:"supported",reason:"Isolate row-level controls."}};
      }
      const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose:{id:"context_compaction_assessment",revision:"1"},mode:"responses-strict",canonical:schema,root:"body"});
      value=codec.parse(JSON.stringify(value));return {evidence:{acceptance:{id:"offline:"+variant+":"+step,revision:"1"}},assessment:{outcome:"valid",value}};
    }});
    const assessment=assessHelarcResponsesCompact({source,candidate,findings});assert.equal(assessment.quality.allowed,supportsAnswer);
    const categories=[...new Set(findings.flatMap(f=>f.assessmentIssue?[f.assessmentIssue.category]:[]))];
    const expected={"original-owners":"plan_attribution","full-progress":"plan_scope","unanswered":"evidence_insufficient",
      "answer-conflict":"candidate_contradiction","question-overreaches":"plan_scope","original-removed":"evidence_insufficient",
      "still-invalid":"plan_attribution","corrected-but-contradicted":"candidate_contradiction","no-correction-allowance":"plan_attribution"}[variant];
    if(disposition)assert.deepEqual(steps,variant==="no-correction-allowance"?["oracle"]:variant==="still-invalid"?["oracle","plan-ownership"]:["oracle","plan-ownership","probe","judgment"]);
    if(expected)assert(categories.includes(expected));else assert.deepEqual(categories,[]);const obj=findings.find(f=>f.dutyId===objective);
    if(variant==="original-owners"){assert.deepEqual(steps,["oracle"]);assert.equal(findings[0].assessmentIssue.requirement,"r6");}
    if(variant==="full-progress"){assert.deepEqual(steps,["oracle"]);assert.equal(findings[0].assessmentIssue.requirement,"r5");}
    if(changed){assert(!obj.visibleOriginal&&obj.kind!=="direct"&&obj.conclusion==="unknown");
      const old=assessHelarcResponsesCompact({source,candidate,findings:priorFindings});assert.equal(old.quality.duties.find(d=>d.id===objective).conclusion,"unknown");}
    if(variant==="answer-conflict"){priorFindings=findings;assert.equal(obj.kind,"direct");
      assert(findings.some(f=>f.factAssessments?.some(a=>a.claim===original[6].claim&&a.status==="contradicted")));}
    const rec=inspection.recorder,records=[...helarcNativeInputRecords(rec,{intent:{runId:root,purpose:{contract:{ref:{id:"helarc.responses-compact"}}}}},
      {request:{id:"offline:"+variant,stageKind:"assessment"},result:{id:"offline:raw:"+variant,recordedAt:new Date().toISOString(),value:{assessment}}})];
    for(const record of records)assert(await rec.offerWhenReady(record));await inspection.flushRecording();
    const {sourceId,datasetId}=records[0].subject,snap=await query.query({kind:"get_snapshot",sourceId,datasetId});
    assert.equal(snap.coverage.rejected,0);assert.equal(snap.coverage.dropped,0);
    const item=records.find(r=>expected?r.payload.code===expected:r.payload.executionKind==="preservation_finding"&&r.payload.status==="supported"),saved=(await query.query({...snap.selection,kind:"get_record",recordId:item.id})).records[0];
    const detail=JSON.parse((await query.query({...snap.selection,kind:"get_content",contentId:saved.contents[0].id,length:65536})).content.text);
    assert.equal(detail.finding.assessmentIssue?.category,expected);
    reports.push({variant,steps,observedInInspector:expected??detail.finding.conclusion,objectiveAlias,probed7,allowed:assessment.quality.allowed});
  }
  const result={root,offline:true,liveCalls:0,recoveredHistoricalAnswer:false,reports};
  fs.writeFileSync(join(dest,"review.json"),JSON.stringify(result,null,2));console.log(dest,JSON.stringify(result));
}
let priorFindings;
app.whenReady().then(async()=>{let code=0;try{await run();}catch(e){console.error(e);code=1;}finally{await query?.close();await inspection?.close();app.exit(code);}});
