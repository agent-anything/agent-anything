import { basename } from "node:path";
import {
  assertActionExecutorDispatchContext,
  createActionRegistrationSnapshot,
  createCanonicalExecutableIdentity,
  createCanonicalPathIdentity,
  createCanonicalSha256Digest,
  type ActionAdapter,
  type ActionAdapterDescriptor,
  type ActionAdapterPreparedData,
  type ActionExecutor,
  type ActionExecutorContext,
  type ActionExecutorDescriptor,
  type CanonicalEnvironmentIdentity,
  type PreparedActionInvocation,
  type SerializableValue,
  type TargetStateAssertion,
} from "@agent-anything/action-execution";
import type { InvocationInterruptionRef } from "@agent-anything/shared";
import type { ToolJsonObject, ToolResult } from "@agent-anything/tools";
import { createToolCatalogSnapshot } from "@agent-anything/tools";
import {
  executeProcess,
  type CapturedProcessOutput,
  type ProcessExecutionOutcome,
} from "../process/ProcessExecutor.js";
import { parseCommandInput } from "../process/CommandInput.js";
import { resolveCommandLimits } from "../process/CommandLimits.js";
import {
  inspectPreparedFileSystemTarget,
  prepareFileSystemTarget,
} from "../file-actions/FileActionFilesystem.js";
import {
  CODE_AGENT_RUN_COMMAND_ACTION,
  type CodeAgentCommandActionCapability,
  type CreateCodeAgentCommandActionCapabilityInput,
  type PreparedCommandInvocationPayload,
  type RunCommandOutput,
} from "./CommandActionContracts.js";
import {
  createCommandEnvironmentPolicy,
  resolveCommandExecutable,
  revalidateCommandExecutable,
  type CommandEnvironmentPolicySnapshot,
} from "./CommandActionIdentity.js";

const ADAPTER_DESCRIPTOR: ActionAdapterDescriptor = Object.freeze({
  id: "code-agent.command.adapter",
  version: "1",
  inputSchemaVersion: "1",
});

const EXECUTOR_DESCRIPTOR: ActionExecutorDescriptor = Object.freeze({
  id: "code-agent.command.executor",
  version: "1",
  invocationContractVersion: "1",
});

const DEFAULT_TERMINATION = Object.freeze({
  gracePeriodMs: 500,
  forceKillTimeoutMs: 2_000,
});

export async function createCodeAgentCommandActionCapability(
  input: CreateCodeAgentCommandActionCapabilityInput,
): Promise<CodeAgentCommandActionCapability> {
  const limits = resolveCommandLimits(input.limits);
  const termination = resolveTermination(input.termination);
  const environment = await createCommandEnvironmentPolicy({
    id: input.environmentPolicyId ?? "code-agent.command.environment.default",
    overrides: input.environment,
  });
  const now = input.now ?? (() => new Date().toISOString());
  const nowMs = input.nowMs ?? (() => Date.now());
  const registrations = createActionRegistrationSnapshot([{
    actionName: CODE_AGENT_RUN_COMMAND_ACTION,
    adapter: ADAPTER_DESCRIPTOR,
    executor: EXECUTOR_DESCRIPTOR,
  }]);
  const adapter = createCommandActionAdapter(input, limits, termination, environment);

  return Object.freeze({
    catalog: createCommandCatalog(),
    registrations,
    adapters: Object.freeze([Object.freeze({
      actionName: CODE_AGENT_RUN_COMMAND_ACTION,
      adapter,
    })]),
    executors: Object.freeze([
      createCommandActionExecutor(environment, now, nowMs),
    ]),
  });
}

function createCommandCatalog() {
  const inputSchema: ToolJsonObject = {
    type: "object",
    additionalProperties: false,
    required: ["command", "args", "reason"],
    properties: {
      command: { type: "string", minLength: 1 },
      args: { type: "array", items: { type: "string" } },
      rootName: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      timeoutMs: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 1 },
    },
  };
  return createToolCatalogSnapshot([{
    name: CODE_AGENT_RUN_COMMAND_ACTION,
    description: "Run one process inside a declared task workspace root.",
    inputSchema,
    annotations: {
      title: "Run command",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    metadata: { capabilityOwner: "code-agent", schemaVersion: 1 },
  }]);
}

