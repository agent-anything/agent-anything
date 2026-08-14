import { describe, expect, it } from "vitest";
import type { ModelContinuationRef } from "./ModelContinuation.js";
import {
  snapshotModelContinuationCapability,
  snapshotModelContinuationCompatibility,
  snapshotModelContinuationOutcome,
  snapshotModelContinuationRef,
} from "./ModelContinuation.js";

describe("Model continuation contracts", () => {
  it("preserves exact Provider, branch, Context, protocol, Tool, and policy lineage", () => {
    const continuation = snapshotModelContinuationRef(validContinuation());

    expect(continuation.activeContext).toEqual({
      id: "context-1",
      runId: "run-1",
      version: 4,
    });
    expect(continuation.toolExposure.revision).toBe("2");
    expect(continuation.policy.revision).toBe("7");
    expect(Object.isFrozen(continuation.activeContext)).toBe(true);
  });

  it("reports unsupported continuation without fabricating an empty handle", () => {
    const unsupported = snapshotModelContinuationCapability({ supported: false });
    expect(unsupported).toEqual({ supported: false });
    expect("mechanism" in unsupported).toBe(false);
  });

  it("keeps compatibility and lifecycle outcomes explicit", () => {
    expect(snapshotModelContinuationCompatibility({
      kind: "incompatible",
      reason: "active_context_changed",
    })).toEqual({ kind: "incompatible", reason: "active_context_changed" });

    expect(snapshotModelContinuationOutcome({
      kind: "reset",
      previousContinuationId: "continuation-1",
      reason: "provider_rejected",
    })).toEqual({
      kind: "reset",
      previousContinuationId: "continuation-1",
      reason: "provider_rejected",
    });
  });

  it("rejects untracked fields in opaque transport lineage", () => {
    expect(() => snapshotModelContinuationRef({
      ...validContinuation(),
      metadata: { productState: true },
    } as ModelContinuationRef)).toThrow(TypeError);
  });
});

function validContinuation(): ModelContinuationRef {
  return {
    id: "continuation-2",
    providerId: "provider-1",
    model: "model-1",
    mechanism: "response_chaining",
    predecessor: {
      continuationId: "continuation-1",
      responseId: "response-1",
    },
    branchId: "branch-main",
    requestId: "request-2",
    responseId: "response-2",
    activeContext: { id: "context-1", runId: "run-1", version: 4 },
    protocol: { id: "helarc-controller", revision: "5" },
    toolExposure: { id: "tools-1", revision: "2" },
    policy: { id: "model-input-policy", revision: "7" },
    state: {
      kind: "opaque_provider_state",
      handle: "provider-owned-state",
      sensitivity: "restricted",
    },
    createdAt: "2026-08-14T00:00:02.000Z",
  };
}
