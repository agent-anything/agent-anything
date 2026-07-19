import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Shared public API", () => {
  it("has no runtime value exports", () => {
    expect(Object.keys(api)).toEqual([]);
  });
});
