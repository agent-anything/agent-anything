import {validCredentialRef,type ProviderCredentialRef} from "./ProviderCredentialStore.js";

export type HelarcRunCredentialBinding =
  | import("./ProviderConnectionRetention.js").RetainedConnection
  | {readonly kind:"none"}
  | {readonly kind:"saved";readonly ref:ProviderCredentialRef}
  | {readonly kind:"environment";readonly name:"HELARC_PROVIDER_API_KEY"};

export function validHelarcRunCredentialBinding(value:unknown,profileId:string):value is HelarcRunCredentialBinding {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>,keys=Object.keys(v).sort().join();
  if(v.kind==="none")return keys==="kind";
  if(v.kind==="connection")return keys==="acceptanceId,bindingId,kind,pinId"&&[v.acceptanceId,v.bindingId,v.pinId].every(value=>typeof value==="string"&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
  if(v.kind==="environment")return keys==="kind,name"&&profileId==="env-provider"&&v.name==="HELARC_PROVIDER_API_KEY";
  return v.kind==="saved"&&keys==="kind,ref"&&validCredentialRef(v.ref,profileId);
}
