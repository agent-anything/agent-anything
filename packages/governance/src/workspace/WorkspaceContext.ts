import type { Metadata } from "@agent-anything/shared";

export interface WorkspaceContext {
  id: string;
  name: string;
  rootRef: string | null;
  policyRefs: string[];
  metadata: Metadata;
}