function createCommandActionAdapter(
  input: CreateCodeAgentCommandActionCapabilityInput,
  limits: ReturnType<typeof resolveCommandLimits>,
  termination: PreparedCommandInvocationPayload["termination"],
  environment: CommandEnvironmentPolicySnapshot,
): ActionAdapter {
  const adapter: ActionAdapter = {
    descriptor: ADAPTER_DESCRIPTOR,
    async prepare(action, context) {
      const interruption = observeInterruption(context.interruption);
      if (interruption !== null) return interruption;
      try {
        assertStrictCommandInput(action.input);
        const parsed = parseCommandInput(action.input, limits);
        const cwd = await prepareFileSystemTarget({
          workspaceScope: input.workspaceScope,
          workspaceRoots: context.workspace.roots,
          platform: context.environment.platform,
          rootName: parsed.rootName,
          path: parsed.cwd,
          operation: "list",
        });
        const executable = await resolveCommandExecutable({
          command: parsed.command,
          cwd: cwd.canonicalTarget,
          platform: context.environment.platform,
          environment: environment.environment,
        });
        const afterResolution = observeInterruption(context.interruption);
        if (afterResolution !== null) return afterResolution;
        return {
          status: "prepared" as const,
          data: await preparedData({
            parsed,
            cwd,
            executable,
            environment,
            termination,
            runtimeEnvironment: context.environment,
            limits,
          }),
        };
      } catch (error) {
        const afterFailure = observeInterruption(context.interruption);
        if (afterFailure !== null) return afterFailure;
        return rejected(safeMessage(error, "Command Action input or target is invalid."));
      }
    },
    async revalidate(invocation, assertions, context) {
      const interruption = observeInterruption(context.interruption);
      if (interruption !== null) return interruption;
      try {
        const payload = readPreparedPayload(invocation);
        const rootAssertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "workspace_root_identity" }> =>
            candidate.kind === "workspace_root_identity" &&
            candidate.expected.rootId === payload.workspaceId,
        );
        const cwdPathAssertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "canonical_path_identity" }> =>
            candidate.kind === "canonical_path_identity" &&
            samePath(candidate.expected.canonicalPath, payload.cwdPath),
        );
        const cwdBaselineAssertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "file_baseline" }> =>
            candidate.kind === "file_baseline" && samePath(candidate.path.canonicalPath, payload.cwdPath),
        );
        const executableAssertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "executable_identity" }> =>
            candidate.kind === "executable_identity",
        );
        if (rootAssertion === undefined || cwdPathAssertion === undefined ||
          cwdBaselineAssertion === undefined || executableAssertion === undefined) {
          return invalidated("command_assertion_missing", "Required command assertions are missing.");
        }
        const actualCwd = await inspectPreparedFileSystemTarget({
          platform: context.environment.platform,
          operation: "list",
          workspaceRootIdentity: rootAssertion.expected,
          workspaceRoot: payload.workspaceRoot,
          canonicalRoot: payload.canonicalRoot,
          canonicalTarget: payload.cwd,
          path: payload.cwdPath,
        });
        const actualExecutable = await revalidateCommandExecutable({
          originalCommand: payload.displayCommand,
          expectedPath: payload.executablePath,
          cwd: payload.cwd,
          platform: context.environment.platform,
        });
        if (!samePathIdentity(actualCwd.pathIdentity, cwdPathAssertion.expected)) {
          return invalidated("command_cwd_identity_changed", "Command working-directory identity changed.");
        }
        if (!sameBaseline(actualCwd.baseline, cwdBaselineAssertion.expected) ||
          !sameBaseline(actualCwd.baseline, payload.cwdBaseline)) {
          return invalidated("command_cwd_baseline_changed", "Command working-directory baseline changed.");
        }
        if (!sameExecutableIdentity(actualExecutable.identity, executableAssertion.expected) ||
          !sameBaseline(actualExecutable.identity.baseline, payload.executableBaseline)) {
          return invalidated("command_executable_changed", "Command executable identity changed.");
        }
        if (payload.environmentPolicyId !== environment.id ||
          payload.environmentDigest !== environment.digest ||
          payload.runtimeEnvironmentId !== context.environment.environmentId ||
          payload.runtimeEnvironmentPlatform !== context.environment.platform ||
          payload.runtimeEnvironmentFingerprint !== context.environment.configurationFingerprint) {
          return invalidated("command_environment_changed", "Command environment identity changed.");
        }
        return { status: "valid" as const };
      } catch (error) {
        const afterFailure = observeInterruption(context.interruption);
        if (afterFailure !== null) return afterFailure;
        return invalidated(
          "command_target_changed",
          safeMessage(error, "Command identity changed after preparation."),
        );
      }
    },
  };
  return Object.freeze(adapter);
}

