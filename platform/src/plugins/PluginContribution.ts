import type { Metadata } from "../shared/types.js";

export type PluginContributionKind = "tool" | "mcpServer" | "policy";

export interface PluginContribution {
  kind: PluginContributionKind;
  id: string;
  metadata: Metadata;
}
