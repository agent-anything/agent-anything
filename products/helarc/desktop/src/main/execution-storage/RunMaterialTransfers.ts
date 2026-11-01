import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {HELARC_CONTROLLER_CAPABILITY} from "@agent-anything/helarc/controller";
import {ContextMaterialError,snapshotContextMaterialRefs} from "@agent-anything/context/material";
import type {MaterialAccessDescription,MaterialRecipient,MaterialReferencePage} from "@agent-anything/context/custody";
import type {RunCommit} from "@agent-anything/agent-runtime/execution-coordinator";
import type {MaterialCustodyDatabase} from "./MaterialCustodyDatabase.js";
import type {ContextMaterialDatabase,ContextMaterialTransfer} from "./ContextMaterialDatabase.js";
import type {SharedAcceptanceDatabase} from "./SharedAcceptanceDatabase.js";

/** Called only within the validated Run commit transaction, never by model arguments alone. */
export class RunMaterialTransfers {
  constructor(private readonly legacy:ContextMaterialDatabase,private readonly custody:MaterialCustodyDatabase,
    private readonly acceptance:SharedAcceptanceDatabase,private readonly head:(runId:string)=>RunCommit|null) {}

  accept(transfer:ContextMaterialTransfer):void {
    const references=snapshotContextMaterialRefs(transfer.references);
    const retained=references.filter(ref=>!ref.id.startsWith("custody:"));
    if(retained.length)this.legacy.accept({...transfer,references:retained});
    const managed=references.filter(ref=>ref.id.startsWith("custody:"));
    if(!managed.length)return;
    const source=this.recipient(transfer.sourceRunId),recipient=this.recipient(transfer.recipientRunId);
    for(const reference of managed) {
      const description=this.custody.command({kind:"resolve_reference",reference,recipient:source}) as MaterialAccessDescription;
      const id=`${transfer.id}:custody:${modelInputValueDigest(reference)}`,basis=`${transfer.basis.kind}:${transfer.basis.id}`;
      const receipt=this.acceptance.accept({id,scope:recipient.runId,actor:"helarc.material-transfer",parts:[{
        owner:"material_custody",kind:"admit_access",proposal:{
          source:{id:`${id}:source`,holdId:description.hold.id,recipient:source,range:description.hold.range},
          hold:{id:`${id}:hold`,instanceId:description.hold.instanceId,consumer:recipient,responsibility:"detail",range:description.hold.range,
            basis,releaseCondition:"Explicit recipient detail retention release"},
          grant:{id:`${id}:grant`,instanceId:description.hold.instanceId,recipient,range:description.hold.range,revision:0,allowed:true,basis},
        }}]});
      if(receipt.outcome!=="accepted")throw new ContextMaterialError(receipt.rejection?.code??"material_transfer_unaccepted",id);
    }
  }

  inherit(input:Omit<ContextMaterialTransfer,"references">):void {
    let after:string|null=null,page=0;
    for(;;) {
      const references=this.legacy.inheritedReferences(input.sourceRunId,after);
      if(!references.length)break;
      this.accept({...input,id:`${input.id}:legacy:${page++}`,references});after=references.at(-1)!.id;
    }
    const recipient=this.recipient(input.sourceRunId);after=null;page=0;
    do {
      const current=this.custody.command({kind:"list_references",recipient,after,limit:16}) as MaterialReferencePage;
      if(current.nextAfter!==null&&current.nextAfter<=(after??""))throw new TypeError("material_reference_page_invalid");
      if(current.references.length)this.accept({...input,id:`${input.id}:custody:${page++}`,references:current.references});
      after=current.nextAfter;
    }while(after!==null);
  }

  private recipient(runId:string):MaterialRecipient {
    const head=this.head(runId);if(!head||head.state.run.id!==runId)throw new ContextMaterialError("material_recipient_unavailable",runId);
    return {runId,recipient:head.state.activeAgent.id,purpose:HELARC_CONTROLLER_CAPABILITY};
  }
}
