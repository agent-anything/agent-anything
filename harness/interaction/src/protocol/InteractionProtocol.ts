import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import {
  snapshotOperationCorrelation,
  type OperationCorrelation,
} from "@agent-anything/operation-catalog/identity";
import {
  dateTime,
  fail,
  positiveInteger,
  strictRecord,
  token,
} from "../internal/validation.js";

export interface InteractionProtocolRef<TKind extends string = string> {
  readonly owner: string;
  readonly kind: TKind;
  readonly revision: string;
}

export interface InteractionSubjectRef<TKind extends string = string> {
  readonly owner: string;
  readonly kind: TKind;
  readonly id: string;
  readonly revision: string;
}

export interface InteractionRequestRef<TKind extends string = string> {
  readonly id: string;
  readonly protocol: InteractionProtocolRef<TKind>;
  readonly requestVersion: number;
  readonly subject: InteractionSubjectRef;
}

export interface InteractionCreateInput<TSubject, TPresentation> {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly subject: TSubject;
  readonly subjectRef: InteractionSubjectRef;
  readonly correlation: OperationCorrelation;
  readonly parentRunAction: RunActionRef | null;
  readonly presentation: TPresentation;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface InteractionRequest<
  TKind extends string,
  TSubject,
  TPresentation,
> {
  readonly ref: InteractionRequestRef<TKind>;
  readonly subject: TSubject;
  readonly correlation: OperationCorrelation;
  readonly parentRunAction: RunActionRef | null;
  readonly presentation: TPresentation;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface InteractionResolveInput<
  TKind extends string,
  TSubmission,
> {
  readonly request: InteractionRequestRef<TKind>;
  readonly submissionId: string;
  readonly submission: TSubmission;
  readonly receivedAt: string;
}

export interface InteractionApplyInput<
  TKind extends string,
  TResolution,
> {
  readonly request: InteractionRequestRef<TKind>;
  readonly resolution: TResolution;
  readonly resolvedAt: string;
}

export interface InteractionProtocol<
  TKind extends string,
  TSubject,
  TPresentation,
  TSubmission,
  TResolution,
  TApplication,
> {
  readonly ref: InteractionProtocolRef<TKind>;
  createRequest(
    input: InteractionCreateInput<TSubject, TPresentation>,
  ): InteractionRequest<TKind, TSubject, TPresentation>;
  validateSubmission(request: InteractionRequestRef<TKind>, candidate: unknown): TSubmission;
  resolve(input: InteractionResolveInput<TKind, TSubmission>): TResolution;
  apply(
    input: InteractionApplyInput<TKind, TResolution>,
  ): TApplication | Promise<TApplication>;
}

export interface SafeInteractionEnvelope<TPresentation> {
  readonly request: InteractionRequestRef;
  readonly presentation: TPresentation;
  readonly disclosureClass: "public" | "internal" | "sensitive";
  readonly expiresAt: string | null;
}

export function snapshotInteractionProtocolRef<TKind extends string>(
  input: InteractionProtocolRef<TKind>,
  path = "InteractionProtocolRef",
): InteractionProtocolRef<TKind> {
  strictRecord(input, path, ["owner", "kind", "revision"]);
  return Object.freeze({
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`) as TKind,
    revision: token(input.revision, `${path}.revision`),
  });
}

export function snapshotInteractionSubjectRef<TKind extends string>(
  input: InteractionSubjectRef<TKind>,
  path = "InteractionSubjectRef",
): InteractionSubjectRef<TKind> {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return Object.freeze({
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`) as TKind,
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  });
}

export function snapshotInteractionRequestRef<TKind extends string>(
  input: InteractionRequestRef<TKind>,
  path = "InteractionRequestRef",
): InteractionRequestRef<TKind> {
  strictRecord(input, path, ["id", "protocol", "requestVersion", "subject"]);
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    protocol: snapshotInteractionProtocolRef(input.protocol, `${path}.protocol`),
    requestVersion: positiveInteger(input.requestVersion, `${path}.requestVersion`),
    subject: snapshotInteractionSubjectRef(input.subject, `${path}.subject`),
  });
}

