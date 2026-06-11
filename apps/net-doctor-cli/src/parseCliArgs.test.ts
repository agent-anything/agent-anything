import { describe, expect, it } from "vitest";
import { CliHelpRequested, parseCliArgs } from "./parseCliArgs.js";

describe("parseCliArgs", () => {
  it("parses target and symptom flags", () => {
    expect(parseCliArgs([
      "--target",
      "https://example.com",
      "--symptom",
      "Browser cannot connect.",
    ])).toEqual({
      target: "https://example.com",
      symptom: "Browser cannot connect.",
    });
  });

  it("uses the first positional value as target", () => {
    expect(parseCliArgs(["example.com"])).toEqual({
      target: "example.com",
      symptom: "",
    });
  });

  it("throws when target is missing", () => {
    expect(() => parseCliArgs([])).toThrow("Missing target.");
  });

  it("throws a help request for help flag", () => {
    expect(() => parseCliArgs(["--help"])).toThrow(CliHelpRequested);
  });
});
