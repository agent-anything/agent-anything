import {
  RunTraceAssembler,
  type RunTraceObserver,
} from "@agent-anything/observability";
import type { RunResult } from "../run/index.js";
import type { CreateRunnerIdentity } from "./RunnerDependencies.js";

export function createRunnerTraceAssembler(input: {
  readonly runId: string;
  readonly taskId: string;
  readonly observers: readonly RunTraceObserver[];
  readonly createId: CreateRunnerIdentity;
}): RunTraceAssembler | null {
  if (input.observers.length === 0) {
    return null;
  }
  try {
    const traceId = input.createId({
      kind: "run_trace",
      runId: input.runId,
      sequence: 1,
    });
    return new RunTraceAssembler({
      traceId,
      runId: input.runId,
      taskId: input.taskId,
      createSpanId: ({ sequence }) => input.createId({
        kind: "trace_span",
        runId: input.runId,
        sequence,
      }),
      observers: input.observers,
    });
  } catch {
    return null;
  }
}

export function completeRunnerTrace(
  assembler: RunTraceAssembler | null,
  result: RunResult,
): void {
  if (assembler === null) {
    return;
  }
  try {
    assembler.complete({
      items: result.items.map((item) => Object.freeze({
        id: item.ref.id,
        runId: item.ref.run.id,
        sequence: item.ref.sequence,
        kind: item.payload.kind,
        createdAt: item.createdAt,
      })),
      result: Object.freeze({
        runId: result.runId,
        taskId: result.taskId,
        status: result.status,
        code: result.code,
        itemCount: result.items.length,
        evidenceCount: result.evidenceRefs.length,
        artifactCount: result.artifactRefs.length,
        errorCodes: Object.freeze(
          [...new Set(
            result.failure === null
              ? []
              : [
                  result.failure.failure.code,
                  ...result.relatedFailures.map(
                    (cause) => cause.failure.code,
                  ),
                ],
          )],
        ),
      }),
    });
  } catch {
    // Trace assembly is optional and cannot alter the exact RunResult.
  }
}
