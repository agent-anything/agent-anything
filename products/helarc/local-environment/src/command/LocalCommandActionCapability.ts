import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import {
  createPreparedAction,
  type ActionAdapterImplementation,
  type ActionAdapterPreparedData,
  type ActionRevalidationResult,
  type ActionSemanticResult,
  type OperationActionAdapter,
  type PreparedAction,
} from "@agent-anything/action-execution/registration";
import {
  assertActionExecutorDispatchContext,
  type ActionExecutor,
  type PhysicalAttemptOutcome,
} from "@agent-anything/action-execution/execution";
import {
  createActionRegistrationSnapshot,
  type ActionAdapterDescriptor,
  type ActionExecutorDescriptor,
  type ActionRegistrationInput,
  type ActionRegistrationSnapshot,
} from "@agent-anything/canonical-action/registration";
import {
  canonicalPathIdentityKey,
  createCanonicalExecutableIdentity,
  createCanonicalPathIdentity,
  createCanonicalSha256Digest,
  type CanonicalEnvironmentIdentity,
  type CanonicalProcessIdentity,
  type CanonicalWorkspaceRootIdentity,
  type FileBaseline,
  type PreparedActionInvocation,
  type SerializableValue,
  type TargetStateAssertion,
} from "@agent-anything/canonical-action/subject";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import type { OperationBindingRevisionRef, OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { parseCommandInput } from "./CommandInput.js";
import { resolveCommandLimits } from "./CommandLimits.js";
import {
  createCommandEnvironmentPolicy,
  resolveCommandExecutable,
  revalidateCommandExecutable,
  selectNativeShell,
  type CommandEnvironmentPolicySnapshot,
} from "./CommandActionIdentity.js";
import { executeProcess, type CapturedProcessOutput, type ProcessExecutionOutcome } from "./ProcessExecutor.js";
import type { CodeAgentCommandLimits, ProcessTerminationLimits } from "./ProcessContracts.js";
import { RunProcessTaskRegistry, ProcessTaskRegistryError } from "./RunProcessTaskRegistry.js";
import {
  ShellExecutionSession,
  type ShellExecutionSessionSnapshot,
} from "./ShellExecutionSession.js";
import { interpretShellCommandOutcome } from "./ShellCommandOutcome.js";
import type {
  ProcessTextEncodingSource,
  ProcessTextIntegrity,
  ProcessTextProjection,
} from "./ProcessOutputText.js";
import {
  inspectPreparedFileSystemTarget,
  prepareFileSystemTarget,
  sameCanonicalPathIdentity,
  sameFileBaseline,
  type PreparedFileSystemTarget,
} from "../filesystem/FileSystemTarget.js";

export const HELARC_LOCAL_SHELL_ACTION_ADAPTER_ID = "helarc.local.shell.adapter";
export const HELARC_LOCAL_TASK_STOP_ACTION_ADAPTER_ID = "helarc.local.task-stop.adapter";

const SHELL_ADAPTER = Object.freeze({ id: HELARC_LOCAL_SHELL_ACTION_ADAPTER_ID, version: "3", requestSchemaRevision: "1" });
const STOP_ADAPTER = Object.freeze({ id: HELARC_LOCAL_TASK_STOP_ACTION_ADAPTER_ID, version: "1", requestSchemaRevision: "1" });
const SHELL_EXECUTOR = Object.freeze({ id: "helarc.local.shell.executor", version: "2", invocationContractVersion: "2", physicalPayloadSchemaRevision: "2" });
const STOP_EXECUTOR = Object.freeze({ id: "helarc.local.task-stop.executor", version: "1", invocationContractVersion: "1", physicalPayloadSchemaRevision: "1" });
const DEFAULT_TERMINATION: ProcessTerminationLimits = Object.freeze({ gracePeriodMs: 500, forceKillTimeoutMs: 2_000 });
const MAX_CWD_CONTROL_BYTES = 32_768;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface CreateHelarcLocalCommandActionCapabilityInput {
  readonly workspace: WorkspaceSelection;
  readonly platform: "win32" | "posix";
  readonly shellOperation: OperationRevisionRef;
  readonly shellBinding: OperationBindingRevisionRef;
  readonly taskStopOperation: OperationRevisionRef;
  readonly taskStopBinding: OperationBindingRevisionRef;
  readonly limits?: Partial<CodeAgentCommandLimits>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly environmentPolicyId?: string;
  readonly termination?: Partial<ProcessTerminationLimits>;
  readonly now?: () => string;
  readonly nowMs?: () => number;
}

export interface HelarcLocalCommandActionCapability {
  readonly shellTool: "Bash" | "PowerShell";
  readonly shellActionAdapterId: string;
  readonly taskStopActionAdapterId: string;
  readonly environment: { readonly id: string; readonly revision: string };
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
  readonly processTasks: RunProcessTaskRegistry;
  readonly taskStopBinding: OperationBindingRevisionRef;
  readonly taskAvailability: Pick<RunProcessTaskRegistry, "getRunAvailability">;
  readonly shellSession: Pick<ShellExecutionSession, "snapshot">;
}

interface ShellPayload {
  readonly runId: string;
  readonly executableCommand: string;
  readonly executablePath: string;
  readonly executableBaseline: FileBaseline;
  readonly args: readonly string[];
  readonly command: string;
  readonly cwdControlPath: string | null;
  readonly sessionRevision: number;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly cwdPath: string;
  readonly cwd: string;
  readonly cwdDisplay: string;
  readonly cwdBaseline: FileBaseline;
  readonly outputPath: string;
  readonly outputAbsolutePath: string;
  readonly outputBaseline: FileBaseline;
  readonly timeoutMs: number;
  readonly runInBackground: boolean;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxOutputFileBytes: number;
  readonly environmentPolicyId: string;
  readonly environmentDigest: string;
  readonly runtimeEnvironmentId: string;
  readonly runtimeEnvironmentPlatform: "win32" | "posix";
  readonly runtimeEnvironmentFingerprint: string;
  readonly termination: ProcessTerminationLimits;
}

interface StopPayload { readonly identity: CanonicalProcessIdentity; }
interface ShellBasis {
  readonly shell: "Bash" | "PowerShell";
  readonly command: string;
  readonly commandDisplay: string;
  readonly cwdDisplay: string;
}
interface StopBasis { readonly taskId: string; readonly cwdDisplay: string; }

export async function createHelarcLocalCommandActionCapability(input: CreateHelarcLocalCommandActionCapabilityInput): Promise<HelarcLocalCommandActionCapability> {
  const limits = resolveCommandLimits(input.limits);
  const termination = resolveTermination(input.termination);
  const environment = await createCommandEnvironmentPolicy({ id: input.environmentPolicyId ?? "helarc.local.shell.environment.default", overrides: input.environment });
  const processTasks = new RunProcessTaskRegistry(limits.maxActiveTasks, limits.maxSettledTasks);
  const shellSession = await ShellExecutionSession.create(input.workspace, input.platform);
  const shell = await selectNativeShell({
    platform: input.platform,
    cwd: shellSession.snapshot().canonicalPath,
    environment: environment.environment,
  });
  const registrations = createActionRegistrationSnapshot([
    registration("helarc.local.shell.registration.v3", input.shellOperation, input.shellBinding, SHELL_ADAPTER, SHELL_EXECUTOR, ["process", "filesystem"]),
    registration("helarc.local.task-stop.registration.v1", input.taskStopOperation, input.taskStopBinding, STOP_ADAPTER, STOP_EXECUTOR, ["process"]),
  ]);
  const now = input.now ?? (() => new Date().toISOString());
  const nowMs = input.nowMs ?? (() => Date.now());
  return Object.freeze({
    shellTool: shell.toolName,
    shellActionAdapterId: HELARC_LOCAL_SHELL_ACTION_ADAPTER_ID,
    taskStopActionAdapterId: HELARC_LOCAL_TASK_STOP_ACTION_ADAPTER_ID,
    environment: Object.freeze({ id: environment.id, revision: environment.digest }),
    registrations,
    adapters: Object.freeze([
      Object.freeze({ adapter: createShellAdapter(input.workspace, shellSession, shell, limits, termination, environment) }),
      Object.freeze({ adapter: createTaskStopAdapter(processTasks) }),
    ]),
    executors: Object.freeze([
      createShellExecutor(environment, processTasks, shellSession, now, nowMs),
      createTaskStopExecutor(processTasks, now),
    ]),
    processTasks,
    taskStopBinding: input.taskStopBinding,
    taskAvailability: processTasks,
    shellSession,
  });
}

function registration(
  id: string,
  operation: OperationRevisionRef,
  binding: OperationBindingRevisionRef,
  adapter: ActionAdapterDescriptor,
  executor: ActionExecutorDescriptor,
  effectFamilies: ActionRegistrationInput["effectFamilies"],
): ActionRegistrationInput {
  return {
    registrationId: id, revision: "1", operation, binding, adapter, executor,
    effectFamilies, sandboxRequirementRevision: "helarc.local.shell.sandbox.v1",
    maxInvocationBytes: 256_000, maxPhysicalResultBytes: 2_500_000,
  };
}

function createShellAdapter(
  workspace: WorkspaceSelection,
  session: ShellExecutionSession,
  shell: Awaited<ReturnType<typeof selectNativeShell>>,
  limits: CodeAgentCommandLimits,
  termination: ProcessTerminationLimits,
  environment: CommandEnvironmentPolicySnapshot,
): OperationActionAdapter<unknown, ShellBasis> {
  const adapter: OperationActionAdapter<unknown, ShellBasis> = {
    descriptor: SHELL_ADAPTER,
    async prepare(binding, context) {
      if (context.interruption.signal.aborted) return interruptedPreparation("shell_action_interrupted");
      try {
        const parsed = parseCommandInput(binding.request, limits);
        const runId = context.parentRunAction?.run.id;
        if (runId === undefined) return invalidPreparation("shell_run_required", "Shell execution requires an owning RunAction.");
        if (context.workspace === null) return invalidPreparation("workspace_required", "Shell execution requires a Run Workspace.");
        const sessionSnapshot = session.snapshot();
        const cwd = await prepareFileSystemTarget({
          workspace,
          workspaceRoots: context.workspace.roots,
          platform: context.environment.platform,
          rootName: sessionSnapshot.rootName,
          path: sessionSnapshot.relativePath,
          operation: "directory",
        });
        const outputPath = `.helarc-process-${digestToken(context.action.id)}.log`;
        const output = await prepareFileSystemTarget({ workspace, workspaceRoots: context.workspace.roots, platform: context.environment.platform, path: outputPath, operation: "write" });
        const executable = await resolveCommandExecutable({ command: shell.command, cwd: cwd.canonicalTarget, platform: context.environment.platform, environment: environment.environment });
        const cwdControlPath = parsed.runInBackground
          ? null
          : join(tmpdir(), `helarc-cwd-${digestToken(context.action.id)}.txt`);
        const args = Object.freeze([
          ...shell.argumentsBeforeCommand,
          commandWithFinalWorkingDirectory(
            shell.toolName,
            parsed.command,
            cwdControlPath,
          ),
        ]);
        const payload: ShellPayload = Object.freeze({
          runId, executableCommand: shell.command, executablePath: executable.canonicalPath,
          executableBaseline: executable.identity.baseline,
          args, command: parsed.command, cwdControlPath, sessionRevision: sessionSnapshot.revision,
          rootName: cwd.rootName, workspaceId: cwd.workspaceId,
          workspaceRoot: cwd.workspaceRoot, canonicalRoot: cwd.canonicalRoot, cwdPath: cwd.pathIdentity.path,
          cwd: cwd.canonicalTarget, cwdDisplay: `${cwd.rootName}:${cwd.relativePath}`, cwdBaseline: cwd.baseline,
          outputPath: output.relativePath, outputAbsolutePath: output.canonicalTarget, outputBaseline: output.baseline,
          timeoutMs: parsed.timeoutMs, runInBackground: parsed.runInBackground,
          maxStdoutBytes: limits.maxStdoutBytes, maxStderrBytes: limits.maxStderrBytes,
          maxOutputFileBytes: limits.maxOutputFileBytes, environmentPolicyId: environment.id,
          environmentDigest: environment.digest, runtimeEnvironmentId: context.environment.environmentId,
          runtimeEnvironmentPlatform: context.environment.platform,
          runtimeEnvironmentFingerprint: context.environment.configurationFingerprint, termination,
        });
        const data = await shellPreparedData(parsed.description, shell.toolName, payload, cwd, output, executable.identity, context.environment, context.now());
        return Object.freeze({ status: "prepared" as const, prepared: await createPreparedAction(binding, context, data) });
      } catch (error) {
        return invalidPreparation("shell_action_invalid", safeMessage(error, "Shell request or target is invalid."));
      }
    },
    async revalidate(prepared, assertions, context) {
      if (context.interruption.signal.aborted) return interruptedRevalidation("shell_action_interrupted");
      try {
        const payload = readShellPayload(prepared.invocation);
        const sessionSnapshot = session.snapshot();
        if (
          sessionSnapshot.revision !== payload.sessionRevision ||
          !samePath(sessionSnapshot.canonicalPath, payload.cwd)
        ) return invalidated("shell_session_changed");
        const executableAssertion = assertions.find((candidate): candidate is Extract<TargetStateAssertion, { kind: "executable_identity" }> => candidate.kind === "executable_identity");
        const cwdAssertions = pathAssertions(assertions, payload.cwdPath);
        const outputAssertions = pathAssertions(assertions, payload.outputAbsolutePath);
        if (executableAssertion === undefined || cwdAssertions === null || outputAssertions === null) return invalidated("shell_assertion_missing");
        const cwd = await inspectTarget(payload, cwdAssertions, "directory", payload.cwd, payload.cwdBaseline);
        const output = await inspectTarget(payload, outputAssertions, "write", payload.outputAbsolutePath, payload.outputBaseline);
        const executable = await revalidateCommandExecutable({ originalCommand: payload.executableCommand, expectedPath: payload.executablePath, cwd: payload.cwd, platform: context.environment.platform });
        const actualExecutable = createCanonicalExecutableIdentity(executable.identity);
        if (!sameCanonicalPathIdentity(cwd.pathIdentity, cwdAssertions.path.expected) ||
            !sameCanonicalPathIdentity(output.pathIdentity, outputAssertions.path.expected) ||
            !sameFileBaseline(cwd.baseline, payload.cwdBaseline) || !sameFileBaseline(output.baseline, payload.outputBaseline) ||
            canonicalPathIdentityKey(actualExecutable.path) !== canonicalPathIdentityKey(executableAssertion.expected.path) ||
            !sameFileBaseline(actualExecutable.baseline, executableAssertion.expected.baseline) ||
            payload.environmentPolicyId !== environment.id || payload.environmentDigest !== environment.digest ||
            payload.runtimeEnvironmentId !== context.environment.environmentId ||
            payload.runtimeEnvironmentFingerprint !== context.environment.configurationFingerprint) return invalidated("shell_target_changed");
        return Object.freeze({ status: "valid" as const, recordId: `revalidation:${context.action.id}:${context.subjectRevision}` });
      } catch { return invalidated("shell_target_changed"); }
    },
    async settle(prepared, settlement) { return settleShell(prepared, settlement); },
  };
  return Object.freeze(adapter);
}

async function shellPreparedData(
  description: string | null,
  shell: "Bash" | "PowerShell",
  payload: ShellPayload,
  cwd: PreparedFileSystemTarget,
  output: PreparedFileSystemTarget,
  executable: Parameters<typeof createCanonicalExecutableIdentity>[0],
  runtimeEnvironment: CanonicalEnvironmentIdentity,
  createdAt: string,
): Promise<ActionAdapterPreparedData<ShellBasis>> {
  const commandDisplay = payload.command;
  const applicability = await createCanonicalSha256Digest("helarc.shell.applicability.v1", { shell: payload.executablePath, command: payload.command, cwd: payload.cwd, environment: payload.environmentDigest });
  return {
    effectSet: { kind: "effects", values: [
      { kind: "process", operation: "spawn", executable },
      { kind: "file_system", operation: "write", targets: [output.pathIdentity] },
    ] },
    requestedAuthority: null,
    targetAssertions: [
      { kind: "workspace_root_identity", expected: rootIdentityInput(cwd.workspaceRootIdentity) },
      { kind: "canonical_path_identity", expected: cwd.pathIdentity },
      { kind: "file_baseline", path: cwd.pathIdentity, expected: cwd.baseline },
      { kind: "canonical_path_identity", expected: output.pathIdentity },
      { kind: "file_baseline", path: output.pathIdentity, expected: output.baseline },
      { kind: "executable_identity", expected: executable },
    ],
    approval: approval(runtimeEnvironment.environmentId, applicability, description ?? "Execute one native shell command.", [payload.executablePath, ...payload.args], commandDisplay, payload.cwd, payload.cwdDisplay, "Spawn one native shell process", createdAt),
    safeSummary: { kind: "process", headline: payload.runInBackground ? "Start background shell task" : "Run shell command", commandDisplay, cwdDisplay: payload.cwdDisplay },
    preparedInvocation: { contractVersion: "2", executorId: SHELL_EXECUTOR.id, executorVersion: SHELL_EXECUTOR.version, payload: payload as unknown as SerializableValue },
    replayBasis: "none", semanticBasis: {
      shell,
      command: payload.command,
      commandDisplay,
      cwdDisplay: payload.cwdDisplay,
    },
    deadlineAt: new Date(Date.parse(createdAt) + payload.timeoutMs).toISOString(),
  };
}

function createShellExecutor(
  environment: CommandEnvironmentPolicySnapshot,
  tasks: RunProcessTaskRegistry,
  session: ShellExecutionSession,
  now: () => string,
  nowMs: () => number,
): ActionExecutor {
  const executor: ActionExecutor = {
    descriptor: SHELL_EXECUTOR,
    validatePayload(candidate): candidate is unknown { return isRecord(candidate); },
    async execute(invocation, context) {
      assertActionExecutorDispatchContext(context);
      const startedAt = now();
      const startedMs = nowMs();
      let dispatched = false;
      let cwdControlPath: string | null = null;
      try {
        const payload = readShellPayload(invocation);
        cwdControlPath = payload.cwdControlPath;
        if (context.interruption.signal.aborted) return interrupted("none", "shell_interrupted_before_dispatch");
        if (payload.environmentPolicyId !== environment.id || payload.environmentDigest !== environment.digest) return failed("none", "shell_environment_changed", "Shell environment changed before dispatch.");
        const executable = await revalidateCommandExecutable({ originalCommand: payload.executableCommand, expectedPath: payload.executablePath, cwd: payload.cwd, platform: payload.runtimeEnvironmentPlatform });
        if (!sameFileBaseline(executable.identity.baseline, payload.executableBaseline)) return failed("none", "shell_executable_changed", "Shell executable changed before dispatch.");
        dispatched = true;
        if (payload.runInBackground) {
          const task = await tasks.start({
            runId: payload.runId, actionId: context.attempt.action.id, environmentId: payload.runtimeEnvironmentId,
            executable: payload.executablePath, args: payload.args, cwd: payload.cwd, environment: environment.environment,
            timeoutMs: payload.timeoutMs, interruption: context.interruption, termination: payload.termination,
            outputAbsolutePath: payload.outputAbsolutePath, outputRelativePath: payload.outputPath,
            maximumOutputBytes: payload.maxOutputFileBytes,
          });
          return completed({ mode: "background", task_id: task.taskId, status: "running", output_file: task.outputFile }, startedAt, now());
        }
        await removeCwdControlFile(cwdControlPath);
        const outcome = await executeProcess({
          command: payload.executablePath, args: payload.args, cwd: payload.cwd,
          environment: environment.environment, replaceEnvironment: true, timeoutMs: payload.timeoutMs,
          maxStdoutBytes: payload.maxStdoutBytes, maxStderrBytes: payload.maxStderrBytes,
          outputFile: { absolutePath: payload.outputAbsolutePath, relativePath: payload.outputPath, maximumBytes: payload.maxOutputFileBytes },
          interruption: context.interruption, termination: payload.termination, startedMs, nowMs,
        });
        const finalWorkingDirectory = await consumeFinalWorkingDirectory(
          cwdControlPath,
        );
        cwdControlPath = null;
        const committed = finalWorkingDirectory === null
          ? null
          : await session.commitFinalWorkingDirectory({
              expectedRevision: payload.sessionRevision,
              path: finalWorkingDirectory,
            });
        return processOutcome(outcome, startedAt, now(), committed);
      } catch (error) {
        await removeCwdControlFile(cwdControlPath);
        return failed(dispatched ? "unknown" : "none", error instanceof ProcessTaskRegistryError ? error.code : dispatched ? "shell_settlement_unknown" : "shell_execution_failed", safeMessage(error, "Shell execution failed."));
      }
    },
  };
  return Object.freeze(executor);
}

function createTaskStopAdapter(tasks: RunProcessTaskRegistry): OperationActionAdapter<unknown, StopBasis> {
  const adapter: OperationActionAdapter<unknown, StopBasis> = {
    descriptor: STOP_ADAPTER,
    async prepare(binding, context) {
      if (context.interruption.signal.aborted) return interruptedPreparation("task_stop_interrupted");
      try {
        const taskId = parseTaskId(binding.request);
        const task = tasks.get(taskId);
        if (task === null) return invalidPreparation("process_task_not_found", "Background task does not exist.");
        if (task.runId !== context.parentRunAction?.run.id) return invalidPreparation("process_task_foreign_run", "Background task belongs to another Run.");
        if (task.status !== "running") return invalidPreparation("process_task_not_active", "Background task is no longer active.");
        const data: ActionAdapterPreparedData<StopBasis> = {
          effectSet: { kind: "effects", values: [{ kind: "process", operation: "signal", target: task.process }] },
          requestedAuthority: null, targetAssertions: [],
          approval: approval(task.process.environmentId, task.process.startFingerprint, "Stop one background shell task.", ["TaskStop", task.taskId], `TaskStop ${task.taskId}`, task.outputFile, task.outputFile, "Signal one exact background process", context.now()),
          safeSummary: { kind: "process", headline: "Stop background shell task", commandDisplay: `TaskStop ${task.taskId}`, cwdDisplay: task.outputFile },
          preparedInvocation: { contractVersion: "1", executorId: STOP_EXECUTOR.id, executorVersion: STOP_EXECUTOR.version, payload: { identity: task.process } as unknown as SerializableValue },
          replayBasis: "none", semanticBasis: { taskId, cwdDisplay: task.outputFile },
        };
        return Object.freeze({ status: "prepared" as const, prepared: await createPreparedAction(binding, context, data) });
      } catch (error) { return invalidPreparation("task_stop_invalid", safeMessage(error, "TaskStop input is invalid.")); }
    },
    async revalidate(prepared, _assertions, context) {
      if (context.interruption.signal.aborted) return interruptedRevalidation("task_stop_interrupted");
      const payload = readStopPayload(prepared.invocation);
      return tasks.isExactActive(payload.identity)
        ? Object.freeze({ status: "valid" as const, recordId: `revalidation:${context.action.id}:${context.subjectRevision}` })
        : invalidated("process_task_stale");
    },
    async settle(prepared, settlement) { return settleStop(prepared, settlement); },
  };
  return Object.freeze(adapter);
}

function createTaskStopExecutor(tasks: RunProcessTaskRegistry, now: () => string): ActionExecutor {
  const executor: ActionExecutor = {
    descriptor: STOP_EXECUTOR,
    validatePayload(candidate): candidate is unknown { return isRecord(candidate); },
    async execute(invocation, context) {
      assertActionExecutorDispatchContext(context);
      const startedAt = now();
      try {
        if (context.interruption.signal.aborted) return interrupted("none", "task_stop_interrupted_before_dispatch");
        const payload = readStopPayload(invocation);
        const result = await tasks.stop(payload.identity);
        if (result.status === "unknown") return failed("unknown", "task_stop_unknown_effect", "Process termination could not be confirmed.");
        return completed({ task_id: result.taskId, status: "stopped", signal: result.signal, effect_certainty: "known_applied" }, startedAt, now());
      } catch (error) {
        return failed("none", error instanceof ProcessTaskRegistryError ? error.code : "task_stop_failed", safeMessage(error, "Background task could not be stopped."));
      }
    },
  };
  return Object.freeze(executor);
}

function processOutcome(
  outcome: ProcessExecutionOutcome,
  startedAt: string,
  finishedAt: string,
  session: ShellExecutionSessionSnapshot | null,
): PhysicalAttemptOutcome<unknown> {
  if (outcome.kind === "cancelled_before_start") return interrupted("none", "shell_interrupted_before_dispatch");
  if (outcome.kind === "failed") return failed(outcome.effectState, "shell_process_failed", "Shell process failed.");
  if (outcome.kind === "timeout") return outcome.terminationConfirmed
    ? Object.freeze({ status: "timed_out" as const, effectState: "settled" as const, evidence: evidence("shell_timeout", "Shell command exceeded its timeout.") })
    : failed("unknown", "shell_timeout_termination_unconfirmed", "Shell termination could not be confirmed.");
  if (outcome.kind === "cancellation_unconfirmed") return interrupted("unknown", "shell_cancellation_unconfirmed");
  if (outcome.kind === "cancelled") return interrupted("settled", "shell_cancelled");
  return completed(foregroundOutput(outcome, session), startedAt, finishedAt);
}

function foregroundOutput(
  output: CapturedProcessOutput & { readonly exitCode: number | null; readonly signal: string | null },
  session: ShellExecutionSessionSnapshot | null,
) {
  return Object.freeze({
    mode: "foreground" as const, exit_code: output.exitCode, signal: output.signal, duration_ms: output.durationMs,
    stdout: shellStreamOutput(
      output.stdout,
      output.stdoutTruncated,
      output.stdoutTruncated ? output.outputFile : null,
    ),
    stderr: shellStreamOutput(
      output.stderr,
      output.stderrTruncated,
      output.stderrTruncated ? output.outputFile : null,
    ),
    final_working_directory: session?.canonicalPath ?? null,
    shell_session_revision: session?.revision ?? null,
  });
}

function shellStreamOutput(
  projection: ProcessTextProjection,
  truncated: boolean,
  overflowFile: string | null,
): ForegroundShellStream {
  return Object.freeze({
    text: projection.text,
    encoding: projection.encoding,
    encoding_source: projection.encodingSource,
    integrity: projection.integrity,
    replacement_count: projection.replacementCount,
    truncated,
    overflow_file: overflowFile,
  });
}

function settleShell(prepared: PreparedAction<ShellBasis>, settlement: CanonicalActionSettlement): ActionSemanticResult {
  const physical = settleOperation(settlement, "shell");
  if (physical.status !== "succeeded") return physical;
  if (!isRecord(physical.output)) {
    return semanticFailure(
      settlement,
      "shell_result_invalid",
      "The completed shell action did not provide a valid result.",
    );
  }
  if (physical.output.mode === "background") return physical;
  if (!isForegroundShellOutput(physical.output)) {
    return semanticFailure(
      settlement,
      "shell_result_invalid",
      "The completed shell action did not provide a valid foreground result.",
    );
  }

  const outcome = interpretShellCommandOutcome({
    shell: prepared.semanticBasis.shell,
    command: prepared.semanticBasis.command,
    exitCode: physical.output.exit_code,
    signal: physical.output.signal,
    stdout: processTextProjection(physical.output.stdout),
    stderr: processTextProjection(physical.output.stderr),
  });
  if (outcome.status === "failed") {
    return semanticFailure(settlement, outcome.code, outcome.message);
  }
  return Object.freeze({
    ...physical,
    output: Object.freeze({
      ...physical.output,
      exit_interpretation: outcome.interpretation,
    }),
  });
}
function settleStop(_prepared: PreparedAction<StopBasis>, settlement: CanonicalActionSettlement): ActionSemanticResult {
  return settleOperation(settlement, "task_stop");
}
function settleOperation(settlement: CanonicalActionSettlement, owner: string): ActionSemanticResult {
  const succeeded = settlement.status === "succeeded";
  const payload = isPhysicalPayload(settlement.payload) ? settlement.payload : null;
  return Object.freeze({
    operationInvocationId: settlement.operationInvocation.id,
    settlement, status: settlement.status === "invalidated" ? "invalid" : settlement.status,
    output: succeeded ? payload?.value ?? null : null,
    failure: succeeded ? null : {
      owner: settlement.causeOwner ?? "helarc.local-environment",
      code: settlement.causeRef ?? `${owner}_${settlement.status}`,
      message: settlement.causeRef ?? `${owner} operation ${settlement.status}.`,
    },
  });
}

function semanticFailure(
  settlement: CanonicalActionSettlement,
  code: string,
  message: string,
): ActionSemanticResult {
  return Object.freeze({
    operationInvocationId: settlement.operationInvocation.id,
    settlement,
    status: "failed" as const,
    output: null,
    failure: Object.freeze({
      owner: "helarc.local-environment",
      code,
      message,
    }),
  });
}

interface ForegroundShellStream {
  readonly text: string;
  readonly encoding: string | null;
  readonly encoding_source: ProcessTextEncodingSource;
  readonly integrity: ProcessTextIntegrity;
  readonly replacement_count: number;
  readonly truncated: boolean;
  readonly overflow_file: string | null;
}

function isForegroundShellOutput(value: Record<string, any>): value is Record<string, any> & {
  readonly mode: "foreground";
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: ForegroundShellStream;
  readonly stderr: ForegroundShellStream;
} {
  return value.mode === "foreground" &&
    (value.exit_code === null || Number.isSafeInteger(value.exit_code)) &&
    (value.signal === null || typeof value.signal === "string") &&
    isForegroundShellStream(value.stdout) &&
    isForegroundShellStream(value.stderr);
}

function isForegroundShellStream(value: unknown): value is ForegroundShellStream {
  if (!isRecord(value)) return false;
  return typeof value.text === "string" &&
    (value.encoding === null || typeof value.encoding === "string") &&
    isEncodingSource(value.encoding_source) &&
    isTextIntegrity(value.integrity) &&
    Number.isSafeInteger(value.replacement_count) &&
    value.replacement_count >= 0 &&
    typeof value.truncated === "boolean" &&
    (value.overflow_file === null || typeof value.overflow_file === "string");
}

function processTextProjection(
  value: ForegroundShellStream,
): ProcessTextProjection & { readonly truncated: boolean } {
  return Object.freeze({
    text: value.text,
    encoding: value.encoding,
    encodingSource: value.encoding_source,
    integrity: value.integrity,
    replacementCount: value.replacement_count,
    truncated: value.truncated,
  });
}

function pathAssertions(assertions: readonly TargetStateAssertion[], path: string) {
  const canonical = assertions.find((candidate): candidate is Extract<TargetStateAssertion, { kind: "canonical_path_identity" }> => candidate.kind === "canonical_path_identity" && pathMatches(candidate.expected, path));
  const baseline = assertions.find((candidate): candidate is Extract<TargetStateAssertion, { kind: "file_baseline" }> => candidate.kind === "file_baseline" && pathMatches(candidate.path, path));
  const root = assertions.find((candidate): candidate is Extract<TargetStateAssertion, { kind: "workspace_root_identity" }> => candidate.kind === "workspace_root_identity" && canonical?.expected.workspaceRootId === candidate.expected.rootId);
  return canonical === undefined || baseline === undefined || root === undefined ? null : { path: canonical, baseline, root };
}

function pathMatches(identity: { readonly canonicalPath: string; readonly resolvedPath: string | null }, path: string): boolean {
  return samePath(identity.canonicalPath, path) ||
    identity.resolvedPath !== null && samePath(identity.resolvedPath, path);
}

async function inspectTarget(payload: ShellPayload, assertions: NonNullable<ReturnType<typeof pathAssertions>>, operation: "directory" | "write", target: string, expected: FileBaseline) {
  return inspectPreparedFileSystemTarget({
    platform: payload.runtimeEnvironmentPlatform, operation, expectedBaseline: expected,
    workspaceRootIdentity: assertions.root.expected, workspaceRoot: payload.workspaceRoot,
    canonicalRoot: payload.canonicalRoot, canonicalTarget: target, path: assertions.path.expected.canonicalPath,
  });
}

function readShellPayload(invocation: PreparedActionInvocation): ShellPayload {
  if (invocation.executorId !== SHELL_EXECUTOR.id || !isRecord(invocation.payload)) throw new TypeError("Prepared shell invocation is invalid.");
  const value = invocation.payload as Record<string, any>;
  if (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string") || !isBaseline(value.executableBaseline) || !isBaseline(value.cwdBaseline) || !isBaseline(value.outputBaseline) || !isRecord(value.termination)) throw new TypeError("Prepared shell payload is invalid.");
  return Object.freeze({
    runId: text(value.runId), executableCommand: text(value.executableCommand),
    executablePath: text(value.executablePath), executableBaseline: value.executableBaseline,
    args: Object.freeze([...(value.args as string[])]), command: text(value.command),
    cwdControlPath: nullableText(value.cwdControlPath), sessionRevision: nonNegativeInteger(value.sessionRevision),
    rootName: text(value.rootName),
    workspaceId: text(value.workspaceId), workspaceRoot: text(value.workspaceRoot), canonicalRoot: text(value.canonicalRoot),
    cwdPath: text(value.cwdPath), cwd: text(value.cwd), cwdDisplay: text(value.cwdDisplay), cwdBaseline: value.cwdBaseline,
    outputPath: text(value.outputPath), outputAbsolutePath: text(value.outputAbsolutePath), outputBaseline: value.outputBaseline,
    timeoutMs: integer(value.timeoutMs), runInBackground: boolean(value.runInBackground), maxStdoutBytes: integer(value.maxStdoutBytes),
    maxStderrBytes: integer(value.maxStderrBytes), maxOutputFileBytes: integer(value.maxOutputFileBytes),
    environmentPolicyId: text(value.environmentPolicyId), environmentDigest: text(value.environmentDigest),
    runtimeEnvironmentId: text(value.runtimeEnvironmentId), runtimeEnvironmentPlatform: platform(value.runtimeEnvironmentPlatform),
    runtimeEnvironmentFingerprint: text(value.runtimeEnvironmentFingerprint),
    termination: Object.freeze({ gracePeriodMs: integer(value.termination.gracePeriodMs), forceKillTimeoutMs: integer(value.termination.forceKillTimeoutMs) }),
  });
}

function readStopPayload(invocation: PreparedActionInvocation): StopPayload {
  const payload = invocation.payload as unknown;
  if (invocation.executorId !== STOP_EXECUTOR.id || !isRecord(payload) || !isRecord(payload.identity)) throw new TypeError("Prepared TaskStop invocation is invalid.");
  const value = payload.identity as Record<string, any>;
  return Object.freeze({ identity: Object.freeze({ runId: text(value.runId), taskId: text(value.taskId), processId: integer(value.processId), environmentId: text(value.environmentId), startFingerprint: text(value.startFingerprint) }) });
}

function parseTaskId(input: unknown): string {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "task_id")) throw new TypeError("TaskStop input must contain only task_id.");
  return text(input.task_id);
}

