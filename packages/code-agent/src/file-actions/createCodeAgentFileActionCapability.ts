import { Buffer } from "node:buffer";
import { lstat, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertActionExecutorDispatchContext,
  createActionRegistrationSnapshot,
  createCanonicalPathIdentity,
  createCanonicalSha256Digest,
  type ActionAdapter,
  type ActionAdapterDescriptor,
  type ActionAdapterPreparedData,
  type ActionExecutor,
  type ActionExecutorContext,
  type ActionExecutorDescriptor,
  type CanonicalWorkspaceRootIdentity,
  type FileBaseline,
  type PreparedActionInvocation,
  type SerializableValue,
  type TargetStateAssertion,
} from "@agent-anything/agent-core/action-execution";
import type { ToolJsonObject, ToolResult } from "@agent-anything/tools";
import { createToolCatalogSnapshot } from "@agent-anything/tools";
import type {
  FileSearchMatch,
  ListFilesOutput,
  ReadFileOutput,
  WorkspaceFileEntry,
  WorkspaceFileEntryKind,
  WriteFileOutput,
} from "../file-tools/FileToolContracts.js";
import { FileToolError } from "../file-tools/FileToolError.js";
import { resolveFileToolLimits } from "../file-tools/fileToolLimits.js";
import { workspaceRelativePath } from "../file-tools/filesystemBoundary.js";
import { decodeUtf8 } from "../file-tools/utf8.js";
import {
  CODE_AGENT_CREATE_FILE_ACTION,
  CODE_AGENT_DELETE_FILE_ACTION,
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
  CODE_AGENT_UPDATE_FILE_ACTION,
  type CodeAgentFileActionCapability,
  type CodeAgentFileActionName,
  type CodeAgentPreparedFileInvocationPayload,
  type CodeAgentPreparedFileOperation,
  type CreateCodeAgentFileActionCapabilityInput,
  type DeleteFileOutput,
} from "./FileActionContracts.js";
import {
  inspectPreparedFileSystemTarget,
  prepareFileSystemTarget,
  type PreparedFileSystemTarget,
} from "./FileActionFilesystem.js";

const ADAPTER_DESCRIPTOR: ActionAdapterDescriptor = Object.freeze({
  id: "code-agent.file.adapter",
  version: "1",
  inputSchemaVersion: "1",
});

const EXECUTOR_DESCRIPTOR: ActionExecutorDescriptor = Object.freeze({
  id: "code-agent.file.executor",
  version: "1",
  invocationContractVersion: "1",
});

const ACTION_NAMES: readonly CodeAgentFileActionName[] = Object.freeze([
  CODE_AGENT_LIST_FILES_ACTION,
  CODE_AGENT_READ_FILE_ACTION,
  CODE_AGENT_SEARCH_FILES_ACTION,
  CODE_AGENT_CREATE_FILE_ACTION,
  CODE_AGENT_UPDATE_FILE_ACTION,
  CODE_AGENT_DELETE_FILE_ACTION,
]);

export function createCodeAgentFileActionCapability(
  input: CreateCodeAgentFileActionCapabilityInput,
): CodeAgentFileActionCapability {
  const limits = resolveFileToolLimits(input.limits);
  const now = input.now ?? (() => new Date().toISOString());
  const registrations = createActionRegistrationSnapshot(ACTION_NAMES.map((actionName) => ({
    actionName,
    adapter: ADAPTER_DESCRIPTOR,
    executor: EXECUTOR_DESCRIPTOR,
  })));
  const adapter = createFileActionAdapter(input, limits);
  const executor = createFileActionExecutor(limits, now);

  return Object.freeze({
    catalog: createFileToolCatalog(),
    registrations,
    adapters: Object.freeze(ACTION_NAMES.map((actionName) => Object.freeze({
      actionName,
      adapter,
    }))),
    executors: Object.freeze([executor]),
  });
}

