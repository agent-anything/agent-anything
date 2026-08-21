import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";
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
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_WRITE_TOOL,
  bindingRefForCodeFileTool,
  operationRefForCodeFileTool,
  type CodeFileActionAdapterIds,
  type CodeFileOperationKind,
  type CodeFileOperationRequest,
  type CodeFileToolName,
} from "@agent-anything/helarc-code-agent/file-operation";
import type {
  CodeAgentFileLimits,
  CodeFileBaselineOutput,
  CodeFileEditOutput,
  CodeFileGlobOutput,
  CodeFileGrepContentEntry,
  CodeFileGrepEntry,
  CodeFileGrepOutput,
  CodeFileReadOutput,
  CodeFileWriteOutput,
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
  version: "2",
  invocationContractVersion: "2",
  physicalPayloadSchemaRevision: "2",
});

const SPECS = Object.freeze([
  actionSpec("read", CODE_AGENT_READ_TOOL, "read"),
  actionSpec("glob", CODE_AGENT_GLOB_TOOL, "read"),
  actionSpec("grep", CODE_AGENT_GREP_TOOL, "read"),
  actionSpec("edit", CODE_AGENT_EDIT_TOOL, "write"),
  actionSpec("write", CODE_AGENT_WRITE_TOOL, "write"),
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
  return Object.freeze({
    actionAdapterIds: HELARC_LOCAL_FILE_ACTION_ADAPTER_IDS,
    registrations: createActionRegistrationSnapshot(SPECS.map(registrationInput)),
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
    readonly version: "2";
    readonly requestSchemaRevision: "2";
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
      version: "2" as const,
      requestSchemaRevision: "2" as const,
    }),
  });
}

