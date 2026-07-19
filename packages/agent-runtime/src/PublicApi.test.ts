import { describe, expect, it } from "vitest";
import * as runtimeApi from "./index.js";

describe("Agent Runtime public API", () => {
  it("exports execution implementations without forwarding Core semantics", () => {
    expect(Object.keys(runtimeApi).sort()).toEqual([
      "ControllerError",
      "ProviderBackedController",
      "RetryExecutor",
      "Runner",
      "StructuredOutputError",
      "createSystemRetryExecutor",
      "systemRetryClock",
    ]);
    expect(runtimeApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runtimeApi).not.toHaveProperty("RunState");
    expect(runtimeApi).not.toHaveProperty("RuntimeEventEmitter");
  });
});
