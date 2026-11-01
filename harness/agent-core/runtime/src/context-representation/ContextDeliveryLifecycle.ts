import type {ContextDeliveryState,ContextSelectionPort,ContextDeliveryFinalization} from "@agent-anything/context/selection";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {activityFactSourceId,type ActivityHandoffPort,type ActivityPublishedFact,type ActivityReconsiderationHandler,type ActivityStageState,
  type ActivityReconsiderationSnapshot,type ActivityReconsiderationPreparation} from "../activity/index.js";
import {contextDeliveryFactSource} from "./ContextDeliveryFacts.js";
import {validateSourceMaterialRequest,type SourceMaterialPublicationRequest} from "./SourceMaterialPublication.js";

/** A published delivery retains its own responsibility after publication work ends. */
export class ContextDeliveryLifecycle implements ActivityReconsiderationHandler {
  constructor(private readonly activities:ActivityHandoffPort,private readonly selections:ContextSelectionPort) {}

  async prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation> {
    signal.throwIfAborted();const sub=snapshot.state.subscription;
    if(sub.binding?.kind!=="activity_path")throw new TypeError("delivery_lifecycle_binding_invalid");
    const original=await this.activities.command({kind:"read_stage",requestId:`${sub.binding.id}:capture`}) as ActivityStageState|null;
    if(!original||original.request.pathId!==sub.binding.id||original.status!=="accepted")throw new TypeError("delivery_lifecycle_publication_missing");
    const request=original.request.input as SourceMaterialPublicationRequest;validateSourceMaterialRequest(request);
    const declared=request.deliveries?.find(delivery=>`${delivery.id}:lifecycle`===sub.id);
    if(!declared)throw new TypeError("delivery_lifecycle_declaration_missing");
    const state=await this.selections.command({kind:"delivery_state",id:declared.id}) as ContextDeliveryState|null;
    const lifetime=state?.delivery.lifetime;
    if(!state||!lifetime||sub.id!==lifetime.subscriptionId||sub.owner!==lifetime.owner||sub.runId!==state.delivery.recipient.runId||
      lifetime.sourcePathId!==sub.binding.id||lifetime.scope.source.runId!==sub.runId||
      digest(lifetime.scope)!==digest(request.deliveryLifetime)||digest(state.delivery.recipient)!==digest(request.recipient))
      throw new TypeError("delivery_lifecycle_original_binding_missing");
    const sources=[contextDeliveryFactSource(state.delivery.recipient).id,lifetime.scope.source.id,activityFactSourceId("control",sub.binding.id)];
    if(state.selectedPathId)sources.push(activityFactSourceId("progress",state.selectedPathId),activityFactSourceId("control",state.selectedPathId));
    let closedFactId:string|null=null;
    const received=state.acceptedResponseId!==null||state.disposition!==null;
    if(!received) {
      const fact=await this.activities.command({kind:"read_fact",id:lifetime.scope.closedFactId}) as ActivityPublishedFact|null;
      if(fact) {
        if(fact.sourceId!==lifetime.scope.source.id||fact.ref.owner!==lifetime.scope.source.owner)
          throw new TypeError("delivery_lifecycle_end_fact_invalid");
        closedFactId=fact.id;
      }
    }
    const close=received||(closedFactId!==null&&state.selectionSettled);
    const proposal:ContextDeliveryFinalization={deliveryId:state.delivery.id,closedFactId,
      expected:{selectedInputId:state.selectedInputId,acceptedResponseId:state.acceptedResponseId,disposition:state.disposition}};
    signal.throwIfAborted();
    return {decision:{owner:sub.owner,kind:close?"delivery_responsibility_closed":"delivery_responsibility_waiting",id:state.delivery.id,
      revision:digest({proposal,selectionSettled:state.selectionSettled})},observeSources:sources,close,
      participants:close?[{owner:"context_delivery",kind:"finalize",proposal}]:[]};
  }
}
