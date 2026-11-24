import { createHash, type Hash } from "node:crypto";
import { copy, digest, json, object, token, list, string, NativeProtocolError, type JsonObject } from "../NativeJson.js";

export interface ResponsesObservationHead {
  readonly responseId:string|null;readonly cursor:number|null;
  readonly status:string|null;readonly terminal:boolean;
  readonly capture:"complete"|"gap"|"not_applicable";readonly unsupported:boolean;
  readonly events:number;readonly duplicates:number;readonly keepalives:number;
}
interface Part {hash:Hash;bytes:number;done:string|null}
export interface ResponsesContinuationItem {
  readonly item:JsonObject;
  readonly source:{readonly kind:"output_item_done";readonly sequence:number}|{readonly kind:"terminal_response"};
}
const terminals=new Set(["completed","failed","incomplete","cancelled"]);
const statuses=new Set(["queued","in_progress",...terminals]);

/** Native fold state lives in memory; durable recovery replays immutable segments once. */
export class ResponsesObservation {
  private responseId:string|null=null;
  private cursor:number|null=null;
  private status:string|null=null;
  private capture:"complete"|"gap"|"not_applicable"="complete";
  private unsupported=false;
  private events=0;private duplicates=0;private keepalives=0;
  private readonly seen=new Map<number,string>();
  private readonly parts=new Map<string,Part>();
  private readonly items=new Map<string,JsonObject>();
  private readonly closedItems=new Map<string,{item:JsonObject;hash:string;sequence:number}>();
  private body:JsonObject|null=null;
  constructor(private readonly maximumEvents=1_000_000,streamExpected=true){
    if(!Number.isSafeInteger(maximumEvents)||maximumEvents<1)throw new NativeProtocolError("responses_event_limit_invalid");
    if(!streamExpected)this.capture="not_applicable";
  }
  head():ResponsesObservationHead{return {responseId:this.responseId,cursor:this.cursor,status:this.status,terminal:this.status!==null&&terminals.has(this.status),
    capture:this.capture,unsupported:this.unsupported,events:this.events,duplicates:this.duplicates,keepalives:this.keepalives};}
  complete():JsonObject|null{return this.body;}
  continuationItems():readonly ResponsesContinuationItem[]|null{
    if(!this.body)return null;
    return copy(list(this.body.output).map(raw=>{
      const item=object(raw),closed=this.closedItems.get(token(item.id));
      return closed&&hasOpaqueContent(item)
        ?{item:closed.item,source:{kind:"output_item_done" as const,sequence:closed.sequence}}
        :{item,source:{kind:"terminal_response" as const}};
    }));
  }
  gap():void{if(this.capture!=="not_applicable")this.capture="gap";}
  private bind(id:unknown):void{const value=token(id);if(this.responseId&&this.responseId!==value)throw new NativeProtocolError("responses_identity_changed");this.responseId=value;}
  event(raw:string,eventName="message"):void {
    const value=object(json(raw)),type=string(value.type);
    if(eventName!=="message"&&eventName!==type)throw new NativeProtocolError("responses_event_type_mismatch");
    if(type==="keepalive"){this.keepalives++;return;}
    if(value.response!==undefined)this.bind(object(value.response).id);
    if(value.response_id!==undefined)this.bind(value.response_id);
    const sequence=value.sequence_number;
    if(!Number.isSafeInteger(sequence)||Number(sequence)<0)throw new NativeProtocolError("responses_event_sequence_invalid");
    // Only the documented top-level transport padding is ignored for semantic identity.
    const {obfuscation:_,...semantic}=value,identity=digest(semantic),old=this.seen.get(Number(sequence));
    if(old){if(old!==identity)throw new NativeProtocolError("responses_event_conflict");this.duplicates++;return;}
    if(this.cursor!==null&&Number(sequence)<=this.cursor)throw new NativeProtocolError("responses_event_sequence_invalid");
    if(this.events>=this.maximumEvents)throw new NativeProtocolError("responses_event_limit");
    if(this.body)throw new NativeProtocolError("responses_event_after_terminal");
    if(type==="error"){this.unsupported=true;}
    else if(["response.created","response.queued","response.in_progress"].includes(type))this.response(object(value.response),false);
    else if(["response.completed","response.failed","response.incomplete"].includes(type)){
      if(object(value.response).status!==type.slice(9))throw new NativeProtocolError("responses_terminal_status_mismatch");
      this.response(object(value.response),true);
    }else if(type==="response.output_item.added"){
      const item=object(value.item),id=token(item.id);if(this.items.has(id))throw new NativeProtocolError("responses_item_duplicate");this.items.set(id,item);
    }else if(type==="response.output_item.done"){
      const item=object(value.item),id=token(item.id);this.verifyItem(item);const hash=digest(item);
      if(this.closedItems.has(id)&&this.closedItems.get(id)!.hash!==hash)throw new NativeProtocolError("responses_closed_item_conflict");
      comparableItem(item);this.closedItems.set(id,{item:copy(item),hash,sequence:Number(sequence)});
    }else if(/^(response\.(output_text|refusal|function_call_arguments|reasoning_summary_text|reasoning_text))\.(delta|done)$/.test(type)){
      this.part(value,type);
    }else if(["response.content_part.added","response.content_part.done","response.reasoning_summary_part.added","response.reasoning_summary_part.done"].includes(type)){
      token(value.item_id);
    }else if(!["response.compaction.in_progress","response.compaction.completed","response.compaction.failed"].includes(type)){
      this.unsupported=true;
    }
    this.seen.set(Number(sequence),identity);this.cursor=Number(sequence);this.events++;
  }
  response(value:JsonObject,fromStream=false):void {
    this.bind(value.id);if(value.object!=="response"||!statuses.has(String(value.status)))throw new NativeProtocolError("responses_envelope_invalid");
    const status=String(value.status);
    if(this.body){
      if(!terminals.has(status))return;
      if(digest(comparableResponse(this.body))!==digest(comparableResponse(value)))throw new NativeProtocolError("responses_terminal_conflict");return;
    }
    if(terminals.has(status)){
      if(!fromStream)this.gap();
      const output=list(value.output).map(object),ids=new Set<string>();
      for(const item of output){const id=token(item.id);if(ids.has(id))throw new NativeProtocolError("responses_item_duplicate");ids.add(id);this.verifyItem(item);
        comparableItem(item);
        if(this.closedItems.has(id)&&digest(comparableItem(this.closedItems.get(id)!.item))!==digest(comparableItem(item)))throw new NativeProtocolError("responses_closed_item_conflict");}
      for(const id of this.closedItems.keys())if(!ids.has(id))throw new NativeProtocolError("responses_closed_item_missing");
      this.body=value;
    }
    this.status=status;
  }
  private part(value:JsonObject,type:string):void{
    const id=token(value.item_id),family=type.slice(0,type.lastIndexOf(".")),index=value.content_index??value.summary_index??0;
    if(!Number.isSafeInteger(index)||Number(index)<0)throw new NativeProtocolError("responses_part_index_invalid");
    const key=JSON.stringify([id,family,index]);let part=this.parts.get(key);
    if(!part){part={hash:createHash("sha256"),bytes:0,done:null};this.parts.set(key,part);}
    if(type.endsWith(".delta")){
      if(part.done!==null)throw new NativeProtocolError("responses_delta_after_done");const delta=string(value.delta);part.hash.update(delta);part.bytes+=Buffer.byteLength(delta);
    }else {
      const text=string(value.text??value.arguments??value.refusal),hash=createHash("sha256").update(text).digest("hex");
      if(part.bytes&&part.hash.copy().digest("hex")!==hash)throw new NativeProtocolError("responses_part_conflict");
      if(part.done!==null&&part.done!==hash)throw new NativeProtocolError("responses_part_conflict");part.done=hash;
    }
  }
  private verifyItem(item:JsonObject):void{
    const id=token(item.id),verify=(family:string,index:number,text:unknown)=>{
      const part=this.parts.get(JSON.stringify([id,family,index]));if(!part?.done)return;
      if(createHash("sha256").update(string(text)).digest("hex")!==part.done)throw new NativeProtocolError("responses_closed_part_conflict");
    };
    if(item.type==="function_call")verify("response.function_call_arguments",0,item.arguments);
    if(item.type==="message")for(const [index,raw] of list(item.content).entries()){
      const part=object(raw);if(part.type==="output_text")verify("response.output_text",index,part.text);if(part.type==="refusal")verify("response.refusal",index,part.refusal);
    }
    if(item.type==="reasoning")for(const [index,raw] of list(item.summary).entries())verify("response.reasoning_summary_text",index,object(raw).text);
  }
}

function hasOpaqueContent(item:JsonObject):boolean{return item.type==="reasoning"||item.type==="compaction";}
function comparableItem(item:JsonObject):JsonObject{
  if(!hasOpaqueContent(item))return item;
  const {encrypted_content,...visible}=item;
  if(encrypted_content!==undefined&&encrypted_content!==null)string(encrypted_content);
  return visible;
}
function comparableResponse(response:JsonObject):JsonObject{
  return {...response,output:list(response.output).map(raw=>comparableItem(object(raw)))};
}
