import type {
  OperationBindingResolutionInput,
  OperationBindingResolverRegistration,
} from "@agent-anything/operation-catalog/binding";
import { snapshotResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import type { ToolJsonObject } from "@agent-anything/tools/catalog";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";

export const CODE_AGENT_READ_TOOL = "Read";
export const CODE_AGENT_GLOB_TOOL = "Glob";
export const CODE_AGENT_GREP_TOOL = "Grep";
export const CODE_AGENT_EDIT_TOOL = "Edit";
export const CODE_AGENT_WRITE_TOOL = "Write";

export type CodeFileToolName =
  | typeof CODE_AGENT_READ_TOOL
  | typeof CODE_AGENT_GLOB_TOOL
  | typeof CODE_AGENT_GREP_TOOL
  | typeof CODE_AGENT_EDIT_TOOL
  | typeof CODE_AGENT_WRITE_TOOL;

export type CodeFileOperationKind = "read" | "glob" | "grep" | "edit" | "write";

export type CodeFileOperationRequest =
  | {
      readonly operation: "read";
      readonly file_path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly operation: "glob";
      readonly pattern: string;
      readonly path?: string;
    }
  | {
      readonly operation: "grep";
      readonly pattern: string;
      readonly path?: string;
      readonly glob?: string;
      readonly output_mode?: "content" | "files_with_matches" | "count";
      readonly case_sensitive?: boolean;
      readonly before_context?: number;
      readonly after_context?: number;
      readonly offset?: number;
      readonly limit?: number;
      readonly multiline?: boolean;
    }
  | {
      readonly operation: "edit";
      readonly file_path: string;
      readonly old_string: string;
      readonly new_string: string;
      readonly replace_all?: boolean;
    }
  | {
      readonly operation: "write";
      readonly file_path: string;
      readonly content: string;
    };

export interface CodeFileOperationContribution {
  readonly operations: readonly RegisteredOperation[];
  readonly bindings: readonly OperationBindingResolverRegistration[];
  readonly tools: readonly ToolRegistrationInput[];
}

export type CodeFileActionAdapterIds = Readonly<Record<CodeFileOperationKind, string>>;

const REVISION = "2";
const BINDING_REVISION = "2";
const RESOLVER_ID = "helarc.code-agent.file.direct";

const SPECS = Object.freeze([
  spec("read", CODE_AGENT_READ_TOOL, "read"),
  spec("glob", CODE_AGENT_GLOB_TOOL, "glob"),
  spec("grep", CODE_AGENT_GREP_TOOL, "grep"),
  spec("edit", CODE_AGENT_EDIT_TOOL, "edit"),
  spec("write", CODE_AGENT_WRITE_TOOL, "write"),
]);

export function createCodeFileOperationContribution(input: {
  readonly actionAdapterIds: CodeFileActionAdapterIds;
  readonly admittedAt: string;
}): CodeFileOperationContribution {
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
            resolutionFingerprint:
              `${request.context.invocation.id}:direct:${input.actionAdapterIds[item.requestOperation]}`,
            actionAdapterId: input.actionAdapterIds[item.requestOperation],
          }, snapshotRequest),
        });
      },
    }),
  }]);
  return Object.freeze({
    operations: Object.freeze(SPECS.map((item) => operationRegistration(item, input.admittedAt))),
    bindings,
    tools: Object.freeze(SPECS.map((item) => toolRegistration(item, input.admittedAt))),
  });
}

export function operationRefForCodeFileTool(name: CodeFileToolName): OperationRevisionRef {
  const item = SPECS.find((candidate) => candidate.toolName === name);
  if (item === undefined) throw new TypeError(`Unknown Code Agent file Tool: ${name}.`);
  return item.operation;
}

export function bindingRefForCodeFileTool(
  name: CodeFileToolName,
): OperationBindingRevisionRef {
  const item = SPECS.find((candidate) => candidate.toolName === name);
  if (item === undefined) throw new TypeError(`Unknown Code Agent file Tool: ${name}.`);
  return item.binding;
}

export function codeFileOperationForRef(ref: OperationRevisionRef): CodeFileOperationKind {
  return specForOperation(ref).requestOperation;
}

interface CodeFileSpec {
  readonly operation: OperationRevisionRef;
  readonly binding: OperationBindingRevisionRef;
  readonly toolName: CodeFileToolName;
  readonly requestOperation: CodeFileOperationKind;
}

function spec(
  operationName: string,
  toolName: CodeFileToolName,
  requestOperation: CodeFileOperationKind,
): CodeFileSpec {
  const operation = Object.freeze({
    operation: Object.freeze({ namespace: "helarc.code-agent.file", name: operationName }),
    revision: REVISION,
  });
  return Object.freeze({
    operation,
    binding: Object.freeze({ operation, revision: BINDING_REVISION }),
    toolName,
    requestOperation,
  });
}

