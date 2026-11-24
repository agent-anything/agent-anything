import {describe,it,expect} from "vitest";
import {assessInputCapacity,modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {bindModelAgentComposition,OPENAI_RESPONSES} from "@agent-anything/model-interaction/protocol";
import type {ActivityStageState} from "../activity/index.js";
import {nativeInputBodyDigest,confirmNativeInputPreparation,type NativeInputPreparationEvidence} from "./NativeInputPreparationEvidence.js";
import {validateRepresentationMethodRequest,type RepresentationMethodRequest} from "./methods/RepresentationMethod.js";
import {createRepresentationMethodContent} from "./methods/RepresentationMethodInput.js";
const ref=(id:string)=>({id,revision:"1"});
function fixture(){
  const scope={id:"scope",runId:"root",recipient:"agent",purpose:"task",owner:"context-representation",target:"config:1",authorityBasis:"authority",continuity:"task"};
  const body='{"model":"controlled","input":[{"role":"user","content":"Original fact 7391 is uncertain"}]}';
  const policy={id:"capacity",revision:"1",purpose:"task",basis:"Explicit unknown tokens",allowUnknown:true,allowEstimatedFit:false};
  const capacity={inputId:"input",measurements:[],limits:[],assessment:assessInputCapacity({encodedInputId:"input",targetRevision:scope.target,purpose:"task",evidence:[],limits:[],reservations:[],policy})};
  const value={kind:"native_input_preparation" as const,revision:"1" as const,scope,inputId:"input",exactInput:{kind:"retained_native",body},
    projection:{owner:"native-input",revision:"1"},encoded:{mediaType:"application/json",body,bodyDigest:nativeInputBodyDigest(body)},capacity};
  const origin={pathId:"preparation",stageId:"stage",rawResultId:"raw",receiptId:"accepted"};
  const evidence:NativeInputPreparationEvidence={value,origin};
  const stage={request:{id:"stage",pathId:"preparation"},status:"accepted",result:{id:"raw",outcome:"returned",completeness:"complete"},
    receipt:{id:"accepted",resultId:"raw",requestId:"stage",owner:scope.owner,progress:{nativeInputPreparation:value}}} as unknown as ActivityStageState;
  const protocol=OPENAI_RESPONSES,participant={protocol,implementation:ref("native-owner")};
  const composition=bindModelAgentComposition({agent:ref("agent"),protocol,configuration:{configuration:ref("config"),protocol,model:"controlled",connectionBinding:ref("connection")},
    adapter:participant,task:{purpose:ref("task"),input:participant,interpreter:participant},auxiliary:[{purpose:ref("context_representation"),input:participant,interpreter:participant}]});
  const recipient={runId:"root",recipient:"context-representation",purpose:"context_representation"};
  const request:RepresentationMethodRequest={kind:"representation_method",method:"check_combination",methodRevision:"1",recipient,
    objective:"Check the complete proposed native input against the original facts and requirements.",requirements:[],relationships:[],sourceBoundary:"boundary",deliveryIds:[],
    combinationDigest:digest(value.exactInput),combination:{native:evidence,scope,subjects:[ref("candidate")]},combine:"keep",omission:null,search:null,
    nativeComposition:composition,targetRevision:scope.target,sources:["source","candidate"].map((alias,order)=>({alias,role:alias as "source"|"candidate",
      access:{id:alias,holdId:alias,recipient,range:{materialId:alias,version:"1",coordinate:"bytes",start:0,end:20}},representation:alias==="candidate"?ref(alias):null,
      order,label:alias,originalRole:alias,indivisibleGroup:alias})),capacity:{limits:[],reservations:[],policy:{...policy,purpose:recipient.purpose},maximumCombinations:1,maximumMeasurements:0},
    bounds:{readBytes:10000,storedBytes:10000,modelCalls:1,repairs:0,levels:1,pageBytes:4096,ranges:4}};
  return {evidence,stage,request};
}
describe("native complete-input preparation evidence",()=>{
  it("confirms accepted native evidence without requiring a generic request",()=>{
    const f=fixture();expect(()=>confirmNativeInputPreparation(f.evidence,f.stage)).not.toThrow();
    expect(()=>validateRepresentationMethodRequest(f.request)).not.toThrow();
    const content=createRepresentationMethodContent(f.request,{id:"check",kind:"combination",sources:["source"],candidates:["candidate"],level:0,repair:0,feedback:null},[]);
    expect(content.sections.find(s=>s.id.endsWith(":combination-body"))!.content).toEqual({kind:"text",text:f.evidence.value.encoded.body});
    expect(JSON.stringify(content)).toContain("originalAcceptance");expect(JSON.stringify(content)).not.toContain('"positions"');
  });
  it.each(["body","capacity","scope","receipt","result","stage"])("rejects changed %s evidence",kind=>{
    const f=fixture(),changed=structuredClone(f.evidence) as any;
    if(kind==="body")changed.value.encoded.body+=" ";
    if(kind==="capacity")changed.value.capacity.assessment.allowed=false;
    if(kind==="scope")changed.value.scope.recipient="child";
    if(kind==="receipt")changed.origin.receiptId="later";
    if(kind==="result")changed.origin.rawResultId="other";
    if(kind==="stage")changed.origin.stageId="other";
    expect(()=>confirmNativeInputPreparation(changed,f.stage)).toThrow();
  });
  it("cannot relabel one opaque native value as another checked input",()=>{
    const f=fixture(),r=structuredClone(f.request);(r.combination!.native!.value as any).exactInput={other:true};
    expect(()=>validateRepresentationMethodRequest(r)).toThrow("representation_native_combination_binding_invalid");
  });
});
