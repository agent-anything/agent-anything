import { basename } from "node:path";
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
  type ActionExecutorContext,
  type PhysicalAttemptOutcome,
} from "@agent-anything/action-execution/execution";
import {
  createActionRegistrationSnapshot,
  type ActionRegistrationSnapshot,
} from "@agent-anything/canonical-action/registration";
import {
  canonicalPathIdentityKey,
  createCanonicalExecutableIdentity,
  createCanonicalPathIdentity,
  createCanonicalSha256Digest,
  type CanonicalEnvironmentIdentity,
  type CanonicalWorkspaceRootIdentity,
  type FileBaseline,
  type PreparedActionInvocation,
  type SerializableValue,
  type TargetStateAssertion,
} from "@agent-anything/canonical-action/subject";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { parseCommandInput } from "./CommandInput.js";
import { resolveCommandLimits } from "./CommandLimits.js";
import {
  createCommandEnvironmentPolicy,
  resolveCommandExecutable,
  revalidateCommandExecutable,
  type CommandEnvironmentPolicySnapshot,
} from "./CommandActionIdentity.js";
import {
  executeProcess,
  type CapturedProcessOutput,
  type ProcessExecutionOutcome,
} from "./ProcessExecutor.js";
import type {
  CodeAgentCommandLimits,
  ProcessTerminationLimits,
} from "./ProcessContracts.js";
import {
  inspectPreparedFileSystemTarget,
  prepareFileSystemTarget,
  sameCanonicalPathIdentity,
  sameFileBaseline,
} from "../filesystem/FileSystemTarget.js";

export const HELARC_LOCAL_COMMAND_ACTION_ADAPTER_ID =
  "helarc.local.command.adapter";

const ADAPTER_DESCRIPTOR = Object.freeze({
  id: HELARC_LOCAL_COMMAND_ACTION_ADAPTER_ID,
  version: "1",
  requestSchemaRevision: "1",
});

const EXECUTOR_DESCRIPTOR = Object.freeze({
  id: "helarc.local.command.executor",
  version: "1",
  invocationContractVersion: "1",
  physicalPayloadSchemaRevision: "1",
});

const DEFAULT_TERMINATION: ProcessTerminationLimits = Object.freeze({
  gracePeriodMs: 500,
  forceKillTimeoutMs: 2_000,
});

export interface CreateHelarcLocalCommandActionCapabilityInput {
  readonly workspace: WorkspaceSelection | null;
  readonly operation: OperationRevisionRef;
  readonly binding: OperationBindingRevisionRef;
  readonly limits?: Partial<CodeAgentCommandLimits>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly environmentPolicyId?: string;
  readonly termination?: Partial<ProcessTerminationLimits>;
  readonly now?: () => string;
  readonly nowMs?: () => number;
}

export interface HelarcLocalCommandActionCapability {
  readonly actionAdapterId: string;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

interface LocalCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly rootName?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly reason: string;
}

interface LocalCommandOutput {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly settlementConfirmed: boolean;
}

export async function createHelarcLocalCommandActionCapability(
  input: CreateHelarcLocalCommandActionCapabilityInput,
): Promise<HelarcLocalCommandActionCapability> {
  const limits = resolveCommandLimits(input.limits);
  const termination = resolveTermination(input.termination);
  const environment = await createCommandEnvironmentPolicy({
    id: input.environmentPolicyId ?? "helarc.local.command.environment.default",
    overrides: input.environment,
  });
  const registrations = createActionRegistrationSnapshot([{
    registrationId: "helarc.local.command.registration.v1",
    revision: "1",
    operation: input.operation,
    binding: input.binding,
    adapter: ADAPTER_DESCRIPTOR,
    executor: EXECUTOR_DESCRIPTOR,
    effectFamilies: ["process"],
    sandboxRequirementRevision: "helarc.local.command.sandbox.v1",
    maxInvocationBytes: 256_000,
    maxPhysicalResultBytes: 2_000_000,
  }]);
  const adapter = createCommandAdapter(
    input.workspace,
    limits,
    termination,
    environment,
  );
  return Object.freeze({
    actionAdapterId: HELARC_LOCAL_COMMAND_ACTION_ADAPTER_ID,
    registrations,
    adapters: Object.freeze([Object.freeze({ adapter })]),
    executors: Object.freeze([createCommandExecutor(
      environment,
      input.now ?? (() => new Date().toISOString()),
      input.nowMs ?? (() => Date.now()),
    )]),
  });
}

