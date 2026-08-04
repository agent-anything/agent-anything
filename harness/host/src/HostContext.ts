import {
  snapshotIdentityRef,
  snapshotRunWorkspace,
  type IdentityRef,
  type Metadata,
  type RunWorkspace,
} from "@agent-anything/foundation";

export type HostWorkspaceSelection =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "references";
      readonly primaryRef: string;
      readonly additionalRefs: readonly string[];
    };

export type HostIdentitySelection =
  | {
      readonly kind: "anonymous";
    }
  | {
      readonly kind: "reference";
      readonly identityRef: string;
    };

interface HostContextResolutionInputBase {
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly metadata: Metadata;
}

export interface HostWorkspaceResolutionInput
  extends HostContextResolutionInputBase {
  readonly selection: HostWorkspaceSelection;
}

export interface HostIdentityResolutionInput
  extends HostContextResolutionInputBase {
  readonly selection: HostIdentitySelection;
}

export interface HostWorkspaceResolver {
  resolve(input: HostWorkspaceResolutionInput): Promise<RunWorkspace | null>;
}

export interface HostIdentityResolver {
  resolve(input: HostIdentityResolutionInput): Promise<IdentityRef>;
}

export type HostWorkspaceRequirement = "optional" | "required";

export interface ResolveHostRunContextInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly metadata: Metadata;
  readonly workspaceResolver: HostWorkspaceResolver;
  readonly identityResolver: HostIdentityResolver;
  readonly workspaceSelection: HostWorkspaceSelection;
  readonly identitySelection: HostIdentitySelection;
  readonly workspaceRequirement: HostWorkspaceRequirement;
}

export interface ResolvedHostRunContext {
  readonly workspace: RunWorkspace | null;
  readonly identity: IdentityRef;
}

export type HostContextResolutionErrorCode =
  | "host_context_input_invalid"
  | "host_workspace_resolver_unavailable"
  | "host_identity_resolver_unavailable"
  | "host_workspace_selection_invalid"
  | "host_identity_selection_invalid"
  | "host_workspace_required"
  | "host_workspace_resolution_failed"
  | "host_workspace_resolution_invalid"
  | "host_identity_resolution_failed"
  | "host_identity_resolution_invalid"
  | "host_identity_rejected";

export class HostContextResolutionError extends Error {
  constructor(
    readonly code: HostContextResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostContextResolutionError";
  }
}

export async function resolveHostRunContext(
  input: ResolveHostRunContextInput,
): Promise<ResolvedHostRunContext> {
  const correlation = snapshotResolutionInputBase(input);
  assertResolver(
    input.workspaceResolver,
    "host_workspace_resolver_unavailable",
    "Host Workspace resolution requires a resolver.",
  );
  assertResolver(
    input.identityResolver,
    "host_identity_resolver_unavailable",
    "Host Identity resolution requires a resolver.",
  );
  assertWorkspaceRequirement(input.workspaceRequirement);

  const workspaceInput = snapshotWorkspaceResolutionInput(
    correlation,
    input.workspaceSelection,
  );
  const identityInput = snapshotIdentityResolutionInput(
    correlation,
    input.identitySelection,
  );
  const workspace = await resolveWorkspace(input.workspaceResolver, workspaceInput);
  if (
    workspaceInput.selection.kind === "none" &&
    workspace !== null
  ) {
    throw new HostContextResolutionError(
      "host_workspace_resolution_invalid",
      "An explicit no-Workspace selection must resolve to null.",
    );
  }
  if (
    workspaceInput.selection.kind === "references" &&
    workspace === null
  ) {
    throw new HostContextResolutionError(
      input.workspaceRequirement === "required"
        ? "host_workspace_required"
        : "host_workspace_resolution_invalid",
      "A referenced Workspace selection did not resolve to a Run Workspace.",
    );
  }
  if (input.workspaceRequirement === "required" && workspace === null) {
    throw new HostContextResolutionError(
      "host_workspace_required",
      "This Run requires a resolved Workspace.",
    );
  }

  const identity = await resolveIdentity(input.identityResolver, identityInput);
  if (
    identityInput.selection.kind === "anonymous" &&
    identity.kind !== "anonymous"
  ) {
    throw new HostContextResolutionError(
      "host_identity_resolution_invalid",
      "An explicit anonymous selection must resolve to anonymous Identity.",
    );
  }
  if (
    identityInput.selection.kind === "reference" &&
    identity.kind === "anonymous"
  ) {
    throw new HostContextResolutionError(
      "host_identity_resolution_invalid",
      "A referenced Identity selection cannot resolve to anonymous Identity.",
    );
  }

  return Object.freeze({ workspace, identity });
}

export function createStaticHostWorkspaceResolver(
  workspace: RunWorkspace | null,
): HostWorkspaceResolver {
  const snapshot = workspace === null ? null : snapshotRunWorkspace(workspace);
  return Object.freeze({
    async resolve(): Promise<RunWorkspace | null> {
      return snapshot;
    },
  });
}

export function createStaticHostIdentityResolver(
  identity: IdentityRef,
): HostIdentityResolver {
  const snapshot = snapshotIdentityRef(identity);
  return Object.freeze({
    async resolve(): Promise<IdentityRef> {
      return snapshot;
    },
  });
}

async function resolveWorkspace(
  resolver: HostWorkspaceResolver,
  input: HostWorkspaceResolutionInput,
): Promise<RunWorkspace | null> {
  let candidate: RunWorkspace | null;
  try {
    candidate = await resolver.resolve(input);
  } catch (error) {
    if (error instanceof HostContextResolutionError) {
      throw error;
    }
    throw new HostContextResolutionError(
      "host_workspace_resolution_failed",
      "Host Workspace resolution failed.",
    );
  }

  if (candidate === null) {
    return null;
  }
  try {
    return snapshotRunWorkspace(candidate);
  } catch {
    throw new HostContextResolutionError(
      "host_workspace_resolution_invalid",
      "Host Workspace resolver returned an invalid Run Workspace.",
    );
  }
}

