import type { Metadata } from "@agent-anything/shared";

export interface RemoteToolNode {
  id: string;
  name: string;
  capabilities: string[];
  metadata: Metadata;
}
