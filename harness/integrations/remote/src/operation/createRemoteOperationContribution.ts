import {
  createPreparedAction,
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
} from "@agent-anything/canonical-action/registration";
import {
  createCanonicalRemoteServerIdentity,
  createCanonicalRemoteToolIdentity,
  createCanonicalSha256Digest,
  type CanonicalRemoteSourceRef,
  type CanonicalRemoteToolIdentity,
  type PreparedActionInvocation,
  type SerializableValue,
  type TargetStateAssertion,
} from "@agent-anything/canonical-action/subject";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import {
  snapshotResolvedOperationBinding,
  type OperationBindingResolutionInput,
  type OperationBindingResolverRegistration,
} from "@agent-anything/operation-catalog/binding";
import type {
  OperationRequestOrigin,
  RegisteredOperation,
} from "@agent-anything/operation-catalog/catalog";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import type { ToolRegistrationInput } from "@agent-anything/tools/registration";
import type {
  CreateRemoteOperationContributionInput,
  PreparedRemoteOperationInvocationPayload,
  RemoteOperationContribution,
  RemoteOperationRegistrationResolver,
  RemotePhysicalResult,
  TrustedRemoteOperationRegistration,
} from "./RemoteOperationContribution.js";

interface RemoteSemanticBasis {
  readonly target: CanonicalRemoteToolIdentity;
}

export function createRemoteOperationContribution<TOutput = unknown>(
  input: CreateRemoteOperationContributionInput<TOutput>,
): RemoteOperationContribution {
  const registration = normalizeRegistration(input.registration);
  const resolver = input.registrationResolver ?? staticResolver(registration);
  const descriptors = createDescriptors(registration);
  const actionRegistrations = createActionRegistrationSnapshot([{
    registrationId: `${descriptorStem(registration)}.registration`,
    revision: registration.registrationRevision,
    operation: registration.operation,
    binding: registration.binding,
    adapter: descriptors.adapter,
    executor: descriptors.executor,
    effectFamilies: registration.server.endpoint === null
      ? ["remote_invocation"]
      : ["network", "remote_invocation"],
    sandboxRequirementRevision: "remote.operation.sandbox.v1",
    maxInvocationBytes: 512_000,
    maxPhysicalResultBytes: 2_000_000,
  }]);
  const adapter = createAdapter(registration, resolver, descriptors);
  return Object.freeze({
    operations: Object.freeze([operationRegistration(registration)]),
    bindings: Object.freeze([bindingRegistration(registration, resolver, descriptors)]),
    tools: Object.freeze(registration.localTool === null
      ? []
      : [toolRegistration(registration)]),
    actionRegistrations,
    adapters: Object.freeze([Object.freeze({ adapter })]),
    executors: Object.freeze([
      createExecutor(
        registration,
        resolver,
        descriptors,
        input.transport,
        input.now ?? (() => new Date().toISOString()),
      ),
    ]),
  });
}

function operationRegistration(
  registration: TrustedRemoteOperationRegistration,
): RegisteredOperation {
  return Object.freeze({
    admissionId: `${descriptorStem(registration)}.operation.admission`,
    operation: Object.freeze({
      ref: registration.operation,
      semanticOwner: registration.semanticOwner,
      requestSchemaRevision: registration.localTool?.schemaRevisions.input ?? "1",
      resultSchemaRevision: registration.localTool?.schemaRevisions.output ?? "1",
      roles: Object.freeze({
        requestOrigins: registration.allowedRequestOrigins,
        exposure: registration.localTool === null
          ? "non_tool" as const
          : "eager_tool" as const,
        runControl: registration.bindingKind,
        trust: "remote_hosted_trust_edge" as const,
        participation: "semantic_owner" as const,
        domainPurpose: `remote.${registration.source.kind}.${registration.remoteOperationName}`,
      }),
    }),
    binding: Object.freeze({
      ref: registration.binding,
      kind: registration.bindingKind,
      resolverId: `${descriptorStem(registration)}.resolver`,
      resolverRevision: registration.registrationRevision,
    }),
    sourceRevision: registration.registrationRevision,
    allowedRequestOrigins: registration.allowedRequestOrigins,
    admittedAt: registration.admittedAt,
    retirement: null,
  });
}

