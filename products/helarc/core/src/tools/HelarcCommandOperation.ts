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
import type { ToolJsonObject } from "@agent-anything/tools/catalog";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";

export const HELARC_RUN_COMMAND_TOOL = "codeAgent.runCommand";

export interface HelarcRunCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly rootName?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly reason: string;
}

export interface HelarcRunCommandOutput {
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

export interface HelarcCommandOperationContribution {
  readonly operations: readonly RegisteredOperation[];
  readonly bindings: readonly OperationBindingResolverRegistration[];
  readonly tools: readonly ToolRegistrationInput[];
}

export const HELARC_RUN_COMMAND_OPERATION: OperationRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "run-command" }),
  revision: "1",
});

export const HELARC_RUN_COMMAND_BINDING: OperationBindingRevisionRef = Object.freeze({
  operation: HELARC_RUN_COMMAND_OPERATION,
  revision: "1",
});

const RESOLVER_ID = "helarc.run-command.direct";

export function createHelarcCommandOperationContribution(input: {
  readonly actionAdapterId: string;
  readonly admittedAt: string;
}): HelarcCommandOperationContribution {
  const operation: RegisteredOperation = {
    admissionId: "helarc.run-command.admission.v1",
    operation: {
      ref: HELARC_RUN_COMMAND_OPERATION,
      semanticOwner: "helarc",
      requestSchemaRevision: "1",
      resultSchemaRevision: "1",
      roles: {
        requestOrigins: ["tool_request"],
        exposure: "eager_tool",
        runControl: "direct",
        trust: "canonical_external_effect",
        participation: "semantic_owner",
        domainPurpose: "code-agent.run-command",
      },
    },
    binding: {
      ref: HELARC_RUN_COMMAND_BINDING,
      kind: "direct",
      resolverId: RESOLVER_ID,
      resolverRevision: "1",
    },
    sourceRevision: "1",
    allowedRequestOrigins: ["tool_request"],
    admittedAt: input.admittedAt,
    retirement: null,
  };
  const binding: OperationBindingResolverRegistration = {
    resolver: Object.freeze({
      id: RESOLVER_ID,
      revision: "1",
      async resolve(request: OperationBindingResolutionInput<unknown, unknown>) {
        return Object.freeze({
          status: "resolved" as const,
          binding: snapshotResolvedOperationBinding({
            kind: "direct",
            invocation: request.context.invocation,
            correlation: request.context.correlation,
            parentInvocation: request.context.parentInvocation,
            binding: request.registration.binding.ref,
            request: request.request,
            resolverRevision: "1",
            resolutionFingerprint: `${request.context.invocation.id}:direct:${input.actionAdapterId}`,
            actionAdapterId: input.actionAdapterId,
          }, snapshotRequest),
        });
      },
    }),
  };
  const tool: ToolRegistrationInput = {
    admissionId: "helarc.tool.run-command.admission.v1",
    descriptor: {
      ref: {
        tool: { namespace: "helarc", name: "run-command" },
        revision: "1",
      },
      name: HELARC_RUN_COMMAND_TOOL,
      description: "Run one process inside a selected Code Workspace root.",
      inputSchema: commandSchema(),
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "1",
        output: "1",
        translation: "native-1",
      },
      annotations: {
        title: "Run command",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      source: {
        kind: "product",
        sourceId: "helarc",
        sourceRevision: "1",
        activationEpoch: null,
      },
      operationBinding: HELARC_RUN_COMMAND_BINDING,
      retirement: null,
      metadata: { profile: "shell-enabled" },
    },
    allowedOrigins: ["model"],
    admittedAt: input.admittedAt,
  };
  return Object.freeze({
    operations: Object.freeze([operation]),
    bindings: Object.freeze([binding]),
    tools: Object.freeze([tool]),
  });
}

function commandSchema(): ToolJsonObject {
  return {
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
}

function snapshotRequest<T>(input: T): T {
  return deepFreeze(structuredClone(input));
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
