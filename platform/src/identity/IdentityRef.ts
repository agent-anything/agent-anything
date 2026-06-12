import type { Metadata } from "../shared/types.js";

export type IdentityKind = "user" | "service" | "anonymous";

export interface IdentityRef {
  id: string;
  kind: IdentityKind;
  displayName: string;
  metadata: Metadata;
}
