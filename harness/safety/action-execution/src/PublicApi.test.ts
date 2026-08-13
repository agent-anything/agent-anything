import { describe, expect, expectTypeOf, it } from "vitest";
import type { OperationActionAdapter } from "./registration/index.js";
import type { ActionExecutionCoordinator } from "./enforcement/index.js";
import type { SandboxProvider } from "./sandbox/index.js";
import * as coordinationApi from "./coordination/index.js";
import * as registrationApi from "./registration/index.js";
import * as enforcementApi from "./enforcement/index.js";
import * as sandboxApi from "./sandbox/index.js";
import * as executionApi from "./execution/index.js";

describe("Action Execution public API", () => {
  it("exposes only the reviewed physical Action execution surfaces", () => {
    expectTypeOf<OperationActionAdapter>().toBeObject();
    expectTypeOf<ActionExecutionCoordinator>().toBeObject();
    expectTypeOf<SandboxProvider>().toBeObject();

    expect(Object.keys(coordinationApi).sort()).toEqual([
      "CanonicalActionCommitError",
      "CanonicalActionLedger",
    ]);
    expect(Object.keys(registrationApi).sort()).toEqual([
      "createActionAdapterImplementationSnapshot",
      "createPreparedAction",
    ]);
    expect(Object.keys(enforcementApi).sort()).toEqual([
      "ActionExecutionCoordinator",
    ]);
    expect(Object.keys(sandboxApi).sort()).toEqual([
      "createSandboxExecutionGateway",
    ]);
    expect(Object.keys(executionApi).sort()).toEqual([
      "assertActionExecutorDispatchContext",
      "createActionExecutionFailure",
    ]);
  });

  it("does not re-expose Tool routing, Runtime state, or private execution stages", () => {
    const publicApis = [
      coordinationApi,
      registrationApi,
      enforcementApi,
      sandboxApi,
      executionApi,
    ];
    for (const api of publicApis) {
      expect(api).not.toHaveProperty("ToolActionBindingValidationError");
      expect(api).not.toHaveProperty("createToolActionBindingSnapshot");
      expect(api).not.toHaveProperty("Runner");
      expect(api).not.toHaveProperty("RunState");
      expect(api).not.toHaveProperty("createActionDispatchPlan");
      expect(api).not.toHaveProperty("prepareSandboxDispatch");
      expect(api).not.toHaveProperty("settleExecutorResult");
    }
  });
});
