import {
  snapshotInteractionRequestRef,
  type InteractionRequestRef,
} from "../protocol/index.js";
import {
  snapshotInteractionSubmissionRecordRef,
  snapshotInteractionTerminalRecord,
  snapshotInteractionTransportReceipt,
  type InteractionSubmissionRecordRef,
  type InteractionTerminalRecord,
  type InteractionTransportReceipt,
} from "../records/index.js";
import { dateTime, fail, token } from "../contract/InteractionContractValidation.js";
import {
  snapshotPendingInteractionRef,
  type PendingInteractionRef,
} from "./InteractionCoordination.js";

export interface InteractionExecutionSnapshot {
  readonly revision: number;
  readonly pending: PendingInteractionRef;
  readonly submissions: readonly InteractionSubmissionRecordRef[];
  readonly receipts: readonly InteractionTransportReceipt[];
  readonly terminal: InteractionTerminalRecord | null;
}

export type InteractionSubmissionCommit =
  | {
      readonly status: "accepted" | "duplicate_identical";
      readonly revision: number;
      readonly record: InteractionSubmissionRecordRef;
      readonly receipt: InteractionTransportReceipt;
    }
  | {
      readonly status: "rejected";
      readonly revision: number;
      readonly code: "stale_revision" | "request_settled" | "duplicate_conflict";
      readonly receipt: InteractionTransportReceipt;
    };

export type InteractionTerminalCommit =
  | {
      readonly status: "committed" | "duplicate_identical";
      readonly revision: number;
      readonly terminal: InteractionTerminalRecord;
    }
  | {
      readonly status: "rejected";
      readonly revision: number;
      readonly code: "stale_revision" | "terminal_conflict";
    };

/** Sole lifecycle writer for one interaction request. */
export class InteractionExecution {
  private revision = 0;
  private lifecycle: PendingInteractionRef["lifecycle"] = "pending";
  private readonly submissions = new Map<string, InteractionSubmissionRecordRef>();
  private readonly receipts: InteractionTransportReceipt[] = [];
  private terminal: InteractionTerminalRecord | null = null;

  private constructor(
    private readonly request: InteractionRequestRef,
    private readonly blockingScope: PendingInteractionRef["blockingScope"],
  ) {}

  static create(input: {
    readonly request: InteractionRequestRef;
    readonly blockingScope: PendingInteractionRef["blockingScope"];
  }): InteractionExecution {
    const pending = snapshotPendingInteractionRef({
      request: input.request,
      lifecycle: "pending",
      blockingScope: input.blockingScope,
    });
    return new InteractionExecution(pending.request, pending.blockingScope);
  }

  getSnapshot(): InteractionExecutionSnapshot {
    return Object.freeze({
      revision: this.revision,
      pending: snapshotPendingInteractionRef({
        request: this.request,
        lifecycle: this.lifecycle,
        blockingScope: this.blockingScope,
      }),
      submissions: Object.freeze([...this.submissions.values()]),
      receipts: Object.freeze([...this.receipts]),
      terminal: this.terminal,
    });
  }

  recordSubmission(input: {
    readonly expectedRevision: number;
    readonly submissionId: string;
    readonly contentDigest: string;
    readonly receiptId: string;
    readonly recordedAt: string;
  }): InteractionSubmissionCommit {
    const submissionId = token(input.submissionId, "submissionId");
    const contentDigest = token(input.contentDigest, "contentDigest");
    const existing = this.submissions.get(submissionId);
    const rejection =
      input.expectedRevision !== this.revision
        ? "stale_revision"
        : this.terminal !== null
          ? "request_settled"
          : existing !== undefined && existing.contentDigest !== contentDigest
            ? "duplicate_conflict"
            : null;
    const receipt = snapshotInteractionTransportReceipt({
      receiptId: token(input.receiptId, "receiptId"),
      request: this.request,
      submissionId,
      status:
        rejection === null
          ? existing === undefined
            ? "accepted_for_resolution"
            : "duplicate_identical"
          : "rejected",
      recordedAt: dateTime(input.recordedAt, "recordedAt"),
    });
    this.receipts.push(receipt);

    if (rejection !== null) {
      return Object.freeze({
        status: "rejected" as const,
        revision: this.revision,
        code: rejection,
        receipt,
      });
    }
    if (existing !== undefined) {
      return Object.freeze({
        status: "duplicate_identical" as const,
        revision: this.revision,
        record: existing,
        receipt,
      });
    }
    const record = snapshotInteractionSubmissionRecordRef({
      request: this.request,
      submissionId,
      contentDigest,
    });
    this.submissions.set(submissionId, record);
    this.revision += 1;
    return Object.freeze({
      status: "accepted" as const,
      revision: this.revision,
      record,
      receipt,
    });
  }

  settle(input: {
    readonly expectedRevision: number;
    readonly terminal: InteractionTerminalRecord;
  }): InteractionTerminalCommit {
    const terminal = snapshotInteractionTerminalRecord(input.terminal);
    assertSameRequest(this.request, terminal.request);
    if (this.terminal !== null) {
      if (terminalKey(this.terminal) === terminalKey(terminal)) {
        return Object.freeze({
          status: "duplicate_identical" as const,
          revision: this.revision,
          terminal: this.terminal,
        });
      }
      return Object.freeze({
        status: "rejected" as const,
        revision: this.revision,
        code: "terminal_conflict" as const,
      });
    }
    if (input.expectedRevision !== this.revision) {
      return Object.freeze({
        status: "rejected" as const,
        revision: this.revision,
        code: "stale_revision" as const,
      });
    }
    this.terminal = terminal;
    this.lifecycle = terminal.kind;
    this.revision += 1;
    return Object.freeze({
      status: "committed" as const,
      revision: this.revision,
      terminal,
    });
  }
}

function assertSameRequest(expected: InteractionRequestRef, actual: InteractionRequestRef): void {
  if (requestKey(expected) !== requestKey(actual)) {
    fail(
      "interaction_contract_invalid",
      "Interaction terminal record targets another request.",
      "terminal.request",
    );
  }
}

function requestKey(input: InteractionRequestRef): string {
  return `${input.protocol.owner}:${input.protocol.kind}:${input.protocol.revision}:${input.id}:${input.requestVersion}:${input.subject.owner}:${input.subject.kind}:${input.subject.id}:${input.subject.revision}`;
}

function terminalKey(input: InteractionTerminalRecord): string {
  return JSON.stringify(input);
}
