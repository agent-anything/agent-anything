import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Phase27 Test Support public API", () => {
  it("exposes only the finite realization and conformance records", () => {
    expect(Object.keys(api).sort()).toEqual([
      "PHASE27_BINDING_CONFORMANCE",
      "PHASE27_CATALOG_REALIZATION_REGISTRY",
      "PHASE27_SCENARIO_CONFORMANCE",
      "findPhase27CatalogRecord",
    ]);
  });
});
