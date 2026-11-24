import {copy,digest,object,token,NativeProtocolError} from "../NativeJson.js";
import {createHash} from "node:crypto";
import type {NativeHttpObservation} from "../NativeHttp.js";
import {readResponsesCompact,type ResponsesCompactPreparation,type ResponsesCompactedWindow} from "./ResponsesCompaction.js";

export interface ResponsesCompactBinding {
  readonly id:string;readonly prepared:ResponsesCompactPreparation;
  readonly sourceDigest:string;readonly target:string;readonly disclosure:string;
  readonly startedAt:number;readonly deadlineAt:number;readonly maximumBytes:number;
}
export interface ResponsesCompactState {
  readonly revision:number;readonly bindingDigest:string;readonly segments:number;
  readonly status:"prepared"|"dispatched"|"observed"|"unknown"|"rejected";
  readonly cancelled:boolean;readonly bytes:number;readonly resourceId:string|null;
  readonly candidateDigest:string|null;readonly observationDigest:string|null;readonly failure:string|null;
}
export type ResponsesCompactSegment =
  | {readonly kind:"dispatch";readonly at:number}
  | {readonly kind:"chunk";readonly offset:number;readonly bytesBase64:string}
  | {readonly kind:"observation";readonly observation:NativeHttpObservation}
  | {readonly kind:"failure";readonly code:string}
  | {readonly kind:"cancel";readonly basis:string};
export interface ResponsesCompactStore {
  load():Promise<ResponsesCompactState|null>;
  segments(count:number):AsyncIterable<ResponsesCompactSegment>;
  commit(expected:number|null,state:ResponsesCompactState,segment:ResponsesCompactSegment|null):Promise<void>;
}

