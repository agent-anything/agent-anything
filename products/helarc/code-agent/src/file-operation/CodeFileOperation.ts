import type {
  OperationBindingResolutionInput,
  OperationBindingResolverRegistration,
} from "@agent-anything/operation-catalog/binding";
import { snapshotResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type {
  RegisteredOperation,
} from "@agent-anything/operation-catalog/catalog";
import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import type { ToolJsonObject } from "@agent-anything/tools/catalog";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";

export const CODE_AGENT_LIST_FILES_TOOL = "codeAgent.listFiles";
export const CODE_AGENT_READ_FILE_TOOL = "codeAgent.readFile";
export const CODE_AGENT_SEARCH_FILES_TOOL = "codeAgent.searchFiles";
export const CODE_AGENT_CREATE_FILE_TOOL = "codeAgent.createFile";
export const CODE_AGENT_UPDATE_FILE_TOOL = "codeAgent.updateFile";
export const CODE_AGENT_DELETE_FILE_TOOL = "codeAgent.deleteFile";

export type CodeFileToolName =
  | typeof CODE_AGENT_LIST_FILES_TOOL
  | typeof CODE_AGENT_READ_FILE_TOOL
  | typeof CODE_AGENT_SEARCH_FILES_TOOL
  | typeof CODE_AGENT_CREATE_FILE_TOOL
  | typeof CODE_AGENT_UPDATE_FILE_TOOL
  | typeof CODE_AGENT_DELETE_FILE_TOOL;

export type CodeFileOperationKind =
  | "list"
  | "read"
  | "search"
  | "create"
  | "update"
  | "delete";

export type CodeFileOperationRequest =
  | { readonly operation: "list"; readonly rootName?: string; readonly path: string; readonly recursive?: boolean }
  | { readonly operation: "read"; readonly rootName?: string; readonly path: string }
  | { readonly operation: "search"; readonly rootName?: string; readonly path: string; readonly query: string }
  | { readonly operation: "create"; readonly rootName?: string; readonly path: string; readonly content: string }
  | { readonly operation: "update"; readonly rootName?: string; readonly path: string; readonly content: string; readonly expectedContentDigest: string }
  | { readonly operation: "delete"; readonly rootName?: string; readonly path: string; readonly expectedContentDigest: string };

export interface CodeFileOperationContribution {
  readonly operations: readonly RegisteredOperation[];
  readonly bindings: readonly OperationBindingResolverRegistration[];
  readonly tools: readonly ToolRegistrationInput[];
}

export type CodeFileActionAdapterIds = Readonly<
  Record<CodeFileOperationKind, string>
>;

const REVISION = "1";
const BINDING_REVISION = "1";
const RESOLVER_ID = "helarc.code-workspace.file.direct";

const SPECS = Object.freeze([
  spec("list-files", CODE_AGENT_LIST_FILES_TOOL, "list", "eager_tool", ["model"]),
  spec("read-file", CODE_AGENT_READ_FILE_TOOL, "read", "eager_tool", ["model"]),
  spec("search-files", CODE_AGENT_SEARCH_FILES_TOOL, "search", "eager_tool", ["model"]),
  spec("create-file", CODE_AGENT_CREATE_FILE_TOOL, "create", "workflow_only", ["workflow"]),
  spec("update-file", CODE_AGENT_UPDATE_FILE_TOOL, "update", "workflow_only", ["workflow"]),
  spec("delete-file", CODE_AGENT_DELETE_FILE_TOOL, "delete", "workflow_only", ["workflow"]),
]);

export function createCodeFileOperationContribution(input: {
  readonly actionAdapterIds: CodeFileActionAdapterIds;
  readonly admittedAt: string;
}): CodeFileOperationContribution {
  const operations = SPECS.map((item) => operationRegistration(item, input.admittedAt));
  const bindings: readonly OperationBindingResolverRegistration[] = Object.freeze([{
    resolver: Object.freeze({
      id: RESOLVER_ID,
      revision: REVISION,
      async resolve(request: OperationBindingResolutionInput<unknown, unknown>) {
        const item = specForOperation(request.registration.operation.ref);
        return Object.freeze({
          status: "resolved" as const,
          binding: snapshotResolvedOperationBinding({
            kind: "direct",
            invocation: request.context.invocation,
            correlation: request.context.correlation,
            parentInvocation: request.context.parentInvocation,
            binding: request.registration.binding.ref,
            request: request.request,
            resolverRevision: REVISION,
            resolutionFingerprint: `${request.context.invocation.id}:direct:${input.actionAdapterIds[item.requestOperation]}`,
            actionAdapterId: input.actionAdapterIds[item.requestOperation],
          }, snapshotRequest),
        });
      },
    }),
  }]);
  const tools = SPECS.map((item) => toolRegistration(item, input.admittedAt));
  return Object.freeze({
    operations: Object.freeze(operations),
    bindings,
    tools: Object.freeze(tools),
  });
}

export function operationRefForCodeFileTool(name: CodeFileToolName): OperationRevisionRef {
  const item = SPECS.find((candidate) => candidate.toolName === name);
  if (item === undefined) throw new TypeError(`Unknown Code Workspace Tool: ${name}.`);
  return item.operation;
}

export function bindingRefForCodeFileTool(
  name: CodeFileToolName,
): OperationBindingRevisionRef {
  const item = SPECS.find((candidate) => candidate.toolName === name);
  if (item === undefined) throw new TypeError(`Unknown Code Workspace Tool: ${name}.`);
  return item.binding;
}

export function codeFileOperationForRef(
  ref: OperationRevisionRef,
): CodeFileOperationKind {
  return specForOperation(ref).requestOperation;
}

interface CodeFileSpec {
  readonly operation: OperationRevisionRef;
  readonly binding: OperationBindingRevisionRef;
  readonly toolName: CodeFileToolName;
  readonly requestOperation: CodeFileOperationKind;
  readonly exposure: "eager_tool" | "workflow_only";
  readonly origins: readonly ("model" | "workflow")[];
}

function spec(
  operationName: string,
  toolName: CodeFileToolName,
  requestOperation: CodeFileOperationKind,
  exposure: CodeFileSpec["exposure"],
  origins: CodeFileSpec["origins"],
): CodeFileSpec {
  const operation = Object.freeze({
    operation: Object.freeze({ namespace: "helarc.code-workspace", name: operationName }),
    revision: REVISION,
  });
  return Object.freeze({
    operation,
    binding: Object.freeze({ operation, revision: BINDING_REVISION }),
    toolName,
    requestOperation,
    exposure,
    origins: Object.freeze([...origins]),
  });
}

function operationRegistration(item: CodeFileSpec, admittedAt: string): RegisteredOperation {
  return {
    admissionId: `helarc.code-workspace.${item.operation.operation.name}.admission.v1`,
    operation: {
      ref: item.operation,
      semanticOwner: "helarc.code-workspace",
      requestSchemaRevision: "1",
      resultSchemaRevision: "1",
      roles: {
        requestOrigins: item.origins.map((origin) => origin === "model" ? "tool_request" as const : "trusted_workflow" as const),
        exposure: item.exposure,
        runControl: "direct",
        trust: "canonical_external_effect",
        participation: "semantic_owner",
        domainPurpose: `code-workspace.${item.requestOperation}`,
      },
    },
    binding: {
      ref: item.binding,
      kind: "direct",
      resolverId: RESOLVER_ID,
      resolverRevision: REVISION,
    },
    sourceRevision: "1",
    allowedRequestOrigins: item.origins.map((origin) => origin === "model" ? "tool_request" as const : "trusted_workflow" as const),
    admittedAt,
    retirement: null,
  };
}

function toolRegistration(item: CodeFileSpec, admittedAt: string): ToolRegistrationInput {
  return {
    admissionId: `helarc.tool.${item.operation.operation.name}.admission.v1`,
    descriptor: {
      ref: {
        tool: { namespace: "helarc.code-agent", name: item.operation.operation.name },
        revision: REVISION,
      },
      name: item.toolName,
      description: description(item.requestOperation),
      inputSchema: schema(item.requestOperation),
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "1",
        output: null,
        translation: "native-1",
      },
      annotations: {
        title: description(item.requestOperation),
        readOnlyHint: !["create", "update", "delete"].includes(item.requestOperation),
        destructiveHint: ["update", "delete"].includes(item.requestOperation),
        idempotentHint: item.requestOperation !== "create",
        openWorldHint: false,
      },
      source: {
        kind: "product",
        sourceId: "helarc.code-workspace",
        sourceRevision: "1",
        activationEpoch: null,
      },
      operationBinding: { operation: item.operation, revision: BINDING_REVISION },
      retirement: null,
      metadata: {
        profile: item.exposure === "workflow_only" ? "workflow" : "read-only",
        requestOperation: item.requestOperation,
      },
    },
    allowedOrigins: item.origins,
    admittedAt,
  };
}

