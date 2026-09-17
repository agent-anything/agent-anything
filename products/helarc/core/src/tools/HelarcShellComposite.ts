import type {CompositeOperationResolverPort} from "@agent-anything/agent-runtime/runner";
import {snapshotCompositeDefinition} from "@agent-anything/operation-composition/definition";
import {HELARC_SHELL_COMPOSITE,HELARC_PROCESS_START_OPERATION,HELARC_INITIAL_OBSERVATION_OPERATION} from "./HelarcCommandIdentity.js";

export function createHelarcShellComposite():CompositeOperationResolverPort {
  const definition=snapshotCompositeDefinition({ref:{id:HELARC_SHELL_COMPOSITE,revision:"1"},inputSchemaRevision:"1",resultSchemaRevision:"1",graphRevision:"1",
    nodes:[{id:"start",operation:HELARC_PROCESS_START_OPERATION,allowedBindings:["direct"],dependencies:[],transformId:"start",conditionId:null,resourceClaims:[],required:true},
      {id:"observe",operation:HELARC_INITIAL_OBSERVATION_OPERATION,allowedBindings:["internal"],dependencies:[{nodeId:"start",requirement:"succeeded"}],transformId:"observe",conditionId:null,resourceClaims:[],required:true}],
    join:{kind:"all_required_succeeded"},reducerId:"shell-result",conflictPolicyRevision:"sequential.v1",limits:{maxNodes:2,maxParallel:1},
    cancellationPolicy:"cancel_unstarted_and_signal_active",sensitivity:"sensitive",retiredAt:null});
  return {resolve(ref) {
    if(ref!==HELARC_SHELL_COMPOSITE)return null;
    return {definition,execution:{conditions:[],conflicts:null,transforms:[
      {id:"start",transform:({compositeInput})=>compositeInput},
      {id:"observe",transform({compositeInput,dependencies}) {
        const start=dependencies.start?.result?.output;
        if(!record(start)||typeof start.task_id!=="string"||!record(compositeInput))throw new TypeError("Process start receipt is invalid.");
        return {task_id:start.task_id,wait_ms:compositeInput.run_in_background===true ? 0:compositeInput.wait_ms??10_000};
      }},
    ],reducer:{id:"shell-result",reduce({children}) {
      const result=children.find(child=>child.nodeId==="observe")?.result?.output;
      if(!record(result)||!record(result.observation))throw new TypeError("Initial process observation is unavailable.");
      if(record(result.commandFailure))return {status:"failed",output:null,failure:{code:String(result.commandFailure.code),message:String(result.commandFailure.message),retryable:false,metadata:{processObservation:result.observation}}};
      return {status:"succeeded",output:result.observation,failure:null};
    }}}};
  }};
}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value);}
