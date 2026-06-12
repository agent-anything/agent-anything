import type { Metadata } from "../shared/types.js";

export interface RemoteToolCall<TInput = unknown> {
  id: string;
  toolCallId: string;
  toolName: string;
  remoteNodeId: string;
  input: TInput;
  timeoutMs: number | null;
  metadata: Metadata;
}