async function preparedData(input: {
  readonly parsed: ReturnType<typeof parseCommandInput>;
  readonly cwd: Awaited<ReturnType<typeof prepareFileSystemTarget>>;
  readonly executable: Awaited<ReturnType<typeof resolveCommandExecutable>>;
  readonly environment: CommandEnvironmentPolicySnapshot;
  readonly termination: PreparedCommandInvocationPayload["termination"];
  readonly runtimeEnvironment: CanonicalEnvironmentIdentity;
  readonly limits: ReturnType<typeof resolveCommandLimits>;
}): Promise<ActionAdapterPreparedData> {
  const executable = createCanonicalExecutableIdentity(input.executable.identity);
  const cwd = createCanonicalPathIdentity(input.cwd.pathIdentity);
  const payload: PreparedCommandInvocationPayload = {
    actionName: CODE_AGENT_RUN_COMMAND_ACTION,
    executablePath: executable.path.canonicalPath,
    executableBaseline: executable.baseline,
    displayCommand: input.parsed.command,
    args: Object.freeze([...input.parsed.args]),
    rootName: input.cwd.rootName,
    workspaceId: input.cwd.workspaceId,
    workspaceRoot: input.cwd.workspaceRoot,
    canonicalRoot: input.cwd.canonicalRoot,
    cwdPath: input.cwd.pathIdentity.path,
    cwd: input.cwd.canonicalTarget,
    cwdDisplay: `${input.cwd.rootName}:${input.cwd.relativePath}`,
    cwdBaseline: input.cwd.baseline,
    timeoutMs: input.parsed.timeoutMs,
    maxStdoutBytes: input.limits.maxStdoutBytes,
    maxStderrBytes: input.limits.maxStderrBytes,
    environmentPolicyId: input.environment.id,
    environmentDigest: input.environment.digest,
    runtimeEnvironmentId: input.runtimeEnvironment.environmentId,
    runtimeEnvironmentPlatform: input.runtimeEnvironment.platform,
    runtimeEnvironmentFingerprint: input.runtimeEnvironment.configurationFingerprint,
    termination: input.termination,
  };
  const applicabilityDigest = await createCanonicalSha256Digest(
    "agent-anything.code-agent.command-applicability.v1",
    {
      executable: executable.path.canonicalPath,
      arguments: input.parsed.args,
      cwd: cwd.canonicalPath,
      environmentDigest: input.environment.digest,
    },
  );
  const data: ActionAdapterPreparedData = {
    operation: {
      kind: "process",
      operation: "spawn",
      executable: input.executable.identity,
      arguments: input.parsed.args.map((value) => ({ kind: "literal" as const, value })),
      cwd: input.cwd.pathIdentity,
      environmentDigest: input.environment.digest,
    },
    effectSet: {
      kind: "effects",
      values: [{ kind: "process", operation: "spawn", executable: input.executable.identity }],
    },
    requestedPermissions: null,
    targetAssertions: [
      { kind: "workspace_root_identity", expected: rootIdentityInput(input.cwd.workspaceRootIdentity) },
      { kind: "canonical_path_identity", expected: input.cwd.pathIdentity },
      { kind: "file_baseline", path: input.cwd.pathIdentity, expected: input.cwd.baseline },
      { kind: "executable_identity", expected: input.executable.identity },
    ],
    approvalCategory: "commandExecution",
    approvalPayload: {
      command: [executable.path.canonicalPath, ...input.parsed.args],
      safeCommandDisplay: `${basename(executable.path.canonicalPath)} (${input.parsed.args.length} args)`,
      cwd: cwd.canonicalPath,
      cwdDisplay: payload.cwdDisplay,
      environmentId: input.runtimeEnvironment.environmentId,
      commandActions: [{ kind: "process", summary: "Spawn one process" }],
      additionalPermissions: null,
    },
    applicabilityKeys: [{ category: "commandExecution", value: applicabilityDigest }],
    safeSummary: {
      kind: "process",
      headline: "Run workspace command",
      commandDisplay: `${basename(executable.path.canonicalPath)} (${input.parsed.args.length} args)`,
      cwdDisplay: payload.cwdDisplay,
    },
    preparedInvocation: {
      contractVersion: EXECUTOR_DESCRIPTOR.invocationContractVersion,
      executorId: EXECUTOR_DESCRIPTOR.id,
      executorVersion: EXECUTOR_DESCRIPTOR.version,
      payload: payload as unknown as SerializableValue,
    },
  };
  return Object.freeze(data);
}

