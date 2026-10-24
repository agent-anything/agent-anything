import type {ContextMaterialDescription, ContextMaterialRef} from "@agent-anything/context/material";
import type {ContextMaterialTransfer} from "./ContextMaterialDatabase.js";

export type ContextMaterialObservation =
  | {kind: "published"; runId: string; description: ContextMaterialDescription}
  | {kind: "retention"; transfer: ContextMaterialTransfer; state: "prepared" | "accepted" | "released"}
  | {kind: "access"; runId: string; invocationId: string; mode: "read" | "search"; reused: boolean;
      references: readonly ContextMaterialRef[]; coverage: Readonly<Record<string, unknown>>};
export interface ContextMaterialObserver {observe(value: ContextMaterialObservation): void;}
