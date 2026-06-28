import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import { FileToolError } from "../file-tools/FileToolError.js";
import {
  resolveExistingTarget,
  resolveWritableTarget,
  type ExistingWorkspaceTarget,
  type WritableWorkspaceTarget,
} from "../file-tools/filesystemBoundary.js";
import { decodeUtf8 } from "../file-tools/utf8.js";
import type {
  AcceptedPatchDecision,
  AcceptedPatchStatus,
  AppliedPatchStatus,
  CreatePatchOperation,
  DeletePatchOperation,
  FailedPatchStatus,
  PatchContentReference,
  PatchFailureCode,
  PatchId,
  PatchOperation,
  PatchProposal,
  ProposedPatchStatus,
  RejectedPatchStatus,
  UpdatePatchOperation,
} from "./PatchContracts.js";
import { PatchWorkflowError } from "./PatchWorkflowError.js";

export interface PatchWorkflowLimits {
  maxContentBytes: number;
}

export const defaultPatchWorkflowLimits: PatchWorkflowLimits = {
  maxContentBytes: 1_000_000,
};

export type PatchProposalChange =
  | { kind: "create"; path: string; proposedContent: string }
  | { kind: "update"; path: string; proposedContent: string }
  | { kind: "delete"; path: string };

export interface CreatePatchProposalInput {
  workspaceScope: TaskWorkspaceScope | undefined;
  rootName?: string;
  change: PatchProposalChange;
  summary: string;
  rationale: string;
  metadata?: Metadata;
}

export interface CreatePatchProposalOptions {
  limits?: Partial<PatchWorkflowLimits>;
  now?: () => ISODateTimeString;
  createPatchId?: () => PatchId;
}

export interface AcceptPatchOptions {
  reason?: string;
  metadata?: Metadata;
  now?: () => ISODateTimeString;
}

export interface RejectPatchInput {
  reason: string;
  metadata?: Metadata;
  now?: () => ISODateTimeString;
}

export interface ApplyAcceptedPatchInput {
  patch: AcceptedPatchStatus;
  workspaceScope: TaskWorkspaceScope | undefined;
  limits?: Partial<PatchWorkflowLimits>;
  now?: () => ISODateTimeString;
}

export interface MaterializePatchReviewInput {
  patch: ProposedPatchStatus;
  workspaceScope: TaskWorkspaceScope | undefined;
  limits?: Partial<PatchWorkflowLimits>;
}

export interface MaterializedPatchReview {
  patchId: PatchId;
  rootName: string;
  workspaceId: string;
  path: string;
  operation: PatchOperation["kind"];
  summary: string;
  rationale: string;
  originalContent: string | null;
  proposedContent: string | null;
  originalContentBytes: number | null;
  proposedContentBytes: number | null;
  metadata: Metadata;
}

export async function createPatchProposal(
  input: CreatePatchProposalInput,
  options: CreatePatchProposalOptions = {},
): Promise<ProposedPatchStatus> {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? defaultNow;
  const patchId = options.createPatchId?.() ?? "patch_" + randomUUID();

  requireNonEmpty(patchId, "Patch id is required.");
  requireNonEmpty(input.summary, "Patch summary is required.");
  requireNonEmpty(input.rationale, "Patch rationale is required.");

  try {
    const operation = await createOperation(input, limits);
    const proposal: PatchProposal = {
      id: patchId,
      rootName: operation.target.resolved.rootName,
      workspaceId: operation.target.resolved.workspaceId,
      operation: operation.value,
      summary: input.summary,
      rationale: input.rationale,
      createdAt: now(),
      metadata: input.metadata ?? {},
    };

    return { status: "proposed", proposal };
  } catch (error) {
    throw toPatchWorkflowError(error, input.change.kind, "proposal");
  }
}

export function acceptPatch(
  patch: ProposedPatchStatus,
  options: AcceptPatchOptions = {},
): AcceptedPatchStatus {
  assertProposedPatch(patch);
  if (options.reason !== undefined) {
    requireNonEmpty(options.reason, "Accepted patch reason must not be empty.");
  }

  const decision: AcceptedPatchDecision = {
    status: "accepted",
    patchId: patch.proposal.id,
    decidedAt: (options.now ?? defaultNow)(),
    metadata: options.metadata ?? {},
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };

  return { status: "accepted", proposal: patch.proposal, decision };
}

