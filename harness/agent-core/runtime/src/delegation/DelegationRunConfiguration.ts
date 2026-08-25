import { createToolContractIdentity, toolRevisionKey } from "@agent-anything/tools/identity";
import type { ToolSelectionRevision } from "@agent-anything/tools/selection";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { DelegationRequest } from "./DelegationRequest.js";
import { createDelegationLimits, type DelegationLimits } from "./DelegationRequest.js";
import type {
  DelegationAuthorityDerivation,
  DelegationAuthorityDimension,
  DelegationAuthorityDimensionInput,
} from "./DelegationAuthority.js";
import { createDelegationContractIdentity, deepFreeze } from "./DelegationContract.js";
import type { RunConfig } from "../runner/RunConfig.js";

const DISCLOSURE_ALLOWED = Object.freeze(["model", "runtime"]);
const DISCLOSURE_REQUIRED = Object.freeze([
  "no_parent_trajectory_copy",
  "source_explicit_context",
]);

export function projectDelegationRunAuthority(
  config: RunConfig,
): readonly DelegationAuthorityDimensionInput[] {
  const workspace = config.workspace === null
    ? []
    : [config.workspace.primary, ...config.workspace.additional].map(({ id }) => id);
  const tools = config.tools.tools.map(({ registration }) =>
    toolRevisionKey(registration.descriptor.ref));
  const permissionProjection = {
    profile: config.permissions.permissionProfile,
    approvalPolicy: config.permissions.approvalPolicy,
    rules: config.permissions.rules,
    networkRules: config.permissions.networkRules,
    managedConstraints: config.permissions.managedConstraints,
    approvalLimits: config.permissions.approvalLimits,
    authorityApplicationLimits: config.permissions.authorityApplicationLimits,
  };
  const actionProjection = config.actionExecution === null
    ? null
    : {
        policySnapshotId: config.actionExecution.policySnapshotId,
        securityContext: config.actionExecution.securityContext,
        enforcement: config.actionExecution.enforcement,
        metadata: config.actionExecution.metadata,
      };
  const validationAllowed = [
    `${config.validation.profile.ref.owner}/${config.validation.profile.ref.kind}/${config.validation.profile.ref.id}@${config.validation.profile.ref.revision}`,
    `specification:${config.validation.profile.specification.id}@${config.validation.profile.specification.revision}`,
  ];
  const validationRequired = config.validation.profile.requirements.map(
    ({ ref }) => `${ref.id}@${ref.revision}`,
  );
  return deepFreeze([
    { kind: "workspace", allowed: workspace, required: [] },
    { kind: "tool", allowed: tools, required: [] },
    {
      kind: "permission",
      allowed: [createDelegationContractIdentity(
        "agent-anything.delegation-permission-authority.v1",
        permissionProjection,
      )],
      required: [
        `enforcement:${config.permissions.permissionProfile.enforcement}`,
        `managed:${config.permissions.permissionProfile.managedConstraintSetId}`,
        "no_delegated_approval",
      ],
    },
    {
      kind: "action_execution",
      allowed: actionProjection === null
        ? []
        : [createDelegationContractIdentity(
            "agent-anything.delegation-action-execution-authority.v1",
            actionProjection,
          )],
      required: actionProjection === null
        ? []
        : [`enforcement:${config.actionExecution!.enforcement}`],
    },
    {
      kind: "validation",
      allowed: validationAllowed,
      required: validationRequired,
    },
    {
      kind: "disclosure",
      allowed: DISCLOSURE_ALLOWED,
      required: DISCLOSURE_REQUIRED,
    },
  ]);
}

export function projectDelegationRunLimits(input: {
  readonly config: RunConfig;
  readonly maxContextBytes: number;
  readonly maxResultBytes: number;
}): DelegationLimits {
  return createDelegationLimits({
    maxControllerTurns: input.config.limits.maxIterations,
    maxActions: input.config.limits.maxActions,
    maxDurationMs: input.config.limits.maxDurationMs,
    maxContextBytes: input.maxContextBytes,
    maxResultBytes: input.maxResultBytes,
  });
}

export function assertDelegationAuthorityRequestWithinCeiling(input: {
  readonly requested: readonly DelegationAuthorityDimensionInput[];
  readonly ceiling: readonly DelegationAuthorityDimensionInput[];
}): void {
  for (const ceiling of input.ceiling) {
    const requested = input.requested.find(({ kind }) => kind === ceiling.kind);
    if (requested === undefined) {
      throw new TypeError(`Delegation request omits authority dimension '${ceiling.kind}'.`);
    }
    if (requested.allowed.some((value) => !ceiling.allowed.includes(value))) {
      throw new TypeError(`Delegation request widens '${ceiling.kind}' allowed authority.`);
    }
    if (ceiling.required.some((value) => !requested.required.includes(value))) {
      throw new TypeError(`Delegation request weakens '${ceiling.kind}' required authority.`);
    }
  }
}

