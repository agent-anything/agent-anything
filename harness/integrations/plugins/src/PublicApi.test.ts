import { describe, expect, expectTypeOf, it } from "vitest";
import * as pluginApi from "./index.js";
import type { PluginManifest } from "./index.js";

describe("Plugins public API", () => {
  it("exposes only Plugin-owned values", () => {
    expect(Object.keys(pluginApi).sort()).toEqual([
      "PluginRegistry",
      "PluginRegistryError",
    ]);
    expect(pluginApi).not.toHaveProperty("McpRegistry");
    expect(pluginApi).not.toHaveProperty("createRemoteActionCapability");
  });

  it("resolves Plugin declarations from the focused package", () => {
    expectTypeOf<PluginManifest>().toBeObject();
  });
});
