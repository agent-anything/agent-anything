import { describe, expect, it } from "vitest";
import { Redactor } from "./Redactor.js";

describe("Redactor", () => {
  it("redacts configured key names recursively", () => {
    const redactor = new Redactor();

    const result = redactor.redact({
      value: {
        user: "alice",
        token: "abc123",
        nested: {
          password: "secret-password",
        },
      },
    });

    expect(result).toEqual({
      value: {
        user: "alice",
        token: "[REDACTED]",
        nested: {
          password: "[REDACTED]",
        },
      },
      redacted: true,
      redactions: [
        {
          path: "$.token",
          ruleId: "key.token",
          reason: "Matches sensitive key 'token'.",
        },
        {
          path: "$.nested.password",
          ruleId: "key.password",
          reason: "Matches sensitive key 'password'.",
        },
      ],
      metadata: {},
    });
  });

  it("redacts configured string patterns recursively", () => {
    const redactor = new Redactor();

    const result = redactor.redact({
      value: {
        headers: [
          "Authorization: Bearer abc.def.ghi",
        ],
      },
    });

    expect(result.value).toEqual({
      headers: [
        "Authorization: [REDACTED]",
      ],
    });
    expect(result.redactions).toEqual([
      {
        path: "$.headers[0]",
        ruleId: "pattern.bearer-token",
        reason: "Matches bearer token pattern.",
      },
    ]);
  });

  it("redacts secret content by default", () => {
    const redactor = new Redactor();

    const result = redactor.redact({
      value: {
        safe: "nope",
      },
      sensitivity: "secret",
    });

    expect(result).toEqual({
      value: "[REDACTED]",
      redacted: true,
      redactions: [
        {
          path: "$",
          ruleId: "sensitivity.secret",
          reason: "Secret content is redacted by default.",
        },
      ],
      metadata: {},
    });
  });

  it("treats restricted content as reference-only by default", () => {
    const redactor = new Redactor();

    const result = redactor.redact({
      value: {
        payload: "restricted payload",
      },
      sensitivity: "restricted",
    });

    expect(result.value).toBe("[RESTRICTED]");
    expect(result.redactions).toEqual([
      {
        path: "$",
        ruleId: "sensitivity.restricted",
        reason: "Restricted content is reference-only by default.",
      },
    ]);
  });

  it("preserves safe public content", () => {
    const redactor = new Redactor();

    const result = redactor.redact({
      value: {
        host: "example.com",
        addresses: ["93.184.216.34"],
      },
      sensitivity: "public",
    });

    expect(result).toEqual({
      value: {
        host: "example.com",
        addresses: ["93.184.216.34"],
      },
      redacted: false,
      redactions: [],
      metadata: {},
    });
  });

  it("keeps private content unless a rule matches", () => {
    const redactor = new Redactor();

    const result = redactor.redact({
      value: {
        proxyConfigured: true,
        proxyUrl: "http://proxy.local:8080",
        apiKey: "key-123",
      },
      sensitivity: "private",
    });

    expect(result.value).toEqual({
      proxyConfigured: true,
      proxyUrl: "http://proxy.local:8080",
      apiKey: "[REDACTED]",
    });
    expect(result.redactions).toEqual([
      {
        path: "$.apiKey",
        ruleId: "key.apiKey",
        reason: "Matches sensitive key 'apiKey'.",
      },
    ]);
  });

  it("preserves metadata and supports custom rules", () => {
    const redactor = new Redactor({
      rules: [
        {
          id: "key.proxyUrl",
          kind: "key",
          key: "proxyUrl",
          reason: "Product rule for proxy URL.",
        },
      ],
    });

    const result = redactor.redact({
      value: {
        proxyUrl: "http://user:password@proxy.local:8080",
      },
      metadata: {
        evidenceId: "evidence_proxy",
      },
    });

    expect(result).toEqual({
      value: {
        proxyUrl: "[REDACTED]",
      },
      redacted: true,
      redactions: [
        {
          path: "$.proxyUrl",
          ruleId: "key.proxyUrl",
          reason: "Product rule for proxy URL.",
        },
      ],
      metadata: {
        evidenceId: "evidence_proxy",
      },
    });
  });
});
