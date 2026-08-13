import { describe, expect, it } from "vitest";
import * as activation from "./activation/index.js";
import * as identity from "./identity/index.js";
import * as catalog from "./catalog/index.js";
import * as registration from "./registration/index.js";
import * as selection from "./selection/index.js";
import * as invocation from "./invocation/index.js";
import * as result from "./result/index.js";

const IDENTITY_VALUES = ["createToolContractIdentity", "toolRevisionKey"];
const CATALOG_VALUES = [
  "ToolCatalogValidationError",
  "createToolCatalogSnapshot",
  "findToolDescriptor",
];
const REGISTRATION_VALUES = [
  "ToolRegistrationValidationError",
  "createToolRegistrationSnapshot",
  "findToolRegistration",
];
const SELECTION_VALUES = [
  "ToolSelectionValidationError",
  "createControllerToolExposureProof",
  "createFixedLocalToolSelection",
  "findSelectedTool",
  "snapshotToolSelectionRevision",
];
const INVOCATION_VALUES = ["materializeToolCall", "validateExactToolCall"];
const RESULT_VALUES = ["adaptToolSemanticResult"];

describe("Tools public API", () => {
  it("exposes only the reviewed Tool contract value surfaces", () => {
    expect(Object.keys(identity).sort()).toEqual(IDENTITY_VALUES.sort());
    expect(Object.keys(catalog).sort()).toEqual(CATALOG_VALUES.sort());
    expect(Object.keys(registration).sort()).toEqual(REGISTRATION_VALUES.sort());
    expect(Object.keys(selection).sort()).toEqual(SELECTION_VALUES.sort());
    expect(Object.keys(invocation).sort()).toEqual(INVOCATION_VALUES.sort());
    expect(Object.keys(result).sort()).toEqual(RESULT_VALUES.sort());
    expect(Object.keys(activation)).toEqual([]);
  });
});
