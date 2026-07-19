import { createCanonicalSha256Digest } from "@agent-anything/action-execution";
import type { ISODateTimeString } from "@agent-anything/shared";
import {
  normalizeHelarcThreadRecord,
  type HelarcArtifact,
  type HelarcConversation,
  type HelarcMessage,
  type HelarcPersistedRun,
  type HelarcRunProgressRecord,
  type HelarcRunTerminalRecord,
  type HelarcThread,
  type HelarcThreadRecord,
} from "./HelarcWorkContext.js";

const COMMIT_FINGERPRINT_DOMAIN = "helarc.work-context.commit.v1";

export type HelarcCommitKind = "run_start" | "run_progress" | "run_terminal";

export interface HelarcCommitLedgerEntry {
  readonly commitId: string;
  readonly kind: HelarcCommitKind;
  readonly threadId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly committedAt: ISODateTimeString;
  readonly progressSequence: number;
}

export interface HelarcThreadAggregate {
  readonly record: HelarcThreadRecord;
  readonly commitLedger: readonly HelarcCommitLedgerEntry[];
}

export interface HelarcThreadAggregateValidationError {
  readonly code: "aggregate_invalid";
  readonly message: string;
}

export type NormalizeHelarcThreadAggregateResult =
  | { readonly ok: true; readonly aggregate: HelarcThreadAggregate }
  | { readonly ok: false; readonly error: HelarcThreadAggregateValidationError };

interface HelarcCommitBase {
  readonly commitId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly committedAt: ISODateTimeString;
}

export type HelarcRunStartTarget =
  | {
      readonly kind: "create_thread";
      readonly thread: HelarcThread;
      readonly conversation: HelarcConversation;
    }
  | {
      readonly kind: "existing_thread";
      readonly conversationId: string;
    };

export interface HelarcRunStartCommit extends HelarcCommitBase {
  readonly kind: "run_start";
  readonly target: HelarcRunStartTarget;
  readonly triggeringMessage: HelarcMessage;
  readonly run: HelarcPersistedRun;
}

export interface HelarcRunProgressCommit extends HelarcCommitBase {
  readonly kind: "run_progress";
  readonly progressSequence: number;
  readonly progress: HelarcRunProgressRecord;
}

export interface HelarcRunTerminalCommit extends HelarcCommitBase {
  readonly kind: "run_terminal";
  readonly terminal: HelarcRunTerminalRecord;
  readonly assistantMessage: HelarcMessage;
  readonly artifacts: readonly HelarcArtifact[];
}

export interface HelarcCommitReceipt {
  readonly status: "applied" | "idempotent";
  readonly commitId: string;
  readonly kind: HelarcCommitKind;
  readonly threadId: string;
  readonly runId: string;
  readonly committedAt: ISODateTimeString;
  readonly progressSequence: number;
}

export type HelarcCommitRejectionCode =
  | "commit_invalid"
  | "commit_id_conflict"
  | "aggregate_invalid"
  | "thread_not_found"
  | "thread_already_exists"
  | "run_not_found"
  | "run_already_exists"
  | "stale_progress"
  | "run_terminal";

export type HelarcCommitResult =
  | {
      readonly status: "applied" | "idempotent";
      readonly receipt: HelarcCommitReceipt;
      readonly aggregate: HelarcThreadAggregate;
    }
  | {
      readonly status: "rejected";
      readonly code: HelarcCommitRejectionCode;
      readonly message: string;
      readonly aggregate: HelarcThreadAggregate | null;
    };

export interface HelarcWorkContextCommitStore {
  commitRunStart(input: HelarcRunStartCommit): Promise<HelarcCommitResult>;
  commitRunProgress(input: HelarcRunProgressCommit): Promise<HelarcCommitResult>;
  commitRunTerminal(input: HelarcRunTerminalCommit): Promise<HelarcCommitResult>;
}

