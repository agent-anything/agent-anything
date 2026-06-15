import type { Metadata } from "@agent-anything/shared";
import type { PluginContribution } from "./PluginContribution.js";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  contributions: PluginContribution[];
  metadata: Metadata;
}
