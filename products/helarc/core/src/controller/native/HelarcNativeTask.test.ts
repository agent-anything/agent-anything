import {describe,it,expect} from "vitest";
import {OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT,type ModelInteractionProtocolRef} from "@agent-anything/model-interaction/protocol";
import {OPENAI_RESPONSES_ADAPTER,DEEPSEEK_CHAT_ADAPTER,OLLAMA_CHAT_ADAPTER,compileNativeCatalog} from "@agent-anything/provider-integrations/native";
import {HELARC_BASELINE_TOOL_CONTRACTS} from "../../tools/HelarcBaselineToolContracts.js";
import {createHelarcControllerControlDefinitions,HELARC_CONTROLLER_CONTROL_GUIDANCE} from "../HelarcControllerControlGuidance.js";
import {nativeTaskCatalog,HELARC_NATIVE_TASK_INTERPRETER,type HelarcNativeTaskBinding} from "./HelarcNativeTask.js";
import {interpretHelarcResponses,interpretHelarcDeepSeek,interpretHelarcOllama} from "./HelarcNativeTaskReaders.js";

const ref=(id:string)=>({id,revision:"1"});
function binding(protocol:ModelInteractionProtocolRef=OPENAI_RESPONSES,adapter=OPENAI_RESPONSES_ADAPTER,activityId="activity"):HelarcNativeTaskBinding{
  const original:Omit<HelarcNativeTaskBinding,"catalogRevision">={protocol,adapter,interpreter:HELARC_NATIVE_TASK_INTERPRETER,acceptance:ref(`${activityId}:accepted`),requestId:`${activityId}:request`,controllerRequestId:`${activityId}:decision`,operationId:"create",record:ref(`${activityId}:response`),
    scope:{runId:"root",activityId,recipientId:"task",purpose:ref("task"),compositionDigest:`sha256:${"a".repeat(64)}`},schemaMode:protocol.id===OPENAI_RESPONSES.id?"responses-strict":"identity",hasPlan:false,
    planLimits:{maxSteps:20,maxStepLength:1000,maxExplanationLength:2000},catalog:[
      {definition:{name:"final_result",description:"Finish",inputSchema:{type:"object",properties:{response:{type:"string"}},additionalProperties:false}},binding:{kind:"control",callableName:"final_result",control:"final_result"}},
      {definition:{name:"update_plan",description:"Maintain plan",inputSchema:{type:"object",properties:{plan:{type:"array",items:{type:"object",properties:{step:{type:"string"},status:{type:"string",enum:["pending","in_progress","completed"]}},required:["step","status"],additionalProperties:false}}},required:["plan"],additionalProperties:false}},binding:{kind:"control",callableName:"update_plan",control:"update_plan"}},
      {definition:{name:"Write_a1",description:"Write once",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}},binding:{kind:"tool",callableName:"Write_a1",toolName:"Write",tool:{tool:{namespace:"helarc",name:"Write"},revision:"1"},binding:{kind:"operation",operation:{operation:{namespace:"helarc",name:"write"},revision:"1"},revision:"1"}}},
    ]};
  return {...original,catalogRevision:nativeTaskCatalog(original).revision};
}
const call=(name="final_result",args='{"response":null}',id="call1")=>({type:"function_call",id:`fc_${id}`,call_id:id,name,arguments:args,status:"completed"});
const text=(value:string,id="msg")=>({id,type:"message",role:"assistant",content:[{type:"output_text",text:value,annotations:[]}]});
const response=(output:unknown[])=>({id:"resp",object:"response",status:"completed",output});