function createCommandActionExecutor(
  environment: CommandEnvironmentPolicySnapshot,
  now: () => string,
  nowMs: () => number,
): ActionExecutor {
  const executor: ActionExecutor = {
    descriptor: EXECUTOR_DESCRIPTOR,
    async execute(invocation, context) {
      assertActionExecutorDispatchContext(context);
      const startedAt = now();
      const startedMs = nowMs();
      let payload: PreparedCommandInvocationPayload;
      try {
        payload = readPreparedPayload(invocation);
        if (payload.environmentPolicyId !== environment.id ||
          payload.environmentDigest !== environment.digest) {
          throw new TypeError("Prepared command environment policy changed.");
        }
        const executable = await revalidateCommandExecutable({
          originalCommand: payload.displayCommand,
          expectedPath: payload.executablePath,
          cwd: payload.cwd,
          platform: process.platform === "win32" ? "win32" : "posix",
        });
        if (!sameBaseline(executable.identity.baseline, payload.executableBaseline)) {
          throw new TypeError("Command executable changed before dispatch.");
        }
        const outcome = await executeProcess({
          command: payload.executablePath,
          args: payload.args,
          cwd: payload.cwd,
          environment: environment.environment,
          replaceEnvironment: true,
          timeoutMs: payload.timeoutMs,
          maxStdoutBytes: payload.maxStdoutBytes,
          maxStderrBytes: payload.maxStderrBytes,
          interruption: context.interruption,
          termination: payload.termination,
          startedMs,
          nowMs,
        });
        return processResult(payload, outcome, context, startedAt, now());
      } catch (error) {
        const candidate = safeReadPayload(invocation);
        return interruptionResult(candidate, context, startedAt, now()) ?? result(
          candidate,
          context,
          startedAt,
          now(),
          "failed",
          null,
          { code: "command_execution_failed", message: safeMessage(error, "Command execution failed.") },
        );
      }
    },
  };
  return Object.freeze(executor);
}

function processResult(
  payload: PreparedCommandInvocationPayload,
  outcome: ProcessExecutionOutcome,
  context: ActionExecutorContext,
  startedAt: string,
  finishedAt: string,
): ToolResult {
  if (outcome.kind === "cancelled_before_start") {
    return interruptionResult(payload, context, startedAt, finishedAt) ?? result(
      payload, context, startedAt, finishedAt, "interrupted", null,
      { code: "tool_cancellation_unconfirmed", message: "Command did not start after an unattributed interruption." },
    );
  }
  if (outcome.kind === "failed") {
    return result(payload, context, startedAt, finishedAt, "failed", null, {
      code: "command_process_start_failed",
      message: "Failed to start or monitor the command process.",
    });
  }
  if (outcome.kind === "timeout") {
    return result(payload, context, startedAt, finishedAt, "timeout", null, {
      code: outcome.terminationConfirmed ? "command_timeout" : "command_timeout_termination_unconfirmed",
      message: outcome.terminationConfirmed
        ? "Command exceeded the configured timeout."
        : "Command timed out and process termination could not be confirmed.",
      metadata: capturedMetadata(outcome),
    });
  }
  if (outcome.kind === "cancellation_unconfirmed") {
    return result(payload, context, startedAt, finishedAt, "interrupted", processOutput(
      payload, outcome, null, null, true, false, "forced", false,
    ), { code: "tool_cancellation_unconfirmed", message: outcome.message });
  }
  if (outcome.kind === "cancelled") {
    const interruption = context.interruption.interruption;
    const attributed = interruption?.kind === "run_cancellation";
    return result(payload, context, startedAt, finishedAt, "interrupted", processOutput(
      payload, outcome, outcome.exitCode, outcome.signal, true, attributed, outcome.termination, true,
    ), attributed
      ? {
          code: "command_cancelled",
          message: "Command process was terminated after Run cancellation.",
          metadata: {
            runId: interruption.cancellation.runId,
            requestId: interruption.cancellation.requestId,
          },
        }
      : { code: "tool_cancellation_unconfirmed", message: "Command stopped without trusted Run cancellation attribution." });
  }
  return result(payload, context, startedAt, finishedAt, "succeeded", processOutput(
    payload, outcome, outcome.exitCode, outcome.signal, false, false, null, true,
  ), null);
}

