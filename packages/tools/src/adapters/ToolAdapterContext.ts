import type { Metadata } from "@agent-anything/shared";

export interface ToolAdapterContext {
  now?: () => string;
  metadata?: Metadata;
}
