import { describe, expect, it } from "vitest";
import {
  snapshotStructuredOutputFailure,
  StructuredOutputError,
} from "./StructuredOutput.js";

describe("StructuredOutput contracts", () => {
  it("snapshots one bounded allowlisted correction failure", () => {
    const failure = snapshotStructuredOutputFailure({
      category: "structured_output_schema",
      code: "field_required",
      correctionFeedback: "Return the required field.",
    });

    expect(failure).toEqual({
      category: "structured_output_schema",
      code: "field_required",
      correctionFeedback: "Return the required field.",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(new StructuredOutputError(failure).failure).toEqual(failure);
  });

  it("rejects undeclared categories and oversized correction feedback", () => {
    expect(() => snapshotStructuredOutputFailure({
      category: "retry_everything",
      code: "unsafe",
      correctionFeedback: "Try again.",
    } as never)).toThrow("category is unsupported");

    expect(() => snapshotStructuredOutputFailure({
      category: "structured_output_schema",
      code: "too_verbose",
      correctionFeedback: "x".repeat(501),
    })).toThrow("must not exceed 500 characters");
  });
});
