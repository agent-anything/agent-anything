import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ActionAdapterImplementation,
  ActionAdapterPreparedData,
  ActionRevalidationResult,
  ActionSemanticResult,
  OperationActionAdapter,
} from "@agent-anything/action-execution/registration";
import { createPreparedAction } from "@agent-anything/action-execution/registration";
import type {
  ActionExecutor,
  ActionExecutorContext,
  PhysicalAttemptOutcome,
} from "@agent-anything/action-execution/execution";
import { assertActionExecutorDispatchContext } from "@agent-anything/action-execution/execution";
import { createActionRegistrationSnapshot } from "@agent-anything/canonical-action/registration";
import type {
  ActionRegistrationInput,
  ActionRegistrationSnapshot,
} from "@agent-anything/canonical-action/registration";
import type {
  CanonicalWorkspaceRootIdentity,
  FileBaseline,
  PreparedActionInvocation,
  SerializableValue,
  TargetStateAssertion,
} from "@agent-anything/canonical-action/subject";
import { createCanonicalSha256Digest } from "@agent-anything/canonical-action/subject";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import {
  CODE_AGENT_CREATE_FILE_TOOL,
  CODE_AGENT_DELETE_FILE_TOOL,
  CODE_AGENT_LIST_FILES_TOOL,
  CODE_AGENT_READ_FILE_TOOL,
  CODE_AGENT_SEARCH_FILES_TOOL,
  CODE_AGENT_UPDATE_FILE_TOOL,
  bindingRefForCodeFileTool,
  operationRefForCodeFileTool,
  type CodeFileActionAdapterIds,
  type CodeFileOperationKind,
  type CodeFileOperationRequest,
  type CodeFileToolName,
} from "@agent-anything/helarc-code-agent/file-operation";
import type {
  CodeAgentFileLimits,
  DeleteFileOutput,
  FileSearchMatch,
  FileWriteOutput,
  ListFilesOutput,
  ReadFileOutput,
  WorkspaceFileEntry,
  WorkspaceFileEntryKind,
} from "@agent-anything/helarc-code-agent/source";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { workspaceRelativePath } from "./FileSystemBoundary.js";
import { FileSystemError } from "./FileSystemError.js";
import { resolveFileSystemLimits } from "./FileSystemLimits.js";
import {
  inspectPreparedFileSystemTarget,
  prepareFileSystemTarget,
  sameCanonicalPathIdentity,
  sameFileBaseline,
  type PreparedFileSystemTarget,
} from "./FileSystemTarget.js";
import { decodeUtf8 } from "./Utf8.js";

const EXECUTOR_DESCRIPTOR = Object.freeze({
  id: "helarc.local.filesystem.executor",
  version: "1",
  invocationContractVersion: "1",
  physicalPayloadSchemaRevision: "1",
});

const SPECS = Object.freeze([
  actionSpec("list", CODE_AGENT_LIST_FILES_TOOL, "read"),
  actionSpec("read", CODE_AGENT_READ_FILE_TOOL, "read"),
  actionSpec("search", CODE_AGENT_SEARCH_FILES_TOOL, "read"),
  actionSpec("create", CODE_AGENT_CREATE_FILE_TOOL, "write"),
  actionSpec("update", CODE_AGENT_UPDATE_FILE_TOOL, "write"),
  actionSpec("delete", CODE_AGENT_DELETE_FILE_TOOL, "write"),
]);

export const HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS: CodeFileActionAdapterIds =
  Object.freeze(Object.fromEntries(
    SPECS.map((spec) => [spec.operation, spec.adapter.id]),
  ) as unknown as Record<CodeFileOperationKind, string>);

export interface CreateHelarcLocalFileActionCapabilityInput {
  readonly workspace: WorkspaceSelection | null;
  readonly limits?: Partial<CodeAgentFileLimits>;
  readonly now?: () => string;
}

export interface HelarcLocalFileActionCapability {
  readonly actionAdapterIds: CodeFileActionAdapterIds;
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly executors: readonly ActionExecutor[];
}

export function createHelarcLocalFileActionCapability(
  input: CreateHelarcLocalFileActionCapabilityInput,
): HelarcLocalFileActionCapability {
  const limits = resolveFileSystemLimits(input.limits);
  const registrations = createActionRegistrationSnapshot(
    SPECS.map(registrationInput),
  );
  return Object.freeze({
    actionAdapterIds: HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS,
    registrations,
    adapters: Object.freeze(SPECS.map((spec) => Object.freeze({
      adapter: createFileAdapter(spec, input.workspace, limits),
    }))),
    executors: Object.freeze([
      createFileExecutor(limits, input.now ?? (() => new Date().toISOString())),
    ]),
  });
}

