import {it,expect} from "vitest";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {OPENAI_RESPONSES,bindModelAgentComposition} from "@agent-anything/model-interaction/protocol";
import {bindProtocolModelActivity} from "@agent-anything/agent-runtime/model-access";
import {OPENAI_RESPONSES_ADAPTER} from "@agent-anything/provider-integrations/native";
import {prepareHelarcResponsesStructured,HELARC_NATIVE_STRUCTURED_INTERPRETER} from "./HelarcNativeStructuredExecution.js";
import {prepareHelarcNativeStructuredInput,assertHelarcNativeStructuredInput} from "./HelarcNativeStructuredInput.js";

const ref=(id:string)=>({id,revision:"1"}),participant=(id:string)=>({implementation:ref(id),protocol:OPENAI_RESPONSES});
const purpose=ref("helarc.task-fulfillment");
const composition=bindModelAgentComposition({agent:ref("agent"),protocol:OPENAI_RESPONSES,
  configuration:{configuration:ref("configuration"),protocol:OPENAI_RESPONSES,model:"model",connectionBinding:ref("connection")},
  adapter:{implementation:OPENAI_RESPONSES_ADAPTER,protocol:OPENAI_RESPONSES},
  task:{purpose:ref("task"),interpreter:participant("task-interpreter"),input:participant("task-input")},
  auxiliary:[{purpose,input:participant("auxiliary-input"),interpreter:{implementation:HELARC_NATIVE_STRUCTURED_INTERPRETER,protocol:OPENAI_RESPONSES}}]});
function request(runId="root"){
  const activity=bindProtocolModelActivity({composition,scope:{runId,activityId:`${runId}:evaluation`,recipientId:"agent",purpose,compositionDigest:composition.digest},
    conditions:{input:ref("input"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}});
  return prepareHelarcResponsesStructured({activity,source:ref("source")},{input:[{role:"user",content:"actual evidence"}],
    textSchema:{type:"object",properties:{allowed:{type:"boolean"}},required:["allowed"],additionalProperties:false}});
}
const policy={id:"auxiliary-capacity",revision:"1",purpose:purpose.id,basis:"Original explicit policy",allowUnknown:true,allowEstimatedFit:true};
it("accounts for the exact native wire and distinguishes unknown token fit",()=>{
  const r=request(),inputPreparation=prepareHelarcNativeStructuredInput(r,{limits:[{id:"window",targetRevision:"configuration:1",
    dimension:"shared_tokens",maximum:64000,source:"target declaration"}],reservations:[],policy});
  expect(inputPreparation.measurements[0]?.quantity).toEqual({kind:"exact",value:Buffer.byteLength(r.wire.body)});
  expect(inputPreparation.assessment).toMatchObject({allowed:true,decisions:[{conclusion:"uncertain",reason:"measurement_unavailable"}]});
  expect(()=>assertHelarcNativeStructuredInput({...r,inputPreparation})).not.toThrow();
});
it("never turns a known capacity violation into permission through allowUnknown",()=>{
  const r=request(),inputPreparation=prepareHelarcNativeStructuredInput(r,{limits:[{id:"bytes",targetRevision:"configuration:1",
    dimension:"request_bytes",maximum:1,source:"transport constraint"}],reservations:[],policy});
  expect(inputPreparation.assessment.allowed).toBe(false);
});
it("binds the original Run, source, body, limits and assessment",()=>{
  const r=request(),inputPreparation=prepareHelarcNativeStructuredInput(r,{limits:[],reservations:[],policy});
  expect(()=>assertHelarcNativeStructuredInput({...request("child"),inputPreparation})).toThrow("preparation_changed");
  const body={...JSON.parse(r.wire.body),input:[{role:"user",content:"changed source"}]};
  expect(()=>assertHelarcNativeStructuredInput({...r,wire:{body:JSON.stringify(body),digest:digest(body)},inputPreparation})).toThrow("preparation_changed");
  expect(()=>assertHelarcNativeStructuredInput({...r,inputPreparation:{...inputPreparation,assessment:{...inputPreparation.assessment,allowed:false}}})).toThrow("preparation_changed");
});
it("restores a blocked auxiliary input with its original native count refusal",()=>{
  const r=request(),capacity={limits:[],reservations:[],policy},first=prepareHelarcNativeStructuredInput(r,capacity);
  const refusal={id:"refusal",encodedInputId:first.inputId,targetRevision:first.assessment.targetRevision,
    conditionId:"native-admissibility",evidenceId:"count-result",reason:"complete_input_refused",basis:"Original count mapping",
    source:{owner:"protocol_execution",id:"root:evaluation:input-count",revision:"1"}};
  const inputPreparation=prepareHelarcNativeStructuredInput(r,capacity,[],[refusal]);
  expect(inputPreparation.assessment.allowed).toBe(false);
  expect(()=>assertHelarcNativeStructuredInput(JSON.parse(JSON.stringify({...r,inputPreparation})))).not.toThrow();
  expect(()=>assertHelarcNativeStructuredInput({...r,inputPreparation:{...inputPreparation,
    assessment:{...inputPreparation.assessment,refusals:[]}}})).toThrow("preparation_changed");
});