function registrationInput(spec: FileActionSpec): ActionRegistrationInput {
  return {
    registrationId: `helarc.local.filesystem.${spec.operation}.registration.v2`,
    revision: "2",
    operation: operationRefForCodeFileTool(spec.toolName),
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
        if (context.workspace === null || workspace === null) {
          return preparationFailure("workspace_required", "File operations require a Run workspace.");
        }
        const requestedPath = fileTargetPath(request);
        const target = await prepareFileSystemTarget({
          workspace,
          workspaceRoots: context.workspace.roots,
          platform: context.environment.platform,
          path: requestedPath,
          operation: request.operation,
        });
        const preparedInput = await prepareOperationInput(request, target, limits);
        const preparedData = await createFilePreparedData(
          request,
          preparedInput,
          target,
          context.environment.environmentId,
          context.now(),
        );
        return Object.freeze({
          status: "prepared" as const,
          prepared: await createPreparedAction(binding, context, preparedData),
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
          expectedBaseline: payload.expectedBaseline,
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
        return Object.freeze({
          status: "valid" as const,
          recordId: `revalidation:${context.action.id}:${context.subjectRevision}`,
        });
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

interface PreparedOperationInput {
  readonly content: string | null;
  readonly replacementCount: number;
  readonly previousByteLength: number | null;
}

interface PreparedFilePayload {
  readonly operation: CodeFileOperationKind;
  readonly targetId: string;
  readonly rootName: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly relativePath: string;
  readonly canonicalTarget: string;
  readonly expectedBaseline: FileBaseline;
  readonly previousByteLength: number | null;
  readonly offset: number;
  readonly limit: number | null;
  readonly pattern: string | null;
  readonly glob: string | null;
  readonly outputMode: "content" | "files_with_matches" | "count";
  readonly caseSensitive: boolean;
  readonly beforeContext: number;
  readonly afterContext: number;
  readonly multiline: boolean;
  readonly content: string | null;
  readonly replacementCount: number;
}

interface PreparedFileBasis {
  readonly operation: CodeFileOperationKind;
  readonly targetLabel: string;
}

async function prepareOperationInput(
  request: CodeFileOperationRequest,
  target: PreparedFileSystemTarget,
  limits: CodeAgentFileLimits,
): Promise<PreparedOperationInput> {
  if (request.operation === "edit") {
    const current = await readBoundedUtf8(target.canonicalTarget, limits.maxWriteBytes);
    const replacementCount = countOccurrences(current.content, request.old_string);
    if (replacementCount === 0) {
      throw new FileSystemError("file_edit_no_match", "Edit old_string does not occur in the target file.");
    }
    if (replacementCount > 1 && request.replace_all !== true) {
      throw new FileSystemError(
        "file_edit_ambiguous",
        "Edit old_string occurs more than once; set replace_all to replace every occurrence.",
      );
    }
    const content = request.replace_all === true
      ? current.content.split(request.old_string).join(request.new_string)
      : current.content.replace(request.old_string, request.new_string);
    assertWriteLimit(content, limits.maxWriteBytes);
    return Object.freeze({
      content,
      replacementCount: request.replace_all === true ? replacementCount : 1,
      previousByteLength: current.byteLength,
    });
  }
  if (request.operation === "write") {
    assertWriteLimit(request.content, limits.maxWriteBytes);
    return Object.freeze({
      content: request.content,
      replacementCount: 0,
      previousByteLength: target.baseline.kind === "present"
        ? (await stat(target.canonicalTarget)).size
        : null,
    });
  }
  return Object.freeze({ content: null, replacementCount: 0, previousByteLength: null });
}

async function createFilePreparedData(
  request: CodeFileOperationRequest,
  operationInput: PreparedOperationInput,
  target: PreparedFileSystemTarget,
  environmentId: string,
  createdAt: string,
): Promise<ActionAdapterPreparedData<PreparedFileBasis>> {
  const mutation = request.operation === "edit" || request.operation === "write";
  const targetId = await createCanonicalSha256Digest(
    "helarc.code-agent.file-target.v1",
    target.pathIdentity,
  );
  const payload: PreparedFilePayload = {
    operation: request.operation,
    targetId,
    rootName: target.rootName,
    workspaceId: target.workspaceId,
    workspaceRoot: target.workspaceRoot,
    canonicalRoot: target.canonicalRoot,
    relativePath: target.relativePath,
    canonicalTarget: target.canonicalTarget,
    expectedBaseline: target.baseline,
    previousByteLength: operationInput.previousByteLength,
    offset: "offset" in request ? request.offset ?? 1 : 1,
    limit: "limit" in request ? request.limit ?? null : null,
    pattern: "pattern" in request ? request.pattern : null,
    glob: request.operation === "grep" ? request.glob ?? null : null,
    outputMode: request.operation === "grep" ? request.output_mode ?? "content" : "content",
    caseSensitive: request.operation === "grep" ? request.case_sensitive ?? true : true,
    beforeContext: request.operation === "grep" ? request.before_context ?? 0 : 0,
    afterContext: request.operation === "grep" ? request.after_context ?? 0 : 0,
    multiline: request.operation === "grep" ? request.multiline ?? false : false,
    content: operationInput.content,
    replacementCount: operationInput.replacementCount,
  };
  const targetLabel = target.relativePath;
  const baselineFingerprint = await createCanonicalSha256Digest(
    "helarc.local.filesystem.baseline.v2",
    target.baseline,
  );
  const fileChangeOperation = target.baseline.kind === "absent" ? "create" : "update";
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
      applicabilityKeys: [{
        category: "fileChange",
        value: `${target.workspaceId}:${fileChangeOperation}:${target.relativePath}`,
      }],
      reason: `${request.operation === "edit" ? "Edit" : "Write"} ${targetLabel}.`,
      payload: {
        changes: [{
          operation: fileChangeOperation,
          canonicalPath: target.pathIdentity.path,
          displayPath: targetLabel,
          destinationCanonicalPath: null,
          destinationDisplayPath: null,
          baselineFingerprint: target.baseline.kind === "absent" ? null : baselineFingerprint,
        }],
        baselineFingerprint,
        additionalPermissions: null,
      },
      decisionOptions: actionDecisionOptions(),
      trustedProposals: [],
      deadlineAt: new Date(Date.parse(createdAt) + 120_000).toISOString(),
      metadata: {},
    } : null,
    safeSummary: {
      kind: "file_system",
      headline: request.operation === "edit" ? "Edit file" :
        request.operation === "write" ? "Write file" : `${request.operation} files`,
      operations: [{
        operation: mutation ? fileChangeOperation : "read",
        sourceLabel: targetLabel,
        destinationLabel: null,
      }],
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
        const value = await executeFile(
          payload,
          limits,
          context,
          () => { effectStarted = true; },
        );
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
          failure: {
            ...evidence(errorCode(error), safeMessage(error, "File operation failed.")),
            retryable: false,
          },
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
    case "read":
      return readTextFile(payload, limits, context);
    case "glob":
      return globFiles(payload, limits.maxGlobEntries, context);
    case "grep":
      return grepFiles(payload, limits, context);
    case "edit":
      return executeEdit(payload, limits, markEffectStarted);
    case "write":
      return executeWrite(payload, limits, markEffectStarted);
  }
}

async function readTextFile(
  payload: PreparedFilePayload,
  limits: CodeAgentFileLimits,
  context: ActionExecutorContext,
): Promise<CodeFileReadOutput> {
  const current = await readBoundedUtf8(payload.canonicalTarget, limits.maxReadBytes);
  throwIfInterrupted(context);
  const lines = current.content.length === 0 ? [] : current.content.split(/\r?\n/u);
  const requestedLimit = payload.limit ?? limits.maxReadLines;
  const limit = Math.min(requestedLimit, limits.maxReadLines);
  const startIndex = Math.min(payload.offset - 1, lines.length);
  const selected = lines.slice(startIndex, startIndex + limit);
  const startLine = lines.length === 0 ? 1 : startIndex + 1;
  const endLine = selected.length === 0 ? 0 : startIndex + selected.length;
  return Object.freeze({
    ...baselineOutput(payload, current.byteLength, digest(current.bytes)),
    content: selected.join("\n"),
    start_line: startLine,
    end_line: endLine,
    total_lines: lines.length,
    truncated: startIndex > 0 || endLine < lines.length,
  });
}

async function globFiles(
  payload: PreparedFilePayload,
  maximum: number,
  context: ActionExecutorContext,
): Promise<CodeFileGlobOutput> {
  if (payload.pattern === null) throw new TypeError("Glob pattern is missing.");
  validateGlobPattern(payload.pattern);
  const candidates: string[] = [];
  await visitFilesAndDirectories(payload.canonicalTarget, context, async (absolute, kind) => {
    const relativeToTarget = normalizedRelative(payload.canonicalTarget, absolute);
    if (relativeToTarget !== "." && matchesGlob(relativeToTarget, payload.pattern!)) {
      candidates.push(workspaceRelativePath(payload.canonicalRoot, absolute));
    }
    return kind === "directory";
  });
  candidates.sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    matches: Object.freeze(candidates.slice(0, maximum)),
    truncated: candidates.length > maximum,
    omitted_count: Math.max(0, candidates.length - maximum),
  });
}

async function grepFiles(
  payload: PreparedFilePayload,
  limits: CodeAgentFileLimits,
  context: ActionExecutorContext,
): Promise<CodeFileGrepOutput> {
  if (payload.pattern === null) throw new TypeError("Grep pattern is missing.");
  const expression = compileExpression(payload.pattern, payload.caseSensitive, payload.multiline);
  if (payload.glob !== null) validateGlobPattern(payload.glob);
  const candidates: CodeFileGrepEntry[] = [];
  await visitFilesAndDirectories(payload.canonicalTarget, context, async (absolute, kind) => {
    if (kind !== "file") return kind === "directory";
    const relativeToTarget = normalizedRelative(payload.canonicalTarget, absolute);
    if (payload.glob !== null && !matchesGlob(relativeToTarget, payload.glob)) return false;
    const stats = await stat(absolute);
    if (stats.size > limits.maxSearchFileBytes) return false;
    const bytes = await readFile(absolute);
    if (bytes.byteLength > limits.maxSearchFileBytes) return false;
    const content = decodeUtf8(bytes);
    if (content === null) return false;
    const path = workspaceRelativePath(payload.canonicalRoot, absolute);
    const fileEntries = grepContent(path, content, expression, payload, limits);
    candidates.push(...fileEntries);
    return false;
  });
  const offset = payload.offset - 1;
  const requestedLimit = payload.limit ?? limits.maxGrepMatches;
  const limit = Math.min(requestedLimit, limits.maxGrepMatches);
  const entries = candidates.slice(offset, offset + limit);
  const omitted = candidates.length - entries.length;
  return Object.freeze({
    output_mode: payload.outputMode,
    entries: Object.freeze(entries),
    truncated: omitted > 0,
    omitted_count: omitted,
  });
}

function grepContent(
  filePath: string,
  content: string,
  expression: RegExp,
  payload: PreparedFilePayload,
  limits: CodeAgentFileLimits,
): readonly CodeFileGrepEntry[] {
  const lines = content.split(/\r?\n/u);
  const matches: CodeFileGrepContentEntry[] = [];
  if (payload.multiline) {
    for (const match of content.matchAll(expression)) {
      const beforeText = content.slice(0, match.index);
      const line = beforeText.split(/\r?\n/u).length;
      const lastBreak = Math.max(beforeText.lastIndexOf("\n"), beforeText.lastIndexOf("\r"));
      const column = match.index - lastBreak;
      matches.push(contentEntry(filePath, lines, line, column, limits, payload));
    }
  } else {
    lines.forEach((lineText, index) => {
      expression.lastIndex = 0;
      for (const match of lineText.matchAll(expression)) {
        matches.push(contentEntry(
          filePath,
          lines,
          index + 1,
          match.index + 1,
          limits,
          payload,
        ));
      }
    });
  }
  if (payload.outputMode === "content") return matches;
  if (matches.length === 0) return [];
  if (payload.outputMode === "files_with_matches") return [{ file_path: filePath }];
  return [{ file_path: filePath, count: matches.length }];
}

function contentEntry(
  filePath: string,
  lines: readonly string[],
  line: number,
  column: number,
  limits: CodeAgentFileLimits,
  payload: PreparedFilePayload,
): CodeFileGrepContentEntry {
  const beforeCount = Math.min(payload.beforeContext, limits.maxGrepContextLines);
  const afterCount = Math.min(payload.afterContext, limits.maxGrepContextLines);
  return Object.freeze({
    file_path: filePath,
    line,
    column,
    text: lines[line - 1] ?? "",
    before: Object.freeze(lines.slice(Math.max(0, line - 1 - beforeCount), line - 1)),
    after: Object.freeze(lines.slice(line, line + afterCount)),
  });
}

async function executeEdit(
  payload: PreparedFilePayload,
  limits: CodeAgentFileLimits,
  markEffectStarted: () => void,
): Promise<CodeFileEditOutput> {
  const content = boundedContent(payload, limits.maxWriteBytes);
  await assertBaseline(payload);
  const previous = presentBaselineOutput(payload, payload.previousByteLength);
  markEffectStarted();
  await writeFile(payload.canonicalTarget, content, { encoding: "utf8", flag: "w" });
  const current = await readCurrentBaselineOutput(payload);
  return Object.freeze({
    target_id: payload.targetId,
    file_path: payload.relativePath,
    operation: "updated" as const,
    replacement_count: payload.replacementCount,
    previous_baseline: previous,
    current_baseline: current,
  });
}

async function executeWrite(
  payload: PreparedFilePayload,
  limits: CodeAgentFileLimits,
  markEffectStarted: () => void,
): Promise<CodeFileWriteOutput> {
  const content = boundedContent(payload, limits.maxWriteBytes);
  await assertBaseline(payload);
  const previous = payload.expectedBaseline.kind === "present"
    ? presentBaselineOutput(payload, payload.previousByteLength)
    : null;
  markEffectStarted();
  await writeFile(payload.canonicalTarget, content, {
    encoding: "utf8",
    flag: payload.expectedBaseline.kind === "absent" ? "wx" : "w",
  });
  return Object.freeze({
    target_id: payload.targetId,
    file_path: payload.relativePath,
    operation: previous === null ? "created" as const : "replaced" as const,
    previous_baseline: previous,
    current_baseline: await readCurrentBaselineOutput(payload),
  });
}

async function visitFilesAndDirectories(
  target: string,
  context: ActionExecutorContext,
  visit: (absolute: string, kind: "file" | "directory") => Promise<boolean>,
): Promise<void> {
  throwIfInterrupted(context);
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) return;
  if (stats.isFile()) {
    await visit(target, "file");
    return;
  }
  if (!stats.isDirectory()) return;
  const descend = await visit(target, "directory");
  if (!descend) return;
  const entries = (await readdir(target, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    throwIfInterrupted(context);
    if (entry.isSymbolicLink()) continue;
    await visitFilesAndDirectories(join(target, entry.name), context, visit);
  }
}

async function assertBaseline(payload: PreparedFilePayload): Promise<void> {
  if (payload.expectedBaseline.kind === "absent") {
    try {
      await lstat(payload.canonicalTarget);
      throw new FileSystemError("file_target_changed", "Prepared file target now exists.");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
  const stats = await stat(payload.canonicalTarget);
  const digestValue = stats.isFile() ? digest(await readFile(payload.canonicalTarget)) : null;
  if (digestValue !== payload.expectedBaseline.contentDigest) {
    throw new FileSystemError("file_target_changed", "File changed before execution.");
  }
}

function settleFileOperation(
  prepared: import("@agent-anything/action-execution/registration").PreparedAction<PreparedFileBasis>,
  settlement: CanonicalActionSettlement,
): ActionSemanticResult {
  const succeeded = settlement.status === "succeeded";
  const payload = isPhysicalPayload(settlement.payload) ? settlement.payload : null;
  const status: ActionSemanticResult["status"] =
    settlement.status === "invalidated" ? "invalid" : settlement.status;
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
  if (!isRecord(input) || input.operation !== undefined && input.operation !== operation) {
    throw new TypeError("File Operation request is invalid.");
  }
  switch (operation) {
    case "read":
      assertKeys(input, ["operation", "file_path", "offset", "limit"]);
      return {
        operation,
        file_path: requiredString(input.file_path, "file_path"),
        ...(input.offset === undefined ? {} : { offset: positiveInteger(input.offset, "offset") }),
        ...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, "limit") }),
      };
    case "glob":
      assertKeys(input, ["operation", "pattern", "path"]);
      return {
        operation,
        pattern: globPattern(input.pattern, "pattern"),
        ...(input.path === undefined ? {} : { path: requiredString(input.path, "path") }),
      };
    case "grep":
      assertKeys(input, [
        "operation", "pattern", "path", "glob", "output_mode", "case_sensitive",
        "before_context", "after_context", "offset", "limit", "multiline",
      ]);
      return {
        operation,
        pattern: regexPattern(input.pattern),
        ...(input.path === undefined ? {} : { path: requiredString(input.path, "path") }),
        ...(input.glob === undefined ? {} : { glob: globPattern(input.glob, "glob") }),
        ...(input.output_mode === undefined ? {} : { output_mode: outputMode(input.output_mode) }),
        ...(input.case_sensitive === undefined ? {} : { case_sensitive: booleanValue(input.case_sensitive, "case_sensitive") }),
        ...(input.before_context === undefined ? {} : { before_context: nonNegativeInteger(input.before_context, "before_context") }),
        ...(input.after_context === undefined ? {} : { after_context: nonNegativeInteger(input.after_context, "after_context") }),
        ...(input.offset === undefined ? {} : { offset: positiveInteger(input.offset, "offset") }),
        ...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, "limit") }),
        ...(input.multiline === undefined ? {} : { multiline: booleanValue(input.multiline, "multiline") }),
      };
    case "edit":
      assertKeys(input, ["operation", "file_path", "old_string", "new_string", "replace_all"]);
      return {
        operation,
        file_path: requiredString(input.file_path, "file_path"),
        old_string: requiredRawString(input.old_string, "old_string"),
        new_string: stringValue(input.new_string, "new_string"),
        ...(input.replace_all === undefined ? {} : { replace_all: booleanValue(input.replace_all, "replace_all") }),
      };
    case "write":
      assertKeys(input, ["operation", "file_path", "content"]);
      return {
        operation,
        file_path: requiredString(input.file_path, "file_path"),
        content: stringValue(input.content, "content"),
      };
  }
}

