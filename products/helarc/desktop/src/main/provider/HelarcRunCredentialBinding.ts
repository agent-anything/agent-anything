import {validCredentialRef,type ProviderCredentialRef} from "./ProviderCredentialStore.js";

export type HelarcRunCredentialBinding =
  | {readonly kind:"none"}
  | {readonly kind:"saved";readonly ref:ProviderCredentialRef}
  | {readonly kind:"environment";readonly name:"HELARC_PROVIDER_API_KEY"};

export function validHelarcRunCredentialBinding(value:unknown,profileId:string):value is HelarcRunCredentialBinding {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>,keys=Object.keys(v).sort().join();
  if(v.kind==="none")return keys==="kind";
  if(v.kind==="environment")return keys==="kind,name"&&profileId==="env-provider"&&v.name==="HELARC_PROVIDER_API_KEY";
  return v.kind==="saved"&&keys==="kind,ref"&&validCredentialRef(v.ref,profileId);
}
