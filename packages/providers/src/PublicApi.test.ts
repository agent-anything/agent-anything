import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("Providers public API", () => {
  it("exposes only Provider-owned interruption helpers as runtime values", () => {
    expect(Object.keys(api).sort()).toEqual([
      "createProviderAttemptInterruption",
      "providerResultFromInterruption",
    ]);
  });
});