function fileTargetPath(request: CodeFileOperationRequest): string {
  return request.operation === "read" || request.operation === "edit" || request.operation === "write"
    ? request.file_path
    : request.path ?? ".";
}

function readPayload(invocation: PreparedActionInvocation): PreparedFilePayload {
  if (
    invocation.executorId !== EXECUTOR_DESCRIPTOR.id ||
    invocation.executorVersion !== EXECUTOR_DESCRIPTOR.version ||
    invocation.contractVersion !== EXECUTOR_DESCRIPTOR.invocationContractVersion ||
    !isRecord(invocation.payload)
  ) throw new TypeError("Prepared file invocation is invalid.");
  const value = invocation.payload;
  if (!isOperation(value.operation) || !isBaseline(value.expectedBaseline)) {
    throw new TypeError("Prepared file payload is invalid.");
  }
  return Object.freeze({
    operation: value.operation,
    targetId: requiredString(value.targetId, "targetId"),
    rootName: requiredString(value.rootName, "rootName"),
    workspaceId: requiredString(value.workspaceId, "workspaceId"),
    workspaceRoot: requiredString(value.workspaceRoot, "workspaceRoot"),
    canonicalRoot: requiredString(value.canonicalRoot, "canonicalRoot"),
    relativePath: requiredString(value.relativePath, "relativePath"),
    canonicalTarget: requiredString(value.canonicalTarget, "canonicalTarget"),
    expectedBaseline: value.expectedBaseline,
    previousByteLength: value.previousByteLength === null
      ? null
      : nonNegativeInteger(value.previousByteLength, "previousByteLength"),
    offset: positiveInteger(value.offset, "offset"),
    limit: value.limit === null ? null : positiveInteger(value.limit, "limit"),
    pattern: value.pattern === null ? null : requiredString(value.pattern, "pattern"),
    glob: value.glob === null ? null : requiredString(value.glob, "glob"),
    outputMode: outputMode(value.outputMode),
    caseSensitive: booleanValue(value.caseSensitive, "caseSensitive"),
    beforeContext: nonNegativeInteger(value.beforeContext, "beforeContext"),
    afterContext: nonNegativeInteger(value.afterContext, "afterContext"),
    multiline: booleanValue(value.multiline, "multiline"),
    content: value.content === null ? null : stringValue(value.content, "content"),
    replacementCount: nonNegativeInteger(value.replacementCount, "replacementCount"),
  });
}

