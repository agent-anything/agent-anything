import type {ProviderCallResult,StructuredOutputFormat,ModelJsonValue} from "@agent-anything/model-interaction";
import type {MethodFinding,MethodJob,MethodRelationship,MethodUnknown,RepresentationMethodRequest} from "./RepresentationMethod.js";
import {representationMethodRequirements} from "./RepresentationMethod.js";

export interface GeneratedRepresentation {
  readonly kind:"candidate";
  readonly body:string;
  readonly parts:readonly {readonly text:string;readonly sources:readonly string[]}[];
  readonly covered:readonly string[];
  readonly background:readonly string[];
  readonly losses:readonly {readonly source:string;readonly kind:"omitted"|"precision"|"unknown";readonly description:string}[];
  readonly relationships:readonly {readonly sources:readonly string[];readonly description:string;readonly necessity:"required"|"unknown"}[];
  readonly unknowns:readonly MethodUnknown[];
  readonly missing:readonly string[];
}
export interface AssessedRepresentation {
  readonly kind:"assessment";
  readonly findings:readonly MethodFinding[];
  readonly requirements:readonly {readonly id:string;readonly conclusion:"supported"|"unsupported"|"unknown";readonly basis:string}[];
  readonly missing:readonly string[];
}
const directions=["source_to_candidate","candidate_to_source","relationships","precision"] as const;
const verdicts=["supported","unsupported","unknown"];
const string={type:"string",minLength:1},strings={type:"array",items:string,maxItems:128};
const missing={...strings,description:"Unresolved necessary information or preservation gaps for this scope and purpose. Use [] if none. Do not list information already accurately retained, stylistic preferences, or uncertainty that already existed in the source."};
const object=(properties:Record<string,ModelJsonValue>)=>({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const reference=(allowed:readonly string[]):ModelJsonValue=>allowed.length?{type:"string",enum:[...allowed]}:string;
const references=(allowed:readonly string[]):ModelJsonValue=>({type:"array",items:reference(allowed),maxItems:allowed.length});
export function representationMethodOutputFormat(request:RepresentationMethodRequest,job:MethodJob):StructuredOutputFormat {
  const check=["check","relation","combination"].includes(job.kind),sources=job.sources,candidates=job.candidates;
  const background=request.sources.filter(s=>s.role==="background").map(s=>s.alias);
  const all=[...new Set([...sources,...background,...candidates])];
  const requirements=representationMethodRequirements(request);
  const unknownSchema=object({kind:{type:"string",enum:["source","preservation_gap","residual"]},source:reference(all),description:string});
  const finding=object({conclusion:{type:"string",enum:verdicts},sources:{...references(sources) as object,minItems:sources.length},candidates:{...references(candidates) as object,minItems:candidates.length},basis:string,unknowns:{type:"array",items:unknownSchema,maxItems:128}});
  return {kind:"json_schema",name:check?"representation_assessment":"representation_candidate",schemaId:check?"representation-assessment":"representation-candidate",schemaRevision:"1",
    schema:check?object({kind:{const:"assessment"},findings:object(Object.fromEntries(directions.map(direction=>[direction,finding]))),
      requirements:{type:"array",minItems:requirements.length,maxItems:requirements.length,items:object({id:reference(requirements.map(r=>r.id)),conclusion:{type:"string",enum:verdicts},basis:string})},missing}):
      object({kind:{const:"candidate"},parts:{type:"array",minItems:1,maxItems:128,items:object({text:string,sources:{...references(sources) as object,minItems:1}})},covered:references(sources),background:references(background),losses:{type:"array",maxItems:128,items:object({source:reference(sources),kind:{type:"string",enum:["omitted","precision","unknown"]},description:string})},
        relationships:{type:"array",maxItems:128,items:object({sources:references([...sources,...background]),description:string,necessity:{type:"string",enum:["required","unknown"]}})},unknowns:{type:"array",items:unknownSchema,maxItems:128},missing})};
}
export class RepresentationMethodResultError extends Error {
  constructor(readonly code:string,readonly details:unknown){super(code);this.name="RepresentationMethodResultError";}
}
export function parseRepresentationMethodOutput(result:ProviderCallResult,request:RepresentationMethodRequest,job:MethodJob):GeneratedRepresentation|AssessedRepresentation {
  if(result.kind!=="succeeded")throw new RepresentationMethodResultError(result.kind==="failed"?result.failure.code:result.kind,result);
  if(result.response.kind!=="structured_generation")throw new RepresentationMethodResultError("representation_output_protocol_invalid",result.response.kind);
  const value=result.response.output;
  const check=["check","relation","combination"].includes(job.kind);
  strict(value,check?["kind","findings","requirements","missing"]:["kind","parts","covered","background","losses","relationships","unknowns","missing"]);
  const sources=new Set(job.sources),background=new Set(request.sources.filter(s=>s.role==="background").map(s=>s.alias)),candidates=new Set(job.candidates);
  if(check) {
    if(value.kind!=="assessment")invalid("kind");
    strict(value.findings,directions);
    const findings=directions.map(direction=>{
      const item=(value.findings as Record<string,unknown>)[direction];
      strict(item,["conclusion","sources","candidates","basis","unknowns"]);
      if(!verdicts.includes(item.conclusion as string))invalid("finding");
      text(item.basis);refs(item.sources,sources,"findings.sources");refs(item.candidates,candidates,"findings.candidates");unknowns(item.unknowns,new Set([...sources,...background,...candidates]));
      return {...item,direction} as unknown as MethodFinding;
    });
    if(findings.length!==4||new Set(findings.map(f=>f.direction)).size!==4)invalid("bidirectional_coverage");
    const required=representationMethodRequirements(request).map(r=>r.id);
    const requirements=array(value.requirements).map(item=>{strict(item,["id","conclusion","basis"]);text(item.id);text(item.basis);if(!required.includes(item.id)||!verdicts.includes(item.conclusion as string))invalid("requirement");return item;});
    if(requirements.length!==required.length||new Set(requirements.map(r=>r.id)).size!==required.length)invalid("requirement_coverage");
    for(const direction of findings) {
      if(direction.sources.length!==sources.size||direction.candidates.length!==candidates.size)invalid("finding_scope");
    }
    for(const missing of array(value.missing))text(missing);
    return {...value,findings} as unknown as AssessedRepresentation;
  } else {
    if(value.kind!=="candidate")invalid("kind");refs(value.covered,sources,"covered");refs(value.background,background,"background");
    const parts=array(value.parts);if(!parts.length)invalid("parts");
    for(const part of parts){strict(part,["text","sources"]);text(part.text);refs(part.sources,sources,"parts.sources");if(!(part.sources as string[]).length)invalid("part_source");}
    if((value.covered as string[]).length!==sources.size)invalid("source_coverage");
    for(const loss of array(value.losses)) {strict(loss,["source","kind","description"]);if(!sources.has(loss.source as string)||!["omitted","precision","unknown"].includes(loss.kind as string))invalid("loss");text(loss.description);}
    for(const relation of array(value.relationships)){strict(relation,["sources","description","necessity"]);refs(relation.sources,new Set([...sources,...background]));text(relation.description);if(!["required","unknown"].includes(relation.necessity as string))invalid("relationship");}
    unknowns(value.unknowns,new Set([...sources,...background]));
  }
  for(const missing of array(value.missing))text(missing);
  return {...value,body:(value.parts as {text:string}[]).map(p=>p.text).join("\n\n")} as unknown as GeneratedRepresentation;
}
export function representationAssessmentSupported(value:AssessedRepresentation,scope:"both"|"source"|"candidate"="both"):boolean {
  const required=scope==="source"?["source_to_candidate","precision"]:scope==="candidate"?["candidate_to_source","precision"]:directions;
  return value.missing.length===0&&value.findings.filter(f=>required.includes(f.direction)).every(f=>f.conclusion==="supported"&&!f.unknowns.some(u=>u.kind==="preservation_gap"))&&value.requirements.every(r=>scope==="both"?r.conclusion==="supported":r.conclusion!=="unsupported");
}
export function discoveredRelationships(id:string,value:GeneratedRepresentation):readonly MethodRelationship[] {
  return value.relationships.map((r,i)=>({id:`${id}:relationship:${i}`,sources:r.sources,basis:`method finding:${id}`,description:r.description,requiresCommonEvidence:r.necessity==="required"}));
}
function strict(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))invalid("fields");
}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||!value.trim())invalid("text");}
function array(value:unknown):unknown[]{if(!Array.isArray(value)||value.length>128)invalid("array");return value;}
function refs(value:unknown,allowed:ReadonlySet<string>,field="relationships.sources"):void {const values=array(value);if(new Set(values).size!==values.length||values.some(v=>typeof v!=="string"||!allowed.has(v)))throw new RepresentationMethodResultError("representation_output_reference_invalid",{field,received:values,allowed:[...allowed],rule:"Use only the supplied aliases, at most once each. Use [] when there are no references."});}
function unknowns(value:unknown,allowed:ReadonlySet<string>):void{for(const u of array(value)){strict(u,["kind","source","description"]);if(!["source","preservation_gap","residual"].includes(u.kind as string)||!allowed.has(u.source as string))invalid("unknown");text(u.description);}}
function invalid(field:string):never{throw new RepresentationMethodResultError(`representation_output_${field}_invalid`,{field});}