function createFileToolCatalog() {
  const pathProperty = { type: "string" } as const;
  const baseProperties = {
    rootName: { type: "string" },
    path: pathProperty,
  };
  return createToolCatalogSnapshot([
    descriptor(CODE_AGENT_LIST_FILES_ACTION, "List files inside a declared task workspace root.", {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { ...baseProperties, recursive: { type: "boolean" } },
    }, true, false),
    descriptor(CODE_AGENT_READ_FILE_ACTION, "Read a UTF-8 file inside a declared task workspace root.", {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: baseProperties,
    }, true, false),
    descriptor(CODE_AGENT_SEARCH_FILES_ACTION, "Search UTF-8 files inside a declared task workspace root.", {
      type: "object",
      additionalProperties: false,
      required: ["path", "query"],
      properties: { ...baseProperties, query: { type: "string", minLength: 1 } },
    }, true, false),
    descriptor(CODE_AGENT_CREATE_FILE_ACTION, "Create a UTF-8 file inside a declared task workspace root.", {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: { ...baseProperties, content: { type: "string" } },
    }, false, true),
    descriptor(CODE_AGENT_UPDATE_FILE_ACTION, "Replace one UTF-8 file inside a declared task workspace root.", {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        ...baseProperties,
        content: { type: "string" },
        expectedContentDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
    }, false, true),
    descriptor(CODE_AGENT_DELETE_FILE_ACTION, "Delete one file inside a declared task workspace root.", {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        ...baseProperties,
        expectedContentDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
      },
    }, false, true),
  ]);
}

function descriptor(
  name: CodeAgentFileActionName,
  description: string,
  inputSchema: ToolJsonObject,
  readOnlyHint: boolean,
  destructiveHint: boolean,
) {
  return {
    name,
    description,
    inputSchema,
    annotations: {
      title: description,
      readOnlyHint,
      destructiveHint,
      idempotentHint: name !== CODE_AGENT_CREATE_FILE_ACTION,
      openWorldHint: false,
    },
    metadata: { capabilityOwner: "code-agent", schemaVersion: 1 },
  };
}

function createFileActionAdapter(
  input: CreateCodeAgentFileActionCapabilityInput,
  limits: ReturnType<typeof resolveFileToolLimits>,
): ActionAdapter {
  const adapter: ActionAdapter = {
    descriptor: ADAPTER_DESCRIPTOR,
    async prepare(action, context) {
      const interruption = observeInterruption(context.interruption);
      if (interruption !== null) return interruption;
      try {
        const parsed = parseFileActionInput(action.actionName, action.input);
        if ((parsed.operation === "create" || parsed.operation === "update") &&
          Buffer.byteLength(parsed.content!, "utf8") > limits.maxWriteBytes) {
          return rejected("Content exceeds the configured write byte limit.");
        }
        const target = await prepareFileSystemTarget({
          workspaceScope: input.workspaceScope,
          workspaceRoots: context.workspace.roots,
          platform: context.environment.platform,
          rootName: parsed.rootName,
          path: parsed.path,
          operation: parsed.operation,
        });
        if (parsed.expectedContentDigest !== null &&
          (target.baseline.kind !== "present" ||
            target.baseline.contentDigest !== parsed.expectedContentDigest)) {
          return rejected("The file target no longer matches the supplied content baseline.");
        }
        const afterResolution = observeInterruption(context.interruption);
        if (afterResolution !== null) return afterResolution;
        return {
          status: "prepared" as const,
          data: await preparedData(parsed, target),
        };
      } catch (error) {
        const afterFailure = observeInterruption(context.interruption);
        if (afterFailure !== null) return afterFailure;
        return rejected(safeMessage(error, "File Action input or target is invalid."));
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
        const pathAssertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "canonical_path_identity" }> =>
            candidate.kind === "canonical_path_identity",
        );
        const baselineAssertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "file_baseline" }> =>
            candidate.kind === "file_baseline",
        );
        if (rootAssertion === undefined || pathAssertion === undefined || baselineAssertion === undefined) {
          return invalidated("tool_file_assertion_missing", "Required file target assertions are missing.");
        }
        const actual = await inspectPreparedFileSystemTarget({
          platform: context.environment.platform,
          operation: payload.operation,
          workspaceRootIdentity: rootAssertion.expected,
          workspaceRoot: payload.workspaceRoot,
          canonicalRoot: payload.canonicalRoot,
          canonicalTarget: payload.canonicalTarget,
          path: pathAssertion.expected.canonicalPath,
        });
        if (!samePathIdentity(actual.pathIdentity, pathAssertion.expected) ||
          !sameBaseline(actual.baseline, baselineAssertion.expected) ||
          !sameBaseline(actual.baseline, payload.expectedBaseline)) {
          return invalidated("tool_file_target_changed", "The file target changed after Action preparation.");
        }
        return { status: "valid" as const };
      } catch (error) {
        const afterFailure = observeInterruption(context.interruption);
        if (afterFailure !== null) return afterFailure;
        return invalidated("tool_file_target_changed", safeMessage(
          error,
          "The file target changed after Action preparation.",
        ));
      }
    },
  };
  return Object.freeze(adapter);
}