function rootIdentityInput(root: CanonicalWorkspaceRootIdentity) {
  if (root.resolvedPath === null) {
    throw new TypeError("Canonical workspace root requires a resolved path.");
  }
  return {
    rootId: root.rootId,
    platform: root.platform,
    path: root.canonicalPath,
    resolvedPath: root.resolvedPath,
    resolutionFingerprint: root.resolutionFingerprint,
  };
}

function invalidated(code: string): ActionRevalidationResult {
  return Object.freeze({
    status: "invalidated" as const,
    owner: "helarc.local-environment",
    code,
    recordId: `revalidation:${code}`,
  });
}

function preparationFailure(code: string, message: string) {
  return Object.freeze({
    status: "invalid" as const,
    owner: "helarc.local-environment",
    code,
    message,
  });
}

function interruptionPreparation(context: { readonly signal: AbortSignal }) {
  return context.signal.aborted ? Object.freeze({
    status: "interrupted" as const,
    owner: "helarc.local-environment",
    code: "file_action_interrupted",
    message: "File Action preparation was interrupted.",
  }) : null;
}

function interruptionRevalidation(
  context: { readonly signal: AbortSignal },
): ActionRevalidationResult | null {
  return context.signal.aborted ? Object.freeze({
    status: "interrupted" as const,
    owner: "helarc.local-environment",
    code: "file_action_interrupted",
    recordId: "revalidation:interrupted",
  }) : null;
}

