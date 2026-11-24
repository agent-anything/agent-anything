const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),{DatabaseSync}=require("node:sqlite");
const {digest}=require("./responses-background-observation-dispatch.cjs");
async function audit(dir){
  const {profile}=require("./responses-case-environment.cjs").openCase("background-observation",path.dirname(path.resolve(dir)));
  const json=n=>JSON.parse(fs.readFileSync(path.join(dir,n+".json"))),c=json("case"),e=json("evidence");
  const log=fs.readFileSync(path.join(dir,"attempt.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
  const dispatch=log.filter(r=>r.kind==="dispatch"),obs=log.filter(r=>r.kind==="observation");
  const creates=dispatch.filter(r=>r.operation==="create"),polls=dispatch.filter(r=>r.operation==="retrieve");
  assert.equal(creates.length,1);const original=obs.find(r=>r.operation==="create");assert(original?.id);
  const endpoint="https://api.openai.com/v1/responses";
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),q=new InspectionQueryService(path.join(dir,"inspection"));
  const get=p=>q.query({...e.selection,...p});
  const content=async d=>{let offset=0,text="";do{const r=await get({kind:"get_content",contentId:d.id,offset,length:65536});
    text+=r.content.text;offset=r.content.nextOffset;}while(offset!==null);return JSON.parse(text);};
  const sends=[],received=[],measured=[];
  let activity;
  try{
    const page=await get({kind:"list_native_interactions",runId:e.root,limit:100});assert(!page.next);
    for(const r of page.records){
      const seen=new Set();let after;
      do{
        const details=await get({kind:"get_native_interaction",subject:r.subject,limit:100,...after?{after}:{}});
        for(const row of details.records)for(const d of row.contents){
          if(d.availability!=="present"||seen.has(d.id)||!["create","retrieve","input_tokens response","response"].includes(d.name))continue;
          seen.add(d.id);const value=await content(d);
          if(d.name==="input_tokens response")measured.push(value.input_tokens);
          else if(d.name==="response"&&value.object==="response")received.push({activity:r.subject.id,id:value.id,status:value.status});
          else if(d.name==="create"||d.name==="retrieve"){
            if(activity)assert.equal(r.subject.id,activity);activity=r.subject.id;
            assert(row.payload.category==="sent"&&row.payload.operationId);
            sends.push({operationId:row.payload.operationId,operation:d.name,method:value.method,endpoint:value.endpoint,sha256:value.body?digest(JSON.stringify(value.body)):null});
          }
        }after=details.next;
      }while(after);
    }
  }finally{await q.close();}
  const db=new DatabaseSync(path.join(profile,"execution","execution.sqlite"),{readOnly:true});
  let delivered,intents,accepted;
  try{
    delivered=db.prepare("select delivered from product_admissions where root_run_id=?").get(e.root)?.delivered;
    accepted=db.prepare("select count(*) as n from protocol_acceptances where run_id=? and activity_id=?").get(e.root,activity).n;
    intents=db.prepare("select value from protocol_records where activity_id=?").all(activity).map(r=>JSON.parse(r.value))
      .filter(r=>r.kind==="dispatch_intent"||r.kind==="reconciliation_intent").map(r=>({kind:r.kind,id:r.ref.id,operationId:r.operationId,native:r.source?.nativeIdentity?.id??null}));
  }finally{db.close();}
  const checks=[],check=(name,ok)=>checks.push({name,pass:!!ok});
  check("one charged create and no other generation, cancellation or deletion",creates.length===1&&e.counts.create===1&&!log.some(r=>r.kind==="blocked"||r.kind==="unconfirmed"));
  check("at least one real GET; every requested and returned ID matches create",polls.length>0&&polls.every(p=>p.requested===original.id&&
    obs.some(o=>o.operation==="retrieve"&&o.ordinal===p.ordinal&&o.id===original.id)));
  // Count physical requests at the wire. Each journal operation needs matching Inspector evidence;
  // every additional capture of that operation must agree, not count as another send.
  const groups=Map.groupBy(sends,s=>s.operationId);
  check("original create bytes and all GET routes are independently recorded",
    groups.size===creates.length+polls.length&&intents.length===groups.size&&new Set(intents.map(i=>i.operationId)).size===groups.size&&
    intents.every(i=>groups.has(i.operationId)&&groups.get(i.operationId).every(s=>i.kind==="dispatch_intent"
      ? s.operation==="create"&&s.method==="POST"&&s.endpoint===endpoint&&s.sha256===creates[0].sha256
      : s.operation==="retrieve"&&s.method==="GET"&&s.sha256===null&&s.endpoint===endpoint+"/"+original.id&&i.native===original.id)));
  check("Inspector has identity and statuses of the actual observations",obs.every(o=>received.some(r=>r.activity===activity&&r.id===o.id&&r.status===o.status)));
  check("original identity is retained in SQLite for reconciliation",intents.filter(i=>i.kind==="dispatch_intent").length===1&&
    intents.filter(i=>i.kind==="reconciliation_intent"&&i.native===original.id).length===polls.length);
  const last=obs.at(-1);
  check("service terminal outcome is the one delivered locally",last.operation==="retrieve"&&last.status==="completed"&&delivered===1&&accepted===1&&e.status==="completed"&&
    e.visible===e.final&&e.visible.includes(c.marker)&&e.settlements.length===1&&e.settlements[0].name==="final_result"&&e.settlements[0].status==="succeeded");
  check("recording drained with no rejection or loss",e.flush==="settled"&&!e.dropped&&!e.rejected);
  const report={root:e.root,activity,selection:e.selection,id:original.id,counts:e.counts,observations:obs,sends,received,intents,measured,checks};
  fs.writeFileSync(path.join(dir,"wire-audit.json"),JSON.stringify(report,null,2));
  for(const c of checks)console.log(c.pass?"PASS":"OPEN",c.name);
  return checks.every(c=>c.pass);
}
audit(process.argv[2]).then(ok=>{process.exitCode=ok?0:1;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
