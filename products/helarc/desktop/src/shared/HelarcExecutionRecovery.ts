export interface HelarcRecoverableWork {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  readonly state: "interrupted" | "delivery_pending";
  readonly revision: number;
}

export interface HelarcRecoverWorkInput {
  readonly id: string;
  readonly revision: number;
  readonly intent: "continue" | "cancel";
}

export type HelarcRecoverWorkResult = {readonly ok: true} | {readonly ok: false; readonly message: string};
