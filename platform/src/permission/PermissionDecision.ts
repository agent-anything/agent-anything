import type { ISODateTimeString, Metadata } from "../shared/types.js";

export type PermissionDecisionStatus = "granted" | "denied";

export type PermissionDecisionCode =
  | "permission_denied"
  | "permission_mode_denied"
  | "permission_unavailable"
  | "permission_prompt_failed"
  | "permission_check_failed";

export interface PermissionDecision {
  requestId: string;
  status: PermissionDecisionStatus;
  code?: PermissionDecisionCode;
  reason: string;
  decidedAt: ISODateTimeString;
  metadata?: Metadata;
}
