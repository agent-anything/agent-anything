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

export type HelarcModelUsePolicy =
  | "require_qualified"
  | "allow_experimental";

export const HELARC_DEFAULT_PROVIDER_SETTINGS = Object.freeze({
  providerKind: "ollama" as const satisfies HelarcProviderKind,
  displayName: "Ollama Provider",
  baseUrl: "http://localhost:11434",
  model: "gemma4:e4b",
  timeoutMs: 300_000_000,
  qualificationPolicy: "allow_experimental" as const satisfies HelarcModelUsePolicy,
});

export interface HelarcOllamaRuntimeProfileSnapshot {
  contextWindowTokens: number;
  maximumOutputTokens: number;
}

export const HELARC_DEFAULT_OLLAMA_RUNTIME_PROFILE: Readonly<
  HelarcOllamaRuntimeProfileSnapshot
> = Object.freeze({
  contextWindowTokens: 16_384,
  maximumOutputTokens: 2_048,
});

export interface HelarcProviderProfileSnapshot {
  id: string;
  providerKind: HelarcProviderKind;
  displayName: string;
  endpointLabel: string;
  baseUrl: string;
  baseUrlOrigin: string;
  model: string;
  timeoutMs: number;
  ollamaRuntime: HelarcOllamaRuntimeProfileSnapshot | null;
  credentialStatus: HelarcProviderCredentialStatus;
  qualificationPolicy: HelarcModelUsePolicy;
  isActive: boolean;
}

export type HelarcProviderSnapshot =
  | {
      configured: true;
      nativeToolInteraction: { supported: boolean };
      activeProfile: HelarcProviderProfileSnapshot;
      profiles: HelarcProviderProfileSnapshot[];
      error: null;
    }
  | {
      configured: false;
      nativeToolInteraction: { supported: false };
      activeProfile: null;
      profiles: HelarcProviderProfileSnapshot[];
      error: HelarcMainError;
    };

export type HelarcMainSnapshotStatus =
  | "idle"
  | "workspace_selected"
  | "starting"
  | "running"
  | "suspended"
  | "cancelling"
  | "waiting_for_approval"
  | "completed"
  | "stopped"
  | "rejected"
  | "failed"
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

interface HelarcPendingInteractionSnapshotBase<TFamily extends string> {
  readonly family: TFamily;
  readonly request: HelarcInteractionRequestRefSnapshot;
  readonly phase: "pending" | "submitted_for_resolution";
  readonly disclosureClass: "public" | "internal" | "sensitive";
  readonly expiresAt: string | null;
  readonly blockingScope: "none" | "branch" | "run";
}

export interface HelarcClarificationQuestionSnapshot {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
  }[];
  readonly allowMultiple: boolean;
}

export interface HelarcClarificationPresentationSnapshot {
  readonly questions: readonly HelarcClarificationQuestionSnapshot[];
}

export type HelarcPendingInteractionSnapshot =
  | (HelarcPendingInteractionSnapshotBase<"approval"> & {
      readonly presentation: HelarcApprovalReviewRequestSnapshot;
    })
  | (HelarcPendingInteractionSnapshotBase<"clarification"> & {
      readonly presentation: HelarcClarificationPresentationSnapshot;
    })
  | (HelarcPendingInteractionSnapshotBase<"unsupported"> & {
      readonly presentation: null;
    });

export type HelarcProductPhaseSnapshot = { readonly kind: "none" };

export type HelarcRunLineageSnapshot =
  | {
      readonly kind: "root";
      readonly rootRunId: string;
      readonly depth: 0;
    }
  | {
      readonly kind: "descendant";
      readonly rootRunId: string;
      readonly parentRunId: string;
      readonly parentRunActionId: string;
      readonly relationId: string;
      readonly depth: number;
    };

export interface HelarcRunActivitySourceSnapshot {
  readonly runId: string;
  readonly eventSequence: number;
  readonly lineage: HelarcRunLineageSnapshot;
}

