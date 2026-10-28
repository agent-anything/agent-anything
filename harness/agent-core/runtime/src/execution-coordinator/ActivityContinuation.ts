import { modelInputValueDigest } from "@agent-anything/model-interaction/input";
import { createModelActivityBinding, type ModelActivityBinding } from "../model-access/ModelActivityBinding.js";
import { ActivityCheckpointError, type ActivityCheckpointPort } from "../activity/ActivityCheckpoint.js";
export type ActivityContinuationCause = {
  readonly kind: "capacity_rejection";
  readonly location: "local_admission" | "provider";
  readonly code: string;
} | {
  readonly kind: "protocol_correction";
  readonly code: string;
  readonly feedback: unknown;
};
export interface ActivityContinuationArrangement {
  readonly version: 1;
  readonly id: string;
  readonly activity: ModelActivityBinding;
  readonly sourceRequestId: string;
  readonly sourceResponseId: string | null;
  readonly sequence: number;
  readonly cause: ActivityContinuationCause;
}
export function createActivityContinuationArrangement(input: Omit<ActivityContinuationArrangement, "version" | "id">): ActivityContinuationArrangement {
  const activity = createModelActivityBinding(input.activity);
  if (activity.id !== input.activity.id || input.activity.version !== activity.version ||
    !Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
    typeof input.sourceRequestId !== "string" || !input.sourceRequestId.trim() ||
    input.sourceResponseId !== null && (typeof input.sourceResponseId !== "string" || !input.sourceResponseId.trim()) ||
    typeof input.cause.code !== "string" || !input.cause.code.trim() ||
    !["capacity_rejection", "protocol_correction"].includes(input.cause.kind) ||
    input.cause.kind === "capacity_rejection" && !["local_admission", "provider"].includes(input.cause.location)) {
    throw new TypeError("Activity continuation requires a valid source, owner and progress.");
  }
  const value = {
    version: 1 as const, activity, sourceRequestId: input.sourceRequestId,
    sourceResponseId: input.sourceResponseId, sequence: input.sequence, cause: structuredClone(input.cause)
  };
  return Object.freeze({ ...value, id: `activity-continuation:${modelInputValueDigest(value)}` });
}
/** Coordinates acceptance only; input preparation and protocol interpretation remain with their owners. */
export class ActivityContinuationCoordinator {
  constructor(private readonly records: ActivityCheckpointPort | undefined) { }
  async accept(input: {
    readonly arrangement: ActivityContinuationArrangement;
    readonly expectedActivity: ModelActivityBinding;
    readonly maximumContinuations: number;
    readonly signal: AbortSignal;
    readonly assertAvailable: () => void;
  }): Promise<ActivityContinuationArrangement> {
    input.signal.throwIfAborted();
    input.assertAvailable();
    const arrangement = createActivityContinuationArrangement(input.arrangement);
    if (arrangement.id !== input.arrangement.id || arrangement.activity.id !== input.expectedActivity.id ||
      !Number.isSafeInteger(input.maximumContinuations) || input.maximumContinuations < 0 ||
      arrangement.sequence > input.maximumContinuations) {
      throw new TypeError("Activity continuation is not admitted for this activity or remaining allowance.");
    }
    // Repeating one source stage must find the same acceptance, not allocate another request.
    const key = `activity-continuation:${arrangement.activity.id}:${arrangement.cause.kind}:${arrangement.sourceRequestId}:${arrangement.sequence}`;
    const retained = this.records?.read(key);
    if (retained !== null && retained !== undefined) {
      if (modelInputValueDigest(retained) !== modelInputValueDigest(arrangement))
        throw new ActivityCheckpointError(key);
      return createActivityContinuationArrangement(retained as ActivityContinuationArrangement);
    }
    if (this.records) {
      if (!this.records.compareAndCommit)
        throw new ActivityCheckpointError("activity_continuation_requires_conditional_acceptance");
      await this.records.compareAndCommit([{ key, value: null }], [{ key, value: arrangement }]);
    }
    input.signal.throwIfAborted();
    return arrangement;
  }
}
