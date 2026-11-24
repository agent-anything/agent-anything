import { createParser } from "eventsource-parser";
import { NativeProtocolError, json, object } from "./NativeJson.js";

export interface NativeHttpRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string,string>>;
  readonly framing: "json" | "sse" | "ndjson";
}
export interface NativeHttpObservation {
  readonly status: number;
  readonly requestId: string | null;
  readonly body: string;
  readonly frames: readonly {readonly event: string; readonly data: string}[];
  readonly work: {readonly bytes: number; readonly chunks: number; readonly elapsedMs: number;readonly startedAt?:string;readonly completedAt?:string};
}
export interface NativeHttpOptions {
  readonly signal: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly maximumBytes?: number;
  /** A custody consumer, not a UI callback; failure prevents acceptance. */
  readonly retainChunk: (bytes: Uint8Array, offset: number) => Promise<void>;
  readonly observeFrame?: (frame: {readonly event: string; readonly data: string}) => void;
}

/** One HTTP operation. It neither retries nor interprets completion, usage or tool execution. */
export async function dispatchNativeHttp(request: NativeHttpRequest, options: NativeHttpOptions): Promise<NativeHttpObservation> {
  const start = performance.now(), startedAt=new Date().toISOString(), chunks: Buffer[] = [], frames: {event:string;data:string}[] = [];
  const maximum = options.maximumBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new NativeProtocolError("native_transport_limit_invalid");
  const response = await (options.fetch ?? globalThis.fetch)(request.url, {method:"POST",headers:request.headers,
    body:request.body,signal:options.signal,redirect:"manual"});
  if (!response.body) throw new NativeProtocolError("native_http_body_missing");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8",{fatal:true});
  const framing = response.ok ? request.framing : "json";
  let bytes = 0, pending = "";
  const frame = (event:string,data:string) => {
    if (Buffer.byteLength(data) > 8 * 1024 * 1024 || frames.length >= 65536) throw new NativeProtocolError("native_frame_limit");
    const value = Object.freeze({event,data}); frames.push(value);
    try { options.observeFrame?.(value); } catch { /* UI observation cannot alter protocol custody. */ }
  };
  const parser = createParser({onEvent:event=>frame(event.event ?? "message",event.data),onError:()=>{throw new NativeProtocolError("native_sse_invalid");},maxBufferSize:8*1024*1024});
  const feed = (text:string, final=false) => {
    if (framing === "sse") { parser.feed(text); if (final) parser.reset({consume:true}); }
    else if (framing === "ndjson") {
      pending += text;
      let newline:number;
      while ((newline=pending.indexOf("\n"))>=0) { const line=pending.slice(0,newline).replace(/\r$/,""); pending=pending.slice(newline+1); if(line.trim())frame("message",line); }
      if (pending.length>8*1024*1024) throw new NativeProtocolError("native_frame_limit");
      if (final && pending.trim()) { frame("message",pending); pending=""; }
    }
  };
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_,reject)=>{abort=()=>reject(options.signal.reason ?? new NativeProtocolError("native_http_cancelled"));});
  void aborted.catch(()=>{}); options.signal.addEventListener("abort",abort,{once:true});
  try {
    options.signal.throwIfAborted();
    for (;;) {
      const result = await Promise.race([reader.read(),aborted]); options.signal.throwIfAborted();
      if(result.done)break;
      if(bytes+result.value.byteLength>maximum)throw new NativeProtocolError("native_http_body_limit",{retainedBytes:bytes});
      const owned=Buffer.from(result.value);
      await options.retainChunk(owned,bytes); options.signal.throwIfAborted();
      bytes+=owned.length; chunks.push(owned); feed(decoder.decode(owned,{stream:true}));
    }
    feed(decoder.decode(),true);
    return Object.freeze({status:response.status,requestId:response.headers.get("x-request-id"),body:Buffer.concat(chunks).toString("utf8"),frames:Object.freeze(frames),
      work:Object.freeze({bytes,chunks:chunks.length,elapsedMs:performance.now()-start,startedAt,completedAt:new Date().toISOString()})});
  } finally {
    options.signal.removeEventListener("abort",abort);
    void reader.cancel().catch(()=>{}); reader.releaseLock();
  }
}
export function httpJson(observation: NativeHttpObservation): Record<string,unknown> {
  if (observation.status < 200 || observation.status >= 300) throw new NativeProtocolError("native_http_rejected",{status:observation.status});
  return object(json(observation.body,32*1024*1024));
}
