import type { RemoteToolCall } from "./RemoteToolCall.js";
import type { RemoteToolResult } from "./RemoteToolResult.js";

export interface RemoteToolPort {
  call<TInput = unknown, TOutput = unknown>(
    input: RemoteToolCall<TInput>,
  ): Promise<RemoteToolResult<TOutput>>;
}
