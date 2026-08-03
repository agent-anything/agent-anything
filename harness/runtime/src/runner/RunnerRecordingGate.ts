import type {
  RuntimeError,
  RuntimeErrorOwner,
} from "@agent-anything/foundation";
import type { ObservabilityRecordPurpose } from "@agent-anything/observability";
import type { RunInfrastructureRequirement } from "./RunConfig.js";

export interface RunnerRecorder {
  readonly owner: Extract<RuntimeErrorOwner, "audit" | "telemetry">;
  readonly requirement: RunInfrastructureRequirement;
  execute(): Promise<RuntimeError | null>;
}

export async function settleRunnerRecordingGate(input: {
  readonly purpose: ObservabilityRecordPurpose;
  readonly signal: AbortSignal;
  readonly recorders: readonly RunnerRecorder[];
}): Promise<readonly RuntimeError[]> {
  const ordered = [...input.recorders].sort(compareRecorders);

  if (input.purpose === "runtime") {
    const errors = await settleRequired(ordered, input.signal);
    if (errors.length > 0) {
      return errors;
    }
    for (const recorder of ordered) {
      if (recorder.requirement === "optional") {
        startOptional(recorder);
      }
    }
    return Object.freeze([]);
  }

  const errors: RuntimeError[] = [];
  for (const recorder of ordered) {
    if (input.signal.aborted) {
      break;
    }
    const error = await recorder.execute();
    if (error !== null) {
      errors.push(error);
    }
  }
  return Object.freeze(errors);
}

async function settleRequired(
  recorders: readonly RunnerRecorder[],
  signal: AbortSignal,
): Promise<readonly RuntimeError[]> {
  const errors: RuntimeError[] = [];
  for (const recorder of recorders) {
    if (recorder.requirement !== "required") {
      continue;
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    const error = await recorder.execute();
    if (error !== null) {
      errors.push(error);
    }
  }
  return Object.freeze(errors);
}

function startOptional(recorder: RunnerRecorder): void {
  try {
    void recorder.execute().catch(() => {
      // Optional runtime recording is deliberately non-authoritative.
    });
  } catch {
    // Optional runtime recording is deliberately non-authoritative.
  }
}

function compareRecorders(left: RunnerRecorder, right: RunnerRecorder): number {
  const requirementDifference =
    requirementRank(left.requirement) - requirementRank(right.requirement);
  return requirementDifference !== 0
    ? requirementDifference
    : ownerRank(left.owner) - ownerRank(right.owner);
}

function requirementRank(requirement: RunInfrastructureRequirement): number {
  return requirement === "required" ? 0 : 1;
}

function ownerRank(owner: RunnerRecorder["owner"]): number {
  return owner === "audit" ? 0 : 1;
}
