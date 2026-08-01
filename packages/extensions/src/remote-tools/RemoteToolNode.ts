import type { Metadata } from "@agent-anything/foundation";

export interface RemoteToolNode {
  id: string;
  name: string;
  capabilities: string[];
  metadata: Metadata;
}
