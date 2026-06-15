import type { ISODateTimeString, Metadata } from "@agent-anything/shared";

export interface AgentTask<TInput = unknown> {
  id: string;
  kind: string;
  input: TInput;
  createdAt: ISODateTimeString;
  metadata: Metadata;
}
