// Offline: join dispatch bytes, decoded Inspector contents, original call settlements and recipient receipts.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{DatabaseSync}=require("node:sqlite");
const {digest}=require("./responses-tool-roundtrip-dispatch.cjs");
async function audit(dir,previousDir){
  const {profile}=require("./responses-case-environment.cjs").openCase("delegated-material",path.dirname(path.resolve(dir)));
  const json=n=>JSON.parse(fs.readFileSync(path.join(dir,n+".json"))),c=json("case"),e=json("evidence");
  const log=fs.readFileSync(path.join(dir,"attempt.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
  const wires=log.filter(x=>x.kind==="generate"),counts=log.filter(x=>x.kind==="count"),turns=[],measurements=[],detailsByWire=new Map();
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),q=new InspectionQueryService(path.join(dir,"inspection"));
  const query=r=>q.query({...e.selection,...r});
  async function read(d){let offset=0,text="";do{const r=await query({kind:"get_content",contentId:d.id,length:65536,offset});
    text+=r.content.text;offset=r.content.nextOffset;}while(offset!==null);return JSON.parse(text);}
  const has=(v,str)=>JSON.stringify(v??null).includes(str);
  try{
    for(const m of e.members){
      const page=await query({kind:"list_native_interactions",runId:m.id,limit:100});assert(!page.next);
      for(const r of page.records){
        const descriptors=new Map();let after;
        do{const d=await query({kind:"get_native_interaction",subject:r.subject,limit:100,...after?{after}:{}});
          for(const row of d.records)for(const v of row.contents)if(v.availability==="present"&&!descriptors.has(v.name))descriptors.set(v.name,v);
          after=d.next;}while(after);
        if(descriptors.has("input_tokens response")){
          measurements.push({activity:r.subject.id,run:m.id,tokens:(await read(descriptors.get("input_tokens response"))).input_tokens});continue;
        }
        if(!descriptors.has("create")||!descriptors.has("response.completed"))throw Error("Incomplete Inspector observation for "+r.subject.id);
        const body=(await read(descriptors.get("create"))).body,obs=(await read(descriptors.get("response.completed"))).response;
        const sha=digest(JSON.stringify(body)),w=wires.find(x=>x.sha256===sha&&log.some(l=>l.kind==="completed"&&l.index===x.index&&l.response===obs.id));
        assert(w&&!detailsByWire.has(w.index),"Inspector create or completion does not match a unique dispatch");
        assert(body.store===false && body.stream===true && !body.previous_response_id && !body.conversation);
        const calls=obs.output.filter(i=>i.type==="function_call").map(i=>({id:i.call_id,name:i.name,args:JSON.parse(i.arguments)}));
        const results=body.input.filter(i=>i.type==="function_call_output").map(i=>({id:i.call_id,data:JSON.parse(i.output)}));
        assert.equal(new Set(results.map(i=>i.id)).size,results.length);
        const task=r.subject.id.endsWith(":native-task");
        turns.push({index:w.index,run:m.id,task,activity:r.subject.id,digest:sha,response:obs.id,calls:calls.map(x=>x.name),
          callIds:calls.map(x=>x.id),results:results.map(x=>x.id),inputContainsAnswer:c.sourceRunId?null:has(body.input,c.answer),
          privateLabelInInput:c.privateTag?has(body.input,c.privateTag):null,usage:obs.usage??null});
        detailsByWire.set(w.index,{body,calls,results});
      }
    }
  }finally{await q.close();}
  turns.sort((a,b)=>a.index-b.index);
  if(c.sourceRunId){
    assert(previousDir,"original evidence directory required");
    const previous=JSON.parse(fs.readFileSync(path.join(previousDir,"wire-audit.json"),"utf8"));
    const prevEvidence=JSON.parse(fs.readFileSync(path.join(previousDir,"evidence.json"),"utf8"));
    const original=prevEvidence.members.find(m=>m.id===previous.child).summary;
    const handoff=json("handoff"),checks=[],check=(name,value)=>checks.push({name,pass:!!value});
    const t=turns.map(t=>detailsByWire.get(t.index)),m=e.members.find(x=>x.id===e.root);
    const fact=previous.caveat.original,ref=previous.firstHandoff.ref;
    turns.forEach((turn,i)=>{turn.inputContainsAnswer=has(t[i].body.input,fact);});
    const same=r=>r?.id===ref.id&&r?.revision===ref.revision;
    const call=t[0]?.calls.find(x=>/^ContextMaterialRead(?:_|$)/.test(x.name));
    const result=t[1]?.results.find(x=>x.id===call?.id)?.data?.result?.output;
    const exact=typeof result?.text==="string" && Buffer.from(original).subarray(result.byteStart,result.byteEnd).equals(Buffer.from(result.text));
    const db=new DatabaseSync(path.join(profile,"execution","execution.sqlite"),{readOnly:true});
    let delivery;try{delivery=db.prepare("select delivered from product_admissions where root_run_id=?").get(e.root)?.delivered;}finally{db.close();}
    check("same conversation; exact report admitted through original Parent handoff",previous.root===c.sourceRunId&&e.root!==previous.root&&
      handoff.sourceRunId===previous.root&&handoff.session===c.runTarget.threadId&&handoff.originalReportAdmitted&&same(c.reportRef)&&ref.revision==="sha256:"+digest(original));
    check("initial user question and input do not contain source answer",!c.prompt.includes(fact)&&has(t[0]?.body.input,c.prompt.replaceAll('"','\\"'))&&!has(t[0]?.body.input,fact));
    check("Parent actually read bytes of original version including calibration statement",same(call?.args.reference)&&same(result?.description?.reference)&&
      result?.coordinate==="utf8_view_bytes"&&exact&&result.text.includes(fact));
    const carriers=t[1]?.body.input.filter(i=>has(i,fact))??[];
    check("answer first appears in the new read result before final generation",carriers.length===1&&carriers[0].type==="function_call_output"&&carriers[0].call_id===call?.id);
    check("final reply supplied by the new Parent matches Desktop",m?.summary===e.visible&&t[1]?.calls[0]?.name==="final_result"&&t[1].calls[0].args.response===e.visible);
    check("no new Child or repeated operation",e.members.length===1&&handoff.memberCount===1&&m.calls.length===2&&
      [call,t[1]?.calls[0]].every(x=>x&&m.calls.some(s=>s.call===x.id&&s.status==="succeeded")));
    check("complete accepted run and recording",delivery===1&&m?.status==="completed"&&e.delivered&&e.flush==="settled"&&!e.rejected&&!e.dropped&&
      turns.length===wires.length&&turns.length===2&&measurements.length===counts.length&&counts.length<=2);
    fs.writeFileSync(path.join(dir,"wire-audit.json"),JSON.stringify({root:e.root,selection:e.selection,sourceRunId:c.sourceRunId,reportRef:ref,
      prompt:c.prompt,turns,measurements,checks,actualRead:result?{start:result.byteStart,end:result.byteEnd,text:result.text}:null,expected:fact,final:e.visible},null,2));
    for(const row of checks)console.log(row.pass?"PASS":"OPEN",row.name);
    console.log("Inspect final meaning against source:",e.visible);return checks.every(c=>c.pass);
  }
  const db=new DatabaseSync(path.join(profile,"execution","execution.sqlite"),{readOnly:true});
  let facts,delivery;
  try{facts=db.prepare("select value from material_delivery_facts where run_id=? order by sequence").all(e.root).map(row=>JSON.parse(row.value));
    delivery=db.prepare("select delivered from product_admissions where root_run_id=?").get(e.root)?.delivered;
  }finally{db.close();}
  const root=e.members.find(x=>x.id===e.root),child=e.members.find(m=>m.id!==e.root);
  const report=child?.summary??"",source=fs.readFileSync(path.join(c.workspace,c.file),"utf8");
  const external={root:e.root,child:child?.id,selection:e.selection,turns,measurements,counts:e.counts,delivered:delivery,sourceDigest:digest(source),
    childReportDigest:digest(report),sourceBytes:Buffer.byteLength(source),childReportBytes:Buffer.byteLength(report),
    sameText:report===source,markerOffset:report.includes("DETAIL_CODE")?Buffer.byteLength(report.slice(0,report.lastIndexOf("DETAIL_CODE"))):null,
    materialFacts:facts.map(f=>({kind:f.kind,role:f.value?.kind,ref:f.ref,obligation:f.value?.obligation?.id}))};
  const checks=[],check=(name,ok)=>checks.push({name,pass:!!ok});
  const rt=turns.filter(t=>t.task&&t.run===e.root),ct=turns.filter(t=>t.task&&t.run===child?.id);
  const rows=t=>detailsByWire.get(t.index);
  const rc=rt.flatMap(t=>rows(t).calls),cc=ct.flatMap(t=>rows(t).calls);
  const belongs=(x,base)=>x.name===base||x.name.startsWith(base+"_");
  const agent=rc.find(x=>belongs(x,"Agent"));
  const firstReceipt=rt.find(t=>rows(t).results.some(r=>r.id===agent?.id));
  const wrapper=firstReceipt&&rows(firstReceipt).results.find(r=>r.id===agent.id).data;
  const out=wrapper?.result?.output,ref=out?.report?.reference??out?.material_refs?.[0];
  external.firstHandoff={index:firstReceipt?.index,status:out?.report?.status,ref,child:wrapper?.result?.childRunId,hasAnswer:has(wrapper,c.answer)};
  const same=(a,b)=>a&&b&&a.id===b.id&&a.revision===b.revision;
  const reads=rc.filter(x=>belongs(x,"ContextMaterialRead"));
  const detail=rt.flatMap(t=>rows(t).results.map(r=>({r,t}))).find(({r})=>reads.some(x=>x.id===r.id&&same(x.args.reference,ref))&&
    same(r.data?.result?.output?.description?.reference,ref)&&r.data.result.output.text?.includes(c.answer));
  const readBody=detail?.r.data.result.output;
  external.access=detail?{turn:detail.t.index,call:detail.r.id,start:readBody.byteStart,end:readBody.byteEnd,reference:ref}:null;
  const seenCaveat=v=>/calibration date/i.test(JSON.stringify(v??null));
  const seenField=v=>/no independent field measurement/i.test(JSON.stringify(v??null));
  external.caveat={original:c.uncertainty,sourcePresent:source.includes(c.uncertainty),fullReportPresent:report.includes(c.uncertainty),
    embeddedSourceAt:report.indexOf(source),parentInput:rt.map(t=>({index:t.index,date:seenCaveat(rows(t).body.input),
      field:seenField(rows(t).body.input),resultMentionsDate:rows(t).results.filter(r=>seenCaveat(r.data)).map(r=>r.id)})),
    handoffMentionsDate:seenCaveat(wrapper),detailMentionsDate:seenCaveat(readBody?.text),detailMentionsField:seenField(readBody?.text),
    final:e.visible};
  external.search=rt.flatMap(t=>rows(t).results).flatMap(r=>(r.data?.result?.output?.matches??[]).map(m=>({
    start:m.byteStart,revision:m.description?.reference?.revision,excerpt:m.excerpt}))).at(0)??null;
  check("actual dispatches and measurement observations complete",turns.length===wires.length&&measurements.length===counts.length&&e.flush==="settled"&&!e.rejected&&!e.dropped);
  check("one completed child and one product delivery",e.members.length===2&&root.status==="completed"&&child?.status==="completed"&&delivery===1);
  check("synthetic original unchanged",digest(source)===c.sourceDigest);
  check("one Agent call, accepted child assignment, no parent private marker/history",rc.filter(x=>belongs(x,"Agent")).length===1&&
    ct.length>0 && rt[0].privateLabelInInput && !rt[0].inputContainsAnswer && has(rows(ct[0]).body.input,agent.args.prompt)&&
    !rows(ct[0]).results.length && !rows(ct[0]).body.input.some(i=>i.type==="function_call") && ct.every(t=>!t.privateLabelInInput));
  check("native calls each settled once by original Run",[[rc,root],[cc,child]].every(([calls,m])=>m && calls.length===m.calls.length&&
    calls.every(x=>m.calls.filter(s=>s.call===x.id && s.name===x.name&&s.status==="succeeded").length===1)));
  check("delegated source read; no direct parent source read",cc.some(x=>belongs(x,"Read")&&has(x.args,c.file))&&!rc.some(x=>belongs(x,"Read")));
  check("original agent call received one addressed result for this child",root.calls.filter(x=>x.call===agent?.id).length===1 &&
    wrapper?.result?.childRunId===child?.id && firstReceipt && rows(firstReceipt).results.filter(x=>x.id===agent.id).length===1);
  check("first handoff discloses immutable reference but not answer",ref?.id&&ref?.revision&&!has(wrapper,c.answer)&&!firstReceipt.inputContainsAnswer);
  check("material detail used from the disclosed version",detail && external.markerOffset!==null && readBody.coordinate==="utf8_view_bytes" &&
    Buffer.from(report).subarray(readBody.byteStart,readBody.byteStart+Buffer.byteLength(readBody.text)).toString("utf8")===readBody.text);
  check("answer first entered Parent via authorized detail",detail && rt.filter(t=>t.index<detail.t.index).every(t=>!t.inputContainsAnswer));
  check("independent value and calibration uncertainty in Desktop final",e.visible===root.summary&&e.visible?.includes(c.answer)&&
    /calibration date/i.test(e.visible)&&/unverified|not (?:been )?(?:independently )?verified|not independently confirmed/i.test(e.visible));
  const receipts=facts.filter(f=>f.kind==="material_delivery.evidence"&&f.value?.kind==="receipt");
  check("receipt and disposition for retained handoff",receipts.length===1&&facts.filter(f=>f.kind==="material_delivery.disposition").length===1);
  external.checks=checks;
  fs.writeFileSync(path.join(dir,"wire-audit.json"),JSON.stringify(external,null,2));
  for(const c of checks)console.log(c.pass?"PASS":"OPEN",c.name);return checks.every(c=>c.pass);
}
audit(process.argv[2],process.argv[3]).then(ok=>{process.exitCode=ok?0:1;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
