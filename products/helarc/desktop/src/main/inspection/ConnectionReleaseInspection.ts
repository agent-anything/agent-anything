import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import {readProtocolContent,type ProtocolConnectionRelease,type ProtocolExecutionJournal,type ProtocolExecutionState} from "@agent-anything/agent-runtime/model-access";
import type {InspectionRecorder} from "@agent-anything/inspection/recording";
import {helarcConnectionActivityId} from "../provider/HelarcConnectionCustodyEvidence.js";
import type {ProviderDependencyPin} from "../provider/ProviderRegistryProtocol.js";

export interface InspectedReleaseBasis {runId:string;activityId:string;release:ProtocolConnectionRelease}
export function releaseBasisSubject(r:Pick<InspectionRecorder,"ref">,basis:InspectedReleaseBasis){
  return r.ref("connection-release","contribution",modelInputValueDigest(basis),basis.runId);
}
/** Historical diagnostic join only. Never reconcile a pin or resolve a credential here. */
export function connectionReleaseReader(journal:ProtocolExecutionJournal,readPin:(id:string)=>Promise<ProviderDependencyPin|null>){
  return async(id:string):Promise<InspectedReleaseBasis|null>=>{
    const pin=await readPin(id);
    if(!pin||pin.id!==id||pin.state!=="released")throw new Error("release_pin_unavailable");
    const activityId=helarcConnectionActivityId(pin);if(!activityId)return null;
    const state=await journal.command({kind:"state",activityId}) as ProtocolExecutionState|null;
    if(!state?.connectionRelease)return null; // Other retirement paths do not claim this basis.
    const {activity,connectionRelease:release}=state,c=activity.composition.composition;
    if(activity.scope.activityId!==activityId||release.observation.limitation.activityId!==activityId||
      c.adapter.implementation.id!==pin.owner||activity.scope.purpose.id!==pin.purpose||
      c.configuration.connectionBinding.id!==pin.bindingId||release.bindingId!==pin.bindingId)throw new Error("release_scope_changed");
    const original=JSON.parse((await readProtocolContent(journal,state.input,activityId,32*1024*1024)).toString());
    const frozen=original.responsesTransport?.connection;
    if(original.format!=="helarc.native-prepared-task.v1"||original.responsesTransport?.protocol!=="openai.responses"||
      frozen?.kind!=="connection"||frozen.pinId!==id||frozen.acceptanceId!==pin.acceptanceId||frozen.bindingId!==pin.bindingId)
      throw new Error("release_original_changed");
    return {runId:activity.scope.runId,activityId,release};
  };
}
