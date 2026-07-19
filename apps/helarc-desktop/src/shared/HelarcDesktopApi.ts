export interface HelarcWorkspaceSnapshot {
  id: string;
  name: string;
  path: string;
}

export type HelarcWorkspaceTrustState = "trusted";

export interface HelarcWorkspaceProfileSnapshot {
  id: string;
  displayName: string;
  path: string;
  lastOpenedAt: string;
  trustState: HelarcWorkspaceTrustState;
}

export interface HelarcAcceptedTaskSnapshot {
  id: string;
  prompt: string;
}

export type HelarcTaskTemplateCategory =
  | "inspect"
  | "edit"
  | "test"
  | "refactor";

export interface HelarcTaskTemplateSnapshot {
  id: string;
  title: string;
  description: string;
  promptText: string;
  category: HelarcTaskTemplateCategory;
  defaultConstraints: string[];
}

export interface HelarcMainError {
  code: string;
  message: string;
}

export type HelarcProviderCredentialStatus =
  | "present"
  | "empty_allowed"
  | "missing";

export type HelarcProviderKind =
  | "openai-compatible"
  | "ollama";

export interface HelarcProviderProfileSnapshot {
  id: string;
  providerKind: HelarcProviderKind;
  displayName: string;
  endpointLabel: string;
  baseUrl: string;
  baseUrlOrigin: string;
  model: string;
  timeoutMs: number;
  credentialStatus: HelarcProviderCredentialStatus;
  isActive: boolean;
}

export type HelarcProviderSnapshot =
  | {
      configured: true;
      activeProfile: HelarcProviderProfileSnapshot;
      profiles: HelarcProviderProfileSnapshot[];
      error: null;
    }
  | {
      configured: false;
      activeProfile: null;
      profiles: HelarcProviderProfileSnapshot[];
      error: HelarcMainError;
    };

export type HelarcMainSnapshotStatus =
  | "idle"
  | "workspace_selected"
  | "starting"
  | "running"
  | "cancelling"
  | "waiting_for_approval"
  | "waiting_for_patch_review"
  | "applying_patch"
  | "completed"
  | "rejected"
  | "failed"
  | "blocked"
  | "cancelled";

export interface HelarcAdditionalPermissionsSnapshot {
  readonly fileSystem?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
  readonly network?: {
    readonly enabled: boolean;
    readonly domains?: readonly string[];
  };
}

export type HelarcApprovalDecisionKind =
  | "accept"
  | "acceptForSession"
  | "grantPermissions"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | "decline"
  | "cancel";

export interface HelarcApprovalDecisionOptionSnapshot {
  readonly id: string;
  readonly kind: HelarcApprovalDecisionKind;
  readonly label: string;
  readonly description: string | null;
}

interface HelarcApprovalReviewRequestBase<
  TCategory extends string,
  TPayload,
> {
  readonly id: string;
  readonly runId: string;
  readonly category: TCategory;
  readonly reason: string;
  readonly payload: TPayload;
  readonly decisionOptions: readonly HelarcApprovalDecisionOptionSnapshot[];
}

export type HelarcApprovalReviewRequestSnapshot =
  | HelarcApprovalReviewRequestBase<"commandExecution", {
      readonly commandDisplay: string;
      readonly additionalPermissions: HelarcAdditionalPermissionsSnapshot | null;
    }>
  | HelarcApprovalReviewRequestBase<"fileChange", {
      readonly changes: readonly {
        readonly operation: "create" | "update" | "delete" | "move" | "copy";
        readonly displayPath: string;
      }[];
      readonly additionalPermissions: HelarcAdditionalPermissionsSnapshot | null;
    }>
  | HelarcApprovalReviewRequestBase<"permissions", {
      readonly permissions: HelarcAdditionalPermissionsSnapshot;
    }>
  | HelarcApprovalReviewRequestBase<"mcpToolCall", {
      readonly serverDisplayName: string;
      readonly toolName: string;
    }>
  | HelarcApprovalReviewRequestBase<"skill", {
      readonly skillDisplayName: string;
      readonly action: string;
      readonly requiredPermissions: HelarcAdditionalPermissionsSnapshot | null;
    }>
  | HelarcApprovalReviewRequestBase<"networkAccess", {
      readonly actionSummary: string;
    }>;

