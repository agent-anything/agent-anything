import { describe, expect, expectTypeOf, it } from "vitest";
import * as lifecycleApi from "./index.js";
import type { PluginRecordSnapshot } from "./index.js";

describe("Plugin lifecycle public API", () => {
  it("exposes lifecycle authority only", () => {
    expect(Object.keys(lifecycleApi).sort()).toEqual([
      "PluginRegistry",
      "PluginRegistryError",
    ]);
    expectTypeOf<PluginRecordSnapshot>().toBeObject();
    expect(lifecycleApi).not.toHaveProperty("createPluginManifestSnapshot");
  });
});
