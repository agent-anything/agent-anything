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

export interface AgentRevisionRef {
  readonly id: string;
  readonly revision: string;
}

export interface Agent<TOutput = unknown> {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly instructions: AgentInstructions;
  readonly output: AgentOutputContract<TOutput>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function snapshotAgent<TOutput>(agent: Agent<TOutput>): Agent<TOutput> {
  assertRecord(agent, "Agent");
  assertNonEmpty(agent.id, "Agent.id");
  assertNonEmpty(agent.revision, "Agent.revision");
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
    revision: agent.revision,
    name: agent.name,
    instructions: agent.instructions,
    output: agent.output,
    metadata: snapshotMetadata(agent.metadata),
  });
}

export function toAgentRevisionRef(agent: Pick<Agent, "id" | "revision">): AgentRevisionRef {
  assertNonEmpty(agent.id, "Agent.id");
  assertNonEmpty(agent.revision, "Agent.revision");
  return Object.freeze({ id: agent.id, revision: agent.revision });
}