export interface HelarcApprovalReviewSnapshot {
  readonly request: HelarcApprovalReviewRequestSnapshot;
  readonly pendingVersion: number;
}

export interface HelarcPendingApprovalSnapshot {
  readonly phase: "reviewing" | "submitted_for_resolution";
  readonly review: HelarcApprovalReviewSnapshot | null;
}

export interface HelarcSubmitApprovalDecisionInput {
  readonly submissionId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly pendingVersion: number;
  readonly optionId: string;
  readonly grantedPermissions: HelarcAdditionalPermissionsSnapshot | null;
  readonly reason: string | null;
}

export type HelarcApprovalSubmissionReceipt =
  | {
      readonly status: "accepted_for_resolution";
      readonly submissionId: string;
      readonly runId: string;
      readonly requestId: string;
      readonly pendingVersion: number;
    }
  | {
      readonly status: "rejected";
      readonly submissionId: string;
      readonly code:
        | "approval_not_pending"
        | "approval_version_mismatch"
        | "approval_already_resolved"
        | "approval_submission_invalid";
    };

export interface HelarcPendingPatchReviewSnapshot {
  readonly runId: string;
  readonly proposalId: string;
  readonly reviewId: string;
  readonly pendingVersion: number;
  readonly phase: "reviewing" | "submitted_for_resolution";
  readonly path: string;
  readonly operation: "create" | "update" | "delete";
  readonly summary: string;
  readonly originalContent: string | null;
  readonly proposedContent: string | null;
}

export type HelarcProductPhaseSnapshot =
  | { readonly kind: "none" }
  | {
      readonly kind: "waiting_for_patch_review";
      readonly review: HelarcPendingPatchReviewSnapshot;
    }
  | {
      readonly kind: "patch_action_submitted";
      readonly runId: string;
      readonly proposalId: string;
      readonly reviewId: string;
      readonly pendingVersion: number;
    };