export function normalizeHelarcThreadAggregate(
  input: HelarcThreadAggregate,
): NormalizeHelarcThreadAggregateResult {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
    !Array.isArray(input.commitLedger)) {
    return invalidAggregate("Thread aggregate shape is invalid.");
  }
  let normalizedRecord: ReturnType<typeof normalizeHelarcThreadRecord>;
  try {
    normalizedRecord = normalizeHelarcThreadRecord(input.record);
  } catch {
    return invalidAggregate("Thread aggregate record shape is invalid.");
  }
  if (!normalizedRecord.ok) {
    return invalidAggregate(normalizedRecord.error.message);
  }
  const threadId = normalizedRecord.record.thread.id;
  if (!isValidLedger(input.commitLedger, threadId) ||
    !isLedgerConsistentWithRecord(input.commitLedger, normalizedRecord.record)) {
    return invalidAggregate("Thread aggregate commit ledger is invalid.");
  }
  return {
    ok: true,
    aggregate: Object.freeze({
      record: normalizedRecord.record,
      commitLedger: Object.freeze(input.commitLedger.map((entry) => Object.freeze({ ...entry }))),
    }),
  };
}

export async function applyHelarcRunStartCommit(
  aggregate: HelarcThreadAggregate | null,
  commit: HelarcRunStartCommit,
): Promise<HelarcCommitResult> {
  if (commit?.kind !== "run_start") {
    return reject(aggregate, "commit_invalid", "Run start commit kind is invalid.");
  }
  const prepared = await prepareCommit(aggregate, commit);
  if (prepared.status !== "ready") return prepared.result;
  if (commit.run.id !== commit.runId || commit.run.threadId !== commit.threadId ||
    commit.triggeringMessage.id !== commit.run.triggeringMessageId ||
    commit.triggeringMessage.threadId !== commit.threadId ||
    commit.triggeringMessage.relatedRunIds.length !== 1 ||
    commit.triggeringMessage.relatedRunIds[0] !== commit.runId ||
    commit.committedAt < commit.run.startedAt || commit.run.progressSequence !== 0 ||
    commit.run.lastProgress !== null || commit.run.terminal !== null ||
    commit.run.artifactIds.length !== 0) {
    return reject(aggregate, "commit_invalid", "Run start aggregate identities are invalid.");
  }

  let record: HelarcThreadRecord;
  if (commit.target.kind === "create_thread") {
    if (aggregate !== null) {
      return reject(aggregate, "thread_already_exists", "Run start cannot recreate a Thread aggregate.");
    }
    const thread = commit.target.thread;
    const conversation = commit.target.conversation;
    if (
      thread.id !== commit.threadId || thread.latestRunId !== null ||
      thread.activeConversationId !== conversation.id || conversation.threadId !== thread.id ||
      conversation.messageIds.length !== 0 || commit.triggeringMessage.conversationId !== conversation.id ||
      commit.committedAt < thread.createdAt || commit.committedAt < thread.updatedAt ||
      commit.committedAt < conversation.createdAt || commit.committedAt < conversation.updatedAt ||
      commit.committedAt < commit.triggeringMessage.createdAt
    ) {
      return reject(aggregate, "commit_invalid", "New Thread start target is invalid.");
    }
    record = {
      thread: { ...thread, latestRunId: commit.runId, updatedAt: commit.committedAt },
      conversations: [{
        ...conversation,
        updatedAt: commit.committedAt,
        messageIds: [commit.triggeringMessage.id],
      }],
      messages: [commit.triggeringMessage],
      runs: [commit.run],
      artifacts: [],
    };
  } else {
    const target = commit.target;
    if (aggregate === null) {
      return reject(null, "thread_not_found", "Existing Thread start target was not found.");
    }
    if (aggregate.record.runs.some((run) => run.id === commit.runId)) {
      return reject(aggregate, "run_already_exists", "Run identity already exists in the Thread.");
    }
    if (aggregate.record.messages.some((message) => message.id === commit.triggeringMessage.id)) {
      return reject(aggregate, "commit_invalid", "Trigger Message identity already exists.");
    }
    const conversation = aggregate.record.conversations.find((candidate) =>
      candidate.id === target.conversationId
    );
    if (
      aggregate.record.thread.id !== commit.threadId || conversation === undefined ||
      conversation.id !== aggregate.record.thread.activeConversationId ||
      commit.triggeringMessage.conversationId !== conversation.id ||
      commit.committedAt < aggregate.record.thread.updatedAt ||
      commit.committedAt < conversation.updatedAt ||
      commit.committedAt < commit.triggeringMessage.createdAt
    ) {
      return reject(aggregate, "commit_invalid", "Existing Thread start target is invalid.");
    }
    record = {
      ...aggregate.record,
      thread: {
        ...aggregate.record.thread,
        latestRunId: commit.runId,
        updatedAt: commit.committedAt,
      },
      conversations: replaceById(aggregate.record.conversations, {
        ...conversation,
        updatedAt: commit.committedAt,
        messageIds: [...conversation.messageIds, commit.triggeringMessage.id],
      }),
      messages: [...aggregate.record.messages, commit.triggeringMessage],
      runs: [...aggregate.record.runs, commit.run],
    };
  }

  return applyRecord(aggregate, record, commit, prepared.fingerprint, 0);
}

