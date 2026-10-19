import { describe, expect, it } from "vitest";
import { createCommandInputContract } from "./CommandInputContract.js";
import { parseCommandInput } from "./CommandInput.js";
import { resolveCommandLimits } from "./CommandLimits.js";

describe("Command input contract", () => {
  it("freezes configuration and uses the same resolved bounds and defaults as preparation", () => {
    const settings = {defaultTimeoutMs: 1234, maxTimeoutMs: 5678};
    const contract = createCommandInputContract(settings);
    const limits = resolveCommandLimits(settings);
    settings.maxTimeoutMs = 9999;
    expect(contract.constraints.timeout).toEqual({minimumMs: 1, maximumMs: 5678, defaultMs: 1234});
    expect(parseCommandInput({command: "echo test"}, limits)).toMatchObject({timeoutMs: 1234, waitMs: 10000});
    expect(contract.validate({command: "echo test", timeout_ms: 5679})).toMatchObject({status: "invalid", issues: [{path: "/timeout_ms", hint: expect.stringContaining("5678")}]});
    expect(() => parseCommandInput({command: "echo test", timeout_ms: 5679}, limits)).toThrow("5678");
    expect(createCommandInputContract(settings).ref.revision).not.toBe(contract.ref.revision);
    expect(Object.isFrozen(limits)).toBe(true);
  });
  it("checks byte counts, code units, blanks and conditional wait without echoing sensitive text", () => {
    const contract = createCommandInputContract({maxCommandBytes: 5, maxDescriptionChars: 3});
    expect(contract.validate({command: "\u4e2d\u6587"})).toMatchObject({status: "invalid", issues: [{path: "/command", hint: expect.stringContaining("6 bytes")}]});
    expect(contract.validate({command: "a", description: "\ud83d\ude00\ud83d\ude00"})).toMatchObject({status: "invalid", issues: [{path: "/description", hint: expect.stringContaining("4 code units")}]});
    expect(contract.validate({command: " "}).status).toBe("invalid");
    expect(contract.validate({command: "a", run_in_background: true, wait_ms: 1000})).toMatchObject({status: "invalid", issues: [{path: "/wait_ms"}]});
    expect(contract.validate({command: "a", run_in_background: true}).status).toBe("valid");
    expect(contract.validate({command: "a", run_in_background: true, wait_ms: 0}).status).toBe("valid");
    expect(contract.issueHint({timeout_ms: "secret"}, {path: "/timeout_ms"})).not.toContain("secret");
    expect(contract.issueHint({command: "secret"}, {path: "/command"})).not.toContain("secret");
  });
});
