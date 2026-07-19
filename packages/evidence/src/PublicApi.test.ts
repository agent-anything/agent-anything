import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Evidence public API", () => {
  it("exposes only the default builder as a runtime value", () => {
    expect(Object.keys(api).sort()).toEqual(["EvidenceBuilder"]);
  });
});
