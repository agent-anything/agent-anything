import {
  snapshotInteractionProtocolRef,
  snapshotInteractionRequestRef,
  type InteractionProtocol,
  type InteractionProtocolRef,
  type InteractionRequest,
  type InteractionRequestRef,
} from "../protocol/index.js";
import { denseArray, fail, strictRecord, token } from "../internal/validation.js";

export type PendingInteractionLifecycle =
  | "pending"
  | "resolved"
  | "expired"
  | "cancelled"
  | "invalidated"
  | "failed";

export interface PendingInteractionRef {
  readonly request: InteractionRequestRef;
  readonly lifecycle: PendingInteractionLifecycle;
  readonly blockingScope: "none" | "branch" | "run";
}

export interface InteractionProtocolRegistration<
  TKind extends string = string,
  TSubject = unknown,
  TPresentation = unknown,
  TSubmission = unknown,
  TResolution = unknown,
  TApplication = unknown,
> {
  readonly ref: InteractionProtocolRef;
  readonly protocol: InteractionProtocol<
    TKind,
    TSubject,
    TPresentation,
    TSubmission,
    TResolution,
    TApplication
  >;
}

export interface CapturedInteractionProtocol {
  readonly ref: InteractionProtocolRef;
  createRequest(input: Parameters<InteractionProtocol<string, unknown, unknown, unknown, unknown, unknown>["createRequest"]>[0]): ReturnType<InteractionProtocol<string, unknown, unknown, unknown, unknown, unknown>["createRequest"]>;
  validateSubmission(request: InteractionRequest<string, unknown, unknown>, candidate: unknown): unknown;
  resolve(input: { readonly request: InteractionRequest<string, unknown, unknown>; readonly submissionId: string; readonly submission: unknown; readonly receivedAt: string }): unknown;
  apply(input: { readonly request: InteractionRequest<string, unknown, unknown>; readonly resolution: unknown; readonly resolvedAt: string }): unknown | Promise<unknown>;
}

export interface InteractionProtocolRegistrySnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly protocols: readonly InteractionProtocolRef[];
  find(ref: InteractionProtocolRef): CapturedInteractionProtocol | undefined;
}

export function createInteractionProtocolRegistrySnapshot(
  snapshotId: string,
  registrations: readonly InteractionProtocolRegistration<string, any, any, any, any, any>[],
): InteractionProtocolRegistrySnapshot {
  const capturedSnapshotId = token(snapshotId, "snapshotId");
  denseArray(registrations, "registrations");
  const captured = new Map<string, CapturedInteractionProtocol>();
  for (let index = 0; index < registrations.length; index += 1) {
    const input = registrations[index]!;
    const path = `registrations[${index}]`;
    strictRecord(input, path, ["ref", "protocol"]);
    const ref = snapshotInteractionProtocolRef(input.ref, `${path}.ref`);
    const protocolRef = snapshotInteractionProtocolRef(input.protocol.ref, `${path}.protocol.ref`);
    if (protocolKey(ref) !== protocolKey(protocolRef)) {
      fail("interaction_protocol_invalid", "Protocol implementation identity does not match its registration.", `${path}.protocol.ref`);
    }
    if (
      typeof input.protocol.createRequest !== "function" ||
      typeof input.protocol.validateSubmission !== "function" ||
      typeof input.protocol.resolve !== "function" ||
      typeof input.protocol.apply !== "function"
    ) fail("interaction_protocol_invalid", "Protocol implementation is incomplete.", `${path}.protocol`);
    const key = protocolKey(ref);
    if (captured.has(key)) fail("interaction_protocol_duplicate", `Duplicate protocol '${key}'.`, path);
    captured.set(key, Object.freeze({
      ref,
      createRequest: input.protocol.createRequest.bind(input.protocol) as CapturedInteractionProtocol["createRequest"],
      validateSubmission: input.protocol.validateSubmission.bind(input.protocol) as CapturedInteractionProtocol["validateSubmission"],
      resolve: input.protocol.resolve.bind(input.protocol) as CapturedInteractionProtocol["resolve"],
      apply: input.protocol.apply.bind(input.protocol) as CapturedInteractionProtocol["apply"],
    }));
  }
  const protocols = Object.freeze([...captured.values()].map(({ ref }) => ref).sort((left, right) => protocolKey(left).localeCompare(protocolKey(right))));
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: capturedSnapshotId,
    protocols,
    find(ref: InteractionProtocolRef) {
      return captured.get(
        protocolKey(snapshotInteractionProtocolRef(ref, "InteractionProtocolRegistry.find.ref")),
      );
    },
  });
}

export function snapshotPendingInteractionRef(
  input: PendingInteractionRef,
): PendingInteractionRef {
  strictRecord(input, "PendingInteractionRef", ["request", "lifecycle", "blockingScope"]);
  if (!["pending", "resolved", "expired", "cancelled", "invalidated", "failed"].includes(input.lifecycle)) {
    fail("interaction_contract_invalid", "Unsupported pending Interaction lifecycle.", "PendingInteractionRef.lifecycle");
  }
  if (!["none", "branch", "run"].includes(input.blockingScope)) {
    fail("interaction_contract_invalid", "Unsupported Interaction blocking scope.", "PendingInteractionRef.blockingScope");
  }
  return Object.freeze({
    request: snapshotInteractionRequestRef(input.request, "PendingInteractionRef.request"),
    lifecycle: input.lifecycle,
    blockingScope: input.blockingScope,
  });
}

function protocolKey(ref: InteractionProtocolRef): string {
  return `${ref.owner}:${ref.kind}@${ref.revision}`;
}