function operationRegistration(item: CodeFileSpec, admittedAt: string): RegisteredOperation {
  return {
    admissionId: `helarc.code-agent.file.${item.requestOperation}.admission.v2`,
    operation: {
      ref: item.operation,
      semanticOwner: "helarc.code-agent",
      requestSchemaRevision: "2",
      resultSchemaRevision: "2",
      roles: {
        requestOrigins: ["tool_request"],
        exposure: "eager_tool",
        runControl: "direct",
        trust: "canonical_external_effect",
        participation: "semantic_owner",
        domainPurpose: `file.${item.requestOperation}`,
      },
    },
    binding: {
      ref: item.binding,
      kind: "direct",
      resolverId: RESOLVER_ID,
      resolverRevision: REVISION,
    },
    sourceRevision: "2",
    allowedRequestOrigins: ["tool_request"],
    admittedAt,
    retirement: null,
  };
}

function toolRegistration(item: CodeFileSpec, admittedAt: string): ToolRegistrationInput {
  const mutation = item.requestOperation === "edit" || item.requestOperation === "write";
  return {
    admissionId: `helarc.tool.file.${item.requestOperation}.admission.v2`,
    descriptor: {
      ref: {
        tool: { namespace: "helarc.code-agent", name: item.requestOperation },
        revision: REVISION,
      },
      name: item.toolName,
      description: description(item.requestOperation),
      inputSchema: schema(item.requestOperation),
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "2",
        output: "2",
        translation: "native-2",
      },
      annotations: {
        title: item.toolName,
        readOnlyHint: !mutation,
        destructiveHint: mutation,
        idempotentHint: item.requestOperation !== "edit",
        openWorldHint: false,
      },
      source: {
        kind: "product",
        sourceId: "helarc.code-agent",
        sourceRevision: "2",
        activationEpoch: null,
      },
      binding: { kind: "operation", operation: item.operation, revision: BINDING_REVISION },
      retirement: null,
      metadata: {
        profile: mutation ? "workspace-write" : "workspace-read",
        requestOperation: item.requestOperation,
      },
    },
    allowedOrigins: ["model"],
    admittedAt,
  };
}

function schema(operation: CodeFileOperationKind): ToolJsonObject {
  switch (operation) {
    case "read":
      return objectSchema(["file_path"], {
        file_path: pathSchema(),
        offset: positiveInteger(),
        limit: positiveInteger(),
      });
    case "glob":
      return objectSchema(["pattern"], {
        pattern: boundedString(),
        path: pathSchema(),
      });
    case "grep":
      return objectSchema(["pattern"], {
        pattern: boundedString(),
        path: pathSchema(),
        glob: boundedString(),
        output_mode: { enum: ["content", "files_with_matches", "count"] },
        case_sensitive: { type: "boolean" },
        before_context: nonNegativeInteger(),
        after_context: nonNegativeInteger(),
        offset: positiveInteger(),
        limit: positiveInteger(),
        multiline: { type: "boolean" },
      });
    case "edit":
      return objectSchema(["file_path", "old_string", "new_string"], {
        file_path: pathSchema(),
        old_string: { type: "string", minLength: 1 },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      });
    case "write":
      return objectSchema(["file_path", "content"], {
        file_path: pathSchema(),
        content: { type: "string" },
      });
  }
}

function description(operation: CodeFileOperationKind): string {
  return ({
    read: "Read bounded textual content from one exact Workspace file.",
    glob: "Find Workspace paths with one bounded glob pattern.",
    grep: "Search Workspace text with one bounded regular expression.",
    edit: "Replace exact text against one current file baseline.",
    write: "Create or replace complete content for one exact Workspace file.",
  } as const)[operation];
}

function objectSchema(
  required: readonly string[],
  properties: Readonly<Record<string, ToolJsonObject>>,
): ToolJsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: [...required],
    properties: { ...properties },
  };
}

function pathSchema(): ToolJsonObject {
  return { type: "string", minLength: 1, maxLength: 4_096 };
}

function boundedString(): ToolJsonObject {
  return { type: "string", minLength: 1, maxLength: 4_096 };
}

function positiveInteger(): ToolJsonObject {
  return { type: "integer", minimum: 1 };
}

function nonNegativeInteger(): ToolJsonObject {
  return { type: "integer", minimum: 0 };
}

function specForOperation(ref: OperationRevisionRef): CodeFileSpec {
  const key = operationRevisionKey(ref);
  const item = SPECS.find((candidate) => operationRevisionKey(candidate.operation) === key);
  if (item === undefined) throw new TypeError(`Unknown Code Agent file Operation: ${key}.`);
  return item;
}

function snapshotRequest<T>(input: T): T {
  return deepFreeze(cloneValue(input)) as T;
}

function cloneValue(input: unknown): unknown {
  if (
    input === null || typeof input === "string" || typeof input === "number" ||
    typeof input === "boolean"
  ) return input;
  if (Array.isArray(input)) return input.map(cloneValue);
  if (typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Code file Operation request must contain plain serializable data.");
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, cloneValue(value)]),
  );
}

function deepFreeze<T>(input: T): T {
  if (typeof input === "object" && input !== null && !Object.isFrozen(input)) {
    Object.freeze(input);
    for (const value of Object.values(input)) deepFreeze(value);
  }
  return input;
}
