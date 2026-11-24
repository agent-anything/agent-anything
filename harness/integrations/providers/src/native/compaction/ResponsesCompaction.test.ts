import {describe,it,expect} from "vitest";
import {prepareResponsesCompact,restoreResponsesCompactedWindow,responsesInternalCompactionReplay,responsesCompactionOccurrences,validateResponsesCompactionOptions} from "./ResponsesCompaction.js";
import {ResponsesCompactSession,type ResponsesCompactState,type ResponsesCompactSegment,type ResponsesCompactStore} from "./ResponsesCompactSession.js";
import {prepareResponses,assertResponsesTaskResponse,mapResponsesReplay} from "../OpenAIResponses.js";
const purpose={id:"compact",revision:"1"};
const raw={id:"compaction-original",object:"response.compaction",output:[{type:"message",role:"user",content:[{type:"input_text",text:"Keep blue."}],extra:"retained"},
  {id:"cmp_1",type:"compaction",encrypted_content:"opaque",created_by:"response-old"},{id:"cmp_2",type:"compaction",encrypted_content:"opaque2"}],usage:{input_tokens:200,output_tokens:80}};
const observation=()=>({status:200,requestId:"request-original",body:JSON.stringify(raw),frames:[],work:{bytes:Buffer.byteLength(JSON.stringify(raw)),chunks:1,elapsedMs:10}});
function memory(){let state:ResponsesCompactState|null=null;const segments:ResponsesCompactSegment[]=[];
  const store:ResponsesCompactStore={load:async()=>structuredClone(state),async *segments(count){for(const segment of segments.slice(0,count))yield structuredClone(segment);},
    commit:async(expected,value,segment)=>{expect(state?.revision??null).toBe(expected);state=structuredClone(value);if(segment)segments.push(structuredClone(segment));}};
  return {store,segments};
}
const binding=()=>({id:"compact",prepared:prepareResponsesCompact({model:"fixture",input:[{role:"user",content:"blue"}],purpose}),
  sourceDigest:"source",target:"original",disclosure:"allowed",startedAt:0,deadlineAt:100,maximumBytes:10000});