function bindingRegistration(
  expected: TrustedRemoteOperationRegistration,
  resolver: RemoteOperationRegistrationResolver,
  descriptors: ReturnType<typeof createDescriptors>,
): OperationBindingResolverRegistration {
  const implementation = Object.freeze({
    id: `${descriptorStem(expected)}.resolver`,
    revision: expected.registrationRevision,
    async resolve(input: OperationBindingResolutionInput<unknown, unknown>) {
      const current = await resolveCurrent(
        resolver,
        expected.source,
        expected.server.serverId,
        expected.remoteOperationName,
      );
      if (!sameRegistration(current, expected)) {
        return Object.freeze({
          status: "unavailable" as const,
          code: "resolver_unavailable" as const,
          resolverId: implementation.id,
        });
      }
      const base = {
        invocation: input.context.invocation,
        correlation: input.context.correlation,
        parentInvocation: input.context.parentInvocation,
        binding: input.registration.binding.ref,
        request: snapshotSerializable(input.request),
        resolverRevision: expected.registrationRevision,
        resolutionFingerprint: `${input.context.invocation.id}:${expected.registrationRevision}:${expected.server.registrationFingerprint}`,
        actionAdapterId: descriptors.adapter.id,
      };
      return Object.freeze({
        status: "resolved" as const,
        binding: snapshotResolvedOperationBinding(
          expected.bindingKind === "hosted"
            ? {
                ...base,
                kind: "hosted" as const,
                hostedEndpointRef: expected.hostedEndpointRef!,
              }
            : { ...base, kind: "direct" as const },
          snapshotSerializable,
        ),
      });
    },
  });
  return Object.freeze({ resolver: implementation });
}

function toolRegistration(
  registration: TrustedRemoteOperationRegistration,
): ToolRegistrationInput {
  const tool = registration.localTool!;
  return Object.freeze({
    admissionId: `${descriptorStem(registration)}.tool.admission`,
    descriptor: Object.freeze({
      ref: tool.ref,
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      schemaRevisions: tool.schemaRevisions,
      annotations: tool.annotations,
      source: Object.freeze({
        kind: registration.source.kind,
        sourceId: registration.source.sourceId,
        sourceRevision: registration.source.sourceRevision,
        activationEpoch: registration.source.activationEpoch,
      }),
      operationBinding: registration.binding,
      retirement: null,
      metadata: Object.freeze({
        remoteServerId: registration.server.serverId,
        remoteOperationName: registration.remoteOperationName,
      }),
    }),
    allowedOrigins: tool.allowedOrigins,
    admittedAt: registration.admittedAt,
  });
}

