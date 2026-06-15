import type { Metadata } from "@agent-anything/shared";

export type WorkspaceTrustState = "trusted" | "restricted" | "unknown";

export interface WorkspaceContext {
  id: string;
  name: string;
  rootRef: string | null;
  trustState: WorkspaceTrustState;
  source: string;
  policyRefs: string[];
  metadata: Metadata;
}
