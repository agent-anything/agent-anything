import type {
  ApprovalReviewerBinding,
  ResolvedRunPermissionConfig,
  RunCancellationController,
} from "@agent-anything/agent-core/run";
import {
  resolveHostRunPermissionConfig,
  type UserApprovalReviewBridge,
} from "@agent-anything/host";
import type {
  ManagedPermissionConstraints,
  PersistentPolicyAmendmentPort,
  WorkspaceContext,
} from "@agent-anything/governance";
import {
  resolveHelarcPermissionPreset,
  type HelarcPermissionPreset,
} from "@agent-anything/helarc";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import type {
  PermissionEnforcement,
  PermissionProfileDefinition,
} from "@agent-anything/permission/profile";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";

export interface CreateHelarcHostPermissionCompositionInput {
  readonly preset: HelarcPermissionPreset;
  readonly runId: string;
  readonly sessionId: string;
  readonly workspace: WorkspaceContext;
  readonly workspaceRoots: readonly { readonly rootId: string; readonly path: string }[];
  readonly platform: "win32" | "posix";
  readonly enforcement: PermissionEnforcement;
  readonly cancellation: RunCancellationController;
  readonly userApprovalBridge: UserApprovalReviewBridge | null;
  readonly automaticReviewer: (ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  }) | null;
  readonly sessionAuthorityPort: SessionAuthorityPort;
  readonly persistentPolicyAmendments: PersistentPolicyAmendmentPort;
}

export interface HelarcHostPermissionComposition {
  readonly permissions: ResolvedRunPermissionConfig;
  readonly userApprovalBridge: UserApprovalReviewBridge | null;
}

export async function createHelarcHostPermissionComposition(
  input: CreateHelarcHostPermissionCompositionInput,
): Promise<HelarcHostPermissionComposition> {
  const preset = resolveHelarcPermissionPreset(input.preset);
  const reviewer = resolveReviewer(input, preset.reviewerKind);
  const managedConstraints: ManagedPermissionConstraints = Object.freeze({
    constraintSetId: `helarc-local-${input.preset}`,
    selectableProfiles: Object.freeze({
      allowedProfileIds: null,
      deniedProfileIds: Object.freeze([]),
    }),
    fileSystem: Object.freeze([]),
    network: Object.freeze({
      enabled: null,
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze([]),
    }),
    allowUnenforcedExecution: input.enforcement === "disabled",
  });
  const permissions = await resolveHostRunPermissionConfig({
    profile: {
      profileId: profileIdForPreset(input.preset, input.enforcement),
      profiles: [profileForPreset(
        input.preset,
        preset.baseProfileId,
        input.enforcement,
      )],
      environment: {
        environmentId: "helarc-local",
        platform: input.platform,
        workspaceRoots: input.workspaceRoots,
      },
    },
    approvalPolicy: preset.approvalPolicy,
    reviewer,
    rules: [],
    networkRules: [],
    managedConstraints,
    sessionAuthority: {
      context: {
        hostSessionId: input.sessionId,
        authorityContextKey: "helarc-local-authority-v1",
        workspaceId: input.workspace.id,
        identityId: null,
        environmentId: "helarc-local",
      },
      port: input.sessionAuthorityPort,
      maxInitialRecords: 64,
    },
    persistentPolicyAmendments: input.persistentPolicyAmendments,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 5_000 },
    interruption: createInterruptionContext(input.cancellation),
  });

  return Object.freeze({
    permissions,
    userApprovalBridge: preset.reviewerKind === "user"
      ? input.userApprovalBridge
      : null,
  });
}

function resolveReviewer(
  input: CreateHelarcHostPermissionCompositionInput,
  expected: "user" | "auto_review" | null,
): ApprovalReviewerBinding | null {
  if (expected === "user") {
    if (input.userApprovalBridge === null) {
      throw new TypeError("Ask for approval requires an explicit user approval bridge.");
    }
    if (input.automaticReviewer !== null) {
      throw new TypeError("Ask for approval must not include an automatic reviewer.");
    }
    if (input.userApprovalBridge.runId !== input.runId) {
      throw new TypeError("User approval bridge Run identity does not match the composed Run.");
    }
    return Object.freeze({
      bindingId: `${input.runId}:reviewer:user`,
      kind: "user",
      reviewer: input.userApprovalBridge,
      descriptor: input.userApprovalBridge.descriptor,
      reviewTimeoutMs: null,
    });
  }
  if (expected === "auto_review") {
    if (input.automaticReviewer === null) {
      throw new TypeError("Approve for me requires an explicit automatic reviewer.");
    }
    if (input.userApprovalBridge !== null) {
      throw new TypeError("Approve for me must not include a user approval bridge.");
    }
    if (input.automaticReviewer.kind !== "auto_review") {
      throw new TypeError("Approve for me reviewer kind must be auto_review.");
    }
    return input.automaticReviewer;
  }
  if (input.userApprovalBridge !== null || input.automaticReviewer !== null) {
    throw new TypeError("Full access must not include an approval reviewer.");
  }
  return null;
}

function profileIdForPreset(
  preset: HelarcPermissionPreset,
  enforcement: PermissionEnforcement,
): string {
  const authority = preset === "full_access" ? "full-access" : "workspace";
  return `helarc-${authority}-${enforcement}`;
}

function profileForPreset(
  preset: HelarcPermissionPreset,
  baseProfileId: ":workspace" | ":danger-full-access",
  enforcement: PermissionEnforcement,
): PermissionProfileDefinition {
  return Object.freeze({
    id: profileIdForPreset(preset, enforcement),
    extends: baseProfileId,
    enforcement,
    unrestrictedFileSystem: false,
    fileSystem: Object.freeze([]),
    process: Object.freeze({ unrestricted: false }),
    network: Object.freeze({
      enabled: false,
      allowedDomains: Object.freeze([]),
      deniedDomains: Object.freeze([]),
    }),
    metadata: Object.freeze({
      product: "helarc",
      permissionPreset: preset,
      enforcement,
    }),
  });
}

function createInterruptionContext(
  cancellation: RunCancellationController,
): InvocationInterruptionContext {
  return Object.freeze({
    signal: cancellation.context.signal,
    get interruption(): InvocationInterruptionRef | null {
      const request = cancellation.context.request;
      return request === null
        ? null
        : {
            kind: "run_cancellation",
            cancellation: {
              runId: request.runId,
              requestId: request.id,
            },
          };
    },
  });
}
