import type { RunRef } from "@agent-anything/agent-core/run";
import type { RunSteeringCommandRef } from "@agent-anything/agent-core/control";

export interface RunSteeringAttribution {
  readonly origin: "user" | "host" | "model";
  readonly actorId: string | null;
}

export interface RunSteeringInput {
  readonly commandId: string;
  readonly expectedRunRevision: number;
  readonly instruction: string;
  readonly attribution: RunSteeringAttribution;
  readonly submittedAt: string;
}

export interface RunSteeringCommand extends RunSteeringInput {
  readonly ref: RunSteeringCommandRef;
  readonly acceptedRunRevision: number;
}

export type RunSteeringRejectionCode =
  | "steering_invalid"
  | "steering_command_conflict"
  | "steering_revision_stale"
  | "steering_queue_full"
  | "run_cancelling"
  | "run_settled";

export type RunSteeringSubmissionReceipt =
  | {
      readonly status: "accepted_for_application" | "duplicate_identical";
      readonly command: RunSteeringCommand;
    }
  | {
      readonly status: "rejected";
      readonly code: RunSteeringRejectionCode;
      readonly run: RunRef;
      readonly commandId: string;
      readonly currentRunRevision: number;
    };

export interface RunSteeringApplication {
  readonly command: RunSteeringCommand;
  readonly status: "applied" | "superseded" | "rejected" | "cancelled" | "run_settled";
  readonly appliedInRunRevision: number;
  readonly supersededByCommandId: string | null;
  readonly reasonCode: string | null;
}

export function snapshotRunSteeringInput(input: RunSteeringInput): RunSteeringInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Run steering input must be an object.");
  }
  const keys = Object.keys(input).sort();
  const expected = [
    "attribution",
    "commandId",
    "expectedRunRevision",
    "instruction",
    "submittedAt",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("Run steering input contains unsupported fields.");
  }
  const commandId = identity(input.commandId, "commandId");
  if (!Number.isSafeInteger(input.expectedRunRevision) || input.expectedRunRevision < 0) {
    throw new TypeError("Run steering expectedRunRevision must be a non-negative integer.");
  }
  if (
    typeof input.instruction !== "string" ||
    input.instruction.trim().length === 0 ||
    input.instruction.length > 32_768
  ) {
    throw new TypeError("Run steering instruction must be bounded non-empty text.");
  }
  if (
    input.attribution === null ||
    typeof input.attribution !== "object" ||
    Object.keys(input.attribution).sort().join(":") !== "actorId:origin" ||
    input.attribution.origin !== "user" &&
      input.attribution.origin !== "host" &&
      input.attribution.origin !== "model" ||
    (input.attribution.actorId !== null && !isIdentity(input.attribution.actorId))
  ) {
    throw new TypeError("Run steering attribution is invalid.");
  }
  if (
    typeof input.submittedAt !== "string" ||
    Number.isNaN(Date.parse(input.submittedAt)) ||
    new Date(input.submittedAt).toISOString() !== input.submittedAt
  ) {
    throw new TypeError("Run steering submittedAt must be an ISO date-time.");
  }
  return Object.freeze({
    commandId,
    expectedRunRevision: input.expectedRunRevision,
    instruction: input.instruction,
    attribution: Object.freeze({ ...input.attribution }),
    submittedAt: input.submittedAt,
  });
}

function identity(input: unknown, field: string): string {
  if (!isIdentity(input)) throw new TypeError(`Run steering ${field} must be an identity.`);
  return input;
}

function isIdentity(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && !/\s/.test(input);
}
