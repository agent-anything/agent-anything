import type { Metadata } from "../../shared/types.js";

export interface ToolAdapterContext {
  now?: () => string;
  metadata?: Metadata;
}
