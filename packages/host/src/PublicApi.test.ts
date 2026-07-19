import { describe, expect, it } from "vitest";
import * as hostApi from "./index.js";

describe("Host public API", () => {
  it("exports only Host-owned runtime values", () => {
    expect(Object.keys(hostApi).sort()).toEqual([
      "HOST_RETRY_EVENT_LIMIT",
      "createHostIdentityProvider",
      "createHostRunProjection",
      "createHostRunProjectionStore",
      "createHostRuntime",
      "createHostTerminalRunProjection",
      "createHostWorkspaceResolver",
      "createInMemoryHostPolicyAmendmentStore",
      "createInMemoryHostSessionAuthorityStore",
      "createUserApprovalReviewBridge",
      "projectRuntimeEventForHost",
      "reduceHostRunProjection",
      "resolveHostRunPermissionConfig",
      "snapshotHostCancellation",
    ]);
    expect(hostApi).not.toHaveProperty("Runner");
    expect(hostApi).not.toHaveProperty("RunState");
    expect(hostApi).not.toHaveProperty("RunResult");
  });
});