function createAdapter(
  expected: TrustedRemoteOperationRegistration,
  resolver: RemoteOperationRegistrationResolver,
  descriptors: ReturnType<typeof createDescriptors>,
): OperationActionAdapter<SerializableValue, RemoteSemanticBasis> {
  const adapter: OperationActionAdapter<SerializableValue, RemoteSemanticBasis> = {
    descriptor: descriptors.adapter,
    async prepare(binding, context) {
      if (context.interruption.signal.aborted) {
        return preparationFailure("interrupted", "remote_preparation_interrupted", "Remote Operation preparation was interrupted.");
      }
      try {
        const current = await resolveCurrent(
          resolver,
          expected.source,
          expected.server.serverId,
          expected.remoteOperationName,
        );
        if (!sameRegistration(current, expected)) {
          return preparationFailure("unavailable", "remote_registration_changed", "Remote Operation registration changed before preparation.");
        }
        const request = snapshotSerializable(binding.request);
        const target = remoteTarget(current);
        const applicability = await createCanonicalSha256Digest(
          "agent-anything.remote-operation.applicability.v1",
          {
            source: current.source,
            server: current.server,
            operation: current.remoteOperationName,
          },
        );
        const prepared = await createPreparedAction(binding, context, {
          effectSet: {
            kind: "effects",
            values: [
              { kind: "remote_tool", operation: "invoke", target },
              ...(current.server.endpoint === null
                ? []
                : [{
                    kind: "network" as const,
                    operation: "connect" as const,
                    endpoints: [current.server.endpoint],
                  }]),
            ],
          },
          requestedAuthority: null,
          targetAssertions: [{ kind: "remote_tool_identity", expected: target }],
          approval: {
            category: "remoteToolCall",
            environmentId: context.environment.environmentId,
            applicabilityKeys: [{ category: "remoteToolCall", value: applicability }],
            reason: `Invoke ${current.remoteOperationDisplayName}.`,
            payload: {
              source: {
                ...current.source,
                displayName: current.sourceDisplayName,
              },
              server: {
                ...current.server,
                displayName: current.serverDisplayName,
              },
              tool: {
                name: current.remoteOperationName,
                displayName: current.remoteOperationDisplayName,
              },
              safeArguments: {},
              annotations: {
                readOnlyHint: current.localTool?.annotations?.readOnlyHint ?? null,
                destructiveHint: current.localTool?.annotations?.destructiveHint ?? null,
                idempotentHint: current.localTool?.annotations?.idempotentHint ?? null,
                openWorldHint: current.localTool?.annotations?.openWorldHint ?? null,
              },
              supportsSessionAuthority: current.supportsSessionAuthority,
            },
            decisionOptions: approvalOptions(),
            trustedProposals: [],
            deadlineAt: new Date(Date.parse(context.now()) + 120_000).toISOString(),
            metadata: {},
          },
          safeSummary: {
            kind: "remote_tool",
            headline: "Invoke remote operation",
            sourceKind: current.source.kind,
            sourceDisplayName: current.sourceDisplayName,
            serverDisplayName: current.serverDisplayName,
            toolDisplayName: current.remoteOperationDisplayName,
          },
          preparedInvocation: {
            contractVersion: descriptors.executor.invocationContractVersion,
            executorId: descriptors.executor.id,
            executorVersion: descriptors.executor.version,
            payload: {
              operationInvocationId: binding.invocation.id,
              source: current.source,
              server: current.server,
              remoteOperationName: current.remoteOperationName,
              input: request,
              timeoutMs: current.timeoutMs,
            } as unknown as SerializableValue,
          },
          replayBasis: "none",
          semanticBasis: { target },
        } satisfies ActionAdapterPreparedData<RemoteSemanticBasis>);
        return Object.freeze({ status: "prepared" as const, prepared });
      } catch (error) {
        return preparationFailure(
          "failed",
          "remote_preparation_failed",
          safeMessage(error, "Remote Operation preparation failed."),
        );
      }
    },
    async revalidate(prepared, assertions, context) {
      if (context.interruption.signal.aborted) {
        return revalidationFailure("interrupted", "remote_revalidation_interrupted");
      }
      try {
        const current = await resolveCurrent(
          resolver,
          expected.source,
          expected.server.serverId,
          expected.remoteOperationName,
        );
        const assertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "remote_tool_identity" }> =>
            candidate.kind === "remote_tool_identity",
        );
        if (
          assertion === undefined ||
          !sameRegistration(current, expected) ||
          !sameRemoteTarget(assertion.expected, prepared.semanticBasis.target)
        ) {
          return revalidationFailure("invalidated", "remote_registration_changed");
        }
        return Object.freeze({
          status: "valid" as const,
          recordId: `revalidation:${context.action.id}:${context.subjectRevision}`,
        });
      } catch {
        return revalidationFailure("failed", "remote_revalidation_failed");
      }
    },
    async settle(prepared, settlement) {
      return settleRemoteOperation(expected, prepared, settlement);
    },
  };
  return Object.freeze(adapter);
}

