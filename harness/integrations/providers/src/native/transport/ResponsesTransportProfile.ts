import { copy, token, validateNativePreparedEncoding, NativeProtocolError, type JsonObject } from "../NativeJson.js";
import type { ResponsesPreparation } from "../OpenAIResponses.js";
export interface ResponsesTransportProfile {
  readonly transport:"http"|"websocket";
  readonly background:boolean;readonly stream:boolean;readonly store:boolean;
  readonly temporaryRetention:boolean;
  readonly continuity:"native_replay"|"persistent_chain"|"connection_memory";
  readonly connectionIncarnation:string|null;
}
export function validateResponsesTransportProfile(profile:ResponsesTransportProfile,prepared:Pick<ResponsesPreparation,"body"|"encoded"|"digest">):void {
  const body=validateNativePreparedEncoding(prepared,"responses_transport_input_changed");
  if(!["http","websocket"].includes(profile.transport)||!["native_replay","persistent_chain","connection_memory"].includes(profile.continuity)||
    [profile.background,profile.stream,profile.store,profile.temporaryRetention].some(v=>typeof v!=="boolean"))throw new NativeProtocolError("responses_transport_profile_invalid");
  if(body.store!==profile.store)throw new NativeProtocolError("responses_storage_profile_mismatch");
  if(profile.continuity==="persistent_chain"&&!profile.store)throw new NativeProtocolError("responses_storage_not_authorized");
  if(profile.background&&(!profile.temporaryRetention||profile.transport!=="http"))throw new NativeProtocolError("responses_temporary_retention_not_authorized");
  if(profile.transport==="websocket"){
    token(profile.connectionIncarnation);
    if(!profile.stream||Object.hasOwn(body,"stream")||Object.hasOwn(body,"background"))throw new NativeProtocolError("responses_websocket_http_fields");
  }else if(profile.connectionIncarnation!==null||profile.continuity==="connection_memory"||body.stream!==profile.stream||Boolean(body.background)!==profile.background)
    throw new NativeProtocolError("responses_http_profile_mismatch");
}
export function responsesWebSocketCreate(prepared:Pick<ResponsesPreparation,"body"|"encoded"|"digest">):{readonly body:JsonObject;readonly encoded:string} {
  const body=validateNativePreparedEncoding(prepared,"responses_websocket_input_changed");
  if(Object.hasOwn(body,"stream")||Object.hasOwn(body,"background")||Object.hasOwn(body,"type")||Object.hasOwn(body,"generate"))throw new NativeProtocolError("responses_websocket_http_fields");
  const event={type:"response.create",...body};return copy({body:event,encoded:JSON.stringify(event)});
}
