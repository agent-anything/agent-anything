const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {digest}=require("./responses-tool-roundtrip-dispatch.cjs");
async function main(directory){
  const json=name=>JSON.parse(fs.readFileSync(path.join(directory,name+".json")));
  const {target,expected,prompt}=json("case"),e=json("evidence");
  const wires=fs.readFileSync(path.join(directory,"attempt.ndjson"),"utf8").trim().split("\n").map(JSON.parse).filter(r=>r.kind==="generate");
  const {InspectionQueryService}=await import("@agent-anything/inspection/query"),q=new InspectionQueryService(path.join(directory,"inspection"));
  const get=input=>q.query({...e.inspector.selection,...input});
  async function content(desc){let offset=0,text="";
    do{const {content}=await get({kind:"get_content",contentId:desc.id,length:65536,offset});text+=content.text;offset=content.nextOffset;}while(offset!==null);
    return JSON.parse(text);
  }
  try{
    const page=await get({kind:"list_native_interactions",runId:e.root,limit:100});assert(!page.next);
    const counts={},turns={};
    for(const r of page.records){
      const n=Number(/:controller_turn:(\d+):native-task/.exec(r.subject.id)?.[1]);assert(n);
      const descriptors=new Map();let after;
      do{const details=await get({kind:"get_native_interaction",subject:r.subject,limit:100,...after?{after}:{}});
        for(const c of details.records.flatMap(x=>x.contents))if(c.availability==="present"&&!descriptors.has(c.name))descriptors.set(c.name,c);
        after=details.next;
      }while(after);
      if(descriptors.has("input_tokens response")){counts[n]=(await content(descriptors.get("input_tokens response"))).input_tokens;continue;}
      const body=(await content(descriptors.get("create"))).body,obs=(await content(descriptors.get("response.completed"))).response;
      assert.equal(body.model,target.model);assert.equal(digest(JSON.stringify(body)),wires[n-1].sha256);
      assert(body.input.some(i=>JSON.stringify(i).includes(prompt.replaceAll("\\","\\\\"))) ||
        body.input.some(i=>i.role==="user" && typeof i.content==="string" && i.content.includes(prompt)),"user objective missing");
      const calls=obs.output.filter(i=>i.type==="function_call").map(i=>({id:i.call_id,name:i.name}));
      for(const call of calls)assert(e.settlements.some(s=>s.call===call.id&&s.name===call.name&&s.settlement==="succeeded"));
      const resultIds=body.input.filter(i=>i.type==="function_call_output").map(i=>i.call_id);
      const callIds=body.input.filter(i=>i.type==="function_call").map(i=>i.call_id);
      assert.equal(new Set(resultIds).size,resultIds.length);assert.equal(new Set(callIds).size,callIds.length);
      assert.deepEqual([...resultIds].sort(),[...callIds].sort());
      const containsAnswer=JSON.stringify(body.input).includes(expected);
      turns[n]={requestDigest:wires[n-1].sha256,responseId:obs.id,usage:obs.usage??null,calls,resultIds,containsAnswer};
    }
    let prior=[];
    for(const n of Object.keys(turns).map(Number).sort((a,b)=>a-b)){
      assert.deepEqual(turns[n].resultIds,prior);
      assert.equal(turns[n].containsAnswer,n!==1);
      assert(Number.isSafeInteger(counts[n]));
      prior=prior.concat(turns[n].calls.map(c=>c.id));
    }
    assert.equal(Object.keys(turns).length,wires.length);assert.equal(e.correctVisible,true);
    assert.equal(e.visible,e.final);assert.equal(e.correctFile,true);assert.equal(e.writes,1);
    assert.deepEqual(e.settlements.map(s=>s.name.split("_")[0]),["Read","Write","final"]);
    assert.equal(e.settlements.at(-1).name,"final_result");
    return {root:e.root,dataset:e.inspector.selection.datasetId,counts,turns};
  }finally{await q.close();}
}
main(process.argv[2]).then(result=>{
  fs.writeFileSync(path.join(process.argv[2],"wire-audit.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify(Object.values(result.turns).map((t,i)=>({turn:i+1,measured:result.counts[i+1],usage:t.usage,calls:t.calls.map(c=>c.name)}))));
}).catch(e=>{console.error(e.message);process.exitCode=1;});
