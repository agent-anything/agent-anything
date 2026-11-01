import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort} from "./ActivityHandoff.js";
import type {ActivityReconsiderationSnapshot,ActivityReconsiderationState,ActivityReconsiderationSubscription,ActivityPublishedFact} from "./ActivityReconsideration.js";
import type {SharedAcceptancePort,SharedAcceptancePart,SharedAcceptanceReceipt} from "./SharedAcceptance.js";

export interface ActivityReconsiderationPreparation {
  /** Stable owner-issued identity when a participant must reference the common acceptance. */
  readonly acceptanceId?:string;
  readonly decision:ActivityPublishedFact["ref"];
  readonly participants:readonly SharedAcceptancePart[];
  readonly close:boolean;
  readonly observeSources?:readonly string[];
  /** The owner may retain a known limitation; stale state is reread, not recursively retried. */
  readonly rejected?:(receipt:SharedAcceptanceReceipt)=>Promise<ActivityReconsiderationPreparation|null>;
}

export interface ActivityReconsiderationHandler {
  /** Bounded professional calculation over retained facts; external work is returned as a handoff. */
  prepare(snapshot:ActivityReconsiderationSnapshot,signal:AbortSignal):Promise<ActivityReconsiderationPreparation>;
}
export interface ActivityReconsiderationCycle {
  readonly accepted:readonly string[];
  readonly rejected:readonly {subscriptionId:string;code:string}[];
  readonly failures:readonly {subscriptionId:string;error:unknown}[];
}

/** Delivers finite B to its original owner; it never interprets the facts or chooses the professional policy. */
export class ActivityReconsiderationProcessor {
  private readonly cursors=new Map<string,string>();
  constructor(private readonly activities:ActivityHandoffPort,private readonly acceptance:SharedAcceptancePort,
    private readonly handler:(owner:string,subscription:ActivityReconsiderationSubscription)=>ActivityReconsiderationHandler|null) {}

  async scan(runId:string,signal:AbortSignal):Promise<ActivityReconsiderationCycle> {
    const accepted:string[]=[],rejected:{subscriptionId:string;code:string}[]=[],failures:{subscriptionId:string;error:unknown}[]=[];
    let afterId:string|null=this.cursors.get(runId)??null;
    {
      signal.throwIfAborted();
      let page=await this.activities.command({kind:"pending_reconsiderations",runId,afterId,limit:64}) as readonly ActivityReconsiderationState[];
      if(!page.length&&afterId!==null)page=await this.activities.command({kind:"pending_reconsiderations",runId,afterId:null,limit:64}) as readonly ActivityReconsiderationState[];
      const last=page.at(-1)?.subscription.id;
      if(last)this.cursors.set(runId,last);else this.cursors.delete(runId);
      for(const state of page) {
        if(signal.aborted)break;
        const subscription=state.subscription;
        try {
          const handler=this.handler(subscription.owner,subscription);
          if(!handler)continue;
          const snapshot=await this.activities.command({kind:"read_reconsideration",subscriptionId:subscription.id,limit:64}) as ActivityReconsiderationSnapshot;
          if(snapshot.state.closed||!snapshot.facts.length)continue;
          let proposed=await handler.prepare(snapshot,signal);
          signal.throwIfAborted();
          for(let attempt=0;attempt<2;attempt++) {
            if(proposed.decision.owner!==subscription.owner)throw new TypeError("activity_reconsideration_decision_owner_invalid");
            const basis={subscriptionId:subscription.id,expectedRevision:snapshot.state.revision,through:snapshot.through,factIds:snapshot.facts.map(f=>f.id),decision:proposed.decision,close:proposed.close,
              ...(proposed.observeSources?{observeSources:proposed.observeSources}:{})};
            const id=proposed.acceptanceId??`reconsideration-acceptance:${modelInputValueDigest({basis,participants:proposed.participants})}`;
            // The shared boundary checks the original digest even when this identity already exists.
            const receipt=await this.acceptance.accept({id,scope:runId,actor:subscription.owner,
              parts:[...proposed.participants,{owner:"activity",kind:"reconsideration_acceptance",proposal:{id,...basis}}]});
            if(receipt.outcome==="accepted") {accepted.push(subscription.id);break;}
            rejected.push({subscriptionId:subscription.id,code:receipt.rejection!.code});
            const limited=attempt===0?await proposed.rejected?.(receipt):null;
            if(!limited)break;
            signal.throwIfAborted();proposed=limited;
          }
        } catch(error) {
          if(signal.aborted&&error===signal.reason)break;
          failures.push({subscriptionId:subscription.id,error});
        }
      }
    }
    return {accepted,rejected,failures};
  }
}
