import type { Metadata } from "@agent-anything/shared";
import type { ToolResult } from "@agent-anything/tools";

export interface RemoteToolResult<TOutput = unknown> {
  remoteCallId: string;
  toolResult: ToolResult<TOutput>;
  metadata: Metadata;
}
