import {describe,it,expect,vi} from "vitest";
import {createHash} from "node:crypto";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import type {ContextSelectionPort} from "@agent-anything/context/selection";
import {bindModelAgentComposition,OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT} from "@agent-anything/model-interaction/protocol";
import {OPENAI_RESPONSES_ADAPTER,DEEPSEEK_CHAT_ADAPTER,OLLAMA_CHAT_ADAPTER} from "@agent-anything/provider-integrations/native";
import {createNativeTaskHistorySeed,projectNativeTaskHistory,retainInputPresentation,type TaskDecisionInputSources} from "@agent-anything/agent-runtime/decision";
import type {HelarcAgentOutput} from "../HelarcController.js";
import {HELARC_NATIVE_TASK_INTERPRETER} from "./HelarcNativeTask.js";
import {prepareHelarcResponsesTask,prepareHelarcDeepSeekTask,prepareHelarcOllamaTask,readHelarcNativeTaskEvidence,adoptHelarcNativeTaskInput,type HelarcNativeTaskInputPorts} from "./HelarcNativeTaskInput.js";
import {validateHelarcNativeWorkingSources} from "./HelarcNativeWorkingSources.js";
const ref=(id:string)=>({id,revision:"1"});
const profiles=[{protocol:OPENAI_RESPONSES,adapter:OPENAI_RESPONSES_ADAPTER,prepare:prepareHelarcResponsesTask},
  {protocol:DEEPSEEK_CHAT_COMPLETIONS,adapter:DEEPSEEK_CHAT_ADAPTER,prepare:prepareHelarcDeepSeekTask},
  {protocol:OLLAMA_CHAT,adapter:OLLAMA_CHAT_ADAPTER,prepare:prepareHelarcOllamaTask}];
