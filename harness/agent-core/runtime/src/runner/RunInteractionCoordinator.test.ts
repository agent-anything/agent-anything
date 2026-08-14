import { createInteractionProtocolRegistrySnapshot } from "@agent-anything/interaction/coordination";
import {
  snapshotInteractionRequest,
  type InteractionProtocolRef,
  type InteractionRequestRef,
} from "@agent-anything/interaction/protocol";
import { describe, expect, it } from "vitest";
import {
  RunInteractionCoordinator,
  type OpenRuntimeInteractionInput,
} from "./RunInteractionCoordinator.js";

const NOW = "2026-08-14T00:00:00.000Z";

describe("RunInteractionCoordinator adverse conformance", () => {
  it("rejects stale, wrong-subject, duplicate-conflicting, and late submissions", async () => {
    const fixture = createFixture();
    const opened = fixture.coordinator.open(openInput());
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;

    expect(fixture.coordinator.submit(submission({
      request: { ...opened.pending.request, requestVersion: 2 },
      submissionId: "stale-version",
    }))).toMatchObject({ status: "rejected", code: "interaction_version_stale" });
    expect(fixture.coordinator.submit(submission({
      request: {
        ...opened.pending.request,
        subject: { ...opened.pending.request.subject, id: "wrong-subject" },
      },
      submissionId: "wrong-subject",
    }))).toMatchObject({ status: "rejected", code: "interaction_not_pending" });

    const first = fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "submission-1",
    }));
    const duplicate = fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "submission-1",
    }));
    const conflict = fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "submission-1",
      contentDigest: "sha256:different",
    }));
    expect(first.status).toBe("accepted_for_resolution");
    expect(duplicate.status).toBe("duplicate_identical");
    expect(conflict).toMatchObject({
      status: "rejected",
      code: "interaction_submission_conflict",
    });
    expect((await opened.completion).status).toBe("resolved");
    expect(fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "late-submission",
    }))).toMatchObject({ status: "rejected", code: "interaction_not_pending" });
  });

  it("accepts transport before rejecting an ineligible responder semantically", async () => {
    const fixture = createFixture();
    const opened = fixture.coordinator.open(openInput());
    if (opened.status !== "opened") throw new Error("Expected an opened Interaction.");

    expect(fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "wrong-responder",
      payload: { actorId: "ineligible", answer: "yes" },
    })).status).toBe("accepted_for_resolution");
    expect(await opened.completion).toMatchObject({
      status: "failed",
      owner: "test-owner",
      code: "interaction_submission_invalid",
    });
  });

  it("settles expiry, cancellation, invalidation, unavailability, and post-Run closure exactly", async () => {
    const expiring = createFixture();
    const expired = expiring.coordinator.open(openInput({
      expiresAt: "2026-08-14T00:00:00.001Z",
    }));
    if (expired.status !== "opened") throw new Error("Expected expiring Interaction.");
    expect(await expired.completion).toMatchObject({
      status: "expired",
      code: "interaction_expired",
    });

    const cancelling = createFixture();
    const cancelled = cancelling.coordinator.open(openInput());
    if (cancelled.status !== "opened") throw new Error("Expected cancellable Interaction.");
    cancelling.coordinator.cancelAll("cancel-request-1");
    expect(await cancelled.completion).toMatchObject({
      status: "cancelled",
      code: "interaction_cancelled",
    });

    const invalidating = createFixture();
    const invalidated = invalidating.coordinator.open(openInput());
    if (invalidated.status !== "opened") throw new Error("Expected invalidatable Interaction.");
    expect(invalidating.coordinator.invalidate(
      invalidated.pending.request,
      "subject_revision_stale",
    )).toBe(true);
    expect(await invalidated.completion).toMatchObject({
      status: "invalidated",
      code: "subject_revision_stale",
    });

    const unavailable = createFixture();
    expect(unavailable.coordinator.open(openInput({
      protocol: { owner: "missing", kind: "question", revision: "1" },
    }))).toMatchObject({
      status: "unavailable",
      code: "interaction_protocol_unavailable",
    });
    unavailable.coordinator.close();
    expect(unavailable.coordinator.open(openInput())).toMatchObject({
      status: "unavailable",
      code: "interaction_run_settled",
    });
  });
});

function createFixture() {
  const ref: InteractionProtocolRef<"question"> = {
    owner: "test-owner",
    kind: "question",
    revision: "1",
  };
  const protocol = {
    ref,
    createRequest(input: any) {
      return snapshotInteractionRequest({
        ref: {
          id: input.requestId,
          protocol: ref,
          requestVersion: input.requestVersion,
          subject: input.subjectRef,
        },
        subject: input.subject,
        correlation: input.correlation,
        parentRunAction: input.parentRunAction,
        presentation: input.presentation,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      }, snapshot, snapshot);
    },
    validateSubmission(_request: unknown, candidate: unknown) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("actorId" in candidate) ||
        candidate.actorId !== "eligible"
      ) {
        throw new TypeError("The responder is not eligible.");
      }
      return snapshot(candidate);
    },
    resolve({ submission }: any) {
      return submission;
    },
    apply({ resolution }: any) {
      return resolution;
    },
  };
  let sequence = 0;
  const coordinator = new RunInteractionCoordinator({
    runId: "run-1",
    registry: createInteractionProtocolRegistrySnapshot("phase27-interactions", [{
      ref,
      protocol,
    }]),
    now: () => NOW,
    createId: (kind) => `${kind}-${++sequence}`,
    onOpened: () => undefined,
    onSettled: () => undefined,
  });
  return { coordinator };
}

function openInput(
  overrides: Partial<OpenRuntimeInteractionInput> = {},
): OpenRuntimeInteractionInput {
  return {
    requestId: "request-1",
    protocol: { owner: "test-owner", kind: "question", revision: "1" },
    subject: { question: "Continue?" },
    subjectRef: {
      owner: "test-owner",
      kind: "question-subject",
      id: "subject-1",
      revision: "1",
    },
    correlation: {
      kind: "owner_operation",
      owner: "test-owner",
      operationId: "question-1",
      operationRevision: "1",
    },
    parentRunAction: null,
    presentation: { title: "Question" },
    requestVersion: 1,
    expiresAt: null,
    blockingScope: "branch",
    createdAt: NOW,
    ...overrides,
  };
}

function submission(input: {
  readonly request: InteractionRequestRef;
  readonly submissionId: string;
  readonly contentDigest?: string;
  readonly payload?: unknown;
}) {
  return {
    request: input.request,
    submissionId: input.submissionId,
    contentDigest: input.contentDigest ?? "sha256:answer",
    payload: input.payload ?? { actorId: "eligible", answer: "yes" },
    receivedAt: NOW,
  };
}

function snapshot<T>(input: T): T {
  return Object.freeze(structuredClone(input));
}
