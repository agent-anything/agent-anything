import type { Metadata } from "@agent-anything/shared";

export type ApprovalsReviewer = "user" | "auto_review";

export interface GranularApprovalPolicy {
  readonly sandboxApproval: boolean;
  readonly rules: boolean;
  readonly mcpElicitations: boolean;
  readonly requestPermissions: boolean;
  readonly skillApproval: boolean;
}

export type ApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | { readonly granular: GranularApprovalPolicy };

export interface ApprovalReviewerDescriptor {
  readonly id: string;
  readonly kind: ApprovalsReviewer;
  readonly displayName: string;
  readonly source: string;
  readonly metadata: Readonly<Metadata>;
}
