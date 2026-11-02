import {mountProcessProvider} from "./process-provider.mjs";

export async function mountComparisonProvider(scope,directory,{live=false,baseUrl="http://localhost:11435",signal}={}){
  return mountProcessProvider(scope,directory,{signal,respond:async({body,raw,url,signal:requestSignal})=>{
    if(!live)return {status:200,body:controlledResponse(body)};
    const upstream=await fetch(`${baseUrl}${url}`,{method:"POST",headers:{"content-type":"application/json"},body:raw,
      signal:AbortSignal.any([requestSignal,AbortSignal.timeout(120000)])});
    return {status:upstream.status,body:await upstream.json()};
  }});
}
export function controlledResponse(body){
  const text=body.messages?.map(m=>m.content??"").join("\n")??body.prompt??"";
  const objects=text.split("\n").flatMap(line=>{try{return [JSON.parse(line.replace(/^user: /,""))];}catch{return [];}}),work=objects.findLast(v=>v.job&&v.outputContract);
  if(body.tools?.length&&!work){
    const pick=name=>body.tools.map(t=>t.function.name).find(n=>n===name||n.startsWith(`${name}_`));
    const count=body.messages.filter(m=>m.role==="tool").length,root=body.messages.some(m=>m.role==="user"&&m.content?.includes("POLICY_TASK_ROOT"));
    let name,args;
    if(count<2){name=pick("Read");args={file_path:count===0?"evidence-a.txt":"evidence-b.txt"};}
    else if(root&&count===2){name=pick("Agent");args={description:"Independent evidence use",prompt:"Read evidence-a.txt and evidence-b.txt, then report the radii for images 5 and 6, the alpha constraint and whether the output version is verified. Do not modify files."};}
    else {name=pick("final_result");args={response:JSON.stringify({image5:3,image6:5,alpha:"preserved",version:"unverified"})};}
    if(!name)throw new Error("Required controlled callable is not exposed");
    return {model:body.model,message:{role:"assistant",content:"",tool_calls:[{function:{name,arguments:args}}]},done:true,done_reason:"stop",prompt_eval_count:Math.ceil(Buffer.byteLength(JSON.stringify(body))/4),eval_count:50};
  }
  let output;
  if(work){
    const evidence=objects.filter(v=>v.alias&&typeof v.text==="string"),source=evidence.filter(v=>work.job.scope.includes(v.alias)).map(v=>v.text).join("\n");
    const original=/radius (\d+)/.exec(source)?.[1]??"3",later=/change radius to (\d+)/i.exec(source)?.[1]??/radius (\d+).*images 6/i.exec(source)?.[1]??"5";
    const check=["check","relation","combination"].includes(work.job.kind);
    output=check?{kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(direction=>[direction,{conclusion:"supported",sources:work.job.scope,candidates:work.job.candidates,basis:"Controlled mechanics response, not independent quality evidence",unknowns:[]}])),requirements:work.requirements.map(r=>({id:r.id,conclusion:"supported",basis:"controlled response"})),missing:[]}:
      {kind:"candidate",parts:[{text:`Images 2-5: radius ${original}; images 6-10: radius ${later}. Preserve alpha throughout. Output version remains unverified.`,sources:work.job.scope}],covered:work.job.scope,background:[],losses:[],relationships:[],unknowns:[],missing:[]};
  }else if(text.includes("FOREGROUND_READY"))output="Ready.";
  else {
    const a=/Images 2-5: radius (\d+)/i.exec(text)?.[1]??/radius (\d+)/.exec(text)?.[1];
    const b=/images 6-10: radius (\d+)/i.exec(text)?.[1]??/change radius to (\d+)/i.exec(text)?.[1];
    output={image5:Number(a),image6:Number(b),alpha:"preserved",version:"unverified"};
  }
  const content=typeof output==="string"?output:JSON.stringify(output);
  return {model:body.model,...(typeof body.prompt==="string"?{response:content}:{message:{role:"assistant",content}}),done:true,done_reason:"stop",prompt_eval_count:Math.ceil(Buffer.byteLength(JSON.stringify(body))/4),eval_count:Math.ceil(content.length/4)};
}
