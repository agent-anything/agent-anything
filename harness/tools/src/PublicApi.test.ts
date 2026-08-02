import { describe, expect, it } from "vitest";
import * as api from "./index.js";
import * as catalog from "./catalog/index.js";
import * as registration from "./registration/index.js";
import * as selection from "./selection/index.js";

const CATALOG_VALUES = [
  "ToolCatalogValidationError",
  "createToolCatalogSnapshot",
  "findToolDescriptor",
];
const REGISTRATION_VALUES = [
  "ToolRegistrationValidationError",
  "createToolRegistrationSnapshot",
  "createToolSourceRef",
  "findToolRegistration",
];
const SELECTION_VALUES = [
  "ToolSelectionValidationError",
  "createToolSelectionSnapshot",
  "findSelectedTool",
];

describe("Tools public API", () => {
  it("exposes the reviewed root and Tool contract value surfaces", () => {
    expect(Object.keys(catalog).sort()).toEqual(CATALOG_VALUES);
    expect(Object.keys(registration).sort()).toEqual(REGISTRATION_VALUES);
    expect(Object.keys(selection).sort()).toEqual(SELECTION_VALUES);
    expect(Object.keys(api).sort()).toEqual([
      ...CATALOG_VALUES,
      ...REGISTRATION_VALUES,
      ...SELECTION_VALUES,
    ].sort());
  });
});
