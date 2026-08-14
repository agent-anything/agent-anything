import { describe, expect, expectTypeOf, it } from "vitest";
import * as operationApi from "./index.js";
import type { RemoteOperationContribution } from "./index.js";

describe("remote Operation public API", () => {
  it("exposes one contribution factory without Tool-to-Action compatibility", () => {
    expect(Object.keys(operationApi)).toEqual(["createRemoteOperationContribution"]);
    expectTypeOf<RemoteOperationContribution>().toBeObject();
    expect(operationApi).not.toHaveProperty("createRemoteActionCapability");
    expect(operationApi).not.toHaveProperty("createRemoteToolActionCapability");
  });
});
