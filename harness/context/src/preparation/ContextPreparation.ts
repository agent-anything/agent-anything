import {createHash} from "node:crypto";

export interface ContextPreparationIntent {
  readonly id: string;
  readonly runId: string;
  readonly basis: string;
  readonly predecessor: string | null;
  readonly deadlineAt: string;
  /** Exact finite stage identities, frozen before work starts. */
  readonly stages: readonly string[];
}

export interface ContextPreparationHead {
  readonly intent: ContextPreparationIntent;
  readonly revision: number;
  readonly state: "open" | "retired";
  readonly retirement: string | null;
}

/** Independent owner storage. Values are immutable and never confer Run authority. */
export interface ContextPreparationStore {
  open(intent: ContextPreparationIntent): Promise<ContextPreparationHead>;
  read(id: string, stage: string): Promise<unknown | null>;
  write(id: string, stage: string, value: unknown): Promise<void>;
  retire(id: string, reason: string): Promise<void>;
}

export function contextPreparationDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function validateContextPreparationIntent(value: ContextPreparationIntent): void {
  if (!value || Object.keys(value).some(key => !["id", "runId", "basis", "predecessor", "deadlineAt", "stages"].includes(key)) ||
      ![value.id, value.runId, value.basis].every(token) || (value.predecessor !== null && !token(value.predecessor)) ||
      !Number.isFinite(Date.parse(value.deadlineAt)) || !Array.isArray(value.stages) || !value.stages.length ||
      value.stages.length > 256 || !value.stages.every(token) || new Set(value.stages).size !== value.stages.length) {
    throw new TypeError("Invalid context preparation intent.");
  }
}

function token(value: unknown): value is string {return typeof value === "string" && value.length > 0 && value.length <= 2048 && value.trim() === value;}