export function rejectPatch(
  patch: ProposedPatchStatus,
  input: RejectPatchInput,
): RejectedPatchStatus {
  assertProposedPatch(patch);
  requireNonEmpty(input.reason, "Rejected patch reason is required.");

  return {
    status: "rejected",
    proposal: patch.proposal,
    decision: {
      status: "rejected",
      patchId: patch.proposal.id,
      decidedAt: (input.now ?? defaultNow)(),
      reason: input.reason,
      metadata: input.metadata ?? {},
    },
  };
}

export async function applyAcceptedPatch(
  input: ApplyAcceptedPatchInput,
): Promise<AppliedPatchStatus | FailedPatchStatus> {
  const now = input.now ?? defaultNow;

  try {
    const limits = resolveLimits(input.limits);
    assertAcceptedPatch(input.patch);
    await applyOperation(input.patch.proposal, input.workspaceScope, limits);

    return {
      status: "applied",
      proposal: input.patch.proposal,
      decision: input.patch.decision,
      result: {
        status: "applied",
        patchId: input.patch.proposal.id,
        appliedAt: now(),
        metadata: resultMetadata(input.patch.proposal),
      },
    };
  } catch (error) {
    const operationKind = input.patch?.proposal?.operation?.kind ?? "update";
    const workflowError = toPatchWorkflowError(error, operationKind, "apply");
    return {
      status: "failed",
      proposal: input.patch.proposal,
      decision: input.patch.decision,
      result: {
        status: "failed",
        patchId: input.patch.proposal.id,
        failedAt: now(),
        code: workflowError.code,
        message: workflowError.message,
        metadata: {
          ...resultMetadata(input.patch.proposal),
          ...workflowError.metadata,
        },
      },
    };
  }
}

export async function materializePatchReview(
  input: MaterializePatchReviewInput,
): Promise<MaterializedPatchReview> {
  assertProposedPatch(input.patch);
  const limits = resolveLimits(input.limits);
  const { proposal } = input.patch;
  const { operation } = proposal;
  let originalContent: string | null = null;
  let originalContentBytes: number | null = null;

  if (operation.kind === "update" || operation.kind === "delete") {
    const current = await readExistingPatchTarget(
      input.workspaceScope,
      proposal.rootName,
      operation.path,
      limits,
      "apply",
    );
    assertWorkspaceIdentity(proposal, current.target.resolved.workspaceId);
    assertContentReference(operation.originalContent, current.reference);
    originalContent = current.content;
    originalContentBytes = current.reference.byteLength;
  }

  const proposedContent = operation.kind === "delete"
    ? null
    : operation.proposedContent;
  if (proposedContent !== null) {
    assertContentLimit(proposedContent, limits);
  }

  return {
    patchId: proposal.id,
    rootName: proposal.rootName,
    workspaceId: proposal.workspaceId,
    path: operation.path,
    operation: operation.kind,
    summary: proposal.summary,
    rationale: proposal.rationale,
    originalContent,
    proposedContent,
    originalContentBytes,
    proposedContentBytes: proposedContent === null
      ? null
      : Buffer.byteLength(proposedContent, "utf8"),
    metadata: proposal.metadata,
  };
}

async function createOperation(
  input: CreatePatchProposalInput,
  limits: PatchWorkflowLimits,
): Promise<
  | { value: CreatePatchOperation; target: WritableWorkspaceTarget }
  | { value: UpdatePatchOperation; target: ExistingWorkspaceTarget }
  | { value: DeletePatchOperation; target: ExistingWorkspaceTarget }
> {
  const { change } = input;

  if (change.kind === "create") {
    assertContentLimit(change.proposedContent, limits);
    const target = await resolveWritableTarget({
      workspaceScope: input.workspaceScope,
      rootName: input.rootName,
      path: change.path,
      overwrite: false,
    });
    return {
      value: {
        kind: "create",
        path: target.resolved.relativePath,
        proposedContent: change.proposedContent,
      },
      target,
    };
  }

  if (change.kind === "update") {
    assertContentLimit(change.proposedContent, limits);
  }

  const current = await readExistingPatchTarget(
    input.workspaceScope,
    input.rootName,
    change.path,
    limits,
    "proposal",
  );

  if (change.kind === "update") {
    return {
      value: {
        kind: "update",
        path: current.target.resolved.relativePath,
        originalContent: current.reference,
        proposedContent: change.proposedContent,
      },
      target: current.target,
    };
  }

  return {
    value: {
      kind: "delete",
      path: current.target.resolved.relativePath,
      originalContent: current.reference,
    },
    target: current.target,
  };
}

