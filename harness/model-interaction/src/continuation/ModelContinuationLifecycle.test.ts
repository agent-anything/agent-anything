import { describe, expect, it, vi } from "vitest";
import type { ModelContinuationRef } from "./ModelContinuation.js";
import {
  checkModelContinuationCompatibility,
  createInMemoryModelContinuationStore,
  ModelContinuationLifecycle,
  type ModelContinuationRequestLineage,
  type ModelContinuationSafeEvent,
  type ModelContinuationStore,
} from "./ModelContinuationLifecycle.js";

const CAPABILITY = {
  supported: true as const,
  mechanism: "response_chaining" as const,
  supportsCompaction: true,
};

describe("ModelContinuationLifecycle", () => {
  it("checks every request compatibility dimension and permits a new request identity", () => {
    const current = continuation();
    expect(checkModelContinuationCompatibility(
      current,
      lineage("request-2"),
      "response_chaining",
    ))
      .toEqual({ kind: "compatible" });

    const cases = [
      ["provider_changed", { providerId: "provider-2" }, "response_chaining"],
      ["model_changed", { model: "model-2" }, "response_chaining"],
      ["mechanism_changed", {}, "provider_conversation"],
      ["branch_changed", { branchId: "branch-2" }, "response_chaining"],
      ["active_context_changed", {
        activeContext: { id: "context-1", runId: "run-1", version: 5 },
      }, "response_chaining"],
      ["protocol_changed", { protocol: { id: "protocol-1", revision: "2" } }, "response_chaining"],
      ["tool_exposure_content_changed", {
        toolExposureContent: { id: "tools-1", revision: "2" },
      }, "response_chaining"],
      ["callable_definitions_changed", {
        callableDefinitions: { id: "callables-1", revision: "2" },
      }, "response_chaining"],
      ["policy_changed", { policy: { id: "policy-1", revision: "2" } }, "response_chaining"],
    ] as const;
    for (const [reason, changed, mechanism] of cases) {
      expect(checkModelContinuationCompatibility(current, {
        ...lineage("request-2"),
        ...changed,
      }, mechanism)).toEqual({ kind: "incompatible", reason });
    }
  });

  it("advances and reuses one branch while cancellation cannot advance it", async () => {
    const store = createInMemoryModelContinuationStore();
    const events: ModelContinuationSafeEvent[] = [];
    const lifecycle = new ModelContinuationLifecycle({
      store,
      now: () => "2026-08-17T00:00:00.000Z",
      events: { publish: (event) => events.push(event) },
    });
    const first = await lifecycle.prepare({
      capability: CAPABILITY,
      lineage: lineage("request-1"),
    });
    expect(first.outcome).toEqual({ kind: "unavailable", reason: "missing" });

    const advanced = await lifecycle.advance({
      preparation: first,
      mechanism: "response_chaining",
      responseId: "response-1",
      state: opaque("state-1"),
    });
    expect(advanced).toMatchObject({
      kind: "advanced",
      continuation: { predecessor: null, responseId: "response-1" },
    });

    const second = await lifecycle.prepare({
      capability: CAPABILITY,
      lineage: lineage("request-2"),
    });
    expect(second).toMatchObject({
      outcome: { kind: "reused" },
      continuation: { responseId: "response-1" },
    });
    await lifecycle.cancelled(second);
    expect(await store.load("branch-1")).toMatchObject({ responseId: "response-1" });
    expect(JSON.stringify(events)).not.toContain("state-1");
  });

  it("clears incompatible or Provider-rejected state with one explicit reset", async () => {
    const store = createInMemoryModelContinuationStore();
    await store.commit({
      branchId: "branch-1",
      expectedContinuationId: null,
      continuation: continuation(),
    });
    const lifecycle = new ModelContinuationLifecycle({ store });

    const incompatible = await lifecycle.prepare({
      capability: CAPABILITY,
      lineage: {
        ...lineage("request-2"),
        activeContext: { id: "context-1", runId: "run-1", version: 5 },
      },
    });
    expect(incompatible).toMatchObject({
      continuation: null,
      outcome: {
        kind: "reset",
        previousContinuationId: "continuation-1",
        reason: "active_context_changed",
      },
    });
    expect(await store.load("branch-1")).toBeNull();

    await store.commit({
      branchId: "branch-1",
      expectedContinuationId: null,
      continuation: continuation(),
    });
    const reusable = await lifecycle.prepare({
      capability: CAPABILITY,
      lineage: lineage("request-3"),
    });
    await expect(lifecycle.rejectAndReset(reusable, "invalid_previous_response"))
      .resolves.toEqual({
        kind: "reset",
        previousContinuationId: "continuation-1",
        reason: "provider_rejected",
      });
    expect(await store.load("branch-1")).toBeNull();
  });

  it("compacts opaque transport lineage through predecessor-preserving CAS", async () => {
    const store = createInMemoryModelContinuationStore();
    await store.commit({
      branchId: "branch-1",
      expectedContinuationId: null,
      continuation: continuation(),
    });
    const compact = vi.fn(async () => ({
      kind: "succeeded" as const,
      compactionId: "compaction-1",
      requestId: "request-compact",
      responseId: "response-compact",
      state: opaque("compacted-state"),
    }));
    const lifecycle = new ModelContinuationLifecycle({
      store,
      compactor: { compact },
      now: () => "2026-08-17T00:00:03.000Z",
    });

    await expect(lifecycle.compact({
      branchId: "branch-1",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: "compacted",
      compaction: {
        continuationId: "continuation-1",
        responseId: "response-compact",
      },
    });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(await store.load("branch-1")).toMatchObject({
      predecessor: {
        continuationId: "continuation-1",
        responseId: "response-1",
      },
      responseId: "response-compact",
      state: { handle: "compacted-state" },
    });
  });

  it("surfaces a CAS conflict instead of creating a competing branch head", async () => {
    const store: ModelContinuationStore = {
      async load() { return null; },
      async commit() { return { kind: "conflict" }; },
      async clear() { return { kind: "conflict" }; },
    };
    const lifecycle = new ModelContinuationLifecycle({ store });
    const preparation = await lifecycle.prepare({
      capability: CAPABILITY,
      lineage: lineage("request-1"),
    });
    await expect(lifecycle.rejectAndReset(preparation, null)).resolves.toMatchObject({
      kind: "failed",
      code: "continuation_rejection_uncorrelated",
    });

    await expect(lifecycle.advance({
      preparation,
      mechanism: "response_chaining",
      responseId: "response-1",
      state: opaque("state-1"),
    })).resolves.toMatchObject({
      kind: "failed",
      code: "continuation_store_conflict",
    });
  });
});

function lineage(requestId: string): ModelContinuationRequestLineage {
  return {
    providerId: "provider-1",
    model: "model-1",
    branchId: "branch-1",
    requestId,
    activeContext: { id: "context-1", runId: "run-1", version: 4 },
    protocol: { id: "protocol-1", revision: "1" },
    toolExposureContent: { id: "tools-1", revision: "1" },
    callableDefinitions: { id: "callables-1", revision: "1" },
    policy: { id: "policy-1", revision: "1" },
  };
}

function continuation(): ModelContinuationRef {
  return {
    id: "continuation-1",
    providerId: "provider-1",
    model: "model-1",
    mechanism: "response_chaining",
    predecessor: null,
    branchId: "branch-1",
    requestId: "request-1",
    responseId: "response-1",
    activeContext: { id: "context-1", runId: "run-1", version: 4 },
    protocol: { id: "protocol-1", revision: "1" },
    toolExposureContent: { id: "tools-1", revision: "1" },
    callableDefinitions: { id: "callables-1", revision: "1" },
    policy: { id: "policy-1", revision: "1" },
    state: opaque("state-1"),
    createdAt: "2026-08-17T00:00:01.000Z",
  };
}

function opaque(handle: string) {
  return {
    kind: "opaque_provider_state" as const,
    handle,
    sensitivity: "restricted" as const,
  };
}
