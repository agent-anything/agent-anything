import type { Metadata } from "@agent-anything/shared";

export type IdentityKind = "user" | "service" | "anonymous";

export interface IdentityRef {
  id: string;
  kind: IdentityKind;
  displayName: string;
  metadata: Metadata;
}