async function applyOperation(
  proposal: PatchProposal,
  workspaceScope: TaskWorkspaceScope | undefined,
  limits: PatchWorkflowLimits,
): Promise<void> {
  const { operation } = proposal;

  if (operation.kind === "create") {
    assertContentLimit(operation.proposedContent, limits);
    const target = await resolveWritableTarget({
      workspaceScope,
      rootName: proposal.rootName,
      path: operation.path,
      overwrite: false,
    });
    assertWorkspaceIdentity(proposal, target.resolved.workspaceId);
    try {
      await writeFile(target.canonicalTarget, operation.proposedContent, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new PatchWorkflowError(
          "patch_stale",
          "The create target appeared after this patch was proposed.",
        );
      }
      throw error;
    }
    return;
  }

  if (operation.kind === "update") {
    assertContentLimit(operation.proposedContent, limits);
  }

  const current = await readExistingPatchTarget(
    workspaceScope,
    proposal.rootName,
    operation.path,
    limits,
    "apply",
  );
  assertWorkspaceIdentity(proposal, current.target.resolved.workspaceId);
  assertContentReference(operation.originalContent, current.reference);

  if (operation.kind === "update") {
    await writeFile(current.target.canonicalTarget, operation.proposedContent, {
      encoding: "utf8",
      flag: "w",
    });
    return;
  }

  await unlink(current.target.canonicalTarget);
}

async function readExistingPatchTarget(
  workspaceScope: TaskWorkspaceScope | undefined,
  rootName: string | undefined,
  path: string,
  limits: PatchWorkflowLimits,
  stage: "proposal" | "apply",
): Promise<{
  target: ExistingWorkspaceTarget;
  reference: PatchContentReference;
  content: string;
}> {
  const target = await resolveExistingTarget({
    workspaceScope,
    rootName,
    path,
    expectedKind: "file",
  });
  const requestedStats = await lstat(target.resolved.absolutePath);
  if (requestedStats.isSymbolicLink()) {
    throw new PatchWorkflowError(
      "patch_path_unsafe",
      "Patch targets must not be symbolic links.",
      pathMetadata(target),
    );
  }
  if (target.stats.size > limits.maxContentBytes) {
    throw contentLimitError(target.stats.size, limits.maxContentBytes);
  }

  const bytes = await readFile(target.canonicalTarget);
  if (bytes.byteLength > limits.maxContentBytes) {
    throw contentLimitError(bytes.byteLength, limits.maxContentBytes);
  }
  const content = decodeUtf8(bytes);
  if (content === null) {
    throw new PatchWorkflowError(
      stage === "apply" ? "patch_stale" : "patch_state_invalid",
      stage === "apply"
        ? "The target content changed after this patch was proposed."
        : "Patch targets must contain valid UTF-8 text.",
      pathMetadata(target),
    );
  }

  return { target, reference: createContentReference(bytes), content };
}

