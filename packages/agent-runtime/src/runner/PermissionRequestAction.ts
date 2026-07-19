import {
  canonicalizeAdditionalPermissions,
  validateGrantedPermissions,
  type AdditionalPermissions,
  type ApprovalDecisionOption,
  type ApprovalPolicy,
  type ApprovalTrustedProposal,
  type CanonicalAdditionalPermissions,
  type PermissionResolutionEnvironmentInput,
} from "@agent-anything/permission";
import type { ResolvedRunPermissionConfig } from "@agent-anything/agent-core/run";

const MAX_PERMISSION_REQUEST_REASON_LENGTH = 2_000;

export interface RequestPermissionsActionInput {
  readonly rootId: string;
  readonly permissions: AdditionalPermissions;
  readonly reason: string;
}

export interface PreparedPermissionRequestAction {
  readonly rootId: string;
  readonly cwd: string;
  readonly cwdDisplay: string;
  readonly environment: PermissionResolutionEnvironmentInput;
  readonly permissions: CanonicalAdditionalPermissions;
  readonly reason: string;
  readonly actionFingerprint: string;
}

export interface PermissionRequestDecisionContract {
  readonly decisionOptions: readonly [ApprovalDecisionOption, ...ApprovalDecisionOption[]];
  readonly trustedProposals: readonly ApprovalTrustedProposal[];
}

export type PreparePermissionRequestActionResult =
  | { readonly status: "ready"; readonly request: PreparedPermissionRequestAction }
  | {
      readonly status: "invalid";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly status: "managed_denied";
      readonly code: string;
      readonly message: string;
      readonly request: PreparedPermissionRequestAction;
    };

export function preparePermissionRequestAction(input: {
  readonly actionInput: unknown;
  readonly config: ResolvedRunPermissionConfig;
}): PreparePermissionRequestActionResult {
  const snapshot = snapshotInput(input.actionInput);
  if (snapshot.status === "invalid") return snapshot;

  const profile = input.config.permissionProfile;
  const root = profile.workspaceRoots.find(
    (candidate) => candidate.rootId === snapshot.input.rootId,
  );
  if (root === undefined) {
    return invalid(
      "permission_request_root_not_found",
      `Permission request root '${snapshot.input.rootId}' is not resolved for this Run.`,
    );
  }

  const environment: PermissionResolutionEnvironmentInput = Object.freeze({
    environmentId: profile.environmentId,
    platform: profile.platform,
    workspaceRoots: Object.freeze(profile.workspaceRoots.map((candidate) =>
      Object.freeze({ rootId: candidate.rootId, path: candidate.canonicalPath })
    )),
  });
  let canonical;
  try {
    canonical = canonicalizeAdditionalPermissions({
      permissions: snapshot.input.permissions,
      cwd: root.canonicalPath,
      environment,
    });
  } catch {
    return invalid(
      "permission_request_invalid",
      "Permission request contains a malformed permission delta.",
    );
  }
  if (canonical.status === "invalid") {
    return invalid(canonical.code, canonical.message);
  }

  const fingerprintPayload = JSON.stringify({
    kind: "request_permissions",
    rootId: root.rootId,
    environmentId: profile.environmentId,
    permissions: canonical.permissions,
  });
  const prepared = Object.freeze({
    rootId: root.rootId,
    cwd: root.canonicalPath,
    cwdDisplay: root.rootId,
    environment,
    permissions: canonical.permissions,
    reason: snapshot.input.reason,
    actionFingerprint: `request_permissions:${encodeURIComponent(fingerprintPayload)}`,
  });
  const managed = validateGrantedPermissions({
    requested: canonical.permissions,
    granted: canonical.permissions,
    cwd: root.canonicalPath,
    environment,
    managedConstraints: input.config.managedConstraints,
  });
  if (managed.status === "invalid") {
    return Object.freeze({
      status: "managed_denied" as const,
      code: managed.code,
      message: managed.message,
      request: prepared,
    });
  }
  return Object.freeze({
    status: "ready" as const,
    request: prepared,
  });
}

export function allowsExplicitPermissionRequest(policy: ApprovalPolicy): boolean {
  if (policy === "never") return false;
  if (policy === "untrusted" || policy === "on-request") return true;
  return policy.granular.requestPermissions;
}

