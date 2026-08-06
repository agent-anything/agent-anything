import { describe, expect, expectTypeOf, it } from "vitest";
import * as admissionApi from "./index.js";
import type { PluginAdmissionSnapshot } from "./index.js";

describe("Plugin admission public API", () => {
  it("exposes Host admission Contracts only", () => {
    expect(Object.keys(admissionApi).sort()).toEqual([
      "PluginAdmissionValidationError",
      "createPluginAdmissionSnapshot",
      "findPluginContributionAdmission",
    ]);
    expectTypeOf<PluginAdmissionSnapshot>().toBeObject();
    expect(admissionApi).not.toHaveProperty("PluginRegistry");
  });
});