function createContentReference(bytes: Uint8Array): PatchContentReference {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function assertContentReference(
  expected: PatchContentReference,
  actual: PatchContentReference,
): void {
  if (
    expected.algorithm !== "sha256" ||
    expected.byteLength !== actual.byteLength ||
    expected.digest !== actual.digest
  ) {
    throw new PatchWorkflowError(
      "patch_stale",
      "The target content changed after this patch was proposed.",
    );
  }
}

function assertWorkspaceIdentity(
  proposal: PatchProposal,
  workspaceId: string,
): void {
  if (proposal.workspaceId !== workspaceId) {
    throw new PatchWorkflowError(
      "patch_state_invalid",
      "The selected workspace does not match this patch proposal.",
      {
        expectedWorkspaceId: proposal.workspaceId,
        actualWorkspaceId: workspaceId,
      },
    );
  }
}

function assertProposedPatch(patch: ProposedPatchStatus): void {
  if (patch?.status !== "proposed") {
    throw new PatchWorkflowError(
      "patch_state_invalid",
      "Only a proposed patch can be accepted or rejected.",
    );
  }
  requireNonEmpty(patch.proposal.id, "Patch id is required.");
}

function assertAcceptedPatch(patch: AcceptedPatchStatus): void {
  if (patch?.status !== "accepted" || patch.decision?.status !== "accepted") {
    throw new PatchWorkflowError(
      "patch_state_invalid",
      "Only an accepted patch can be applied.",
    );
  }
  assertPatchProposal(patch.proposal);
  if (patch.decision.patchId !== patch.proposal.id) {
    throw new PatchWorkflowError(
      "patch_state_invalid",
      "Patch decision identity does not match the proposal.",
    );
  }
}

function assertPatchProposal(proposal: PatchProposal): void {
  requireNonEmpty(proposal.id, "Patch id is required.");
  requireNonEmpty(proposal.rootName, "Patch root name is required.");
  requireNonEmpty(proposal.workspaceId, "Patch workspace id is required.");
  requireNonEmpty(proposal.operation.path, "Patch path is required.");

  if (
    proposal.operation.kind === "create" ||
    proposal.operation.kind === "update"
  ) {
    if (typeof proposal.operation.proposedContent !== "string") {
      throw new PatchWorkflowError(
        "patch_state_invalid",
        "Patch proposed content must be a string.",
      );
    }
  }

  if (
    proposal.operation.kind === "update" ||
    proposal.operation.kind === "delete"
  ) {
    assertOriginalContentReference(proposal.operation.originalContent);
  }
}

function assertOriginalContentReference(
  reference: PatchContentReference,
): void {
  if (
    reference?.algorithm !== "sha256" ||
    typeof reference.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(reference.digest) ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 0
  ) {
    throw new PatchWorkflowError(
      "patch_state_invalid",
      "Patch original content reference is invalid.",
    );
  }
}

function resolveLimits(
  input: Partial<PatchWorkflowLimits> | undefined,
): PatchWorkflowLimits {
  const limits = { ...defaultPatchWorkflowLimits, ...input };
  if (
    !Number.isSafeInteger(limits.maxContentBytes) ||
    limits.maxContentBytes <= 0
  ) {
    throw new PatchWorkflowError(
      "patch_state_invalid",
      "Patch workflow limits must be positive safe integers.",
      { limit: "maxContentBytes", value: limits.maxContentBytes },
    );
  }
  return limits;
}

function assertContentLimit(
  content: string,
  limits: PatchWorkflowLimits,
): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > limits.maxContentBytes) {
    throw contentLimitError(sizeBytes, limits.maxContentBytes);
  }
}

function contentLimitError(
  sizeBytes: number,
  maxContentBytes: number,
): PatchWorkflowError {
  return new PatchWorkflowError(
    "patch_state_invalid",
    "Patch content exceeds the configured byte limit.",
    { sizeBytes, maxContentBytes },
  );
}

function requireNonEmpty(value: string, message: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PatchWorkflowError("patch_state_invalid", message);
  }
}

function toPatchWorkflowError(
  error: unknown,
  operation: PatchOperation["kind"],
  stage: "proposal" | "apply",
): PatchWorkflowError {
  if (error instanceof PatchWorkflowError) {
    return error;
  }

  if (error instanceof FileToolError) {
    if (isUnsafePathCode(error.code)) {
      return new PatchWorkflowError(
        "patch_path_unsafe",
        "Patch path is not safe for the selected workspace.",
        error.metadata,
      );
    }
    if (
      error.code === "file_already_exists" ||
      (error.code === "file_not_found" && operation !== "create")
    ) {
      return new PatchWorkflowError(
        "patch_stale",
        "The patch target no longer matches the proposal baseline.",
        error.metadata,
      );
    }
    if (stage === "proposal") {
      return new PatchWorkflowError(
        "patch_path_unsafe",
        "Patch target could not be resolved safely.",
        error.metadata,
      );
    }
  }

  if (isNodeError(error, "ENOENT") && operation !== "create") {
    return new PatchWorkflowError(
      "patch_stale",
      "The patch target no longer matches the proposal baseline.",
    );
  }

  return new PatchWorkflowError(
    stage === "apply" ? "patch_apply_failed" : "patch_path_unsafe",
    stage === "apply"
      ? "Patch application failed."
      : "Patch target could not be inspected safely.",
  );
}

function isUnsafePathCode(code: string): boolean {
  return (
    code.startsWith("workspace_") ||
    code === "requested_path_missing" ||
    code === "absolute_path_not_allowed" ||
    code === "path_outside_workspace" ||
    code === "file_not_file" ||
    code === "file_parent_not_directory"
  );
}

function pathMetadata(target: ExistingWorkspaceTarget): Metadata {
  return {
    rootName: target.resolved.rootName,
    workspaceId: target.resolved.workspaceId,
    path: target.resolved.relativePath,
  };
}

function resultMetadata(proposal: PatchProposal): Metadata {
  return {
    rootName: proposal.rootName,
    workspaceId: proposal.workspaceId,
    path: proposal.operation.path,
    operation: proposal.operation.kind,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function defaultNow(): ISODateTimeString {
  return new Date().toISOString();
}
