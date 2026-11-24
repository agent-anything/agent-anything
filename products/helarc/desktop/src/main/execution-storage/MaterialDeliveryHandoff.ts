import type {MaterialDeliveryJournal,MaterialCustodyPort,MaterialDeliveryTransferReceipt,MaterialDeliveryState,
  MaterialDeliveryGuard,MaterialDispositionRef,MaterialDeliveryDispositionAcceptance} from "@agent-anything/context/custody";
import type {SharedAcceptancePort} from "@agent-anything/agent-runtime/activity";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";

interface Store {readonly materialDeliveries:MaterialDeliveryJournal;readonly materialCustody:MaterialCustodyPort;readonly sharedAcceptance:SharedAcceptancePort;}
/** Trusted Host reads the receiver's durable receipt. Callers cannot submit an unverified receipt. */
export async function completeMaterialDeliveryHandoff(source:Store,receiver:Store,id:string,request:MaterialDispositionRef):Promise<MaterialDeliveryDispositionAcceptance> {
  const receipt=await receiver.materialDeliveries.query({kind:"transfer",id}) as MaterialDeliveryTransferReceipt|null;
  if(!receipt||receipt.id!==id||receipt.sourceStore!==await source.materialDeliveries.query({kind:"store_identity"})||
    receipt.receiverStore!==await receiver.materialDeliveries.query({kind:"store_identity"}))throw new Error("material_handoff_store_mismatch");
  let result=await source.materialDeliveries.query({kind:"accepted",ref:request}) as MaterialDeliveryDispositionAcceptance|null;
  if(result){
    if(result.disposition.kind!=="transferred"||modelInputValueDigest(result.disposition.successor)!==modelInputValueDigest(receipt.successor)||
      modelInputValueDigest(result.disposition.obligation)!==modelInputValueDigest(receipt.source.ref))throw new Error("material_handoff_original_request_conflict");
  } else {
    const successor=await receiver.materialDeliveries.query({kind:"obligation",ref:receipt.successor.ref}) as MaterialDeliveryState|null;
    if(!successor||successor.inboundHandoff!==id||successor.handoffAcknowledged||successor.discharged.length||
      modelInputValueDigest(successor.obligation)!==modelInputValueDigest(receipt.successor)||
      modelInputValueDigest(successor.accepted)!==modelInputValueDigest(receipt.accepted))throw new Error("material_handoff_receiver_not_protected");
    await receiver.materialCustody.command({kind:"describe",holdId:receipt.successor.holdId,recipient:receipt.successor.recipient});
    const imported=await source.sharedAcceptance.accept({id:`${id}:import`,scope:receipt.source.recipient.runId,actor:"material-transfer-host",
      parts:[{owner:"material_delivery",kind:"import_transfer",proposal:receipt}]});
    if(imported.outcome!=="accepted")throw new Error(imported.rejection?.code??"material_handoff_import_rejected");
    const guard=await source.materialDeliveries.query({kind:"guard",ref:receipt.source.ref}) as MaterialDeliveryGuard;
    const accepted=await source.sharedAcceptance.accept({id:request.id,scope:receipt.source.recipient.runId,actor:receipt.source.contract.owner,
      parts:[{owner:"material_delivery",kind:"disposition",proposal:{ref:request,expectedObligation:receipt.source,expectedSelectionRevision:guard.revision,
        disposition:{kind:"transferred",obligation:receipt.source.ref,contract:receipt.source.contract.ref,acceptance:receipt.accepted,range:receipt.successor.range,successor:receipt.successor}}}]});
    if(accepted.outcome!=="accepted")throw new Error(accepted.rejection?.code??"material_handoff_source_rejected");
    result=await source.materialDeliveries.query({kind:"accepted",ref:request}) as MaterialDeliveryDispositionAcceptance;
  }
  const acknowledged=await receiver.sharedAcceptance.accept({id:`${id}:acknowledge`,scope:receipt.successor.recipient.runId,actor:"material-transfer-host",
    parts:[{owner:"material_delivery",kind:"acknowledge_transfer",proposal:{id,sourceAcceptance:result.accepted}}]});
  if(acknowledged.outcome!=="accepted")throw new Error(acknowledged.rejection?.code??"material_handoff_acknowledgement_rejected");
  return result;
}