function createExecutor<TOutput>(
  expected: TrustedRemoteOperationRegistration,
  resolver: RemoteOperationRegistrationResolver,
  descriptors: ReturnType<typeof createDescriptors>,
  transport: CreateRemoteOperationContributionInput<TOutput>["transport"],
  now: () => string,
): ActionExecutor<PreparedActionInvocation, RemotePhysicalResult<TOutput>> {
  const executor: ActionExecutor<PreparedActionInvocation, RemotePhysicalResult<TOutput>> = {
    descriptor: descriptors.executor,
    validatePayload(candidate): candidate is RemotePhysicalResult<TOutput> {
      return isRemotePhysicalResult(candidate);
    },
    async execute(invocation, context): Promise<PhysicalAttemptOutcome<RemotePhysicalResult<TOutput>>> {
      assertActionExecutorDispatchContext(context);
      const startedAt = now();
      let dispatched = false;
      try {
        const payload = readPayload(invocation, descriptors.executor);
        if (context.interruption.signal.aborted) {
          return interrupted("none", "remote_interrupted_before_dispatch");
        }
        const current = await resolveCurrent(
          resolver,
          payload.source,
          payload.server.serverId,
          payload.remoteOperationName,
        );
        if (!sameRegistration(current, expected)) {
          return failed("none", "remote_registration_changed", "Remote Operation registration changed before dispatch.", false);
        }
        if (context.interruption.signal.aborted) {
          return interrupted("none", "remote_interrupted_before_dispatch");
        }
        dispatched = true;
        const outcome = await transport.invoke({
          actionId: context.attempt.action.id,
          operationInvocationId: payload.operationInvocationId,
          sourceKind: payload.source.kind,
          sourceId: payload.source.sourceId,
          serverId: payload.server.serverId,
          remoteOperationName: payload.remoteOperationName,
          input: payload.input,
          timeoutMs: payload.timeoutMs,
          signal: context.interruption.signal,
        });
        if (outcome.status === "failed") {
          return Object.freeze({
            status: "failed" as const,
            effectState: outcome.effectState,
            failure: freezeEvidence(outcome.failure),
          });
        }
        if (outcome.status === "interrupted" || outcome.status === "timed_out") {
          return Object.freeze({
            status: outcome.status,
            effectState: outcome.effectState,
            evidence: freezeEvidence(outcome.evidence),
          });
        }
        const physical: RemotePhysicalResult<TOutput> = Object.freeze({
          output: snapshotSerializable(outcome.output) as TOutput,
          semanticError: outcome.semanticError === null
            ? null
            : Object.freeze({
                code: requiredText(outcome.semanticError.code, "semanticError.code"),
                message: requiredText(outcome.semanticError.message, "semanticError.message"),
                metadata: snapshotMetadata(outcome.semanticError.metadata),
              }),
          metadata: snapshotMetadata(outcome.metadata),
          startedAt,
          finishedAt: now(),
        });
        return Object.freeze({
          status: "completed" as const,
          effectState: "settled" as const,
          payload: physical,
        });
      } catch (error) {
        return failed(
          dispatched ? "unknown" : "none",
          dispatched ? "remote_settlement_unknown" : "remote_dispatch_failed",
          safeMessage(error, "Remote Operation dispatch failed."),
          !dispatched,
        );
      }
    },
  };
  return Object.freeze(executor);
}

function settleRemoteOperation<TOutput>(
  registration: TrustedRemoteOperationRegistration,
  _prepared: PreparedAction<RemoteSemanticBasis>,
  settlement: CanonicalActionSettlement,
): ActionSemanticResult<TOutput> {
  const payload = isRemotePhysicalResult<TOutput>(settlement.payload)
    ? settlement.payload
    : null;
  if (settlement.status === "succeeded" && payload?.semanticError !== null) {
    return Object.freeze({
      operationInvocationId: settlement.operationInvocation.id,
      settlement,
      status: "failed" as const,
      output: null,
      failure: {
        owner: registration.semanticOwner,
        code: payload?.semanticError.code ?? "remote_semantic_result_missing",
        message: payload?.semanticError.message ?? "Remote Operation semantic result is missing.",
      },
    });
  }
  const status: ActionSemanticResult["status"] = settlement.status === "invalidated"
    ? "invalid"
    : settlement.status;
  const hasOutput = status === "succeeded" || status === "partial";
  return Object.freeze({
    operationInvocationId: settlement.operationInvocation.id,
    settlement,
    status,
    output: hasOutput ? payload?.output as TOutput ?? null : null,
    failure: status === "succeeded"
      ? null
      : {
          owner: settlement.causeOwner ?? registration.semanticOwner,
          code: settlement.causeRef ?? `remote_${status}`,
          message: settlement.causeRef ?? `Remote Operation ${status}.`,
        },
  });
}