async function preparedData(
  input: ParsedFileActionInput,
  target: PreparedFileSystemTarget,
): Promise<ActionAdapterPreparedData> {
  const mutation = isMutation(input.operation);
  const permissionKind = mutation ? "write" : "read";
  const canonicalTargetPath = createCanonicalPathIdentity(target.pathIdentity).canonicalPath;
  const baselineFingerprint = await createCanonicalSha256Digest(
    "agent-anything.code-agent.file-baseline.v1",
    target.baseline,
  );
  const parametersDigest = await createCanonicalSha256Digest(
    "agent-anything.code-agent.file-operation.v1",
    {
      operation: input.operation,
      recursive: input.recursive,
      query: input.query,
      contentDigest: input.content === null
        ? null
        : `sha256:${await sha256Text(input.content)}`,
      expectedContentDigest: input.expectedContentDigest,
    },
  );
  const approvalCategory = mutation ? "fileChange" as const : null;
  const approvalPayload = mutation
    ? {
        changes: [{
          operation: input.operation as "create" | "update" | "delete",
          canonicalPath: canonicalTargetPath,
          displayPath: `${target.rootName}:${target.relativePath}`,
          destinationCanonicalPath: null,
          destinationDisplayPath: null,
          baselineFingerprint: input.operation === "create" ? null : baselineFingerprint,
        }],
        baselineFingerprint,
        additionalPermissions: null,
      }
    : null;
  const payload: CodeAgentPreparedFileInvocationPayload = {
    actionName: actionNameForOperation(input.operation),
    operation: input.operation,
    rootName: target.rootName,
    workspaceId: target.workspaceId,
    workspaceRoot: target.workspaceRoot,
    canonicalRoot: target.canonicalRoot,
    relativePath: target.relativePath,
    canonicalTarget: target.canonicalTarget,
    expectedBaseline: target.baseline,
    recursive: input.recursive,
    query: input.query,
    content: input.content,
  };

  const data: ActionAdapterPreparedData = {
    operation: {
      kind: "file_system",
      operations: [{ sequence: 0, operation: input.operation, target: target.pathIdentity }],
      parametersDigest,
    },
    effectSet: {
      kind: "effects",
      values: [{
        kind: "file_system",
        operation: permissionKind,
        targets: [target.pathIdentity],
      }],
    },
    requestedPermissions: null,
    targetAssertions: [
      { kind: "workspace_root_identity", expected: rootIdentityInput(target.workspaceRootIdentity) },
      { kind: "canonical_path_identity", expected: target.pathIdentity },
      { kind: "file_baseline", path: target.pathIdentity, expected: target.baseline },
    ],
    approvalCategory,
    approvalPayload,
    applicabilityKeys: approvalCategory === null ? [] : [{
      category: approvalCategory,
      value: `${target.workspaceId}:${input.operation}:${target.relativePath}`,
    }],
    safeSummary: {
      kind: "file_system",
      headline: headline(input.operation),
      operations: [{
        operation: input.operation,
        sourceLabel: `${target.rootName}:${target.relativePath}`,
        destinationLabel: null,
      }],
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

function createFileActionExecutor(
  limits: ReturnType<typeof resolveFileToolLimits>,
  now: () => string,
): ActionExecutor {
  const executor: ActionExecutor = {
    descriptor: EXECUTOR_DESCRIPTOR,
    async execute(invocation, context) {
      assertActionExecutorDispatchContext(context);
      const startedAt = now();
      let payload: CodeAgentPreparedFileInvocationPayload;
      try {
        payload = readPreparedPayload(invocation);
        throwIfInterrupted(context);
        const output = await executePreparedFileAction(payload, limits, context);
        throwIfInterrupted(context);
        return result(payload, context, startedAt, now(), "succeeded", output, null);
      } catch (error) {
        const candidate = safeReadPayload(invocation);
        return interruptionToolResult(candidate, context, startedAt, now()) ??
          result(
            candidate,
            context,
            startedAt,
            now(),
            "failed",
            null,
            toToolError(error),
          );
      }
    },
  };
  return Object.freeze(executor);
}

async function executePreparedFileAction(
  payload: CodeAgentPreparedFileInvocationPayload,
  limits: ReturnType<typeof resolveFileToolLimits>,
  context: ActionExecutorContext,
): Promise<unknown> {
  switch (payload.operation) {
    case "list": return executeList(payload, limits.maxListEntries, context);
    case "read": return executeRead(payload, limits.maxReadBytes, context);
    case "search": return executeSearch(payload, limits, context);
    case "create": return executeCreate(payload, limits.maxWriteBytes, context);
    case "update": return executeUpdate(payload, limits.maxWriteBytes, context);
    case "delete": return executeDelete(payload, context);
  }
}

async function executeList(
  payload: CodeAgentPreparedFileInvocationPayload,
  maxEntries: number,
  context: ActionExecutorContext,
): Promise<ListFilesOutput> {
  const entries: WorkspaceFileEntry[] = [];
  const state = { truncated: false };
  await collectEntries(
    payload.canonicalTarget,
    payload.canonicalRoot,
    payload.recursive ?? false,
    maxEntries,
    entries,
    state,
    context,
  );
  return {
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    path: payload.relativePath,
    entries,
    truncated: state.truncated,
  };
}

async function collectEntries(
  directory: string,
  canonicalRoot: string,
  recursive: boolean,
  maxEntries: number,
  output: WorkspaceFileEntry[],
  state: { truncated: boolean },
  context: ActionExecutorContext,
): Promise<void> {
  const directoryEntries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  throwIfInterrupted(context);
  for (const entry of directoryEntries) {
    if (output.length >= maxEntries) {
      state.truncated = true;
      return;
    }
    const absolutePath = join(directory, entry.name);
    const kind = entryKind(entry);
    const stats = kind === "file" ? await lstat(absolutePath) : null;
    throwIfInterrupted(context);
    output.push({
      path: workspaceRelativePath(canonicalRoot, absolutePath),
      kind,
      sizeBytes: stats?.size ?? null,
    });
    if (recursive && kind === "directory") {
      await collectEntries(absolutePath, canonicalRoot, true, maxEntries, output, state, context);
      if (state.truncated) return;
    }
  }
}

async function executeRead(
  payload: CodeAgentPreparedFileInvocationPayload,
  maxReadBytes: number,
  context: ActionExecutorContext,
): Promise<ReadFileOutput> {
  const current = await stat(payload.canonicalTarget);
  if (current.size > maxReadBytes) throw limitError("file_read_limit_exceeded");
  const bytes = await readFile(payload.canonicalTarget);
  throwIfInterrupted(context);
  if (bytes.byteLength > maxReadBytes) throw limitError("file_read_limit_exceeded");
  const content = decodeUtf8(bytes);
  if (content === null) throw new FileToolError("file_not_utf8", "File is not valid UTF-8 text.");
  return {
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    path: payload.relativePath,
    content,
    sizeBytes: bytes.byteLength,
  };
}

async function executeSearch(
  payload: CodeAgentPreparedFileInvocationPayload,
  limits: ReturnType<typeof resolveFileToolLimits>,
  context: ActionExecutorContext,
) {
  if (payload.query === null) throw new TypeError("Prepared search query is missing.");
  const state = { matches: [] as FileSearchMatch[], truncated: false, skippedFiles: 0 };
  const targetStats = await stat(payload.canonicalTarget);
  if (targetStats.isFile()) {
    await searchFile(payload.canonicalTarget, payload.canonicalRoot, payload.query, limits, state, context);
  } else {
    await searchDirectory(payload.canonicalTarget, payload.canonicalRoot, payload.query, limits, state, context);
  }
  return {
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    path: payload.relativePath,
    query: payload.query,
    matches: state.matches,
    truncated: state.truncated,
    skippedFiles: state.skippedFiles,
  };
}

interface SearchState {
  matches: FileSearchMatch[];
  truncated: boolean;
  skippedFiles: number;
}

async function searchDirectory(
  directory: string,
  root: string,
  query: string,
  limits: ReturnType<typeof resolveFileToolLimits>,
  state: SearchState,
  context: ActionExecutorContext,
): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  throwIfInterrupted(context);
  for (const entry of entries) {
    if (state.truncated) return;
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await searchDirectory(absolutePath, root, query, limits, state, context);
    } else if (entry.isFile()) {
      await searchFile(absolutePath, root, query, limits, state, context);
    }
  }
}

async function searchFile(
  path: string,
  root: string,
  query: string,
  limits: ReturnType<typeof resolveFileToolLimits>,
  state: SearchState,
  context: ActionExecutorContext,
): Promise<void> {
  const stats = await lstat(path);
  if (stats.size > limits.maxSearchFileBytes) {
    state.skippedFiles += 1;
    return;
  }
  const bytes = await readFile(path);
  throwIfInterrupted(context);
  if (bytes.byteLength > limits.maxSearchFileBytes || bytes.includes(0)) {
    state.skippedFiles += 1;
    return;
  }
  const decoded = decodeUtf8(bytes);
  if (decoded === null) {
    state.skippedFiles += 1;
    return;
  }
  const lines = decoded.replaceAll(String.fromCharCode(13), "").split(String.fromCharCode(10));
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    let fromIndex = 0;
    while (fromIndex <= line.length) {
      throwIfInterrupted(context);
      const matchIndex = line.indexOf(query, fromIndex);
      if (matchIndex < 0) break;
      state.matches.push({
        path: workspaceRelativePath(root, path),
        line: lineIndex + 1,
        column: matchIndex + 1,
        preview: line.slice(0, 240),
      });
      if (state.matches.length >= limits.maxSearchMatches) {
        state.truncated = true;
        return;
      }
      fromIndex = matchIndex + query.length;
    }
  }
}

