import type { Metadata } from "../shared/types.js";

export interface RemoteToolNode {
  id: string;
  name: string;
  capabilities: string[];
  metadata: Metadata;
}