export async function applyHelarcRunProgressCommit(
  aggregate: HelarcThreadAggregate | null,
  commit: HelarcRunProgressCommit,
): Promise<HelarcCommitResult> {
  if (commit?.kind !== "run_progress") {
    return reject(aggregate, "commit_invalid", "Progress commit kind is invalid.");
  }
  const prepared = await prepareCommit(aggregate, commit);
  if (prepared.status !== "ready") return prepared.result;
  if (aggregate === null) return reject(null, "thread_not_found", "Progress Thread was not found.");
  const run = aggregate.record.runs.find((candidate) => candidate.id === commit.runId);
  if (run === undefined) return reject(aggregate, "run_not_found", "Progress Run was not found.");
  if (run.terminal !== null) return reject(aggregate, "run_terminal", "Terminal Run rejects progress.");
  if (
    !Number.isSafeInteger(commit.progressSequence) || commit.progressSequence < 1 ||
    commit.progressSequence <= run.progressSequence
  ) {
    return reject(aggregate, "stale_progress", "Progress sequence is stale.");
  }
  if (
    commit.progress.platform.runId !== run.id || commit.progress.platform.taskId !== run.taskId ||
    commit.progress.platform.sessionId !== run.sessionId || commit.progress.product.runId !== run.id ||
    commit.progress.platform.terminal !== null || commit.progress.product.result !== null ||
    commit.committedAt < commit.progress.recordedAt || commit.committedAt < run.updatedAt ||
    (run.lastProgress !== null && commit.progress.recordedAt < run.lastProgress.recordedAt)
  ) {
    return reject(aggregate, "commit_invalid", "Progress source projection is invalid.");
  }
  const updatedRun: HelarcPersistedRun = {
    ...run,
    updatedAt: commit.committedAt,
    progressSequence: commit.progressSequence,
    lastProgress: commit.progress,
  };
  const record: HelarcThreadRecord = {
    ...aggregate.record,
    thread: { ...aggregate.record.thread, updatedAt: commit.committedAt },
    runs: replaceById(aggregate.record.runs, updatedRun),
  };
  return applyRecord(
    aggregate,
    record,
    commit,
    prepared.fingerprint,
    commit.progressSequence,
  );
}

export async function applyHelarcRunTerminalCommit(
  aggregate: HelarcThreadAggregate | null,
  commit: HelarcRunTerminalCommit,
): Promise<HelarcCommitResult> {
  if (commit?.kind !== "run_terminal") {
    return reject(aggregate, "commit_invalid", "Terminal commit kind is invalid.");
  }
  const prepared = await prepareCommit(aggregate, commit);
  if (prepared.status !== "ready") return prepared.result;
  if (aggregate === null) return reject(null, "thread_not_found", "Terminal Thread was not found.");
  const run = aggregate.record.runs.find((candidate) => candidate.id === commit.runId);
  if (run === undefined) return reject(aggregate, "run_not_found", "Terminal Run was not found.");
  if (run.terminal !== null) return reject(aggregate, "run_terminal", "Run terminal is immutable.");
  if (
    commit.terminal.platform.runId !== run.id || commit.terminal.platform.taskId !== run.taskId ||
    commit.terminal.platform.completedAt < run.startedAt ||
    commit.committedAt < commit.terminal.platform.completedAt || commit.committedAt < run.updatedAt
  ) {
    return reject(aggregate, "commit_invalid", "Terminal projection identity is invalid.");
  }
  const artifactIds = commit.artifacts.map((artifact) => artifact.id);
  if (
    new Set(artifactIds).size !== artifactIds.length ||
    commit.artifacts.some((artifact) =>
      artifact.threadId !== commit.threadId || artifact.runId !== commit.runId ||
      artifact.createdAt < run.startedAt || artifact.createdAt > commit.committedAt ||
      aggregate.record.artifacts.some((existing) => existing.id === artifact.id)
    )
  ) {
    return reject(aggregate, "commit_invalid", "Terminal Artifact ownership is invalid.");
  }
  const conversation = aggregate.record.conversations.find((candidate) =>
    candidate.id === aggregate.record.thread.activeConversationId
  );
  if (!isValidAssistantMessage(
    commit.assistantMessage,
    conversation,
    commit,
    run,
    artifactIds,
    aggregate.record,
  )) {
    return reject(aggregate, "commit_invalid", "Terminal assistant Message is invalid.");
  }

  const updatedRun: HelarcPersistedRun = {
    ...run,
    updatedAt: commit.committedAt,
    terminal: commit.terminal,
    artifactIds,
  };
  const messages = [...aggregate.record.messages, commit.assistantMessage];
  const conversations = conversation === undefined
    ? aggregate.record.conversations
    : replaceById(aggregate.record.conversations, {
        ...conversation,
        updatedAt: commit.committedAt,
        messageIds: [...conversation.messageIds, commit.assistantMessage.id],
      });
  const record: HelarcThreadRecord = {
    ...aggregate.record,
    thread: {
      ...aggregate.record.thread,
      latestRunId: run.id,
      updatedAt: commit.committedAt,
    },
    conversations,
    messages,
    runs: replaceById(aggregate.record.runs, updatedRun),
    artifacts: [...aggregate.record.artifacts, ...commit.artifacts],
  };
  return applyRecord(
    aggregate,
    record,
    commit,
    prepared.fingerprint,
    run.progressSequence,
  );
}

