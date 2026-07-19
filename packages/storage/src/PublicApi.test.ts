import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Storage public API", () => {
  it("exposes only the basic in-memory implementation as a runtime value", () => {
    expect(Object.keys(api).sort()).toEqual(["InMemoryStorage"]);
  });
});
