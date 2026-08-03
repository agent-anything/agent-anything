import type { Metadata } from "@agent-anything/foundation";
import type { PluginContribution } from "./PluginContribution.js";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  contributions: PluginContribution[];
  metadata: Metadata;
}
