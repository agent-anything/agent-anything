import { describe, expect, expectTypeOf, it } from "vitest";
import * as activationApi from "./index.js";
import type {
  PluginActivationSnapshot,
  PluginContributionActivationPort,
} from "./index.js";

describe("Plugin activation public API", () => {
  it("exposes destination-owner activation Contracts only", () => {
    expect(Object.keys(activationApi).sort()).toEqual([
      "PluginActivationContractError",
      "createPluginContributionSourceRef",
      "createPluginOwnerActivationRequest",
      "createPluginOwnerDeactivationRequest",
      "settlePluginOwnerActivationResult",
      "settlePluginOwnerDeactivationResult",
    ]);
    expectTypeOf<PluginActivationSnapshot>().toBeObject();
    expectTypeOf<PluginContributionActivationPort>().toBeObject();
    expect(activationApi).not.toHaveProperty("PluginRegistry");
  });
});
