import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Test Support public API", () => {
  it("exposes only lower-port fakes", () => {
    expect(Object.keys(api).sort()).toEqual([
      "FakeApprovalReviewer",
      "FakeAuditPort",
      "FakeEvidencePersistencePort",
      "FakeProvider",
      "FakeRuntimeEventPublisher",
      "FakeTelemetryPort",
      "createTestContextProjection",
      "createTestVerificationExecutionFactory",
    ]);
  });
});
