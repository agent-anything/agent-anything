export type ProviderCompactionPermission = "accepted" | "unassessed" | "excluded";
export type ProviderCompactionContent = "text" | "function_calls" | "reasoning" | "compaction" | "images" | "files" | "remote_tools";
export interface ProviderCompactionUseProfile {
  readonly id:string;
  readonly content:readonly ProviderCompactionContent[];
  readonly transports:readonly ("http"|"websocket")[];
  readonly continuities:readonly ("replay"|"stored-response"|"connection-memory")[];
  readonly background:boolean;
  readonly preservation:Readonly<Record<"goals_and_constraints"|"sources_and_authority"|"execution_and_pending_work"|"references_and_changes"|"uncertainty_and_disagreement"|"details_and_discoverability",ProviderCompactionPermission>>;
  readonly repeated:ProviderCompactionPermission;
  readonly specialRequirements:readonly {readonly id:string;readonly revision:string}[];
  readonly limitations:readonly string[];
}
/** Serializable settings data. The Host validates the policy before it is accepted. */
export interface ProviderCompactionPolicy {
  readonly revision:"1";
  readonly target:string;
  readonly origin:"provider_documentation"|"external_evaluation"|"unassessed";
  readonly basis:string;
  readonly reviewedAt:string;
  readonly support:ProviderCompactionPermission;
  readonly profiles:readonly ProviderCompactionUseProfile[];
  readonly trigger:{readonly windowTokens:number|null;readonly thresholdTokens:number|null;readonly basis:string};
}
