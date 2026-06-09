import type { Metadata } from "../../shared/types.js";
import type { ToolCall } from "../ToolCall.js";
import type { ToolDefinition } from "../ToolDefinition.js";
import type { ToolResult } from "../ToolResult.js";
import type { ToolRisk } from "../ToolRisk.js";
import type { ToolAdapter } from "./ToolAdapter.js";
import type { ToolAdapterContext } from "./ToolAdapterContext.js";

export type FunctionToolHandler<TInput = unknown, TOutput = unknown> = (
  call: ToolCall<TInput>,
  context: ToolAdapterContext,
) => TOutput | Promise<TOutput>;

export interface FunctionToolAdapterInput<TInput = unknown, TOutput = unknown> {
  name: string;
  risk: ToolRisk;
  handler: FunctionToolHandler<TInput, TOutput>;
  description?: string;
  metadata?: Metadata;
  inputSchema?: unknown;
  context?: ToolAdapterContext;
}

export class FunctionToolAdapter<TInput = unknown, TOutput = unknown>
implements ToolAdapter {
  readonly name: string;
  private readonly risk: ToolRisk;
  private readonly handler: FunctionToolHandler<TInput, TOutput>;
  private readonly description?: string;
  private readonly metadata: Metadata;
  private readonly inputSchema: unknown;
  private readonly context: ToolAdapterContext;

  constructor(input: FunctionToolAdapterInput<TInput, TOutput>) {
    assertName(input.name);

    this.name = input.name;
    this.risk = input.risk;
    this.handler = input.handler;
    this.description = input.description;
    this.metadata = input.metadata ?? {};
    this.inputSchema = input.inputSchema;
    this.context = input.context ?? {};
  }

  toToolDefinition(): ToolDefinition<TInput, TOutput> {
    return {
      name: this.name,
      risk: this.risk,
      description: this.description,
      metadata: {
        ...this.metadata,
        adapter: "function",
        inputSchema: this.inputSchema,
      },
      execute: async (call) => this.execute(call),
    };
  }

  private async execute(call: ToolCall<TInput>): Promise<ToolResult<TOutput>> {
    const startedAt = this.now();

    try {
      const output = await this.handler(call, this.context);
      return {
        toolCallId: call.id,
        toolName: call.toolName,
        status: "succeeded",
        output,
        error: null,
        startedAt,
        finishedAt: this.now(),
        metadata: {
          ...call.metadata,
          ...this.context.metadata,
        },
      };
    } catch (error) {
      return {
        toolCallId: call.id,
        toolName: call.toolName,
        status: "failed",
        output: null,
        error: {
          code: "tool_adapter_handler_failed",
          message: error instanceof Error ? error.message : "Tool adapter handler failed.",
        },
        startedAt,
        finishedAt: this.now(),
        metadata: {
          ...call.metadata,
          ...this.context.metadata,
        },
      };
    }
  }

  private now(): string {
    return this.context.now?.() ?? new Date().toISOString();
  }
}

function assertName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("Tool adapter name must not be empty.");
  }
}
