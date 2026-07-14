import type {
  ExecPolicyAmendment,
  NetworkPolicyAmendment,
} from "@agent-anything/governance/amendment";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
  Metadata,
} from "@agent-anything/shared";
import type {
  ApprovalApplicabilityKey,
  RunPermissionGrant,
  SessionAuthorityProposal,
  SessionAuthorityRecord,
  ValidatedActionAuthority,
} from "../authority/AuthorityContracts.js";
import type { ApprovalCategory, ApprovalScope } from "./ApprovalCategory.js";
import type {
  AdditionalPermissions,
  CanonicalAdditionalPermissions,
} from "./PermissionDelta.js";
import type { ApprovalsReviewer } from "./ApprovalPolicy.js";

export interface CommandActionSummary {
  readonly kind: "read" | "write" | "network" | "process" | "unknown";
  readonly summary: string;
}

export interface FileChangeApprovalChange {
  readonly operation: "create" | "update" | "delete" | "move" | "copy";
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly destinationCanonicalPath: string | null;
  readonly destinationDisplayPath: string | null;
  readonly baselineFingerprint: string | null;
}

export interface McpApprovalAnnotations {
  readonly readOnlyHint: boolean | null;
  readonly destructiveHint: boolean | null;
  readonly idempotentHint: boolean | null;
  readonly openWorldHint: boolean | null;
}

export interface ApprovalPayloadByCategory {
  readonly commandExecution: {
    readonly command: readonly string[];
    readonly safeCommandDisplay: string;
    readonly cwd: string;
    readonly cwdDisplay: string;
    readonly environmentId: string;
    readonly commandActions: readonly CommandActionSummary[];
    readonly additionalPermissions: CanonicalAdditionalPermissions | null;
  };
  readonly fileChange: {
    readonly changes: readonly FileChangeApprovalChange[];
    readonly baselineFingerprint: string;
    readonly additionalPermissions: CanonicalAdditionalPermissions | null;
  };
  readonly permissions: {
    readonly permissions: CanonicalAdditionalPermissions;
    readonly cwd: string;
    readonly cwdDisplay: string;
    readonly environmentId: string;
  };
  readonly mcpToolCall: {
    readonly serverId: string;
    readonly serverDisplayName: string;
    readonly toolName: string;
    readonly safeArguments: Readonly<Metadata>;
    readonly annotations: McpApprovalAnnotations;
    readonly supportsSessionAuthority: boolean;
  };
  readonly skill: {
    readonly skillId: string;
    readonly skillDisplayName: string;
    readonly action: string;
    readonly requiredPermissions: CanonicalAdditionalPermissions | null;
  };
  readonly networkAccess: {
    readonly host: string;
    readonly port: number | null;
    readonly protocol: string | null;
    readonly actionSummary: string;
  };
}

export interface ApprovalApplicabilityKeyInput {
  readonly category: ApprovalCategory;
  readonly value: string;
}

export interface ApprovalSubject {
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly environmentId: string;
  readonly applicabilityKeys: readonly ApprovalApplicabilityKey[];
}

export type ApprovalDecisionKind =
  | "accept"
  | "acceptForSession"
  | "grantPermissions"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | "decline"
  | "cancel";

export interface ApprovalDecisionOption {
  readonly id: string;
  readonly kind: ApprovalDecisionKind;
  readonly scope: ApprovalScope | null;
  readonly label: string;
  readonly description: string | null;
  readonly trustedProposalRef: string | null;
  readonly metadata: Metadata;
}

export type ApprovalTrustedProposal =
  | {
      readonly kind: "session_authority";
      readonly ref: string;
      readonly proposal: SessionAuthorityProposal;
    }
  | {
      readonly kind: "exec_policy_amendment";
      readonly ref: string;
      readonly amendment: ExecPolicyAmendment;
    }
  | {
      readonly kind: "network_policy_amendment";
      readonly ref: string;
      readonly amendment: NetworkPolicyAmendment;
    };

export interface ApprovalRequirement<
  TCategory extends ApprovalCategory = ApprovalCategory,