async function executeCreate(
  payload: CodeAgentPreparedFileInvocationPayload,
  maxWriteBytes: number,
  context: ActionExecutorContext,
): Promise<WriteFileOutput> {
  const content = requirePreparedContent(payload, maxWriteBytes);
  throwIfInterrupted(context);
  await writeFile(payload.canonicalTarget, content, { encoding: "utf8", flag: "wx" });
  return {
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    path: payload.relativePath,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    created: true,
    replaced: false,
  };
}

async function executeUpdate(
  payload: CodeAgentPreparedFileInvocationPayload,
  maxWriteBytes: number,
  context: ActionExecutorContext,
): Promise<WriteFileOutput> {
  const content = requirePreparedContent(payload, maxWriteBytes);
  await assertExecutorBaseline(payload);
  throwIfInterrupted(context);
  await writeFile(payload.canonicalTarget, content, { encoding: "utf8", flag: "w" });
  return {
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    path: payload.relativePath,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    created: false,
    replaced: true,
  };
}

async function executeDelete(
  payload: CodeAgentPreparedFileInvocationPayload,
  context: ActionExecutorContext,
): Promise<DeleteFileOutput> {
  await assertExecutorBaseline(payload);
  throwIfInterrupted(context);
  await unlink(payload.canonicalTarget);
  return {
    rootName: payload.rootName,
    workspaceId: payload.workspaceId,
    path: payload.relativePath,
    deleted: true,
  };
}

