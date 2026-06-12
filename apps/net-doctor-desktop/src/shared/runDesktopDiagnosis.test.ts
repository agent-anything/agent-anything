import { FakeProvider } from "@agent-anything/platform";
import { describe, expect, it } from "vitest";
import { runDesktopDiagnosis } from "./runDesktopDiagnosis.js";

describe("runDesktopDiagnosis", () => {
  it("runs NetDoctor through the desktop host boundary", async () => {
    const result = await runDesktopDiagnosis({
      request: {
        target: "https://example.com",
        symptom: "Browser cannot connect.",
        permissionMode: "trusted",
        executionAccess: "workspace",
      },
      provider: new FakeProvider({
        responses: [
          {
            status: "succeeded",
            output: {
              kind: "final",
              finalOutput: {
                conclusion: "Desktop test completed.",
              },
            },
            usage: null,
            error: null,
            metadata: {},
          },
        ],
      }),
    });

    expect(result.status).toBe("succeeded");
    expect(result.reportRef).toMatch(/^artifact_report_report_task_/);
    expect(result.errors).toEqual([]);
  });
});