interface FileActionSpec {
  readonly operation: CodeFileOperationKind;
  readonly toolName: CodeFileToolName;
  readonly permission: "read" | "write";
  readonly adapter: {
    readonly id: string;
    readonly version: "1";
    readonly requestSchemaRevision: "1";
  };
}

function actionSpec(
  operation: CodeFileOperationKind,
  toolName: CodeFileToolName,
  permission: "read" | "write",
): FileActionSpec {
  return Object.freeze({
    operation,
    toolName,
    permission,
    adapter: Object.freeze({
      id: `helarc.local.filesystem.${operation}.adapter`,
      version: "1" as const,
      requestSchemaRevision: "1" as const,
    }),
  });
}

function registrationInput(spec: FileActionSpec): ActionRegistrationInput {
  const operation = operationRefForCodeFileTool(spec.toolName);
  return {
    registrationId: `helarc.local.filesystem.${spec.operation}.registration.v1`,
    revision: "1",
    operation,
    binding: bindingRefForCodeFileTool(spec.toolName),
    adapter: spec.adapter,
    executor: EXECUTOR_DESCRIPTOR,
    effectFamilies: ["filesystem"],
    sandboxRequirementRevision: "helarc.local.filesystem.sandbox.v1",
    maxInvocationBytes: 2_000_000,
    maxPhysicalResultBytes: 2_000_000,
  };
}

function createFileAdapter(
  spec: FileActionSpec,
  workspace: WorkspaceSelection | null,
  limits: CodeAgentFileLimits,
): OperationActionAdapter<CodeFileOperationRequest, PreparedFileBasis> {
  const adapter: OperationActionAdapter<CodeFileOperationRequest, PreparedFileBasis> = {
    descriptor: spec.adapter,
    async prepare(binding, context) {
      const interrupted = interruptionPreparation(context.interruption);
      if (interrupted !== null) return interrupted;
      try {
        const request = parseRequest(spec.operation, binding.request);
        if (
          (request.operation === "create" || request.operation === "update") &&
          Buffer.byteLength(request.content, "utf8") > limits.maxWriteBytes
        ) {
          return preparationFailure("file_write_limit_exceeded", "File content exceeds the configured write limit.");
        }
        if (context.workspace === null) {
          return preparationFailure("workspace_required", "File operations require a Run workspace.");
        }
        const target = await prepareFileSystemTarget({
          workspace,
          workspaceRoots: context.workspace.roots,
          platform: context.environment.platform,
          rootName: request.rootName,
          path: request.path,
          operation: request.operation,
        });
        if (
          "expectedContentDigest" in request &&
          (target.baseline.kind !== "present" ||
            target.baseline.contentDigest !== request.expectedContentDigest)
        ) {
          return preparationFailure("file_baseline_mismatch", "The file no longer matches the requested baseline.");
        }
        const prepared = await createFilePreparedData(
          request,
          target,
          context.environment.environmentId,
          context.now(),
        );
        return Object.freeze({
          status: "prepared" as const,
          prepared: await createPreparedAction(binding, context, prepared),
        });
      } catch (error) {
        return preparationFailure(
          error instanceof FileSystemError ? error.code : "file_action_invalid",
          safeMessage(error, "File Action input or target is invalid."),
        );
      }
    },
    async revalidate(prepared, assertions, context) {
      const interrupted = interruptionRevalidation(context.interruption);
      if (interrupted !== null) return interrupted;
      try {
        const payload = readPayload(prepared.invocation);
        const root = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "workspace_root_identity" }> =>
            candidate.kind === "workspace_root_identity" &&
            candidate.expected.rootId === payload.workspaceId,
        );
        const path = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "canonical_path_identity" }> =>
            candidate.kind === "canonical_path_identity",
        );
        const baseline = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "file_baseline" }> =>
            candidate.kind === "file_baseline",
        );
        if (root === undefined || path === undefined || baseline === undefined) {
          return invalidated("file_assertion_missing");
        }
        const actual = await inspectPreparedFileSystemTarget({
          platform: context.environment.platform,
          operation: payload.operation,
          workspaceRootIdentity: root.expected,
          workspaceRoot: payload.workspaceRoot,
          canonicalRoot: payload.canonicalRoot,
          canonicalTarget: payload.canonicalTarget,
          path: path.expected.canonicalPath,
        });
        if (
          !sameCanonicalPathIdentity(actual.pathIdentity, path.expected) ||
          !sameFileBaseline(actual.baseline, baseline.expected) ||
          !sameFileBaseline(actual.baseline, payload.expectedBaseline)
        ) return invalidated("file_target_changed");
        return Object.freeze({ status: "valid" as const, recordId: `revalidation:${context.action.id}:${context.subjectRevision}` });
      } catch {
        return invalidated("file_target_changed");
      }
    },
    async settle(prepared, settlement) {
      return settleFileOperation(prepared, settlement);
    },
  };
  return Object.freeze(adapter);
}