export interface HelarcRunActivitySnapshot {
  readonly id: string;
  readonly sequence: number;
  readonly source: HelarcRunActivitySourceSnapshot;
  readonly timestamp: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type HelarcRunTreeNodeStatusSnapshot =
  | "initializing"
  | "running"
  | "waiting"
  | "suspended"
  | "cancelling"
  | "succeeded"
  | "stopped"
  | "failed"
  | "cancelled";

export interface HelarcRunTreeNodeSnapshot {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly relationId: string | null;
  readonly relationKind: "delegation" | "continuation" | null;
  readonly parentRunActionId: string | null;
  readonly dispatch: {
    readonly requestedForm: "single" | "concurrent_sibling";
    readonly controllerRequestId: string;
    readonly controllerTurnId: string;
    readonly candidateIndex: number;
    readonly siblingIndex: number;
    readonly siblingCount: number;
  } | null;
  readonly depth: number;
  readonly status: HelarcRunTreeNodeStatusSnapshot;
  readonly terminal: {
    readonly causeId: string;
    readonly causeRevision: string;
    readonly causeKind: "completion" | "stop" | "failure" | "cancellation";
    readonly code: string;
    readonly sourceOwner: string;
    readonly sourceKind: string;
    readonly sourceId: string;
  } | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly resourcesSettled: boolean;
  readonly resultTransfer: "pending" | "settled" | "failed" | "unknown" | "not_required";
  readonly cancellationScope: "subtree" | "tree" | null;
}

export type HelarcRunTreeResourceSnapshot =
  | {
      readonly enforcement: "hard";
      readonly capacity: number;
      readonly measuredConsumed: number;
      readonly chargedUnknown: number;
      readonly activeReserved: number;
      readonly available: number;
      readonly cumulativeReleased: number;
      readonly measurementStatus: "measured" | "unavailable" | "not_applicable" | "unknown";
    }
  | {
      readonly enforcement: "observational";
      readonly threshold: number;
      readonly observed: number;
      readonly overage: number;
      readonly measurementStatus: "measured" | "unavailable" | "not_applicable" | "unknown";
    };

export interface HelarcRunTreeSnapshot {
  readonly rootRunId: string;
  readonly revision: number;
  readonly deadlineAt: string;
  readonly limits: {
    readonly maxDescendantDepth: number;
    readonly maxTotalDescendantRuns: number;
    readonly maxActiveDescendantRuns: number;
  };
  readonly totalDescendantRuns: number;
  readonly activeDescendantRuns: number;
  readonly resources: Readonly<Record<
    "controllerTurns" | "actions" | "modelInputTokens" | "modelOutputTokens" |
      "costUnits" | "contextBytes" | "resultBytes",
    HelarcRunTreeResourceSnapshot
  >>;
  readonly approvals: {
    readonly totalRequests: number;
    readonly activeReviews: number;
    readonly settledRequests: number;
    readonly uniqueOperationFingerprints: number;
    readonly maxEquivalentOperationRequests: number;
    readonly consecutiveDeclines: number;
    readonly consecutiveReviewerFailures: number;
    readonly exhaustedCode: string | null;
  };
  readonly cancellation: {
    readonly totalRequests: number;
    readonly treeRequested: boolean;
    readonly subtreeRequests: number;
    readonly latestScope: "subtree" | "tree" | null;
    readonly latestOrigin: string | null;
    readonly latestReasonCode: string | null;
    readonly latestRequestedAt: string | null;
  };
  readonly settlement: {
    readonly complete: boolean;
    readonly unsettledDescendantRuns: number;
    readonly pendingResultTransfers: number;
    readonly failedResultTransfers: number;
    readonly unknownResultTransfers: number;
  };
  readonly nodes: readonly HelarcRunTreeNodeSnapshot[];
}

export interface HelarcActiveDelegationSnapshot {
  readonly request: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly relation: Readonly<{ readonly id: string }>;
  readonly child: Readonly<{ readonly id: string }>;
  readonly relationKind: "delegation" | "continuation";
  readonly childRunRevision: number;
  readonly childStatus: HelarcRunTreeNodeStatusSnapshot;
  readonly suspension: null | {
    readonly id: string;
    readonly revision: string;
    readonly code: string;
    readonly reason: string;
    readonly runRevision: number;
    readonly suspendedAt: string;
  };
  readonly admittedControls: readonly ("steer" | "resume" | "cancel")[];
  readonly resultTransfer: "pending";
  readonly steerable: true;
}

export interface HelarcDescendantContinuationTargetSnapshot {
  readonly ref: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly sourceChild: Readonly<{ readonly id: string }>;
  readonly sourceResult: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly agent: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly limitations: readonly string[];
}

export interface HelarcModelContinuationSnapshot {
  readonly branchId: string;
  readonly requestId: string;
  readonly kind:
    | "reused"
    | "advanced"
    | "reset"
    | "unavailable"
    | "rejected"
    | "cancelled"
    | "failed"
    | "compacted";
  readonly reason: string | null;
  readonly occurredAt: string;
}

export type HelarcVerificationStateSnapshot =
  | "unassessed"
  | "pending"
  | "satisfied"
  | "violated"
  | "inconclusive"
  | "stale";

export type HelarcVerificationGateStatusSnapshot =
  | "completion_eligible"
  | "blocked_unassessed"
  | "blocked_pending"
  | "blocked_stale"
  | "blocked_violated"
  | "blocked_inconclusive"
  | "invalid"
  | "failed";

export interface HelarcHostVerificationSnapshot {
  readonly snapshotRevision: number;
  readonly counts: readonly {
    readonly state: HelarcVerificationStateSnapshot;
    readonly count: number;
  }[];
  readonly activeChecks: number;
  readonly gateStatus: HelarcVerificationGateStatusSnapshot | null;
  readonly waiting: boolean;
  readonly recoveryNeeded: boolean;
  readonly safeReasons: readonly string[];
  readonly updatedAt: string;
}

export interface HelarcProductVerificationSnapshot {
  readonly status:
    | "not_required"
    | "pending"
    | "satisfied"
    | "attention_required"
    | "unavailable";
  readonly snapshotRevision: number | null;
  readonly counts: HelarcHostVerificationSnapshot["counts"];
  readonly activeChecks: number;
  readonly gateStatus: HelarcVerificationGateStatusSnapshot | null;
  readonly waiting: boolean;
  readonly recoveryNeeded: boolean;
  readonly safeReasons: readonly string[];
  readonly updatedAt: string | null;
}

export interface HelarcModelUseSnapshot {
  readonly providerKind: string;
  readonly modelId: string;
  readonly modelIdentityStrength: "immutable" | "mutable_alias" | "unknown";
  readonly status: "qualified" | "experimental" | "blocked";
  readonly policy: HelarcModelUsePolicy;
  readonly experimentalUseSelected: boolean;
  readonly scopes: readonly {
    readonly scope:
      | "agent_loop"
      | "workspace_observation"
      | "workspace_mutation"
      | "process_execution"
      | "user_interaction"
      | "delegation";
    readonly applicability: "current" | "stale" | "absent";
    readonly outcome: "qualified" | "not_qualified" | "inconclusive" | null;
    readonly decidedAt: string | null;
    readonly limitations: readonly string[];
  }[];
  readonly reasons: readonly string[];
  readonly toolGuidance: {
    readonly releaseId: string;
    readonly releaseRevision: string;
    readonly profileRevision: string;
  };
}

export interface HelarcInstructionBindingSnapshot {
  readonly ref: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly agent: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly instructions: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly release: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly model: Readonly<{ readonly providerId: string; readonly modelId: string }>;
  readonly resolverRevision: string;
  readonly contentDigest: Readonly<{ readonly algorithm: "sha256"; readonly value: string }>;
  readonly blockCount: number;
  readonly effectiveFromRunRevision: number;
  readonly supersedes: Readonly<{ readonly id: string; readonly revision: string }> | null;
}

export interface HelarcRunProductResultSnapshot {
  readonly status: "completed" | "stopped" | "rejected" | "failed" | "cancelled";
  readonly qualification: HelarcModelUseSnapshot;
  readonly verification: HelarcProductVerificationSnapshot;
  readonly output: {
    readonly taskId: string;
    readonly workspace: {
      readonly primaryId: string | null;
      readonly additionalIds: readonly string[];
    };
    readonly agentSummary: string | null;
    readonly runtimeStatus: "succeeded" | "stopped" | "failed" | "cancelled";
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
    readonly instructionBinding: HelarcInstructionBindingSnapshot | null;
    readonly runTree: HelarcRunTreeSnapshot;
    readonly activeDelegations: readonly HelarcActiveDelegationSnapshot[];
    readonly continuationTargets: readonly HelarcDescendantContinuationTargetSnapshot[];
    readonly verification: HelarcHostVerificationSnapshot | null;
    readonly pendingInteractions: readonly HelarcPendingInteractionSnapshot[];
    readonly terminal: {
      readonly status: "completed" | "stopped" | "failed" | "cancelled";
      readonly code: string;
      readonly completedAt: string;
    } | null;
  };
  readonly product: {
    readonly phase: HelarcProductPhaseSnapshot;
    readonly qualification: HelarcModelUseSnapshot;
    readonly activity: readonly HelarcRunActivitySnapshot[];
    readonly continuation: HelarcModelContinuationSnapshot | null;
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
  | "verification-report"
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
  | "stopped"
  | "rejected"
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

export interface HelarcResumeDescendantInput {
  readonly commandId: string;
  readonly runId: string;
  readonly request: Readonly<{ readonly id: string; readonly revision: string }>;
  readonly relation: Readonly<{ readonly id: string }>;
  readonly child: Readonly<{ readonly id: string }>;
  readonly expectedRunRevision: number;
  readonly suspension: Readonly<{
    readonly id: string;
    readonly revision: string;
  }>;
  readonly reason: string;
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
  ollamaRuntime: HelarcOllamaRuntimeProfileSnapshot | null;
  qualificationPolicy: HelarcModelUsePolicy;
  apiKeyUpdate: "keep" | "set" | "clear";
  apiKey: string;
}

export interface HelarcChooseWorkspaceInput {
  readonly commandId: string;
}

export interface HelarcProductCommandResultMap {
  readonly "instructions.save": import("./HelarcInstructionSettings.js").HelarcInstructionSettingsSnapshot;
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
  TKind extends "run.cancel" | "run.steer" | "descendant.resume" | "interaction.submit",
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
          | "run_settling"
          | "run_settled";
        readonly commandId: string;
        readonly currentRunRevision: number;
      };
}

export interface HelarcDescendantResumeCommandReceipt
  extends HelarcHostCommandReceiptBase<"descendant.resume"> {
  readonly status: "handled";
  readonly result:
    | {
        readonly status: "routed";
        readonly relation: Readonly<{ readonly id: string }>;
        readonly child: Readonly<{ readonly id: string }>;
        readonly resume:
          | {
              readonly status: "accepted";
              readonly currentRunRevision: number;
            }
          | {
              readonly status: "rejected";
              readonly code:
                | "resume_invalid"
                | "run_not_suspended"
                | "run_revision_stale"
                | "suspension_stale"
                | "run_cancelling"
                | "run_settling"
                | "run_settled";
              readonly requestId: string;
              readonly currentRunRevision: number;
            };
      }
    | {
        readonly status: "rejected";
        readonly code:
          | "delegation_route_invalid"
          | "delegation_relation_unknown"
          | "delegation_route_mismatch"
          | "delegation_child_settled";
        readonly relation: Readonly<{ readonly id: string }> | null;
        readonly child: Readonly<{ readonly id: string }> | null;
      };
}

export interface HelarcHostCommandRejectedReceipt {
  readonly version: 1;
  readonly commandId: string;
  readonly runId: string;
  readonly kind: "run.cancel" | "run.steer" | "descendant.resume" | "interaction.submit" | null;
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
  | HelarcDescendantResumeCommandReceipt
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
  readonly instructionBinding: HelarcInstructionBindingSnapshot | null;
  readonly status:
    | "starting"
    | "running"
    | "waiting"
    | "suspended"
    | "cancelling"
    | "completed"
    | "stopped"
    | "failed"
    | "cancelled";
  readonly startedAt: string;
  readonly runTree: HelarcRunTreeSnapshot;
  readonly activeDelegations: readonly HelarcActiveDelegationSnapshot[];
  readonly continuationTargets: readonly HelarcDescendantContinuationTargetSnapshot[];
  readonly verification: HelarcHostVerificationSnapshot | null;
  readonly pendingInteractions: readonly HelarcPendingInteractionSnapshot[];
  readonly terminal: HelarcRunSnapshot["host"]["terminal"];
}

export interface HelarcDesktopApi {
  getInstructionSettings(): Promise<import("./HelarcInstructionSettings.js").HelarcInstructionSettingsSnapshot>;
  saveInstructionSettings(input: {
    readonly commandId: string;
    readonly settings: import("./HelarcInstructionSettings.js").HelarcInstructionSettings;
  }): Promise<HelarcProductCommandReceipt<"instructions.save">>;
  readonly bridgeVersion: 11;
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
  resumeDescendant(input: HelarcResumeDescendantInput): Promise<HelarcHostCommandResponse>;
  submitInteraction(input: HelarcSubmitInteractionInput): Promise<HelarcHostCommandResponse>;
  getRunStatus(input: HelarcGetRunStatusInput): Promise<HelarcRunStatusResponse>;
  openThread(
    input: HelarcOpenThreadInput,
  ): Promise<HelarcProductCommandReceipt<"thread.open">>;
  subscribeSnapshot(listener: (snapshot: HelarcMainSnapshot) => void): () => void;
}
