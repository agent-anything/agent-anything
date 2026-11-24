import { describe, expect, it } from "vitest";
import { addDecimal, compareDecimal, decimal, divideDecimal, multiplyDecimal, nonnegativeDecimal, subtractDecimal } from "./ExactDecimal.js";

describe("exact serializable decimal arithmetic", () => {
  it("keeps decimal and large integer arithmetic exact", () => {
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("9007199254740992", "1")).toBe("9007199254740993");
    expect(subtractDecimal("0.1", "0.3")).toBe("-0.2");
    expect(multiplyDecimal("0.00000001", "0.00000001")).toBe("0.0000000000000001");
    expect(compareDecimal("1.01", "1.001")).toBe(1);
    expect(decimal("-0.000")).toBe("0");
  });
  it("divides only terminating decimals without silently rounding", () => {
    expect(divideDecimal("19800", "1000000")).toBe("0.0198");
    expect(divideDecimal("0", "1000000")).toBe("0");
    expect(divideDecimal("1", "8")).toBe("0.125");
    expect(divideDecimal("1", "0.5")).toBe("2");
    expect(() => divideDecimal("1", "3")).toThrow("nonterminating");
    expect(() => divideDecimal("1", "0")).toThrow("unit_invalid");
    expect(() => nonnegativeDecimal("-1")).toThrow("negative");
    expect(() => decimal("1e-3")).toThrow("invalid");
  });
});
