import { describe, expect, expectTypeOf, it } from "vitest";
import * as remoteActionApi from "./index.js";
import type { RemoteActionCapability } from "./index.js";

describe("Remote Action public API", () => {
  it("exposes protocol-neutral Action adaptation only", () => {
    expect(Object.keys(remoteActionApi)).toEqual([
      "createRemoteActionCapability",
    ]);
    expectTypeOf<RemoteActionCapability>().toBeObject();
    expect(remoteActionApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(remoteActionApi).not.toHaveProperty(
      "createSandboxExecutionGateway",
    );
  });
});
