import { describe, expect, it } from "vitest";
import {
  createHelarcAgent,
  createHelarcDelegatedWorkerAgent,
} from "./HelarcAgent.js";

const MODEL = Object.freeze({ providerId: "test-provider", modelId: "test-model" });

describe("Helarc Agents", () => {
  it("binds the main Agent revision to the exact selected instructions", () => {
    const production = createHelarcAgent({ target: "production", ...MODEL });
    const minimal = createHelarcAgent({ target: "minimal", ...MODEL });

    expect(production).toMatchObject({
      id: "helarc-code-agent",
      name: "Helarc",
      metadata: { product: "helarc", instructionTarget: "production" },
    });
    expect(production.revision).toContain(production.instructions.contentDigest.value);
    expect(minimal.revision).toContain(minimal.instructions.contentDigest.value);
    expect(minimal.revision).not.toBe(production.revision);
    expect(production.output.validate({ kind: "complete", summary: "Done." })).toEqual({
      valid: true,
      output: { kind: "complete", summary: "Done." },
    });
  });

  it("creates an exact delegated-worker Agent rather than reusing the main Agent", () => {
    const main = createHelarcAgent({ target: "production", ...MODEL });
    const delegated = createHelarcDelegatedWorkerAgent(MODEL);

    expect(delegated.id).toBe("helarc-delegated-worker");
    expect(delegated.metadata).toMatchObject({ instructionTarget: "delegated-worker" });
    expect(delegated.revision).not.toBe(main.revision);
    expect(delegated.instructions.blocks.at(-1)?.id).toBe("delegated_work");
  });

  it("changes Agent revision when model-specific resolution identity changes", () => {
    const first = createHelarcAgent({ target: "production", ...MODEL });
    const second = createHelarcAgent({
      target: "production",
      providerId: MODEL.providerId,
      modelId: "other-model",
    });

    expect(second.revision).not.toBe(first.revision);
  });

  it("rejects non-terminal controller decisions as Agent output", () => {
    const output = createHelarcAgent({ target: "production", ...MODEL }).output;

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
