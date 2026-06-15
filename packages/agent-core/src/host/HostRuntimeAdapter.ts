import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { RuntimeResult } from "../runtime/index.js";
import type {
  HostCancellation,
  HostRunInput,
  HostRunResult,
  HostSessionId,
} from "./HostSession.js";

export type HostRuntimeRun<TTaskInput = unknown, TOutput = unknown> = (
  input: HostRunInput<TTaskInput>,
) => Promise<RuntimeResult<TOutput>>;

export interface HostRuntimeAdapter<TTaskInput = unknown, TOutput = unknown> {
  run(input: HostRunInput<TTaskInput>): Promise<HostRunResult<TOutput>>;
}

export interface CreateHostRunResultInput<TOutput = unknown> {
  sessionId: HostSessionId;
  runtimeResult: RuntimeResult<TOutput>;
  cancellation?: HostCancellation;
  timestamp?: ISODateTimeString;
  metadata?: Metadata;
}

export function createHostRunResult<TOutput = unknown>(
  input: CreateHostRunResultInput<TOutput>,
): HostRunResult<TOutput> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const metadata = input.metadata ?? {};
  const base = {
    sessionId: input.sessionId,
    taskId: input.runtimeResult.taskId,
    timestamp,
    metadata,
  };

  if (input.runtimeResult.status === "succeeded") {
    return {
      sessionId: input.sessionId,
      taskId: input.runtimeResult.taskId,
      state: {
        ...base,
        status: "completed",
        runtimeResult: input.runtimeResult,
      },
      runtimeResult: input.runtimeResult,
      metadata,
    };
  }

  if (input.runtimeResult.status === "blocked") {
    return {
      sessionId: input.sessionId,
      taskId: input.runtimeResult.taskId,
      state: {
        ...base,
        status: "blocked",
        runtimeResult: input.runtimeResult,
      },
      runtimeResult: input.runtimeResult,
      metadata,
    };
  }

  if (input.runtimeResult.status === "cancelled") {
    const cancellation = input.cancellation ?? {
      requested: false,
      metadata: {},
    };

    return {
      sessionId: input.sessionId,
      taskId: input.runtimeResult.taskId,
      state: {
        ...base,
        status: "cancelled",
        cancellation,
        runtimeResult: input.runtimeResult,
      },
      runtimeResult: input.runtimeResult,
      cancellation,
      metadata,
    };
  }

  return {
    sessionId: input.sessionId,
    taskId: input.runtimeResult.taskId,
    state: {
      ...base,
      status: "failed",
      errors: input.runtimeResult.errors,
    },
    runtimeResult: input.runtimeResult,
    metadata,
  };
}