> {
  readonly category: TCategory;
  readonly subject: ApprovalSubject;
  readonly reason: string;
  readonly payload: ApprovalPayloadByCategory[TCategory];
  readonly decisionOptions: readonly [
    ApprovalDecisionOption,
    ...ApprovalDecisionOption[],
  ];
  readonly trustedProposals: readonly ApprovalTrustedProposal[];
  readonly deadlineAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface ApprovalRequestBase<
  TCategory extends ApprovalCategory,
> {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly category: TCategory;
  readonly subject: ApprovalSubject;
  readonly reason: string;
  readonly payload: ApprovalPayloadByCategory[TCategory];
  readonly decisionOptions: readonly [
    ApprovalDecisionOption,
    ...ApprovalDecisionOption[],
  ];
  readonly trustedProposals: readonly ApprovalTrustedProposal[];
  readonly createdAt: ISODateTimeString;
  readonly deadlineAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export type ApprovalRequest = {
  readonly [TCategory in ApprovalCategory]: ApprovalRequestBase<TCategory>;
}[ApprovalCategory];

export interface ApprovalDecisionSubmission {
  readonly submissionId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly pendingVersion: number;
  readonly optionId: string;
  readonly grantedPermissions: AdditionalPermissions | null;
  readonly reason: string | null;
}

export type ApprovalSubmissionReceipt =
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

export type ValidatedApprovalDecision =
  | {
      readonly kind: "accept";
      readonly optionId: string;
      readonly actionAuthority: ValidatedActionAuthority;
    }
  | {
      readonly kind: "acceptForSession";
      readonly optionId: string;
      readonly sessionAuthority: SessionAuthorityRecord;
    }
  | {
      readonly kind: "grantPermissions";
      readonly optionId: string;
      readonly authority:
        | { readonly scope: "run"; readonly grant: RunPermissionGrant }
        | { readonly scope: "session"; readonly record: SessionAuthorityRecord };
    }
  | {
      readonly kind: "acceptWithExecpolicyAmendment";
      readonly optionId: string;
      readonly trustedProposalRef: string;
      readonly amendment: ExecPolicyAmendment;
    }
  | {
      readonly kind: "applyNetworkPolicyAmendment";
      readonly optionId: string;
      readonly trustedProposalRef: string;
      readonly amendment: NetworkPolicyAmendment;
    }
  | { readonly kind: "decline"; readonly reason: string | null }
  | { readonly kind: "cancel" };

export interface ApprovalSubjectProjection {
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly environmentId: string;
  readonly applicabilityKeyCount: number;
}

export interface ApprovalDecisionOptionProjection {
  readonly id: string;
  readonly kind: ApprovalDecisionKind;
  readonly scope: ApprovalScope | null;
  readonly label: string;
  readonly description: string | null;
}

export interface ApprovalReviewPayloadByCategory {
  readonly commandExecution: {
    readonly commandDisplay: string;
    readonly cwdDisplay: string;
    readonly commandActions: readonly CommandActionSummary[];
    readonly additionalPermissions: CanonicalAdditionalPermissions | null;
  };
  readonly fileChange: {
    readonly changes: readonly {
      readonly operation: FileChangeApprovalChange["operation"];
      readonly displayPath: string;
      readonly destinationDisplayPath: string | null;
    }[];
    readonly baselineFingerprint: string;
    readonly additionalPermissions: CanonicalAdditionalPermissions | null;
  };
  readonly permissions: {
    readonly permissions: CanonicalAdditionalPermissions;
    readonly cwdDisplay: string;
    readonly environmentId: string;
  };
  readonly mcpToolCall: ApprovalPayloadByCategory["mcpToolCall"];
  readonly skill: ApprovalPayloadByCategory["skill"];
  readonly networkAccess: ApprovalPayloadByCategory["networkAccess"];
}

export interface ApprovalReviewRequestBase<
  TCategory extends ApprovalCategory,
> {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly category: TCategory;
  readonly reason: string;
  readonly subject: ApprovalSubjectProjection;
  readonly payload: ApprovalReviewPayloadByCategory[TCategory];
  readonly decisionOptions: readonly [
    ApprovalDecisionOptionProjection,
    ...ApprovalDecisionOptionProjection[],
  ];
  readonly createdAt: ISODateTimeString;
  readonly deadlineAt: ISODateTimeString;
}

export type ApprovalReviewRequest = {
  readonly [TCategory in ApprovalCategory]: ApprovalReviewRequestBase<TCategory>;
}[ApprovalCategory];

export interface ApprovalReviewContext {
  readonly workspaceTrustState: "trusted" | "restricted" | "unknown" | null;
  readonly ruleOutcome: "allow" | "prompt" | "forbidden" | "none";
  readonly currentAuthority: {
    readonly fileSystemRead: boolean;
    readonly fileSystemWrite: boolean;
    readonly network: boolean;
  };
  readonly annotations: Readonly<Metadata>;
}

export interface ApprovalReviewInput {
  readonly request: ApprovalReviewRequest;
  readonly pendingVersion: number;
  readonly context: ApprovalReviewContext;
}

export interface ApprovalReviewFailure {
  readonly code:
    | "approval_reviewer_unavailable"
    | "approval_review_timeout"
    | "approval_review_failed"
    | "approval_review_malformed"
    | "approval_review_retry_exhausted";
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Metadata;
}

export type ApprovalReviewOutcome =
  | {
      readonly status: "decided";
      readonly submission: ApprovalDecisionSubmission;
      readonly rationale: string | null;
    }
  | { readonly status: "failed"; readonly failure: ApprovalReviewFailure }
  | {
      readonly status: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    };

export interface ApprovalReviewerPort {
  review(
    input: ApprovalReviewInput,
    context: InvocationInterruptionContext,
  ): Promise<ApprovalReviewOutcome>;
}

export type ApprovalApplicationOutcome =
  | { readonly kind: "not_applicable" }
  | {
      readonly kind: "applied";
      readonly target:
        | "action_authority"
        | "run_authority"
        | "session_authority"
        | "policy_amendment";
      readonly authorityRecordIds: readonly [string, ...string[]];
    }
  | { readonly kind: "not_applied"; readonly code: string }
  | { readonly kind: "interrupted"; readonly interruption: InvocationInterruptionRef }
  | { readonly kind: "outcome_unknown"; readonly code: string };

export interface ApprovalRecord {
  readonly id: string;
  readonly runId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly pendingVersion: number;
  readonly reviewer: ApprovalsReviewer;
  readonly resolution:
    | { readonly kind: "decision"; readonly decision: ValidatedApprovalDecision }
    | { readonly kind: "review_failure"; readonly failure: ApprovalReviewFailure }
    | {
        readonly kind: "run_cancelled";
        readonly cancellationRequestId: string;
        readonly initiatingDecision: "cancel" | null;
      };
  readonly application: ApprovalApplicationOutcome;
  readonly resolvedAt: ISODateTimeString;
  readonly metadata: Metadata;
}
