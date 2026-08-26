import {
  snapshotAgent,
  type Agent,
  type AgentInstructions,
} from "@agent-anything/agent-core/agent";
import type { HelarcAgentOutput } from "../controller/HelarcController.js";
import {
  HELARC_INSTRUCTION_CATALOG,
  resolveHelarcAgentInstructions,
  type HelarcMainInstructionTarget,
} from "../instructions/index.js";

export interface CreateHelarcAgentInput {
  readonly target: HelarcMainInstructionTarget;
  readonly providerId: string;
  readonly modelId: string;
}

export interface CreateHelarcDelegatedWorkerAgentInput {
  readonly providerId: string;
  readonly modelId: string;
}

export function createHelarcAgent(
  input: CreateHelarcAgentInput,
): Agent<HelarcAgentOutput> {
  return createAgent(
    "helarc-code-agent",
    "Helarc",
    input.target,
    resolveHelarcAgentInstructions({
      catalog: HELARC_INSTRUCTION_CATALOG,
      target: input.target,
      agentId: "helarc-code-agent",
      providerId: input.providerId,
      modelId: input.modelId,
    }),
  );
}

export function createHelarcDelegatedWorkerAgent(
  input: CreateHelarcDelegatedWorkerAgentInput,
): Agent<HelarcAgentOutput> {
  return createAgent(
    "helarc-delegated-worker",
    "Helarc Delegated Worker",
    "delegated-worker",
    resolveHelarcAgentInstructions({
      catalog: HELARC_INSTRUCTION_CATALOG,
      target: "delegated-worker",
      agentId: "helarc-delegated-worker",
      providerId: input.providerId,
      modelId: input.modelId,
    }),
  );
}

function createAgent(
  id: string,
  name: string,
  instructionTarget: string,
  instructions: AgentInstructions,
): Agent<HelarcAgentOutput> {
  return snapshotAgent({
    id,
    revision: `instructions-v1:${instructions.contentDigest.value}`,
    name,
    instructions,
    output: HELARC_OUTPUT_CONTRACT,
    metadata: Object.freeze({ product: "helarc", instructionTarget }),
  });
}

const HELARC_OUTPUT_CONTRACT = Object.freeze({
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
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