/** A single original compact operation. No retrieve/cancel-by-resource-id and no implicit POST retry. */
export class ResponsesCompactSession {
  private poisoned=false;
  private result:ResponsesCompactedWindow|null=null;
  private observation:NativeHttpObservation|null=null;
  private readonly chunksHash=createHash("sha256");
  private constructor(readonly binding:ResponsesCompactBinding,private readonly store:ResponsesCompactStore,private state:ResponsesCompactState){}
  static async open(binding:ResponsesCompactBinding,store:ResponsesCompactStore):Promise<ResponsesCompactSession>{
    token(binding.id);token(binding.sourceDigest);token(binding.target);token(binding.disclosure);
    if(!Number.isSafeInteger(binding.maximumBytes)||binding.maximumBytes<1||!Number.isFinite(binding.startedAt)||
      !Number.isFinite(binding.deadlineAt)||binding.deadlineAt<=binding.startedAt||digest(binding.prepared.body)!==binding.prepared.digest||
      digest(JSON.parse(binding.prepared.encoded))!==binding.prepared.digest)throw new NativeProtocolError("responses_compact_binding_invalid");
    const saved=await store.load(),state:ResponsesCompactState=saved??{revision:0,bindingDigest:digest(binding),segments:0,status:"prepared",
      cancelled:false,bytes:0,resourceId:null,candidateDigest:null,observationDigest:null,failure:null};
    if(state.bindingDigest!==digest(binding)||!Number.isSafeInteger(state.segments)||state.segments<0)throw new NativeProtocolError("responses_compact_original_binding_changed");
    const session=new ResponsesCompactSession(copy(binding),store,state);
    if(!saved)await store.commit(null,state,null);
    else {
      let recovered:ResponsesCompactState={revision:0,bindingDigest:digest(binding),segments:0,status:"prepared",cancelled:false,bytes:0,
        resourceId:null,candidateDigest:null,observationDigest:null,failure:null};
      for await(const segment of store.segments(state.segments))recovered=session.fold(recovered,segment);
      if(digest(recovered)!==digest(state))throw new NativeProtocolError("responses_compact_checkpoint_mismatch");
    }
    return session;
  }
  snapshot():ResponsesCompactState{this.usable();return copy(this.state);}
  candidate():ResponsesCompactedWindow|null{this.usable();return this.result;}
  observed():NativeHttpObservation|null{this.usable();return this.observation;}
  private usable(){if(this.poisoned)throw new NativeProtocolError("responses_compact_reload_required");}
  private fold(state:ResponsesCompactState,segment:ResponsesCompactSegment):ResponsesCompactState {
    object(segment);let next={...state,revision:state.revision+1,segments:state.segments+1};
    if(segment.kind==="dispatch"){
      if(state.status!=="prepared"||state.cancelled||segment.at<this.binding.startedAt||segment.at>=this.binding.deadlineAt)
        throw new NativeProtocolError("responses_compact_dispatch_not_allowed");
      next.status="dispatched";
    }else if(segment.kind==="chunk"){
      if(state.status!=="dispatched"||segment.offset!==state.bytes)throw new NativeProtocolError("responses_compact_chunk_position_invalid");
      const bytes=Buffer.from(segment.bytesBase64,"base64");
      if(bytes.toString("base64")!==segment.bytesBase64||!bytes.length||state.bytes+bytes.length>this.binding.maximumBytes)
        throw new NativeProtocolError("responses_compact_chunk_invalid");
      next.bytes+=bytes.length;
      this.chunksHash.update(bytes);
    }else if(segment.kind==="observation"){
      if(state.status!=="dispatched"&&state.status!=="unknown")throw new NativeProtocolError("responses_compact_observation_not_expected");
      const observation=segment.observation;
      if(Buffer.byteLength(observation.body)>this.binding.maximumBytes||observation.frames.length)throw new NativeProtocolError("responses_compact_body_invalid");
      if(state.bytes&&(state.bytes!==Buffer.byteLength(observation.body)||this.chunksHash.copy().digest("hex")!==createHash("sha256").update(observation.body).digest("hex")))
        throw new NativeProtocolError("responses_compact_retained_bytes_mismatch");
      this.observation=copy(observation);next.observationDigest=digest(observation);
      if(observation.status>=200&&observation.status<300){
        try{this.result=readResponsesCompact(observation);next.status="observed";next.resourceId=this.result.resourceId;next.candidateDigest=this.result.digest;}
        catch {next.status="rejected";next.failure="unsupported_compact_result";}
      }else {next.status="rejected";next.failure=`http_${observation.status}`;}
    }else if(segment.kind==="failure"){
      if(state.status!=="dispatched")throw new NativeProtocolError("responses_compact_failure_not_expected");
      next.status="unknown";next.failure=token(segment.code);
    }else if(segment.kind==="cancel"){token(segment.basis);next.cancelled=true;}
    else throw new NativeProtocolError("responses_compact_segment_unsupported");
    return next;
  }
  private async append(segment:ResponsesCompactSegment){
    this.usable();const before=this.state;
    try{const next=this.fold(before,segment);await this.store.commit(before.revision,next,segment);this.state=next;}
    catch(error){this.poisoned=true;throw error;}
  }
  async cancel(basis:string):Promise<void>{await this.append({kind:"cancel",basis});}
  async reconcileInterrupted():Promise<void>{
    this.usable();if(this.state.status==="dispatched")await this.append({kind:"failure",code:"original_compact_outcome_unknown"});
  }
  async retainObservation(observation:NativeHttpObservation):Promise<void>{await this.append({kind:"observation",observation});}
  async execute(input:{readonly now:number;readonly authorize:()=>Promise<boolean>;
    readonly dispatch:(retainChunk:(bytes:Uint8Array,offset:number)=>Promise<void>)=>Promise<NativeHttpObservation>}):Promise<ResponsesCompactState>{
    this.usable();
    if(this.state.status!=="prepared"||this.state.cancelled||input.now>=this.binding.deadlineAt)throw new NativeProtocolError("responses_compact_not_dispatchable");
    if(!await input.authorize())throw new NativeProtocolError("responses_compact_disclosure_denied");
    await this.append({kind:"dispatch",at:input.now});
    let observation:NativeHttpObservation;
    try{observation=await input.dispatch(async(bytes,offset)=>this.append({kind:"chunk",offset,bytesBase64:Buffer.from(bytes).toString("base64")}));}
    catch(error){if(!this.poisoned)await this.append({kind:"failure",code:"compact_transport_outcome_unknown"});throw error;}
    await this.retainObservation(observation);return this.snapshot();
  }
}
