import type { Metadata } from "../shared/types.js";

export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
  metadata: Metadata;
}