async function assertExecutorBaseline(payload: CodeAgentPreparedFileInvocationPayload): Promise<void> {
  if (payload.expectedBaseline.kind !== "present") {
    throw new FileToolError("file_target_changed", "File target baseline is not present.");
  }
  const stats = await stat(payload.canonicalTarget);
  const current: FileBaseline = {
    kind: "present",
    entryKind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
    objectIdentity: payload.expectedBaseline.objectIdentity.kind === "win32"
      ? { kind: "win32", volumeId: String(stats.dev), fileId: String(stats.ino) }
      : { kind: "posix", deviceId: String(stats.dev), inode: String(stats.ino) },
    contentDigest: stats.isFile()
      ? `sha256:${await sha256Bytes(await readFile(payload.canonicalTarget))}`
      : null,
  };
  if (!sameBaseline(current, payload.expectedBaseline)) {
    throw new FileToolError("file_target_changed", "File target changed before execution.");
  }
}

function parseFileActionInput(actionName: string, input: unknown): ParsedFileActionInput {
  const operation = operationForActionName(actionName);
  const value = strictRecord(input, allowedKeys(operation));
  const path = requiredString(value.path, "path", false);
  const rootName = optionalString(value.rootName, "rootName");
  const recursive = operation === "list"
    ? optionalBoolean(value.recursive, "recursive") ?? false
    : null;
  const query = operation === "search" ? requiredString(value.query, "query", false) : null;
  const content = operation === "create" || operation === "update"
    ? requiredString(value.content, "content", true)
    : null;
  const expectedContentDigest = operation === "update" || operation === "delete"
    ? optionalDigest(value.expectedContentDigest)
    : null;
  return { operation, path, rootName, recursive, query, content, expectedContentDigest };
}