export interface HelarcRunActivitySnapshot {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface HelarcRunProductResultSnapshot {
  readonly status: "completed" | "rejected" | "failed" | "blocked" | "cancelled";
  readonly output: {
    readonly taskId: string;
    readonly workspaceId: string | null;
    readonly agentSummary: string | null;
    readonly runtimeStatus: "succeeded" | "blocked" | "failed" | "cancelled";
    readonly patchStatus: "proposed" | "applied" | "rejected" | "failed" | null;
    readonly appliedPath: string | null;
    readonly enforcement: {
      readonly selected: "managed" | "external" | "disabled";
      readonly status:
        | "not_exercised"
        | "unisolated"
        | "enforced"
        | "unavailable"
        | "denied"
        | "interrupted"
        | "failed";
      readonly code: string | null;
    };
    readonly safeErrors: readonly {
      readonly code: string;
      readonly message: string;
    }[];
  };
}

export type HelarcRunDisplayStatus = Exclude<HelarcMainSnapshotStatus, "idle" | "workspace_selected">;

export interface HelarcRunSnapshot {
  readonly runId: string;
  readonly display: {
    readonly status: HelarcRunDisplayStatus;
    readonly terminal: boolean;
    readonly statusSource: "platform" | "product";
  };
  readonly platform: {
    readonly taskId: string;
    readonly startedAt: string;
    readonly approval: HelarcPendingApprovalSnapshot | null;
    readonly terminal: {
      readonly status: "completed" | "blocked" | "failed" | "cancelled";
      readonly code: string | null;
      readonly completedAt: string;
    } | null;
  };
  readonly product: {
    readonly phase: HelarcProductPhaseSnapshot;
    readonly activity: readonly HelarcRunActivitySnapshot[];
    readonly result: HelarcRunProductResultSnapshot | null;
  };
}

export type HelarcConversationMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "product-event";

export interface HelarcConversationMessageSnapshot {
  id: string;
  role: HelarcConversationMessageRole;
  content: string;
  createdAt: string;
  relatedRunIds: string[];
  relatedArtifactIds: string[];
}

export type HelarcArtifactSnapshotKind =
  | "final-output"
  | "patch-proposal"
  | "applied-patch"
  | "trace-projection"
  | "tool-output-summary"
  | "error-report";

export interface HelarcArtifactSnapshot {
  id: string;
  kind: HelarcArtifactSnapshotKind;
  title: string;
  summary: string | null;
  createdAt: string;
  runId: string | null;
}

export interface HelarcActiveThreadSnapshot {
  id: string;
  title: string;
  status: "open" | "closed" | "archived";
  workspace: HelarcWorkspaceSnapshot;
  activeConversationId: string;
  messages: HelarcConversationMessageSnapshot[];
  artifacts: HelarcArtifactSnapshot[];
}

export type HelarcThreadRunStatus =
  | "inactive"
  | "completed"
  | "rejected"
  | "blocked"
  | "failed"
  | "cancelled";

export interface HelarcThreadLatestRunSnapshot {
  runId: string;
  status: HelarcThreadRunStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface HelarcThreadSummarySnapshot {
  id: string;
  title: string;
  status: "open" | "closed" | "archived";
  workspace: HelarcWorkspaceSnapshot;
  createdAt: string;
  updatedAt: string;
  latestRun: HelarcThreadLatestRunSnapshot | null;
}

export interface HelarcMainSnapshot {
  status: HelarcMainSnapshotStatus;
  workspace: HelarcWorkspaceSnapshot | null;
  workspaceProfiles: HelarcWorkspaceProfileSnapshot[];
  taskTemplates: HelarcTaskTemplateSnapshot[];
  provider: HelarcProviderSnapshot;
  acceptedTask: HelarcAcceptedTaskSnapshot | null;
  activeThread: HelarcActiveThreadSnapshot | null;
  threadSummaries: HelarcThreadSummarySnapshot[];
  run: HelarcRunSnapshot | null;
  error: HelarcMainError | null;
}

export interface HelarcStartRunInput {
  taskText: string;
}

export type HelarcStartRunResult =
  | { ok: true; taskId: string; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export type HelarcCancelRunResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcResolvePatchReviewInput {
  submissionId: string;
  runId: string;
  proposalId: string;
  reviewId: string;
  pendingVersion: number;
  decision: "accepted" | "rejected";
  reason: string | null;
}

export type HelarcResolvePatchReviewResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcOpenThreadInput {
  threadId: string;
}

export type HelarcOpenThreadResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcSelectWorkspaceProfileInput {
  profileId: string;
}

export interface HelarcSaveProviderConfigInput {
  providerKind: HelarcProviderKind;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKeyUpdate: "keep" | "set" | "clear";
  apiKey: string;
}

export interface HelarcDesktopApi {
  readonly bridgeVersion: 4;
  readonly productId: "helarc";
  chooseWorkspace(): Promise<HelarcMainSnapshot>;
  getSnapshot(): Promise<HelarcMainSnapshot>;
  saveProviderConfig(input: HelarcSaveProviderConfigInput): Promise<HelarcMainSnapshot>;
  selectWorkspaceProfile(input: HelarcSelectWorkspaceProfileInput): Promise<HelarcMainSnapshot>;
  startRun(input: HelarcStartRunInput): Promise<HelarcStartRunResult>;
  cancelRun(): Promise<HelarcCancelRunResult>;
  submitApprovalDecision(
    input: HelarcSubmitApprovalDecisionInput,
  ): Promise<HelarcApprovalSubmissionReceipt>;
  resolvePatchReview(input: HelarcResolvePatchReviewInput): Promise<HelarcResolvePatchReviewResult>;
  openThread(input: HelarcOpenThreadInput): Promise<HelarcOpenThreadResult>;
  subscribeSnapshot(listener: (snapshot: HelarcMainSnapshot) => void): () => void;
}