export function createPermissionRequestDecisionContract(input: {
  readonly requestId: string;
  readonly prepared: PreparedPermissionRequestAction;
  readonly config: ResolvedRunPermissionConfig;
}): PermissionRequestDecisionContract {
  const session = input.config.sessionAuthority;
  const proposalRef = `${input.requestId}:session_authority_proposal`;
  const sessionOption: ApprovalDecisionOption[] = session === null
    ? []
    : [{
        id: `${input.requestId}:grant_session`,
        kind: "grantPermissions",
        scope: "session",
        label: "Grant for this session",
        description: "Grant a selected subset for the active host session.",
        trustedProposalRef: proposalRef,
        metadata: {},
      }];
  const proposals: ApprovalTrustedProposal[] = session === null
    ? []
    : [{
        kind: "session_authority",
        ref: proposalRef,
        proposal: {
          proposalRef,
          context: session.context,
          category: "permissions",
          applicabilityKeys: [{
            category: "permissions",
            value: input.prepared.actionFingerprint,
          }],
          defaultGrantedPermissions: null,
        },
      }];
  return deepFreeze({
    decisionOptions: [
      {
        id: `${input.requestId}:grant_run`,
        kind: "grantPermissions",
        scope: "run",
        label: "Grant for this run",
        description: "Grant a selected subset for the active run.",
        trustedProposalRef: null,
        metadata: {},
      },
      ...sessionOption,
      {
        id: `${input.requestId}:decline`,
        kind: "decline",
        scope: null,
        label: "Decline",
        description: "Continue without granting these permissions.",
        trustedProposalRef: null,
        metadata: {},
      },
      {
        id: `${input.requestId}:cancel`,
        kind: "cancel",
        scope: null,
        label: "Cancel run",
        description: "Cancel the active run.",
        trustedProposalRef: null,
        metadata: {},
      },
    ] as [ApprovalDecisionOption, ...ApprovalDecisionOption[]],
    trustedProposals: proposals,
  });
}

function snapshotInput(input: unknown):
  | { readonly status: "valid"; readonly input: RequestPermissionsActionInput }
  | Extract<PreparePermissionRequestActionResult, { readonly status: "invalid" }> {
  if (!isRecord(input)) {
    return invalid("permission_request_invalid", "Permission request input must be an object.");
  }
  const rootId = input.rootId;
  const reason = input.reason;
  if (typeof rootId !== "string" || rootId.trim().length === 0) {
    return invalid("permission_request_invalid", "Permission request rootId is invalid.");
  }
  if (
    typeof reason !== "string" ||
    reason.trim().length === 0 ||
    reason.length > MAX_PERMISSION_REQUEST_REASON_LENGTH
  ) {
    return invalid("permission_request_invalid", "Permission request reason is invalid.");
  }
  if (!isRecord(input.permissions)) {
    return invalid("permission_request_invalid", "Permission request permissions are invalid.");
  }
  const permissionShapeFailure = validatePermissionShape(input.permissions);
  if (permissionShapeFailure !== null) return permissionShapeFailure;
  return Object.freeze({
    status: "valid" as const,
    input: Object.freeze({
      rootId,
      permissions: snapshotPermissions(input.permissions),
      reason: reason.trim(),
    }),
  });
}

function validatePermissionShape(
  permissions: Record<string, unknown>,
): Extract<PreparePermissionRequestActionResult, { readonly status: "invalid" }> | null {
  if (permissions.fileSystem !== undefined) {
    if (!isRecord(permissions.fileSystem)) {
      return invalid("permission_request_invalid", "Permission request fileSystem is invalid.");
    }
    for (const field of ["read", "write"] as const) {
      const value = permissions.fileSystem[field];
      if (
        value !== undefined &&
        (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
      ) {
        return invalid("permission_request_invalid", `Permission request ${field} paths are invalid.`);
      }
    }
  }
  if (permissions.network !== undefined) {
    if (!isRecord(permissions.network) || typeof permissions.network.enabled !== "boolean") {
      return invalid("permission_request_invalid", "Permission request network is invalid.");
    }
    const domains = permissions.network.domains;
    if (
      domains !== undefined &&
      (!Array.isArray(domains) || domains.some((entry) => typeof entry !== "string"))
    ) {
      return invalid("permission_request_invalid", "Permission request network domains are invalid.");
    }
  }
  return null;
}

function snapshotPermissions(input: Record<string, unknown>): AdditionalPermissions {
  const fileSystem = isRecord(input.fileSystem) ? input.fileSystem : null;
  const network = isRecord(input.network) ? input.network : null;
  return Object.freeze({
    ...(fileSystem === null
      ? {}
      : {
          fileSystem: Object.freeze({
            ...(Array.isArray(fileSystem.read)
              ? { read: Object.freeze([...fileSystem.read]) as readonly string[] }
              : fileSystem.read === undefined ? {} : { read: fileSystem.read as readonly string[] }),
            ...(Array.isArray(fileSystem.write)
              ? { write: Object.freeze([...fileSystem.write]) as readonly string[] }
              : fileSystem.write === undefined ? {} : { write: fileSystem.write as readonly string[] }),
          }),
        }),
    ...(network === null
      ? {}
      : {
          network: Object.freeze({
            enabled: network.enabled as boolean,
            ...(Array.isArray(network.domains)
              ? { domains: Object.freeze([...network.domains]) as readonly string[] }
              : network.domains === undefined ? {} : { domains: network.domains as readonly string[] }),
          }),
        }),
  });
}

function invalid(code: string, message: string) {
  return Object.freeze({ status: "invalid" as const, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
