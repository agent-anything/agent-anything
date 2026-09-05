import { describe, expect, it } from "vitest";
import { snapshotModelInstructions, modelInstructionsEqual } from "./ModelInstructions.js";

describe("ModelInstructions", () => {
  it("supports an explicitly empty immutable instruction collection", () => {
    const empty = snapshotModelInstructions({ content: [] });
    expect(empty).toEqual({ content: [] });
    expect(Object.isFrozen(empty.content)).toBe(true);
    expect(modelInstructionsEqual(empty, { content: [] })).toBe(true);
    expect(modelInstructionsEqual(empty, { content: [{ kind: "text", text: "Role." }] })).toBe(false);
  });
});
