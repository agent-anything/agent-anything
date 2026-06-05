import type { ISODateTimeString, Metadata } from "../../shared/types.js";

export interface AgentTask<TInput = unknown> {
  id: string;
  kind: string;
  input: TInput;
  createdAt: ISODateTimeString;
  metadata: Metadata;
}
