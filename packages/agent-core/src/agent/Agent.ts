import type { Metadata } from "@agent-anything/shared";
import type { ToolDescriptor } from "@agent-anything/tools";

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
  readonly tools: readonly ToolDescriptor[];
  readonly output: AgentOutputContract<TOutput>;
  readonly metadata: Metadata;
}
