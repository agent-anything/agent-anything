import type { Metadata } from "@agent-anything/shared";

export type ContextMessageRole = "system" | "user" | "assistant";

export interface ContextMessage {
  id: string;
  role: ContextMessageRole;
  content: string;
  metadata: Metadata;
}