interface ParsedFileActionInput {
  readonly operation: CodeAgentPreparedFileOperation;
  readonly path: string;
  readonly rootName?: string;
  readonly recursive: boolean | null;
  readonly query: string | null;
  readonly content: string | null;
  readonly expectedContentDigest: string | null;
}

function readPreparedPayload(invocation: PreparedActionInvocation): CodeAgentPreparedFileInvocationPayload {
  if (invocation.contractVersion !== EXECUTOR_DESCRIPTOR.invocationContractVersion ||
    invocation.executorId !== EXECUTOR_DESCRIPTOR.id ||
    invocation.executorVersion !== EXECUTOR_DESCRIPTOR.version) {
    throw new TypeError("Prepared file invocation executor identity is invalid.");
  }
  const value = strictRecord(invocation.payload, new Set([
    "actionName", "operation", "rootName", "workspaceId", "workspaceRoot", "canonicalRoot",
    "relativePath", "canonicalTarget", "expectedBaseline", "recursive", "query", "content",
  ]));
  const actionName = requiredString(value.actionName, "actionName", false);
  const operation = operationForActionName(actionName);
  if (value.operation !== operation) throw new TypeError("Prepared file operation is inconsistent.");
  if (!isBaseline(value.expectedBaseline)) throw new TypeError("Prepared file baseline is invalid.");
  return Object.freeze({
    actionName: actionName as CodeAgentFileActionName,
    operation,
    rootName: requiredString(value.rootName, "rootName", false),
    workspaceId: requiredString(value.workspaceId, "workspaceId", false),
    workspaceRoot: requiredString(value.workspaceRoot, "workspaceRoot", false),
    canonicalRoot: requiredString(value.canonicalRoot, "canonicalRoot", false),
    relativePath: requiredString(value.relativePath, "relativePath", false),
    canonicalTarget: requiredString(value.canonicalTarget, "canonicalTarget", false),
    expectedBaseline: value.expectedBaseline,
    recursive: value.recursive === null ? null : requireBoolean(value.recursive, "recursive"),
    query: value.query === null ? null : requiredString(value.query, "query", false),
    content: value.content === null ? null : requiredString(value.content, "content", true),
  });
}

