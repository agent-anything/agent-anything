import type {
  ActionDispatchClaim,
  ActionDispatchClaimInput,
  CanonicalActionCommitPort,
  CanonicalActionCommitReceipt,
  CanonicalActionLifecycle,
  CanonicalActionState,
  CanonicalActionTransitionProposal,
} from "@agent-anything/canonical-action/lifecycle";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import type {
  ActionAttemptRef,
  CanonicalActionRef,
  CanonicalActionSubjectRevision,
} from "@agent-anything/canonical-action/subject";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";

export class CanonicalActionCommitError extends Error {
  constructor(
    readonly code:
      | "action_revision_conflict"
      | "action_transition_invalid"
      | "action_subject_invalid"
      | "action_dispatch_consumed"
      | "action_settlement_conflict",
    message: string,
  ) {
    super(message);
    this.name = "CanonicalActionCommitError";
  }
}

/** Sole state writer for one canonical Action invocation. */
export class CanonicalActionLedger<TPayload = unknown>
  implements CanonicalActionCommitPort<TPayload>
{
  private revision = 0;
  private lifecycle: CanonicalActionLifecycle = "reserved";
  private readonly subjects: CanonicalActionSubjectRevision[] = [];
  private readonly attempts: ActionAttemptRef[] = [];
  private activeDispatchClaim: ActionDispatchClaim | null = null;
  private settlement: CanonicalActionSettlement<TPayload> | null = null;

  constructor(
    private readonly action: CanonicalActionRef,
    private readonly parentRunAction: RunActionRef | null,
  ) {
    requireToken(action.id, "action.id");
  }

  /** Restore an acknowledged dispatch, without replaying transitions or claiming work. */
  static restoreDispatch(input: CanonicalActionState): CanonicalActionLedger {
    const saved = deepFreeze(structuredClone(input));
    const ledger = new CanonicalActionLedger(saved.action, saved.parentRunAction);
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || saved.lifecycle !== "attempting" ||
        saved.settlement !== null || saved.activeDispatchClaim === null || saved.attempts.length === 0) {
      throw new TypeError("An acknowledged Action dispatch checkpoint is required.");
    }
    for (const subject of saved.subjects) ledger.recordSubject(subject);
    const last = saved.attempts.at(-1)!;
    const ids = new Set<string>();
    for (const [index, attempt] of saved.attempts.entries()) {
      requireToken(attempt.id, "attempt.id");
      if (attempt.action.id !== saved.action.id || attempt.ordinal !== index + 1 || ids.has(attempt.id)) {
        throw new TypeError("Retained Action attempts are inconsistent.");
      }
      ids.add(attempt.id);
    }
    const claim = saved.activeDispatchClaim;
    if (saved.currentSubject?.action.id !== saved.action.id ||
        saved.currentSubject.revision !== saved.subjects.length ||
        claim.subject.action.id !== saved.action.id || claim.subject.revision !== saved.currentSubject.revision ||
        claim.attempt.id !== last.id || claim.attempt.ordinal !== last.ordinal || claim.attempt.action.id !== saved.action.id) {
      throw new TypeError("Retained Action dispatch does not match its subject and attempts.");
    }
    requireToken(claim.id, "claim.id");
    requireToken(claim.planFingerprint, "claim.planFingerprint");
    requireDateTime(claim.claimedAt, "claim.claimedAt");
    ledger.attempts.push(...saved.attempts);
    ledger.revision = saved.revision;
    ledger.lifecycle = saved.lifecycle;
    ledger.activeDispatchClaim = claim;
    return ledger;
  }

  getSnapshot(): CanonicalActionState<TPayload> {
    return Object.freeze({
      revision: this.revision,
      action: Object.freeze({ ...this.action }),
      parentRunAction: this.parentRunAction,
      lifecycle: this.lifecycle,
      subjects: Object.freeze([...this.subjects]),
      currentSubject: this.subjects.at(-1)?.ref ?? null,
      attempts: Object.freeze([...this.attempts]),
      activeDispatchClaim: this.activeDispatchClaim,
      settlement: this.settlement,
    });
  }

  transition(proposal: CanonicalActionTransitionProposal): Promise<CanonicalActionCommitReceipt> {
    return Promise.resolve(this.commit(proposal));
  }

  commit(proposal: CanonicalActionTransitionProposal): CanonicalActionCommitReceipt {
    this.assertRevision(proposal.expectedRevision);
    const previousRevision = this.revision;
    switch (proposal.kind) {
      case "begin_preparation":
        this.requireLifecycle("reserved");
        this.lifecycle = "preparing";
        break;
      case "record_subject":
        this.requireLifecycle("preparing", "retry_delay");
        if (proposal.subject === undefined) {
          throw new CanonicalActionCommitError("action_subject_invalid", "record_subject requires a complete subject revision.");
        }
        this.recordSubject(proposal.subject);
        this.lifecycle = "prepared";
        break;
      case "begin_assessment":
        this.requireLifecycle("prepared", "awaiting_approval", "retry_delay");
        this.lifecycle = "assessing";
        break;
      case "await_approval":
        this.requireLifecycle("assessing");
        this.lifecycle = "awaiting_approval";
        break;
      case "mark_ready":
        this.requireLifecycle("assessing");
        this.lifecycle = "ready";
        break;
      case "begin_revalidation":
        this.requireLifecycle("ready", "retry_delay");
        this.lifecycle = "revalidating";
        break;
      case "begin_retry_delay":
        this.requireLifecycle("attempting");
        this.activeDispatchClaim = null;
        this.lifecycle = "retry_delay";
        break;
    }
    this.revision += 1;
    return this.receipt(previousRevision);
  }

  claimDispatch(input: ActionDispatchClaimInput): Promise<CanonicalActionCommitReceipt> {
    this.assertRevision(input.expectedRevision);
    this.requireLifecycle("revalidating");
    if (this.activeDispatchClaim !== null) {
      throw new CanonicalActionCommitError("action_dispatch_consumed", "The current dispatch plan has already been consumed.");
    }
    const currentSubject = this.subjects.at(-1)?.ref;
    if (currentSubject === undefined) {
      throw new CanonicalActionCommitError("action_subject_invalid", "Dispatch requires a current Action subject.");
    }
    const attempt: ActionAttemptRef = Object.freeze({
      action: Object.freeze({ ...this.action }),
      id: requireToken(input.attemptId, "attemptId"),
      ordinal: this.attempts.length + 1,
    });
    if (this.attempts.some(({ id }) => id === attempt.id)) {
      throw new CanonicalActionCommitError("action_dispatch_consumed", "Attempt identity has already been used.");
    }
    this.attempts.push(attempt);
    this.activeDispatchClaim = Object.freeze({
      id: requireToken(input.claimId, "claimId"),
      subject: currentSubject,
      attempt,
      planFingerprint: requireToken(input.planFingerprint, "planFingerprint"),
      claimedAt: requireDateTime(input.claimedAt, "claimedAt"),
    });
    const previousRevision = this.revision;
    this.lifecycle = "attempting";
    this.revision += 1;
    return Promise.resolve(this.receipt(previousRevision));
  }

  settle(input: {
    readonly expectedRevision: number;
    readonly settlement: CanonicalActionSettlement<TPayload>;
  }): Promise<CanonicalActionCommitReceipt> {
    if (this.settlement !== null) {
      if (JSON.stringify(this.settlement) === JSON.stringify(input.settlement)) {
        return Promise.resolve(this.receipt(this.revision));
      }
      throw new CanonicalActionCommitError("action_settlement_conflict", "Canonical Action is already settled with another terminal fact.");
    }
    this.assertRevision(input.expectedRevision);
    if (input.settlement.action.id !== this.action.id) {
      throw new CanonicalActionCommitError("action_settlement_conflict", "Settlement does not belong to this canonical Action.");
    }
    const previousRevision = this.revision;
    this.settlement = deepFreeze(input.settlement);
    this.activeDispatchClaim = null;
    this.lifecycle = "settled";
    this.revision += 1;
    return Promise.resolve(this.receipt(previousRevision));
  }

  private recordSubject(subject: CanonicalActionSubjectRevision): void {
    if (subject.ref.action.id !== this.action.id) {
      throw new CanonicalActionCommitError("action_subject_invalid", "Subject revision does not belong to this canonical Action.");
    }
    const expected = this.subjects.length + 1;
    if (
      subject.ref.revision !== expected ||
      (expected === 1) !== (subject.previousRevision === null) ||
      (subject.previousRevision !== null &&
        (subject.previousRevision.action.id !== this.action.id || subject.previousRevision.revision !== expected - 1))
    ) {
      throw new CanonicalActionCommitError("action_subject_invalid", "Subject revision chain is not contiguous.");
    }
    this.subjects.push(deepFreeze(subject));
  }

  private assertRevision(expected: number): void {
    if (expected !== this.revision) {
      throw new CanonicalActionCommitError("action_revision_conflict", `Expected Action revision ${expected}, current revision is ${this.revision}.`);
    }
  }

  private requireLifecycle(...allowed: CanonicalActionLifecycle[]): void {
    if (!allowed.includes(this.lifecycle)) {
      throw new CanonicalActionCommitError("action_transition_invalid", `Cannot transition canonical Action from '${this.lifecycle}'.`);
    }
  }

  private receipt(previousRevision: number): CanonicalActionCommitReceipt {
    return Object.freeze({
      action: Object.freeze({ ...this.action }),
      previousRevision,
      revision: this.revision,
      lifecycle: this.lifecycle,
    });
  }
}

function requireToken(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw new CanonicalActionCommitError("action_subject_invalid", `A canonical token is required at ${path}.`);
  }
  return input;
}

function requireDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input))) {
    throw new CanonicalActionCommitError("action_subject_invalid", `A date-time is required at ${path}.`);
  }
  return input;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
