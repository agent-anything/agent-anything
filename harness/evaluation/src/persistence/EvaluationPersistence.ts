import {
  assertIsoTime,
  assertText,
  assertToken,
  createEvaluationFailure,
  createEvaluationRecordRef,
  createEvaluationSchemaRef,
  evaluationRefKey,
  snapshotRefs,
  snapshotLimitations,
  type EvaluationFailure,
  type EvaluationLimitation,
  type EvaluationRecordRef,
  type EvaluationSchemaRef,
} from "../contract/EvaluationPrimitives.js";
import {
  assertSafeProjectionData,
  compareText,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
} from "../contract/EvaluationData.js";

export type EvaluationStoreStatus =
  | "stored"
  | "conflict"
  | "rejected"
  | "unavailable"
  | "failed";

export type EvaluationStoreResult =
  | {
      readonly status: "stored";
      readonly persistedRevision: number;
    }
  | {
      readonly status: "conflict";
      readonly currentRevision: number | null;
      readonly failure: EvaluationFailure;
    }
  | {
      readonly status: "rejected" | "unavailable" | "failed";
      readonly failure: EvaluationFailure;
    };

export type EvaluationAppendResult =
  | { readonly status: "stored" }
  | {
      readonly status: "conflict" | "rejected" | "unavailable" | "failed";
      readonly failure: EvaluationFailure;
    };

export interface EvaluationVersionedSnapshot {
  readonly id: string;
  readonly revision: number;
}

export interface EvaluationExpectedRevisionStore<
  TSnapshot extends EvaluationVersionedSnapshot,
> {
  commit(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly snapshot: TSnapshot;
  }): Promise<EvaluationStoreResult>;
}

export interface EvaluationImmutableRecordStore<TRecord> {
  append(record: TRecord): Promise<EvaluationAppendResult>;
}

export class EvaluationPersistenceError extends Error {
  readonly failure: EvaluationFailure;

  constructor(failure: EvaluationFailure) {
    super(failure.message);
    this.name = "EvaluationPersistenceError";
    this.failure = failure;
  }
}

export async function commitEvaluationSnapshot<
  TSnapshot extends EvaluationVersionedSnapshot,
>(
  store: EvaluationExpectedRevisionStore<TSnapshot>,
  snapshot: TSnapshot,
  expectedRevision: number,
): Promise<TSnapshot> {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    snapshot.revision !== expectedRevision + 1
  ) {
    throw persistenceError("Evaluation snapshot revision must advance exactly once.");
  }
  let result: EvaluationStoreResult;
  try {
    result = await store.commit({ id: snapshot.id, expectedRevision, snapshot });
  } catch {
    throw persistenceError("Evaluation snapshot store threw an exception.");
  }
  if (result.status !== "stored") {
    throw new EvaluationPersistenceError(createEvaluationFailure(result.failure));
  }
  if (result.persistedRevision !== snapshot.revision) {
    throw persistenceError("Evaluation snapshot store acknowledged another revision.");
  }
  return snapshot;
}

export async function appendEvaluationRecord<TRecord>(
  store: EvaluationImmutableRecordStore<TRecord>,
  record: TRecord,
): Promise<TRecord> {
  let result: EvaluationAppendResult;
  try {
    result = await store.append(record);
  } catch {
    throw persistenceError("Evaluation immutable record store threw an exception.");
  }
  if (result.status !== "stored") {
    throw new EvaluationPersistenceError(createEvaluationFailure(result.failure));
  }
  return record;
}

export interface EvaluationQueryProjection {
  readonly ref: EvaluationRecordRef;
  readonly schemaRef: EvaluationSchemaRef;
  readonly consumerId: string;
  readonly status: "available" | "redacted";
  readonly recordRefs: readonly EvaluationRecordRef[];
  readonly data: EvaluationDataObject | null;
  readonly createdAt: string;
  readonly limitations: readonly EvaluationLimitation[];
}

export function createEvaluationQueryProjection(
  input: EvaluationQueryProjection,
): EvaluationQueryProjection {
  const ref = createEvaluationRecordRef(input?.ref, "EvaluationQueryProjection.ref");
  const schemaRef = createEvaluationSchemaRef(
    input.schemaRef,
    "EvaluationQueryProjection.schemaRef",
  );
  assertToken(input.consumerId, "EvaluationQueryProjection.consumerId");
  if (input.status !== "available" && input.status !== "redacted") {
    throw new TypeError("EvaluationQueryProjection.status is unsupported.");
  }
  if (
    (input.status === "available" && input.data === null) ||
    (input.status === "redacted" && input.data !== null)
  ) {
    throw new TypeError("EvaluationQueryProjection status and data disagree.");
  }
  const data = input.data === null
    ? null
    : snapshotEvaluationDataObject(input.data, "EvaluationQueryProjection.data");
  if (data !== null) assertSafeProjectionData(data, "EvaluationQueryProjection.data");
  assertIsoTime(input.createdAt, "EvaluationQueryProjection.createdAt");
  const recordRefs = Object.freeze([...snapshotRefs(
    input.recordRefs,
    "EvaluationQueryProjection.recordRefs",
  )].sort((left, right) =>
    compareText(evaluationRefKey(left), evaluationRefKey(right))));
  return Object.freeze({
    ref,
    schemaRef,
    consumerId: input.consumerId,
    status: input.status,
    recordRefs,
    data,
    createdAt: input.createdAt,
    limitations: snapshotLimitations(
      input.limitations,
      "EvaluationQueryProjection.limitations",
    ),
  });
}

function persistenceError(message: string): EvaluationPersistenceError {
  assertText(message, "EvaluationPersistenceError.message");
  return new EvaluationPersistenceError(createEvaluationFailure({
    code: "evaluation_persistence_failed",
    stage: "persistence",
    message,
    retryable: false,
    causeOwner: "evaluation.persistence",
    details: {},
  }));
}