function safeReadPayload(invocation: PreparedActionInvocation): CodeAgentPreparedFileInvocationPayload | null {
  try { return readPreparedPayload(invocation); } catch { return null; }
}

function result(
  payload: CodeAgentPreparedFileInvocationPayload | null,
  context: ActionExecutorContext,
  startedAt: string,
  finishedAt: string,
  status: "succeeded" | "failed",
  output: unknown,
  error: { code: string; message: string } | null,
): ToolResult {
  return {
    toolCallId: context.attempt.actionId,
    toolName: payload?.actionName ?? "codeAgent.fileAction",
    status,
    output,
    error,
    startedAt,
    finishedAt,
    metadata: payload === null ? {} : {
      rootName: payload.rootName,
      workspaceId: payload.workspaceId,
      path: payload.relativePath,
      operation: payload.operation,
    },
  };
}

function interruptionToolResult(
  payload: CodeAgentPreparedFileInvocationPayload | null,
  context: ActionExecutorContext,
  startedAt: string,
  finishedAt: string,
): ToolResult | null {
  if (!context.interruption.signal.aborted) return null;
  const interruption = context.interruption.interruption;
  const base = {
    toolCallId: context.attempt.actionId,
    toolName: payload?.actionName ?? "codeAgent.fileAction",
    output: null,
    startedAt,
    finishedAt,
    metadata: {},
  };
  if (interruption?.kind === "run_cancellation") {
    return { ...base, status: "cancelled", error: { code: "tool_cancelled", message: "File operation was cancelled." } };
  }
  if (interruption?.kind === "operation_deadline") {
    return { ...base, status: "timeout", error: { code: "tool_timeout", message: "File operation exceeded its deadline." } };
  }
  return { ...base, status: "interrupted", error: { code: "tool_cancellation_unconfirmed", message: "File operation was interrupted without trusted attribution." } };
}

function observeInterruption(interruption: { readonly signal: AbortSignal; readonly interruption: unknown }) {
  if (!interruption.signal.aborted) return null;
  if (interruption.interruption === null || typeof interruption.interruption !== "object") {
    return {
      status: "failed" as const,
      code: "tool_interruption_unattributed",
      message: "File Action interruption is not attributed.",
      retryable: false,
    };
  }
  return { status: "interrupted" as const, interruption: interruption.interruption as never };
}

function throwIfInterrupted(context: ActionExecutorContext): void {
  if (context.interruption.signal.aborted) throw context.interruption.signal.reason;
}

function invalidated(code: string, message: string) {
  return { status: "invalidated" as const, code, message };
}

function rejected(message: string) {
  return { status: "rejected" as const, code: "action_invalid" as const, message };
}

function rootIdentityInput(root: CanonicalWorkspaceRootIdentity) {
  return {
    rootId: root.rootId,
    platform: root.platform,
    path: root.canonicalPath,
    resolvedPath: root.resolvedPath ?? root.canonicalPath,
    resolutionFingerprint: root.resolutionFingerprint,
  };
}

function samePathIdentity(actual: { path: string; resolvedPath: string | null; workspaceRootId: string | null; resolutionFingerprint: string }, expected: { canonicalPath: string; resolvedPath: string | null; workspaceRootId: string | null; resolutionFingerprint: string }) {
  return normalizePath(actual.path) === normalizePath(expected.canonicalPath) &&
    normalizeNullablePath(actual.resolvedPath) === normalizeNullablePath(expected.resolvedPath) &&
    actual.workspaceRootId === expected.workspaceRootId &&
    actual.resolutionFingerprint === expected.resolutionFingerprint;
}

