import {
  assertMetadata,
  assertNonEmpty,
  assertRecord,
  snapshotMetadata,
} from "../validation.js";

export type AgentInstructions = string;

export type AgentOutputValidation<TOutput> =
  | {
      readonly valid: true;
      readonly output: TOutput;
    }
  | {
      readonly valid: false;
      readonly message: string;
    };

export interface AgentOutputContract<TOutput = unknown> {
  validate(candidate: unknown): AgentOutputValidation<TOutput>;
}

export interface Agent<TOutput = unknown> {
  readonly id: string;
  readonly name: string;
  readonly instructions: AgentInstructions;
  readonly output: AgentOutputContract<TOutput>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function snapshotAgent<TOutput>(agent: Agent<TOutput>): Agent<TOutput> {
  assertRecord(agent, "Agent");
  assertNonEmpty(agent.id, "Agent.id");
  assertNonEmpty(agent.name, "Agent.name");
  if (typeof agent.instructions !== "string") {
    throw new TypeError("Agent.instructions must be text.");
  }
  if (!agent.output || typeof agent.output.validate !== "function") {
    throw new TypeError("Agent.output must provide validate().");
  }
  assertMetadata(agent.metadata, "Agent.metadata");

  return Object.freeze({
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    output: agent.output,
    metadata: snapshotMetadata(agent.metadata),
  });
}
