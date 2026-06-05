import type { ISODateTimeString } from "../shared/types.js";

export type PermissionDecisionStatus = "allowed" | "denied";

export interface PermissionDecision {
  requestId: string;
  status: PermissionDecisionStatus;
  reason: string;
  decidedAt: ISODateTimeString;
}
