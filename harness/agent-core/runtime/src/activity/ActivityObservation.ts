import type {ActivityHandoffPort} from "./ActivityHandoff.js";
import {activityToken} from "./ActivityPurpose.js";
import type {ActivityPathState, ActivityStageState, ActivityInputNeed} from "./ActivityHandoff.js";

/** One bounded read, not an acceptance or a grant. Bodies are absent in observations. */
export interface ActivityReadScope {
  readonly pathId:string;
  readonly requestIds:readonly string[];
  /** Include the supplied/unavailable stage references declared by these needs. */
  readonly inputNeedIds:readonly string[];
}
export interface ActivityControlReceipt {readonly kind:"activity_control";readonly pathId:string;readonly runId:string;readonly controlRevision:number;readonly cancelled:boolean;}
export interface ActivitySnapshot {
  readonly path:ActivityPathState|null;
  readonly stages:readonly (ActivityStageState|null)[];
  readonly inputNeeds:readonly (ActivityInputNeed|null)[];
}
export interface ActivityStateObservation {
  readonly path:Omit<ActivityPathState,"progress">|null;
  readonly stages:readonly ({readonly requestId:string;readonly pathId:string;readonly requestDigest:string;
    readonly status:ActivityStageState["status"]}|null)[];
  readonly inputNeeds:readonly (ActivityInputNeed|null)[];
}

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