async function prepareCommit(
  aggregate: HelarcThreadAggregate | null,
  commit: HelarcRunStartCommit | HelarcRunProgressCommit | HelarcRunTerminalCommit,
): Promise<
  | { readonly status: "ready"; readonly fingerprint: string }
  | { readonly status: "settled"; readonly result: HelarcCommitResult }
> {
  if (
    !hasIdentity(commit?.commitId) || !hasIdentity(commit.threadId) ||
    !hasIdentity(commit.runId) || !isDateTime(commit.committedAt)
  ) {
    return { status: "settled", result: reject(aggregate, "commit_invalid", "Commit base is invalid.") };
  }
  if (aggregate !== null) {
    const normalized = normalizeHelarcThreadAggregate(aggregate);
    if (!normalized.ok) {
      return { status: "settled", result: reject(aggregate, "aggregate_invalid", "Thread aggregate is invalid.") };
    }
    if (aggregate.record.thread.id !== commit.threadId) {
      return { status: "settled", result: reject(aggregate, "commit_invalid", "Commit Thread identity does not match.") };
    }
  }
  let fingerprint: string;
  try {
    fingerprint = await createCanonicalSha256Digest(COMMIT_FINGERPRINT_DOMAIN, commit);
  } catch {
    return { status: "settled", result: reject(aggregate, "commit_invalid", "Commit is not canonical safe data.") };
  }
  const previous = aggregate?.commitLedger.find((entry) => entry.commitId === commit.commitId);
  if (previous !== undefined) {
    if (previous.kind !== commit.kind || previous.fingerprint !== fingerprint) {
      return { status: "settled", result: reject(aggregate, "commit_id_conflict", "Commit id was reused with different content.") };
    }
    return {
      status: "settled",
      result: {
        status: "idempotent",
        receipt: receipt("idempotent", previous),
        aggregate: aggregate!,
      },
    };
  }
  return { status: "ready", fingerprint };
}

function applyRecord(
  aggregate: HelarcThreadAggregate | null,
  record: HelarcThreadRecord,
  commit: HelarcRunStartCommit | HelarcRunProgressCommit | HelarcRunTerminalCommit,
  fingerprint: string,
  progressSequence: number,
): HelarcCommitResult {
  const normalized = normalizeHelarcThreadRecord(record);
  if (!normalized.ok) {
    return reject(aggregate, "commit_invalid", normalized.error.message);
  }
  const entry: HelarcCommitLedgerEntry = Object.freeze({
    commitId: commit.commitId,
    kind: commit.kind,
    threadId: commit.threadId,
    runId: commit.runId,
    fingerprint,
    committedAt: commit.committedAt,
    progressSequence,
  });
  const next = Object.freeze({
    record: normalized.record,
    commitLedger: Object.freeze([...(aggregate?.commitLedger ?? []), entry]),
  });
  return {
    status: "applied",
    receipt: receipt("applied", entry),
    aggregate: next,
  };
}

