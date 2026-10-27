import { createInteractionProtocolRegistrySnapshot } from "@agent-anything/interaction/coordination";
import {
  snapshotInteractionRequest,
  type InteractionProtocolRef,
  type InteractionRequestRef,
} from "@agent-anything/interaction/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionFlowObservation } from "@agent-anything/observability/execution-flow";
import {
  RunInteractionCoordinator,
  type OpenRuntimeInteractionInput,
  type RunInteractionCheckpoint,
  type RunInteractionCoordinatorDependencies,
} from "./RunInteractionCoordinator.js";
import { RunCommitError } from "./RunCommitPort.js";

const NOW = "2026-08-14T00:00:00.000Z";

describe("RunInteractionCoordinator adverse conformance", () => {
  it.each(["submission", "application", "outcome"] as const)("restores the exact %s position without replaying an unknown application", async crash => {
    let saved!: RunInteractionCheckpoint;
    let coordinator!: RunInteractionCoordinator;
    const apply = vi.fn((input: {resolution: unknown}) => input.resolution);
    const fixture = createFixture({onChanged: async () => {
      saved = coordinator.checkpoint();
      const record = saved.records[0]!;
      if ((crash === "submission" && record.submission !== null) ||
          (crash === "application" && record.applicationStarted) ||
          (crash === "outcome" && record.outcome !== null)) throw new Error("worker acknowledgement lost");
    }}, apply);
    coordinator = fixture.coordinator;
    const opened = await coordinator.open(openInput());
    if (opened.status !== "opened") throw new Error("Expected opened request");
    const input = submission({request: opened.pending.request, submissionId: "saved-answer"});
    if (crash === "submission") await expect(coordinator.submit(input)).rejects.toBeInstanceOf(RunCommitError);
    else expect((await coordinator.submit(input)).status).toBe("accepted_for_resolution");
    await expect(opened.completion).rejects.toBeInstanceOf(RunCommitError);
    const callsBefore = apply.mock.calls.length;
    const resumed = RunInteractionCoordinator.restore({...fixture.dependencies, onChanged: async () => {}}, saved);
    if (crash === "application") {
      expect(resumed.getRecoveryIssues()).toEqual([{request: input.request, code: "interaction_application_unconfirmed"}]);
      await expect(resumed.activateRestored()).rejects.toThrow("reconciled");
      expect(apply).toHaveBeenCalledTimes(0);
      await resumed.cancelAll("cancel-interrupted");
    } else {
      expect(resumed.getRecoveryIssues()).toEqual([]);
      await resumed.activateRestored();
      expect(await resumed.completion(input.request)).toMatchObject({status: "resolved", applicationValue: input.payload});
      expect(apply).toHaveBeenCalledTimes(crash === "submission" ? 1 : callsBefore);
      expect((await resumed.submit(input)).status).toBe("duplicate_identical");
      expect(resumed.checkpoint().records[0]!.request).toEqual(saved.records[0]!.request);
      expect(resumed.checkpoint().nextApplication).toBe(2);
    }
  });

  it("waits for submission persistence before acknowledging or applying the answer", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => {entered = resolve;});
    const held = new Promise<void>(resolve => {release = resolve;});
    const apply = vi.fn((input: {resolution: unknown}) => input.resolution);
    const fixture = createFixture({onChanged: async () => {entered(); await held;}}, apply);
    const opened = await fixture.coordinator.open(openInput());
    if (opened.status !== "opened") throw new Error("Expected opened request");
    let acknowledged = false;
    const accepted = fixture.coordinator.submit(submission({request: opened.pending.request, submissionId: "answer"}))
      .then(value => {acknowledged = true; return value;});
    await waiting;
    expect(acknowledged).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    release();
    expect((await accepted).status).toBe("accepted_for_resolution");
    expect((await opened.completion).status).toBe("resolved");
  });

  it("restores an unanswered request with its original identity and expiry", async () => {
    const fixture = createFixture();
    const opened = await fixture.coordinator.open(openInput());
    if (opened.status !== "opened") throw new Error("Expected opened request");
    const saved = fixture.coordinator.checkpoint();
    const restored = RunInteractionCoordinator.restore(fixture.dependencies, saved);
    expect(restored.checkpoint()).toEqual(saved);
    expect(restored.getPendingProjections()).toEqual(fixture.coordinator.getPendingProjections());
    await restored.activateRestored();
    await expect(restored.activateRestored()).rejects.toThrow("already activated");
    await restored.cancelAll("cancel");
    expect(await restored.completion(opened.pending.request)).toMatchObject({status: "cancelled"});
    await fixture.coordinator.close();
  });

  it("distinguishes no submission from an accepted submission cancelled before resolution", async () => {
    for (const received of [false, true]) {
      const facts: ExecutionFlowObservation[] = [];
      const fixture = createFixture();
      const opened = (await fixture.coordinator.open(openInput({executionFlow: {observer: {observe: fact => {facts.push(fact);}}}})));
      if (opened.status !== "opened") throw new Error("Expected opened interaction");
      const submitted = received ? fixture.coordinator.submit(submission({request: opened.pending.request, submissionId: "accepted"})) : null;
      await fixture.coordinator.cancelAll("cancel");
      await submitted;
      expect((await opened.completion).status).toBe("cancelled");
      const receipts = facts.filter(fact => fact.kind === "constraint" && fact.checkId === "submission_receipt");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({disposition: received ? "passed" : "not_evaluated"});
      expect(facts.some(fact => fact.kind === "material" && fact.name === "Interaction settlement")).toBe(true);
      expect(facts.some(fact => fact.kind === "material" && fact.name === "Interaction submission receipt")).toBe(received);
    }
  });
  it("rejects stale, wrong-subject, duplicate-conflicting, and late submissions", async () => {
    const fixture = createFixture();
    expect(fixture.coordinator.getAvailabilitySnapshot(
      { owner: "test-owner", kind: "question", revision: "1" },
      1,
    )).toMatchObject({
      revision: 0,
      activeCount: 0,
      protocolAvailable: true,
      hasCapacity: true,
    });
    const opened = (await fixture.coordinator.open(openInput()));
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    expect(fixture.coordinator.getAvailabilitySnapshot(
      opened.pending.request.protocol,
      1,
    )).toMatchObject({
      revision: 1,
      activeCount: 1,
      hasCapacity: false,
    });

    expect(await fixture.coordinator.submit(submission({
      request: { ...opened.pending.request, requestVersion: 2 },
      submissionId: "stale-version",
    }))).toMatchObject({ status: "rejected", code: "interaction_version_stale" });
    expect(await fixture.coordinator.submit(submission({
      request: {
        ...opened.pending.request,
        subject: { ...opened.pending.request.subject, id: "wrong-subject" },
      },
      submissionId: "wrong-subject",
    }))).toMatchObject({ status: "rejected", code: "interaction_not_pending" });

    const first = await fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "submission-1",
    }));
    const duplicate = await fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "submission-1",
    }));
    const conflict = await fixture.coordinator.submit(submission({
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
    expect(fixture.coordinator.getAvailabilitySnapshot(
      opened.pending.request.protocol,
      1,
    )).toMatchObject({
      revision: 2,
      activeCount: 0,
      hasCapacity: true,
    });
    expect(await fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "late-submission",
    }))).toMatchObject({ status: "rejected", code: "interaction_not_pending" });
  });

  it("accepts transport before rejecting an ineligible responder semantically", async () => {
    const fixture = createFixture();
    const opened = (await fixture.coordinator.open(openInput()));
    if (opened.status !== "opened") throw new Error("Expected an opened Interaction.");

    expect((await fixture.coordinator.submit(submission({
      request: opened.pending.request,
      submissionId: "wrong-responder",
      payload: { actorId: "ineligible", answer: "yes" },
    }))).status).toBe("accepted_for_resolution");
    expect(await opened.completion).toMatchObject({
      status: "failed",
      owner: "test-owner",
      code: "interaction_submission_invalid",
    });
  });

  it("settles expiry, cancellation, invalidation, unavailability, and post-Run closure exactly", async () => {
    const expiring = createFixture();
    const expired = (await expiring.coordinator.open(openInput({
      expiresAt: "2026-08-14T00:00:00.001Z",
    })));
    if (expired.status !== "opened") throw new Error("Expected expiring Interaction.");
    expect(await expired.completion).toMatchObject({
      status: "expired",
      code: "interaction_expired",
    });

    const cancelling = createFixture();
    const cancelled = (await cancelling.coordinator.open(openInput()));
    if (cancelled.status !== "opened") throw new Error("Expected cancellable Interaction.");
    await cancelling.coordinator.cancelAll("cancel-request-1");
    expect(await cancelled.completion).toMatchObject({
      status: "cancelled",
      code: "interaction_cancelled",
    });

    const invalidating = createFixture();
    const invalidated = (await invalidating.coordinator.open(openInput()));
    if (invalidated.status !== "opened") throw new Error("Expected invalidatable Interaction.");
    expect(await invalidating.coordinator.invalidate(
      invalidated.pending.request,
      "subject_revision_stale",
    )).toBe(true);
    expect(await invalidated.completion).toMatchObject({
      status: "invalidated",
      code: "subject_revision_stale",
    });

    const unavailable = createFixture();
    expect((await unavailable.coordinator.open(openInput({
      protocol: { owner: "missing", kind: "question", revision: "1" },
    })))).toMatchObject({
      status: "unavailable",
      code: "interaction_protocol_unavailable",
    });
    await unavailable.coordinator.close();
    expect((await unavailable.coordinator.open(openInput()))).toMatchObject({
      status: "unavailable",
      code: "interaction_run_settled",
    });
  });
});

function createFixture(overrides: Partial<RunInteractionCoordinatorDependencies> = {}, apply?: (input: {resolution: unknown}) => unknown) {
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
      return apply ? apply({resolution}) : resolution;
    },
  };
  const dependencies: RunInteractionCoordinatorDependencies = {
    runId: "run-1",
    registry: createInteractionProtocolRegistrySnapshot("runner-interactions", [{
      ref,
      protocol,
    }]),
    now: () => NOW,
    createId: (kind, index) => `${kind}-${index}`,
    onOpened: () => undefined,
    onSettled: () => undefined,
    ...overrides,
  };
  const coordinator = new RunInteractionCoordinator(dependencies);
  return { coordinator, dependencies };
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
