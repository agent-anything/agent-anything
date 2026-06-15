import type {
  RemoteToolCall,
  RemoteToolPort,
  RemoteToolResult,
} from "../remote-tools/index.js";

export type FakeRemoteToolPortHandler = (
  input: RemoteToolCall,
) => RemoteToolResult | Promise<RemoteToolResult>;

export class FakeRemoteToolPort implements RemoteToolPort {
  readonly calls: RemoteToolCall[] = [];

  constructor(
    private readonly handler: FakeRemoteToolPortHandler,
  ) {}

  async call<TInput = unknown, TOutput = unknown>(
    input: RemoteToolCall<TInput>,
  ): Promise<RemoteToolResult<TOutput>> {
    this.calls.push(input);
    return this.handler(input) as RemoteToolResult<TOutput> | Promise<RemoteToolResult<TOutput>>;
  }
}