function isValidAssistantMessage(
  message: HelarcMessage,
  conversation: HelarcConversation | undefined,
  commit: HelarcRunTerminalCommit,
  run: HelarcPersistedRun,
  artifactIds: readonly string[],
  record: HelarcThreadRecord,
): boolean {
  return conversation !== undefined && message.role === "assistant" &&
    message.threadId === commit.threadId && message.conversationId === conversation.id &&
    message.createdAt >= run.startedAt &&
    message.createdAt <= commit.committedAt &&
    message.relatedRunIds.length === 1 && message.relatedRunIds[0] === commit.runId &&
    message.relatedArtifactIds.length === artifactIds.length &&
    message.relatedArtifactIds.every((id, index) => id === artifactIds[index]) &&
    !record.messages.some((existing) => existing.id === message.id);
}

function isValidLedger(
  ledger: readonly HelarcCommitLedgerEntry[],
  threadId: string,
): boolean {
  const ids = new Set<string>();
  for (const entry of ledger) {
    if (
      entry === null || typeof entry !== "object" || Array.isArray(entry) ||
      !hasIdentity(entry.commitId) || entry.threadId !== threadId || !hasIdentity(entry.runId) ||
      !isCommitKind(entry.kind) || !/^sha256:[0-9a-f]{64}$/.test(entry.fingerprint) ||
      !isDateTime(entry.committedAt) ||
      !Number.isSafeInteger(entry.progressSequence) || entry.progressSequence < 0 ||
      ids.has(entry.commitId)
    ) {
      return false;
    }
    ids.add(entry.commitId);
  }
  return true;
}

function isLedgerConsistentWithRecord(
  ledger: readonly HelarcCommitLedgerEntry[],
  record: HelarcThreadRecord,
): boolean {
  if (ledger.length === 0 || ledger.at(-1)?.committedAt !== record.thread.updatedAt) {
    return false;
  }
  const runById = new Map(record.runs.map((run) => [run.id, run]));
  const entriesByRun = new Map<string, HelarcCommitLedgerEntry[]>();
  let previousCommittedAt: string | null = null;
  for (const entry of ledger) {
    if (!runById.has(entry.runId) ||
      (previousCommittedAt !== null && Date.parse(entry.committedAt) < Date.parse(previousCommittedAt))) {
      return false;
    }
    previousCommittedAt = entry.committedAt;
    const entries = entriesByRun.get(entry.runId) ?? [];
    entries.push(entry);
    entriesByRun.set(entry.runId, entries);
  }
  for (const run of record.runs) {
    const entries = entriesByRun.get(run.id) ?? [];
    if (entries.length === 0 || entries[0]?.kind !== "run_start" ||
      entries[0].progressSequence !== 0 ||
      entries.filter((entry) => entry.kind === "run_start").length !== 1) {
      return false;
    }
    let progressSequence = 0;
    let terminalCount = 0;
    for (const entry of entries.slice(1)) {
      if (entry.kind === "run_start") return false;
      if (entry.kind === "run_progress") {
        if (terminalCount > 0 || entry.progressSequence <= progressSequence) return false;
        progressSequence = entry.progressSequence;
      } else {
        terminalCount += 1;
        if (terminalCount > 1 || entry.progressSequence !== progressSequence) return false;
      }
    }
    if (run.progressSequence !== progressSequence ||
      (run.terminal === null) !== (terminalCount === 0) ||
      (terminalCount === 1 && entries.at(-1)?.kind !== "run_terminal")) {
      return false;
    }
  }
  return true;
}

function isCommitKind(value: unknown): value is HelarcCommitKind {
  return value === "run_start" || value === "run_progress" || value === "run_terminal";
}

function receipt(
  status: HelarcCommitReceipt["status"],
  entry: HelarcCommitLedgerEntry,
): HelarcCommitReceipt {
  return Object.freeze({
    status,
    commitId: entry.commitId,
    kind: entry.kind,
    threadId: entry.threadId,
    runId: entry.runId,
    committedAt: entry.committedAt,
    progressSequence: entry.progressSequence,
  });
}

function reject(
  aggregate: HelarcThreadAggregate | null,
  code: HelarcCommitRejectionCode,
  message: string,
): HelarcCommitResult {
  return Object.freeze({ status: "rejected" as const, code, message, aggregate });
}

function invalidAggregate(message: string): NormalizeHelarcThreadAggregateResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "aggregate_invalid" as const, message }),
  });
}

function replaceById<T extends { readonly id: string }>(items: readonly T[], item: T): T[] {
  return items.map((candidate) => candidate.id === item.id ? item : candidate);
}

function hasIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateTime(value: unknown): value is ISODateTimeString {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
