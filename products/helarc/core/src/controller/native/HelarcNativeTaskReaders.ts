import { OPENAI_RESPONSES, DEEPSEEK_CHAT_COMPLETIONS, OLLAMA_CHAT } from "@agent-anything/model-interaction/protocol";
import { OPENAI_RESPONSES_ADAPTER, DEEPSEEK_CHAT_ADAPTER, OLLAMA_CHAT_ADAPTER, assertResponsesTaskResponse,
  deepSeekAssistant, ollamaAssistant, NativeProtocolError } from "@agent-anything/provider-integrations/native";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import { HelarcNativeTaskInterpretation, nativeTaskCatalog, type HelarcNativeTaskBinding, type HelarcCommittedTaskReply } from "./HelarcNativeTask.js";
import {inspectHelarcResponsesCompaction} from "./HelarcResponsesCompaction.js";

export function validateHelarcResponsesTaskInput(encoded:string,binding:HelarcNativeTaskBinding,model:string):void{
  const body=JSON.parse(encoded),catalog=nativeTaskCatalog(binding);
  const tools=catalog.entries.map(e=>({type:"function",name:e.definition.name,description:e.definition.description,parameters:e.codec.wire,strict:e.codec.spec.mode==="responses-strict"}));
  if(binding.protocol.id!==OPENAI_RESPONSES.id||body.model!==model||!Array.isArray(body.input)||body.text?.format||
    modelInputValueDigest(body.tools??[])!==modelInputValueDigest(tools)||(tools.length&&(body.tool_choice!=="auto"||body.parallel_tool_calls!==true)))
    throw new NativeProtocolError("helarc_original_responses_input_mismatch");
}
export function validateHelarcDeepSeekTaskInput(encoded:string,binding:HelarcNativeTaskBinding,model:string):void{
  const body=JSON.parse(encoded),catalog=nativeTaskCatalog(binding);
  const tools=catalog.entries.map(e=>({type:"function",function:{name:e.definition.name,description:e.definition.description,parameters:e.codec.wire}}));
  if(binding.protocol.id!==DEEPSEEK_CHAT_COMPLETIONS.id||body.model!==model||!Array.isArray(body.messages)||body.response_format||
    modelInputValueDigest(body.tools??[])!==modelInputValueDigest(tools)||(tools.length&&body.tool_choice!=="auto"))
    throw new NativeProtocolError("helarc_original_deepseek_input_mismatch");
}
export function validateHelarcOllamaTaskInput(encoded:string,binding:HelarcNativeTaskBinding,model:string):void{
  const body=JSON.parse(encoded),catalog=nativeTaskCatalog(binding);
  const tools=catalog.entries.map(e=>({type:"function",function:{name:e.definition.name,description:e.definition.description,parameters:e.codec.wire}}));
  if(binding.protocol.id!==OLLAMA_CHAT.id||body.model!==model||!Array.isArray(body.messages)||body.format||
    modelInputValueDigest(body.tools??[])!==modelInputValueDigest(tools))throw new NativeProtocolError("helarc_original_ollama_input_mismatch");
}

export function interpretHelarcResponses(response:Record<string,unknown>,binding:HelarcNativeTaskBinding,previous:HelarcCommittedTaskReply|null=null,
  compaction:Omit<Parameters<typeof inspectHelarcResponsesCompaction>[0],"response">|null=null){
  assertResponsesTaskResponse(response);
  const conversion=inspectHelarcResponsesCompaction({response,...(compaction??{agreement:null,acceptedAgreementId:null,originalRequestDigest:"absent"})});
  if(!conversion.allowed)throw new NativeProtocolError("helarc_unaccepted_in_request_compaction");
  const task=new HelarcNativeTaskInterpretation(binding,OPENAI_RESPONSES,OPENAI_RESPONSES_ADAPTER);
  task.source("",{kind:"response",id:response.id as string});
  for(const [ordinal,item] of (response.output as Record<string,unknown>[]).entries()){
    const pointer=`/output/${ordinal}`,identity={kind:item.type as string,id:item.id as string};
    if(item.type==="function_call")task.addCall(task.source(pointer,identity),item.call_id as string,item.name as string,item.arguments);
    else if(item.type==="compaction")task.source(pointer,identity);
    else if(item.type==="message")for(const [i,part] of (item.content as Record<string,unknown>[]).entries()){
      const source=task.source(`${pointer}/content/${i}`,identity);
      if(part.type==="output_text")task.addText(source,part.text as string);
      else if(part.type==="refusal")task.addRefusal(source,part.refusal as string);
    }
  }
  return task.finish(previous);
}
export function interpretHelarcDeepSeek(response:Record<string,unknown>,binding:HelarcNativeTaskBinding,previous:HelarcCommittedTaskReply|null=null){
  const message=deepSeekAssistant(response),task=new HelarcNativeTaskInterpretation(binding,DEEPSEEK_CHAT_COMPLETIONS,DEEPSEEK_CHAT_ADAPTER);
  const identity={kind:"chat.completion",id:response.id as string};task.source("",identity);
  if(typeof message.content==="string")task.addText(task.source("/choices/0/message/content",identity),message.content);
  if(typeof message.refusal==="string")task.addRefusal(task.source("/choices/0/message/refusal",identity),message.refusal);
  for(const [i,call] of ((message.tool_calls??[]) as Record<string,unknown>[]).entries()){
    const fn=call.function as Record<string,unknown>;
    task.addCall(task.source(`/choices/0/message/tool_calls/${i}`,{kind:"tool_call",id:call.id as string}),call.id as string,fn.name as string,fn.arguments);
  }
  return task.finish(previous);
}
export function interpretHelarcOllama(response:Record<string,unknown>,binding:HelarcNativeTaskBinding,previous:HelarcCommittedTaskReply|null=null){
  const message=ollamaAssistant(response),task=new HelarcNativeTaskInterpretation(binding,OLLAMA_CHAT,OLLAMA_CHAT_ADAPTER);
  // Ollama has no remote response/call identity: durable record + exact position is the source.
  task.source("",null);task.addText(task.source("/message/content",null),message.content as string);
  for(const [i,call] of ((message.tool_calls??[]) as Record<string,unknown>[]).entries()){
    const fn=call.function as Record<string,unknown>;
    task.addCall(task.source(`/message/tool_calls/${i}`,null),null,fn.name as string,fn.arguments);
  }
  return task.finish(previous);
}