export function snapshotInteractionRequest<
  TKind extends string,
  TSubject,
  TPresentation,
>(
  input: InteractionRequest<TKind, TSubject, TPresentation>,
  snapshotSubject: (subject: TSubject) => TSubject,
  snapshotPresentation: (presentation: TPresentation) => TPresentation,
): InteractionRequest<TKind, TSubject, TPresentation> {
  strictRecord(input, "InteractionRequest", [
    "ref",
    "subject",
    "correlation",
    "parentRunAction",
    "presentation",
    "expiresAt",
    "createdAt",
  ]);
  const createdAt = dateTime(input.createdAt, "InteractionRequest.createdAt");
  const expiresAt =
    input.expiresAt === null
      ? null
      : dateTime(input.expiresAt, "InteractionRequest.expiresAt");
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail(
      "interaction_contract_invalid",
      "Interaction expiry must be later than its creation time.",
      "InteractionRequest.expiresAt",
    );
  }
  const correlation = snapshotOperationCorrelation(input.correlation);
  const parentRunAction =
    input.parentRunAction === null
      ? null
      : snapshotRunActionRef(
          input.parentRunAction,
          "InteractionRequest.parentRunAction",
        );
  if (correlation.kind === "run_action") {
    if (
      parentRunAction === null ||
      runActionKey(parentRunAction) !== runActionKey(correlation.runAction)
    ) {
      fail(
        "interaction_contract_invalid",
        "Run Action interaction correlation requires the exact parent Run Action.",
        "InteractionRequest.parentRunAction",
      );
    }
  } else if (parentRunAction !== null) {
    fail(
      "interaction_contract_invalid",
      "Only Run Action correlation may carry a parent Run Action.",
      "InteractionRequest.parentRunAction",
    );
  }
  return Object.freeze({
    ref: snapshotInteractionRequestRef(input.ref, "InteractionRequest.ref"),
    subject: snapshotSubject(input.subject),
    correlation,
    parentRunAction,
    presentation: snapshotPresentation(input.presentation),
    expiresAt,
    createdAt,
  });
}

export function snapshotSafeInteractionEnvelope<TPresentation>(
  input: SafeInteractionEnvelope<TPresentation>,
  snapshotPresentation: (presentation: TPresentation) => TPresentation,
): SafeInteractionEnvelope<TPresentation> {
  strictRecord(input, "SafeInteractionEnvelope", [
    "request",
    "presentation",
    "disclosureClass",
    "expiresAt",
  ]);
  if (!["public", "internal", "sensitive"].includes(input.disclosureClass)) {
    fail(
      "interaction_contract_invalid",
      "Unsupported Interaction disclosure class.",
      "SafeInteractionEnvelope.disclosureClass",
    );
  }
  return Object.freeze({
    request: snapshotInteractionRequestRef(
      input.request,
      "SafeInteractionEnvelope.request",
    ),
    presentation: snapshotPresentation(input.presentation),
    disclosureClass: input.disclosureClass,
    expiresAt:
      input.expiresAt === null
        ? null
        : dateTime(input.expiresAt, "SafeInteractionEnvelope.expiresAt"),
  });
}

function snapshotRunActionRef(input: RunActionRef, path: string): RunActionRef {
  strictRecord(input, path, ["run", "id", "sequence"]);
  strictRecord(input.run, `${path}.run`, ["id"]);
  return Object.freeze({
    run: Object.freeze({ id: token(input.run.id, `${path}.run.id`) }),
    id: token(input.id, `${path}.id`),
    sequence: positiveInteger(input.sequence, `${path}.sequence`),
  });
}

function runActionKey(input: RunActionRef): string {
  return `${input.run.id}:${input.sequence}:${input.id}`;
}
