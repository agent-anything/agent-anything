import { describe, expect, expectTypeOf, it } from "vitest";
import * as manifestApi from "./index.js";
import type {
  PluginContributionDescriptor,
  PluginManifestSnapshot,
} from "./index.js";

describe("Plugin manifest public API", () => {
  it("exposes declaration and validation Contracts only", () => {
    expect(Object.keys(manifestApi).sort()).toEqual([
      "PluginManifestValidationError",
      "createPluginManifestSnapshot",
      "snapshotPluginManifestEnvironment",
      "validatePluginManifest",
    ]);
    expectTypeOf<PluginManifestSnapshot>().toBeObject();
    expectTypeOf<PluginContributionDescriptor>().toBeObject();
  });
});
