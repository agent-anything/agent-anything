import { describe, expect, it } from "vitest";
import {
  createInteractionProtocolRegistrySnapshot,
  snapshotPendingInteractionRef,
} from "./coordination/index.js";
import {
  snapshotInteractionRequest,
  snapshotSafeInteractionEnvelope,
} from "./protocol/index.js";
import {
  snapshotInteractionTerminalRecord,
  snapshotInteractionTransportReceipt,
} from "./records/index.js";

const ref = { owner: "permission", kind: "approval", revision: "v1" } as const;
const protocol = {
  ref,
  createRequest: (input: never) => input,
  validateSubmission: (_request: never, candidate: unknown) => candidate as never,
  resolve: (input: never) => input,
  apply: (input: never) => input,
};
const requestRef = {
  id: "request-1",
  protocol: ref,
  requestVersion: 1,
  subject: {
    owner: "permission",
    kind: "action-subject",
    id: "subject-1",
    revision: "v1",
  },
} as const;

describe("Interaction contracts", () => {
  it("captures an immutable fail-closed protocol registry", () => {
    const snapshot = createInteractionProtocolRegistrySnapshot("registry-1", [{ ref, protocol }]);
    expect(Object.isFrozen(snapshot.protocols)).toBe(true);
    expect(snapshot.find(ref)?.ref).toEqual(ref);
  });

  it("rejects duplicate and mismatched protocol registrations", () => {
    expect(() => createInteractionProtocolRegistrySnapshot("registry-1", [{ ref, protocol }, { ref, protocol }]))
      .toThrow(/Duplicate protocol/);
    expect(() => createInteractionProtocolRegistrySnapshot("registry-1", [{
      ref,
      protocol: { ...protocol, ref: { ...ref, revision: "v2" } },
    }]))
      .toThrow(/does not match/);
  });

  it("captures owner-typed requests without taking ownership of their payload", () => {
    const subject = { actionId: "action-1" };
    const presentation = { title: "Allow file write" };
    const request = snapshotInteractionRequest({
      ref: requestRef,
      subject,
      correlation: {
        kind: "owner_operation",
        owner: "permission",
        operationId: "approval-1",
        operationRevision: "v1",
      },
      parentRunAction: null,
      presentation,
      expiresAt: "2026-08-12T01:00:00.000Z",
      createdAt: "2026-08-12T00:00:00.000Z",
    }, (value) => Object.freeze({ actionId: value.actionId }), (value) => Object.freeze({ title: value.title }));

    subject.actionId = "changed";
    presentation.title = "changed";
    expect(request.subject.actionId).toBe("action-1");
    expect(request.presentation.title).toBe("Allow file write");
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("validates pending and safe projection contracts fail closed", () => {
    expect(snapshotPendingInteractionRef({
      request: requestRef,
      lifecycle: "pending",
      blockingScope: "branch",
    })).toEqual({ request: requestRef, lifecycle: "pending", blockingScope: "branch" });

    const envelope = snapshotSafeInteractionEnvelope({
      request: requestRef,
      presentation: { title: "Allow file write" },
      disclosureClass: "sensitive",
      expiresAt: null,
    }, (value) => Object.freeze({ title: value.title }));
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(() => snapshotPendingInteractionRef({
      request: requestRef,
      lifecycle: "pending",
      blockingScope: "branch",
      extra: true,
    } as never)).toThrow(/Unsupported field/);
  });

  it("keeps transport acceptance distinct from semantic resolution", () => {
    expect(snapshotInteractionTransportReceipt({
      receiptId: "receipt-1",
      request: requestRef,
      submissionId: "submission-1",
      status: "accepted_for_resolution",
      recordedAt: "2026-08-12T00:01:00.000Z",
    })).toEqual({
      receiptId: "receipt-1",
      request: requestRef,
      submissionId: "submission-1",
      status: "accepted_for_resolution",
      recordedAt: "2026-08-12T00:01:00.000Z",
    });
  });

  it("keeps semantic resolution and application as separate records", () => {
    const resolution = {
      request: requestRef,
      resolutionId: "resolution-1",
      resolutionRevision: "v1",
    } as const;
    expect(snapshotInteractionTerminalRecord({
      kind: "resolved",
      request: requestRef,
      resolution,
    }).kind).toBe("resolved");

    expect(() => snapshotInteractionTerminalRecord({
      kind: "resolved",
      request: requestRef,
      resolution: {
        ...resolution,
        request: { ...requestRef, id: "request-2" },
      },
    })).toThrow(/same request/);
  });
});
