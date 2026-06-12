import type { Metadata } from "../../shared/types.js";

export type ContextMessageRole = "system" | "user" | "assistant";

export interface ContextMessage {
  id: string;
  role: ContextMessageRole;
  content: string;
  metadata: Metadata;
}
