import type { Metadata } from "../shared/types.js";
import type { ToolResult } from "../tools/index.js";

export interface RemoteToolResult<TOutput = unknown> {
  remoteCallId: string;
  toolResult: ToolResult<TOutput>;
  metadata: Metadata;
}
