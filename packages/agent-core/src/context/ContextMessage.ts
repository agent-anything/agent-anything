import type { Metadata } from "@agent-anything/shared";

export type ContextMessageRole = "system" | "user" | "assistant";

export interface ContextMessage {
  readonly id: string;
  readonly role: ContextMessageRole;
  readonly content: string;
  readonly metadata: Metadata;
}
