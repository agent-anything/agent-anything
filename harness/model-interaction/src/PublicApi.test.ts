import { describe, expect, it } from "vitest";
import type { RetrySchedulerOwnership } from "./index.js";
import * as api from "./index.js";

describe("Model Interaction public API", () => {
  it("exposes only Model Interaction interruption helpers as runtime values", () => {
    expect(Object.keys(api).sort()).toEqual([
      "createProviderAttemptInterruption",
      "providerResultFromInterruption",
    ]);
  });

  it("uses explicit Harness or SDK request Retry ownership", () => {
    const harness: RetrySchedulerOwnership = { kind: "harness" };
    const sdk: RetrySchedulerOwnership = {
      kind: "sdk",
      sdkName: "example-sdk",
      maxAttempts: 3,
      exposesAttemptEvents: true,
      supportsCancellation: true,
    };

    expect(harness.kind).toBe("harness");
    expect(sdk).toMatchObject({
      kind: "sdk",
      maxAttempts: 3,
      exposesAttemptEvents: true,
      supportsCancellation: true,
    });
  });
});