interface PreparedFilePayload {
  readonly operation: CodeFileOperationKind;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly relativePath: string;
  readonly canonicalTarget: string;
  readonly expectedBaseline: FileBaseline;
  readonly recursive: boolean;
  readonly query: string | null;
  readonly content: string | null;
}

interface PreparedFileBasis {
  readonly operation: CodeFileOperationKind;
  readonly targetLabel: string;
}

async function createFilePreparedData(
  request: CodeFileOperationRequest,
  target: PreparedFileSystemTarget,
  environmentId: string,
  deadlineAt: string,
): Promise<ActionAdapterPreparedData<PreparedFileBasis>> {
  const mutation = request.operation === "create" || request.operation === "update" || request.operation === "delete";
  const payload: PreparedFilePayload = {
    operation: request.operation,
    rootName: target.rootName,
    workspaceId: target.workspaceId,
    workspaceRoot: target.workspaceRoot,
    canonicalRoot: target.canonicalRoot,
    relativePath: target.relativePath,
    canonicalTarget: target.canonicalTarget,
    expectedBaseline: target.baseline,
    recursive: request.operation === "list" ? request.recursive ?? false : false,
    query: request.operation === "search" ? request.query : null,
    content: request.operation === "create" || request.operation === "update" ? request.content : null,
  };
  const targetLabel = `${target.rootName}:${target.relativePath}`;
  const baselineFingerprint = await createCanonicalSha256Digest(
    "helarc.local.filesystem.baseline.v1",
    target.baseline,
  );
  return {
    effectSet: {
      kind: "effects",
      values: [{
        kind: "file_system",
        operation: mutation ? "write" : "read",
        targets: [target.pathIdentity],
      }],
    },
    requestedAuthority: null,
    targetAssertions: [
      { kind: "workspace_root_identity", expected: rootIdentityInput(target.workspaceRootIdentity) },
      { kind: "canonical_path_identity", expected: target.pathIdentity },
      { kind: "file_baseline", path: target.pathIdentity, expected: target.baseline },
    ],
    approval: mutation ? {
      category: "fileChange",
      environmentId,
      applicabilityKeys: [{ category: "fileChange", value: `${target.workspaceId}:${request.operation}:${target.relativePath}` }],
      reason: `Apply reviewed file ${request.operation}.`,
      payload: {
        changes: [{
          operation: request.operation,
          canonicalPath: target.pathIdentity.path,
          displayPath: targetLabel,
          destinationCanonicalPath: null,
          destinationDisplayPath: null,
          baselineFingerprint: request.operation === "create" ? null : baselineFingerprint,
        }],
        baselineFingerprint,
        additionalPermissions: null,
      },
      decisionOptions: actionDecisionOptions(),
      trustedProposals: [],
      deadlineAt,
      metadata: {},
    } : null,
    safeSummary: {
      kind: "file_system",
      headline: `File ${request.operation}`,
      operations: [{ operation: request.operation, sourceLabel: targetLabel, destinationLabel: null }],
    },
    preparedInvocation: {
      contractVersion: EXECUTOR_DESCRIPTOR.invocationContractVersion,
      executorId: EXECUTOR_DESCRIPTOR.id,
      executorVersion: EXECUTOR_DESCRIPTOR.version,
      payload: payload as unknown as SerializableValue,
    },
    replayBasis: mutation ? "none" : "confirmed_no_effect",
    semanticBasis: { operation: request.operation, targetLabel },
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

function createFileExecutor(
  limits: CodeAgentFileLimits,
  now: () => string,
): ActionExecutor<PreparedActionInvocation, unknown> {
  const executor: ActionExecutor<PreparedActionInvocation, unknown> = {
    descriptor: EXECUTOR_DESCRIPTOR,
    validatePayload(candidate: unknown): candidate is unknown {
      return isPhysicalPayload(candidate);
    },
    async execute(invocation, context) {
      assertActionExecutorDispatchContext(context);
      const payload = readPayload(invocation);
      const startedAt = now();
      let effectStarted = false;
      try {
        throwIfInterrupted(context);
        const value = await executeFile(payload, limits, context, () => { effectStarted = true; });
        return Object.freeze({
          status: "completed" as const,
          effectState: "settled" as const,
          payload: Object.freeze({ value, startedAt, finishedAt: now() }),
        });
      } catch (error) {
        if (context.interruption.signal.aborted) {
          return Object.freeze({
            status: "interrupted" as const,
            effectState: effectStarted ? "unknown" as const : "none" as const,
            evidence: evidence("file_operation_interrupted", "File operation was interrupted."),
          });
        }
        return Object.freeze({
          status: "failed" as const,
          effectState: effectStarted ? "unknown" as const : "none" as const,
          failure: { ...evidence(errorCode(error), safeMessage(error, "File operation failed.")), retryable: false },
        });
      }
    },
  };
  return Object.freeze(executor);
}

async function executeFile(
  payload: PreparedFilePayload,
  limits: CodeAgentFileLimits,
  context: ActionExecutorContext,
  markEffectStarted: () => void,
): Promise<unknown> {
  switch (payload.operation) {
    case "list": return listFiles(payload, limits.maxListEntries, context);
    case "read": return readTextFile(payload, limits.maxReadBytes, context);
    case "search": return searchFiles(payload, limits, context);
    case "create": {
      const content = boundedContent(payload, limits.maxWriteBytes);
      markEffectStarted();
      await writeFile(payload.canonicalTarget, content, { encoding: "utf8", flag: "wx" });
      return fileWriteOutput(payload, content, true, false);
    }
    case "update": {
      const content = boundedContent(payload, limits.maxWriteBytes);
      await assertBaseline(payload);
      markEffectStarted();
      await writeFile(payload.canonicalTarget, content, { encoding: "utf8", flag: "w" });
      return fileWriteOutput(payload, content, false, true);
    }
    case "delete": {
      await assertBaseline(payload);
      markEffectStarted();
      await unlink(payload.canonicalTarget);
      const output: DeleteFileOutput = { rootName: payload.rootName, workspaceId: payload.workspaceId, path: payload.relativePath, deleted: true };
      return output;
    }
  }
}

async function listFiles(
  payload: PreparedFilePayload,
  maxEntries: number,
  context: ActionExecutorContext,
): Promise<ListFilesOutput> {
  const entries: WorkspaceFileEntry[] = [];
  const state = { truncated: false };
  await collectEntries(payload.canonicalTarget, payload.canonicalRoot, payload.recursive, maxEntries, entries, state, context);
  return { rootName: payload.rootName, workspaceId: payload.workspaceId, path: payload.relativePath, entries, truncated: state.truncated };
}

async function collectEntries(
  directory: string,
  root: string,
  recursive: boolean,
  maxEntries: number,
  output: WorkspaceFileEntry[],
  state: { truncated: boolean },
  context: ActionExecutorContext,
): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    throwIfInterrupted(context);
    if (output.length >= maxEntries) { state.truncated = true; return; }
    const absolute = join(directory, entry.name);
    const kind: WorkspaceFileEntryKind = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symbolicLink" : "other";
    const size = kind === "file" ? (await lstat(absolute)).size : null;
    output.push({ path: workspaceRelativePath(root, absolute), kind, sizeBytes: size });
    if (recursive && kind === "directory") await collectEntries(absolute, root, true, maxEntries, output, state, context);
    if (state.truncated) return;
  }
}

