const assert=require("node:assert/strict");
const {randomBytes,createCipheriv,createDecipheriv}=require("node:crypto");
const {gzipSync,gunzipSync}=require("node:zlib");
const ordinary=require("./native-application-ordinary.cjs");

// Only the controlled HTTP service can interpret its opaque item, including after an Electron restart.
const key=randomBytes(32),capacity=13850;
const rootPrompt="HOST_ROOT: Delegate HOST_CHILD to report calibration result 7391, the number of repeated observations, uncertainty and changes. When its report arrives, write ORIGINAL to once.txt once, then report the findings and write outcome.";
const childPrompt="HOST_CHILD: Report result 7391 and all 60 identical calibration observations. State that measurements are unverified and that no changes were made.";
function produce(input,requireCalibrationPrefix=true){
  const start=input.findIndex(i=>i.role!=="user");
  assert(start>=0);const history=input.slice(start);assert(history.every(i=>i.role!=="user"));
  if(requireCalibrationPrefix){
    assert(history.some(i=>i.type==="function_call_output"&&JSON.parse(i.output).result.output?.summary===ordinary.report));
    assert(!history.some(i=>/^Write(?:_|$)/.test(i.name)));
  }
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);
  const bytes=Buffer.concat([cipher.update(gzipSync(JSON.stringify(history))),cipher.final()]);
  return [...input.slice(0,start),{type:"compaction",id:"cmp_calibration",encrypted_content:Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString("base64")}];
}
function expand(input){
  assert.equal(input.filter(i=>i.type==="compaction").length,1);
  return input.flatMap(i=>{
    if(i.type!=="compaction")return [i];
    const bytes=Buffer.from(i.encrypted_content,"base64"),cipher=createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(gunzipSync(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()])));
  });
}
function answerKey(items){
  const stable=(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v;
  const [header,line,...repeats]=ordinary.report.split("\n");assert(repeats.every(s=>s===line));
  return JSON.stringify(items.map(i=>{
    if(i.type!=="function_call_output")return i;
    const output=JSON.parse(i.output);
    if(output.result?.output?.summary===ordinary.report)output.result.output.summary={header,line,occurrences:1+repeats.length};
    return {...i,output};
  }),stable);
}
// Compare the complete ordered fixture evidence, spelling identical report lines only once.
function assess(items,exerciseRepair=false){
  const evidence=JSON.parse(items.at(-1).content),question="Reconstruct the complete ordered calibration exchange, including its task, bindings, calls and results.";
  if(["source_and_use.v1","source_and_use.v2","source_and_use.v3"].includes(evidence.format)){
    const scoped=evidence.format!=="source_and_use.v1";
    if(evidence.issues){
      assert(exerciseRepair&&scoped);assert.equal(evidence.issues.length,1);
      assert(!evidence.answers&&!evidence.candidate);
      return {kind:"plan-ownership",value:{assignments:evidence.issues.map(i=>({id:i.id,duties:exerciseRepair==="reject"?[]:i.eligible}))}};
    }
    if(evidence.requirements){
      const answer=evidence.answers[0],ok=answer.answer===answerKey(evidence.groups.flatMap(g=>g.items));
      return {kind:"judgment",value:{reviews:[{id:answer.id,...(scoped?{plan:"valid"}:{}),source:"supported",sourceReason:"Original ordered exchange.",coverage:"asked",
        quality:ok?"demonstrated":"insufficient",reason:"Compared the recipient's reconstruction.",answerExcerpt:answer.answer.slice(0,48)}],
        duties:evidence.duties.map(d=>({id:d.id,complete:ok,reason:"Reconstruction covers the complete fixture exchange."})),
        publicClaims:{conclusion:ok?"supported":"unsupported",reason:"Compared the readable reconstruction to the original."}}};
    }
    if(evidence.questions)return {kind:"probe",value:{answers:evidence.questions.map(q=>({id:q.id,answer:answerKey(expand(items.slice(0,-1)))}))}};
    const open=evidence.duties.filter(d=>d.witness!=="ordered_original_text");
    const sources=evidence.groups.filter(g=>open.some(d=>d.sourceGroups.includes(g.id))).map(g=>{
      const i=g.items[0];return {group:g.id,excerpt:[i.call_id,i.content,i.arguments,i.output,i.name].find(v=>typeof v==="string"&&v.length).slice(0,48),
        ...(scoped?{supports:"The ordered call or outcome at this position."}:{})};
    });
    return {kind:"oracle",value:{requirements:[{duties:exerciseRepair?["nonexistent-duty"]:open.map(d=>d.id),...(scoped?{boundary:"frozen_prefix"}:{}),claim:"Recover the ordered calibration exchange.",
      necessity:"The next task uses the report and its call/result bindings.",sources,use:"recipient",question,resultGroup:"",pointer:"",expectedJson:""}]}};
  }
  if(evidence.format==="preservation_facts.v1"){
    if(evidence.answers){
      const answer=evidence.answers[0],ok=answer.answer===answerKey(evidence.groups.flatMap(g=>g.items));
      return {kind:"judgment",value:{checks:[{questionId:answer.questionId,factKey:"exchange",coverage:"asked",
        quality:ok?"demonstrated":"insufficient",reason:"Compared complete ordered reconstruction to original.",answerExcerpt:answer.answer.slice(0,48)}],gaps:[]}};
    }
    if(evidence.questions){
      assert.deepEqual(evidence.questions.map(q=>q.question),[question]);assert(!evidence.facts&&!evidence.groups);
      return {kind:"probe",value:{answers:[{questionId:evidence.questions[0].questionId,answer:answerKey(expand(items.slice(0,-1))),limitations:[]}]}};
    }
    const sources=evidence.groups.filter(g=>evidence.duties.some(d=>d.sourceGroups.includes(g.id))).map(g=>{
      const item=g.items[0],text=[item.call_id,item.content,item.arguments,item.output,item.name].find(v=>typeof v==="string"&&v.length);
      assert(text);return {groupId:g.id,excerpt:text.slice(0,48)};
    });
    return {kind:"oracle",value:{facts:[{key:"exchange",dutyIds:evidence.duties.map(d=>d.dutyId),required:true,
      claim:"Complete ordered synthetic exchange can be reconstructed.",necessity:"Original calibration report and its call/result bindings are required for continuation.",sources}],
      questions:[{question,factKeys:["exchange"]}]}};
  }
  if(evidence.format==="scoped_checks.v1"){
    if(evidence.oracle)return {kind:"judgment",value:{coverage:evidence.duties.map(d=>({dutyId:d.dutyId,complete:true,reason:"Full ordered reconstruction was requested."})),
      findings:evidence.oracle.map(q=>({checkId:q.checkId,status:evidence.answers.find(a=>a.checkId===q.checkId)?.answer===q.expectedAnswer&&
        q.expectedAnswer===answerKey(evidence.material)?"supported":"not_established",reason:"Checked source and reconstructed exchange.",answerExcerpt:"",sourceExcerpt:""}))}};
    if(evidence.questions){assert(!evidence.material&&!evidence.oracle);const answer=answerKey(expand(items.slice(0,-1)));
      return {kind:"probe",value:{answers:evidence.questions.map(q=>{assert.equal(q.question,question);return {checkId:q.checkId,answer,limitations:[]};})}};}
    return {kind:"oracle",value:{queries:evidence.duties.map(d=>({dutyId:d.dutyId,established:true,checks:[{question,expectedAnswer:answerKey(evidence.material),basis:"Exact fixture exchange."}]}))}};
  }
  if(evidence.oracle)return {kind:"judgment",value:{findings:evidence.duties.map(d=>{
    const q=evidence.oracle.find(q=>q.dutyId===d.dutyId),a=evidence.answers.find(a=>a.dutyId===d.dutyId);
    return {dutyId:d.dutyId,conclusion:q?.established&&q.expectedAnswer===answerKey(evidence.material)&&a?.answer===q.expectedAnswer?"supported":"unsupported",
      reason:"Compared complete ordered fixture evidence with the candidate-only reconstruction.",limitations:[]};
  })}};
  if(evidence.questions){
    assert(!evidence.material&&!evidence.oracle);const answer=answerKey(expand(items.slice(0,-1)));
    return {kind:"probe",value:{answers:evidence.questions.map(q=>{assert.equal(q.question,question);return {dutyId:q.dutyId,answer,limitations:[]};})}};
  }
  assert(evidence.duties?.length&&evidence.material?.length);
  return {kind:"oracle",value:{queries:evidence.duties.map(d=>({dutyId:d.dutyId,question,expectedAnswer:answerKey(evidence.material),established:true,basis:"Exact synthetic source evidence."}))}};
}
function call(items){
  if(items.some(i=>i.type==="compaction")){
    const restored=expand(items),calls=restored.filter(i=>i.type==="function_call");
    assert.deepEqual(calls.map(i=>i.name.split("_")[0]),["Agent","Write"]);
    const results=calls.map(c=>{const matches=restored.filter(i=>i.type==="function_call_output"&&i.call_id===c.call_id);assert.equal(matches.length,1);return JSON.parse(matches[0].output);});
    assert.equal(results[0].result.output.summary,ordinary.report);assert.equal(results[1].settlement,"succeeded");
    return {name:"final_result",values:{response:"Child result 7391. 60 repeated observations, unverified; Child made no changes. Parent wrote once.txt."}};
  }
  if(!JSON.stringify(items).includes("HOST_ROOT"))return {name:"final_result",values:{response:ordinary.report}};
  if(!items.some(i=>i.type==="function_call_output"))return {name:"Agent",values:{description:"Report number",prompt:childPrompt}};
  const results=items.filter(i=>i.type==="function_call_output");assert.equal(results.length,1,"Parent may not dispatch the over-capacity original");
  assert.equal(JSON.parse(results[0].output).result.output.summary,ordinary.report);
  return {name:"Write",values:{file_path:"once.txt",content:"ORIGINAL"}};
}
module.exports={rootPrompt,capacity,produce,expand,assess,call};