function fixture(profile:typeof profiles[number]){
  const {protocol,adapter}=profile,agent={...ref("child"),instructions:{blocks:[]},output:{validate:()=>({valid:true})}};
  const material=ref("original-material"),execution=ref("original-execution");
  const preservation={obligations:[{id:"method",requirement:"exact" as const,basis:"Preserve the agreed method"}],
    relationships:[{kind:"requires" as const,source:{owner:"parent",kind:"method",...ref("method-source")}}]};
  const input={runId:"child-run",agent,task:{id:"task",input:{prompt:"must not replace the accepted Parent assignment",material_refs:[material],execution_refs:[execution]}},
    inputItems:[{id:"assignment",role:"user",content:"Use the supplied method for the next image",metadata:{source:"delegation_objective"}}],
    interaction:{kind:"native_evidence",entries:[],seed:null,unsettledCalls:[]},context:{blocks:[{id:"method",contribution:ref("method-source"),
      payload:{kind:"text",text:"Preserve the edge alpha"},preservation}]},plan:null,planLimits:{maxSteps:8,maxStepLength:500,maxExplanationLength:2000},
    toolExposure:{controllerRequestId:"decision"},workspace:null,permission:{profile:{},authority:{hasAdditionalFileSystemRead:false,hasAdditionalFileSystemWrite:false,hasAdditionalNetwork:false},
      approval:{canRequest:false,reviewer:"user"}}} as unknown as TaskDecisionInputSources<HelarcAgentOutput>;
  const composition=bindModelAgentComposition({agent:ref("child"),protocol,configuration:{protocol,configuration:ref("configuration"),connectionBinding:ref("connection"),model:"controlled"},
    adapter:{implementation:adapter,protocol},task:{purpose:ref("task"),input:{implementation:ref("input"),protocol},interpreter:{implementation:HELARC_NATIVE_TASK_INTERPRETER,protocol}},auxiliary:[]});
  const ports={composition,journal:{command:async()=>{throw new Error("Opening must not read another Run's history");}},
    controller:{protocolInstructions:[],createCallableCatalog:()=>({definitions:[],bindings:[]})},
    conditions:{input:ref("decision"),authority:ref("authority"),resources:ref("resources"),control:ref("control")}} as unknown as HelarcNativeTaskInputPorts;
  return {input,ports,preservation,material,execution};
}
describe.each(profiles)("$protocol.id task opening custody",profile=>{
  async function retiredHistory(){
    const f=fixture(profile),first=await profile.prepare(f.input,f.ports),prepared={...first.prepared,selectedInputId:"old-input"},b=prepared.binding;
    const source={scope:b.scope,protocol:b.protocol,interpretation:b.adapter,operationId:b.operationId,record:b.record,
      position:{format:"json-pointer",value:""},nativeIdentity:null};
    const evidence={scope:b.scope,interpreter:b.interpreter,sources:[source],acceptance:b.acceptance};
    const response=profile.protocol.id===OPENAI_RESPONSES.id?{object:"response",id:"r",status:"completed",output:[{type:"message",id:"m",role:"assistant",status:"completed",content:[{type:"output_text",text:"Recorded reply",annotations:[]}]}]}:
      profile.protocol.id===DEEPSEEK_CHAT_COMPLETIONS.id?{object:"chat.completion",id:"r",choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"Recorded reply"}}]}:
      {model:"controlled",message:{role:"assistant",content:"Recorded reply"},done:true,done_reason:"stop"};
    const native={kind:"helarc_native_input",wire:prepared.wire,workingSources:prepared.workingSources,
      manifest:{scope:b.scope,groups:[{items:prepared.workingItems}]}};
    const selected={scope:{runId:f.input.runId,recipient:b.scope.recipientId,purpose:b.scope.purpose.id},
      input:{id:"old-input",activityId:b.scope.activityId,exactInput:native,nativeConsumer:{protocol:b.protocol,compositionDigest:b.scope.compositionDigest}}};
    const blocks=new Map<string,Buffer>();
    const retain=(id:string,value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value));blocks.set(id,bytes);return {id,activityId:b.scope.activityId,bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`};};
    const state={activity:first.activity,input:retain("input",prepared),contextInput:{id:"old-input",digest:digest(native)}};
    const accepted={evidence,result:retain("result",{format:"helarc.native-task-decision.v1",proposal:{evidence,text:"Recorded reply"}})};
    const record={kind:"observation",source,content:retain("response",response)};
    const command=vi.fn(async(c:any)=>{
      if(c.kind==="state")return state;if(c.kind==="acceptance")return accepted;if(c.kind==="record")return record;
      if(c.kind==="content_read"){const bytes=blocks.get(c.content.id)!;return {bytesBase64:bytes.subarray(c.offset,c.offset+c.length).toString("base64"),next:c.offset+c.length<bytes.length?c.offset+c.length:null};}
      throw new Error(`Unexpected journal command: ${c.kind}`);
    });
    const selectionCommand=vi.fn(async(c:any)=>{if(c.checkCurrentControl)throw new Error("input_retired");return selected;});
    const ports={...f.ports,journal:{command} as HelarcNativeTaskInputPorts["journal"],contextSelections:{command:selectionCommand} as ContextSelectionPort};
    const interaction={kind:"native_evidence" as const,seed:null,unsettledCalls:[],entries:[{kind:"purpose" as const,evidence,calls:[]}]};
    const next={...f.input,interaction,toolExposure:{...f.input.toolExposure,controllerRequestId:"next"}} as TaskDecisionInputSources<HelarcAgentOutput>;
    return {f,ports,next,state,selected,prepared,selectionCommand,command};
  }
  it("uses accepted history after input retirement without reviving the old sending authority",async()=>{
    const h=await retiredHistory(),next=await profile.prepare(h.next,h.ports);
    expect(JSON.stringify(next.prepared.workingItems)).toContain("Recorded reply");
    expect(next.prepared.workingItems.slice(0,h.prepared.workingItems.length)).toEqual(h.prepared.workingItems);
    const evidence=await readHelarcNativeTaskEvidence(h.next.interaction as Parameters<typeof readHelarcNativeTaskEvidence>[0],h.ports);
    expect(JSON.stringify(evidence)).toContain("Recorded reply");
    expect(h.selectionCommand.mock.calls.every(([c])=>c.checkCurrentControl===false)).toBe(true);
    await expect(adoptHelarcNativeTaskInput(h.prepared,h.f.input,"old-input",h.ports.contextSelections!)).rejects.toThrow("input_retired");
    expect(h.command.mock.calls.every(([c])=>["state","acceptance","record","content_read"].includes(c.kind))).toBe(true);
  });
  it.each(["digest","activity","recipient"])("rejects altered retired history %s",async field=>{
    const h=await retiredHistory();
    if(field==="digest")h.state.contextInput.digest="changed";
    if(field==="activity")h.selected.input.activityId="another-activity";
    if(field==="recipient")h.selected.scope.recipient="parent";
    await expect(profile.prepare(h.next,h.ports)).rejects.toThrow("helarc_native_selected_working_input_changed");
  });
  it("imports consecutive cancelled assignments in order without inventing native responses",async()=>{
    const boundary=(runId:string)=>{
      const source={owner:"runtime",kind:"run_commit",id:`${runId}:commit:1`,revision:"1",runId};
      const item=(id:string,text:string)=>retainInputPresentation({id:`${runId}:${id}`,source,kind:"conversation_opening",role:"user",necessity:"mandatory",content:{kind:"text",text},
        provenance:{purpose:"prior_task",recipientRunId:runId,author:"host",sources:[source],presenter:{owner:"host",kind:"presenter",...ref("handoff")},coverage:[source.id],limitations:[]},
        preservation:{obligations:[{id:"truth",requirement:"account",basis:"No response was accepted"}],relationships:[]}});
      return {opening:[item("assignment",`Assignment ${runId}`)],closing:[item("outcome",`Cancelled ${runId}`)]};
    };
    const first=createNativeTaskHistorySeed("first",projectNativeTaskHistory({runId:"first",runRevision:1,items:[]}),boundary("first"));
    const second=createNativeTaskHistorySeed("second",projectNativeTaskHistory({runId:"second",runRevision:1,items:[],seed:first}),boundary("second"));
    const f=fixture(profile),input={...f.input,interaction:projectNativeTaskHistory({runId:f.input.runId,runRevision:1,items:[],seed:second})};
    let authorized=0;const {prepared}=await profile.prepare(input,{...f.ports,authorizeImport:async seed=>{expect(seed).toEqual(second);authorized++;}});
    expect(authorized).toBe(1);
    expect(prepared.workingItems.slice(0,4).map(i=>i.content)).toEqual(["Assignment first","Cancelled first","Assignment second","Cancelled second"]);
    expect(prepared.workingItems.every(i=>i.role==="user")).toBe(true);
    expect(prepared.workingSources.groups.slice(0,4).map(g=>g.originRunId)).toEqual(["first","first","second","second"]);
  });
  it("delivers Parent references as references and preserves source-authored obligations",async()=>{
    const f=fixture(profile),{prepared}=await profile.prepare(f.input,f.ports),body=JSON.parse(prepared.wire.body),items=body.input??body.messages;
    expect(body.instructions).toBeUndefined();expect(items.some((i:any)=>i.role==="system")).toBe(false);
    expect(items[1].content).toBe("Parent assignment:\nUse the supplied method for the next image");
    expect(items.some((i:any)=>i.content.includes('"id":"original-material"')&&i.content.includes("not already read"))).toBe(true);
    expect(items.some((i:any)=>i.content.includes('"id":"original-execution"')&&i.content.includes("not contents already read"))).toBe(true);
    expect(prepared.workingSources.groups.at(-1)!.preservation).toEqual(f.preservation);
    expect(prepared.workingSources.groups.every(g=>g.originRunId==="child-run"&&g.protection.includes("first_delivery"))).toBe(true);
    expect(()=>validateHelarcNativeWorkingSources(prepared.workingSources,items)).not.toThrow();
  });
  it("keeps instructions outside working coordinates and does not reclassify them as material",async()=>{
    const f=fixture(profile),input={...f.input,agent:{...f.input.agent,instructions:{...f.input.agent.instructions,
      blocks:[{content:"Explicitly enabled instruction"}]}}} as TaskDecisionInputSources<HelarcAgentOutput>;
    const {prepared}=await profile.prepare(input,f.ports),body=JSON.parse(prepared.wire.body);
    if(profile.protocol.id===OPENAI_RESPONSES.id)expect(body.instructions).toBe("Explicitly enabled instruction");
    else expect(body.messages[0]).toEqual({role:"system",content:"Explicitly enabled instruction"});
    expect(prepared.workingItems[0]!.content).toContain("Host-provided execution background");
    expect(()=>validateHelarcNativeWorkingSources(prepared.workingSources,prepared.workingItems)).not.toThrow();
  });
});
