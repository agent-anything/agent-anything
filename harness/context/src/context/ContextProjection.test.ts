import type { ContextObservation } from "./Context.js";
import { describe, expect, it } from "vitest";
import {
  ContextProjectionError,
  snapshotContextProjection,
  type ContextProjectionRequest,
} from "./ContextProjection.js";

interface TestObservation extends ContextObservation {
  readonly kind: "test_result";
  readonly value: unknown;
}

describe("Context projection Contracts", () => {
  it("snapshots a bounded projection", () => {
    const projection = snapshotContextProjection({
      projection: {
        messages: [{
          id: "message-1",
          role: "user",
          content: "Inspect the workspace.",
          metadata: {},
        }],
        observations: [observation()],
        evidenceRefs: ["evidence-1"],
        metadata: { purpose: "test" },
      },
      request: request(),
    });

    expect(projection.observations[0]?.kind).toBe("test_result");
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.observations)).toBe(true);
  });

  it("rejects a cross-Run Observation", () => {
    expect(() =>
      snapshotContextProjection({
        projection: {
          messages: [],
          observations: [{ ...observation(), runId: "run-2" }],
          evidenceRefs: [],
          metadata: {},
        },
        request: request(),
      }),
    ).toThrow(ContextProjectionError);
  });

  it("rejects projections that exceed declared limits", () => {
    expect(() =>
      snapshotContextProjection({
        projection: {
          messages: [],
          observations: [observation()],
          evidenceRefs: [],
          metadata: {},
        },
        request: request({ maxObservations: 0 }),
      }),
    ).toThrow("exceeds its configured limit");
  });

  it("rejects non-serializable Observation content", () => {
    expect(() =>
      snapshotContextProjection({
        projection: {
          messages: [],
          observations: [observation(1n)],
          evidenceRefs: [],
          metadata: {},
        },
        request: request(),
      }),
    ).toThrow("non-serializable Observation");
  });

  it("rejects duplicate projected identities", () => {
    expect(() =>
      snapshotContextProjection({
        projection: {
          messages: [],
          observations: [observation(), observation()],
          evidenceRefs: [],
          metadata: {},
        },
        request: request(),
      }),
    ).toThrow("duplicate Observation identity");
  });
});

function observation(value: unknown = "accepted"): TestObservation {
  return {
    id: "observation-1",
    runId: "run-1",
    actionId: "action-1",
    kind: "test_result",
    value,
    createdAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}

function request(
  limits: Partial<ContextProjectionRequest["limits"]> = {},
): ContextProjectionRequest {
  return {
    runId: "run-1",
    controllerIteration: 1,
    purpose: "model",
    limits: {
      maxMessages: 10,
      maxMessageLength: 1_000,
      maxObservations: 10,
      maxObservationBytes: 10_000,
      maxEvidenceRefs: 10,
      maxMetadataEntries: 10,
      ...limits,
    },
  };
}
