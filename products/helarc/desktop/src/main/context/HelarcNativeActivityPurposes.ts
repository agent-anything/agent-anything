import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {ActivityPurposeRegistry,type ActivityPurposeBinding,type ActivityPurposeContract} from "@agent-anything/agent-runtime/activity";
import {REPRESENTATION_METHOD_PURPOSE,SOURCE_MATERIAL_PUBLICATION_PURPOSE} from "@agent-anything/agent-runtime/context-representation";
import {PROTOCOL_OBSERVATION_PURPOSE} from "@agent-anything/agent-runtime/model-access";
import {HELARC_NATIVE_INPUT_DEMAND_PURPOSE,HELARC_NATIVE_ORIGINAL_INPUT_PURPOSE,HELARC_NATIVE_ACCOUNT_RECEPTION_PURPOSE,
  HELARC_NATIVE_RESULT_RECEPTION_PURPOSE,HELARC_RESPONSES_COMPACT_PURPOSE,HELARC_RESPONSES_COMPACT_RECEPTION_PURPOSE,
  HELARC_NATIVE_MEASURED_ORIGINAL_INPUT_PURPOSE,HELARC_NATIVE_MEASURED_ACCOUNT_RECEPTION_PURPOSE,
  HELARC_NATIVE_MEASURED_RESULT_RECEPTION_PURPOSE,HELARC_RESPONSES_MEASURED_COMPACT_RECEPTION_PURPOSE,
  HELARC_RESPONSES_IN_REQUEST_RECEPTION_PURPOSE,HELARC_RESPONSES_MEASURED_IN_REQUEST_RECEPTION_PURPOSE} from "@agent-anything/helarc/controller";
import type {ProviderConfiguration} from "../../shared/ProviderConfiguration.js";
import {HELARC_NATIVE_AUXILIARY_INPUT_PURPOSE} from "./HelarcNativeAuxiliaryInputPreparation.js";

export type NativePurposeInventoryRevision="1"|"2"|"3";
// Order is part of the frozen binding, including the historical v1 and v2 inventories.
const inventory:readonly {since:number;protocol?:"openai.responses";contracts:readonly ActivityPurposeContract[]}[]=[
  {since:1,contracts:[PROTOCOL_OBSERVATION_PURPOSE,REPRESENTATION_METHOD_PURPOSE,SOURCE_MATERIAL_PUBLICATION_PURPOSE,
    HELARC_NATIVE_INPUT_DEMAND_PURPOSE,HELARC_NATIVE_ORIGINAL_INPUT_PURPOSE,HELARC_NATIVE_ACCOUNT_RECEPTION_PURPOSE,HELARC_NATIVE_RESULT_RECEPTION_PURPOSE]},
  {since:1,protocol:"openai.responses",contracts:[HELARC_RESPONSES_COMPACT_PURPOSE,HELARC_RESPONSES_COMPACT_RECEPTION_PURPOSE]},
  {since:2,protocol:"openai.responses",contracts:[HELARC_NATIVE_MEASURED_ORIGINAL_INPUT_PURPOSE,HELARC_NATIVE_MEASURED_ACCOUNT_RECEPTION_PURPOSE,
    HELARC_NATIVE_MEASURED_RESULT_RECEPTION_PURPOSE,HELARC_RESPONSES_MEASURED_COMPACT_RECEPTION_PURPOSE]},
  {since:3,protocol:"openai.responses",contracts:[HELARC_RESPONSES_IN_REQUEST_RECEPTION_PURPOSE,HELARC_RESPONSES_MEASURED_IN_REQUEST_RECEPTION_PURPOSE,HELARC_NATIVE_AUXILIARY_INPUT_PURPOSE]},
];
export const nativeDiscoveryPurposeIds=[...new Set(inventory.flatMap(g=>g.contracts.map(p=>p.ref.id)))];
const supportedContracts=new Set(inventory.flatMap(g=>g.contracts.map(p=>digest(p))));
/** An implementation cannot add undiscoverable work by registering a private contract. */
export class NativeActivityPurposeRegistry<T> extends ActivityPurposeRegistry<T>{
  override register(contract:ActivityPurposeContract,handler:T):ActivityPurposeBinding{
    if(!supportedContracts.has(digest(contract)))throw new TypeError(`native_activity_purpose_not_declared:${contract.ref.id}@${contract.ref.revision}`);
    return super.register(contract,handler);
  }
}
export function nativeActivityPurposes(protocol:ProviderConfiguration["protocol"],revision:NativePurposeInventoryRevision){
  return inventory.filter(g=>(!g.protocol||g.protocol===protocol)&&g.since<=Number(revision)).flatMap(g=>g.contracts);
}
export function frozenNativePurposes(contracts:readonly ActivityPurposeContract[]){
  const digests=new Set(contracts.map(c=>digest(c)));
  return {includes:(c:ActivityPurposeContract)=>digests.has(digest(c)),
    bind<T>(registry:ActivityPurposeRegistry<T>){
      for(const contract of contracts)registry.resolve({contract,digest:digest(contract)});
      return {resolve:(binding:ActivityPurposeBinding)=>{
        if(!digests.has(binding.digest))throw new TypeError(`native_activity_purpose_not_in_original_binding:${binding.contract.ref.id}@${binding.contract.ref.revision}`);
        return registry.resolve(binding);
      }};
    }};
}