function createCommandAdapter(
  workspace: WorkspaceSelection | null,
  limits: CodeAgentCommandLimits,
  termination: ProcessTerminationLimits,
  environment: CommandEnvironmentPolicySnapshot,
): OperationActionAdapter<LocalCommandRequest, CommandSemanticBasis> {
  const adapter: OperationActionAdapter<LocalCommandRequest, CommandSemanticBasis> = {
    descriptor: ADAPTER_DESCRIPTOR,
    async prepare(binding, context) {
      if (context.interruption.signal.aborted) return preparationInterrupted();
      try {
        assertCommandRequest(binding.request);
        const parsed = parseCommandInput(binding.request, limits);
        if (context.workspace === null) {
          return preparationInvalid("workspace_required", "Command execution requires a Run workspace.");
        }
        const cwd = await prepareFileSystemTarget({
          workspace,
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
        if (context.interruption.signal.aborted) return preparationInterrupted();
        const data = await createPreparedData({
          parsed,
          cwd,
          executable,
          environment,
          termination,
          runtimeEnvironment: context.environment,
          limits,
          now: context.now,
        });
        return Object.freeze({
          status: "prepared" as const,
          prepared: await createPreparedAction(binding, context, data),
        });
      } catch (error) {
        return preparationInvalid(
          "command_action_invalid",
          safeMessage(error, "Command Action input or target is invalid."),
        );
      }
    },
    async revalidate(prepared, assertions, context) {
      if (context.interruption.signal.aborted) return revalidationInterrupted();
      try {
        const payload = readPayload(prepared.invocation);
        const root = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "workspace_root_identity" }> =>
            candidate.kind === "workspace_root_identity" &&
            candidate.expected.rootId === payload.workspaceId,
        );
        const cwdPath = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "canonical_path_identity" }> =>
            candidate.kind === "canonical_path_identity" &&
            samePath(candidate.expected.canonicalPath, payload.cwdPath),
        );
        const cwdBaseline = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "file_baseline" }> =>
            candidate.kind === "file_baseline" &&
            samePath(candidate.path.canonicalPath, payload.cwdPath),
        );
        const executable = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "executable_identity" }> =>
            candidate.kind === "executable_identity",
        );
        if (root === undefined || cwdPath === undefined || cwdBaseline === undefined || executable === undefined) {
          return invalidated("command_assertion_missing");
        }
        const actualCwd = await inspectPreparedFileSystemTarget({
          platform: context.environment.platform,
          operation: "list",
          workspaceRootIdentity: root.expected,
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
        const actualExecutableIdentity = createCanonicalExecutableIdentity(
          actualExecutable.identity,
        );
        if (
          !sameCanonicalPathIdentity(actualCwd.pathIdentity, cwdPath.expected) ||
          !sameFileBaseline(actualCwd.baseline, cwdBaseline.expected) ||
          !sameFileBaseline(actualCwd.baseline, payload.cwdBaseline) ||
          canonicalPathIdentityKey(actualExecutableIdentity.path) !==
            canonicalPathIdentityKey(executable.expected.path) ||
          !sameFileBaseline(
            actualExecutableIdentity.baseline,
            executable.expected.baseline,
          ) ||
          payload.environmentPolicyId !== environment.id ||
          payload.environmentDigest !== environment.digest ||
          payload.runtimeEnvironmentId !== context.environment.environmentId ||
          payload.runtimeEnvironmentPlatform !== context.environment.platform ||
          payload.runtimeEnvironmentFingerprint !== context.environment.configurationFingerprint
        ) return invalidated("command_target_changed");
        return Object.freeze({
          status: "valid" as const,
          recordId: `revalidation:${context.action.id}:${context.subjectRevision}`,
        });
      } catch {
        return invalidated("command_target_changed");
      }
    },
    async settle(prepared, settlement) {
      return settleCommand(prepared, settlement);
    },
  };
  return Object.freeze(adapter);
}

interface PreparedCommandPayload {
  readonly executablePath: string;
  readonly executableBaseline: FileBaseline;
  readonly displayCommand: string;
  readonly args: readonly string[];
  readonly rootName: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly cwdPath: string;
  readonly cwd: string;
  readonly cwdDisplay: string;
  readonly cwdBaseline: FileBaseline;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly environmentPolicyId: string;
  readonly environmentDigest: string;
  readonly runtimeEnvironmentId: string;
  readonly runtimeEnvironmentPlatform: "win32" | "posix";
  readonly runtimeEnvironmentFingerprint: string;
  readonly termination: ProcessTerminationLimits;
}

