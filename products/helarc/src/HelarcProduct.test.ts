import { describe, expect, it } from "vitest";
import { HELARC_PRODUCT_ID, helarcProduct } from "./index.js";

describe("Helarc product entry point", () => {
  it("exposes the stable product identity", () => {
    expect(HELARC_PRODUCT_ID).toBe("helarc");
    expect(helarcProduct).toEqual({
      id: "helarc",
      displayName: "Helarc",
    });
  });
});
