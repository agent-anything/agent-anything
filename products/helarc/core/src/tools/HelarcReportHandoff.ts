import type {DelegationResult} from "@agent-anything/agent-runtime/delegation";
import type {ContextMaterialRef} from "@agent-anything/context/material";

/** Publishes the exact retained report with independently authorized Parent access. */
export interface HelarcReportHandoff {
  publish(result:DelegationResult,signal:AbortSignal):Promise<HelarcReportHandoffOutcome>;
}

export type HelarcReportHandoffOutcome =
  | {readonly status:"published";readonly reference:ContextMaterialRef}
  | {readonly status:"unavailable";readonly reason:"report_publication_cancelled"|"report_publication_deadline"|"report_access_denied"};
