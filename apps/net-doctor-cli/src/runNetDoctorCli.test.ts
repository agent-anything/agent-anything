import { FakeProvider } from "@agent-anything/testing";
import { describe, expect, it } from "vitest";
import { runNetDoctorCli } from "./runNetDoctorCli.js";

describe("runNetDoctorCli", () => {
  it("runs a diagnosis through product runtime composition", async () => {
    const lines: string[] = [];
    const result = await runNetDoctorCli({
      args: {
        target: "https://example.com",
        symptom: "Browser cannot connect.",
        permissionMode: "trusted",
      },
      provider: new FakeProvider({
        responses: [
          {
            status: "succeeded",
            output: {
              kind: "final",
              finalOutput: {
                conclusion: "No extra checks needed.",
              },
            },
            usage: null,
            error: null,
            metadata: {},
          },
        ],
      }),
      write(line) {
        lines.push(line);
      },
    });

    expect(result).toMatchObject({
      status: "succeeded",
      exitCode: 0,
    });
    expect(lines.some((line) => line.includes("NetDoctor diagnosis"))).toBe(true);
    expect(lines.some((line) => line.includes("Result: succeeded"))).toBe(true);
  });
});
