import { describe, expect, it } from "vitest";
import * as api from "./index.js";
import * as audit from "./audit/index.js";
import * as events from "./events/index.js";
import * as redaction from "./redaction/index.js";
import * as telemetry from "./telemetry/index.js";

describe("Observability public API", () => {
  it("exposes distinct event, audit, telemetry, and redaction surfaces", () => {
    expect(Object.keys(audit).sort()).toEqual([
      "AUDIT_RECORD_SCHEMA_VERSION",
      "createAuditRecord",
    ]);
    expect(Object.keys(events).sort()).toEqual([
      "RUNTIME_EVENT_SCHEMA_VERSION",
      "RuntimeEventStream",
      "snapshotRuntimeEventPayload",
    ]);
    expect(Object.keys(telemetry).sort()).toEqual([
      "TELEMETRY_RECORD_SCHEMA_VERSION",
      "createTelemetryRecord",
    ]);
    expect(Object.keys(redaction).sort()).toEqual(["Redactor", "defaultRedactionRules"]);
    expect(Object.keys(api).sort()).toEqual([
      ...new Set([
        ...Object.keys(audit),
        ...Object.keys(events),
        ...Object.keys(telemetry),
        ...Object.keys(redaction),
      ]),
    ].sort());
  });
});