async function readTextFile(
  payload: PreparedFilePayload,
  maxBytes: number,
  context: ActionExecutorContext,
): Promise<ReadFileOutput> {
  if ((await stat(payload.canonicalTarget)).size > maxBytes) throw new FileSystemError("file_read_limit_exceeded", "File exceeds read limit.");
  const bytes = await readFile(payload.canonicalTarget);
  throwIfInterrupted(context);
  if (bytes.byteLength > maxBytes) throw new FileSystemError("file_read_limit_exceeded", "File exceeds read limit.");
  const content = decodeUtf8(bytes);
  if (content === null) throw new FileSystemError("file_not_utf8", "File is not UTF-8 text.");
  return { rootName: payload.rootName, workspaceId: payload.workspaceId, path: payload.relativePath, content, sizeBytes: bytes.byteLength };
}

async function searchFiles(
  payload: PreparedFilePayload,
  limits: CodeAgentFileLimits,
  context: ActionExecutorContext,
): Promise<import("@agent-anything/helarc-code-agent/source").SearchFilesOutput> {
  if (payload.query === null) throw new TypeError("Search query is missing.");
  const state = { matches: [] as FileSearchMatch[], truncated: false, skippedFiles: 0 };
  const visit = async (path: string): Promise<void> => {
    if (state.truncated) return;
    throwIfInterrupted(context);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      return;
    }
    if (!stats.isFile() || stats.size > limits.maxSearchFileBytes) { state.skippedFiles += 1; return; }
    const bytes = await readFile(path);
    const content = decodeUtf8(bytes);
    if (content === null || bytes.byteLength > limits.maxSearchFileBytes) { state.skippedFiles += 1; return; }
    const lines = content.replaceAll("\r", "").split("\n");
    for (let line = 0; line < lines.length; line += 1) {
      let start = 0;
      while (start <= lines[line]!.length) {
        const column = lines[line]!.indexOf(payload.query!, start);
        if (column < 0) break;
        state.matches.push({ path: workspaceRelativePath(payload.canonicalRoot, path), line: line + 1, column: column + 1, preview: lines[line]!.slice(0, 240) });
        if (state.matches.length >= limits.maxSearchMatches) { state.truncated = true; return; }
        start = column + payload.query!.length;
      }
    }
  };
  await visit(payload.canonicalTarget);
  return { rootName: payload.rootName, workspaceId: payload.workspaceId, path: payload.relativePath, query: payload.query, matches: state.matches, truncated: state.truncated, skippedFiles: state.skippedFiles };
}

