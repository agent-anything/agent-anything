import WebSocket from "ws";
import { NativeProtocolError, token, object, json } from "../NativeJson.js";
import { nativeHttpEndpoint } from "../NativeHttpEndpoint.js";

/** One physical carrier per independently cancellable scope; never a cross-scope pool. */
export class ResponsesWebSocket {
  private socket:WebSocket|null=null;
  private active=false;
  private queue:{text:string;arrivedAt:number}[]=[];
  private queuedBytes=0;
  private failure:unknown=null;
  private wake:(()=>void)|null=null;
  private observation:{queueMs:number;bufferedBytes:number;frameBytes:number}|null=null;
  lastObservation(){return this.observation?{...this.observation}:null;}
  constructor(readonly scopeId:string,readonly incarnation:string,private readonly connection:{readonly baseUrl:string;readonly headers:Readonly<Record<string,string>>},
    private readonly limits:{readonly connectMs:number;readonly maximumFrameBytes:number;readonly maximumBufferedBytes:number}){
    token(scopeId);token(incarnation);
    for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<1)throw new NativeProtocolError("responses_socket_limits_invalid");
  }
  private notify():void{this.wake?.();this.wake=null;}
  private async open(signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();
    if(this.failure)throw this.failure;
    if(this.socket?.readyState===WebSocket.OPEN)return;
    if(this.socket)throw new NativeProtocolError("responses_connection_lost");
    const url=new URL(nativeHttpEndpoint(this.connection.baseUrl,"responses"));url.protocol=url.protocol==="https:"?"wss:":"ws:";
    const socket=this.socket=new WebSocket(url,{headers:this.connection.headers,handshakeTimeout:this.limits.connectMs,
      maxPayload:this.limits.maximumFrameBytes,perMessageDeflate:false,followRedirects:false});
    socket.on("message",(data,binary)=>{
      if(binary){this.failure=new NativeProtocolError("responses_binary_frame_unsupported");socket.terminate();this.notify();return;}
      const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.from(data as Buffer),text=bytes.toString("utf8");
      this.queuedBytes+=bytes.length;
      if(this.queuedBytes>this.limits.maximumBufferedBytes){this.failure=new NativeProtocolError("responses_socket_backpressure_limit");socket.terminate();this.notify();return;}
      this.queue.push({text,arrivedAt:performance.now()});socket.pause();this.notify();
    });
    socket.on("error",error=>{this.failure=error;this.notify();});
    socket.on("close",()=>{this.failure??=new NativeProtocolError("responses_connection_lost");this.notify();});
    // Control-frame traffic is liveness, not a model event or a resumable response cursor.
    socket.on("ping",()=>this.notify());socket.on("pong",()=>this.notify());
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{socket.terminate();finish(new NativeProtocolError("responses_websocket_not_sent"));};
      const failed=()=>finish(new NativeProtocolError("responses_websocket_not_sent"));
      const opened=()=>finish();
      const finish=(error?:unknown)=>{signal.removeEventListener("abort",abort);socket.off("open",opened);socket.off("error",failed);socket.off("close",failed);error?reject(error):resolve();};
      signal.addEventListener("abort",abort,{once:true});socket.once("open",opened);socket.once("error",failed);socket.once("close",failed);
      if(signal.aborted)abort();
    });
  }
  async *create(input:{readonly scopeId:string;readonly incarnation:string;readonly encoded:string;readonly signal:AbortSignal;
    readonly silenceMs:number;readonly maximumBytes:number}):AsyncGenerator<string>{
    if(input.scopeId!==this.scopeId||input.incarnation!==this.incarnation)throw new NativeProtocolError("responses_connection_scope_changed");
    if(this.active)throw new NativeProtocolError("responses_connection_busy");
    const envelope=object(json(input.encoded,32*1024*1024));
    if(envelope.type!=="response.create"||Object.hasOwn(envelope,"stream")||Object.hasOwn(envelope,"background")||Object.hasOwn(envelope,"generate"))
      throw new NativeProtocolError("responses_websocket_create_invalid");
    this.active=true;let completed=false,bytes=0;
    const abort=()=>{this.failure=input.signal.reason??new NativeProtocolError("responses_socket_interrupted");this.socket?.terminate();this.notify();};
    try{
      await this.open(input.signal);input.signal.addEventListener("abort",abort,{once:true});input.signal.throwIfAborted();
      await new Promise<void>((resolve,reject)=>this.socket!.send(input.encoded,error=>error?reject(error):resolve()));
      for(;;){
        if(!this.queue.length){
          if(this.failure)throw this.failure;
          this.socket!.resume();
          await new Promise<void>((resolve,reject)=>{
            const timer=setTimeout(()=>{this.wake=null;reject(new NativeProtocolError("responses_socket_silence"));},input.silenceMs);timer.unref();
            this.wake=()=>{clearTimeout(timer);resolve();};
            if(this.queue.length||this.failure)this.notify();
          });
        }
        input.signal.throwIfAborted();
        const entry=this.queue.shift();if(entry===undefined)continue;const {text,arrivedAt}=entry;
        const length=Buffer.byteLength(text);this.queuedBytes-=length;bytes+=length;
        this.observation={queueMs:performance.now()-arrivedAt,bufferedBytes:this.queuedBytes,frameBytes:length};
        if(bytes>input.maximumBytes)throw new NativeProtocolError("responses_socket_body_limit");
        yield text;
        const type=object(json(text,this.limits.maximumFrameBytes)).type;
        if(["response.completed","response.failed","response.incomplete","error"].includes(String(type))){completed=true;break;}
      }
    }finally{
      input.signal.removeEventListener("abort",abort);this.active=false;
      if(!completed)this.socket?.terminate();
    }
  }
  async close():Promise<void>{
    const socket=this.socket;if(!socket||socket.readyState===WebSocket.CLOSED)return;
    await new Promise<void>(resolve=>{socket.once("close",()=>resolve());socket.terminate();});
  }
}