function throwIfInterrupted(context: ActionExecutorContext): void {
  if (context.interruption.signal.aborted) {
    throw new FileSystemError("file_action_interrupted", "File operation was interrupted.");
  }
}

function boundedContent(payload: PreparedFilePayload, maximum: number): string {
  if (payload.content === null) {
    throw new FileSystemError("file_write_content_missing", "Prepared file content is missing.");
  }
  assertWriteLimit(payload.content, maximum);
  return payload.content;
}

function assertWriteLimit(content: string, maximum: number): void {
  if (Buffer.byteLength(content, "utf8") > maximum) {
    throw new FileSystemError(
      "file_write_limit_exceeded",
      "File content exceeds the configured write limit.",
    );
  }
}

async function readBoundedUtf8(
  path: string,
  maximum: number,
): Promise<{ readonly bytes: Uint8Array; readonly content: string; readonly byteLength: number }> {
  if ((await stat(path)).size > maximum) {
    throw new FileSystemError("file_read_limit_exceeded", "File exceeds the configured read limit.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maximum) {
    throw new FileSystemError("file_read_limit_exceeded", "File exceeds the configured read limit.");
  }
  const content = decodeUtf8(bytes);
  if (content === null || bytes.includes(0)) {
    throw new FileSystemError("file_content_unsupported", "File is not supported UTF-8 text.");
  }
  return Object.freeze({ bytes, content, byteLength: bytes.byteLength });
}

function presentBaselineOutput(
  payload: PreparedFilePayload,
  byteLength: number | null,
): CodeFileBaselineOutput {
  if (
    payload.expectedBaseline.kind !== "present" ||
    payload.expectedBaseline.contentDigest === null ||
    byteLength === null
  ) throw new TypeError("Present file baseline output is unavailable.");
  return baselineOutput(
    payload,
    byteLength,
    payload.expectedBaseline.contentDigest,
  );
}

async function readCurrentBaselineOutput(
  payload: PreparedFilePayload,
): Promise<CodeFileBaselineOutput> {
  const bytes = await readFile(payload.canonicalTarget);
  return baselineOutput(payload, bytes.byteLength, digest(bytes));
}

function baselineOutput(
  payload: PreparedFilePayload,
  byteLength: number,
  contentDigest: string,
): CodeFileBaselineOutput {
  return Object.freeze({
    target_id: payload.targetId,
    file_path: payload.relativePath,
    byte_length: byteLength,
    content_digest: contentDigest,
  });
}

function countOccurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

function compileExpression(pattern: string, caseSensitive: boolean, multiline: boolean): RegExp {
  try {
    return new RegExp(pattern, `g${caseSensitive ? "" : "i"}${multiline ? "ms" : ""}u`);
  } catch {
    throw new FileSystemError("file_grep_pattern_invalid", "Grep pattern is not a valid regular expression.");
  }
}

function validateGlobPattern(pattern: string): void {
  if (pattern.includes("\0") || isAbsolute(pattern) || pattern.split(/[\\/]/u).includes("..")) {
    throw new FileSystemError("file_glob_pattern_invalid", "Glob pattern is outside the admitted Workspace scope.");
  }
  try {
    matchesGlob("probe/path.txt", pattern);
  } catch {
    throw new FileSystemError("file_glob_pattern_invalid", "Glob pattern is invalid.");
  }
}

function normalizedRelative(from: string, to: string): string {
  const value = relative(from, to);
  return value.length === 0 ? "." : value.split(sep).join("/");
}

function globPattern(value: unknown, name: string): string {
  const pattern = requiredString(value, name);
  if (pattern.length > 4_096) throw new TypeError(`${name} exceeds its limit.`);
  validateGlobPattern(pattern);
  return pattern;
}

function regexPattern(value: unknown): string {
  const pattern = requiredString(value, "pattern");
  if (pattern.length > 4_096) throw new TypeError("pattern exceeds its limit.");
  return pattern;
}

function outputMode(value: unknown): "content" | "files_with_matches" | "count" {
  if (value === "content" || value === "files_with_matches" || value === "count") return value;
  throw new TypeError("output_mode is invalid.");
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`File Operation field '${key}' is unsupported.`);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} is required.`);
  }
  return value;
}

function requiredRawString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required.`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is CodeFileOperationKind {
  return value === "read" || value === "glob" || value === "grep" ||
    value === "edit" || value === "write";
}

function isBaseline(value: unknown): value is FileBaseline {
  return isRecord(value) && (value.kind === "absent" || value.kind === "present");
}

function isPhysicalPayload(value: unknown): value is {
  readonly value: unknown;
  readonly startedAt: string;
  readonly finishedAt: string;
} {
  return isRecord(value) && Object.hasOwn(value, "value") &&
    typeof value.startedAt === "string" && typeof value.finishedAt === "string";
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

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
