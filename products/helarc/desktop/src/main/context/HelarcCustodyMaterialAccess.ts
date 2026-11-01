import {CustodyMaterialAccess,type MaterialCustodyPort,type MaterialRecipient} from "@agent-anything/context/custody";
import type {ContextMaterialAccessPort} from "@agent-anything/context/material";

/** Recipient resolution is Host-owned; arguments and references never select authority. */
export function createHelarcCustodyMaterialAccess(materials:MaterialCustodyPort,recipient:(runId:string)=>Promise<MaterialRecipient>):ContextMaterialAccessPort {
  const access=async(runId:string)=>{
    const resolved=await recipient(runId);
    if(resolved.runId!==runId)throw new TypeError("material_recipient_run_mismatch");
    return new CustodyMaterialAccess(materials,resolved);
  };
  return {
    validate:async(runId,...args)=>(await access(runId)).validate(runId,...args),
    read:async(runId,...args)=>(await access(runId)).read(runId,...args),
    search:async(runId,...args)=>(await access(runId)).search(runId,...args),
  };
}
