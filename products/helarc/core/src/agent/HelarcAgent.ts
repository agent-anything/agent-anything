import type { Agent } from "@agent-anything/agent-core/agent";
import type { HelarcAgentOutput } from "../controller/HelarcController.js";

export function createHelarcAgent(): Agent<HelarcAgentOutput> {
  return Object.freeze({
    id: "helarc-code-agent",
    revision: "1",
    name: "Helarc",
    instructions:
      "Complete the requested code task within the active workspace and safety boundaries.",
    output: Object.freeze({
      validate(candidate: unknown) {
        if (!isRecord(candidate) || typeof candidate.summary !== "string") {
          return { valid: false as const, message: "Helarc output requires a summary." };
        }
        if (candidate.kind !== "complete") {
          return { valid: false as const, message: "Helarc output kind is invalid." };
        }
        return {
          valid: true as const,
          output: Object.freeze({
            kind: "complete" as const,
            summary: candidate.summary,
          }),
        };
      },
    }),
    metadata: Object.freeze({ product: "helarc" }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
