import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import {
  snapshotResolvedOperationBinding,
  type OperationBindingResolutionInput,
  type OperationBindingResolverRegistration,
} from "@agent-anything/operation-catalog/binding";
import type { RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type {
  OperationBindingRevisionRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import type { OperationResult } from "@agent-anything/operation-catalog/result";
import {
  snapshotCompositeDefinition,
  type CompositeDefinitionRevision,
} from "@agent-anything/operation-composition/definition";
import type { CompositeExecutionDependencies } from "@agent-anything/operation-composition/execution";
import type { ToolJsonObject } from "@agent-anything/tools/catalog";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import type { ValidationOwnerRef } from "@agent-anything/validation/definition";

export const HELARC_RUN_VALIDATION_CHECK_TOOL = "codeAgent.runValidationCheck";

export const HELARC_RUN_VALIDATION_CHECK_OPERATION: OperationRevisionRef = Object.freeze({
  operation: Object.freeze({ namespace: "helarc", name: "run-validation-check" }),
  revision: "1",
});

export const HELARC_RUN_VALIDATION_CHECK_BINDING: OperationBindingRevisionRef = Object.freeze({
  operation: HELARC_RUN_VALIDATION_CHECK_OPERATION,
  revision: "1",
});

export type HelarcValidationClaim =
  | "tests"
  | "static_analysis"
  | "runtime_verification"
  | "security_scan"
  | "performance_benchmark";

export interface HelarcRunValidationCheckRequest {
  readonly claim: HelarcValidationClaim;
  readonly command: string;
  readonly timeout_ms?: number;
  readonly description?: string;
}

export interface HelarcValidationCheckConfiguration {
  readonly ref: ValidationOwnerRef;
  readonly runAction: RunActionRef;
  readonly request: HelarcRunValidationCheckRequest;
}

export interface HelarcValidationCheckConfigurationRegistry {
  register(
    runAction: RunActionRef,
    request: HelarcRunValidationCheckRequest,
  ): HelarcValidationCheckConfiguration;
  resolve(ref: ValidationOwnerRef): HelarcValidationCheckConfiguration | null;
}

export interface HelarcValidationCheckOperationContribution {
  readonly operations: readonly RegisteredOperation[];
  readonly bindings: readonly OperationBindingResolverRegistration[];
  readonly tools: readonly ToolRegistrationInput[];
  readonly composite: {
    resolve(ref: string): {
      readonly definition: CompositeDefinitionRevision;
      readonly execution: Omit<CompositeExecutionDependencies, "children">;
    } | null;
  };
}

const COMPOSITE_DEFINITION_REF = "helarc.validation.command-check.v1";
const COMPOSITE_DEFINITION = snapshotCompositeDefinition({
  ref: { id: "helarc.validation.command-check", revision: "1" },
  inputSchemaRevision: "1",
  resultSchemaRevision: "1",
  graphRevision: "1",
  nodes: Object.freeze([Object.freeze({
    id: "run-command",
    operation: Object.freeze({
      operation: Object.freeze({ namespace: "helarc", name: "shell-execute" }),
      revision: "1",
    }),
    allowedBindings: Object.freeze(["direct" as const]),
    dependencies: Object.freeze([]),
    transformId: "helarc.validation.command-request",
    conditionId: null,
    resourceClaims: Object.freeze([Object.freeze({
      family: "process",
      identity: "selected-workspace-command",
      access: "mutate" as const,
    })]),
    required: true,
  })]),
  join: Object.freeze({ kind: "all_required_succeeded" as const }),
  reducerId: "helarc.validation.command-result",
  conflictPolicyRevision: "1",
  limits: Object.freeze({ maxNodes: 1, maxParallel: 1 }),
  cancellationPolicy: "cancel_unstarted_and_signal_active",
  sensitivity: "sensitive",
  retiredAt: null,
});

export function createHelarcValidationCheckConfigurationRegistry(): HelarcValidationCheckConfigurationRegistry {
  const configurations = new Map<string, HelarcValidationCheckConfiguration>();
  return Object.freeze({
    register(runAction, request) {
      const parsed = parseHelarcRunValidationCheckRequest(request);
      const ref: ValidationOwnerRef = Object.freeze({
        owner: "helarc",
        kind: "validation_check_configuration",
        id: `command-${runAction.id}`,
        revision: "1",
      });
      const key = ownerKey(ref);
      const existing = configurations.get(key);
      if (existing !== undefined) {
        if (JSON.stringify(existing.request) !== JSON.stringify(parsed)) {
          throw new TypeError("Validation Check configuration identity was reused with different input.");
        }
        return existing;
      }
      const configuration = deepFreeze({ ref, runAction, request: parsed });
      configurations.set(key, configuration);
      return configuration;
    },
    resolve(ref) {
      return configurations.get(ownerKey(ref)) ?? null;
    },
  } satisfies HelarcValidationCheckConfigurationRegistry);
}

export function createHelarcValidationCheckOperationContribution(input: {
  readonly admittedAt: string;
  readonly registry: HelarcValidationCheckConfigurationRegistry;
}): HelarcValidationCheckOperationContribution {
  requireIsoDate(input.admittedAt);
  const operation: RegisteredOperation = {
    admissionId: "helarc.run-validation-check.admission.v1",
    operation: {
      ref: HELARC_RUN_VALIDATION_CHECK_OPERATION,
      semanticOwner: "helarc",
      requestSchemaRevision: "1",
      resultSchemaRevision: "1",
      roles: {
        requestOrigins: ["tool_request", "trusted_workflow", "automatic_stage"],
        exposure: "eager_tool",
        runControl: "direct",
        trust: "canonical_external_effect",
        participation: "semantic_owner",
        domainPurpose: "code-agent.validation-check",
      },
    },
    binding: {
      ref: HELARC_RUN_VALIDATION_CHECK_BINDING,
      kind: "composite",
      resolverId: "helarc.run-validation-check.composite",
      resolverRevision: "1",
    },
    sourceRevision: "1",
    allowedRequestOrigins: ["tool_request", "trusted_workflow", "automatic_stage"],
    admittedAt: input.admittedAt,
    retirement: null,
  };
  const binding: OperationBindingResolverRegistration = {
    resolver: Object.freeze({
      id: "helarc.run-validation-check.composite",
      revision: "1",
      async resolve(request: OperationBindingResolutionInput<unknown, unknown>) {
        return Object.freeze({
          status: "resolved" as const,
          binding: snapshotResolvedOperationBinding({
            kind: "composite",
            invocation: request.context.invocation,
            correlation: request.context.correlation,
            parentInvocation: request.context.parentInvocation,
            binding: request.registration.binding.ref,
            request: request.request,
            resolverRevision: "1",
            resolutionFingerprint: `${request.context.invocation.id}:validation-command-check`,
            compositeDefinitionRef: COMPOSITE_DEFINITION_REF,
          }, snapshotValue),
        });
      },
    }),
  };
  const tool: ToolRegistrationInput = {
    admissionId: "helarc.tool.run-validation-check.admission.v1",
    descriptor: {
      ref: {
        tool: { namespace: "helarc", name: "run-validation-check" },
        revision: "1",
      },
      name: HELARC_RUN_VALIDATION_CHECK_TOOL,
      description: "Run one admitted engineering validation command and assess its declared claim.",
      inputSchema: validationCheckSchema(),
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "1",
        output: "1",
        translation: "native-1",
      },
      annotations: {
        title: "Run validation check",
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
      binding: { kind: "operation", ...HELARC_RUN_VALIDATION_CHECK_BINDING },
      retirement: null,
      metadata: { profile: "code-agent", purpose: "validation" },
    },
    allowedOrigins: ["model", "workflow"],
    admittedAt: input.admittedAt,
  };
  return Object.freeze({
    operations: Object.freeze([operation]),
    bindings: Object.freeze([binding]),
    tools: Object.freeze([tool]),
    composite: Object.freeze({
      resolve(ref: string) {
        if (ref !== COMPOSITE_DEFINITION_REF) return null;
        return Object.freeze({
          definition: COMPOSITE_DEFINITION,
          execution: Object.freeze({
            transforms: Object.freeze([Object.freeze({
              id: "helarc.validation.command-request",
              transform({ compositeInput }: { readonly compositeInput: unknown }) {
                const configuration = resolveCompositeConfiguration(compositeInput, input.registry);
                return Object.freeze({
                  command: configuration.request.command,
                  validation_claim: configuration.request.claim,
                  ...(configuration.request.timeout_ms === undefined ? {} : { timeout_ms: configuration.request.timeout_ms }),
                  ...(configuration.request.description === undefined ? {} : { description: configuration.request.description }),
                });
              },
            })]),
            conditions: Object.freeze([]),
            reducer: Object.freeze({
              id: "helarc.validation.command-result",
              reduce(reduction: { readonly compositeInput: unknown; readonly children: readonly { readonly result: OperationResult | null }[] }) {
                const configuration = resolveCompositeConfiguration(reduction.compositeInput, input.registry);
                const child = reduction.children[0]?.result ?? null;
                return projectValidationCommandResult(configuration, child);
              },
            }),
            conflicts: null,
          }),
        });
      },
    }),
  });
}

export function parseHelarcRunValidationCheckRequest(value: unknown): HelarcRunValidationCheckRequest {
  if (!isRecord(value)) throw new TypeError("Validation Check request must be an object.");
  const allowed = new Set(["claim", "command", "timeout_ms", "description"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("Validation Check request contains unsupported fields.");
  }
  if (!VALIDATION_CLAIMS.includes(value.claim as HelarcValidationClaim)) {
    throw new TypeError("Validation Check claim is unsupported.");
  }
  if (typeof value.command !== "string" || value.command.trim().length === 0 ||
      (value.description !== undefined && (typeof value.description !== "string" || value.description.trim().length === 0)) ||
      (value.timeout_ms !== undefined && (!Number.isSafeInteger(value.timeout_ms) || (value.timeout_ms as number) < 1))) {
    throw new TypeError("Validation Check command input is invalid.");
  }
  return deepFreeze({
    claim: value.claim as HelarcValidationClaim,
    command: value.command,
    ...(value.timeout_ms === undefined ? {} : { timeout_ms: value.timeout_ms as number }),
    ...(value.description === undefined ? {} : { description: value.description as string }),
  });
}

function resolveCompositeConfiguration(
  value: unknown,
  registry: HelarcValidationCheckConfigurationRegistry,
): HelarcValidationCheckConfiguration {
  if (!isRecord(value) || !isOwnerRef(value.configuration)) {
    throw new TypeError("Validation Check Operation requires exact configuration correlation.");
  }
  const configuration = registry.resolve(value.configuration);
  if (configuration === null) {
    throw new TypeError("Validation Check configuration is unavailable.");
  }
  return configuration;
}

function projectValidationCommandResult(
  configuration: HelarcValidationCheckConfiguration,
  child: OperationResult | null,
) {
  const output = child?.output;
  const command = isRecord(output) &&
      output.mode === "foreground" &&
      (typeof output.exit_code === "number" || output.exit_code === null) &&
      (typeof output.signal === "string" || output.signal === null) &&
      typeof output.duration_ms === "number" &&
      typeof output.stdout_truncated === "boolean" &&
      typeof output.stderr_truncated === "boolean"
    ? Object.freeze({
        exitCode: output.exit_code as number | null,
        signal: output.signal as string | null,
        durationMs: output.duration_ms,
        stdoutTruncated: output.stdout_truncated,
        stderrTruncated: output.stderr_truncated,
        settlementConfirmed: true,
      })
    : null;
  return Object.freeze({
    claim: configuration.request.claim,
    childOperationResultId: child?.ref.id ?? null,
    command,
  });
}

function validationCheckSchema(): ToolJsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["claim", "command"],
    properties: {
      claim: { type: "string", enum: [...VALIDATION_CLAIMS] },
      command: { type: "string", minLength: 1 },
      timeout_ms: { type: "integer", minimum: 1 },
      description: { type: "string", minLength: 1 },
    },
  };
}

const VALIDATION_CLAIMS: readonly HelarcValidationClaim[] = Object.freeze([
  "tests",
  "static_analysis",
  "runtime_verification",
  "security_scan",
  "performance_benchmark",
]);

function isOwnerRef(value: unknown): value is ValidationOwnerRef {
  return isRecord(value) && typeof value.owner === "string" && typeof value.kind === "string" &&
    typeof value.id === "string" && typeof value.revision === "string";
}

function ownerKey(ref: ValidationOwnerRef): string {
  return `${ref.owner}:${ref.kind}:${ref.id}@${ref.revision}`;
}

function snapshotValue<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIsoDate(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError("Validation Check admission time must be an ISO date-time.");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