export function deriveDelegatedRunConfig(input: {
  readonly parent: RunConfig;
  readonly request: DelegationRequest;
  readonly authority: DelegationAuthorityDerivation;
}): RunConfig {
  if (
    input.request.authorityDerivation.id !== input.authority.ref.id ||
    input.request.authorityDerivation.revision !== input.authority.ref.revision
  ) {
    throw new TypeError("Delegation request and authority derivation do not match.");
  }
  const workspace = restrictWorkspace(
    input.parent.workspace,
    effective(input.authority, "workspace").allowed,
  );
  const tools = restrictTools(
    input.parent.tools,
    effective(input.authority, "tool").allowed,
  );
  const permissions = Object.freeze({
    ...input.parent.permissions,
    sessionAuthority: input.parent.permissions.sessionAuthority === null
      ? null
      : Object.freeze({
          ...input.parent.permissions.sessionAuthority,
          initialRecords: Object.freeze([]),
        }),
  });
  const config: RunConfig = Object.freeze({
    workspace,
    identity: input.parent.identity,
    permissions,
    tools,
    actionExecution: input.parent.actionExecution,
    validation: input.parent.validation,
    limits: Object.freeze({
      ...input.parent.limits,
      maxIterations: Math.min(
        input.parent.limits.maxIterations,
        input.request.limits.maxControllerTurns,
      ),
      maxActions: Math.min(
        input.parent.limits.maxActions,
        input.request.limits.maxActions,
      ),
      maxDurationMs: Math.min(
        input.parent.limits.maxDurationMs,
        input.request.limits.maxDurationMs,
      ),
    }),
    audit: input.parent.audit,
    telemetry: input.parent.telemetry,
    cancellationLimits: input.parent.cancellationLimits,
    retry: input.parent.retry,
    metadata: Object.freeze({
      delegationRequestId: input.request.ref.id,
      delegationRequestRevision: input.request.ref.revision,
      rootRunId: input.request.origin.root.run.id,
      parentRunId: input.request.origin.parent.run.id,
    }),
  });
  assertConfigurationWithinEffectiveAuthority(config, input.authority.effective);
  return config;
}

function restrictWorkspace(
  parent: WorkspaceSelection | null,
  allowed: readonly string[],
): WorkspaceSelection | null {
  if (parent === null) {
    if (allowed.length > 0) {
      throw new TypeError("Delegation cannot create Workspace authority.");
    }
    return null;
  }
  if (!allowed.includes(parent.primary.id)) {
    throw new TypeError("Delegation cannot remove the primary Workspace from an active Run.");
  }
  return Object.freeze({
    primary: parent.primary,
    additional: Object.freeze(
      parent.additional.filter(({ id }) => allowed.includes(id)),
    ),
  });
}

function restrictTools(
  parent: ToolSelectionRevision,
  allowed: readonly string[],
): ToolSelectionRevision {
  const tools = Object.freeze(parent.tools.filter(({ registration }) =>
    allowed.includes(toolRevisionKey(registration.descriptor.ref))));
  const material = {
    toolCatalogId: parent.toolCatalogId,
    operationCatalogId: parent.operationCatalogId,
    operationCatalogRevision: parent.operationCatalogRevision,
    tools: tools.map((selected) => ({
      tool: selected.registration.descriptor.ref,
      origins: selected.origins,
    })),
  };
  const selectionId = createToolContractIdentity(
    "agent-anything.fixed-local-tool-selection.v3",
    material,
  );
  return Object.freeze({
    schemaVersion: 3 as const,
    selectionId,
    revision: selectionId,
    toolCatalogId: parent.toolCatalogId,
    operationCatalogId: parent.operationCatalogId,
    operationCatalogRevision: parent.operationCatalogRevision,
    tools,
  });
}

function assertConfigurationWithinEffectiveAuthority(
  config: RunConfig,
  dimensions: readonly DelegationAuthorityDimension[],
): void {
  const projected = projectDelegationRunAuthority(config);
  for (const dimension of dimensions) {
    const actual = projected.find(({ kind }) => kind === dimension.kind)!;
    if (actual.allowed.some((value) => !dimension.allowed.includes(value))) {
      throw new TypeError(`Delegated Run config widens '${dimension.kind}' authority.`);
    }
    if (dimension.required.some((value) => !actual.required.includes(value))) {
      throw new TypeError(`Delegated Run config weakens '${dimension.kind}' requirements.`);
    }
  }
}

function effective(
  derivation: DelegationAuthorityDerivation,
  kind: DelegationAuthorityDimension["kind"],
): DelegationAuthorityDimension {
  const dimension = derivation.effective.find((candidate) => candidate.kind === kind);
  if (dimension === undefined) {
    throw new TypeError(`Delegation authority omits '${kind}'.`);
  }
  return dimension;
}