function processOutput(
  payload: PreparedCommandInvocationPayload,
  captured: CapturedProcessOutput,
  exitCode: number | null,
  signal: string | null,
  interrupted: boolean,
  cancellationAttributed: boolean,
  termination: "graceful" | "forced" | null,
  settlementConfirmed: boolean,
): RunCommandOutput {
  const common = {
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    command: payload.executablePath,
    args: [...payload.args],
    cwd: payload.cwdDisplay,
    exitCode,
    signal,
    stdout: captured.stdout,
    stderr: captured.stderr,
    durationMs: captured.durationMs,
    stdoutTruncated: captured.stdoutTruncated,
    stderrTruncated: captured.stderrTruncated,
    timedOut: false as const,
    settlementConfirmed,
  };
  return interrupted
    ? { ...common, interrupted: true, cancellationAttributed, termination: termination ?? "forced" }
    : { ...common, interrupted: false, cancellationAttributed: false, termination: null, settlementConfirmed: true };
}

function result(
  payload: PreparedCommandInvocationPayload | null,
  context: ActionExecutorContext,
  startedAt: string,
  finishedAt: string,
  status: ToolResult["status"],
  output: unknown,
  error: ToolResult["error"],
): ToolResult {
  return {
    toolCallId: context.attempt.actionId,
    toolName: payload?.actionName ?? CODE_AGENT_RUN_COMMAND_ACTION,
    status,
    output,
    error,
    startedAt,
    finishedAt,
    metadata: payload === null ? {} : {
      rootName: payload.rootName,
      workspaceId: payload.workspaceId,
      cwd: payload.cwdDisplay,
      executable: payload.executablePath,
      environmentPolicyId: payload.environmentPolicyId,
    },
  };
}

function interruptionResult(
  payload: PreparedCommandInvocationPayload | null,
  context: ActionExecutorContext,
  startedAt: string,
  finishedAt: string,
): ToolResult | null {
  if (!context.interruption.signal.aborted) return null;
  const interruption = context.interruption.interruption;
  if (interruption?.kind === "run_cancellation") {
    return result(payload, context, startedAt, finishedAt, "cancelled", null, {
      code: "tool_cancelled",
      message: "Command was cancelled before process execution.",
      metadata: {
        runId: interruption.cancellation.runId,
        requestId: interruption.cancellation.requestId,
      },
    });
  }
  if (interruption?.kind === "operation_deadline") {
    return result(payload, context, startedAt, finishedAt, "timeout", null, {
      code: "tool_timeout",
      message: "Command operation exceeded its invocation deadline.",
      metadata: {
        operationId: interruption.deadline.operationId,
        deadlineAt: interruption.deadline.deadlineAt,
      },
    });
  }
  return result(payload, context, startedAt, finishedAt, "interrupted", null, {
    code: "tool_cancellation_unconfirmed",
    message: "Command was interrupted without trusted attribution.",
  });
}

