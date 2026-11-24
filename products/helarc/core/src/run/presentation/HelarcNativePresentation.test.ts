import {describe,it,expect} from "vitest";
import {createHelarcRunPresentation,appendHelarcRunPresentation,appendHelarcPresentationGap} from "./HelarcRunPresentation.js";
import {helarcNativePresentationId,helarcNativeResponseGroupId} from "./HelarcNativePresentation.js";
import {HelarcResponsePreviewStore} from "./HelarcResponsePreviews.js";
import {nativeReadableReasoning} from "./HelarcNativeReasoning.js";
import {OPENAI_RESPONSES,type NativeModelSourceRef} from "@agent-anything/model-interaction/protocol";
import type {RunTranscriptRecord} from "@agent-anything/agent-runtime/transcript";
import type {HelarcNativeTaskProposal,HelarcNativeTaskBinding} from "../../controller/native/HelarcNativeTask.js";
const source=(index:number,runId="root"):NativeModelSourceRef=>({scope:{runId,activityId:`${runId}:activity`,recipientId:runId,
  purpose:{id:"helarc.controller",revision:"1"},compositionDigest:`sha256:${"1".repeat(64)}`},protocol:OPENAI_RESPONSES,
  interpretation:{id:"openai.responses.adapter",revision:"1"},operationId:"op",record:{id:"response-record",revision:"1"},
  position:{format:"json-pointer",value:`/output/${index}/content/0`},nativeIdentity:{kind:"message",id:`message-${index}`}});
const proposal=():HelarcNativeTaskProposal=>({kind:"continue_with_feedback",evidence:{scope:source(0).scope,interpreter:{id:"helarc.native-task",revision:"1"},
  acceptance:{id:"accepted",revision:"1"},sources:[source(0),source(1)]},text:[{source:source(0),text:"Same text"},{source:source(1),text:"Same text"}],
  refusals:[],calls:[],rejections:[],ending:null,feedback:{code:"signal",message:"End explicitly"}});
const record=(p:HelarcNativeTaskProposal)=>({runId:"root",sequence:1,item:{ref:{id:"item"},committedInRevision:1,createdAt:"2026-11-16T00:00:00Z",
  payload:{kind:"controller_turn",modelItems:[{kind:"native_purpose_evidence",id:"evidence",evidence:p.evidence}]}}}) as unknown as RunTranscriptRecord;
