import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { AgentTask } from "../task/index.js";

export type RunInputMessageRole = "system" | "user" | "assistant";

export interface RunInputItem {
  readonly id: string;
  readonly kind: "message";
  readonly role: RunInputMessageRole;
  readonly content: string;
  readonly createdAt: ISODateTimeString;
  readonly metadata: Metadata;
}

export interface RunInput {
  readonly runId: string;
  readonly task: AgentTask;
  readonly conversationItems: readonly RunInputItem[];
  readonly metadata: Metadata;
}
