import { copy, digest, object, json, token, NativeProtocolError } from "../NativeJson.js";
import type { ResponsesPreparation } from "../OpenAIResponses.js";
import { nativeHttpEndpoint } from "../NativeHttpEndpoint.js";
import { streamNativeHttp, type NativeTransportPart } from "./NativeHttpStream.js";
import { ResponsesObservation, type ResponsesObservationHead } from "./ResponsesObservation.js";
import { responsesReadFailure, responsesPollDue, validateResponsesObservationPolicy, type ResponsesFailureEpisode, type ResponsesObservationPolicy } from "./ResponsesOperationPolicy.js";
import { responsesWebSocketCreate, validateResponsesTransportProfile, type ResponsesTransportProfile } from "./ResponsesTransportProfile.js";
import type { ResponsesWebSocket } from "./ResponsesWebSocket.js";

export interface ResponsesSessionBinding {
  readonly id:string;readonly scopeId:string;readonly target:string;readonly prepared:Pick<ResponsesPreparation,"body"|"encoded"|"digest">;
  readonly profile:ResponsesTransportProfile;readonly policy:ResponsesObservationPolicy;
  readonly createdAt:number;readonly deadlineAt:number;readonly maximumBytes:number;readonly maximumFrameBytes:number;readonly maximumEvents:number;
}
export type ResponsesOperation="create"|"retrieve"|"resume"|"cancel";
export interface ResponsesSessionState {
  readonly bindingDigest:string;readonly revision:number;readonly segments:number;
  readonly head:ResponsesObservationHead;
  readonly creation:"unsent"|"possibly_sent"|"observed"|"rejected";
  readonly pending:{readonly id:string;readonly kind:ResponsesOperation;readonly startedAt:number}|null;
  readonly operations:number;readonly polls:number;readonly dueAt:number|null;readonly lastAt:number;
  readonly readEpisode:ResponsesFailureEpisode|null;readonly cancelEpisode:ResponsesFailureEpisode|null;
  readonly cancellation:string|null;readonly cancelAcknowledged:boolean;
  readonly observation:"stream"|"poll";
  readonly disposition:"active"|"terminal"|"unresolved"|"unsent";
  readonly reason:string|null;readonly followUp:string|null;readonly followUpDeadlineAt:number|null;readonly shutdown:"preserve"|"cancel"|null;
}
export type ResponsesSessionSegment = (
  | {readonly kind:"dispatch";readonly operationId:string;readonly operation:ResponsesOperation;readonly method:"POST"|"GET"|"websocket";readonly url:string;readonly body:string|null;readonly startingAfter:number|null;readonly startedAt?:number}
  | {readonly kind:"http";readonly operationId:string;readonly part:NativeTransportPart;readonly interpretationError?:string}
  | {readonly kind:"websocket";readonly operationId:string;readonly data:string;readonly interpretationError?:string}
  | {readonly kind:"body";readonly operationId:string;readonly data:string;readonly interpretationError?:string}
  | {readonly kind:"gap";readonly operationId:string;readonly reason:string}
  | {readonly kind:"outcome";readonly operationId:string;readonly code:string;readonly status:number|null}
  | {readonly kind:"control";readonly identity:string;readonly action:"cancel"|"preserve"|"follow_up"}
) & {readonly work?:{readonly observedAt:number;readonly interpretMs:number;readonly socket:{readonly queueMs:number;readonly bufferedBytes:number;readonly frameBytes:number}|null}};
export interface ResponsesSessionStore {
  load():Promise<ResponsesSessionState|null>;
  /** State and segment identity commit atomically; repeating a committed revision only returns its original receipt. */
  commit(expectedRevision:number|null,state:ResponsesSessionState,segment:ResponsesSessionSegment|null):Promise<void>;
  segments(count:number):AsyncIterable<ResponsesSessionSegment>;
}
export interface ResponsesSessionEnvironment {
  readonly now:()=>number;readonly jitter:()=>number;
  readonly target:string;readonly headers:Readonly<Record<string,string>>;readonly baseUrl:string;
  readonly signal:AbortSignal;readonly fetch?:typeof globalThis.fetch;readonly socket?:ResponsesWebSocket;
  /** Checks current authority/custody without replacing the original accepted target or input. */
  readonly authorize:(operation:ResponsesOperation)=>Promise<void>;
}

