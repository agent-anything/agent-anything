export type RecoveryBindingLimitation = {
  readonly component:"preparation_policy"|"method_comparison"|"activity_purposes";
  readonly code:string;
  readonly required:string;
  readonly available:string;
  readonly requiredDigest?:string;
  readonly availableDigest?:string;
}

export interface HelarcRecoverableWork {
  readonly id: string;
  readonly threadId: string|null;
  readonly title: string;
  readonly state: "interrupted" | "delivery_pending" | "prepared" | "admission_unconfirmed";
  readonly revision: number;
  readonly resumeLimitation?:RecoveryBindingLimitation;
}

export interface HelarcRecoverWorkInput {
  readonly id: string;
  readonly revision: number;
  readonly intent: "continue" | "cancel";
}

export type HelarcRecoverWorkResult = {readonly ok: true} | {readonly ok: false; readonly message: string};
