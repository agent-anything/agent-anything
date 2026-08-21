import { describe, expect, it } from "vitest";
import { createHelarcAgent } from "./HelarcAgent.js";

describe("createHelarcAgent", () => {
  it("defines the stable Helarc Agent identity and validates terminal output", () => {
    const agent = createHelarcAgent();

    expect(agent).toMatchObject({
      id: "helarc-code-agent",
      revision: "1",
      name: "Helarc",
      metadata: { product: "helarc" },
    });
    expect(agent.output.validate({ kind: "complete", summary: "Done." })).toEqual({
      valid: true,
      output: { kind: "complete", summary: "Done." },
    });
  });

  it("rejects non-terminal controller decisions as Agent output", () => {
    const output = createHelarcAgent().output;

    expect(output.validate({
      kind: "propose",
      summary: "Create a file.",
      change: { operation: "create", path: "empty.txt", content: "" },
    })).toEqual({
      valid: false,
      message: "Helarc output kind is invalid.",
    });
  });
});
