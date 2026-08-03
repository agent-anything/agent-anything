import { describe, expect, expectTypeOf, it } from "vitest";
import * as pluginApi from "./index.js";
import type {
  PluginActivationSnapshot,
  PluginManifestSnapshot,
} from "./index.js";

describe("Plugins public API", () => {
  it("exposes Plugin-owned Contract and lifecycle values", () => {
    expect(Object.keys(pluginApi).sort()).toEqual([
      "PluginActivationContractError",
      "PluginAdmissionValidationError",
      "PluginManifestValidationError",
      "PluginRegistry",
      "PluginRegistryError",
      "createPluginAdmissionSnapshot",
      "createPluginContributionSourceRef",
      "createPluginManifestSnapshot",
      "createPluginOwnerActivationRequest",
      "createPluginOwnerDeactivationRequest",
      "findPluginContributionAdmission",
      "settlePluginOwnerActivationResult",
      "settlePluginOwnerDeactivationResult",
      "snapshotPluginManifestEnvironment",
      "validatePluginManifest",
    ]);
    expect(pluginApi).not.toHaveProperty("McpRegistry");
    expect(pluginApi).not.toHaveProperty("createToolRegistrationSnapshot");
    expect(pluginApi).not.toHaveProperty("createAllowAllActionPolicyPort");
  });

  it("resolves immutable Plugin records from the focused package", () => {
    expectTypeOf<PluginManifestSnapshot>().toBeObject();
    expectTypeOf<PluginActivationSnapshot>().toBeObject();
  });
});
