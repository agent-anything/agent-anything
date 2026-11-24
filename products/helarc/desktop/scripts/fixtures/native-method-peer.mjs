import assert from "node:assert/strict";

// A deterministic synthetic peer, not a semantic-quality evaluator for real tasks.
export function nativeMethodPeer(items){
  const values=items.map(item=>{try{return JSON.parse(item.content);}catch{return null;}}).filter(Boolean);
  const work=values.find(value=>value.job);assert(work);
  const sources=values.filter(value=>value.role==="source"&&work.job.scope.includes(value.alias));
  assert(sources.length,"Synthetic peer requires explicit source content");
  const parts=sources.map(source=>({text:account(source.text),sources:[source.alias]}));
  if(work.job.kind!=="check")return {kind:"candidate",parts,covered:work.job.scope,background:[],losses:[],relationships:[],unknowns:[],missing:[]};
  const candidates=values.filter(value=>value.role==="candidate"&&work.job.candidates.includes(value.alias));
  const text=candidates.map(candidate=>candidate.text).join("\n");
  const supported=parts.every(part=>text.includes(part.text));
  const conclusion=supported?"supported":"unsupported",basis=supported?"All synthetic source facts and repeated-line multiplicities are retained.":"Candidate does not retain the declared synthetic source facts.";
  return {kind:"assessment",findings:Object.fromEntries(["source_to_candidate","candidate_to_source","relationships","precision"].map(d=>[d,
    {conclusion,sources:work.job.scope,candidates:work.job.candidates,basis,unknowns:[]}])),
    requirements:work.requirements.map(r=>({id:r.id,conclusion,basis})),missing:supported?[]:[basis]};
}
function account(text){
  let source;try{source=JSON.parse(text);}catch{}
  if(source?.kind==="native_working_source")return JSON.stringify({originRunId:source.originRunId,items:source.items});
  const lines=text.split("\n"),result=[];
  for(let i=0;i<lines.length;){
    let end=i+1;while(end<lines.length&&lines[end]===lines[i])end++;
    result.push(end-i>1?`Identical line repeated ${end-i} times: ${lines[i]}`:lines[i]);i=end;
  }
  return result.join("\n");
}