function readPreparedPayload(invocation: PreparedActionInvocation): PreparedCommandInvocationPayload {
  if (invocation.contractVersion !== EXECUTOR_DESCRIPTOR.invocationContractVersion ||
    invocation.executorId !== EXECUTOR_DESCRIPTOR.id ||
    invocation.executorVersion !== EXECUTOR_DESCRIPTOR.version) {
    throw new TypeError("Prepared command invocation executor identity is invalid.");
  }
  const value = strictRecord(invocation.payload, new Set([
    "actionName", "executablePath", "executableBaseline", "displayCommand", "args",
    "rootName", "workspaceId", "workspaceRoot", "canonicalRoot", "cwdPath", "cwd", "cwdDisplay",
    "cwdBaseline", "timeoutMs", "maxStdoutBytes", "maxStderrBytes", "environmentPolicyId",
    "environmentDigest", "runtimeEnvironmentId", "runtimeEnvironmentPlatform",
    "runtimeEnvironmentFingerprint", "termination",
  ]), "Prepared command invocation");
  if (value.actionName !== CODE_AGENT_RUN_COMMAND_ACTION || !Array.isArray(value.args) ||
    !value.args.every((candidate) => typeof candidate === "string")) {
    throw new TypeError("Prepared command invocation action or arguments are invalid.");
  }
  const termination = strictRecord(
    value.termination,
    new Set(["gracePeriodMs", "forceKillTimeoutMs"]),
    "Prepared command termination",
  );
  return Object.freeze({
    actionName: CODE_AGENT_RUN_COMMAND_ACTION,
    executablePath: requiredString(value.executablePath, "executablePath"),
    executableBaseline: requireBaseline(value.executableBaseline),
    displayCommand: requiredString(value.displayCommand, "displayCommand"),
    args: Object.freeze([...(value.args as string[])]),
    rootName: requiredString(value.rootName, "rootName"),
    workspaceId: requiredString(value.workspaceId, "workspaceId"),
    workspaceRoot: requiredString(value.workspaceRoot, "workspaceRoot"),
    canonicalRoot: requiredString(value.canonicalRoot, "canonicalRoot"),
    cwdPath: requiredString(value.cwdPath, "cwdPath"),
    cwd: requiredString(value.cwd, "cwd"),
    cwdDisplay: requiredString(value.cwdDisplay, "cwdDisplay"),
    cwdBaseline: requireBaseline(value.cwdBaseline),
    timeoutMs: positiveInteger(value.timeoutMs, "timeoutMs"),
    maxStdoutBytes: positiveInteger(value.maxStdoutBytes, "maxStdoutBytes"),
    maxStderrBytes: positiveInteger(value.maxStderrBytes, "maxStderrBytes"),
    environmentPolicyId: requiredString(value.environmentPolicyId, "environmentPolicyId"),
    environmentDigest: requiredDigest(value.environmentDigest, "environmentDigest"),
    runtimeEnvironmentId: requiredString(value.runtimeEnvironmentId, "runtimeEnvironmentId"),
    runtimeEnvironmentPlatform: requirePlatform(value.runtimeEnvironmentPlatform),
    runtimeEnvironmentFingerprint: requiredDigest(
      value.runtimeEnvironmentFingerprint,
      "runtimeEnvironmentFingerprint",
    ),
    termination: Object.freeze({
      gracePeriodMs: positiveInteger(termination.gracePeriodMs, "gracePeriodMs"),
      forceKillTimeoutMs: positiveInteger(termination.forceKillTimeoutMs, "forceKillTimeoutMs"),
    }),
  });
}

function safeReadPayload(invocation: PreparedActionInvocation): PreparedCommandInvocationPayload | null {
  try { return readPreparedPayload(invocation); } catch { return null; }
}

function assertStrictCommandInput(input: unknown): void {
  strictRecord(
    input,
    new Set(["command", "args", "rootName", "cwd", "timeoutMs", "reason"]),
    "Command Action input",
  );
}

function strictRecord(
  input: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field '${String(key)}'.`);
    }
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (property?.get !== undefined || property?.set !== undefined || !property?.enumerable) {
      throw new TypeError(`${label} field '${key}' must be an enumerable data property.`);
    }
  }
  return input as Record<string, unknown>;
}

function resolveTermination(
  input: CreateCodeAgentCommandActionCapabilityInput["termination"],
) {
  return Object.freeze({
    gracePeriodMs: positiveInteger(input?.gracePeriodMs ?? DEFAULT_TERMINATION.gracePeriodMs, "gracePeriodMs"),
    forceKillTimeoutMs: positiveInteger(
      input?.forceKillTimeoutMs ?? DEFAULT_TERMINATION.forceKillTimeoutMs,
      "forceKillTimeoutMs",
    ),
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Prepared command field '${field}' must be non-empty text.`);
  }
  return value;
}

function requiredDigest(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) {
    throw new TypeError(`Prepared command field '${field}' must be a canonical SHA-256 digest.`);
  }
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`Command field '${field}' must be a positive safe integer.`);
  }
  return value as number;
}

