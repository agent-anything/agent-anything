import { describe, expect, it } from "vitest";
import { createEvaluationFailure } from "../definition/index.js";
import {
  EvaluationPersistenceError,
  appendEvaluationRecord,
  commitEvaluationSnapshot,
  createEvaluationQueryProjection,
  type EvaluationAppendResult,
  type EvaluationStoreResult,
} from "./index.js";

const TIME = "2026-08-01T00:00:00.000Z";

describe("Evaluation persistence ports", () => {
  it("does not treat expected-revision conflict as a committed transition", async () => {
    const snapshot = { id: "trial", revision: 2, status: "running" } as const;
    let stored: typeof snapshot | null = null;
    const store = {
      async commit(): Promise<EvaluationStoreResult> {
        return {
          status: "conflict",
          currentRevision: 3,
          failure: persistenceFailure(),
        };
      },
    };

    await expect(commitEvaluationSnapshot(store, snapshot, 1)).rejects.toBeInstanceOf(
      EvaluationPersistenceError,
    );
    expect(stored).toBeNull();
  });

  it("does not return a record when immutable append is rejected", async () => {
    const record = { ref: { id: "grade", revision: "v1" } };
    const store = {
      async append(): Promise<EvaluationAppendResult> {
        return { status: "rejected", failure: persistenceFailure() };
      },
    };

    await expect(appendEvaluationRecord(store, record)).rejects.toBeInstanceOf(
      EvaluationPersistenceError,
    );
  });

  it("creates purpose-specific safe query Projections", () => {
    const projection = createEvaluationQueryProjection({
      ref: ref("query"),
      schemaRef: { schemaId: "evaluation-query", revision: "v1" },
      consumerId: "engineering-dashboard",
      status: "available",
      recordRefs: [ref("report")],
      data: { status: "completed", failureCount: 0 },
      createdAt: TIME,
      limitations: [],
    });

    expect(Object.isFrozen(projection)).toBe(true);
    expect(() => createEvaluationQueryProjection({
      ...projection,
      ref: ref("unsafe-query"),
      data: { physicalRoot: "C:\\private\\workspace" },
    })).toThrow(/not admitted/);
  });
});

function persistenceFailure() {
  return createEvaluationFailure({
    code: "evaluation_persistence_failed",
    stage: "persistence",
    message: "Persistence failed.",
    retryable: false,
    causeOwner: "test-store",
    details: {},
  });
}

function ref(id: string) {
  return { id, revision: "v1" };
}
