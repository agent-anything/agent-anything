import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunCauseSourceRef } from "./RunSettlement.js";

export type RunSuspensionCode =
  | "controller_stop_requested"
  | "completion_gate_feedback_exhausted"
  | "stop_hook_feedback_exhausted";

export interface RunSuspensionRef {
  readonly run: RunRef;
  readonly id: string;
  readonly revision: string;
}

export interface RunSuspension {
  readonly ref: RunSuspensionRef;
  readonly code: RunSuspensionCode;
  readonly source: RunCauseSourceRef;
  readonly reason: string;
  readonly runRevision: number;
  readonly suspendedAt: string;
}

export interface RunResumeRequestInput {
  readonly id: string;
  readonly expectedRunRevision: number;
  readonly suspension: RunSuspensionRef;
  readonly origin: "user" | "host";
  readonly reason: string;
}

export interface RunResumeRequest extends RunResumeRequestInput {
  readonly run: RunRef;
  readonly requestedAt: string;
}

export type RunResumeRejectionCode =
  | "resume_invalid"
  | "run_not_suspended"
  | "run_revision_stale"
  | "suspension_stale"
  | "run_cancelling"
  | "run_settled";

export type RunResumeReceipt =
  | {
      readonly status: "accepted";
      readonly request: RunResumeRequest;
      readonly currentRunRevision: number;
    }
  | {
      readonly status: "rejected";
      readonly code: RunResumeRejectionCode;
      readonly requestId: string;
      readonly currentRunRevision: number;
    };

export function sameRunSuspensionRef(left: RunSuspensionRef, right: RunSuspensionRef): boolean {
  return left.run.id === right.run.id && left.id === right.id && left.revision === right.revision;
}
