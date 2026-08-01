import {
  assertMetadata,
  assertNonEmpty,
  assertRecord,
  snapshotMetadata,
} from "../internal/validation.js";
import type { Metadata } from "../primitives/index.js";

export type IdentityKind = "user" | "service" | "anonymous";

export interface IdentityRef {
  readonly id: string;
  readonly kind: IdentityKind;
  readonly displayName: string;
  readonly metadata: Metadata;
}

export function snapshotIdentityRef(identity: IdentityRef): IdentityRef {
  assertRecord(identity, "IdentityRef");
  assertNonEmpty(identity.id, "IdentityRef.id");
  if (
    identity.kind !== "user" &&
    identity.kind !== "service" &&
    identity.kind !== "anonymous"
  ) {
    throw new TypeError("IdentityRef.kind is unsupported.");
  }
  assertNonEmpty(identity.displayName, "IdentityRef.displayName");
  assertMetadata(identity.metadata, "IdentityRef.metadata");

  return Object.freeze({
    id: identity.id,
    kind: identity.kind,
    displayName: identity.displayName,
    metadata: snapshotMetadata(identity.metadata),
  });
}
