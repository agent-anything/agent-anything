import { describe, expect, expectTypeOf, it } from "vitest";
import * as remoteActionApi from "./action/index.js";
import type { RemoteActionCapability } from "./action/index.js";
import * as remoteIntegrationApi from "./index.js";
import * as remoteToolApi from "./tools/index.js";
import type { RemoteToolPort } from "./tools/index.js";

describe("Remote Integrations public API", () => {
  it("exposes focused remote Action and Tool adaptation", () => {
    expect(Object.keys(remoteIntegrationApi).sort()).toEqual([
      "createRemoteActionCapability",
      "createRemoteToolActionCapability",
    ]);
    expect(Object.keys(remoteActionApi)).toEqual([
      "createRemoteActionCapability",
    ]);
    expect(Object.keys(remoteToolApi)).toEqual([
      "createRemoteToolActionCapability",
    ]);
  });

  it("does not expose execution infrastructure", () => {
    expectTypeOf<RemoteActionCapability>().toBeObject();
    expectTypeOf<RemoteToolPort>().toBeObject();
    expect(remoteIntegrationApi).not.toHaveProperty("Runner");
    expect(remoteIntegrationApi).not.toHaveProperty(
      "ActionEnforcementPipeline",
    );
    expect(remoteIntegrationApi).not.toHaveProperty(
      "createSandboxExecutionGateway",
    );
  });
});
