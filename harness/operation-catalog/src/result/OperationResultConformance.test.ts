import { createOperationResult } from "./index.js";
import { describe, expect, it } from "vitest";

const NOW = "2026-08-14T00:00:00.000Z";

describe("Operation result conformance", () => {
  it("keeps physical success as lower evidence when semantic interpretation fails", () => {
    const result = createOperationResult({
      ...base("semantic-failure"),
      status: "failed",
      output: null,
      failure: failure("command_exit_nonzero"),
      lowerRefs: [{
        owner: "action-execution",
        kind: "action_settlement",
        id: "settlement-1",
        revision: "1",
      }],
    });

    expect(result.status).toBe("failed");
    expect(result.lowerRefs).toEqual([expect.objectContaining({
      owner: "action-execution",
      kind: "action_settlement",
    })]);
  });

  it("requires usable output for partial and no output for non-usable terminal states", () => {
    const partial = createOperationResult({
      ...base("partial"),
      status: "partial",
      output: { matches: ["src/index.ts"], coverage: "truncated" },
      failure: failure("result_truncated"),
    });
    expect(partial.output).toEqual({
      matches: ["src/index.ts"],
      coverage: "truncated",
    });

    for (const status of [
      "failed",
      "unavailable",
      "denied",
      "cancelled",
      "timed_out",
      "invalid",
      "unknown_effect",
    ] as const) {
      const result = createOperationResult({
        ...base(status),
        status,
        output: null,
        failure: failure(`operation_${status}`),
      });
      expect(result.output).toBeNull();
      expect(result.failure.owner).toBe("operation.semantic-owner");
    }
  });

  it("rejects a partial result that carries no usable output", () => {
    expect(() => createOperationResult({
      ...base("invalid-partial"),
      status: "partial",
      output: null,
      failure: failure("result_truncated"),
    })).toThrow(/usable output/);
  });
});

function base(name: string) {
  const operation = {
    operation: { namespace: "operation.conformance", name },
    revision: "1",
  };
  return {
    ref: {
      invocation: { id: `invocation-${name}`, operation },
      id: `result-${name}`,
    },
    binding: { operation, revision: "binding-1" },
    semanticOwner: "operation.semantic-owner",
    startedAt: NOW,
    finishedAt: NOW,
    lowerRefs: [],
    metadata: {},
  };
}

function failure(code: string) {
  return {
    owner: "operation.semantic-owner",
    code,
    message: code,
    retryable: false,
    metadata: {},
  };
}