function requireBaseline(value: unknown): PreparedCommandInvocationPayload["cwdBaseline"] {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    ((value as { kind?: unknown }).kind !== "absent" &&
      (value as { kind?: unknown }).kind !== "present")) {
    throw new TypeError("Prepared command file baseline is invalid.");
  }
  return value as PreparedCommandInvocationPayload["cwdBaseline"];
}

function observeInterruption(input: {
  readonly signal: AbortSignal;
  readonly interruption: InvocationInterruptionRef | null;
}) {
  if (!input.signal.aborted) return null;
  if (input.interruption === null) {
    return {
      status: "failed" as const,
      code: "tool_interruption_unattributed",
      message: "Command Action interruption is not attributed.",
      retryable: false,
    };
  }
  return { status: "interrupted" as const, interruption: input.interruption };
}

function rejected(message: string) {
  return { status: "rejected" as const, code: "action_invalid" as const, message };
}

function invalidated(code: string, message: string) {
  return { status: "invalidated" as const, code, message };
}

function rootIdentityInput(root: {
  readonly rootId: string;
  readonly platform: "win32" | "posix";
  readonly canonicalPath: string;
  readonly resolvedPath: string | null;
  readonly resolutionFingerprint: string;
}) {
  return {
    rootId: root.rootId,
    platform: root.platform,
    path: root.canonicalPath,
    resolvedPath: root.resolvedPath ?? root.canonicalPath,
    resolutionFingerprint: root.resolutionFingerprint,
  };
}

function requirePlatform(value: unknown): "win32" | "posix" {
  if (value !== "win32" && value !== "posix") {
    throw new TypeError("Prepared command runtime environment platform is invalid.");
  }
  return value;
}

function samePathIdentity(
  actual: { path: string; resolvedPath: string | null; workspaceRootId: string | null; resolutionFingerprint: string },
  expected: { canonicalPath: string; resolvedPath: string | null; workspaceRootId: string | null; resolutionFingerprint: string },
): boolean {
  return samePath(actual.path, expected.canonicalPath) &&
    sameNullablePath(actual.resolvedPath, expected.resolvedPath) &&
    actual.workspaceRootId === expected.workspaceRootId &&
    actual.resolutionFingerprint === expected.resolutionFingerprint;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase()
    : left === right;
}

function sameNullablePath(left: string | null, right: string | null): boolean {
  return left === null || right === null ? left === right : samePath(left, right);
}

function sameExecutableIdentity(
  actual: {
    readonly path: { readonly path: string; readonly resolvedPath: string | null; readonly workspaceRootId: string | null; readonly resolutionFingerprint: string };
    readonly baseline: PreparedCommandInvocationPayload["executableBaseline"];
  },
  expected: {
    readonly path: { readonly canonicalPath: string; readonly resolvedPath: string | null; readonly workspaceRootId: string | null; readonly resolutionFingerprint: string };
    readonly baseline: PreparedCommandInvocationPayload["executableBaseline"];
  },
): boolean {
  return samePathIdentity(actual.path, expected.path) &&
    sameBaseline(actual.baseline, expected.baseline);
}

function sameBaseline(
  left: PreparedCommandInvocationPayload["cwdBaseline"],
  right: PreparedCommandInvocationPayload["cwdBaseline"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  if (left.entryKind !== right.entryKind || left.contentDigest !== right.contentDigest ||
    left.objectIdentity.kind !== right.objectIdentity.kind) {
    return false;
  }
  return left.objectIdentity.kind === "win32" && right.objectIdentity.kind === "win32"
    ? left.objectIdentity.volumeId === right.objectIdentity.volumeId &&
      left.objectIdentity.fileId === right.objectIdentity.fileId
    : left.objectIdentity.kind === "posix" && right.objectIdentity.kind === "posix" &&
      left.objectIdentity.deviceId === right.objectIdentity.deviceId &&
      left.objectIdentity.inode === right.objectIdentity.inode;
}

function capturedMetadata(outcome: Extract<ProcessExecutionOutcome, { kind: "timeout" }>) {
  return {
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    terminationConfirmed: outcome.terminationConfirmed,
  };
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof TypeError ||
    (error instanceof Error && error.name === "CommandInputError")
    ? error.message
    : fallback;
}
