import { describe, expect, it } from "vitest";
import * as api from "./index.js";
import * as audit from "./audit/index.js";
import * as redaction from "./redaction/index.js";
import * as telemetry from "./telemetry/index.js";

describe("Observability public API", () => {
  it("exposes distinct audit, telemetry, and redaction surfaces", () => {
    expect(Object.keys(audit).sort()).toEqual(["createAuditRecord"]);
    expect(Object.keys(telemetry).sort()).toEqual(["createTelemetryRecord"]);
    expect(Object.keys(redaction).sort()).toEqual(["Redactor", "defaultRedactionRules"]);
    expect(Object.keys(api).sort()).toEqual([
      ...new Set([
        ...Object.keys(audit),
        ...Object.keys(telemetry),
        ...Object.keys(redaction),
      ]),
    ].sort());
  });
});