async function assertBaseline(payload: PreparedFilePayload): Promise<void> {
  if (payload.expectedBaseline.kind !== "present") throw new FileSystemError("file_target_changed", "Expected file baseline is absent.");
  const stats = await stat(payload.canonicalTarget);
  const digest = stats.isFile() ? `sha256:${await sha256(await readFile(payload.canonicalTarget))}` : null;
  if (digest !== payload.expectedBaseline.contentDigest) throw new FileSystemError("file_target_changed", "File changed before execution.");
}

function settleFileOperation(
  prepared: import("@agent-anything/action-execution/registration").PreparedAction<PreparedFileBasis>,
  settlement: CanonicalActionSettlement,
): ActionSemanticResult {
  const succeeded = settlement.status === "succeeded";
  const payload = isPhysicalPayload(settlement.payload) ? settlement.payload : null;
  const status: ActionSemanticResult["status"] = settlement.status === "invalidated" ? "invalid" : settlement.status;
  return Object.freeze({
    operationInvocationId: settlement.operationInvocation.id,
    settlement,
    status,
    output: succeeded ? payload?.value ?? null : null,
    failure: succeeded ? null : {
      owner: settlement.causeOwner ?? "helarc.local-environment",
      code: settlement.causeRef ?? `file_${settlement.status}`,
      message: settlement.causeRef ?? `File operation ${settlement.status}.`,
    },
  });
}

function parseRequest(operation: CodeFileOperationKind, input: unknown): CodeFileOperationRequest {
  if (!isRecord(input) || input.operation !== undefined && input.operation !== operation) throw new TypeError("File Operation request is invalid.");
  const path = requiredString(input.path, "path");
  const rootName = optionalString(input.rootName);
  if (operation === "list") return { operation, path, ...(rootName ? { rootName } : {}), recursive: input.recursive === true };
  if (operation === "read") return { operation, path, ...(rootName ? { rootName } : {}) };
  if (operation === "search") return { operation, path, ...(rootName ? { rootName } : {}), query: requiredString(input.query, "query") };
  if (operation === "create") return { operation, path, ...(rootName ? { rootName } : {}), content: stringValue(input.content, "content") };
  if (operation === "update") return { operation, path, ...(rootName ? { rootName } : {}), content: stringValue(input.content, "content"), expectedContentDigest: requiredString(input.expectedContentDigest, "expectedContentDigest") };
  return { operation, path, ...(rootName ? { rootName } : {}), expectedContentDigest: requiredString(input.expectedContentDigest, "expectedContentDigest") };
}

