import type {
  HelarcProductCommandKind,
  HelarcProductCommandRejectionCode,
  HelarcProductRunStartTarget,
} from "./HelarcDesktopCommand.js";

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
  | HelarcApprovalReviewRequestBase<"remoteToolCall", {
      readonly sourceKind: "mcp" | "plugin" | "remote";
      readonly sourceDisplayName: string;
      readonly serverDisplayName: string;
      readonly toolDisplayName: string;
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
  readonly commandId: string;
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
  readonly proposalRevision: number;
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
      readonly proposalRevision: number;
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
  readonly productRunId: string;
  readonly harnessRunId: string;
  readonly display: {
    readonly status: HelarcRunDisplayStatus;
    readonly terminal: boolean;
    readonly statusSource: "host" | "product";
  };
  readonly host: {
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

export type HelarcThreadMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "product";

export interface HelarcThreadMessageSnapshot {
  id: string;
  sequence: number;
  role: HelarcThreadMessageRole;
  content: string;
  createdAt: string;
  relatedRunIds: string[];
  relatedArtifactIds: string[];
}

export type HelarcArtifactSnapshotKind =
  | "final-output"
  | "proposal-revision"
  | "applied-change"
  | "trace-projection"
  | "tool-output-summary"
  | "evidence-bundle"
  | "validation-report"
  | "evaluation-report"
  | "engineering-review"
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
  revision: number;
  messages: HelarcThreadMessageSnapshot[];
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
  commandId: string;
  taskText: string;
  target: HelarcProductRunStartTarget;
}

export type HelarcStartRunResult =
  | {
      ok: true;
      taskId: string;
      productRunId: string;
      threadId: string;
      snapshot: HelarcMainSnapshot;
    }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcCancelRunInput {
  readonly commandId: string;
  readonly runId: string;
  readonly reason: string | null;
}

export interface HelarcResolvePatchReviewInput {
  commandId: string;
  submissionId: string;
  runId: string;
  proposalId: string;
  proposalRevision: number;
  reviewId: string;
  pendingVersion: number;
  decision: "accepted" | "rejected" | "request_revision";
  reason: string | null;
}

export type HelarcResolvePatchReviewResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcOpenThreadInput {
  commandId: string;
  threadId: string;
}

export type HelarcOpenThreadResult =
  | { ok: true; snapshot: HelarcMainSnapshot }
  | { ok: false; error: HelarcMainError; snapshot: HelarcMainSnapshot };

export interface HelarcSelectWorkspaceProfileInput {
  commandId: string;
  profileId: string;
}

export interface HelarcSaveProviderConfigInput {
  commandId: string;
  providerKind: HelarcProviderKind;
  displayName: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKeyUpdate: "keep" | "set" | "clear";
  apiKey: string;
}

export interface HelarcChooseWorkspaceInput {
  readonly commandId: string;
}

export interface HelarcProductCommandResultMap {
  readonly "workspace.choose": HelarcMainSnapshot;
  readonly "workspace.select": HelarcMainSnapshot;
  readonly "provider.save": HelarcMainSnapshot;
  readonly "run.start": HelarcStartRunResult;
  readonly "patch_review.submit": HelarcResolvePatchReviewResult;
  readonly "thread.open": HelarcOpenThreadResult;
}

export type HelarcProductCommandHandledReceipt<
  TKind extends HelarcProductCommandKind,
> = TKind extends HelarcProductCommandKind
  ? {
      readonly version: 1;
      readonly commandId: string;
      readonly kind: TKind;
      readonly status: "handled";
      readonly result: HelarcProductCommandResultMap[TKind];
    }
  : never;

export interface HelarcProductCommandRejectedReceipt {
  readonly version: 1;
  readonly commandId: string;
  readonly kind: HelarcProductCommandKind | null;
  readonly status: "rejected";
  readonly code: HelarcProductCommandRejectionCode;
}

export type HelarcProductCommandReceipt<
  TKind extends HelarcProductCommandKind,
> =
  | HelarcProductCommandHandledReceipt<TKind>
  | HelarcProductCommandRejectedReceipt;

export interface HelarcCancellationSummarySnapshot {
  readonly requestId: string;
  readonly origin: "user" | "host" | "approval" | "parent_run" | "runner";
  readonly reasonCode:
    | "user_requested"
    | "host_requested"
    | "host_shutdown"
    | "approval_cancelled"
    | "parent_run_cancelled"
    | "runner_shutdown";
  readonly requestedAt: string;
}

export type HelarcRunCancellationReceipt =
  | {
      readonly status: "accepted" | "already_requested";
      readonly cancellation: HelarcCancellationSummarySnapshot;
    }
  | {
      readonly status: "run_settled";
      readonly cancellation: HelarcCancellationSummarySnapshot | null;
    };

interface HelarcHostCommandReceiptBase<TKind extends "run.cancel" | "approval.submit"> {
  readonly version: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: TKind;
}

export interface HelarcRunCancellationCommandReceipt
  extends HelarcHostCommandReceiptBase<"run.cancel"> {
  readonly status: "handled";
  readonly result: HelarcRunCancellationReceipt;
}

export interface HelarcApprovalSubmissionCommandReceipt
  extends HelarcHostCommandReceiptBase<"approval.submit"> {
  readonly status: "handled";
  readonly result: HelarcApprovalSubmissionReceipt;
}

export interface HelarcHostCommandRejectedReceipt {
  readonly version: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: "run.cancel" | "approval.submit" | null;
  readonly status: "rejected";
  readonly code: HelarcHostCommandRejectionCode;
}

export type HelarcHostCommandRejectionCode =
  | "host_command_invalid"
  | "host_command_version_unsupported"
  | "host_command_kind_unsupported"
  | "host_command_kind_mismatch"
  | "host_command_id_conflict"
  | "host_command_ledger_full"
  | "host_command_run_not_active"
  | "host_command_failed";

export type HelarcHostCommandReceipt =
  | HelarcRunCancellationCommandReceipt
  | HelarcApprovalSubmissionCommandReceipt
  | HelarcHostCommandRejectedReceipt;

export interface HelarcHostCommandResponse {
  readonly receipt: HelarcHostCommandReceipt;
  readonly snapshot: HelarcMainSnapshot;
}

export interface HelarcDesktopApi {
  readonly bridgeVersion: 6;
  readonly productId: "helarc";
  chooseWorkspace(
    input: HelarcChooseWorkspaceInput,
  ): Promise<HelarcProductCommandReceipt<"workspace.choose">>;
  getSnapshot(): Promise<HelarcMainSnapshot>;
  saveProviderConfig(
    input: HelarcSaveProviderConfigInput,
  ): Promise<HelarcProductCommandReceipt<"provider.save">>;
  selectWorkspaceProfile(
    input: HelarcSelectWorkspaceProfileInput,
  ): Promise<HelarcProductCommandReceipt<"workspace.select">>;
  startRun(
    input: HelarcStartRunInput,
  ): Promise<HelarcProductCommandReceipt<"run.start">>;
  cancelRun(input: HelarcCancelRunInput): Promise<HelarcHostCommandResponse>;
  submitApprovalDecision(
    input: HelarcSubmitApprovalDecisionInput,
  ): Promise<HelarcHostCommandResponse>;
  resolvePatchReview(
    input: HelarcResolvePatchReviewInput,
  ): Promise<HelarcProductCommandReceipt<"patch_review.submit">>;
  openThread(
    input: HelarcOpenThreadInput,
  ): Promise<HelarcProductCommandReceipt<"thread.open">>;
  subscribeSnapshot(listener: (snapshot: HelarcMainSnapshot) => void): () => void;
}
