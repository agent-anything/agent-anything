import {
  snapshotInteractionRequestRef,
  type InteractionRequestRef,
} from "../protocol/index.js";
import { dateTime, fail, strictRecord, token } from "../internal/validation.js";

export interface InteractionSubmissionRecordRef {
  readonly request: InteractionRequestRef;
  readonly submissionId: string;
  readonly contentDigest: string;
}

export interface InteractionTransportReceipt {
  readonly receiptId: string;
  readonly request: InteractionRequestRef;
  readonly submissionId: string;
  readonly status: "accepted_for_resolution" | "duplicate_identical" | "rejected";
  readonly recordedAt: string;
}

export interface InteractionResolutionRef {
  readonly request: InteractionRequestRef;
  readonly resolutionId: string;
  readonly resolutionRevision: string;
}

export interface InteractionApplicationRef {
  readonly resolution: InteractionResolutionRef;
  readonly owner: string;
  readonly applicationId: string;
}

export type InteractionTerminalRecord =
  | {
      readonly kind: "resolved";
      readonly request: InteractionRequestRef;
      readonly resolution: InteractionResolutionRef;
    }
  | {
      readonly kind: "expired";
      readonly request: InteractionRequestRef;
      readonly expiredAt: string;
    }
  | {
      readonly kind: "cancelled";
      readonly request: InteractionRequestRef;
      readonly cancellationId: string;
    }
  | {
      readonly kind: "invalidated";
      readonly request: InteractionRequestRef;
      readonly reasonCode: string;
    }
  | {
      readonly kind: "failed";
      readonly request: InteractionRequestRef;
      readonly owner: string;
      readonly failureRef: string;
    };

export function snapshotInteractionSubmissionRecordRef(
  input: InteractionSubmissionRecordRef,
): InteractionSubmissionRecordRef {
  strictRecord(input, "InteractionSubmissionRecordRef", [
    "request",
    "submissionId",
    "contentDigest",
  ]);
  return Object.freeze({
    request: snapshotInteractionRequestRef(
      input.request,
      "InteractionSubmissionRecordRef.request",
    ),
    submissionId: token(
      input.submissionId,
      "InteractionSubmissionRecordRef.submissionId",
    ),
    contentDigest: token(
      input.contentDigest,
      "InteractionSubmissionRecordRef.contentDigest",
    ),
  });
}

export function snapshotInteractionTransportReceipt(
  input: InteractionTransportReceipt,
): InteractionTransportReceipt {
  strictRecord(input, "InteractionTransportReceipt", [
    "receiptId",
    "request",
    "submissionId",
    "status",
    "recordedAt",
  ]);
  if (!["accepted_for_resolution", "duplicate_identical", "rejected"].includes(input.status)) {
    fail(
      "interaction_contract_invalid",
      "Unsupported Interaction transport receipt status.",
      "InteractionTransportReceipt.status",
    );
  }
  return Object.freeze({
    receiptId: token(input.receiptId, "InteractionTransportReceipt.receiptId"),
    request: snapshotInteractionRequestRef(
      input.request,
      "InteractionTransportReceipt.request",
    ),
    submissionId: token(
      input.submissionId,
      "InteractionTransportReceipt.submissionId",
    ),
    status: input.status,
    recordedAt: dateTime(input.recordedAt, "InteractionTransportReceipt.recordedAt"),
  });
}

export function snapshotInteractionResolutionRef(
  input: InteractionResolutionRef,
  path = "InteractionResolutionRef",
): InteractionResolutionRef {
  strictRecord(input, path, ["request", "resolutionId", "resolutionRevision"]);
  return Object.freeze({
    request: snapshotInteractionRequestRef(input.request, `${path}.request`),
    resolutionId: token(input.resolutionId, `${path}.resolutionId`),
    resolutionRevision: token(
      input.resolutionRevision,
      `${path}.resolutionRevision`,
    ),
  });
}

export function snapshotInteractionApplicationRef(
  input: InteractionApplicationRef,
  path = "InteractionApplicationRef",
): InteractionApplicationRef {
  strictRecord(input, path, ["resolution", "owner", "applicationId"]);
  return Object.freeze({
    resolution: snapshotInteractionResolutionRef(
      input.resolution,
      `${path}.resolution`,
    ),
    owner: token(input.owner, `${path}.owner`),
    applicationId: token(input.applicationId, `${path}.applicationId`),
  });
}

export function snapshotInteractionTerminalRecord(
  input: InteractionTerminalRecord,
): InteractionTerminalRecord {
  strictRecord(input, "InteractionTerminalRecord", [
    "kind",
    "request",
    "resolution",
    "expiredAt",
    "cancellationId",
    "reasonCode",
    "owner",
    "failureRef",
  ]);
  const request = snapshotInteractionRequestRef(
    input.request,
    "InteractionTerminalRecord.request",
  );
  switch (input.kind) {
    case "resolved": {
      strictRecord(input, "InteractionTerminalRecord", [
        "kind",
        "request",
        "resolution",
      ]);
      const resolution = snapshotInteractionResolutionRef(
        input.resolution,
        "InteractionTerminalRecord.resolution",
      );
      assertSameRequest(request, resolution.request, "InteractionTerminalRecord.resolution.request");
      return Object.freeze({ kind: "resolved", request, resolution });
    }
    case "expired":
      strictRecord(input, "InteractionTerminalRecord", ["kind", "request", "expiredAt"]);
      return Object.freeze({
        kind: "expired",
        request,
        expiredAt: dateTime(input.expiredAt, "InteractionTerminalRecord.expiredAt"),
      });
    case "cancelled":
      strictRecord(input, "InteractionTerminalRecord", ["kind", "request", "cancellationId"]);
      return Object.freeze({
        kind: "cancelled",
        request,
        cancellationId: token(input.cancellationId, "InteractionTerminalRecord.cancellationId"),
      });
    case "invalidated":
      strictRecord(input, "InteractionTerminalRecord", ["kind", "request", "reasonCode"]);
      return Object.freeze({
        kind: "invalidated",
        request,
        reasonCode: token(input.reasonCode, "InteractionTerminalRecord.reasonCode"),
      });
    case "failed":
      strictRecord(input, "InteractionTerminalRecord", ["kind", "request", "owner", "failureRef"]);
      return Object.freeze({
        kind: "failed",
        request,
        owner: token(input.owner, "InteractionTerminalRecord.owner"),
        failureRef: token(input.failureRef, "InteractionTerminalRecord.failureRef"),
      });
    default:
      return fail(
        "interaction_contract_invalid",
        "Unsupported Interaction terminal record kind.",
        "InteractionTerminalRecord.kind",
      );
  }
}

function assertSameRequest(
  expected: InteractionRequestRef,
  actual: InteractionRequestRef,
  path: string,
): void {
  if (requestKey(expected) !== requestKey(actual)) {
    fail(
      "interaction_contract_invalid",
      "Interaction record references do not identify the same request.",
      path,
    );
  }
}

function requestKey(input: InteractionRequestRef): string {
  return [
    input.protocol.owner,
    input.protocol.kind,
    input.protocol.revision,
    input.id,
    input.requestVersion,
    input.subject.owner,
    input.subject.kind,
    input.subject.id,
    input.subject.revision,
  ].join(":" );
}
