import type {ActivityPurposeRef} from "./ActivityPurpose.js";
import type {ActivityStageState} from "./ActivityHandoff.js";
import type {ActivitySchedulingIntent,ActivityServiceClass} from "./ActivityScheduling.js";

/** Bounded read-only facts for presentation, never an admission or execution decision. */
export interface ActivityWorkView {
  readonly scopeId:string;
  readonly revision:number;
  readonly hasMore:boolean;
  readonly items:readonly {
    readonly workId:string;readonly runId:string;readonly pathId:string|null;readonly purpose:ActivityPurposeRef|null;readonly owner:string;
    readonly reason:ActivitySchedulingIntent["reason"];readonly service:ActivityServiceClass;
    readonly cancelled:boolean;readonly closed:boolean;readonly pathsSealed:boolean;readonly settlementConfirmed:boolean;
    readonly pendingInputs:number;readonly updatedAt:string;readonly hasMoreStages:boolean;
    readonly stages:readonly {
      readonly requestId:string;readonly status:ActivityStageState["status"];readonly capabilities:readonly string[];
      readonly dispatchRestriction:NonNullable<ActivityStageState["dispatchRestriction"]>|null;
      readonly authorizationRestrictions:NonNullable<ActivityStageState["authorizationRestrictions"]>;
      readonly schedulingWait:"resource_occupied"|"service_turn"|null;
    }[];
  }[];
}
