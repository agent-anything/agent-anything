import type {
  HostRunProjection,
  HostRuntime,
  UserApprovalReviewBridge,
} from "@agent-anything/host";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as hostApi from "./index.js";

describe("Host public API", () => {
  it("exports only Host-owned runtime values", () => {
    expectTypeOf<HostRunProjection>().toBeObject();
    expectTypeOf<HostRuntime>().toBeObject();
    expectTypeOf<UserApprovalReviewBridge>().toBeObject();
    expect(Object.keys(hostApi).sort()).toEqual([
      "HOST_RETRY_EVENT_LIMIT",
      "HostContextResolutionError",
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
    ]);
    expect(hostApi).not.toHaveProperty("Runner");
    expect(hostApi).not.toHaveProperty("RunState");
    expect(hostApi).not.toHaveProperty("RunResult");
  });
});
