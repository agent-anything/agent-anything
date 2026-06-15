import type { ArtifactRef, ISODateTimeString, Metadata } from "@agent-anything/shared";

export type RetentionPolicyRef = string;
export type AccessPolicyRef = string;

export interface EnterpriseStoredArtifact {
  id: string;
  kind: string;
  ref: ArtifactRef;
  workspaceId: string;
  retentionPolicyRef: RetentionPolicyRef;
  accessPolicyRef: AccessPolicyRef;
  auditRef: string | null;
  createdAt: ISODateTimeString;
  metadata: Metadata;
}

export interface StoreEnterpriseArtifactInput {
  kind: string;
  ref: ArtifactRef;
  workspaceId: string;
  retentionPolicyRef: RetentionPolicyRef;
  accessPolicyRef: AccessPolicyRef;
  auditRef?: string | null;
  metadata: Metadata;
}
