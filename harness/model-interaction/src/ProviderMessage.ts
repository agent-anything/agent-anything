import type { Metadata } from "@agent-anything/foundation";

export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
  metadata: Metadata;
}
