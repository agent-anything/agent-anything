import {describe,it,expect,vi} from "vitest";
import {OPENAI_RESPONSES,OLLAMA_CHAT} from "@agent-anything/model-interaction/protocol";
import {compileNativeSchema,prepareResponses,prepareOllamaChat,prepareDeepSeekChat,readResponsesObservation,readResponsesStructured,
  readDeepSeekObservation,readOllamaChatObservation,dispatchNativeHttp,responsesReplayItems,responsesFunctionResult,deepSeekToolResult,ollamaToolResult,mapResponsesReplay,
  responsesCallableExchange,deepSeekCallableExchange,ollamaCallableExchange} from "./index.js";
import type {NativeHttpObservation} from "./NativeHttp.js";
const purpose={id:"task",revision:"1"};
const canonical={type:"object",properties:{required:{type:"string"},optional:{type:"string",enum:["", "yes"]},nullable:{type:["string","null"]},
  nested:{type:"object",properties:{enabled:{type:"boolean"}},additionalProperties:false}},required:["required"],additionalProperties:false};
function schema(value=canonical){return compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,canonical:value,mode:"responses-strict",root:"function"});}
function observation(value:unknown):NativeHttpObservation{return {status:200,requestId:null,body:JSON.stringify(value),frames:[],work:{bytes:0,chunks:1,elapsedMs:0}};}
const response={id:"resp_1",object:"response",status:"completed",output:[
  {id:"rs_1",type:"reasoning",summary:[],encrypted_content:"opaque"},
  {id:"msg_1",type:"message",role:"assistant",phase:"commentary",status:"completed",content:[{type:"output_text",text:"Ready",annotations:[]}]},
  {id:"fc_1",type:"function_call",status:"completed",call_id:"call_1",name:"Write_a1",arguments:'{"path":"x"}'},
],usage:{input_tokens:20,output_tokens:12}};

