import {
  normalizePolicyAmendment,
  type AppliedPolicyAmendmentRecord,
  type PersistentPolicyAmendmentCommit,
  type PersistentPolicyAmendmentCommitResult,
  type TrustedPolicyAmendment,
} from "@agent-anything/governance";
import {
  validateSessionAuthorityRecord,
  type ApprovalApplicationOutcome,
  type SessionAuthorityCommitResult,
  type SessionAuthorityRecord,
  type ValidatedApprovalDecision,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { CancellationContext } from "./RunCancellation.js";
import {
  type ResolvedRunPermissionConfig,
} from "./RunPermissionConfig.js";
import type { PendingApproval } from "./RunPermissionState.js";

type SessionAuthorityDecision =
  | Extract<ValidatedApprovalDecision, { readonly kind: "acceptForSession" }>
  | (Extract<ValidatedApprovalDecision, { readonly kind: "grantPermissions" }> & {
      readonly authority: { readonly scope: "session"; readonly record: SessionAuthorityRecord };
    });

type PersistentAuthorityDecision = Extract<
  ValidatedApprovalDecision,
  { readonly kind: "acceptWithExecpolicyAmendment" | "applyNetworkPolicyAmendment" }
>;

export type DurableAuthorityDecision =
  | SessionAuthorityDecision
  | PersistentAuthorityDecision;

export type AuthorityCommitOwner = "permission" | "policy";

interface AuthorityCommitExecutionBase {
  readonly owner: AuthorityCommitOwner;
  readonly scope: "session" | "persistent";
  readonly commitId: string;
  readonly deadlineAt: ISODateTimeString;
  readonly interruption: InvocationInterruptionRef | null;
}

export type AuthorityCommitExecutionResult =
  | (AuthorityCommitExecutionBase & {
      readonly kind: "applied";
      readonly record: SessionAuthorityRecord | AppliedPolicyAmendmentRecord;
      readonly application: Extract<ApprovalApplicationOutcome, { readonly kind: "applied" }>;
    })
  | (AuthorityCommitExecutionBase & {
      readonly kind: "not_applied";
      readonly code: string;
      readonly message: string;
      readonly application: Extract<ApprovalApplicationOutcome, { readonly kind: "not_applied" }>;
    })
  | (AuthorityCommitExecutionBase & {
      readonly kind: "interrupted";
      readonly application: Extract<ApprovalApplicationOutcome, { readonly kind: "interrupted" }>;
    })
  | (AuthorityCommitExecutionBase & {
      readonly kind: "outcome_unknown";
      readonly code: string;
      readonly message: string;
      readonly application: Extract<ApprovalApplicationOutcome, { readonly kind: "outcome_unknown" }>;
    });

export interface ExecuteAuthorityCommitInput {
  readonly decision: DurableAuthorityDecision;
  readonly pending: PendingApproval & { readonly phase: "applying_authority" };
  readonly config: ResolvedRunPermissionConfig;
  readonly cancellation: CancellationContext;
  readonly startedAt: ISODateTimeString;
  readonly deadlineAt: ISODateTimeString;
  readonly policyAmendmentRecordId: string;
  readonly now: () => ISODateTimeString;
}

export function isDurableAuthorityDecision(
  decision: ValidatedApprovalDecision,
): decision is DurableAuthorityDecision {
  return decision.kind === "acceptForSession" ||
    (decision.kind === "grantPermissions" && decision.authority.scope === "session") ||
    decision.kind === "acceptWithExecpolicyAmendment" ||
    decision.kind === "applyNetworkPolicyAmendment";
}

export function authorityCommitOwner(
  decision: DurableAuthorityDecision,
): AuthorityCommitOwner {
  return decision.kind === "acceptForSession" ||
      (decision.kind === "grantPermissions" && decision.authority.scope === "session")
    ? "permission"
    : "policy";
}

export async function executeAuthorityCommit(
  input: ExecuteAuthorityCommitInput,
): Promise<AuthorityCommitExecutionResult> {
  const commitId = `${input.pending.authorityOperationId}:commit`;
  const interruption = createCommitInterruption({
    operationId: input.pending.authorityOperationId,
    deadlineAt: input.deadlineAt,
    cancellation: input.cancellation,
    now: input.now,
  });

  try {
    if (isSessionDecision(input.decision)) {
      return await executeSessionCommit(
        { ...input, decision: input.decision },
        commitId,
        input.deadlineAt,
        interruption,
      );
    }
    return await executePersistentCommit(
      { ...input, decision: input.decision },
      commitId,
      input.startedAt,
      input.deadlineAt,
      interruption,
    );
  } finally {
    interruption.dispose();
  }
}

async function executeSessionCommit(
  input: ExecuteAuthorityCommitInput & { readonly decision: SessionAuthorityDecision },
  commitId: string,
  deadlineAt: ISODateTimeString,
  interruption: CommitInterruption,
): Promise<AuthorityCommitExecutionResult> {
  const owner = "permission" as const;
  const scope = "session" as const;
  const session = input.config.sessionAuthority;
  if (session === null) {
    return notApplied(owner, scope, commitId, deadlineAt, interruption.current(),
      "approval_scope_unavailable", "Session authority is not configured for this Run.");
  }
  const expected = sessionRecord(input.decision);
  let result: SessionAuthorityCommitResult;
  try {
    result = await session.port.commit(
      Object.freeze({ commitId, record: expected }),
      interruption.context,
    );
  } catch {
    return unknown(owner, scope, commitId, deadlineAt, interruption.current(),
      "session_authority_commit_outcome_unknown",
      "Session authority commit threw before its durable outcome could be confirmed.");
  }
  try {
    if (result.kind === "applied") {
      const environment = permissionEnvironment(input.config);
      const cwd = input.config.permissionProfile.workspaceRoots[0]?.canonicalPath ??
        (input.config.permissionProfile.platform === "win32" ? "C:/" : "/");
      const validated = validateSessionAuthorityRecord({
        record: result.record,
        expectedContext: session.context,
        cwd,
        environment,
        managedConstraints: input.config.managedConstraints,
      });
      if (validated.status === "invalid" || !sameValue(validated.record, expected)) {
        return unknown(owner, scope, commitId, deadlineAt, interruption.current(),
          "session_authority_commit_outcome_unknown",
          "Session authority commit returned an applied record that does not match the validated decision.");
      }
      return Object.freeze({
        kind: "applied" as const,
        owner,
        scope,
        commitId,
        deadlineAt,
        interruption: interruption.current(),
        record: validated.record,
        application: applied("session_authority", validated.record.id),
      });
    }
    return normalizeNonAppliedResult(
      result,
      owner,
      scope,
      commitId,
      deadlineAt,
      interruption,
      "session_authority_commit_outcome_unknown",
    );
  } catch {
    return unknown(owner, scope, commitId, deadlineAt, interruption.current(),
      "session_authority_commit_outcome_unknown",
      "Session authority commit returned a malformed result.");
  }
}

async function executePersistentCommit(
  input: ExecuteAuthorityCommitInput & { readonly decision: PersistentAuthorityDecision },
  commitId: string,
  appliedAt: ISODateTimeString,
  deadlineAt: ISODateTimeString,
  interruption: CommitInterruption,
): Promise<AuthorityCommitExecutionResult> {
  const owner = "policy" as const;
  const scope = "persistent" as const;
  const port = input.config.persistentPolicyAmendments;
  if (port === null) {
    return notApplied(owner, scope, commitId, deadlineAt, interruption.current(),
      "approval_scope_unavailable", "Persistent policy amendments are not configured for this Run.");
  }
  const amendment = trustedAmendment(input.decision);
  const expected: AppliedPolicyAmendmentRecord = deepFreeze({
    id: input.policyAmendmentRecordId,
    proposalRef: input.decision.trustedProposalRef,
    sourceRequestId: input.pending.request.id,
    sourceActionFingerprint: input.pending.request.actionFingerprint,
    amendment,
    appliedAt,
  });
  const commit: PersistentPolicyAmendmentCommit = deepFreeze({
    commitId,
    recordId: expected.id,
    proposalRef: expected.proposalRef,
    sourceRequestId: expected.sourceRequestId,
    sourceActionFingerprint: expected.sourceActionFingerprint,
    amendment,
    appliedAt,
  });
  let result: PersistentPolicyAmendmentCommitResult;
  try {
    result = await port.commit(commit, interruption.context);
  } catch {
    return unknown(owner, scope, commitId, deadlineAt, interruption.current(),
      "policy_amendment_commit_outcome_unknown",
      "Persistent policy commit threw before its durable outcome could be confirmed.");
  }
  try {
    if (result.kind === "applied") {
      const normalized = normalizePolicyAmendment(result.record.amendment);
      if (
        normalized.status === "invalid" ||
        !sameValue(normalized.amendment, amendment) ||
        !sameValue(result.record, expected)
      ) {
        return unknown(owner, scope, commitId, deadlineAt, interruption.current(),
          "policy_amendment_commit_outcome_unknown",
          "Persistent policy commit returned an applied record that does not match the validated decision.");
      }
      const record = deepFreezeClone(result.record);
      return Object.freeze({
        kind: "applied" as const,
        owner,
        scope,
        commitId,
        deadlineAt,
        interruption: interruption.current(),
        record,
        application: applied("policy_amendment", record.id),
      });
    }
    return normalizeNonAppliedResult(
      result,
      owner,
      scope,
      commitId,
      deadlineAt,
      interruption,
      "policy_amendment_commit_outcome_unknown",
    );
  } catch {
    return unknown(owner, scope, commitId, deadlineAt, interruption.current(),
      "policy_amendment_commit_outcome_unknown",
      "Persistent policy commit returned a malformed result.");
  }
}

function normalizeNonAppliedResult(
  result: unknown,
  owner: AuthorityCommitOwner,
  scope: "session" | "persistent",
  commitId: string,
  deadlineAt: ISODateTimeString,
  interruption: CommitInterruption,
  unknownCode: string,
): AuthorityCommitExecutionResult {
  if (!isRecord(result) || typeof result.kind !== "string") {
    return unknown(owner, scope, commitId, deadlineAt, interruption.current(), unknownCode,
      "Authority commit returned a malformed result.");
  }
  if (
    result.kind === "not_applied" &&
    typeof result.code === "string" && result.code.length > 0 &&
    typeof result.message === "string" && result.message.length > 0
  ) {
    return notApplied(owner, scope, commitId, deadlineAt, interruption.current(),
      result.code, result.message);
  }
  if (result.kind === "interrupted" && isRecord(result.interruption)) {
    const current = interruption.current();
    if (current === null || !sameValue(current, result.interruption)) {
      return unknown(owner, scope, commitId, deadlineAt, current, unknownCode,
        "Authority commit returned an interruption that does not match the active operation.");
    }
    return Object.freeze({
      kind: "interrupted" as const,
      owner,
      scope,
      commitId,
      deadlineAt,
      interruption: current,
      application: Object.freeze({ kind: "interrupted" as const, interruption: current }),
    });
  }
  if (
    result.kind === "outcome_unknown" &&
    typeof result.code === "string" && result.code.length > 0 &&
    typeof result.message === "string" && result.message.length > 0
  ) {
    return unknown(owner, scope, commitId, deadlineAt, interruption.current(),
      result.code, result.message);
  }
  return unknown(owner, scope, commitId, deadlineAt, interruption.current(), unknownCode,
    "Authority commit returned a malformed result.");
}

function isSessionDecision(
  decision: DurableAuthorityDecision,
): decision is SessionAuthorityDecision {
  return decision.kind === "acceptForSession" ||
    (decision.kind === "grantPermissions" && decision.authority.scope === "session");
}

function sessionRecord(decision: SessionAuthorityDecision): SessionAuthorityRecord {
  return decision.kind === "acceptForSession"
    ? decision.sessionAuthority
    : decision.authority.record;
}

function trustedAmendment(decision: PersistentAuthorityDecision): TrustedPolicyAmendment {
  return decision.kind === "acceptWithExecpolicyAmendment"
    ? deepFreeze({ kind: "exec_policy" as const, amendment: decision.amendment })
    : deepFreeze({ kind: "network_policy" as const, amendment: decision.amendment });
}

function permissionEnvironment(config: ResolvedRunPermissionConfig) {
  return Object.freeze({
    environmentId: config.permissionProfile.environmentId,
    platform: config.permissionProfile.platform,
    workspaceRoots: Object.freeze(config.permissionProfile.workspaceRoots.map((root) =>
      Object.freeze({ rootId: root.rootId, path: root.canonicalPath })
    )),
  });
}

function applied(
  target: "session_authority" | "policy_amendment",
  authorityRecordId: string,
): Extract<ApprovalApplicationOutcome, { readonly kind: "applied" }> {
  return Object.freeze({
    kind: "applied" as const,
    target,
    authorityRecordIds: Object.freeze([authorityRecordId]) as readonly [string],
  });
}

function notApplied(
  owner: AuthorityCommitOwner,
  scope: "session" | "persistent",
  commitId: string,
  deadlineAt: ISODateTimeString,
  interruption: InvocationInterruptionRef | null,
  code: string,
  message: string,
): AuthorityCommitExecutionResult {
  return Object.freeze({
    kind: "not_applied" as const,
    owner,
    scope,
    commitId,
    deadlineAt,
    interruption,
    code,
    message,
    application: Object.freeze({ kind: "not_applied" as const, code }),
  });
}

function unknown(
  owner: AuthorityCommitOwner,
  scope: "session" | "persistent",
  commitId: string,
  deadlineAt: ISODateTimeString,
  interruption: InvocationInterruptionRef | null,
  code: string,
  message: string,
): AuthorityCommitExecutionResult {
  return Object.freeze({
    kind: "outcome_unknown" as const,
    owner,
    scope,
    commitId,
    deadlineAt,
    interruption,
    code,
    message,
    application: Object.freeze({ kind: "outcome_unknown" as const, code }),
  });
}

interface CommitInterruption {
  readonly context: InvocationInterruptionContext;
  current(): InvocationInterruptionRef | null;
  dispose(): void;
}

function createCommitInterruption(input: {
  readonly operationId: string;
  readonly deadlineAt: ISODateTimeString;
  readonly cancellation: CancellationContext;
  readonly now: () => ISODateTimeString;
}): CommitInterruption {
  const controller = new AbortController();
  let current: InvocationInterruptionRef | null = null;
  const abortFromCancellation = (): void => {
    const request = input.cancellation.request;
    if (request === null || current !== null) return;
    current = Object.freeze({
      kind: "run_cancellation" as const,
      cancellation: Object.freeze({ runId: request.runId, requestId: request.id }),
    });
    controller.abort(current);
  };
  input.cancellation.signal.addEventListener("abort", abortFromCancellation, { once: true });
  const delayMs = Math.max(0, Date.parse(input.deadlineAt) - Date.parse(input.now()));
  const timer = setTimeout(() => {
    if (current !== null) return;
    current = Object.freeze({
      kind: "operation_deadline" as const,
      deadline: Object.freeze({
        operationId: input.operationId,
        deadlineAt: input.deadlineAt,
      }),
    });
    controller.abort(current);
  }, delayMs);
  if (input.cancellation.signal.aborted) abortFromCancellation();

  return Object.freeze({
    context: Object.freeze({
      signal: controller.signal,
      get interruption() {
        return current;
      },
    }),
    current: () => current,
    dispose() {
      clearTimeout(timer);
      input.cancellation.signal.removeEventListener("abort", abortFromCancellation);
    },
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function deepFreezeClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((child) => deepFreezeClone(child))) as T;
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = deepFreezeClone(child);
    }
    return Object.freeze(clone) as T;
  }
  return value;
}
