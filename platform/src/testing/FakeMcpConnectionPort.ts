import type {
  McpConnectionPort,
  McpToolCallInput,
  McpToolCallResult,
} from "../mcp/index.js";

export type FakeMcpConnectionPortHandler = (
  input: McpToolCallInput,
) => McpToolCallResult | Promise<McpToolCallResult>;

export class FakeMcpConnectionPort implements McpConnectionPort {
  readonly calls: McpToolCallInput[] = [];

  constructor(
    private readonly handler: FakeMcpConnectionPortHandler,
  ) {}

  async callTool<TInput = unknown, TOutput = unknown>(
    input: McpToolCallInput<TInput>,
  ): Promise<McpToolCallResult<TOutput>> {
    this.calls.push(input);
    return this.handler(input) as McpToolCallResult<TOutput> | Promise<McpToolCallResult<TOutput>>;
  }
}
