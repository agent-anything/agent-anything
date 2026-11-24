import { createParser } from "eventsource-parser";
import { Agent } from "undici";
import { NativeProtocolError } from "../NativeJson.js";

export interface NativeStreamLimits {
  readonly connectMs: number;
  readonly silenceMs: number;
  readonly maximumBytes: number;
  readonly maximumFrameBytes: number;
}
export type NativeTransportPart =
  | {readonly kind:"headers"; readonly status:number; readonly requestId:string|null; readonly retryAfter:string|null; readonly contentType:string|null;readonly elapsedMs:number}
  | {readonly kind:"bytes"; readonly offset:number; readonly bytesBase64:string; readonly frames:readonly {readonly event:string;readonly data:string}[];
      readonly elapsedMs:number; readonly decodeMs:number;readonly decodeError?:string}
  | {readonly kind:"end"; readonly bytes:number;readonly elapsedMs:number;readonly frames:readonly {readonly event:string;readonly data:string}[];readonly decodeError?:string};

// Socket creation (DNS/TCP/TLS) has a deadline even when the operation may
// legitimately wait much longer for headers. Pool reuse does not reconnect.
const pools=new Map<number,Agent>();
function transportPool(connectMs:number){
  let pool=pools.get(connectMs);
  if(!pool){
    pool=new Agent({connect:{timeout:connectMs},headersTimeout:0,bodyTimeout:0});
    if(pools.size>=16){const [key,old]=pools.entries().next().value!;pools.delete(key);void old.close().catch(()=>{});}
    pools.set(connectMs,pool);
  }
  return pool;
}

/** Pull-based raw custody: the consumer commits each part before the next read. No retries. */
export async function* streamNativeHttp(input: {
  readonly url:string;readonly method:"POST"|"GET";readonly headers:Readonly<Record<string,string>>;
  readonly body?:string;readonly framing:"json"|"sse"|"ndjson";readonly signal:AbortSignal;
  readonly limits:NativeStreamLimits;readonly fetch?:typeof globalThis.fetch;
}):AsyncGenerator<NativeTransportPart> {
  for(const value of Object.values(input.limits))if(!Number.isSafeInteger(value)||value<1)throw new NativeProtocolError("native_stream_limits_invalid");
  input.signal.throwIfAborted();
  const controller=new AbortController(),signal=AbortSignal.any([input.signal,controller.signal]);
  let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const arm=(ms:number,code:string)=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new NativeProtocolError(code)),ms);timer.unref();};
  const start=performance.now();
  try {
    const init:RequestInit & {dispatcher:Agent}={method:input.method,headers:input.headers,
      ...(input.body===undefined?{}:{body:input.body}),signal,redirect:"manual",dispatcher:transportPool(input.limits.connectMs)};
    let response:Response;
    try{response=await (input.fetch??globalThis.fetch)(input.url,init);}
    catch(error){
      if(signal.aborted){
        if(signal.reason instanceof NativeProtocolError&&signal.reason.code==="responses_operation_deadline")
          throw new NativeProtocolError("native_response_headers_deadline");
        if(signal.reason instanceof NativeProtocolError)throw signal.reason;
        throw new NativeProtocolError("native_request_aborted");
      }
      const code=(error as {cause?:{code?:string}})?.cause?.code;
      if(code==="UND_ERR_CONNECT_TIMEOUT")throw new NativeProtocolError("native_connect_timeout");
      if(code==="UND_ERR_HEADERS_TIMEOUT")throw new NativeProtocolError("native_response_headers_deadline");
      throw error;
    }
    clearTimeout(timer);signal.throwIfAborted();
    yield {kind:"headers",status:response.status,requestId:response.headers.get("x-request-id"),retryAfter:response.headers.get("retry-after"),contentType:response.headers.get("content-type"),elapsedMs:performance.now()-start};
    if(!response.body)throw new NativeProtocolError("native_http_body_missing");
    reader=response.body.getReader();
    const decoder=new TextDecoder("utf-8",{fatal:true});
    let frames:{event:string;data:string}[]=[],pending="",bytes=0;
    const framing=response.ok?input.framing:"json";
    const frame=(event:string,data:string)=>{
      if(Buffer.byteLength(data)>input.limits.maximumFrameBytes)throw new NativeProtocolError("native_frame_limit");
      frames.push({event,data});
    };
    const parser=createParser({maxBufferSize:input.limits.maximumFrameBytes,onEvent:value=>frame(value.event??"message",value.data),
      onError:()=>{throw new NativeProtocolError("native_sse_invalid");}});
    const feed=(text:string,final=false)=>{
      if(framing==="sse"){parser.feed(text);if(final)parser.reset({consume:true});}
      else if(framing==="ndjson"){
        pending+=text;let end:number;
        while((end=pending.indexOf("\n"))>=0){const line=pending.slice(0,end).replace(/\r$/,"");pending=pending.slice(end+1);if(line.trim())frame("message",line);}
        if(Buffer.byteLength(pending)>input.limits.maximumFrameBytes)throw new NativeProtocolError("native_frame_limit");
        if(final&&pending.trim()){frame("message",pending);pending="";}
      }
    };
    for(;;){
      arm(input.limits.silenceMs,"native_stream_silence");
      const value=await abortableRead(reader,signal);clearTimeout(timer);signal.throwIfAborted();
      if(value.done)break;
      // Bound each custody unit even when the transport supplies a large network chunk.
      for(let offset=0;offset<value.value.length;offset+=65536){
        const chunk=Buffer.from(value.value.subarray(offset,offset+65536));
        if(bytes+chunk.length>input.limits.maximumBytes)throw new NativeProtocolError("native_stream_body_limit",{retainedBytes:bytes});
        const before=performance.now();frames=[];let decodeError:string|undefined;
        try{feed(decoder.decode(chunk,{stream:true}));}catch(error){decodeError=error instanceof NativeProtocolError?error.code:"native_decode_invalid";}
        const part:NativeTransportPart={kind:"bytes",offset:bytes,bytesBase64:chunk.toString("base64"),frames,elapsedMs:performance.now()-start,decodeMs:performance.now()-before,...(decodeError?{decodeError}:{})};
        bytes+=chunk.length;yield part;signal.throwIfAborted();
        if(decodeError)throw new NativeProtocolError(decodeError);
      }
    }
    frames=[];let decodeError:string|undefined;
    try{feed(decoder.decode(),true);}catch(error){decodeError=error instanceof NativeProtocolError?error.code:"native_decode_invalid";}
    yield {kind:"end",bytes,elapsedMs:performance.now()-start,frames,...(decodeError?{decodeError}:{})};
    if(decodeError)throw new NativeProtocolError(decodeError);
  } finally {
    clearTimeout(timer);controller.abort();
    if(reader){try{await reader.cancel();}catch{/* Transport already closed. */}finally{reader.releaseLock();}}
  }
}

async function abortableRead(reader:ReadableStreamDefaultReader<Uint8Array>,signal:AbortSignal){
  signal.throwIfAborted();
  let abort:()=>void=()=>{};
  try{return await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});
  })]);}finally{signal.removeEventListener("abort",abort);}
}
