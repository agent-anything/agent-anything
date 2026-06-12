import type { Metadata } from "../shared/types.js";

export interface WorkspaceContext {
  id: string;
  name: string;
  rootRef: string | null;
  policyRefs: string[];
  metadata: Metadata;
}
