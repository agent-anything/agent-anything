import { describe, expect, it } from "vitest";
import * as api from "./index.js";
import * as catalog from "./catalog/index.js";

const CATALOG_VALUES = [
  "ToolCatalogValidationError",
  "createToolCatalogSnapshot",
  "findToolDescriptor",
];

describe("Tools public API", () => {
  it("exposes the reviewed root and catalog value surfaces", () => {
    expect(Object.keys(catalog).sort()).toEqual(CATALOG_VALUES);
    expect(Object.keys(api).sort()).toEqual(CATALOG_VALUES);
  });
});
