import type { RunRef } from "../run/index.js";

export interface RunItemRef {
  readonly run: RunRef;
  readonly id: string;
  readonly sequence: number;
}

export interface RunItemEnvelope<TPayload> {
  readonly ref: RunItemRef;
  readonly committedInRevision: number;
  readonly createdAt: string;
  readonly payload: TPayload;
}
