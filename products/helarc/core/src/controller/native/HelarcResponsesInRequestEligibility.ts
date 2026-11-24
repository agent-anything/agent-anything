import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {TransformationDuty,TransformationFinding,TransformationDependencies} from "@agent-anything/context/representation";
import {HELARC_COMPACTION_PRESERVATION,snapshotHelarcInRequestCompactionPolicy,
  type HelarcCompactionContent} from "../../configuration/HelarcInRequestCompactionPolicy.js";
import type {HelarcRetainedNativeInput} from "./HelarcRetainedNativeInput.js";
import type {RepresentationMethodRequest} from "@agent-anything/agent-runtime/context-representation";
import {validateHelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";
import {helarcNativeWorkingGroupRevision} from "./HelarcNativeAccountScopes.js";

import type {HelarcResponsesInRequestUse,HelarcResponsesInRequestEligibility} from "./HelarcResponsesInRequestEvidence.js";
export type {HelarcResponsesInRequestUse,HelarcResponsesInRequestEligibility} from "./HelarcResponsesInRequestEvidence.js";

/** Native shapes and owner-declared requirements only; never classify natural-language statements. */
export function assessHelarcResponsesInRequestUse(input:{readonly native:HelarcRetainedNativeInput;readonly use:HelarcResponsesInRequestUse;
  readonly capacity:RepresentationMethodRequest["capacity"]}):HelarcResponsesInRequestEligibility{
  const {native,use,capacity}=input,policy=use.policy?snapshotHelarcInRequestCompactionPolicy(use.policy):null;
  const reasons:string[]=[],content=new Set<HelarcCompactionContent>(),duties:TransformationDuty[]=[],dutyBasis:{id:string;basis:string}[]=[];
  const items=native.manifest.groups.flatMap(g=>g.items),body=JSON.parse(native.wire.body);
  const sources=native.workingSources;
  if(native.manifest.protocol.id!=="openai.responses"||native.continuity.kind!=="responses")reasons.push("protocol_not_responses");
  if(!use.enabled)reasons.push("in_request_compaction_disabled");
  if(!policy)reasons.push("method_use_policy_missing");
  if(policy&&policy.target!==use.target)reasons.push("method_use_policy_target_changed");
  if(policy&&policy.support!=="accepted")reasons.push(`method_support_${policy.support}`);
  if(body.context_management!==undefined||native.compactionAgreement)reasons.push("original_input_already_arranged");
  if(!sources)reasons.push("source_preservation_inventory_missing");
  else validateHelarcNativeWorkingSources(sources,items);
  function blocks(value:unknown):void{
    if(typeof value==="string"){content.add("text");return;}
    if(!Array.isArray(value)){reasons.push("content_shape_unknown");return;}
    for(const b of value){
      if(b?.type==="input_text"||b?.type==="output_text"||b?.type==="refusal")content.add("text");
      else if(b?.type==="input_image")content.add("images");else if(b?.type==="input_file")content.add("files");
      else reasons.push(`content_type_unassessed:${String(b?.type)}`);
    }
  }
  for(const item of items){
    if(item.type==="message"||!item.type&&["user","assistant","developer","system"].includes(String(item.role)))blocks(item.content);
    else if(item.type==="function_call")content.add("function_calls");
    else if(item.type==="function_call_output"){content.add("function_calls");blocks(item.output);}
    else if(item.type==="reasoning")content.add("reasoning");else if(item.type==="compaction")content.add("compaction");
    else if(["web_search_call","file_search_call","code_interpreter_call","image_generation_call","mcp_call","mcp_list_tools"].includes(String(item.type)))content.add("remote_tools");
    else reasons.push(`native_item_unassessed:${String(item.type)}`);
  }
  if(Array.isArray(body.tools))for(const tool of body.tools){
    if(tool.type==="function")content.add("function_calls");
    else if(["web_search","web_search_preview","file_search","code_interpreter","image_generation","mcp"].includes(tool.type))content.add("remote_tools");
    else reasons.push(`native_tool_unassessed:${String(tool.type)}`);
  }
  const scoped=sources?.groups.flatMap(g=>g.preservation.obligations.flatMap(o=>o.assuranceScope?[o.assuranceScope]:[]))??[];
  const profiles=policy?.profiles.filter(p=>p.transports.includes(use.transport)&&p.continuities.includes(use.continuity)&&
    (!use.background||p.background)&&[...content].every(c=>p.content.includes(c))&&p.repeated==="accepted"&&
    HELARC_COMPACTION_PRESERVATION.every(k=>p.preservation[k]==="accepted")&&
    scoped.every(s=>p.specialRequirements.some(r=>r.id===s.id&&r.revision===s.revision)))??[];
  const profile=profiles[0]??null;
  if(!profile)reasons.push("joint_use_profile_unavailable");
  const add=(id:string,revision:string,requirement:TransformationDuty["requirement"],permittedEvidence:TransformationDuty["permittedEvidence"],basis:string)=>{
    duties.push({id,revision,requirement,permittedEvidence});dutyBasis.push({id,basis});
    if(requirement!=="semantic")reasons.push(`required_unconverted_content:${id}`);
    if(!permittedEvidence.includes("method_assurance"))reasons.push(`pre_use_artifact_evidence_required:${id}`);
  };
  for(const dimension of HELARC_COMPACTION_PRESERVATION)add(`baseline:${dimension}`,"1","semantic",["method_assurance"],`General working-conversation duty: ${dimension}`);
  for(const group of sources?.groups??[]){
    const revision=helarcNativeWorkingGroupRevision(group);
    for(const o of group.preservation.obligations)add(`${group.id}:obligation:${o.id}`,revision,o.requirement==="exact"?"exact":"semantic",
      o.permittedEvidence??["method_assurance","continuation_probe"],o.basis);
    for(const [index,r]of group.preservation.relationships.entries())add(`${group.id}:relationship:${index}`,revision,"semantic",["method_assurance"],
      `Preserve declared ${r.kind} relation to ${r.source.owner}:${r.source.kind}:${r.source.id}@${r.source.revision}`);
  }
  const limits=capacity.limits.filter(l=>l.dimension==="shared_tokens"&&l.targetRevision===native.manifest.target.configuration);
  const window=limits.length?Math.min(...limits.map(l=>l.maximum)):policy?.trigger.windowTokens??null;
  const tokens=policy?.trigger.thresholdTokens??null;
  // Planning estimates remain estimates. Never turn an unknown reservation into a claimed zero bound.
  const reserve=capacity.reservations.filter(r=>r.dimension==="shared_tokens"&&r.purpose!=="future_growth"&&!r.alreadyIncluded);
  let headroom=0;
  for(const r of reserve){const q=r.quantity;
    if(q.kind==="exact"||q.kind==="estimate")headroom+=q.value;
    else if(q.kind==="bounds")headroom+=q.upper??q.lower;
  }
  const unknownReservation=reserve.some(r=>r.quantity.kind==="unknown"||r.quantity.kind==="bounds"&&r.quantity.upper===null);
  if(unknownReservation&&!capacity.policy.allowUnknown)reasons.push("generation_headroom_unknown");
  const trigger=window!==null&&tokens!==null&&Number.isSafeInteger(window)&&tokens<window&&tokens<=window-Math.ceil(headroom)?
    {tokens,window,headroom:Math.ceil(headroom),basis:`${policy!.trigger.basis}; ${limits.map(l=>l.source).join("; ")}; ${unknownReservation?"generation headroom is not a proven bound; original capacity policy accepts uncertainty":"recorded generation planning, not an output cap"}`}:
    null;
  if(!trigger)reasons.push("compaction_trigger_basis_unavailable");
  const value={allowed:reasons.length===0,originalInputDigest:digest(native),use,profileId:profile?.id??null,content:[...content].sort(),
    reasons:[...new Set(reasons)],duties,dutyBasis,trigger};
  return {id:`in-request-eligibility:${digest(value)}`,...value};
}
export function helarcResponsesInRequestFindings(eligibility:HelarcResponsesInRequestEligibility,subject:string,
  dependencies:TransformationDependencies):readonly TransformationFinding[]{
  if(!eligibility.allowed||!eligibility.use.policy||!eligibility.profileId)throw new TypeError("in_request_compaction_not_eligible");
  const profile=eligibility.use.policy.profiles.find(p=>p.id===eligibility.profileId)!;
  return eligibility.duties.map(d=>({id:`${eligibility.id}:finding:${d.id}`,dutyId:d.id,dutyRevision:d.revision,kind:"method_assurance",conclusion:"supported",
    dependencies,subject,evidence:[eligibility.id,`configured-policy:${digest(eligibility.use.policy)}`],
    limitations:[...profile.limitations,`Basis: ${eligibility.use.policy!.origin}; not direct inspection of this future conversion`]}));
}
