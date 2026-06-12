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
      permissionMode: "trusted",
    });
  });

  it("uses the first positional value as target", () => {
    expect(parseCliArgs(["example.com"])).toEqual({
      target: "example.com",
      symptom: "",
      permissionMode: "trusted",
    });
  });

  it("parses permission mode", () => {
    expect(parseCliArgs([
      "--target",
      "https://example.com",
      "--permission",
      "deny",
    ])).toEqual({
      target: "https://example.com",
      symptom: "",
      permissionMode: "deny",
    });
  });

  it("throws when permission mode is invalid", () => {
    expect(() => parseCliArgs([
      "--target",
      "https://example.com",
      "--permission",
      "always",
    ])).toThrow("must be one of: trusted, ask, deny");
  });

  it("throws when target is missing", () => {
    expect(() => parseCliArgs([])).toThrow("Missing target.");
  });

  it("throws a help request for help flag", () => {
    expect(() => parseCliArgs(["--help"])).toThrow(CliHelpRequested);
  });
});
