import type { ToolRevisionRef } from "../identity/index.js";

export interface ToolRevocationInput {
  readonly tool: ToolRevisionRef;
  readonly effectiveAt: string;
  readonly reasonCode: string;
}

export interface ToolActivationProofSlot {
  readonly kind: "fixed_local";
  readonly selectionRevision: string;
  readonly activationRevision: null;
}
