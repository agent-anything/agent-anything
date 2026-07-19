import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Testing public API", () => {
  it("exposes only lower-port fakes", () => {
    expect(Object.keys(api).sort()).toEqual([
      "FakeApprovalReviewer",
      "FakeAuditPort",
      "FakeIdentityProvider",
      "FakeProvider",
      "FakeTelemetryPort",
      "FakeWorkspaceResolver",
    ]);
  });
});
