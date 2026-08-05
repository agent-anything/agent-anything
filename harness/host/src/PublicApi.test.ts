import type {
  HostCommand,
  HostRunProjection,
  HostRuntime,
  UserApprovalReviewBridge,
} from "./index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as hostApi from "./index.js";

describe("Host public API", () => {
  it("exports only Host-owned runtime values", () => {
    expectTypeOf<HostCommand>().toBeObject();
    expectTypeOf<HostRunProjection>().toBeObject();
    expectTypeOf<HostRuntime>().toBeObject();
    expectTypeOf<UserApprovalReviewBridge>().toBeObject();
    expect(Object.keys(hostApi).sort()).toEqual([
      "HOST_COMMAND_REASON_MAX_LENGTH",
      "HOST_COMMAND_RECEIPT_LIMIT",
      "HOST_COMMAND_VERSION",
      "HOST_RETRY_EVENT_LIMIT",
      "HostContextResolutionError",
      "createHostCommandDispatcher",
      "createHostRunProjection",
      "createHostRunProjectionStore",
      "createHostRuntime",
      "createHostTerminalRunProjection",
      "createInMemoryHostPolicyAmendmentStore",
      "createInMemoryHostSessionAuthorityStore",
      "createStaticHostIdentityResolver",
      "createStaticHostWorkspaceResolver",
      "createUserApprovalReviewBridge",
      "projectRuntimeEventForHost",
      "reduceHostRunProjection",
      "resolveHostRunContext",
      "resolveHostRunPermissionConfig",
      "snapshotHostCancellation",
      "snapshotHostCommand",
    ]);
    expect(hostApi).not.toHaveProperty("Runner");
    expect(hostApi).not.toHaveProperty("RunState");
    expect(hostApi).not.toHaveProperty("RunResult");
  });
});