describe("native Helarc task interpretation",()=>{
  it("realizes the actual baseline Tools and both Plan-presence control catalogs without dropping constraints",()=>{
    for(const hasPlan of [false,true]){
      const definitions=[...HELARC_BASELINE_TOOL_CONTRACTS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})),
        ...createHelarcControllerControlDefinitions(HELARC_CONTROLLER_CONTROL_GUIDANCE,{maxSteps:20,maxStepLength:1000,maxExplanationLength:2000},hasPlan)];
      const catalog=compileNativeCatalog({protocol:OPENAI_RESPONSES,purpose:ref("task"),definitions,mode:"responses-strict"});
      expect(catalog.entries).toHaveLength(definitions.length);
      const plan=catalog.entries.find(c=>c.definition.name==="update_plan")!.codec;
      const value={plan:[{step:"one",status:"in_progress"},{step:"two",status:"in_progress"}]};
      expect(plan.decode(plan.encode(value))).toEqual(value);
      expect(()=>plan.encode({plan:[{step:"",status:"completed"}]})).toThrow("native_arguments_invalid");
    }
  });
  it("interprets original Response items directly, with no artificial Turn",()=>{
    const result=interpretHelarcResponses(response([text("Report"),call()]),binding());
    expect(result.kind).toBe("propose_completion");expect(result.ending).toMatchObject({disposition:"adopted_current",response:"Report"});
    expect(result.calls[0].call.modelCallRef.turnId).toBeNull();expect(result.ending?.sources[0].position.value).toBe("/output/0/content/0");
    expect(result.evidence.sources.map(s=>s.position.value)).toEqual(["","/output/0/content/0","/output/1"]);
  });
  it("keeps explicit empty and whitespace replies distinct from omission",()=>{
    for(const value of ["","  "]){const p=interpretHelarcResponses(response([text("not selected"),call("final_result",JSON.stringify({response:value}))]),binding());expect(p.ending?.response).toBe(value);}
  });
  it("uses the preceding committed task response and excludes another recipient",()=>{
    const priorBinding=binding(OPENAI_RESPONSES,OPENAI_RESPONSES_ADAPTER,"prior"),prior=interpretHelarcResponses(response([text("Prior report")]),priorBinding);
    const previous={scope:priorBinding.scope,acceptance:priorBinding.acceptance,responseRecord:priorBinding.record,text:prior.text};
    expect(interpretHelarcResponses(response([call()]),binding(),previous).ending).toMatchObject({response:"Prior report",disposition:"adopted_previous"});
    expect(()=>interpretHelarcResponses(response([call()]),binding(),{...previous,scope:{...previous.scope,recipientId:"auxiliary"}})).toThrow("helarc_previous_task_source_invalid");
    expect(()=>interpretHelarcResponses(response([call()]),binding(),{...previous,text:previous.text.map(t=>({...t,source:{...t.source,scope:{...t.source.scope,recipientId:"auxiliary"}}}))})).toThrow("helarc_previous_task_source_invalid");
  });
  it("keeps valid co-calls alongside ending; acceptance remains a separate coordinator responsibility",()=>{
    const result=interpretHelarcResponses(response([call("Write_a1",'{"path":"x"}',"w"),call()]),binding());
    expect(result.kind).toBe("propose_completion");expect(result.calls).toHaveLength(2);expect(result.calls[0].binding.kind).toBe("tool");
  });
  it("rejects only invalid or unknown calls with actionable wire-schema feedback",()=>{
    const p=interpretHelarcResponses(response([call("Write_a1",'{"path":null}',"bad"),call("Agent","{}","unknown"),call("Write_a1",'{"path":"x"}',"ok")]),binding());
    expect(p.calls).toHaveLength(1);expect(p.rejections).toHaveLength(2);expect(p.rejections[0].message).toContain("wire schema");expect(p.rejections[1].message).toContain("Write_a1");
  });
  it("rejects conflicting final controls without dropping other work",()=>{
    const p=interpretHelarcResponses(response([call(),call("final_result",'{"response":null}',"f2"),call("Write_a1",'{"path":"x"}',"w")]),binding());
    expect(p.kind).toBe("advance");expect(p.ending).toBeNull();expect(p.rejections).toHaveLength(2);expect(p.calls).toHaveLength(1);
  });
  it("allows parallel in-progress plan steps and rejects a competing final snapshot",()=>{
    const p=interpretHelarcResponses(response([call("update_plan",JSON.stringify({plan:[{step:"A",status:"in_progress"},{step:"B",status:"in_progress"}]}),"p"),call()]),binding());
    expect(p.calls).toHaveLength(1);expect(p.calls[0].binding).toMatchObject({control:"update_plan"});expect(p.rejections).toHaveLength(1);
  });
  it("retains refusal with legitimate co-calls; standalone refusal is not a fake final_result",()=>{
    const refusal={...text("unused"),content:[{type:"refusal",refusal:"Cannot do that part"}]};
    expect(interpretHelarcResponses(response([refusal]),binding()).ending).toMatchObject({call:null,disposition:"refusal"});
    const p=interpretHelarcResponses(response([refusal,call("Write_a1",'{"path":"x"}')]),binding());expect(p.kind).toBe("advance");expect(p.refusals).toHaveLength(1);
  });
  it("does not reinterpret changed original mappings and keeps call IDs stable across re-observation",()=>{
    const b=binding(),raw=response([call("Write_a1",'{"path":"x"}')]);
    const first=interpretHelarcResponses(raw,b),second=interpretHelarcResponses(raw,b);
    expect(second).toEqual(first);
    expect(()=>interpretHelarcResponses(raw,{...b,schemaMode:"identity"})).toThrow("helarc_native_original_mapping_mismatch");
  });
  it("interprets DeepSeek and Ollama native calls without constructing Responses objects",()=>{
    const d=interpretHelarcDeepSeek({id:"d1",object:"chat.completion",choices:[{index:0,finish_reason:"tool_calls",message:{role:"assistant",content:"Report",reasoning_content:"private",tool_calls:[{id:"dc",type:"function",function:{name:"final_result",arguments:"{}"}}]}}]},binding(DEEPSEEK_CHAT_COMPLETIONS,DEEPSEEK_CHAT_ADAPTER));
    expect(d.ending?.response).toBe("Report");expect(d.calls[0].call.modelCallRef.nativeSource?.position.value).toBe("/choices/0/message/tool_calls/0");
    const o=interpretHelarcOllama({model:"m",done:true,done_reason:"stop",message:{role:"assistant",content:"Report",thinking:"private",tool_calls:[{function:{name:"final_result",arguments:{}}}]}},binding(OLLAMA_CHAT,OLLAMA_CHAT_ADAPTER));
    expect(o.ending?.response).toBe("Report");expect(o.calls[0].call.providerCallRef).toBeNull();expect(o.calls[0].call.modelCallRef.nativeSource?.nativeIdentity).toBeNull();
  });
  it("uses actual strict argument spelling in no-ending feedback",()=>{
    const p=interpretHelarcResponses(response([text("Report")]),binding());expect(p.feedback?.message).toContain('{"response":null}');expect(p.feedback?.message).not.toContain("arguments {}");
  });
});
