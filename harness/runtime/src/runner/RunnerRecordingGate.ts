import type { ObservabilityRecordPurpose } from "@agent-anything/observability";
import type {
  RunFailureCause,
  RunFailureKind,
} from "@agent-anything/runtime/run";
import type { RunInfrastructureRequirement } from "./RunConfig.js";

export interface RunnerRecorder {
  readonly owner: Extract<RunFailureKind, "audit" | "telemetry">;
  readonly requirement: RunInfrastructureRequirement;
  execute(): Promise<ObservabilityRunFailure | null>;
}

type ObservabilityRunFailure = Extract<
  RunFailureCause,
  { readonly kind: "audit" | "telemetry" }
>;

export async function settleRunnerRecordingGate(input: {
  readonly purpose: ObservabilityRecordPurpose;
  readonly signal: AbortSignal;
  readonly recorders: readonly RunnerRecorder[];
}): Promise<readonly ObservabilityRunFailure[]> {
  const ordered = [...input.recorders].sort(compareRecorders);

  if (input.purpose === "runtime") {
    const failures = await settleRequired(ordered, input.signal);
    if (failures.length > 0) {
      return failures;
    }
    for (const recorder of ordered) {
      if (recorder.requirement === "optional") {
        startOptional(recorder);
      }
    }
    return Object.freeze([]);
  }

  const failures: ObservabilityRunFailure[] = [];
  for (const recorder of ordered) {
    if (input.signal.aborted) {
      break;
    }
    const failure = await recorder.execute();
    if (failure !== null) {
      failures.push(failure);
    }
  }
  return Object.freeze(failures);
}

async function settleRequired(
  recorders: readonly RunnerRecorder[],
  signal: AbortSignal,
): Promise<readonly ObservabilityRunFailure[]> {
  const failures: ObservabilityRunFailure[] = [];
  for (const recorder of recorders) {
    if (recorder.requirement !== "required") {
      continue;
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    const failure = await recorder.execute();
    if (failure !== null) {
      failures.push(failure);
    }
  }
  return Object.freeze(failures);
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
