import { describe, expect, it } from "vitest";
import {
  assertPreparedInvocationMatchesExecutor,
  createPreparedActionInvocation,
  PreparedActionInvocationValidationError,
} from "./PreparedActionInvocation.js";

describe("PreparedActionInvocation", () => {
  it("creates a canonical deeply immutable serializable snapshot", () => {
    const payload = {
      z: ["last", { nested: true }],
      a: -0,
    };
    const invocation = createPreparedActionInvocation({
      contractVersion: "1",
      executorId: "code-agent.file.read.executor",
      executorVersion: "1.0.0",
      payload,
      secretReferences: ["secret:provider", "secret:organization"],
    });
    payload.z[0] = "changed";

    expect(invocation).toEqual({
      contractVersion: "1",
      executorId: "code-agent.file.read.executor",
      executorVersion: "1.0.0",
      payload: {
        a: 0,
        z: ["last", { nested: true }],
      },
      secretReferences: ["secret:organization", "secret:provider"],
    });
    expect(Object.keys(invocation.payload as object)).toEqual(["a", "z"]);
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.payload)).toBe(true);
    expect(Object.isFrozen((invocation.payload as { z: readonly unknown[] }).z)).toBe(true);
    expect(Object.isFrozen(invocation.secretReferences)).toBe(true);
  });

  it("matches the exact executor identity and invocation contract", () => {
    const invocation = createPreparedActionInvocation({
      contractVersion: "1",
      executorId: "code-agent.file.read.executor",
      executorVersion: "1.0.0",
      payload: null,
    });
    const executor = {
      id: "code-agent.file.read.executor",
      version: "1.0.0",
      invocationContractVersion: "1",
    };

    expect(() => assertPreparedInvocationMatchesExecutor(invocation, executor)).not.toThrow();
    expect(() => assertPreparedInvocationMatchesExecutor(invocation, {
      ...executor,
      version: "2.0.0",
    })).toThrowError(expect.objectContaining({ code: "invocation_executor_mismatch" }));
  });

  it("rejects duplicate or invalid secret references", () => {
    expect(() => createPreparedActionInvocation({
      contractVersion: "1",
      executorId: "executor",
      executorVersion: "1",
      payload: null,
      secretReferences: ["secret:a", "secret:a"],
    })).toThrowError(expect.objectContaining({
      code: "invocation_secret_reference_duplicate",
    }));
    expect(() => createPreparedActionInvocation({
      contractVersion: "1",
      executorId: "executor",
      executorVersion: "1",
      payload: null,
      secretReferences: ["raw secret value"],
    })).toThrowError(expect.objectContaining({
      code: "invocation_secret_reference_invalid",
    }));

    const sparse: string[] = [];
    sparse.length = 1;
    expect(() => createPreparedActionInvocation({
      contractVersion: "1",
      executorId: "executor",
      executorVersion: "1",
      payload: null,
      secretReferences: sparse,
    })).toThrowError(expect.objectContaining({
      code: "invocation_secret_reference_invalid",
    }));
  });

  it("rejects functions, cycles, class instances, accessors, and non-finite numbers", () => {
    expectInvalidPayload({ execute: () => undefined });
    expectInvalidPayload({ value: Number.NaN });
    expectInvalidPayload(new Date());

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expectInvalidPayload(cycle);

    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "value",
    });
    expectInvalidPayload(getter);
  });

  it("rejects sparse arrays, extra array properties, symbols, and forbidden keys", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectInvalidPayload(sparse);

    const extra = ["value"] as unknown[] & { other?: string };
    extra.other = "unsupported";
    expectInvalidPayload(extra);

    const symbolData = { value: true } as Record<PropertyKey, unknown>;
    symbolData[Symbol("hidden")] = true;
    expectInvalidPayload(symbolData);

    expectInvalidPayload(JSON.parse('{"__proto__":{"polluted":true}}'));
  });

  it("reports the exact invalid payload path", () => {
    try {
      createPreparedActionInvocation({
        contractVersion: "1",
        executorId: "executor",
        executorVersion: "1",
        payload: { nested: { value: undefined as never } },
      });
      expect.fail("Expected invocation validation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PreparedActionInvocationValidationError);
      expect(error).toMatchObject({
        code: "invocation_not_serializable",
        path: "payload.nested.value",
      });
    }
  });

  it("rejects unknown and accessor fields on the invocation envelope", () => {
    expect(() => createPreparedActionInvocation({
      contractVersion: "1",
      executorId: "executor",
      executorVersion: "1",
      payload: null,
      execute: () => undefined,
    } as never)).toThrowError(expect.objectContaining({
      code: "invocation_not_serializable",
    }));

    const accessor = Object.defineProperty({}, "contractVersion", {
      enumerable: true,
      get: () => "1",
    });
    expect(() => createPreparedActionInvocation(accessor as never)).toThrowError(
      expect.objectContaining({ code: "invocation_not_serializable" }),
    );
  });
});

function expectInvalidPayload(payload: unknown): void {
  expect(() => createPreparedActionInvocation({
    contractVersion: "1",
    executorId: "executor",
    executorVersion: "1",
    payload: payload as never,
  })).toThrowError(expect.objectContaining({ code: "invocation_not_serializable" }));
}