/** Native progression performs at most one bounded operation; the host schedules returned due times. */
export class ResponsesSession {
  private readonly fold:ResponsesObservation;
  private state!:ResponsesSessionState;
  private busy=false;
  private poisoned=false;
  private constructor(readonly binding:ResponsesSessionBinding,private readonly store:ResponsesSessionStore){this.fold=new ResponsesObservation(binding.maximumEvents,binding.profile.stream);}
  static async open(binding:ResponsesSessionBinding,store:ResponsesSessionStore):Promise<ResponsesSession>{
    for(const value of [binding.id,binding.scopeId,binding.target])token(value);
    validateResponsesTransportProfile(binding.profile,binding.prepared);validateResponsesObservationPolicy(binding.policy);
    for(const value of [binding.createdAt,binding.deadlineAt,binding.maximumBytes,binding.maximumFrameBytes,binding.maximumEvents])
      if(!Number.isSafeInteger(value)||value<1)throw new NativeProtocolError("responses_session_limits_invalid");
    if(binding.deadlineAt<=binding.createdAt||binding.maximumFrameBytes>binding.maximumBytes)throw new NativeProtocolError("responses_session_limits_invalid");
    const session=new ResponsesSession(copy(binding),store),saved=await store.load();
    if(saved){
      if(saved.bindingDigest!==digest(binding))throw new NativeProtocolError("responses_original_binding_changed");
      session.state=copy(saved);let count=0;
      for await(const segment of store.segments(saved.segments)){session.replay(segment);count++;}
      if(count!==saved.segments||digest(session.fold.head())!==digest(saved.head))throw new NativeProtocolError("responses_checkpoint_content_mismatch");
    }else{
      session.state=copy({bindingDigest:digest(binding),revision:0,segments:0,head:session.fold.head(),creation:"unsent",pending:null,operations:0,polls:0,
        dueAt:null,lastAt:binding.createdAt,readEpisode:null,cancelEpisode:null,cancellation:null,cancelAcknowledged:false,
        observation:binding.profile.stream?"stream":"poll",disposition:"active",reason:null,followUp:null,followUpDeadlineAt:null,shutdown:null});
      await store.commit(null,session.state,null);
    }
    return session;
  }
  snapshot():ResponsesSessionState{return this.state;}
  response():ReturnType<ResponsesObservation["complete"]>{this.requireCommittedFold();return this.fold.complete();}
  continuationItems():ReturnType<ResponsesObservation["continuationItems"]>{this.requireCommittedFold();return this.fold.continuationItems();}
  private requireCommittedFold():void{if(this.poisoned)throw new NativeProtocolError("responses_session_reload_required");}
  private replay(segment:ResponsesSessionSegment):void{
    let errorCode:string|null=null;
    try{
    if(segment.kind==="http"&&segment.part.kind!=="headers")for(const frame of segment.part.frames)this.fold.event(frame.data,frame.event);
    if(segment.kind==="http"&&segment.part.kind!=="headers"&&segment.part.decodeError)throw new NativeProtocolError(segment.part.decodeError);
    if(segment.kind==="websocket")this.fold.event(segment.data);
    if(segment.kind==="body")this.fold.response(object(json(segment.data,this.binding.maximumBytes)));
    if(segment.kind==="gap")this.fold.gap();
    }catch(error){errorCode=error instanceof NativeProtocolError?error.code:"native_interpretation_failed";}
    if(errorCode!==("interpretationError" in segment?segment.interpretationError??null:null))throw new NativeProtocolError("responses_segment_interpretation_changed");
  }
  private async save(patch:Partial<ResponsesSessionState>,segment:ResponsesSessionSegment|null=null):Promise<void>{
    this.requireCommittedFold();
    const next=copy({...this.state,...patch,head:this.fold.head(),revision:this.state.revision+1,segments:this.state.segments+(segment?1:0)});
    try{await this.store.commit(this.state.revision,next,segment);this.state=next;}
    catch(error){this.poisoned=true;throw error;}
  }
  async cancel(identity:string):Promise<void>{
    if(this.poisoned)throw new NativeProtocolError("responses_session_reload_required");
    token(identity);if(this.busy)throw new NativeProtocolError("responses_control_requires_interrupted_operation");
    if(this.state.cancellation){if(this.state.cancellation!==identity)throw new NativeProtocolError("responses_cancel_identity_changed");return;}
    await this.save({cancellation:identity,dueAt:null,disposition:"active",reason:null}, {kind:"control",identity,action:"cancel"});
  }
  async shutdown(policy:"preserve"|"cancel",identity:string):Promise<void>{
    this.requireCommittedFold();token(identity);
    if(policy==="cancel"){await this.cancel(identity);await this.save({shutdown:policy});}
    else {if(this.busy)throw new NativeProtocolError("responses_shutdown_requires_checkpoint");await this.save({shutdown:policy},{kind:"control",identity,action:"preserve"});}
  }
  /** The caller supplies an already accepted shared handoff receipt, never just a receiver name. */
  async followUp(receipt:string,expiresAt:number):Promise<void>{
    this.requireCommittedFold();
    token(receipt);if(!this.state.cancellation||this.busy)throw new NativeProtocolError("responses_follow_up_ineligible");
    if(!Number.isSafeInteger(expiresAt)||expiresAt>this.binding.deadlineAt||expiresAt<1)throw new NativeProtocolError("responses_follow_up_deadline_invalid");
    if(this.state.followUp&&this.state.followUp!==receipt)throw new NativeProtocolError("responses_follow_up_identity_changed");
    if(this.state.followUp&&this.state.followUpDeadlineAt!==expiresAt)throw new NativeProtocolError("responses_follow_up_deadline_changed");
    if(!this.state.followUp)await this.save({followUp:receipt,followUpDeadlineAt:expiresAt},{kind:"control",identity:receipt,action:"follow_up"});
  }
  async step(env:ResponsesSessionEnvironment):Promise<ResponsesSessionState>{
    if(this.poisoned)throw new NativeProtocolError("responses_session_reload_required");
    if(this.busy)throw new NativeProtocolError("responses_session_busy");this.busy=true;
    try{return await this.advance(env);}finally{this.busy=false;}
  }
  private async advance(env:ResponsesSessionEnvironment):Promise<ResponsesSessionState>{
    if(env.target!==this.binding.target)throw new NativeProtocolError("responses_original_target_changed");
    env.signal.throwIfAborted();const now=env.now();
    if(!Number.isFinite(now)||now<this.state.lastAt){await this.save({disposition:"unresolved",reason:"clock_revalidation_required",dueAt:null});return this.state;}
    if(this.state.disposition!=="active")return this.state;
    if(now>=Math.min(this.binding.deadlineAt,this.state.followUpDeadlineAt??Infinity)){await this.save({lastAt:now,disposition:"unresolved",reason:"authorized_lifetime_exhausted",pending:null,dueAt:null});return this.state;}
    if(this.state.dueAt!==null&&now<this.state.dueAt)return this.state;
    if(this.state.head.terminal){await this.save({lastAt:now,disposition:this.state.head.unsupported?"unresolved":"terminal",reason:this.state.head.unsupported?"unsupported_native_observation":null,pending:null,dueAt:null});return this.state;}
    const profile=this.binding.profile;
    if(this.state.cancellation&&(this.state.creation==="unsent"||this.state.creation==="rejected")){
      await this.save({lastAt:now,disposition:"unsent",pending:null,dueAt:null});return this.state;
    }
    if(this.state.cancellation&&(!profile.background||!this.state.head.responseId)){
      await env.socket?.close();await this.save({lastAt:now,disposition:"unresolved",reason:"local_closed_remote_outcome_unknown",pending:null,dueAt:null});return this.state;
    }
    let operation:ResponsesOperation;
    if(this.state.cancellation&&!this.state.cancelAcknowledged)operation="cancel";
    else if(this.state.creation==="unsent")operation="create";
    else if(this.state.head.responseId&&(profile.store||profile.background)){
      operation=profile.background&&profile.stream&&this.state.observation==="stream"?"resume":"retrieve";
    }else{
      await this.save({lastAt:now,disposition:"unresolved",reason:"original_response_unavailable",pending:null,dueAt:null});return this.state;
    }
    // A lost read/cancel attempt spends its original allowance instead of disappearing on restart.
    if(this.state.pending&&operation!=="create"){
      const old=this.state.pending;
      await this.failure(old.kind,now,"interrupted_operation",null,true,null,env.jitter());
      if(operation==="cancel"&&old.kind!=="cancel")await this.save({disposition:"active",dueAt:null,reason:null});
      return this.state;
    }
    const episode=operation==="cancel"?this.state.cancelEpisode:this.state.readEpisode;
    if(episode&&(episode.exhausted||now>=episode.deadlineAt)){
      await this.save({lastAt:now,disposition:"unresolved",reason:operation==="cancel"?"cancel_episode_exhausted":"observation_episode_exhausted",dueAt:null});return this.state;
    }
    await env.authorize(operation);env.signal.throwIfAborted();
    const id=`${this.binding.id}:operation:${this.state.operations+1}`;
    const responseId=this.state.head.responseId;
    let url=nativeHttpEndpoint(env.baseUrl,"responses"),body:string|null=null,method:"POST"|"GET"|"websocket"="GET",framing:"sse"|"json"="json";
    if(operation==="create"){
      method=profile.transport==="websocket"?"websocket":"POST";
      body=method==="websocket"?responsesWebSocketCreate(this.binding.prepared).encoded:this.binding.prepared.encoded;
      framing=profile.stream?"sse":"json";
    }else{
      url+=`/${encodeURIComponent(responseId!)}`;
      if(operation==="cancel"){url+="/cancel";method="POST";body="{}";}
      if(operation==="resume"){
        const query=new URL(url);query.searchParams.set("stream","true");if(this.state.head.cursor!==null)query.searchParams.set("starting_after",String(this.state.head.cursor));url=query.href;framing="sse";
      }
    }
    await this.save({lastAt:now,pending:{id,kind:operation,startedAt:now},operations:this.state.operations+1,
      creation:operation==="create"?"possibly_sent":this.state.creation,dueAt:null},
      {kind:"dispatch",operationId:id,operation,method,url,body,startingAfter:operation==="resume"?this.state.head.cursor:null,startedAt:now});
    const controller=new AbortController(),signal=AbortSignal.any([env.signal,controller.signal]);
    const deadline=Math.min(this.binding.deadlineAt,this.state.followUpDeadlineAt??Infinity,episode?.deadlineAt??Infinity,operation==="retrieve"||operation==="cancel"?now+this.binding.policy.readMs:Infinity);
    const timeout=setTimeout(()=>controller.abort(new NativeProtocolError("responses_operation_deadline")),Math.min(2147483647,Math.max(1,deadline-now)));timeout.unref();
    let status:number|null=null,retryAfter:string|null=null,buffer:Buffer[]=[],persistenceFailure=false;
    const commit=async(patch:Partial<ResponsesSessionState>,segment:ResponsesSessionSegment)=>{
      try{await this.save(patch,segment);}catch(error){persistenceFailure=true;throw error;}
    };
    const observe=async(segment:Extract<ResponsesSessionSegment,{kind:"http"|"websocket"|"body"}>,read:()=>void)=>{
      let failure:unknown;const before=this.fold.head().events,started=performance.now(),observedAt=env.now();
      try{read();}catch(error){failure=error;}
      const work={observedAt,interpretMs:performance.now()-started,socket:segment.kind==="websocket"?env.socket?.lastObservation()??null:null};
      await commit({lastAt:env.now(),creation:this.fold.head().responseId?"observed":this.state.creation,
        ...(this.fold.head().events>before&&!failure?{readEpisode:null}:{} )},
        {...segment,work,...(failure?{interpretationError:failure instanceof NativeProtocolError?failure.code:"native_interpretation_failed"}:{})});
      if(failure)throw failure;
    };
    try{
      if(method==="websocket"){
        if(!env.socket)throw new NativeProtocolError("responses_websocket_not_sent");
        for await(const data of env.socket.create({scopeId:this.binding.scopeId,incarnation:profile.connectionIncarnation!,encoded:body!,signal,
          silenceMs:this.binding.policy.silenceMs,maximumBytes:this.binding.maximumBytes})){
          await observe({kind:"websocket",operationId:id,data},()=>this.fold.event(data));
        }
      }else{
        for await(const part of streamNativeHttp({url,method,headers:env.headers,...(body===null?{}:{body}),framing,signal,fetch:env.fetch,
          limits:{connectMs:this.binding.policy.connectMs,silenceMs:this.binding.policy.silenceMs,maximumBytes:this.binding.maximumBytes,maximumFrameBytes:this.binding.maximumFrameBytes}})){
          if(part.kind==="headers"){status=part.status;retryAfter=part.retryAfter;}
          else{
            if(framing==="json"||status!==null&&(status<200||status>=300)){if(part.kind==="bytes")buffer.push(Buffer.from(part.bytesBase64,"base64"));}
          }
          await observe({kind:"http",operationId:id,part},()=>{
            if(part.kind!=="headers"&&framing!=="json"&&status!==null&&status>=200&&status<300)
              for(const frame of part.frames)this.fold.event(frame.data,frame.event);
            if(part.kind!=="headers"&&part.decodeError)throw new NativeProtocolError(part.decodeError);
          });
        }
        if(status!==null&&(status<200||status>=300)){
          const errorText=Buffer.concat(buffer).toString("utf8");
          const retryable=status===408||status===429||status>=500;
          if(operation==="create"){
            const rejected=status>=400&&status<500&&status!==408;
            await this.save({lastAt:env.now(),pending:null,creation:rejected?"rejected":"possibly_sent",disposition:"unresolved",reason:rejected?"create_rejected":"create_outcome_unknown"},
              {kind:"outcome",operationId:id,code:errorText||"http_rejection",status});
          }else if(operation==="resume"&&(status===400||status===404)&&this.state.head.responseId){
            this.fold.gap();await commit({observation:"poll",lastAt:env.now()}, {kind:"gap",operationId:id,reason:"resume_unavailable"});
            await this.failure(operation,env.now(),"resume_unavailable",retryAfter,true,status,env.jitter());
          }else await this.failure(operation,env.now(),`http_${status}`,retryAfter,retryable,status,env.jitter());
          return this.state;
        }
        if(framing==="json"){
          const data=Buffer.concat(buffer).toString("utf8");
          await observe({kind:"body",operationId:id,data},()=>this.fold.response(object(json(data,this.binding.maximumBytes))));
        }
      }
      const head=this.fold.head();
      if(head.unsupported){await this.save({pending:null,disposition:"unresolved",reason:"unsupported_native_observation",dueAt:null});return this.state;}
      if(!head.terminal&&(!profile.background||!head.responseId))throw new NativeProtocolError("responses_stream_incomplete");
      await this.save({pending:null,lastAt:env.now(),readEpisode:null,...(operation==="cancel"?{cancelAcknowledged:true,cancelEpisode:null}:{}),
        polls:head.terminal?this.state.polls:this.state.polls+1,disposition:head.terminal?"terminal":"active",
        dueAt:head.terminal?null:responsesPollDue(this.binding.policy,this.state.polls,env.now(),env.jitter()),reason:null},
        {kind:"outcome",operationId:id,code:head.terminal?"terminal_observed":"healthy_wait",status});
    }catch(error){
      if(persistenceFailure)throw error;
      const code=error instanceof NativeProtocolError?error.code:"transport_interrupted";
      if(operation==="create"&&!this.fold.head().responseId){
        await this.save({pending:null,lastAt:env.now(),creation:code==="responses_websocket_not_sent"?"unsent":"possibly_sent",disposition:"unresolved",reason:code,dueAt:null},
          {kind:"outcome",operationId:id,code,status});
      }else await this.failure(operation,env.now(),code,retryAfter,!code.includes("conflict")&&!code.includes("invalid")&&!code.includes("limit"),status,env.jitter());
    }finally{clearTimeout(timeout);controller.abort();}
    return this.state;
  }
  private async failure(operation:ResponsesOperation,now:number,reason:string,retryAfter:string|null,retryable:boolean,status:number|null,jitter:number):Promise<void>{
    const control=operation==="cancel",previous=control?this.state.cancelEpisode:this.state.readEpisode;
    const episode=responsesReadFailure({previous,policy:this.binding.policy,now,startedAt:reason==="interrupted_operation"?this.state.lastAt:now,
      lifetime:Math.min(this.binding.deadlineAt,this.state.followUpDeadlineAt??Infinity),retryAfter,reason,retryable,jitter});
    await this.save({pending:null,lastAt:now,...(control?{cancelEpisode:episode}:{readEpisode:episode}),
      dueAt:episode.exhausted?null:episode.dueAt,disposition:episode.exhausted?"unresolved":"active",reason},
      {kind:"outcome",operationId:this.state.pending?.id??`${this.binding.id}:recovery`,code:reason,status});
  }
}
