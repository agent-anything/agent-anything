import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Delegation Transfer Evaluation public API", () => {
  it("exports only the deterministic and optional diagnostic entry points", () => {
    expect(Object.keys(api).sort()).toEqual([
      "runDelegationTransferDeterministicEvaluation",
      "runDelegationTransferModelDiagnostic",
    ]);
  });
});
