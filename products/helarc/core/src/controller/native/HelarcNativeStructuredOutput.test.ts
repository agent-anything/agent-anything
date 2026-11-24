import {it,expect} from "vitest";
import {OPENAI_RESPONSES,type NativeModelSourceRef} from "@agent-anything/model-interaction/protocol";
import {compileNativeSchema} from "@agent-anything/provider-integrations/native";
import {assessHelarcResponsesStructured,planHelarcStructuredCorrection} from "./HelarcNativeStructuredOutput.js";
const purpose={id:"representation-generation",revision:"1"};
const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,canonical:{type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false},mode:"responses-strict",root:"body"});
const source:NativeModelSourceRef={scope:{runId:"root",activityId:"aux",recipientId:"generation",purpose,compositionDigest:`sha256:${"b".repeat(64)}`},
  protocol:OPENAI_RESPONSES,interpretation:{id:"openai.responses.adapter",revision:"1"},operationId:"create",record:{id:"response",revision:"1"},
  position:{format:"json-pointer",value:""},nativeIdentity:{kind:"response",id:"response1"}};
const response=(content:unknown[])=>({id:"response1",object:"response",status:"completed",output:[{id:"m",type:"message",role:"assistant",content}]});
const ledger=()=>({runId:"root",recipientId:"generation",purpose,maximumCorrections:1,observations:[]});
it("validates auxiliary content without treating it as a task ending",()=>{
  const assessment=assessHelarcResponsesStructured(response([{type:"output_text",text:'{"answer":"done"}'}]),codec,source);
  expect(assessment.outcome).toBe("valid");expect(assessment.value).toEqual({answer:"done"});expect(planHelarcStructuredCorrection(ledger(),assessment).correction).toBe(false);
});
it("keeps owner-supplied correction bounds across repeated observations and subsequent attempts",()=>{
  const bad=assessHelarcResponsesStructured(response([{type:"output_text",text:'{"answer":3}'}]),codec,source);
  const first=planHelarcStructuredCorrection(ledger(),bad);expect(first.correction).toBe(true);expect(first.feedback).toContain("wire schema");
  const observedAgain={...bad,source:{...source,record:{...source.record,revision:"2"}}};
  expect(planHelarcStructuredCorrection(first.ledger,observedAgain).ledger).toBe(first.ledger);
  const second={...bad,source:{...source,scope:{...source.scope,activityId:"second"},nativeIdentity:{kind:"response",id:"response2"}}};
  expect(planHelarcStructuredCorrection(first.ledger,second).correction).toBe(false);
});
it("does not retry refusals or execute auxiliary tool calls",()=>{
  const refused=assessHelarcResponsesStructured(response([{type:"refusal",refusal:"no"}]),codec,source);
  expect(refused.outcome).toBe("refused");expect(planHelarcStructuredCorrection(ledger(),refused).correction).toBe(false);
  const call=assessHelarcResponsesStructured({...response([]),output:[{id:"f",type:"function_call",call_id:"c",name:"Write",arguments:"{}"}]},codec,source);
  expect(call.failure?.code).toBe("responses_auxiliary_call_forbidden");expect(planHelarcStructuredCorrection(ledger(),call).correction).toBe(false);
});
it("reports native capacity refusal separately from semantic or schema failure",()=>{
  const assessment=assessHelarcResponsesStructured({error:{type:"invalid_request_error",code:"context_length_exceeded",message:"too large"}},codec,source);
  expect(assessment.outcome).toBe("refused");
  expect(assessment.failure?.code).toBe("native_input_capacity_refused");
  expect(planHelarcStructuredCorrection(ledger(),assessment).correction).toBe(false);
});
it("rejects cross-purpose evidence and changed original observations",()=>{
  expect(()=>assessHelarcResponsesStructured(response([]),codec,{...source,scope:{...source.scope,purpose:{id:"task",revision:"1"}}})).toThrow("helarc_structured_purpose_mismatch");
  const bad=assessHelarcResponsesStructured(response([{type:"output_text",text:"invalid"}]),codec,source),first=planHelarcStructuredCorrection(ledger(),bad);
  expect(()=>planHelarcStructuredCorrection(first.ledger,{...bad,failure:{code:"different",details:{}}})).toThrow("helarc_structured_correction_conflict");
});