interface CommandSemanticBasis {
  readonly commandDisplay: string;
  readonly cwdDisplay: string;
}

async function createPreparedData(input: {
  readonly parsed: ReturnType<typeof parseCommandInput>;
  readonly cwd: Awaited<ReturnType<typeof prepareFileSystemTarget>>;
  readonly executable: Awaited<ReturnType<typeof resolveCommandExecutable>>;
  readonly environment: CommandEnvironmentPolicySnapshot;
  readonly termination: ProcessTerminationLimits;
  readonly runtimeEnvironment: CanonicalEnvironmentIdentity;
  readonly limits: CodeAgentCommandLimits;
  readonly now: () => string;
}): Promise<ActionAdapterPreparedData<CommandSemanticBasis>> {
  const executable = createCanonicalExecutableIdentity(input.executable.identity);
  const cwd = createCanonicalPathIdentity(input.cwd.pathIdentity);
  const cwdDisplay = `${input.cwd.rootName}:${input.cwd.relativePath}`;
  const commandDisplay = `${basename(executable.path.canonicalPath)} (${input.parsed.args.length} args)`;
  const payload: PreparedCommandPayload = {
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
    cwdDisplay,
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
  const applicability = await createCanonicalSha256Digest(
    "helarc.command.applicability.v1",
    { executable: executable.path.canonicalPath, args: input.parsed.args, cwd: cwd.canonicalPath, environment: input.environment.digest },
  );
  const createdAt = input.now();
  return {
    effectSet: {
      kind: "effects",
      values: [{ kind: "process", operation: "spawn", executable: input.executable.identity }],
    },
    requestedAuthority: null,
    targetAssertions: [
      { kind: "workspace_root_identity", expected: rootIdentityInput(input.cwd.workspaceRootIdentity) },
      { kind: "canonical_path_identity", expected: input.cwd.pathIdentity },
      { kind: "file_baseline", path: input.cwd.pathIdentity, expected: input.cwd.baseline },
      { kind: "executable_identity", expected: input.executable.identity },
    ],
    approval: {
      category: "commandExecution",
      environmentId: input.runtimeEnvironment.environmentId,
      applicabilityKeys: [{ category: "commandExecution", value: applicability }],
      reason: input.parsed.reason,
      payload: {
        command: [executable.path.canonicalPath, ...input.parsed.args],
        safeCommandDisplay: commandDisplay,
        cwd: cwd.canonicalPath,
        cwdDisplay,
        environmentId: input.runtimeEnvironment.environmentId,
        commandActions: [{ kind: "process", summary: "Spawn one process" }],
        additionalPermissions: null,
      },
      decisionOptions: actionDecisionOptions(),
      trustedProposals: [],
      deadlineAt: new Date(Date.parse(createdAt) + 120_000).toISOString(),
      metadata: {},
    },
    safeSummary: {
      kind: "process",
      headline: "Run workspace command",
      commandDisplay,
      cwdDisplay,
    },
    preparedInvocation: {
      contractVersion: EXECUTOR_DESCRIPTOR.invocationContractVersion,
      executorId: EXECUTOR_DESCRIPTOR.id,
      executorVersion: EXECUTOR_DESCRIPTOR.version,
      payload: payload as unknown as SerializableValue,
    },
    replayBasis: "none",
    semanticBasis: { commandDisplay, cwdDisplay },
  };
}

function actionDecisionOptions() {
  return [{
    id: "accept-action",
    kind: "accept" as const,
    scope: "action" as const,
    label: "Allow",
    description: null,
    trustedProposalRef: null,
    metadata: {},
  }, {
    id: "decline-action",
    kind: "decline" as const,
    scope: null,
    label: "Deny",
    description: null,
    trustedProposalRef: null,
    metadata: {},
  }] as const;
}

function createCommandExecutor(
  environment: CommandEnvironmentPolicySnapshot,
  now: () => string,
  nowMs: () => number,
): ActionExecutor<PreparedActionInvocation, unknown> {
  const executor: ActionExecutor<PreparedActionInvocation, unknown> = {
    descriptor: EXECUTOR_DESCRIPTOR,
    validatePayload(candidate: unknown): candidate is unknown {
      return isPhysicalPayload(candidate);
    },
    async execute(invocation, context) {
      assertActionExecutorDispatchContext(context);
      const startedAt = now();
      const startedMs = nowMs();
      let dispatched = false;
      try {
        const payload = readPayload(invocation);
        if (context.interruption.signal.aborted) return interrupted("none", "command_interrupted_before_dispatch");
        if (payload.environmentPolicyId !== environment.id || payload.environmentDigest !== environment.digest) {
          return failed("none", "command_environment_changed", "Command environment changed before dispatch.");
        }
        const executable = await revalidateCommandExecutable({
          originalCommand: payload.displayCommand,
          expectedPath: payload.executablePath,
          cwd: payload.cwd,
          platform: payload.runtimeEnvironmentPlatform,
        });
        if (!sameFileBaseline(executable.identity.baseline, payload.executableBaseline)) {
          return failed("none", "command_executable_changed", "Command executable changed before dispatch.");
        }
        dispatched = true;
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
        return processOutcome(payload, outcome, startedAt, now());
      } catch (error) {
        return failed(
          dispatched ? "unknown" : "none",
          dispatched ? "command_settlement_unknown" : "command_execution_failed",
          safeMessage(error, "Command execution failed."),
        );
      }
    },
  };
  return Object.freeze(executor);
}

function processOutcome(
  payload: PreparedCommandPayload,
  outcome: ProcessExecutionOutcome,
  startedAt: string,
  finishedAt: string,
): PhysicalAttemptOutcome<unknown> {
  if (outcome.kind === "cancelled_before_start") return interrupted("none", "command_interrupted_before_dispatch");
  if (outcome.kind === "failed") return failed(outcome.effectState, "command_process_failed", "Command process failed.");
  if (outcome.kind === "timeout") {
    return outcome.terminationConfirmed
      ? Object.freeze({ status: "timed_out" as const, effectState: "settled" as const, evidence: physicalEvidence("command_timeout", "Command exceeded its timeout.") })
      : failed("unknown", "command_timeout_termination_unconfirmed", "Command termination could not be confirmed.");
  }
  if (outcome.kind === "cancellation_unconfirmed") return interrupted("unknown", "command_cancellation_unconfirmed");
  if (outcome.kind === "cancelled") return interrupted("settled", "command_cancelled");
  return Object.freeze({
    status: "completed" as const,
    effectState: "settled" as const,
    payload: Object.freeze({
      value: commandOutput(payload, outcome),
      startedAt,
      finishedAt,
    }),
  });
}

function commandOutput(
  payload: PreparedCommandPayload,
  output: CapturedProcessOutput & { readonly exitCode: number | null; readonly signal: string | null },
): LocalCommandOutput {
  return Object.freeze({
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    command: payload.executablePath,
    args: Object.freeze([...payload.args]),
    cwd: payload.cwdDisplay,
    exitCode: output.exitCode,
    signal: output.signal,
    stdout: output.stdout,
    stderr: output.stderr,
    durationMs: output.durationMs,
    stdoutTruncated: output.stdoutTruncated,
    stderrTruncated: output.stderrTruncated,
    settlementConfirmed: true,
  });
}

function settleCommand(
  _prepared: PreparedAction<CommandSemanticBasis>,
  settlement: CanonicalActionSettlement,
): ActionSemanticResult<LocalCommandOutput> {
  const succeeded = settlement.status === "succeeded";
  const payload = isPhysicalPayload(settlement.payload) ? settlement.payload : null;
  return Object.freeze({
    operationInvocationId: settlement.operationInvocation.id,
    settlement,
    status: settlement.status === "invalidated" ? "invalid" : settlement.status,
    output: succeeded ? payload?.value as LocalCommandOutput ?? null : null,
    failure: succeeded ? null : {
      owner: settlement.causeOwner ?? "helarc.local-environment",
      code: settlement.causeRef ?? `command_${settlement.status}`,
      message: settlement.causeRef ?? `Command operation ${settlement.status}.`,
    },
  });
}

function readPayload(invocation: PreparedActionInvocation): PreparedCommandPayload {
  if (invocation.executorId !== EXECUTOR_DESCRIPTOR.id || invocation.executorVersion !== EXECUTOR_DESCRIPTOR.version || invocation.contractVersion !== EXECUTOR_DESCRIPTOR.invocationContractVersion || !isRecord(invocation.payload)) throw new TypeError("Prepared command invocation is invalid.");
  const value = invocation.payload;
  if (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === "string") || !isBaseline(value.executableBaseline) || !isBaseline(value.cwdBaseline) || !isRecord(value.termination)) throw new TypeError("Prepared command payload is invalid.");
  const platform = value.runtimeEnvironmentPlatform;
  if (platform !== "win32" && platform !== "posix") throw new TypeError("Prepared command platform is invalid.");
  return Object.freeze({
    executablePath: text(value.executablePath),
    executableBaseline: value.executableBaseline,
    displayCommand: text(value.displayCommand),
    args: Object.freeze([...(value.args as string[])]),
    rootName: text(value.rootName),
    workspaceId: text(value.workspaceId),
    workspaceRoot: text(value.workspaceRoot),
    canonicalRoot: text(value.canonicalRoot),
    cwdPath: text(value.cwdPath),
    cwd: text(value.cwd),
    cwdDisplay: text(value.cwdDisplay),
    cwdBaseline: value.cwdBaseline,
    timeoutMs: integer(value.timeoutMs),
    maxStdoutBytes: integer(value.maxStdoutBytes),
    maxStderrBytes: integer(value.maxStderrBytes),
    environmentPolicyId: text(value.environmentPolicyId),
    environmentDigest: text(value.environmentDigest),
    runtimeEnvironmentId: text(value.runtimeEnvironmentId),
    runtimeEnvironmentPlatform: platform,
    runtimeEnvironmentFingerprint: text(value.runtimeEnvironmentFingerprint),
    termination: Object.freeze({
      gracePeriodMs: integer(value.termination.gracePeriodMs),
      forceKillTimeoutMs: integer(value.termination.forceKillTimeoutMs),
    }),
  });
}

