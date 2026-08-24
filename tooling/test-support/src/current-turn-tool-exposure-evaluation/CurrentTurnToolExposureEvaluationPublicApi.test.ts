import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Current-turn Tool Exposure Evaluation public API", () => {
  it("exports only the semantic Evaluation entry point", () => {
    expect(Object.keys(api).sort()).toEqual([
      "runCurrentTurnToolExposureDeterministicEvaluation",
    ]);
  });
});
