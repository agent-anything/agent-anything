import { describe, expect, it } from "vitest";
import {
  accountProviderTransport,
  verifyProviderTransportAccounting,
} from "./ProviderTransport.js";

const binding = {
  method: "POST" as const,
  endpoint: "https://provider.example/v1/chat",
  contentType: "application/json",
  encoding: "utf-8" as const,
};
const limit = {
  maximumBytes: 16,
  source: "host_configured" as const,
  revision: "limit-1",
};

describe("Provider transport accounting", () => {
  it("accounts exact UTF-8 bytes and binds the encoded body", () => {
    const accounting = accountProviderTransport({
      encodedBody: "{\"x\":\"ok\"}",
      binding,
      limit,
    });
    expect(accounting.encodedBytes).toBe(10);
    expect(accounting.disposition).toBe("within_limit");
    expect(() => verifyProviderTransportAccounting({
      accounting,
      encodedBody: "{\"x\":\"ok\"}",
      binding,
    })).not.toThrow();
  });

  it("rejects changed bodies and transport bindings", () => {
    const accounting = accountProviderTransport({ encodedBody: "{}", binding, limit });
    expect(() => verifyProviderTransportAccounting({
      accounting,
      encodedBody: "{\"changed\":true}",
      binding,
    })).toThrow(TypeError);
    expect(() => verifyProviderTransportAccounting({
      accounting,
      encodedBody: "{}",
      binding: { ...binding, endpoint: "https://provider.example/v1/other" },
    })).toThrow(TypeError);
  });

  it("reports local request-body overflow without calling it context overflow", () => {
    const accounting = accountProviderTransport({
      encodedBody: "x".repeat(17),
      binding,
      limit,
    });
    expect(accounting.disposition).toBe("exceeds_limit");
  });
});
