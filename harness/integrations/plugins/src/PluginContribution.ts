import type { Metadata } from "@agent-anything/foundation";

export type PluginContributionKind = "tool" | "mcpServer" | "policy";

export interface PluginContribution {
  kind: PluginContributionKind;
  id: string;
  metadata: Metadata;
}