function readPayload(invocation: PreparedActionInvocation): PreparedFilePayload {
  if (invocation.executorId !== EXECUTOR_DESCRIPTOR.id || invocation.executorVersion !== EXECUTOR_DESCRIPTOR.version || invocation.contractVersion !== EXECUTOR_DESCRIPTOR.invocationContractVersion || !isRecord(invocation.payload)) throw new TypeError("Prepared file invocation is invalid.");
  const value = invocation.payload;
  const operation = value.operation;
  if (!isOperation(operation) || !isBaseline(value.expectedBaseline)) throw new TypeError("Prepared file payload is invalid.");
  return Object.freeze({
    operation,
    rootName: requiredString(value.rootName, "rootName"),
    workspaceId: requiredString(value.workspaceId, "workspaceId"),
    workspaceRoot: requiredString(value.workspaceRoot, "workspaceRoot"),
    canonicalRoot: requiredString(value.canonicalRoot, "canonicalRoot"),
    relativePath: requiredString(value.relativePath, "relativePath"),
    canonicalTarget: requiredString(value.canonicalTarget, "canonicalTarget"),
    expectedBaseline: value.expectedBaseline,
    recursive: value.recursive === true,
    query: value.query === null ? null : requiredString(value.query, "query"),
    content: value.content === null ? null : stringValue(value.content, "content"),
  });
}

function rootIdentityInput(root: CanonicalWorkspaceRootIdentity) {
  if (root.resolvedPath === null) {
    throw new TypeError("Canonical workspace root requires a resolved path.");
  }
  return { rootId: root.rootId, platform: root.platform, path: root.canonicalPath, resolvedPath: root.resolvedPath, resolutionFingerprint: root.resolutionFingerprint };
}

function invalidated(code: string): ActionRevalidationResult {
  return Object.freeze({ status: "invalidated" as const, owner: "helarc.local-environment", code, recordId: `revalidation:${code}` });
}

function preparationFailure(code: string, message: string) {
  return Object.freeze({ status: "invalid" as const, owner: "helarc.local-environment", code, message });
}

function interruptionPreparation(context: { readonly signal: AbortSignal; readonly interruption: unknown }) {
  return context.signal.aborted ? Object.freeze({ status: "interrupted" as const, owner: "helarc.local-environment", code: "file_action_interrupted", message: "File Action preparation was interrupted." }) : null;
}

function interruptionRevalidation(context: { readonly signal: AbortSignal; readonly interruption: unknown }): ActionRevalidationResult | null {
  return context.signal.aborted ? Object.freeze({ status: "interrupted" as const, owner: "helarc.local-environment", code: "file_action_interrupted", recordId: "revalidation:interrupted" }) : null;
}

function throwIfInterrupted(context: ActionExecutorContext): void {
  if (context.interruption.signal.aborted) throw new FileSystemError("file_action_interrupted", "File operation was interrupted.");
}

function boundedContent(payload: PreparedFilePayload, maxBytes: number): string {
  if (payload.content === null || Buffer.byteLength(payload.content, "utf8") > maxBytes) throw new FileSystemError("file_write_limit_exceeded", "File content exceeds write limit.");
  return payload.content;
}

function fileWriteOutput(payload: PreparedFilePayload, content: string, created: boolean, replaced: boolean): FileWriteOutput {
  return { rootName: payload.rootName, workspaceId: payload.workspaceId, path: payload.relativePath, bytesWritten: Buffer.byteLength(content, "utf8"), created, replaced };
}

function isPhysicalPayload(value: unknown): value is { readonly value: unknown; readonly startedAt: string; readonly finishedAt: string } {
  return isRecord(value) && Object.hasOwn(value, "value") && typeof value.startedAt === "string" && typeof value.finishedAt === "string";
}

function evidence(code: string, message: string) {
  return Object.freeze({ code, message, metadata: Object.freeze({}) });
}

function errorCode(error: unknown): string {
  return error instanceof FileSystemError ? error.code : "file_operation_failed";
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} is required.`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, "rootName");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is CodeFileOperationKind {
  return value === "list" || value === "read" || value === "search" || value === "create" || value === "update" || value === "delete";
}

function isBaseline(value: unknown): value is FileBaseline {
  return isRecord(value) && (value.kind === "absent" || value.kind === "present");
}

async function sha256(value: Uint8Array): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}
