import { describe, expect, it } from "vitest";
import { InteractionExecution } from "./InteractionExecution.js";

const request = Object.freeze({
  id: "request-1",
  protocol: Object.freeze({ owner: "permission", kind: "approval", revision: "1" }),
  requestVersion: 1,
  subject: Object.freeze({ owner: "canonical-action", kind: "subject", id: "action-1", revision: "1" }),
});

describe("InteractionExecution", () => {
  it("accepts an idempotent duplicate and rejects a conflicting duplicate", () => {
    const execution = InteractionExecution.create({ request, blockingScope: "run" });
    expect(execution.recordSubmission({
      expectedRevision: 0,
      submissionId: "submission-1",
      contentDigest: "sha256:one",
      receiptId: "receipt-1",
      recordedAt: "2026-08-12T00:00:00.000Z",
    }).status).toBe("accepted");
    expect(execution.recordSubmission({
      expectedRevision: 1,
      submissionId: "submission-1",
      contentDigest: "sha256:one",
      receiptId: "receipt-2",
      recordedAt: "2026-08-12T00:00:01.000Z",
    }).status).toBe("duplicate_identical");
    expect(execution.recordSubmission({
      expectedRevision: 1,
      submissionId: "submission-1",
      contentDigest: "sha256:other",
      receiptId: "receipt-3",
      recordedAt: "2026-08-12T00:00:02.000Z",
    })).toMatchObject({ status: "rejected", code: "duplicate_conflict" });
  });

  it("settles once and rejects a conflicting terminal fact", () => {
    const execution = InteractionExecution.create({ request, blockingScope: "branch" });
    expect(execution.settle({
      expectedRevision: 0,
      terminal: { kind: "cancelled", request, cancellationId: "cancel-1" },
    }).status).toBe("committed");
    expect(execution.settle({
      expectedRevision: 1,
      terminal: { kind: "expired", request, expiredAt: "2026-08-12T00:00:00.000Z" },
    })).toMatchObject({ status: "rejected", code: "terminal_conflict" });
  });
});
