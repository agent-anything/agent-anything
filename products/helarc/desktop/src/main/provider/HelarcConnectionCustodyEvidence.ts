import type {ProtocolExecutionState,ProtocolAdmissionReservation} from "@agent-anything/agent-runtime/model-access";
import type {HelarcExecutionStore} from "../execution-storage/HelarcExecutionStore.js";
import type {ProviderDependencyPin} from "./ProviderRegistryProtocol.js";
import type {ConnectionAcceptanceEvidence} from "./ProviderConnectionRetention.js";

/** Reads acceptance and release facts, without interpreting a protocol or creating an Agent. */
export function helarcConnectionCustodyEvidence(store:HelarcExecutionStore):ConnectionAcceptanceEvidence {
  return {async read(pin){
    if(pin.purpose==="run_tree"){
      const result=await store.resolveAdmission(pin.owner,pin.acceptanceId);
      if(result.status==="closed")return "released";
      if(result.status!=="accepted")return "unknown";
      const original=await store.readProductRun(pin.owner);
      const connection=original?.version===4?original.model.connection:original?.providerCredential;
      if(original?.productRunId!==pin.acceptanceId||connection?.kind!=="connection"||
        connection.pinId!==pin.id||connection.bindingId!==pin.bindingId)throw new TypeError("run_connection_custody_changed");
      const members=await store.readTreeControl(pin.owner);
      // This releases only the tree's ability to start future model work. Each
      // already admitted native activity and follow-up still owns its own pin.
      return members.length&&members.every(member=>member.terminal)?"released":"accepted";
    }
    const activityId=helarcConnectionActivityId(pin);
    if(!activityId)return "unknown";
    const state=await store.protocolJournal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    if(!state){
      const reservation=await store.protocolJournal.command({kind:"admission_reservation",activityId,closeIfInactive:true}) as ProtocolAdmissionReservation|null;
      if(!reservation)return "unknown";
      const original=reservation.activity;
      if(original.composition.composition.adapter.implementation.id!==pin.owner||original.scope.purpose.id!==pin.purpose||
        original.composition.composition.configuration.connectionBinding.id!==pin.bindingId)throw new TypeError("native_connection_reservation_changed");
      return reservation.status==="closed"?"released":"unknown";
    }
    const c=state.activity.composition.composition;
    if(c.adapter.implementation.id!==pin.owner||state.activity.scope.purpose.id!==pin.purpose||
      c.configuration.connectionBinding.id!==pin.bindingId)throw new TypeError("native_connection_custody_changed");
    if(state.connectionRelease&&state.connectionRelease.bindingId!==pin.bindingId)throw new TypeError("native_connection_release_binding_changed");
    return state.retentionReleased||state.connectionRelease?"released":"accepted";
  }};
}

/** The Host's recorded pin format; the located activity must still authenticate every field. */
export function helarcConnectionActivityId(pin:ProviderDependencyPin):string|null {
  if(!pin.acceptanceId.endsWith(":prepare"))return null;
  const id=pin.acceptanceId.slice(0,-":prepare".length);
  return id&&pin.id===`${id}:connection`?id:null;
}