async function resolveIdentity(
  resolver: HostIdentityResolver,
  input: HostIdentityResolutionInput,
): Promise<IdentityRef> {
  let candidate: IdentityRef;
  try {
    candidate = await resolver.resolve(input);
  } catch (error) {
    if (error instanceof HostContextResolutionError) {
      throw error;
    }
    throw new HostContextResolutionError(
      "host_identity_resolution_failed",
      "Host Identity resolution failed.",
    );
  }

  try {
    return snapshotIdentityRef(candidate);
  } catch {
    throw new HostContextResolutionError(
      "host_identity_resolution_invalid",
      "Host Identity resolver returned an invalid Identity.",
    );
  }
}

function snapshotWorkspaceResolutionInput(
  correlation: HostContextResolutionInputBase,
  selection: HostWorkspaceSelection,
): HostWorkspaceResolutionInput {
  return Object.freeze({
    ...correlation,
    selection: snapshotWorkspaceSelection(selection),
  });
}

function snapshotIdentityResolutionInput(
  correlation: HostContextResolutionInputBase,
  selection: HostIdentitySelection,
): HostIdentityResolutionInput {
  return Object.freeze({
    ...correlation,
    selection: snapshotIdentitySelection(selection),
  });
}

function snapshotResolutionInputBase(
  input: ResolveHostRunContextInput,
): HostContextResolutionInputBase {
  if (!isRecord(input)) {
    throw new HostContextResolutionError(
      "host_context_input_invalid",
      "Host context resolution input must be an object.",
    );
  }
  assertNonEmpty(
    input.sessionId,
    "Host context sessionId",
    "host_context_input_invalid",
  );
  assertNonEmpty(
    input.runId,
    "Host context runId",
    "host_context_input_invalid",
  );
  assertNonEmpty(
    input.taskId,
    "Host context taskId",
    "host_context_input_invalid",
  );
  if (!isRecord(input.metadata)) {
    throw new HostContextResolutionError(
      "host_context_input_invalid",
      "Host context metadata must be an object.",
    );
  }
  return Object.freeze({
    sessionId: input.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    metadata: Object.freeze({ ...input.metadata }),
  });
}

function snapshotWorkspaceSelection(
  selection: HostWorkspaceSelection,
): HostWorkspaceSelection {
  if (!isRecord(selection)) {
    throw new HostContextResolutionError(
      "host_workspace_selection_invalid",
      "Host Workspace selection must be an object.",
    );
  }
  if (selection.kind === "none") {
    return Object.freeze({ kind: "none" });
  }
  if (
    selection.kind !== "references" ||
    !Array.isArray(selection.additionalRefs)
  ) {
    throw new HostContextResolutionError(
      "host_workspace_selection_invalid",
      "Host Workspace selection is invalid.",
    );
  }
  assertNonEmpty(
    selection.primaryRef,
    "Host Workspace primary reference",
    "host_workspace_selection_invalid",
  );
  const references = [selection.primaryRef, ...selection.additionalRefs];
  const unique = new Set<string>();
  for (const reference of references) {
    assertNonEmpty(
      reference,
      "Host Workspace reference",
      "host_workspace_selection_invalid",
    );
    if (unique.has(reference)) {
      throw new HostContextResolutionError(
        "host_workspace_selection_invalid",
        `Host Workspace reference '${reference}' is duplicated.`,
      );
    }
    unique.add(reference);
  }
  return Object.freeze({
    kind: "references",
    primaryRef: selection.primaryRef,
    additionalRefs: Object.freeze([...selection.additionalRefs]),
  });
}

function snapshotIdentitySelection(
  selection: HostIdentitySelection,
): HostIdentitySelection {
  if (!isRecord(selection)) {
    throw new HostContextResolutionError(
      "host_identity_selection_invalid",
      "Host Identity selection must be an object.",
    );
  }
  if (selection.kind === "anonymous") {
    return Object.freeze({ kind: "anonymous" });
  }
  if (selection.kind !== "reference") {
    throw new HostContextResolutionError(
      "host_identity_selection_invalid",
      "Host Identity selection is invalid.",
    );
  }
  assertNonEmpty(
    selection.identityRef,
    "Host Identity reference",
    "host_identity_selection_invalid",
  );
  return Object.freeze({
    kind: "reference",
    identityRef: selection.identityRef,
  });
}

function assertResolver(
  resolver: unknown,
  code: Extract<
    HostContextResolutionErrorCode,
    "host_workspace_resolver_unavailable" | "host_identity_resolver_unavailable"
  >,
  message: string,
): asserts resolver is { resolve(input: unknown): Promise<unknown> } {
  if (!isRecord(resolver) || typeof resolver.resolve !== "function") {
    throw new HostContextResolutionError(code, message);
  }
}

function assertWorkspaceRequirement(
  requirement: unknown,
): asserts requirement is HostWorkspaceRequirement {
  if (requirement !== "optional" && requirement !== "required") {
    throw new HostContextResolutionError(
      "host_workspace_selection_invalid",
      "Host Workspace requirement must be optional or required.",
    );
  }
}

function assertNonEmpty(
  value: unknown,
  field: string,
  code:
    | "host_context_input_invalid"
    | "host_workspace_selection_invalid"
    | "host_identity_selection_invalid",
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HostContextResolutionError(
      code,
      `${field} must be a non-empty string.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
