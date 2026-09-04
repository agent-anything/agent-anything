import { describe, expect, expectTypeOf, it } from "vitest";

import type { HostIdentityResolver } from "./context/index.js";
import type { HostSessionAuthorityComposition } from "./composition/index.js";
import type { HostActiveRun, HostRunManager } from "./run/index.js";
import type { HostRunProjection } from "./projection/index.js";
import type { HostCommand } from "./transport/index.js";
import * as contextApi from "./context/index.js";
import * as compositionApi from "./composition/index.js";
import * as runApi from "./run/index.js";
import * as projectionApi from "./projection/index.js";
import * as transportApi from "./transport/index.js";
import * as authorityApi from "./authority/index.js";

describe("Host public API", () => {
  it("exposes focused semantic subpaths", () => {
    expectTypeOf<HostIdentityResolver>().toBeObject();
    expectTypeOf<HostSessionAuthorityComposition>().toBeObject();
    expectTypeOf<HostActiveRun>().toBeObject();
    expectTypeOf<HostActiveRun>().not.toHaveProperty("result");
    expectTypeOf<HostRunManager>().toBeObject();
    expectTypeOf<HostRunProjection>().toBeObject();
    expectTypeOf<HostCommand>().toBeObject();

    expect(Object.keys(contextApi).sort()).toEqual([
      "HostContextResolutionError",
      "createStaticHostIdentityResolver",
      "createStaticHostWorkspaceResolver",
      "resolveHostRunContext",
    ]);
    expect(Object.keys(compositionApi).sort()).toEqual([
      "resolveHostRunPermissionConfig",
    ]);
    expect(Object.keys(runApi).sort()).toEqual([
      "createHostRunManager",
    ]);
    expect(Object.keys(projectionApi).sort()).toEqual([
      "createHostRunProjection",
      "createHostRunProjectionStore",
      "createHostTerminalRunProjection",
      "projectHostRunLifecycleHooks",
      "projectRuntimeEventForHost",
      "reduceHostRunProjection",
      "snapshotHostCancellation",
    ]);
    expect(Object.keys(transportApi).sort()).toEqual([
      "HOST_COMMAND_REASON_MAX_LENGTH",
      "HOST_COMMAND_RECEIPT_LIMIT",
      "HOST_COMMAND_VERSION",
      "HOST_INTERACTION_PAYLOAD_MAX_BYTES",
      "HOST_QUERY_VERSION",
      "createHostCommandDispatcher",
      "createHostRunStatusQueryHandler",
      "snapshotHostCommand",
      "snapshotHostRunStatusQuery",
    ]);
    expect(Object.keys(authorityApi).sort()).toEqual([
      "createInMemoryHostPolicyAmendmentStore",
      "createInMemoryHostSessionAuthorityStore",
    ]);
  });

  it("does not expose Runtime, Runner, Product, or transport implementation authority", () => {
    const publicApis = [
      contextApi,
      compositionApi,
      runApi,
      projectionApi,
      transportApi,
      authorityApi,
    ];
    for (const api of publicApis) {
      expect(api).not.toHaveProperty("Runner");
      expect(api).not.toHaveProperty("RunState");
      expect(api).not.toHaveProperty("RunResult");
      expect(api).not.toHaveProperty("HelarcProductResult");
    }
  });
});
