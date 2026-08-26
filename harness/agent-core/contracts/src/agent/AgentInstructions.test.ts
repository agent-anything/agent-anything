import { describe, expect, it } from "vitest";
import {
  createAgentInstructions,
  snapshotAgentInstructions,
  type AgentInstructions,
} from "./AgentInstructions.js";

describe("AgentInstructions", () => {
  it("creates one deeply immutable canonical snapshot", () => {
    const instructions = exampleInstructions();

    expect(instructions.ref.revision).toBe(`sha256:${instructions.contentDigest.value}`);
    expect(instructions.contentDigest.value).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(instructions)).toBe(true);
    expect(Object.isFrozen(instructions.blocks)).toBe(true);
    expect(Object.isFrozen(instructions.blocks[0]?.source)).toBe(true);
    expect(snapshotAgentInstructions(instructions)).toEqual(instructions);
  });

  it("changes identity when ordered content or model correlation changes", () => {
    const original = exampleInstructions();
    const reordered = exampleInstructions({ reverse: true });
    const otherModel = exampleInstructions({ modelId: "model-2" });

    expect(reordered.contentDigest.value).not.toBe(original.contentDigest.value);
    expect(otherModel.contentDigest.value).not.toBe(original.contentDigest.value);
  });

  it("rejects duplicate blocks, unknown fields, and digest tampering", () => {
    expect(() => createAgentInstructions({
      id: "test.instructions",
      release: { id: "test.release", revision: "1" },
      model: { providerId: "test-provider", modelId: "model-1" },
      resolverRevision: "1",
      blocks: [block("same", "one"), block("same", "two")],
    })).toThrow(/duplicate block id/);

    const instructions = exampleInstructions();
    const tampered = {
      ...instructions,
      contentDigest: { ...instructions.contentDigest, value: "0".repeat(64) },
    } as AgentInstructions;
    expect(() => snapshotAgentInstructions(tampered)).toThrow(/does not match/);

    expect(() => snapshotAgentInstructions({
      ...instructions,
      unexpected: true,
    } as AgentInstructions)).toThrow(/must contain exactly/);
  });
});

function exampleInstructions(input: {
  readonly reverse?: boolean;
  readonly modelId?: string;
} = {}): AgentInstructions {
  const blocks = [block("identity", "Act carefully."), block("workflow", "Complete the task.")];
  return createAgentInstructions({
    id: "test.instructions",
    release: { id: "test.release", revision: "1" },
    model: { providerId: "test-provider", modelId: input.modelId ?? "model-1" },
    resolverRevision: "1",
    blocks: input.reverse ? blocks.reverse() : blocks,
  });
}

function block(id: string, content: string) {
  return {
    id,
    source: { owner: "test", kind: "instruction_source", id: `source.${id}`, revision: "1" },
    content,
  };
}