function normalizeRegistration(
  input: TrustedRemoteOperationRegistration,
): TrustedRemoteOperationRegistration {
  if (operationRevisionKey(input.operation) !== operationRevisionKey(input.binding.operation)) {
    throw new TypeError("Remote Operation binding must belong to its Operation revision.");
  }
  if (input.bindingKind === "hosted" && input.hostedEndpointRef === null) {
    throw new TypeError("Hosted remote Operation requires a hosted endpoint reference.");
  }
  if (input.bindingKind === "direct" && input.hostedEndpointRef !== null) {
    throw new TypeError("Direct remote Operation cannot carry a hosted endpoint reference.");
  }
  const server = createCanonicalRemoteServerIdentity(input.server);
  const target = createCanonicalRemoteToolIdentity({
    source: input.source,
    server,
    toolName: input.remoteOperationName,
  });
  if (input.timeoutMs !== null && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) {
    throw new TypeError("Remote Operation timeout must be a positive safe integer or null.");
  }
  if (input.allowedRequestOrigins.length === 0) {
    throw new TypeError("Remote Operation requires at least one request origin.");
  }
  assertToolOrigins(input.localTool?.allowedOrigins ?? [], input.allowedRequestOrigins);
  requiredText(input.semanticOwner, "semanticOwner");
  requiredText(input.sourceDisplayName, "sourceDisplayName");
  requiredText(input.serverDisplayName, "serverDisplayName");
  requiredText(input.remoteOperationDisplayName, "remoteOperationDisplayName");
  requiredText(input.registrationRevision, "registrationRevision");
  return deepFreeze({
    ...input,
    source: target.source,
    server,
    allowedRequestOrigins: [...new Set(input.allowedRequestOrigins)].sort(),
    localTool: input.localTool === null
      ? null
      : {
          ...input.localTool,
          inputSchema: snapshotSerializable(input.localTool.inputSchema),
          ...(input.localTool.outputSchema === undefined
            ? {}
            : { outputSchema: snapshotSerializable(input.localTool.outputSchema) }),
          annotations: input.localTool.annotations === undefined
            ? undefined
            : { ...input.localTool.annotations },
          allowedOrigins: [...new Set(input.localTool.allowedOrigins)].sort(),
        },
  }) as TrustedRemoteOperationRegistration;
}

function staticResolver(
  registration: TrustedRemoteOperationRegistration,
): RemoteOperationRegistrationResolver {
  const resolver: RemoteOperationRegistrationResolver = {
    async resolve(source, serverId, remoteOperationName) {
      return sameSource(source, registration.source) &&
        serverId === registration.server.serverId &&
        remoteOperationName === registration.remoteOperationName
        ? registration
        : null;
    },
  };
  return Object.freeze(resolver);
}

async function resolveCurrent(
  resolver: RemoteOperationRegistrationResolver,
  source: CanonicalRemoteSourceRef,
  serverId: string,
  remoteOperationName: string,
): Promise<TrustedRemoteOperationRegistration> {
  const current = await resolver.resolve(source, serverId, remoteOperationName);
  if (current === null) {
    throw new Error("Remote Operation registration is unavailable.");
  }
  return normalizeRegistration(current);
}

function createDescriptors(registration: TrustedRemoteOperationRegistration) {
  const stem = descriptorStem(registration);
  const adapter: ActionAdapterDescriptor = Object.freeze({
    id: `${stem}.adapter`,
    version: registration.registrationRevision,
    requestSchemaRevision: registration.localTool?.schemaRevisions.input ?? "1",
  });
  const executor: ActionExecutorDescriptor = Object.freeze({
    id: `${stem}.executor`,
    version: registration.registrationRevision,
    invocationContractVersion: "1",
    physicalPayloadSchemaRevision: "1",
  });
  return Object.freeze({ adapter, executor });
}

function descriptorStem(registration: TrustedRemoteOperationRegistration): string {
  return `remote.${registration.source.kind}.${registration.source.sourceId}.${registration.server.serverId}.${registration.remoteOperationName}.${registration.registrationRevision}`;
}

function remoteTarget(
  registration: TrustedRemoteOperationRegistration,
): CanonicalRemoteToolIdentity {
  return createCanonicalRemoteToolIdentity({
    source: registration.source,
    server: registration.server,
    toolName: registration.remoteOperationName,
  });
}

