

export interface RemoteToolCall<TInput = unknown> {
  id: string;
  toolCallId: string;
  toolName: string;
  remoteNodeId: string;
  input: TInput;
  timeoutMs: number | null;
  metadata: Readonly<Record<string, unknown>>;
}
