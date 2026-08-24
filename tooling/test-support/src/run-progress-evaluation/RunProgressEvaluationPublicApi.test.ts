import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Run Progress Evaluation public API", () => {
  it("exposes only the deterministic observer entry point", () => {
    expect(Object.keys(api).sort()).toEqual([
      "runRunProgressDeterministicEvaluation",
    ]);
  });
});
