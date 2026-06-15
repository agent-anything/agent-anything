import { FakeProvider } from "@agent-anything/testing";
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
    expect(result.hostResult.state.status).toBe("completed");
    expect(result.hostEvents.some((event) => event.name === "host.runtime.event")).toBe(true);
    expect(result.output).toEqual({
      conclusion: "Desktop test completed.",
    });
    expect(result.errors).toEqual([]);
  });
});
