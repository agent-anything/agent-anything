import { describe, expect, expectTypeOf, it } from "vitest";
import * as remoteToolApi from "./index.js";
import type { RemoteToolPort } from "./index.js";

describe("Remote Tool public API", () => {
  it("exposes protocol-neutral Tool adaptation only", () => {
    expect(Object.keys(remoteToolApi)).toEqual([
      "createRemoteToolActionCapability",
    ]);
    expectTypeOf<RemoteToolPort>().toBeObject();
    expect(remoteToolApi).not.toHaveProperty("Runner");
  });
});
