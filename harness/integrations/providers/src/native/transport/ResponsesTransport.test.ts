import {describe,it,expect,vi} from "vitest";
import {createServer} from "node:http";
import {WebSocketServer} from "ws";
import {prepareResponses} from "../OpenAIResponses.js";
import {ResponsesSession,type ResponsesSessionBinding,type ResponsesSessionStore,type ResponsesSessionState,type ResponsesSessionSegment} from "./ResponsesSession.js";
import {ResponsesObservation} from "./ResponsesObservation.js";
import {ResponsesWebSocket} from "./ResponsesWebSocket.js";
import {DEFAULT_RESPONSES_OBSERVATION_POLICY as policy,responsesReadFailure,responsesPollDue} from "./ResponsesOperationPolicy.js";
import {streamNativeHttp} from "./NativeHttpStream.js";

const body=(status="completed",id="response-original")=>({id,object:"response",status,output:[]});
const event=(type:string,sequence_number:number,extra:object={})=>JSON.stringify({type,sequence_number,...extra});
const sse=(...events:string[])=>new Response(events.map(data=>`data: ${data}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
function binding(options:Partial<ResponsesSessionBinding["profile"]>={}):ResponsesSessionBinding{
  const profile={transport:"http" as const,background:false,stream:true,store:true,temporaryRetention:false,continuity:"persistent_chain" as const,connectionIncarnation:null,...options};
  const prepared=prepareResponses({model:"fixture",input:[{role:"user",content:"original"}],purpose:{id:"task",revision:"1"},stream:profile.stream,store:profile.store,
    transport:profile.transport,...(profile.transport==="http"?{background:profile.background}:{})});
  return {id:"session",scopeId:"scope",target:"original-target",prepared,profile,policy,createdAt:1000,deadlineAt:1_000_000,maximumBytes:10_000_000,maximumFrameBytes:1_000_000,maximumEvents:10000};
}
function memory(){
  let state:ResponsesSessionState|null=null;const segments:ResponsesSessionSegment[]=[];
  const store:ResponsesSessionStore={load:async()=>state,commit:async(expected,next,segment)=>{
    expect(state?.revision??null).toBe(expected);if(segment)segments.push(structuredClone(segment));state=structuredClone(next);
  },async *segments(count){yield* segments.slice(0,count);}};
  return {store,segments,state:()=>state!};
}
function environment(fetcher:typeof fetch){let now=1000;return {env:{now:()=>now,jitter:()=>0.5,target:"original-target",baseUrl:"https://fixture.invalid/v1",headers:{},
  signal:new AbortController().signal,fetch:fetcher,authorize:async()=>{}},at:(value:number)=>{now=value;}};}

describe("Responses native transport ownership",()=>{
  it("assembles fragmented UTF-8 and SSE with pull backpressure",async()=>{
    const bytes=Buffer.from(`data: ${event("response.created",0,{response:body("in_progress")})}\n\ndata: ${event("response.completed",1,{response:{...body(),label:"中文"}})}\n\n`);
    let cursor=0,pulls=0;
    const stream=new ReadableStream<Uint8Array>({pull(controller){pulls++;if(cursor===bytes.length)controller.close();else controller.enqueue(bytes.subarray(cursor,cursor+=1));}}, {highWaterMark:0});
    const fetcher=vi.fn(async()=>new Response(stream));const parts=[];
    for await(const part of streamNativeHttp({url:"http://fixture.invalid",method:"POST",headers:{},framing:"sse",signal:new AbortController().signal,
      limits:{connectMs:1000,silenceMs:1000,maximumBytes:10000,maximumFrameBytes:10000},fetch:fetcher})){parts.push(part);if(part.kind==="headers")expect(pulls).toBe(0);}
    const raw=Buffer.concat(parts.flatMap(p=>p.kind==="bytes"?[Buffer.from(p.bytesBase64,"base64")]:[]));
    expect(raw.equals(bytes)).toBe(true);expect(parts.flatMap(p=>p.kind==="headers"?[]:p.frames)).toHaveLength(2);
  });
  it("times out silent custom streams and closes their reader",async()=>{
    const cancel=vi.fn(),stream=new ReadableStream<Uint8Array>({cancel});
    await expect((async()=>{for await(const _ of streamNativeHttp({url:"http://fixture.invalid",method:"GET",headers:{},framing:"sse",
      signal:new AbortController().signal,limits:{connectMs:100,silenceMs:20,maximumBytes:1000,maximumFrameBytes:1000},fetch:async()=>new Response(stream)})){} })()).rejects.toThrow("native_stream_silence");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("retains a failed UTF-8 flush and cannot reinterpret it as a clean ending on recovery",async()=>{
    const m=memory(),b=binding(),data=Buffer.concat([Buffer.from(`data: ${event("response.created",0,{response:body("in_progress")})}\n\n`),Buffer.from([0xe4])]);
    const session=await ResponsesSession.open(b,m.store);
    await session.step(environment(async()=>new Response(data)).env);
    expect(session.snapshot().reason).toBe("native_decode_invalid");
    expect(m.segments.some(s=>s.kind==="http"&&s.part.kind==="end"&&s.part.decodeError==="native_decode_invalid")).toBe(true);
    expect((await ResponsesSession.open(b,m.store)).snapshot()).toEqual(session.snapshot());
  });
  it("separates keepalive counters, duplicates and conflicting event identities",()=>{
    const fold=new ResponsesObservation();const created=event("response.created",5,{response:body("in_progress")});
    fold.event(created);fold.event(event("keepalive",999));fold.event(created);
    expect(fold.head()).toMatchObject({cursor:5,events:1,duplicates:1,keepalives:1});
    expect(()=>fold.event(event("response.created",5,{response:body("queued")}))).toThrow("responses_event_conflict");
  });
  it("rejects a complete body contradicting an already closed part",()=>{
    const fold=new ResponsesObservation();fold.event(event("response.created",0,{response:body("in_progress")}));
    fold.event(event("response.function_call_arguments.delta",1,{item_id:"call",delta:'{"x":1}'}));
    fold.event(event("response.function_call_arguments.done",2,{item_id:"call",arguments:'{"x":1}'}));
    expect(()=>fold.response({...body(),output:[{id:"call",type:"function_call",arguments:'{"x":2}'}]})).toThrow("responses_closed_part_conflict");
  });
  it.each(["reasoning","compaction"])("preserves distinct %s ciphertext observations and restores the completed-item continuation source",async type=>{
    const item={id:"opaque-item",type,summary:[],encrypted_content:"done-ciphertext"};
    const terminal={...body(),output:[{...item,encrypted_content:"terminal-ciphertext"}]};
    const m=memory(),b=binding();let session=await ResponsesSession.open(b,m.store);
    await session.step(environment(async()=>sse(event("response.created",0,{response:body("in_progress")}),
      event("response.output_item.added",1,{item:{...item,encrypted_content:"partial"},output_index:0}),
      event("response.output_item.done",2,{item,output_index:0}),event("response.completed",3,{response:terminal}))).env);
    expect(session.snapshot().disposition).toBe("terminal");expect(session.response()).toEqual(terminal);
    expect(session.continuationItems()).toEqual([{item,source:{kind:"output_item_done",sequence:2}}]);
    session=await ResponsesSession.open(b,m.store);
    expect(session.response()).toEqual(terminal);expect(session.continuationItems()).toEqual([{item,source:{kind:"output_item_done",sequence:2}}]);
    const retrieved=new ResponsesObservation();retrieved.response(terminal);
    expect(retrieved.continuationItems()).toEqual([{item:terminal.output[0],source:{kind:"terminal_response"}}]);
  });
  it("does not excuse visible conflicts, malformed opaque fields or conflicting duplicate events",()=>{
    const item={id:"r",type:"reasoning",summary:[],encrypted_content:"opaque-a"};
    const make=()=>{const f=new ResponsesObservation();f.event(event("response.output_item.done",0,{item}));return f;};
    expect(()=>make().response({...body(),output:[{...item,summary:[{type:"summary_text",text:"changed"}]}]})).toThrow("responses_closed_item_conflict");
    expect(()=>make().response({...body(),output:[{...item,encrypted_content:5}]})).toThrow();
    expect(()=>make().event(event("response.output_item.done",0,{item:{...item,encrypted_content:"different"}}))).toThrow("responses_event_conflict");
    const unknown={id:"u",type:"unknown",encrypted_content:"one"},f=new ResponsesObservation();
    f.event(event("response.output_item.done",0,{item:unknown}));
    expect(()=>f.response({...body(),output:[{...unknown,encrypted_content:"two"}]})).toThrow("responses_closed_item_conflict");
  });
  it("keeps polling healthy queued work without spending retry allowances",async()=>{
    const m=memory(),b=binding({background:true,stream:false,temporaryRetention:true}),requests:string[]=[];
    const e=environment(async(url)=>{requests.push(String(url));return Response.json(body(requests.length===4?"completed":"queued"));});
    let session=await ResponsesSession.open(b,m.store);
    for(let i=0;i<4;i++){await session.step(e.env);if(session.snapshot().dueAt)e.at(session.snapshot().dueAt!);session=await ResponsesSession.open(b,m.store);}
    expect(session.snapshot()).toMatchObject({disposition:"terminal",readEpisode:null,creation:"observed"});
    expect(m.segments.filter(s=>s.kind==="dispatch"&&s.operation==="create")).toHaveLength(1);
    expect(requests.slice(1).every(url=>url.endsWith("/responses/response-original"))).toBe(true);
    const observed=m.segments.filter(s=>s.kind==="http");expect(observed.every(s=>s.work&&s.work.interpretMs>=0)).toBe(true);
    expect(observed.some(s=>s.kind==="http"&&s.part.kind==="headers"&&s.part.elapsedMs>=0)).toBe(true);
  });
  it("reopens the durable response cursor, never an unknown generation",async()=>{
    const m=memory(),b=binding({background:true,temporaryRetention:true}),requests:string[]=[];
    let n=0;const e=environment(async(url)=>{requests.push(String(url));return ++n===1?sse(event("response.created",7,{response:body("in_progress")}),event("keepalive",1000)):
      sse(event("response.completed",8,{response:body()}));});
    let session=await ResponsesSession.open(b,m.store);await session.step(e.env);e.at(session.snapshot().dueAt!);
    session=await ResponsesSession.open(b,m.store);await session.step(e.env);
    expect(requests[1]).toContain("starting_after=7");expect(session.snapshot().disposition).toBe("terminal");
    const unknown=memory(),f=vi.fn(async()=>{throw new Error("connection lost after send");}),env=environment(f);
    let lost=await ResponsesSession.open(binding(),unknown.store);await lost.step(env.env);lost=await ResponsesSession.open(binding(),unknown.store);await lost.step(env.env);
    expect(f).toHaveBeenCalledOnce();expect(lost.snapshot()).toMatchObject({disposition:"unresolved",creation:"possibly_sent"});
  });
  it("does not hide invalid events or advance past uncommitted segments",async()=>{
    const m=memory(),b=binding(),e=environment(async()=>sse(event("response.created",0,{response:body("in_progress")}),event("response.created",0,{response:body("queued")})));
    let session=await ResponsesSession.open(b,m.store);await session.step(e.env);
    expect(m.segments.some(s=>"interpretationError" in s&&s.interpretationError==="responses_event_conflict")).toBe(true);
    session=await ResponsesSession.open(b,m.store);expect(session.snapshot().reason).toBe("responses_event_conflict");
    const failed=memory();let reject=true;const store={...failed.store,commit:async(expected:number|null,next:ResponsesSessionState,segment:ResponsesSessionSegment|null)=>{
      if(reject&&segment?.kind==="http"&&segment.part.kind==="bytes")throw new Error("disk failed");await failed.store.commit(expected,next,segment);
    }};
    const pending=await ResponsesSession.open(b,store);await expect(pending.step(environment(async()=>sse(event("response.created",0,{response:body("in_progress")}))).env)).rejects.toThrow("disk failed");
    await expect(pending.step(e.env)).rejects.toThrow("responses_session_reload_required");reject=false;
    await expect(pending.shutdown("preserve","shutdown")).rejects.toThrow("responses_session_reload_required");
    await expect(pending.followUp("receipt",2000)).rejects.toThrow("responses_session_reload_required");
    expect(()=>pending.response()).toThrow("responses_session_reload_required");
    expect(()=>pending.continuationItems()).toThrow("responses_session_reload_required");
    const recovered=await ResponsesSession.open(b,store);expect(recovered.snapshot().head.responseId).toBe(null);
    await recovered.step(e.env);expect(recovered.snapshot().reason).toBe("original_response_unavailable");
  });
  it("uses a separate cancellation allowance after observation exhaustion",async()=>{
    const m=memory(),b=binding({background:true,stream:false,temporaryRetention:true});let count=0;
    const e=environment(async(url)=>{if(String(url).endsWith("/cancel"))return Response.json(body("cancelled"));return ++count===1?Response.json(body("queued")):new Response("unavailable",{status:503});});
    let session=await ResponsesSession.open(b,m.store);await session.step(e.env);
    for(let i=0;i<4;i++){e.at(session.snapshot().dueAt!);session=await ResponsesSession.open(b,m.store);await session.step(e.env);}
    expect(session.snapshot().readEpisode?.exhausted).toBe(true);await session.cancel("accepted-cancel");await session.step(e.env);
    expect(session.snapshot()).toMatchObject({disposition:"terminal",cancelAcknowledged:true});
    expect(m.segments.filter(s=>s.kind==="dispatch"&&s.operation==="cancel")).toHaveLength(1);
  });
  it("retains original episode deadlines and respects Retry-After",()=>{
    const failed=responsesReadFailure({previous:null,policy,now:200_000,startedAt:1000,lifetime:1_000_000,retryAfter:null,reason:"restart",retryable:true,jitter:0.5});
    expect(failed).toMatchObject({startedAt:1000,deadlineAt:121000,exhausted:true});
    const delayed=responsesReadFailure({previous:null,policy,now:1000,lifetime:1_000_000,retryAfter:"3600",reason:"rate",retryable:true,jitter:0.5});
    expect(delayed.exhausted).toBe(true);expect(delayed.dueAt).toBeGreaterThan(3_600_000);
    expect(responsesPollDue(policy,99,1000,1)).toBe(11000);
  });
  it("falls back to retrieval of the same response without resetting the failed resume episode",async()=>{
    const m=memory(),b=binding({background:true,temporaryRetention:true});const urls:string[]=[];
    const e=environment(async url=>{urls.push(String(url));return urls.length===1?sse(event("response.created",0,{response:body("queued")})):
      urls.length===2?new Response("resume unavailable",{status:404}):Response.json(body());});
    let session=await ResponsesSession.open(b,m.store);await session.step(e.env);e.at(session.snapshot().dueAt!);await session.step(e.env);
    expect(session.snapshot()).toMatchObject({observation:"poll",readEpisode:{failures:1},head:{capture:"gap"}});
    session=await ResponsesSession.open(b,m.store);e.at(session.snapshot().dueAt!);await session.step(e.env);
    expect(urls[2]).toBe("https://fixture.invalid/v1/responses/response-original");expect(session.snapshot().disposition).toBe("terminal");
  });
  it("preserves background work on shutdown and fences cancellation before an unsent request",async()=>{
    const b=binding({background:true,stream:false,temporaryRetention:true}),m=memory(),fetcher=vi.fn(async()=>Response.json(body("queued"))),e=environment(fetcher);
    let session=await ResponsesSession.open(b,m.store);await session.step(e.env);await session.shutdown("preserve","shutdown");
    session=await ResponsesSession.open(b,m.store);expect(session.snapshot().shutdown).toBe("preserve");expect(session.snapshot().cancellation).toBeNull();
    e.at(session.snapshot().dueAt!);await session.step(e.env);expect(fetcher).toHaveBeenCalledTimes(2);
    const unsent=await ResponsesSession.open(binding(),memory().store);await unsent.cancel("accepted-control");await unsent.step(e.env);
    expect(unsent.snapshot().disposition).toBe("unsent");expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("expires transferred responsibility without creating an immortal poller",async()=>{
    const m=memory(),b=binding({background:true,stream:false,temporaryRetention:true}),fetcher=vi.fn(async()=>Response.json(body("queued"))),e=environment(fetcher);
    const session=await ResponsesSession.open(b,m.store);await session.step(e.env);await session.cancel("cancel");await session.followUp("accepted-handoff",2000);
    e.at(2000);await session.step(e.env);expect(session.snapshot()).toMatchObject({disposition:"unresolved",reason:"authorized_lifetime_exhausted",pending:null});
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401,403,404])("does not turn rejected retrieval %i into a replacement generation",async status=>{
    const m=memory(),b=binding({background:true,stream:false,temporaryRetention:true}),requests:string[]=[];
    const e=environment(async url=>{requests.push(String(url));return requests.length===1?Response.json(body("queued")):new Response("unavailable",{status});});
    const session=await ResponsesSession.open(b,m.store);await session.step(e.env);e.at(session.snapshot().dueAt!);await session.step(e.env);await session.step(e.env);
    expect(session.snapshot().disposition).toBe("unresolved");expect(requests).toHaveLength(2);
  });
  it("retains a buffered foreground response without a fabricated stream gap",async()=>{
    const m=memory(),b=binding({stream:false}),e=environment(async()=>Response.json(body()));
    const session=await ResponsesSession.open(b,m.store);await session.step(e.env);
    expect(session.snapshot()).toMatchObject({disposition:"terminal",head:{capture:"not_applicable"}});
    expect((await ResponsesSession.open(b,m.store)).response()).toEqual(body());
  });
  it("uses exclusive real WebSocket carriers without HTTP fields or replaying creation",async()=>{
    const server=createServer(),wss=new WebSocketServer({server});const requests:unknown[]=[];
    wss.on("connection",socket=>socket.on("message",data=>{requests.push(JSON.parse(data.toString()));socket.send(event("response.created",0,{response:body("in_progress")}));socket.send(event("response.completed",1,{response:body()}));}));
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address() as {port:number};
    const socket=new ResponsesWebSocket("scope","incarnation",{baseUrl:`http://127.0.0.1:${address.port}/v1`,headers:{}},{connectMs:1000,maximumFrameBytes:10000,maximumBufferedBytes:20000});
    try{
      const m=memory(),session=await ResponsesSession.open(binding({transport:"websocket",connectionIncarnation:"incarnation",store:false,continuity:"connection_memory"}),m.store);
      await session.step({...environment(vi.fn()).env,socket});expect(session.snapshot().disposition).toBe("terminal");
      expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({type:"response.create",store:false});
      expect(requests[0]).not.toHaveProperty("stream");expect(requests[0]).not.toHaveProperty("background");
      expect(m.segments.filter(s=>s.kind==="websocket").every(s=>s.work?.socket&&s.work.socket.queueMs>=0)).toBe(true);
      await expect((async()=>{for await(const _ of socket.create({scopeId:"child",incarnation:"incarnation",encoded:"{}",signal:new AbortController().signal,silenceMs:100,maximumBytes:1000})){} })()).rejects.toThrow("responses_connection_scope_changed");
    }finally{await socket.close();for(const client of wss.clients)client.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