function sameRegistration(
  left: TrustedRemoteOperationRegistration,
  right: TrustedRemoteOperationRegistration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRemoteTarget(
  left: CanonicalRemoteToolIdentity,
  right: CanonicalRemoteToolIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSource(
  left: CanonicalRemoteSourceRef,
  right: CanonicalRemoteSourceRef,
): boolean {
  return left.kind === right.kind &&
    left.sourceId === right.sourceId &&
    left.sourceRevision === right.sourceRevision &&
    left.activationEpoch === right.activationEpoch &&
    left.capabilityId === right.capabilityId;
}

function readPayload(
  invocation: PreparedActionInvocation,
  executor: ActionExecutorDescriptor,
): PreparedRemoteOperationInvocationPayload {
  if (
    invocation.executorId !== executor.id ||
    invocation.executorVersion !== executor.version ||
    invocation.contractVersion !== executor.invocationContractVersion
  ) {
    throw new TypeError("Prepared remote Operation executor identity is invalid.");
  }
  const value = exactRecord(invocation.payload, [
    "operationInvocationId",
    "source",
    "server",
    "remoteOperationName",
    "input",
    "timeoutMs",
  ]);
  const server = createCanonicalRemoteServerIdentity(value.server as never);
  const target = createCanonicalRemoteToolIdentity({
    source: value.source as never,
    server,
    toolName: requiredText(value.remoteOperationName, "remoteOperationName"),
  });
  return Object.freeze({
    operationInvocationId: requiredText(value.operationInvocationId, "operationInvocationId"),
    source: target.source,
    server,
    remoteOperationName: target.toolName,
    input: snapshotSerializable(value.input) as SerializableValue,
    timeoutMs: value.timeoutMs === null
      ? null
      : positiveInteger(value.timeoutMs, "timeoutMs"),
  });
}

function approvalOptions() {
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

function preparationFailure(
  status: "invalid" | "unavailable" | "failed" | "interrupted",
  code: string,
  message: string,
) {
  return Object.freeze({
    status,
    owner: "remote-integrations",
    code,
    message,
  });
}

function revalidationFailure(
  status: "invalidated" | "failed" | "interrupted",
  code: string,
): ActionRevalidationResult {
  return Object.freeze({
    status,
    owner: "remote-integrations",
    code,
    recordId: `revalidation:${code}`,
  });
}

function interrupted(
  effectState: "none" | "settled" | "unknown",
  code: string,
): PhysicalAttemptOutcome<never> {
  return Object.freeze({
    status: "interrupted" as const,
    effectState,
    evidence: Object.freeze({ code, message: "Remote Operation was interrupted.", metadata: {} }),
  });
}

function failed(
  effectState: "none" | "settled" | "unknown",
  code: string,
  message: string,
  retryable: boolean,
): PhysicalAttemptOutcome<never> {
  return Object.freeze({
    status: "failed" as const,
    effectState,
    failure: Object.freeze({ code, message, retryable, metadata: {} }),
  });
}

function freezeEvidence<T extends {
  readonly code: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}>(input: T): T {
  return Object.freeze({
    ...input,
    code: requiredText(input.code, "evidence.code"),
    message: requiredText(input.message, "evidence.message"),
    metadata: snapshotMetadata(input.metadata),
  });
}

function isRemotePhysicalResult<TOutput = unknown>(
  input: unknown,
): input is RemotePhysicalResult<TOutput> {
  if (!isRecord(input)) return false;
  if (
    typeof input.startedAt !== "string" ||
    typeof input.finishedAt !== "string" ||
    !isRecord(input.metadata)
  ) return false;
  if (input.semanticError !== null && (
    !isRecord(input.semanticError) ||
    typeof input.semanticError.code !== "string" ||
    typeof input.semanticError.message !== "string" ||
    !isRecord(input.semanticError.metadata)
  )) return false;
  return Object.hasOwn(input, "output");
}

function assertToolOrigins(
  toolOrigins: readonly ("model" | "workflow")[],
  operationOrigins: readonly OperationRequestOrigin[],
): void {
  for (const origin of toolOrigins) {
    const required = origin === "model" ? "tool_request" : "trusted_workflow";
    if (!operationOrigins.includes(required)) {
      throw new TypeError("Remote Tool origin is incompatible with its Operation registration.");
    }
  }
}

function exactRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError("Prepared remote Operation payload must be a plain object.");
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("Prepared remote Operation payload has an invalid shape.");
  }
  return input;
}

function snapshotMetadata(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const value = snapshotSerializable(input);
  if (!isRecord(value)) throw new TypeError("Remote metadata must be a plain serializable object.");
  return value;
}

function snapshotSerializable<T>(input: T): T {
  return deepFreeze(cloneSerializable(input)) as T;
}

function cloneSerializable(input: unknown): SerializableValue {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) return input.map(cloneSerializable);
  if (!isRecord(input)) throw new TypeError("Remote Operation data must be plain JSON-serializable data.");
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, cloneSerializable(value)]),
  );
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}

function isRecord(input: unknown): input is Record<string, any> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) {
    throw new TypeError(`Remote Operation ${field} must be non-empty text.`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TypeError(`Remote Operation ${field} must be a positive safe integer.`);
  }
  return input as number;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
