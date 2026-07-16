import type {
  ApprovalReviewerBinding,
  ResolvedRunPermissionConfig,
  RunCancellationController,
} from "@agent-anything/agent-core";
import {
  createInMemoryHostPolicyAmendmentStore,
  createInMemoryHostSessionAuthorityStore,
  createUserApprovalReviewBridge,
  resolveHostRunPermissionConfig,
  type UserApprovalReviewBridge,
} from "@agent-anything/agent-core/host";
import type {
  ManagedPermissionConstraints,
  PersistentPolicyAmendmentPort,
  WorkspaceContext,
} from "@agent-anything/governance";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import type {
  PermissionEnforcement,
  PermissionProfileDefinition,
} from "@agent-anything/permission/profile";

export type HelarcPermissionPreset =
  | "ask_for_approval"
  | "approve_for_me"
  | "full_access";

export interface CreateHelarcPermissionCompositionInput {
  readonly preset: HelarcPermissionPreset;
  readonly runId: string;
  readonly hostSessionId: string;
  readonly workspace: WorkspaceContext;
  readonly workspaceRoots: readonly { readonly rootId: string; readonly path: string }[];
  readonly platform: "win32" | "posix";
  readonly enforcement: PermissionEnforcement;
  readonly cancellation: RunCancellationController;
  readonly userApprovalBridge?: UserApprovalReviewBridge;
  readonly automaticReviewer?: ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  };
  readonly sessionAuthorityPort?: SessionAuthorityPort;
  readonly persistentPolicyAmendments?: PersistentPolicyAmendmentPort;
}

export interface HelarcPermissionComposition {
  readonly permissions: ResolvedRunPermissionConfig;
  readonly userApprovalBridge: UserApprovalReviewBridge | null;
}

const MANAGED_CONSTRAINTS: ManagedPermissionConstraints = Object.freeze({
  constraintSetId: "helarc-local-default",
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
  allowUnenforcedExecution: true,
});

export async function createHelarcPermissionComposition(
  input: CreateHelarcPermissionCompositionInput,
): Promise<HelarcPermissionComposition> {
  const managedConstraints = Object.freeze({
    ...MANAGED_CONSTRAINTS,
    constraintSetId: `helarc-local-${input.preset}`,
  });
  const userApprovalBridge = input.preset === "ask_for_approval"
    ? input.userApprovalBridge ?? createUserApprovalReviewBridge({
        runId: input.runId,
        descriptor: {
          id: "helarc-user-reviewer",
          kind: "user",
          displayName: "Helarc user",
          source: "helarc",
          metadata: { product: "helarc" },
        },
      })
    : null;
  const reviewer = resolveReviewer(input, userApprovalBridge);
  const sessionAuthorityPort = input.sessionAuthorityPort ??
    createInMemoryHostSessionAuthorityStore({ maxRecords: 64 });
  const persistentPolicyAmendments = input.persistentPolicyAmendments ??
    createInMemoryHostPolicyAmendmentStore({ maxRecords: 64 });

  const permissions = await resolveHostRunPermissionConfig({
    profile: {
      profileId: profileIdForPreset(input.preset, input.enforcement),
      profiles: [profileForPreset(input.preset, input.enforcement)],
      environment: {
        environmentId: "helarc-local",
        platform: input.platform,
        workspaceRoots: input.workspaceRoots,
      },
    },
    approvalPolicy: input.preset === "full_access" ? "never" : "on-request",
    reviewer,
    rules: [],
    networkRules: [],
    managedConstraints,
    sessionAuthority: {
      context: {
        hostSessionId: input.hostSessionId,
        authorityContextKey: "helarc-local-authority-v1",
        workspaceId: input.workspace.id,
        identityId: null,
        environmentId: "helarc-local",
      },
      port: sessionAuthorityPort,
      maxInitialRecords: 64,
    },
    persistentPolicyAmendments,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 5_000 },
    interruption: createInterruptionContext(input.cancellation),
  });

  return Object.freeze({ permissions, userApprovalBridge });
}

function resolveReviewer(
  input: CreateHelarcPermissionCompositionInput,
  userApprovalBridge: UserApprovalReviewBridge | null,
): ApprovalReviewerBinding | null {
  if (input.preset === "full_access") return null;
  if (input.preset === "approve_for_me") {
    if (input.automaticReviewer === undefined) {
      throw new TypeError(
        "Helarc Approve for me requires an explicit automatic reviewer binding.",
      );
    }
    return input.automaticReviewer;
  }
  if (userApprovalBridge === null) {
    throw new TypeError("Helarc Ask for approval requires a user-review bridge.");
  }
  return Object.freeze({
    bindingId: `${input.runId}:reviewer:user`,
    kind: "user",
    reviewer: userApprovalBridge,
    descriptor: userApprovalBridge.descriptor,
    reviewTimeoutMs: null,
  });
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
  enforcement: PermissionEnforcement,
): PermissionProfileDefinition {
  return Object.freeze({
    id: profileIdForPreset(preset, enforcement),
    extends: preset === "full_access" ? ":danger-full-access" : ":workspace",
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