function approval(environmentId: string, applicability: string, reason: string, command: readonly string[], safeCommandDisplay: string, cwd: string, cwdDisplay: string, summary: string, createdAt: string) {
  return {
    category: "commandExecution" as const, environmentId,
    applicabilityKeys: [{ category: "commandExecution" as const, value: applicability }], reason,
    payload: { command, safeCommandDisplay, cwd, cwdDisplay, environmentId, commandActions: [{ kind: "process" as const, summary }], additionalPermissions: null },
    decisionOptions: actionDecisionOptions(), trustedProposals: [],
    deadlineAt: new Date(Date.parse(createdAt) + 120_000).toISOString(), metadata: {},
  };
}

function actionDecisionOptions() {
  return [{ id: "accept-action", kind: "accept" as const, scope: "action" as const, label: "Allow", description: null, trustedProposalRef: null, metadata: {} },
    { id: "decline-action", kind: "decline" as const, scope: null, label: "Deny", description: null, trustedProposalRef: null, metadata: {} }] as const;
}
function completed(value: unknown, startedAt: string, finishedAt: string) { return Object.freeze({ status: "completed" as const, effectState: "settled" as const, payload: Object.freeze({ value, startedAt, finishedAt }) }); }
function failed(effectState: "none" | "settled" | "unknown", code: string, message: string) { return Object.freeze({ status: "failed" as const, effectState, failure: { ...evidence(code, message), retryable: false } }); }
function interrupted(effectState: "none" | "settled" | "unknown", code: string) { return Object.freeze({ status: "interrupted" as const, effectState, evidence: evidence(code, "Process execution was interrupted.") }); }
function evidence(code: string, message: string) { return Object.freeze({ code, message, metadata: Object.freeze({}) }); }
function invalidPreparation(code: string, message: string) { return Object.freeze({ status: "invalid" as const, owner: "helarc.local-environment", code, message }); }
function interruptedPreparation(code: string) { return Object.freeze({ status: "interrupted" as const, owner: "helarc.local-environment", code, message: "Action preparation was interrupted." }); }
function invalidated(code: string): ActionRevalidationResult { return Object.freeze({ status: "invalidated" as const, owner: "helarc.local-environment", code, recordId: `revalidation:${code}` }); }
function interruptedRevalidation(code: string): ActionRevalidationResult { return Object.freeze({ status: "interrupted" as const, owner: "helarc.local-environment", code, recordId: `revalidation:${code}` }); }
function isPhysicalPayload(value: unknown): value is { readonly value: unknown; readonly startedAt: string; readonly finishedAt: string } { return isRecord(value) && Object.hasOwn(value, "value") && typeof value.startedAt === "string" && typeof value.finishedAt === "string"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isBaseline(value: unknown): value is FileBaseline { return isRecord(value) && (value.kind === "absent" || value.kind === "present"); }
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw new TypeError("Prepared text is invalid."); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError("Prepared integer is invalid."); return value as number; }
function nonNegativeInteger(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Prepared non-negative integer is invalid."); return value as number; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new TypeError("Prepared boolean is invalid."); return value; }
function nullableText(value: unknown): string | null { if (value === null) return null; return text(value); }
function platform(value: unknown): "win32" | "posix" { if (value !== "win32" && value !== "posix") throw new TypeError("Prepared platform is invalid."); return value; }
function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase()
    : left === right;
}
function safeMessage(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function digestToken(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
export function commandWithFinalWorkingDirectory(
  shell: "Bash" | "PowerShell",
  command: string,
  controlPath: string | null,
): string {
  if (shell === "PowerShell") {
    const utf8 = "$__helarc_utf8 = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $__helarc_utf8; [Console]::OutputEncoding = $__helarc_utf8; $OutputEncoding = $__helarc_utf8";
    const capture = controlPath === null
      ? ""
      : `; (Get-Location).ProviderPath | Out-File -LiteralPath '${powerShellLiteral(controlPath)}' -Encoding utf8 -NoNewline`;
    return `${utf8}; & { ${command} }; $__helarc_exit = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }${capture}; exit $__helarc_exit`;
  }
  const capture = controlPath === null
    ? ""
    : `; printf '%s' "$PWD" > '${bashLiteral(controlPath)}'`;
  return `{ ${command}; }; __helarc_exit=$?${capture}; exit "$__helarc_exit"`;
}

export async function consumeFinalWorkingDirectory(
  controlPath: string | null,
): Promise<string | null> {
  if (controlPath === null) return null;
  try {
    const handle = await open(controlPath, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size < 1 || stats.size > MAX_CWD_CONTROL_BYTES) {
        return null;
      }
      const bytes = Buffer.alloc(stats.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) return null;
      const value = STRICT_UTF8.decode(bytes).trim();
      return value.length === 0 ? null : value;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  } finally {
    await removeCwdControlFile(controlPath);
  }
}

async function removeCwdControlFile(controlPath: string | null): Promise<void> {
  if (controlPath === null) return;
  await rm(controlPath, { force: true }).catch(() => undefined);
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function bashLiteral(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function isEncodingSource(value: unknown): value is ProcessTextEncodingSource {
  return value === "utf8" || value === "bom" || value === "detected" ||
    value === "fallback" || value === "none";
}

function isTextIntegrity(value: unknown): value is ProcessTextIntegrity {
  return value === "exact" || value === "inferred" || value === "lossy" ||
    value === "unavailable";
}
function rootIdentityInput(root: CanonicalWorkspaceRootIdentity) {
  if (root.resolvedPath === null) throw new TypeError("Canonical Workspace root requires a resolved path.");
  return { rootId: root.rootId, platform: root.platform, path: root.canonicalPath, resolvedPath: root.resolvedPath, resolutionFingerprint: root.resolutionFingerprint };
}
function resolveTermination(input: Partial<ProcessTerminationLimits> | undefined): ProcessTerminationLimits {
  const value = { ...DEFAULT_TERMINATION, ...input };
  if (!Number.isSafeInteger(value.gracePeriodMs) || value.gracePeriodMs < 1 || !Number.isSafeInteger(value.forceKillTimeoutMs) || value.forceKillTimeoutMs < 1) throw new TypeError("Process termination limits must be positive integers.");
  return Object.freeze(value);
}
