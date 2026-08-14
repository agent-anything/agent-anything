import type { ApprovalReviewerBinding, ResolvedRunPermissionConfig } from "@agent-anything/agent-runtime/run";
import {
  resolveHostRunPermissionConfig,
} from "@agent-anything/host/composition";
import type {
  ManagedPermissionConstraints,
  PersistentPolicyAmendmentPort,
} from "@agent-anything/governance";
import type { WorkspaceIdentity } from "@agent-anything/workspace/identity";
import {
  resolveHelarcPermissionPreset,
  type HelarcPermissionPreset,
} from "@agent-anything/helarc/configuration";
import type { SessionAuthorityPort } from "@agent-anything/permission";
import type {
  PermissionEnforcement,
  PermissionProfileDefinition,
} from "@agent-anything/permission/profile";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";

export interface CreateHelarcHostPermissionCompositionInput {
  readonly preset: HelarcPermissionPreset;
  readonly productRunId: string;
  readonly sessionId: string;
  readonly workspace: WorkspaceIdentity;
  readonly workspaceRoots: readonly { readonly rootId: string; readonly path: string }[];
  readonly platform: "win32" | "posix";
  readonly enforcement: PermissionEnforcement;
  readonly automaticReviewer: (ApprovalReviewerBinding & {
    readonly kind: "auto_review";
  }) | null;
  readonly sessionAuthorityPort: SessionAuthorityPort;
  readonly persistentPolicyAmendments: PersistentPolicyAmendmentPort;
}

export interface HelarcHostPermissionComposition {
  readonly permissions: ResolvedRunPermissionConfig;
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
    interruption: createPreparationInterruptionContext(),
  });

  return Object.freeze({ permissions });
}

function resolveReviewer(
  input: CreateHelarcHostPermissionCompositionInput,
  expected: "user" | "auto_review" | null,
): ApprovalReviewerBinding | null {
  if (expected === "user") {
    if (input.automaticReviewer !== null) {
      throw new TypeError("Ask for approval must not include an automatic reviewer.");
    }
    return Object.freeze({
      bindingId: `${input.productRunId}:reviewer:user`,
      kind: "user",
      descriptor: Object.freeze({
        id: "helarc-desktop-user-reviewer",
        kind: "user" as const,
        displayName: "Helarc user",
        source: "helarc-desktop",
        metadata: Object.freeze({ product: "helarc" }),
      }),
    });
  }
  if (expected === "auto_review") {
    if (input.automaticReviewer === null) {
      throw new TypeError("Approve for me requires an explicit automatic reviewer.");
    }
    if (input.automaticReviewer.kind !== "auto_review") {
      throw new TypeError("Approve for me reviewer kind must be auto_review.");
    }
    return input.automaticReviewer;
  }
  if (input.automaticReviewer !== null) {
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

function createPreparationInterruptionContext(): InvocationInterruptionContext {
  const controller = new AbortController();
  return Object.freeze({
    signal: controller.signal,
    interruption: null,
  });
}