function sameBaseline(left: FileBaseline, right: FileBaseline): boolean {
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

function isBaseline(value: unknown): value is FileBaseline {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    ((value as { kind?: unknown }).kind === "absent" || (value as { kind?: unknown }).kind === "present");
}

function normalizePath(value: string): string {
  return process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
}

function normalizeNullablePath(value: string | null): string | null {
  return value === null ? null : normalizePath(value);
}

function actionNameForOperation(operation: CodeAgentPreparedFileOperation): CodeAgentFileActionName {
  switch (operation) {
    case "list": return CODE_AGENT_LIST_FILES_ACTION;
    case "read": return CODE_AGENT_READ_FILE_ACTION;
    case "search": return CODE_AGENT_SEARCH_FILES_ACTION;
    case "create": return CODE_AGENT_CREATE_FILE_ACTION;
    case "update": return CODE_AGENT_UPDATE_FILE_ACTION;
    case "delete": return CODE_AGENT_DELETE_FILE_ACTION;
  }
}

function operationForActionName(actionName: string): CodeAgentPreparedFileOperation {
  switch (actionName) {
    case CODE_AGENT_LIST_FILES_ACTION: return "list";
    case CODE_AGENT_READ_FILE_ACTION: return "read";
    case CODE_AGENT_SEARCH_FILES_ACTION: return "search";
    case CODE_AGENT_CREATE_FILE_ACTION: return "create";
    case CODE_AGENT_UPDATE_FILE_ACTION: return "update";
    case CODE_AGENT_DELETE_FILE_ACTION: return "delete";
    default: throw new TypeError(`Unsupported code-agent file Action: ${actionName}.`);
  }
}

function isMutation(operation: CodeAgentPreparedFileOperation): boolean {
  return operation === "create" || operation === "update" || operation === "delete";
}

function headline(operation: CodeAgentPreparedFileOperation): string {
  switch (operation) {
    case "list": return "List workspace files";
    case "read": return "Read workspace file";
    case "search": return "Search workspace files";
    case "create": return "Create workspace file";
    case "update": return "Update workspace file";
    case "delete": return "Delete workspace file";
  }
}

function allowedKeys(operation: CodeAgentPreparedFileOperation): ReadonlySet<string> {
  if (operation === "list") return new Set(["rootName", "path", "recursive"]);
  if (operation === "search") return new Set(["rootName", "path", "query"]);
  if (operation === "create" || operation === "update") {
    return operation === "update"
      ? new Set(["rootName", "path", "content", "expectedContentDigest"])
      : new Set(["rootName", "path", "content"]);
  }
  if (operation === "delete") return new Set(["rootName", "path", "expectedContentDigest"]);
  return new Set(["rootName", "path"]);
}

function strictRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("File Action input must be a plain object.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`Unsupported file Action field: ${String(key)}.`);
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property?.get !== undefined || property?.set !== undefined || !property?.enumerable) {
      throw new TypeError(`File Action field '${key}' must be a data property.`);
    }
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`File Action field '${field}' must be ${allowEmpty ? "text" : "non-empty text"}.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field, false);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : requireBoolean(value, field);
}

function optionalDigest(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("File Action expectedContentDigest must be a canonical SHA-256 digest.");
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`File Action field '${field}' must be boolean.`);
  return value;
}

function requirePreparedContent(payload: CodeAgentPreparedFileInvocationPayload, maxBytes: number): string {
  if (payload.content === null) throw new TypeError("Prepared file content is missing.");
  if (Buffer.byteLength(payload.content, "utf8") > maxBytes) throw limitError("file_write_limit_exceeded");
  return payload.content;
}

function entryKind(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): WorkspaceFileEntryKind {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symbolicLink";
  return "other";
}

function limitError(code: string): FileToolError {
  return new FileToolError(code, "File operation exceeds its configured limit.");
}

function toToolError(error: unknown) {
  if (error instanceof FileToolError) return { code: error.code, message: error.message };
  if (isNodeError(error, "EEXIST")) return { code: "file_already_exists", message: "File already exists." };
  if (isNodeError(error, "ENOENT")) return { code: "file_not_found", message: "File target does not exist." };
  return { code: "file_operation_failed", message: "File operation failed." };
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof FileToolError || error instanceof TypeError ? error.message : fallback;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