function schema(operation: CodeFileOperationKind): ToolJsonObject {
  const properties: Record<string, ToolJsonObject> = {
    rootName: { type: "string" },
    path: { type: "string" },
  };
  const required = ["path"];
  if (operation === "list") properties.recursive = { type: "boolean" };
  if (operation === "search") {
    properties.query = { type: "string", minLength: 1 };
    required.push("query");
  }
  if (operation === "create" || operation === "update") {
    properties.content = { type: "string" };
    required.push("content");
  }
  if (operation === "update" || operation === "delete") {
    properties.expectedContentDigest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
    required.push("expectedContentDigest");
  }
  return { type: "object", additionalProperties: false, required, properties };
}

function description(operation: CodeFileOperationKind): string {
  return ({
    list: "List files inside a selected Code Workspace root.",
    read: "Read one UTF-8 file inside a selected Code Workspace root.",
    search: "Search UTF-8 files inside a selected Code Workspace root.",
    create: "Create one reviewed UTF-8 file inside a selected Code Workspace root.",
    update: "Replace one reviewed UTF-8 file inside a selected Code Workspace root.",
    delete: "Delete one reviewed file inside a selected Code Workspace root.",
  } as const)[operation];
}

function specForOperation(ref: OperationRevisionRef): CodeFileSpec {
  const key = operationRevisionKey(ref);
  const item = SPECS.find(
    (candidate) => operationRevisionKey(candidate.operation) === key,
  );
  if (item === undefined) {
    throw new TypeError(`Unknown Code Workspace Operation revision: ${key}.`);
  }
  return item;
}

function snapshotRequest<T>(input: T): T {
  return deepFreeze(cloneValue(input)) as T;
}

function cloneValue(input: unknown): unknown {
  if (input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean") return input;
  if (Array.isArray(input)) return input.map(cloneValue);
  if (typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Code file Operation request must contain plain serializable data.");
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, cloneValue(value)]));
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
