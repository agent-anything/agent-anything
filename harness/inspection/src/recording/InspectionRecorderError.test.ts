import {expect,it} from "vitest";
import {inspectionProjectionFailureCode} from "./InspectionRecorderError.js";

it("preserves public storage failure reasons without disclosing arbitrary projection errors",()=>{
  expect(inspectionProjectionFailureCode(new Error("inspection_storage_budget_exhausted"))).toBe("inspection_storage_budget_exhausted");
  expect(inspectionProjectionFailureCode(new Error("inspection_path_invalid"))).toBe("inspection_path_invalid");
  expect(inspectionProjectionFailureCode(new Error("private/path secret"))).toBe("inspection_projection_failed");
  expect(inspectionProjectionFailureCode(null)).toBe("inspection_projection_failed");
});