describe("Responses native compaction",()=>{
  it("keeps the whole native window and documents only output-only normalization",()=>{
    const result=restoreResponsesCompactedWindow(raw);expect(result.items).toHaveLength(3);expect(result.raw).toEqual(raw);
    expect(result.items[0]).toEqual(raw.output[0]);expect(result.opaqueItems).toHaveLength(2);
    expect(result.removed).toEqual([{pointer:"/output/1/created_by",reason:"output_provenance"}]);
    expect(result.items[1]).not.toHaveProperty("created_by");expect(result.items[1]).toHaveProperty("encrypted_content","opaque");
  });
  it("keeps compact resources distinct from Responses, checks exchange completeness and supported threshold",()=>{
    expect(()=>assertResponsesTaskResponse(raw)).toThrow("envelope_invalid");
    expect(()=>prepareResponsesCompact({model:"m",purpose,input:[{type:"function_call",id:"i",call_id:"c",name:"Read",arguments:"{}"}]})).toThrow("exchange_incomplete");
    expect(()=>validateResponsesCompactionOptions([{type:"compaction",compact_threshold:999}])).toThrow("options_invalid");
    const request=prepareResponses({model:"m",input:[],purpose,store:false,stream:false,context_management:[{type:"compaction",compact_threshold:1000}]});
    expect(request.body.context_management).toEqual([{type:"compaction",compact_threshold:1000}]);
    expect(prepareResponsesCompact({model:"m",purpose,input:[]}).body).not.toHaveProperty("tools");
  });
  it("records internal occurrence without inventing coverage, and prunes only an explicitly chosen replay",()=>{
    const response={id:"r",object:"response",status:"completed",output:[{id:"a",type:"message",role:"assistant",content:[{type:"output_text",text:"progress"}]},
      {id:"cmp",type:"compaction",encrypted_content:"opaque"},{id:"b",type:"message",role:"assistant",content:[{type:"output_text",text:"next"}]}]};
    expect(responsesCompactionOccurrences(response)[0]).toMatchObject({precedingOutput:["a"],internalSourceCoverage:"unknown",outputIndex:1});
    expect(mapResponsesReplay(response).items).toHaveLength(3);
    const replay=responsesInternalCompactionReplay([{role:"user",content:"old"}],response.output);
    expect(replay.omittedItems).toBe(2);expect(replay.items).toEqual(response.output.slice(1));expect(replay.omittedPrefixDigest).not.toBeNull();
  });
  it("restores a complete native candidate without new generation or operation lookup",async()=>{
    const {store}=memory(),b=binding();let calls=0;const s=await ResponsesCompactSession.open(b,store);
    await s.execute({now:1,authorize:async()=>true,dispatch:async retain=>{calls++;const o=observation();await retain(Buffer.from(o.body),0);return o;}});
    const restored=await ResponsesCompactSession.open(b,store);expect(restored.candidate()).toEqual(s.candidate());expect(restored.snapshot().status).toBe("observed");
    await expect(restored.execute({now:2,authorize:async()=>true,dispatch:async()=>{calls++;return observation();}})).rejects.toThrow("not_dispatchable");expect(calls).toBe(1);
    await expect(ResponsesCompactSession.open({...b,target:"changed"},store)).rejects.toThrow("binding_changed");
  });
  it("keeps ambiguous dispatch unknown, forbids implicit retry and retains late observed cost after cancellation",async()=>{
    const {store}=memory(),s=await ResponsesCompactSession.open(binding(),store);let calls=0;
    await expect(s.execute({now:1,authorize:async()=>true,dispatch:async()=>{calls++;throw new Error("disconnect");}})).rejects.toThrow("disconnect");
    await s.cancel("user-stop");await s.retainObservation(observation());expect(s.snapshot()).toMatchObject({status:"observed",cancelled:true});
    expect(s.observed()?.body).toContain("input_tokens");expect(calls).toBe(1);
    const recovered=await ResponsesCompactSession.open(binding(),store);expect(recovered.snapshot()).toEqual(s.snapshot());
  });
  it("poisons volatile progress on failed custody and recovers the original committed operation",async()=>{
    const {store}=memory(),b=binding();let fail=true;
    const wrapper={...store,commit:async(expected:number|null,state:ResponsesCompactState,segment:ResponsesCompactSegment|null)=>{
      if(segment?.kind==="observation"&&fail){fail=false;throw new Error("disk");}await store.commit(expected,state,segment);}};
    const session=await ResponsesCompactSession.open(b,wrapper);
    await expect(session.execute({now:1,authorize:async()=>true,dispatch:async()=>observation()})).rejects.toThrow("disk");
    expect(()=>session.candidate()).toThrow("reload_required");
    const restored=await ResponsesCompactSession.open(b,store);await restored.reconcileInterrupted();expect(restored.snapshot().status).toBe("unknown");
    await restored.retainObservation(observation());expect(restored.candidate()?.resourceId).toBe(raw.id);
  });
  it("does not treat a damaged complete body as the captured bytes",async()=>{
    const {store}=memory(),s=await ResponsesCompactSession.open(binding(),store);
    await expect(s.execute({now:1,authorize:async()=>true,dispatch:async retain=>{await retain(Buffer.from("changed"),0);return observation();}})).rejects.toThrow("bytes_mismatch");
    expect(()=>s.candidate()).toThrow("reload_required");
  });
  it("bounds source/result and dispatch lifetime without assigning false completion",async()=>{
    const {store}=memory(),s=await ResponsesCompactSession.open(binding(),store);
    await expect(s.execute({now:100,authorize:async()=>true,dispatch:async()=>observation()})).rejects.toThrow("not_dispatchable");
    await expect(s.execute({now:1,authorize:async()=>false,dispatch:async()=>observation()})).rejects.toThrow("disclosure_denied");expect(s.snapshot().status).toBe("prepared");
  });
});