describe("Native Product reading sources",()=>{
  it("keeps returned reasoning separate and reconciles its exact native position",()=>{
    const s=source(0),root={...s,position:{format:"json-pointer" as const,value:""}},p=proposal();
    const reasoning=nativeReadableReasoning({output:[{type:"reasoning",id:"r1",encrypted_content:"SECRET",summary:[{type:"summary_text",text:"Visible reasoning summary"}]}]},root);
    expect(reasoning).toHaveLength(1);expect(JSON.stringify(reasoning)).not.toContain("SECRET");
    const read={...p,reasoning},out=appendHelarcRunPresentation(createHelarcRunPresentation(),record(p),read);
    expect(out.records[0]?.content).toMatchObject({kind:"assistant_reasoning",text:"Visible reasoning summary",turnId:null});
    const store=new HelarcResponsePreviewStore(()=>{}),binding={scope:s.scope,protocol:s.protocol,adapter:s.interpretation,operationId:s.operationId,record:s.record,requestId:"q",controllerRequestId:"cq"} as HelarcNativeTaskBinding;
    store.observeNative({binding,sequence:1,value:{type:"response.reasoning_summary_text.delta",output_index:0,summary_index:0,item_id:"r1",delta:"Visible "}});
    store.commitNative(read);
    expect(store.snapshot().attempts[0]?.parts[0]).toMatchObject({kind:"reasoning",text:"Visible reasoning summary",committedRecordId:helarcNativePresentationId(reasoning[0]!.source)});store.close();
    expect(nativeReadableReasoning({choices:[{index:0,message:{reasoning_content:"DeepSeek thought"}}]}, {...root,protocol:{providerId:"deepseek",id:"deepseek.chat-completions",revision:"1"},interpretation:{id:"deepseek.chat-completions.adapter",revision:"1"}})[0]?.text).toBe("DeepSeek thought");
    expect(nativeReadableReasoning({message:{thinking:"Ollama thought"}}, {...root,protocol:{providerId:"ollama",id:"ollama.chat",revision:"1"},interpretation:{id:"ollama.chat.adapter",revision:"1"}})[0]?.text).toBe("Ollama thought");
  });
  it("bounds explicit display gaps without accepting or inventing model progress",()=>{
    let value=createHelarcRunPresentation();const r=record(proposal());
    value=appendHelarcPresentationGap(value,r,"capture_failed");
    value={...value,records:Array.from({length:2100},(_,i)=>({...value.records[0]!,id:`gap-${i}`,sequence:i}))};
    value=appendHelarcPresentationGap(value,{...r,sequence:2101},"capture_failed");
    expect(value.records.length).toBeLessThanOrEqual(2048);expect(value.omittedRecords).toBeGreaterThan(0);
    expect(value.sourceSequences).toEqual({});expect(value.retainedBytes).toBeLessThanOrEqual(4*1024*1024);
  });
  it("previews only the original final control, deduplicates event replay and separates observation from acceptance",()=>{
    const s=source(0),store=new HelarcResponsePreviewStore(()=>{});
    const binding={scope:s.scope,protocol:s.protocol,adapter:s.interpretation,operationId:s.operationId,record:s.record,requestId:"q",controllerRequestId:"cq",
      catalog:[{definition:{name:"finish"},binding:{kind:"control",control:"final_result"}}]} as unknown as HelarcNativeTaskBinding;
    store.observeNative({binding,sequence:1,value:{type:"response.output_item.added",sequence_number:1,output_index:0,item:{type:"function_call",id:"fc",name:"finish",arguments:""}}});
    const value={type:"response.function_call_arguments.delta",sequence_number:2,output_index:0,delta:'{"response":"Visible report'};
    store.observeNative({binding,sequence:2,value});store.observeNative({binding,sequence:3,value});
    expect(store.snapshot().attempts[0]?.parts[0]).toMatchObject({kind:"final_response",text:"Visible report",turnId:null});
    store.observeNative({binding,sequence:4,value:{type:"response.output_item.added",sequence_number:3,output_index:1,item:{type:"function_call",id:"other",name:"Read",arguments:'{"response":"not a reply"}'}}});
    expect(store.snapshot().attempts[0]?.parts).toHaveLength(1);
    store.observeNative({binding,sequence:5,value:{},disposition:"interrupted",code:"connection_lost"});
    expect(store.snapshot().attempts[0]).toMatchObject({state:"interrupted",parts:[{committedRecordId:null}]});store.close();
  });
  it("retains equal text as distinct original parts, with no fabricated Turn",()=>{
    const p=proposal(),r=record(p),out=appendHelarcRunPresentation(createHelarcRunPresentation(),r,p);
    expect(out.records).toHaveLength(2);
    expect(new Set(out.records.map(r=>r.id)).size).toBe(2);
    expect(out.records.every(r=>r.origin?.turnId===null&&r.origin.nativeSource)).toBe(true);
    expect(appendHelarcRunPresentation(out,r,p)).toBe(out);
    expect(helarcNativeResponseGroupId(source(0))).toBe(helarcNativeResponseGroupId(source(1)));
    expect(helarcNativeResponseGroupId(source(0,"child"))).not.toBe(helarcNativeResponseGroupId(source(0)));
  });
  it("replaces provisional text by exact accepted source, not equal text",()=>{
    const p=proposal(),s=source(0),store=new HelarcResponsePreviewStore(()=>{});
    const binding={scope:s.scope,protocol:s.protocol,adapter:s.interpretation,operationId:s.operationId,record:s.record,requestId:"q",controllerRequestId:"cq"} as HelarcNativeTaskBinding;
    store.observeNative({binding,sequence:1,value:{type:"response.output_text.delta",output_index:0,content_index:0,item_id:"message-0",delta:"Same "}});
    store.observeNative({binding,sequence:2,value:{type:"response.output_text.delta",output_index:0,content_index:0,item_id:"message-0",delta:"text"}});
    expect(store.snapshot().attempts[0]?.parts[0]?.text).toBe("Same text");
    store.commitNative(p);
    expect(store.snapshot().attempts[0]).toMatchObject({state:"committed",parts:[{turnId:null,modelItemId:helarcNativePresentationId(s),committedRecordId:helarcNativePresentationId(s)}]});
    store.observeNative({binding,sequence:3,value:{type:"response.output_text.delta",output_index:0,content_index:0,item_id:"message-0",delta:"late"}});
    expect(store.snapshot().attempts[0]?.parts[0]?.text).toBe("Same text");store.close();
  });
});
