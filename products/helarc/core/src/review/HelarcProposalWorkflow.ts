import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type {
  CodeSourcePort,
  CodeSourceSnapshot,
} from "@agent-anything/helarc-code-agent/source";
import type {
  AcceptedPatchDecision,
  AcceptedPatchStatus,
  DeletePatchOperation,
  PatchDecisionSubmissionId,
  PatchOperation,
  PatchProposal,
  PatchProposalId,
  PatchProposalRevision,
  PatchReviewId,
  ProposedPatchStatus,
  RejectedPatchStatus,
  RevisionRequestedPatchStatus,
  UpdatePatchOperation,
} from "./HelarcProposalReview.js";
import { PatchWorkflowError } from "./HelarcProposalWorkflowError.js";

export interface PatchWorkflowLimits {
  readonly maxContentBytes: number;
}

export const defaultPatchWorkflowLimits: PatchWorkflowLimits = Object.freeze({
  maxContentBytes: 1_000_000,
});

export type PatchProposalChange =
  | { readonly kind: "create"; readonly path: string; readonly proposedContent: string }
  | { readonly kind: "update"; readonly path: string; readonly proposedContent: string }
  | { readonly kind: "delete"; readonly path: string };

export interface CreatePatchProposalInput {
  readonly runId: string;
  readonly workspace: WorkspaceSelection | null;
  readonly source: CodeSourcePort;
  readonly rootName?: string;
  readonly change: PatchProposalChange;
  readonly previousRevision?: PatchProposal;
  readonly producer: PatchProposal["producer"];
  readonly creationBasis: PatchProposal["creationBasis"];
  readonly sensitivity: PatchProposal["sensitivity"];
  readonly summary: string;
  readonly rationale: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CreatePatchProposalOptions {
  readonly limits?: Partial<PatchWorkflowLimits>;
  readonly now?: () => string;
  readonly createProposalId?: () => PatchProposalId;
}

export interface AcceptPatchInput {
  readonly runId: string;
  readonly proposalId: PatchProposalId;
  readonly proposalRevision: PatchProposalRevision;
  readonly reviewId: PatchReviewId;
  readonly requestVersion: number;
  readonly submissionId: PatchDecisionSubmissionId;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly now?: () => string;
}

export interface RejectPatchInput extends Omit<AcceptPatchInput, "reason"> {
  readonly reason: string;
}

export type RequestPatchRevisionInput = RejectPatchInput;

export interface MaterializePatchReviewInput {
  readonly patch: ProposedPatchStatus;
  readonly workspace: WorkspaceSelection | null;
  readonly source: CodeSourcePort;
  readonly limits?: Partial<PatchWorkflowLimits>;
  readonly createReviewId?: (proposal: PatchProposal) => PatchReviewId;
}

export interface MaterializedPatchReview {
  readonly runId: string;
  readonly proposalId: PatchProposalId;
  readonly proposalRevision: PatchProposalRevision;
  readonly reviewId: PatchReviewId;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly operation: PatchOperation["kind"];
  readonly summary: string;
  readonly rationale: string;
  readonly originalContent: string | null;
  readonly proposedContent: string | null;
  readonly originalContentBytes: number | null;
  readonly proposedContentBytes: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function createPatchProposal(
  input: CreatePatchProposalInput,
  options: CreatePatchProposalOptions = {},
): Promise<ProposedPatchStatus> {
  const limits = resolveLimits(options.limits);
  const runId = required(input.runId, "Patch proposal Run id is required.");
  const summary = required(input.summary, "Patch summary is required.");
  const rationale = required(input.rationale, "Patch rationale is required.");
  required(input.change.path, "Patch path is required.");
  if (input.change.kind !== "delete") assertContentLimit(input.change.proposedContent, limits);
  const captured = await input.source.capture({
    workspace: input.workspace,
    ...(input.rootName === undefined ? {} : { rootName: input.rootName }),
    path: input.change.path,
    operation: input.change.kind,
    maxContentBytes: limits.maxContentBytes,
  });
  if (captured.status !== "captured") throw sourceError(captured);
  assertSnapshotForChange(captured.snapshot, input.change);
  const prior = input.previousRevision;
  if (prior !== undefined && prior.runId !== runId) {
    throw invalidState("A proposal revision must remain in the same Run.");
  }
  const proposalId = prior === undefined
    ? required(
        options.createProposalId?.() ?? `patch_proposal_${randomUUID()}`,
        "Patch proposal id is required.",
      )
    : prior.id;
  const revision = prior === undefined ? 1 : positiveInteger(
    prior.revision + 1,
    "Patch proposal revision",
  );
  const proposal: PatchProposal = Object.freeze({
    id: proposalId,
    revision,
    previousRevision: prior === undefined
      ? null
      : Object.freeze({ proposalId: prior.id, revision: prior.revision }),
    runId,
    rootName: captured.snapshot.target.rootName,
    workspaceId: captured.snapshot.target.workspaceId,
    operation: operationFromChange(input.change, captured.snapshot),
    sourceSnapshot: captured.snapshot,
    producer: snapshotProducer(input.producer),
    creationBasis: snapshotCreationBasis(input.creationBasis),
    sensitivity: snapshotSensitivity(input.sensitivity),
    summary,
    rationale,
    createdAt: isoDate((options.now ?? defaultNow)()),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
  return Object.freeze({ status: "proposed" as const, proposal });
}

export async function materializePatchReview(
  input: MaterializePatchReviewInput,
): Promise<MaterializedPatchReview> {
  assertProposedPatch(input.patch);
  const limits = resolveLimits(input.limits);
  const { proposal } = input.patch;
  const rehydrated = await input.source.rehydrate({
    workspace: input.workspace,
    expected: proposal.sourceSnapshot,
    maxContentBytes: limits.maxContentBytes,
  });
  if (rehydrated.status !== "matched") throw sourceError(rehydrated);
  const current = rehydrated.snapshot;
  assertSnapshotMatchesProposal(current, proposal);
  const reviewId = required(
    input.createReviewId?.(proposal) ?? `patch_review_${randomUUID()}`,
    "Patch review id is required.",
  );
  const originalContent = proposal.operation.kind === "create" ? null : current.content;
  const proposedContent = proposal.operation.kind === "delete"
    ? null
    : proposal.operation.proposedContent;
  if (proposedContent !== null) assertContentLimit(proposedContent, limits);
  return Object.freeze({
    runId: proposal.runId,
    proposalId: proposal.id,
    proposalRevision: proposal.revision,
    reviewId,
    rootName: proposal.rootName,
    workspaceId: proposal.workspaceId,
    path: proposal.operation.path,
    operation: proposal.operation.kind,
    summary: proposal.summary,
    rationale: proposal.rationale,
    originalContent,
    proposedContent,
    originalContentBytes: current.contentRef?.byteLength ?? null,
    proposedContentBytes: proposedContent === null
      ? null
      : Buffer.byteLength(proposedContent, "utf8"),
    metadata: Object.freeze({ ...proposal.metadata }),
  });
}

export function acceptPatch(
  patch: ProposedPatchStatus,
  input: AcceptPatchInput,
): AcceptedPatchStatus {
  assertProposedPatch(patch);
  assertDecisionCorrelation(patch, input);
  const decision: AcceptedPatchDecision = Object.freeze({
    status: "accepted" as const,
    runId: input.runId,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    reviewId: required(input.reviewId, "Patch review id is required."),
    requestVersion: positiveInteger(input.requestVersion, "Patch review request version"),
    submissionId: required(input.submissionId, "Patch submission id is required."),
    decidedAt: isoDate((input.now ?? defaultNow)()),
    ...(input.reason === undefined ? {} : { reason: required(input.reason, "Accepted reason is invalid.") }),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
  return Object.freeze({ status: "accepted" as const, proposal: patch.proposal, decision });
}

export function rejectPatch(
  patch: ProposedPatchStatus,
  input: RejectPatchInput,
): RejectedPatchStatus {
  assertProposedPatch(patch);
  assertDecisionCorrelation(patch, input);
  return Object.freeze({
    status: "rejected" as const,
    proposal: patch.proposal,
    decision: Object.freeze({
      status: "rejected" as const,
      runId: input.runId,
      proposalId: input.proposalId,
      proposalRevision: input.proposalRevision,
      reviewId: required(input.reviewId, "Patch review id is required."),
      requestVersion: positiveInteger(input.requestVersion, "Patch review request version"),
      submissionId: required(input.submissionId, "Patch submission id is required."),
      decidedAt: isoDate((input.now ?? defaultNow)()),
      reason: required(input.reason, "Rejected patch reason is required."),
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    }),
  });
}

export function requestPatchRevision(
  patch: ProposedPatchStatus,
  input: RequestPatchRevisionInput,
): RevisionRequestedPatchStatus {
  assertProposedPatch(patch);
  assertDecisionCorrelation(patch, input);
  return Object.freeze({
    status: "revision_requested" as const,
    proposal: patch.proposal,
    decision: Object.freeze({
      status: "revision_requested" as const,
      runId: input.runId,
      proposalId: input.proposalId,
      proposalRevision: input.proposalRevision,
      reviewId: required(input.reviewId, "Patch review id is required."),
      requestVersion: positiveInteger(input.requestVersion, "Patch review request version"),
      submissionId: required(input.submissionId, "Patch submission id is required."),
      decidedAt: isoDate((input.now ?? defaultNow)()),
      reason: required(input.reason, "Patch revision request reason is required."),
      metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    }),
  });
}

function operationFromChange(
  change: PatchProposalChange,
  source: CodeSourceSnapshot,
): PatchOperation {
  if (change.kind === "create") {
    return Object.freeze({ kind: "create" as const, path: source.target.path, proposedContent: change.proposedContent });
  }
  if (source.contentRef === null) throw invalidState("Existing source requires a content reference.");
  if (change.kind === "update") {
    const operation: UpdatePatchOperation = {
      kind: "update",
      path: source.target.path,
      originalContent: source.contentRef,
      proposedContent: change.proposedContent,
    };
    return Object.freeze(operation);
  }
  const operation: DeletePatchOperation = {
    kind: "delete",
    path: source.target.path,
    originalContent: source.contentRef,
  };
  return Object.freeze(operation);
}

function assertSnapshotForChange(
  source: CodeSourceSnapshot,
  change: PatchProposalChange,
): void {
  if (change.kind === "create") {
    if (source.baseline.kind !== "absent" || source.content !== null || source.contentRef !== null) {
      throw invalidState("Create proposal requires an absent source baseline.");
    }
    return;
  }
  if (source.baseline.kind !== "present" || source.content === null || source.contentRef === null) {
    throw invalidState("Update and delete proposals require an existing UTF-8 source baseline.");
  }
}

function assertSnapshotMatchesProposal(
  source: CodeSourceSnapshot,
  proposal: PatchProposal,
): void {
  if (
    source.target.rootName !== proposal.rootName ||
    source.target.workspaceId !== proposal.workspaceId ||
    source.target.path !== proposal.operation.path ||
    JSON.stringify(source.baseline) !== JSON.stringify(proposal.sourceSnapshot.baseline) ||
    source.contentRef?.digest !== proposal.sourceSnapshot.contentRef?.digest ||
    source.contentRef?.byteLength !== proposal.sourceSnapshot.contentRef?.byteLength
  ) throw new PatchWorkflowError("patch_stale", "The patch target no longer matches the proposal baseline.");
}

function assertProposedPatch(patch: ProposedPatchStatus): void {
  if (
    patch?.status !== "proposed" ||
    typeof patch.proposal !== "object" ||
    patch.proposal === null ||
    requiredOrNull(patch.proposal.id) === null ||
    requiredOrNull(patch.proposal.runId) === null
  ) throw invalidState("Patch proposal state is invalid.");
}

function assertDecisionCorrelation(
  patch: ProposedPatchStatus,
  input: Pick<AcceptPatchInput, "runId" | "proposalId" | "proposalRevision">,
): void {
  if (
    patch.proposal.runId !== input.runId ||
    patch.proposal.id !== input.proposalId ||
    patch.proposal.revision !== input.proposalRevision
  ) {
    throw invalidState("Patch decision does not match the proposal.");
  }
}

function snapshotProducer(value: PatchProposal["producer"]): PatchProposal["producer"] {
  if (
    value === null || typeof value !== "object" ||
    (value.kind !== "controller" && value.kind !== "user" && value.kind !== "product")
  ) throw invalidState("Patch proposal producer is invalid.");
  return Object.freeze({
    kind: value.kind,
    owner: required(value.owner, "Patch proposal producer owner is required."),
    refId: required(value.refId, "Patch proposal producer reference is required."),
  });
}

function snapshotCreationBasis(
  value: PatchProposal["creationBasis"],
): PatchProposal["creationBasis"] {
  if (
    value === null || typeof value !== "object" ||
    (value.kind !== "controller_output" && value.kind !== "user_input" &&
      value.kind !== "product_workflow")
  ) throw invalidState("Patch proposal creation basis is invalid.");
  return Object.freeze({
    kind: value.kind,
    refId: required(value.refId, "Patch proposal creation-basis reference is required."),
  });
}

function snapshotSensitivity(
  value: PatchProposal["sensitivity"],
): PatchProposal["sensitivity"] {
  if (value !== "public" && value !== "private" && value !== "secret" && value !== "restricted") {
    throw invalidState("Patch proposal sensitivity is invalid.");
  }
  return value;
}

function sourceError(input: { readonly status: string; readonly code: string; readonly message: string }): PatchWorkflowError {
  if (input.status === "changed") return new PatchWorkflowError("patch_stale", input.message, { sourceCode: input.code });
  if (input.status === "unavailable" || input.status === "failed") {
    return new PatchWorkflowError("patch_source_unavailable", input.message, { sourceCode: input.code });
  }
  const unsafe = /path|containment|symbolic|workspace/i.test(input.code);
  return new PatchWorkflowError(unsafe ? "patch_path_unsafe" : "patch_state_invalid", input.message, { sourceCode: input.code });
}

function resolveLimits(input?: Partial<PatchWorkflowLimits>): PatchWorkflowLimits {
  const maxContentBytes = input?.maxContentBytes ?? defaultPatchWorkflowLimits.maxContentBytes;
  positiveInteger(maxContentBytes, "Patch content limit");
  return Object.freeze({ maxContentBytes });
}

function assertContentLimit(content: string, limits: PatchWorkflowLimits): void {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > limits.maxContentBytes) {
    throw invalidState("Patch content exceeds the configured limit.");
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidState(`${name} must be a positive safe integer.`);
  return value as number;
}

function required(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalidState(message);
  return value.trim();
}

function requiredOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isoDate(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalidState("Patch timestamp must be an ISO date-time.");
  }
  return value;
}

function invalidState(message: string): PatchWorkflowError {
  return new PatchWorkflowError("patch_state_invalid", message);
}

function defaultNow(): string {
  return new Date().toISOString();
}
