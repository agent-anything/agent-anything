import type { Metadata } from "@agent-anything/shared";

export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
  metadata: Metadata;
}
