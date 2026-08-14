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

export interface HelarcInteractionProtocolRefSnapshot {
  readonly owner: string;
  readonly kind: string;
  readonly revision: string;
}

export interface HelarcInteractionSubjectRefSnapshot {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface HelarcInteractionRequestRefSnapshot {
  readonly id: string;
  readonly protocol: HelarcInteractionProtocolRefSnapshot;
  readonly requestVersion: number;
  readonly subject: HelarcInteractionSubjectRefSnapshot;
}

export interface HelarcPatchReviewPresentationSnapshot {
  readonly runId: string;
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly reviewId: string;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly operation: "create" | "update" | "delete";
  readonly summary: string;
  readonly rationale: string;
  readonly originalContent: string | null;
  readonly proposedContent: string | null;
  readonly originalContentBytes: number | null;
  readonly proposedContentBytes: number | null;
}

interface HelarcPendingInteractionSnapshotBase<TFamily extends string> {
  readonly family: TFamily;
  readonly request: HelarcInteractionRequestRefSnapshot;
  readonly phase: "pending" | "submitted_for_resolution";
  readonly disclosureClass: "public" | "internal" | "sensitive";
  readonly expiresAt: string | null;
  readonly blockingScope: "none" | "branch" | "run";
}

export type HelarcPendingInteractionSnapshot =
  | (HelarcPendingInteractionSnapshotBase<"approval"> & {
      readonly presentation: HelarcApprovalReviewRequestSnapshot;
    })
  | (HelarcPendingInteractionSnapshotBase<"patch_review"> & {
      readonly presentation: HelarcPatchReviewPresentationSnapshot;
    })
  | (HelarcPendingInteractionSnapshotBase<"unsupported"> & {
      readonly presentation: null;
    });

export type HelarcProductPhaseSnapshot =
  | { readonly kind: "none" }
  | {
      readonly kind: "patch_review_requested";
      readonly proposalId: string;
      readonly proposalRevision: number;
      readonly reviewId: string;
    }
  | {
      readonly kind: "patch_action_submitted";
      readonly proposalId: string;
      readonly proposalRevision: number;
      readonly reviewId: string;
      readonly requestVersion: number;
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
    readonly workspace: {
      readonly primaryId: string | null;
      readonly additionalIds: readonly string[];
    };
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
    readonly runRevision: number;
    readonly pendingInteractions: readonly HelarcPendingInteractionSnapshot[];
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

export interface HelarcSubmitInteractionInput {
  readonly commandId: string;
  readonly runId: string;
  readonly request: HelarcInteractionRequestRefSnapshot;
  readonly submissionId: string;
  readonly payload: unknown;
}

export interface HelarcSteerRunInput {
  readonly commandId: string;
  readonly runId: string;
  readonly expectedRunRevision: number;
  readonly instruction: string;
}

export interface HelarcGetRunStatusInput {
  readonly queryId: string;
  readonly runId: string;
}

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

interface HelarcHostCommandReceiptBase<
  TKind extends "run.cancel" | "run.steer" | "interaction.submit",
> {
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

export interface HelarcInteractionSubmissionCommandReceipt
  extends HelarcHostCommandReceiptBase<"interaction.submit"> {
  readonly status: "handled";
  readonly result:
    | {
        readonly status: "accepted_for_resolution" | "duplicate_identical";
        readonly receipt: {
          readonly receiptId: string;
          readonly request: HelarcInteractionRequestRefSnapshot;
          readonly submissionId: string;
          readonly status: "accepted_for_resolution" | "duplicate_identical" | "rejected";
          readonly recordedAt: string;
        };
      }
    | {
        readonly status: "rejected";
      readonly code:
          | "interaction_not_pending"
          | "interaction_version_stale"
          | "interaction_submission_conflict"
          | "interaction_submission_invalid"
          | "run_settled";
        readonly receipt: {
          readonly receiptId: string;
          readonly request: HelarcInteractionRequestRefSnapshot;
          readonly submissionId: string;
          readonly status: "accepted_for_resolution" | "duplicate_identical" | "rejected";
          readonly recordedAt: string;
        } | null;
      };
}

export interface HelarcRunSteeringCommandReceipt
  extends HelarcHostCommandReceiptBase<"run.steer"> {
  readonly status: "handled";
  readonly result:
    | {
        readonly status: "accepted_for_application" | "duplicate_identical";
        readonly command: {
          readonly commandId: string;
          readonly expectedRunRevision: number;
          readonly acceptedRunRevision: number;
          readonly instruction: string;
          readonly submittedAt: string;
        };
      }
    | {
        readonly status: "rejected";
        readonly code:
          | "steering_invalid"
          | "steering_command_conflict"
          | "steering_revision_stale"
          | "steering_queue_full"
          | "run_cancelling"
          | "run_settled";
        readonly commandId: string;
        readonly currentRunRevision: number;
      };
}

export interface HelarcHostCommandRejectedReceipt {
  readonly version: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: "run.cancel" | "run.steer" | "interaction.submit" | null;
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
  | HelarcRunSteeringCommandReceipt
  | HelarcInteractionSubmissionCommandReceipt
  | HelarcHostCommandRejectedReceipt;

export interface HelarcHostCommandResponse {
  readonly receipt: HelarcHostCommandReceipt;
  readonly snapshot: HelarcMainSnapshot;
}

export interface HelarcRunStatusResponse {
  readonly receipt:
    | {
        readonly version: 1;
        readonly queryId: string;
        readonly runId: string;
        readonly kind: "run.status";
        readonly status: "handled";
        readonly run: HelarcHostRunStatusSnapshot;
      }
    | {
        readonly version: 1;
        readonly queryId: string;
        readonly runId: string;
        readonly kind: "run.status" | null;
        readonly status: "rejected";
        readonly code:
          | "host_query_invalid"
          | "host_query_version_unsupported"
          | "host_query_run_not_found"
          | "host_query_failed";
      };
  readonly snapshot: HelarcMainSnapshot;
}

export interface HelarcHostRunStatusSnapshot {
  readonly runId: string;
  readonly taskId: string;
  readonly runRevision: number;
  readonly status:
    | "starting"
    | "running"
    | "waiting"
    | "cancelling"
    | "completed"
    | "blocked"
    | "failed"
    | "cancelled";
  readonly startedAt: string;
  readonly pendingInteractions: readonly HelarcPendingInteractionSnapshot[];
  readonly terminal: HelarcRunSnapshot["host"]["terminal"];
}

export interface HelarcDesktopApi {
  readonly bridgeVersion: 7;
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
  steerRun(input: HelarcSteerRunInput): Promise<HelarcHostCommandResponse>;
  submitInteraction(input: HelarcSubmitInteractionInput): Promise<HelarcHostCommandResponse>;
  getRunStatus(input: HelarcGetRunStatusInput): Promise<HelarcRunStatusResponse>;
  openThread(
    input: HelarcOpenThreadInput,
  ): Promise<HelarcProductCommandReceipt<"thread.open">>;
  subscribeSnapshot(listener: (snapshot: HelarcMainSnapshot) => void): () => void;
}
