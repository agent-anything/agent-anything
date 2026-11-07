import type {ActivityHandoffPort} from "./ActivityHandoff.js";
import {activityToken} from "./ActivityPurpose.js";

/** A discovery hint, never an acceptance, dispatch or content-integrity proof. */
export interface ActivityPathObservation {
  readonly pathId:string;
  readonly runId:string;
  readonly changeRevision:number;
  readonly controlRevision:number;
  readonly progressRevision:number;
  readonly cancelled:boolean;
}
export interface ActivityChangeInterest {readonly pathIds:readonly string[];}

/** Local waiting state is deliberately discarded on recovery. */
export class ActivityObservationCursor {
  private previous:string|null=null;
  constructor(private readonly port:ActivityHandoffPort,private readonly pathIds:readonly string[]) {
    if(!pathIds.length||pathIds.length>64||new Set(pathIds).size!==pathIds.length)throw new TypeError("activity_observation_scope_invalid");
    pathIds.forEach(activityToken);
    this.pathIds=Object.freeze([...pathIds]);
  }
  async changed():Promise<boolean> {
    const heads=await this.port.command({kind:"observe_paths",pathIds:this.pathIds}) as readonly (ActivityPathObservation|null)[];
    if(!Array.isArray(heads)||heads.length!==this.pathIds.length||heads.some((head,index)=>head!==null&&
      (head.pathId!==this.pathIds[index]||!head.runId||typeof head.cancelled!=="boolean"||
        [head.changeRevision,head.controlRevision,head.progressRevision].some(value=>!Number.isSafeInteger(value)||value<0))))
      throw new TypeError("activity_observation_invalid");
    const signature=JSON.stringify(heads);
    const changed=signature!==this.previous;
    this.previous=signature;
    return changed;
  }
}
