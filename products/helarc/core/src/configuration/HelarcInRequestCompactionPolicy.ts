export const HELARC_COMPACTION_PRESERVATION = [
  "goals_and_constraints", "sources_and_authority", "execution_and_pending_work",
  "references_and_changes", "uncertainty_and_disagreement", "details_and_discoverability",
] as const;
export type HelarcCompactionPreservation = typeof HELARC_COMPACTION_PRESERVATION[number];
export type HelarcCompactionPermission = "accepted" | "unassessed" | "excluded";
export type HelarcCompactionContent = "text" | "function_calls" | "reasoning" | "compaction" | "images" | "files" | "remote_tools";
export interface HelarcCompactionUseProfile {
  readonly id:string;
  readonly content:readonly HelarcCompactionContent[];
  readonly transports:readonly ("http"|"websocket")[];
  readonly continuities:readonly ("replay"|"stored-response"|"connection-memory")[];
  readonly background:boolean;
  readonly preservation:Readonly<Record<HelarcCompactionPreservation,HelarcCompactionPermission>>;
  readonly repeated:HelarcCompactionPermission;
  readonly specialRequirements:readonly {readonly id:string;readonly revision:string}[];
  readonly limitations:readonly string[];
}
/** Human-adopted use conditions. No evaluator runtime or report format is imported. */
export interface HelarcInRequestCompactionPolicy {
  readonly revision:"1";
  readonly target:string;
  readonly origin:"provider_documentation"|"external_evaluation"|"unassessed";
  readonly basis:string;
  readonly reviewedAt:string;
  readonly support:HelarcCompactionPermission;
  readonly profiles:readonly HelarcCompactionUseProfile[];
  readonly trigger:{readonly windowTokens:number|null;readonly thresholdTokens:number|null;readonly basis:string};
}
const permission=(x:unknown)=>x==="accepted"||x==="unassessed"||x==="excluded";
const text=(x:unknown):x is string=>typeof x==="string"&&x.length>0&&x.length<=8192&&!/[\u0000-\u0008]/u.test(x);
function record(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))
    throw new TypeError("in_request_compaction_policy_invalid");
}
function choices(value:unknown,allowed:readonly string[],empty=false):void{
  if(!Array.isArray(value)||!empty&&!value.length||value.length>allowed.length||new Set(value).size!==value.length||value.some(v=>!allowed.includes(v)))
    throw new TypeError("in_request_compaction_policy_choices_invalid");
}
export function snapshotHelarcInRequestCompactionPolicy(value:unknown):HelarcInRequestCompactionPolicy{
  record(value,["revision","target","origin","basis","reviewedAt","support","profiles","trigger"]);
  if(value.revision!=="1"||!text(value.target)||!text(value.basis)||typeof value.reviewedAt!=="string"||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.reviewedAt)||!Number.isFinite(Date.parse(value.reviewedAt))||
    new Date(value.reviewedAt).toISOString().slice(0,10)!==value.reviewedAt||
    !["provider_documentation","external_evaluation","unassessed"].includes(value.origin as string)||!permission(value.support)||
    value.support==="accepted"&&value.origin==="unassessed"||
    !Array.isArray(value.profiles)||value.profiles.length>16)throw new TypeError("in_request_compaction_policy_invalid");
  record(value.trigger,["windowTokens","thresholdTokens","basis"]);
  if(!text(value.trigger.basis))throw new TypeError("in_request_compaction_trigger_invalid");
  for(const key of ["windowTokens","thresholdTokens"] as const){const n=value.trigger[key];
    if(n!==null&&(!Number.isSafeInteger(n)||(n as number)<1000||(n as number)>100_000_000))throw new TypeError("in_request_compaction_trigger_invalid");}
  if(value.trigger.thresholdTokens!==null&&value.trigger.windowTokens!==null&&
    (value.trigger.thresholdTokens as number)>=(value.trigger.windowTokens as number))
    throw new TypeError("in_request_compaction_trigger_invalid");
  const ids=new Set<string>();
  for(const profile of value.profiles){
    record(profile,["id","content","transports","continuities","background","preservation","repeated","specialRequirements","limitations"]);
    if(!text(profile.id)||ids.has(profile.id)||typeof profile.background!=="boolean"||!permission(profile.repeated))throw new TypeError("in_request_compaction_profile_invalid");
    ids.add(profile.id);
    choices(profile.content,["text","function_calls","reasoning","compaction","images","files","remote_tools"]);
    choices(profile.transports,["http","websocket"]);choices(profile.continuities,["replay","stored-response","connection-memory"]);
    record(profile.preservation,HELARC_COMPACTION_PRESERVATION);
    if(HELARC_COMPACTION_PRESERVATION.some(k=>!permission((profile.preservation as Record<string,unknown>)[k]))||
      !Array.isArray(profile.specialRequirements)||profile.specialRequirements.length>128||!Array.isArray(profile.limitations)||
      profile.limitations.length>64||profile.limitations.some(v=>!text(v)))throw new TypeError("in_request_compaction_profile_invalid");
    const requirements=new Set<string>();
    for(const r of profile.specialRequirements){record(r,["id","revision"]);
      if(!text(r.id)||!text(r.revision)||requirements.has(r.id))throw new TypeError("in_request_compaction_requirement_invalid");requirements.add(r.id);}
  }
  return structuredClone(value) as unknown as HelarcInRequestCompactionPolicy;
}

