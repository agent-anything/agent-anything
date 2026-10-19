import type {CompositeOperationResolverPort} from "@agent-anything/agent-runtime/runner";
import {snapshotCompositeDefinition} from "@agent-anything/operation-composition/definition";
import {HELARC_SHELL_COMPOSITE,HELARC_PROCESS_START_OPERATION,HELARC_INITIAL_OBSERVATION_OPERATION} from "./HelarcCommandIdentity.js";

export function createHelarcShellComposite(defaultWaitMs: number):CompositeOperationResolverPort {
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
        return {task_id:start.task_id,wait_ms:compositeInput.run_in_background===true ? 0:compositeInput.wait_ms??defaultWaitMs};
      }},
    ],reducer:{id:"shell-result",reduce({children,aggregateStatus,aggregateFailure}) {
      const observed=children.find(child=>child.nodeId==="observe");
      const started=children.find(child=>child.nodeId==="start");
      const receipt=started?.result?.output;
      const result=observed?.result?.output;
      if(record(result)&&record(result.observation)) {
        const output = {...result.observation, ...(record(receipt) && record(receipt.execution_descriptor) ? {execution_descriptor: receipt.execution_descriptor} : {})};
        if(aggregateStatus!=="succeeded")return {status:aggregateStatus,output,failure:aggregateFailure!};
        if(record(result.commandFailure))return {status:"failed",output,failure:{code:String(result.commandFailure.code),message:String(result.commandFailure.message),retryable:false,metadata:{}}};
        return {status:"succeeded",output,failure:null};
      }
      const output=record(receipt)&&typeof receipt.task_id==="string" ? {
        task_id:receipt.task_id,run_id:receipt.run_id,observation:null,
        ...(record(receipt.snapshot) ? {snapshot: receipt.snapshot} : {}),
        ...(record(receipt.execution_descriptor) ? {execution_descriptor: receipt.execution_descriptor} : {}),
        outcome:null,limitations:["initial_observation_unavailable"],
      }:null;
      const failure=(started?.status!=="succeeded"?started?.failure:null)??observed?.failure??aggregateFailure??{
        code:"initial_observation_unavailable",message:"The initial process observation is unavailable.",retryable:false,metadata:{},
      };
      return {status:aggregateStatus==="cancelled"||aggregateStatus==="unknown_effect"?aggregateStatus:"failed",output,failure};
    }}}};
  }};
}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value);}
