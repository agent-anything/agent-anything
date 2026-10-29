import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ActivityHandoffPort} from "./ActivityHandoff.js";
import type {ActivityReconsiderationSnapshot,ActivityReconsiderationState,ActivityReconsiderationSubscription,ActivityPublishedFact} from "./ActivityReconsideration.js";
import type {SharedAcceptancePort,SharedAcceptancePart,SharedAcceptanceReceipt} from "./SharedAcceptance.js";

export interface ActivityReconsiderationPreparation {
  readonly decision:ActivityPublishedFact["ref"];
  readonly participants:readonly SharedAcceptancePart[];
  readonly close:boolean;
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
  constructor(private readonly activities:ActivityHandoffPort,private readonly acceptance:SharedAcceptancePort,
    private readonly handler:(owner:string,subscription:ActivityReconsiderationSubscription)=>ActivityReconsiderationHandler|null) {}

  async scan(runId:string,signal:AbortSignal):Promise<ActivityReconsiderationCycle> {
    const accepted:string[]=[],rejected:{subscriptionId:string;code:string}[]=[],failures:{subscriptionId:string;error:unknown}[]=[];
    for(let afterId:string|null=null;;) {
      signal.throwIfAborted();
      const page=await this.activities.command({kind:"pending_reconsiderations",runId,afterId,limit:64}) as readonly ActivityReconsiderationState[];
      for(const state of page) {
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
            const basis={subscriptionId:subscription.id,expectedRevision:snapshot.state.revision,through:snapshot.through,factIds:snapshot.facts.map(f=>f.id),decision:proposed.decision,close:proposed.close};
            const id=`reconsideration-acceptance:${modelInputValueDigest({basis,participants:proposed.participants})}`;
            const previous=await this.acceptance.query(id);
            const receipt=previous??await this.acceptance.accept({id,scope:runId,actor:subscription.owner,
              parts:[{owner:"activity",kind:"reconsideration_acceptance",proposal:{id,...basis}},...proposed.participants]});
            if(receipt.outcome==="accepted") {accepted.push(subscription.id);break;}
            rejected.push({subscriptionId:subscription.id,code:receipt.rejection!.code});
            const limited=attempt===0?await proposed.rejected?.(receipt):null;
            if(!limited)break;
            signal.throwIfAborted();proposed=limited;
          }
        } catch(error) {failures.push({subscriptionId:subscription.id,error});}
      }
      if(page.length<64)break;afterId=page.at(-1)!.subscription.id;
    }
    return {accepted,rejected,failures};
  }
}