const documentation="https://developers.openai.com/api/docs/guides/compaction";
const modelDocumentation:Readonly<Record<string,string>>={
  "gpt-5.3-codex":"https://developers.openai.com/api/docs/models/gpt-5.3-codex",
  "gpt-5.4":"https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4",
  "gpt-5.4-mini":"https://developers.openai.com/api/docs/changelog",
  "gpt-5.4-nano":"https://developers.openai.com/api/docs/changelog",
};
/** Exact documented targets only; unknown models still get an explicit closed default. */
export function defaultHelarcInRequestCompactionPolicy(input:{readonly protocol:string;readonly model:string;readonly target:string;
  readonly officialEndpoint:boolean}):HelarcInRequestCompactionPolicy{
  const model=input.model.trim(),documented=input.protocol==="openai.responses"&&input.officialEndpoint&&
    Object.hasOwn(modelDocumentation,model);
  const responses=input.protocol==="openai.responses";
  return {revision:"1",target:input.target,origin:documented?"provider_documentation":"unassessed",reviewedAt:"2026-11-17",
    basis:documented?`${documentation}; ${modelDocumentation[model]}; adopted native semantic continuation, not application evaluation`:
      responses?"No adopted model/route-specific in-request compaction evidence":"This Model Interaction Protocol has no established in-request compaction implementation",
    support:documented?"accepted":responses?"unassessed":"excluded",
    profiles:documented?[{id:"documented-text-native-continuation-v1",content:["text","function_calls","reasoning","compaction"],
      transports:["http"],continuities:["replay","stored-response"],background:false,
      preservation:Object.fromEntries(HELARC_COMPACTION_PRESERVATION.map(k=>[k,"accepted"])) as Record<HelarcCompactionPreservation,HelarcCompactionPermission>,
      repeated:"accepted",specialRequirements:[],limitations:[
        "Provider method assurance for general semantic continuation; no application evaluation performed",
        "Opaque internal representation is not directly inspected; no exactness or universal retention guarantee",
        "Image, file, hosted-tool, background and WebSocket combinations need separate adopted evidence",
      ]}]:[],
    trigger:{windowTokens:model==="gpt-5.3-codex"&&documented?400_000:null,
      thresholdTokens:model==="gpt-5.3-codex"&&documented?200_000:null,
      basis:model==="gpt-5.3-codex"&&documented?`${documentation} example threshold; ${modelDocumentation[model]} window; not a hard output cap`:
        "Threshold requires an explicit adopted value and applicable window evidence"}};
}
