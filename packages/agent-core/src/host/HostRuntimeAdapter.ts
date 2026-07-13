import type { ISODateTimeString, Metadata } from "@agent-anything/shared";
import type { Runner } from "../runner/index.js";
import type { RunResult } from "../runner/index.js";
import type {
  HostRunInput,
  HostRunResult,
  HostSessionId,
  HostTerminalSessionState,
} from "./HostSession.js";

export interface HostRuntimeAdapter {
  run<TOutput>(input: HostRunInput<TOutput>): Promise<HostRunResult<TOutput>>;
}

export interface CreateHostRuntimeAdapterInput {
  readonly runner: Runner;
  readonly now?: () => ISODateTimeString;
}

export interface CreateHostRunResultInput<TOutput = unknown> {
  readonly sessionId: HostSessionId;
  readonly runResult: RunResult<TOutput>;
  readonly timestamp?: ISODateTimeString;
  readonly metadata?: Metadata;
}

export function createHostRuntimeAdapter(
  input: CreateHostRuntimeAdapterInput,
): HostRuntimeAdapter {
  const now = input.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async run<TOutput>(hostInput: HostRunInput<TOutput>) {
      const runResult = await input.runner.run(
        hostInput.agent,
        hostInput.runInput,
        hostInput.runConfig,
      );
      return createHostRunResult({
        sessionId: hostInput.sessionId,
        runResult,
        timestamp: now(),
        metadata: hostInput.metadata,
      });
    },
  });
}

export function createHostRunResult<TOutput = unknown>(
  input: CreateHostRunResultInput<TOutput>,
): HostRunResult<TOutput> {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const metadata = Object.freeze({ ...(input.metadata ?? {}) });
  const base = Object.freeze({
    sessionId: input.sessionId,
    taskId: input.runResult.taskId,
    runId: input.runResult.runId,
    timestamp,
    metadata,
  });
  const state = createTerminalState(base, input.runResult);

  return Object.freeze({
    sessionId: input.sessionId,
    taskId: input.runResult.taskId,
    runId: input.runResult.runId,
    state,
    runResult: input.runResult,
    metadata,
  });
}

function createTerminalState<TOutput>(
  base: {
    readonly sessionId: HostSessionId;
    readonly taskId: string;
    readonly runId: string;
    readonly timestamp: ISODateTimeString;
    readonly metadata: Metadata;
  },
  runResult: RunResult<TOutput>,
): HostTerminalSessionState<TOutput> {
  switch (runResult.status) {
    case "succeeded":
      return Object.freeze({ ...base, status: "completed", runResult });
    case "blocked":
      return Object.freeze({ ...base, status: "blocked", runResult });
    case "failed":
      return Object.freeze({
        ...base,
        status: "failed",
        runResult,
        errors: runResult.errors,
      });
    case "cancelled":
      return Object.freeze({ ...base, status: "cancelled", runResult });
  }
}