describe("native schema realization",()=>{
  it.each([{required:"v"},{required:"v",optional:"",nullable:null},{required:"v",nullable:"",nested:{enabled:false}},{required:"v",nested:{}}])("round trips presence without defaults: %j",value=>{
    const codec=schema();expect(codec.decode(codec.encode(value))).toEqual(value);
  });
  it("uses a presence tag for nullable optional fields, not recursive null removal",()=>{
    const codec=schema(),wire=codec.encode({required:"v",nullable:null}) as any;
    expect(wire).toEqual({required:"v",optional:null,nullable:{state:"present",value:null},nested:null});
    expect(codec.decode({...wire,nullable:{state:"absent"}})).toEqual({required:"v"});
    expect(()=>codec.decode({...wire,required:null})).toThrow("native_arguments_invalid");
  });
  it("preserves enum null alternatives and rejects malformed wrapper fields",()=>{
    const codec=schema();expect(()=>codec.decode({required:"v",optional:"no",nullable:{state:"absent"},nested:null})).toThrow();
    expect(()=>codec.decode({required:"v",optional:null,nullable:{state:"absent",value:null},nested:null})).toThrow();
  });
  it("wraps non-object structured bodies without changing canonical values",()=>{
    const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,canonical:{type:"array",items:{type:"string"}},mode:"responses-strict",root:"body"});
    expect(codec.encode([])).toEqual({result:[]});expect(codec.decode({result:["a"]})).toEqual(["a"]);
  });
  it("resolves local references and refuses unsupported structural changes before dispatch",()=>{
    const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,canonical:{type:"object",properties:{v:{$ref:"#/$defs/value"}},additionalProperties:false,$defs:{value:{type:"string"}}},mode:"responses-strict",root:"function"});
    expect(codec.decode(codec.encode({v:"x"}))).toEqual({v:"x"});
    expect(()=>compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,canonical:{type:"object",additionalProperties:true},mode:"responses-strict",root:"function"})).toThrow("native_schema_open_object_unsupported");
  });
  it("round trips overlapping canonical variants through an explicit wire discriminator",()=>{
    const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,mode:"responses-strict",root:"body",canonical:{anyOf:[
      {type:"object",properties:{v:{type:"string"}},additionalProperties:false},
      {type:"object",properties:{v:{type:["string","null"]}},additionalProperties:false}]}});
    for(const value of [{},{v:""},{v:null}])expect(codec.decode(codec.encode(value))).toEqual(value);
    expect(codec.encode({})).toEqual({result:{variant:"0",value:{v:null}}});
  });
  it("admits explicit identity profiles without narrowing open objects or refinements",()=>{
    const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,canonical:{type:"object",properties:{n:{type:"number",minimum:2}},additionalProperties:true},mode:"identity",root:"function"});
    expect(codec.decode({n:2,other:null})).toEqual({n:2,other:null});expect(()=>codec.decode({n:1})).toThrow();
  });
  it("reuses only exact immutable schemas; old binding remains independent",()=>{
    expect(schema()).toBe(schema());
    const changed=compileNativeSchema({protocol:OLLAMA_CHAT,purpose,canonical,mode:"identity",root:"function"});
    expect(changed.binding).not.toEqual(schema().binding);
  });
  it("retains value bounds, enum types and owner defaults without applying defaults",()=>{
    const codec=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,mode:"responses-strict",root:"function",canonical:{type:"object",additionalProperties:false,properties:{
      n:{type:"integer",minimum:1,maximum:3},label:{type:"string",minLength:1,maxLength:3,pattern:"^a"},mode:{enum:["a","b"]},
      wait:{anyOf:[{const:0},{type:"integer",minimum:1000,maximum:30000}],default:10000}}}});
    expect(codec.decode(codec.encode({}))).toEqual({});
    const input={n:2,label:"ab",mode:"a",wait:0};expect(codec.decode(codec.encode(input))).toEqual(input);
    expect(()=>codec.encode({...input,n:4})).toThrow("native_arguments_invalid");
    expect(()=>codec.encode({...input,label:"x"})).toThrow("native_arguments_invalid");
    expect(()=>compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,mode:"identity",root:"body",canonical:{type:"string",format:"unknown-format"}})).toThrow("native_schema_configuration_invalid");
  });
});
describe("native requests and evidence",()=>{
  it("preserves actual local results in native history and rejects incomplete or duplicated groups",()=>{
    expect(responsesCallableExchange(response,[{call_id:"call_1",output:"denied"}])).toEqual([...response.output,{type:"function_call_output",call_id:"call_1",output:"denied"}]);
    expect(()=>responsesCallableExchange(response,[])).toThrow("responses_result_group_mismatch");
    expect(()=>responsesCallableExchange(response,[{call_id:"call_1",output:"one"},{call_id:"call_1",output:"two"}])).toThrow();
    const message={role:"assistant",content:"Working",reasoning_content:"original reasoning",tool_calls:[{id:"a",type:"function",function:{name:"Write",arguments:"{}"}}]};
    const deep={id:"d",object:"chat.completion",choices:[{index:0,finish_reason:"tool_calls",message}]};
    expect(deepSeekCallableExchange(deep,[{tool_call_id:"a",content:"failed"}])).toEqual([message,{role:"tool",tool_call_id:"a",content:"failed"}]);
    expect(()=>deepSeekCallableExchange(deep,[{tool_call_id:"other",content:"ok"}])).toThrow("deepseek_result_group_mismatch");
    const om={role:"assistant",content:"Working",thinking:"original thinking",tool_calls:[{function:{name:"Write",arguments:{path:"a"}}},{function:{name:"Write",arguments:{path:"b"}}}]};
    const ollama={model:"m",done:true,done_reason:"stop",message:om};
    expect(ollamaCallableExchange(ollama,[{ordinal:1,content:"b"},{ordinal:0,content:"a"}])).toEqual([om,{role:"tool",tool_name:"Write",content:"a"},{role:"tool",tool_name:"Write",content:"b"}]);
    expect(()=>ollamaCallableExchange(ollama,[{ordinal:0,content:"a"},{ordinal:0,content:"a"}])).toThrow("ollama_result_group_mismatch");
  });
  it("uses Responses fields and preserves omitted Instructions",()=>{
    const p=prepareResponses({model:"fixture",input:[{role:"user",content:"task"}],purpose,stream:true,store:false,
      tools:[{name:"final_result",description:"Finish",inputSchema:{type:"object",properties:{response:{type:"string"}},additionalProperties:false}}]});
    expect(p.body).not.toHaveProperty("messages");expect(p.body).not.toHaveProperty("instructions");expect(p.body).not.toHaveProperty("max_output_tokens");
    expect((p.body.tools as any[])[0]).toMatchObject({type:"function",name:"final_result",strict:true});
    expect(p.body.tool_choice).toBe("auto");expect(p.body.parallel_tool_calls).toBe(true);
    expect(p.catalog.entries[0].codec.decode({response:null})).toEqual({});
  });
  it("uses Ollama Chat for structured auxiliaries, with no Generate prompt",()=>{
    const p=prepareOllamaChat({model:"fixture",messages:[{role:"user",content:"return object"}],purpose,stream:false,format:{type:"object"},think:false});
    expect(p.body).toEqual({model:"fixture",messages:[{role:"user",content:"return object"}],stream:false,think:false,format:{type:"object"}});
  });
  it("requires owner-authored DeepSeek JSON context and never adds hidden instructions",()=>{
    expect(()=>prepareDeepSeekChat({model:"fixture",messages:[{role:"user",content:"task"}],purpose,stream:false,jsonSchema:{type:"object"}})).toThrow("deepseek_json_instruction_required");
    const p=prepareDeepSeekChat({model:"fixture",messages:[{role:"user",content:"JSON object"}],purpose,stream:true,jsonSchema:{type:"object"}});
    expect(p.body).toMatchObject({response_format:{type:"json_object"},stream_options:{include_usage:true}});expect(p.body).not.toHaveProperty("max_tokens");
  });
  it("uses an object envelope for a DeepSeek non-object result without changing its value",()=>{
    const messages=[{role:"user",content:"Return a JSON object with result containing the requested array."}];
    const p=prepareDeepSeekChat({model:"fixture",messages,purpose,stream:false,jsonSchema:{type:"array",items:{type:"string"}}});
    expect(p.format!.wrapped).toBe(true);expect(p.format!.decode({result:["a"]})).toEqual(["a"]);
    expect(p.body.messages).toEqual(messages);expect(()=>p.format!.decode(["a"])).toThrow("native_arguments_invalid");
  });
  it("keeps raw reasoning, phase, item order and exact call_id for replay",()=>{
    expect(responsesReplayItems(response)).toEqual(response.output);
    expect(responsesFunctionResult(response,"call_1","done")).toEqual({type:"function_call_output",call_id:"call_1",output:"done"});
    expect(()=>responsesFunctionResult(response,"fc_1","done")).toThrow();
  });
  it("does not silently turn unknown or server-side output into local work",()=>{
    expect(()=>responsesReplayItems({...response,output:[...response.output,{id:"web1",type:"web_search_call",status:"completed"}]})).toThrow("responses_item_unsupported");
    expect(response.output[0].encrypted_content).toBe("opaque");
  });
  it("separates legal replay omissions from unchanged raw custody",()=>{
    const raw={...response,output:[{...response.output[1],created_by:"remote-owner",content:[{type:"output_text",text:"reply",parsed:{extra:true}}]},
      {...response.output[2],parsed_arguments:{path:"x"}}]};
    const replay=mapResponsesReplay(raw);
    expect(replay.removed.map(r=>r.pointer)).toEqual(["/output/0/created_by","/output/0/content/0/parsed","/output/1/parsed_arguments"]);
    expect(raw.output[0]).toHaveProperty("created_by");expect(replay.items[0]).toHaveProperty("phase","commentary");
    expect(replay.items[1]).toHaveProperty("arguments",'{"path":"x"}');
  });
  it("rejects duplicate call identities and incomplete responses even with valid arguments",()=>{
    expect(()=>responsesReplayItems({...response,status:"incomplete"})).toThrow("responses_not_completed");
    expect(()=>responsesReplayItems({...response,output:[response.output[2],{...response.output[2],id:"fc2"}]})).toThrow("responses_call_id_duplicate");
  });
  it("requires one auxiliary message and keeps refusal distinct",()=>{
    const format=compileNativeSchema({protocol:OPENAI_RESPONSES,purpose,canonical:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false},mode:"responses-strict",root:"body"});
    const message={id:"m",type:"message",role:"assistant",content:[{type:"output_text",text:'{"ok":'},{type:"output_text",text:'true}'}]};
    expect(readResponsesStructured({...response,output:[message]},format)).toEqual({ok:true});
    expect(()=>readResponsesStructured({...response,output:[message,{...message,id:"m2"}]},format)).toThrow("responses_auxiliary_body_ambiguous");
    expect(()=>readResponsesStructured({...response,output:[{...message,content:[{type:"refusal",refusal:"no"}]}]},format)).toThrow("responses_auxiliary_refused");
  });
});
describe("native streaming",()=>{
  it("does not accept arguments.done as a completed response",()=>{
    const o={...observation(null),frames:[{event:"response.function_call_arguments.done",data:JSON.stringify({type:"response.function_call_arguments.done",arguments:"{}",sequence_number:0})}]};
    expect(()=>readResponsesObservation(o)).toThrow("responses_stream_incomplete");
    expect(readResponsesObservation({...o,frames:[...o.frames,{event:"response.completed",data:JSON.stringify({type:"response.completed",sequence_number:1,response})}]})).toEqual(response);
  });
  it("accumulates DeepSeek delta arguments and retains the final usage-only chunk",()=>{
    const chunk=(choices:unknown[],usage:unknown=null)=>({event:"message",data:JSON.stringify({id:"chat1",object:"chat.completion.chunk",choices,usage})});
    const result=readDeepSeekObservation({...observation(null),frames:[
      chunk([{index:0,delta:{role:"assistant",reasoning_content:"think",tool_calls:[{index:0,id:"c1",type:"function",function:{name:"Write",arguments:'{"x":'}}]},finish_reason:null}]),
      chunk([{index:0,delta:{tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:"tool_calls"}]),
      chunk([],{prompt_tokens:10,completion_tokens:5}),{event:"message",data:"[DONE]"}]});
    expect(result.usage).toEqual({prompt_tokens:10,completion_tokens:5});
    expect((result.choices as any[])[0].message).toMatchObject({reasoning_content:"think",tool_calls:[{id:"c1",function:{name:"Write",arguments:'{"x":1}'}}]});
    expect(deepSeekToolResult(result,"c1","ok")).toEqual({role:"tool",tool_call_id:"c1",content:"ok"});
  });
  it("preserves Ollama thinking and its ordinal-correlated tool result",()=>{
    const frames=[{model:"m",message:{role:"assistant",content:"a",thinking:"t",tool_calls:[{function:{name:"Write",arguments:{x:1}}}]},done:false},
      {model:"m",message:{role:"assistant",content:"b"},done:true,done_reason:"stop",eval_count:8}].map(v=>({event:"message",data:JSON.stringify(v)}));
    const result=readOllamaChatObservation({...observation(null),frames});
    expect(result.message).toMatchObject({content:"ab",thinking:"t"});expect(result.eval_count).toBe(8);
    expect(ollamaToolResult(result,0,"ok")).toEqual({role:"tool",tool_name:"Write",content:"ok"});
  });
  it("frames split SSE bytes and retains exact wire bytes before observations",async()=>{
    const bytes=Buffer.from('event: response.completed\r\ndata: '+JSON.stringify({type:"response.completed",response})+'\r\n\r\n');
    const retained:Buffer[]=[],observe=vi.fn();
    const fetch=vi.fn(async()=>new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close();}}),{status:200}));
    const result=await dispatchNativeHttp({url:"http://localhost/responses",body:"{}",headers:{},framing:"sse"},{signal:new AbortController().signal,fetch:fetch as typeof globalThis.fetch,
      retainChunk:async b=>{retained.push(Buffer.from(b));},observeFrame:observe});
    expect(Buffer.concat(retained)).toEqual(bytes);expect(result.body).toBe(bytes.toString());expect(observe).toHaveBeenCalledTimes(1);
    expect(readResponsesObservation(result)).toEqual(response);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts stalled reads without retrying or accepting partial output",async()=>{
    const abort=new AbortController(),cancel=vi.fn(),fetch=vi.fn(async()=>new Response(new ReadableStream({cancel})));
    const pending=dispatchNativeHttp({url:"http://localhost/responses",body:"{}",headers:{},framing:"sse"},{signal:abort.signal,fetch:fetch as typeof globalThis.fetch,retainChunk:async()=>{}});
    await Promise.resolve();abort.abort(new Error("cancelled"));await expect(pending).rejects.toThrow("cancelled");expect(fetch).toHaveBeenCalledTimes(1);
  });
});