function assertCommandRequest(input: unknown): asserts input is LocalCommandRequest {
  if (!isRecord(input)) throw new TypeError("Command request must be an object.");
  const allowed = new Set(["command", "args", "rootName", "cwd", "timeoutMs", "reason"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Command request contains unsupported fields.");
}

function resolveTermination(input: Partial<ProcessTerminationLimits> | undefined): ProcessTerminationLimits {
  const value = { ...DEFAULT_TERMINATION, ...input };
  if (!Number.isSafeInteger(value.gracePeriodMs) || value.gracePeriodMs < 1 || !Number.isSafeInteger(value.forceKillTimeoutMs) || value.forceKillTimeoutMs < 1) throw new TypeError("Command termination limits must be positive integers.");
  return Object.freeze(value);
}

function rootIdentityInput(root: CanonicalWorkspaceRootIdentity) {
  if (root.resolvedPath === null) throw new TypeError("Canonical workspace root requires a resolved path.");
  return { rootId: root.rootId, platform: root.platform, path: root.canonicalPath, resolvedPath: root.resolvedPath, resolutionFingerprint: root.resolutionFingerprint };
}

function preparationInvalid(code: string, message: string) {
  return Object.freeze({ status: "invalid" as const, owner: "helarc.local-environment", code, message });
}

function preparationInterrupted() {
  return Object.freeze({ status: "interrupted" as const, owner: "helarc.local-environment", code: "command_action_interrupted", message: "Command Action preparation was interrupted." });
}

function invalidated(code: string): ActionRevalidationResult {
  return Object.freeze({ status: "invalidated" as const, owner: "helarc.local-environment", code, recordId: `revalidation:${code}` });
}

function revalidationInterrupted(): ActionRevalidationResult {
  return Object.freeze({ status: "interrupted" as const, owner: "helarc.local-environment", code: "command_action_interrupted", recordId: "revalidation:interrupted" });
}

function failed(effectState: "none" | "settled" | "unknown", code: string, message: string) {
  return Object.freeze({ status: "failed" as const, effectState, failure: { ...physicalEvidence(code, message), retryable: false } });
}

function interrupted(effectState: "none" | "settled" | "unknown", code: string) {
  return Object.freeze({ status: "interrupted" as const, effectState, evidence: physicalEvidence(code, "Command execution was interrupted.") });
}

function physicalEvidence(code: string, message: string) {
  return Object.freeze({ code, message, metadata: Object.freeze({}) });
}

function isPhysicalPayload(value: unknown): value is { readonly value: unknown; readonly startedAt: string; readonly finishedAt: string } {
  return isRecord(value) && Object.hasOwn(value, "value") && typeof value.startedAt === "string" && typeof value.finishedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBaseline(value: unknown): value is FileBaseline {
  return isRecord(value) && (value.kind === "absent" || value.kind === "present");
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Prepared command text is invalid.");
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError("Prepared command integer is invalid.");
  return value as number;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
