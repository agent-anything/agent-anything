import {
  assertActionExecutorDispatchContext,
  createActionRegistrationSnapshot,
  createCanonicalRemoteServerIdentity,
  createCanonicalRemoteToolIdentity,
  createCanonicalSha256Digest,
  type ActionAdapter,
  type ActionAdapterDescriptor,
  type ActionAdapterPreparedData,
  type ActionExecutor,
  type ActionExecutorContext,
  type ActionExecutorDescriptor,
  type PreparedActionInvocation,
  type SerializableValue,
  type TargetStateAssertion,
} from "@agent-anything/action-execution";
import type { InvocationInterruptionRef } from "@agent-anything/shared";
import type { ToolResult } from "@agent-anything/tools";
import { createToolCatalogSnapshot } from "@agent-anything/tools";
import {
  type CreateRemoteActionCapabilityInput,
  type PreparedRemoteActionInvocationPayload,
  type RemoteActionCapability,
  type RemoteActionRegistrationResolver,
  type TrustedRemoteActionRegistration,
} from "./RemoteActionRegistration.js";

const ADAPTER_DESCRIPTOR: ActionAdapterDescriptor = Object.freeze({
  id: "extensions.remote-action.adapter",
  version: "1",
  inputSchemaVersion: "1",
});

const EXECUTOR_DESCRIPTOR: ActionExecutorDescriptor = Object.freeze({
  id: "extensions.remote-action.executor",
  version: "1",
  invocationContractVersion: "1",
});

export function createRemoteActionCapability(
  input: CreateRemoteActionCapabilityInput,
): RemoteActionCapability {
  const registration = normalizeRegistration(input.registration);
  const resolver = input.registrationResolver ?? staticResolver(registration);
  const registrations = createActionRegistrationSnapshot([{
    actionName: registration.actionName,
    adapter: ADAPTER_DESCRIPTOR,
    executor: EXECUTOR_DESCRIPTOR,
  }]);
  const adapter = createRemoteActionAdapter(registration, resolver);

  const capability: RemoteActionCapability = {
    catalog: createToolCatalogSnapshot([{
      name: registration.actionName,
      description: registration.description,
      inputSchema: registration.inputSchema,
      annotations: registration.annotations,
      metadata: {
        capabilityOwner: "extensions",
        remoteServerId: registration.server.serverId,
        remoteToolName: registration.toolName,
      },
    }]),
    registrations,
    adapters: Object.freeze([Object.freeze({ actionName: registration.actionName, adapter })]),
    executors: Object.freeze([
      createRemoteActionExecutor(registration, resolver, input.invokePort, input.now),
    ]),
  };
  return Object.freeze(capability);
}

function createRemoteActionAdapter(
  expected: TrustedRemoteActionRegistration,
  resolver: RemoteActionRegistrationResolver,
): ActionAdapter {
  const adapter: ActionAdapter = {
    descriptor: ADAPTER_DESCRIPTOR,
    async prepare(action, context) {
      const interruption = observeInterruption(context.interruption);
      if (interruption !== null) return interruption;
      try {
        if (action.actionName !== expected.actionName) {
          return rejected("Remote Action name does not match its trusted registration.");
        }
        const current = await resolveCurrent(resolver, expected.server.serverId, expected.toolName);
        if (!sameAuthorityRegistration(current, expected)) {
          return rejected("Remote Action registration changed before preparation.");
        }
        const argumentsDigest = await createCanonicalSha256Digest(
          "agent-anything.extensions.remote-action-arguments.v1",
          action.input,
        );
        const inputValue = action.input as SerializableValue;
        const afterResolution = observeInterruption(context.interruption);
        if (afterResolution !== null) return afterResolution;
        return {
          status: "prepared" as const,
          data: await preparedData(current, inputValue, argumentsDigest),
        };
      } catch (error) {
        const afterFailure = observeInterruption(context.interruption);
        if (afterFailure !== null) return afterFailure;
        return rejected(safeMessage(error, "Remote Action input or registration is invalid."));
      }
    },
    async revalidate(invocation, assertions, context) {
      const interruption = observeInterruption(context.interruption);
      if (interruption !== null) return interruption;
      try {
        const payload = readPayload(invocation);
        const assertion = assertions.find(
          (candidate): candidate is Extract<TargetStateAssertion, { kind: "remote_server_identity" }> =>
            candidate.kind === "remote_server_identity",
        );
        if (assertion === undefined) {
          return invalidated("remote_registration_assertion_missing", "Remote server assertion is missing.");
        }
        const current = await resolveCurrent(resolver, payload.serverId, payload.toolName);
        if (!sameAuthorityRegistration(current, expected) ||
          !sameServer(current.server, assertion.expected) ||
          !samePayloadRegistration(payload, current)) {
          return invalidated(
            "remote_registration_changed",
            "Remote Action registration changed after preparation.",
          );
        }
        return { status: "valid" as const };
      } catch (error) {
        const afterFailure = observeInterruption(context.interruption);
        if (afterFailure !== null) return afterFailure;
        return invalidated(
          "remote_registration_changed",
          safeMessage(error, "Remote Action registration changed after preparation."),
        );
      }
    },
  };
  return Object.freeze(adapter);
}

async function preparedData(
  registration: TrustedRemoteActionRegistration,
  input: SerializableValue,
  argumentsDigest: string,
): Promise<ActionAdapterPreparedData> {
  const target = createCanonicalRemoteToolIdentity({
    server: registration.server,
    toolName: registration.toolName,
  });
  const payload: PreparedRemoteActionInvocationPayload = {
    actionName: registration.actionName,
    serverId: registration.server.serverId,
    registrationFingerprint: registration.server.registrationFingerprint,
    transport: registration.server.transport,
    endpoint: registration.server.endpoint,
    toolName: registration.toolName,
    input,
    timeoutMs: registration.timeoutMs,
  };
  const effects: ActionAdapterPreparedData["effectSet"] = {
    kind: "effects",
    values: [
      { kind: "remote_tool", operation: "invoke", target },
      ...(registration.server.endpoint === null
        ? []
        : [{
            kind: "network" as const,
            operation: "connect" as const,
            endpoints: [registration.server.endpoint],
          }]),
    ],
  };
  const data: ActionAdapterPreparedData = {
    operation: {
      kind: "remote_tool",
      operation: "invoke",
      target,
      argumentsDigest,
    },
    effectSet: effects,
    requestedPermissions: null,
    targetAssertions: [{ kind: "remote_server_identity", expected: registration.server }],
    approvalCategory: "mcpToolCall",
    approvalPayload: {
      serverId: registration.server.serverId,
      serverDisplayName: registration.serverDisplayName,
      toolName: registration.toolName,
      safeArguments: {},
      annotations: {
        readOnlyHint: registration.annotations?.readOnlyHint ?? null,
        destructiveHint: registration.annotations?.destructiveHint ?? null,
        idempotentHint: registration.annotations?.idempotentHint ?? null,
        openWorldHint: registration.annotations?.openWorldHint ?? null,
      },
      supportsSessionAuthority: registration.supportsSessionAuthority,
    },
    applicabilityKeys: [{
      category: "mcpToolCall",
      value: `${registration.server.serverId}:${registration.server.registrationFingerprint}:${registration.toolName}`,
    }],
    safeSummary: {
      kind: "remote_tool",
      headline: "Invoke remote tool",
      serverDisplayName: registration.serverDisplayName,
      toolDisplayName: registration.toolDisplayName,
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

function createRemoteActionExecutor(
  expected: TrustedRemoteActionRegistration,
  resolver: RemoteActionRegistrationResolver,
  invokePort: CreateRemoteActionCapabilityInput["invokePort"],
  nowInput: (() => string) | undefined,
): ActionExecutor {
  const now = nowInput ?? (() => new Date().toISOString());
  const executor: ActionExecutor = {
    descriptor: EXECUTOR_DESCRIPTOR,
    async execute(invocation, context) {
      assertActionExecutorDispatchContext(context);
      const startedAt = now();
      let payload: PreparedRemoteActionInvocationPayload;
      try {
        payload = readPayload(invocation);
        const beforeCall = interruptionResult(payload, context, startedAt, now());
        if (beforeCall !== null) return beforeCall;
        const current = await resolveCurrent(resolver, payload.serverId, payload.toolName);
        if (!sameAuthorityRegistration(current, expected) ||
          !samePayloadRegistration(payload, current)) {
          throw new RemoteActionError(
            "tool_remote_registration_changed",
            "Remote Action registration changed before dispatch.",
          );
        }
        const result = await invokePort.invoke({
          actionId: context.attempt.actionId,
          actionName: payload.actionName,
          serverId: payload.serverId,
          toolName: payload.toolName,
          input: payload.input,
          timeoutMs: payload.timeoutMs,
        });
        if (result.toolCallId !== context.attempt.actionId || result.toolName !== payload.actionName) {
          throw new RemoteActionError(
            "tool_remote_result_mismatch",
            "Remote Action result did not match the authorized Action.",
          );
        }
        return result;
      } catch (error) {
        const candidate = safeReadPayload(invocation);
        return interruptionResult(candidate, context, startedAt, now()) ?? failedResult(
          candidate,
          context,
          startedAt,
          now(),
          error,
        );
      }
    },
  };
  return Object.freeze(executor);
}

function normalizeRegistration(
  input: TrustedRemoteActionRegistration,
): TrustedRemoteActionRegistration {
  const server = createCanonicalRemoteServerIdentity(input.server);
  if (input.actionName.length === 0 || input.toolName.length === 0 ||
    input.serverDisplayName.length === 0 || input.toolDisplayName.length === 0) {
    throw new TypeError("Remote Action registration names must not be empty.");
  }
  if (input.timeoutMs !== null &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new TypeError("Remote Action timeout must be a positive safe integer or null.");
  }
  return Object.freeze({
    ...input,
    server,
    inputSchema: Object.freeze({ ...input.inputSchema }),
    annotations: input.annotations === undefined
      ? undefined
      : Object.freeze({ ...input.annotations }),
  });
}

function staticResolver(
  registration: TrustedRemoteActionRegistration,
): RemoteActionRegistrationResolver {
  return Object.freeze({
    async resolve(serverId: string, toolName: string) {
      return serverId === registration.server.serverId && toolName === registration.toolName
        ? registration
        : null;
    },
  });
}

async function resolveCurrent(
  resolver: RemoteActionRegistrationResolver,
  serverId: string,
  toolName: string,
): Promise<TrustedRemoteActionRegistration> {
  const registration = await resolver.resolve(serverId, toolName);
  if (registration === null) {
    throw new RemoteActionError("tool_remote_unavailable", "Remote Action registration is unavailable.");
  }
  return normalizeRegistration(registration);
}

function readPayload(invocation: PreparedActionInvocation): PreparedRemoteActionInvocationPayload {
  if (invocation.contractVersion !== EXECUTOR_DESCRIPTOR.invocationContractVersion ||
    invocation.executorId !== EXECUTOR_DESCRIPTOR.id ||
    invocation.executorVersion !== EXECUTOR_DESCRIPTOR.version) {
    throw new TypeError("Prepared remote invocation executor identity is invalid.");
  }
  const value = strictRecord(invocation.payload, new Set([
    "actionName", "serverId", "registrationFingerprint", "transport", "endpoint",
    "toolName", "input", "timeoutMs",
  ]));
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "https" &&
    transport !== "websocket") {
    throw new TypeError("Prepared remote transport is invalid.");
  }
  const server = createCanonicalRemoteServerIdentity({
    serverId: requiredString(value.serverId, "serverId"),
    registrationFingerprint: requiredString(value.registrationFingerprint, "registrationFingerprint"),
    transport,
    endpoint: value.endpoint as never,
  });
  const timeoutMs = value.timeoutMs === null ? null : positiveInteger(value.timeoutMs, "timeoutMs");
  return Object.freeze({
    actionName: requiredString(value.actionName, "actionName"),
    serverId: server.serverId,
    registrationFingerprint: server.registrationFingerprint,
    transport: server.transport,
    endpoint: server.endpoint,
    toolName: requiredString(value.toolName, "toolName"),
    input: value.input as SerializableValue,
    timeoutMs,
  });
}

function safeReadPayload(invocation: PreparedActionInvocation): PreparedRemoteActionInvocationPayload | null {
  try { return readPayload(invocation); } catch { return null; }
}

function strictRecord(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Prepared remote invocation must be a plain object.");
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`Prepared remote invocation contains unsupported field '${String(key)}'.`);
    }
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (property?.get !== undefined || property?.set !== undefined || !property?.enumerable) {
      throw new TypeError(`Prepared remote invocation field '${key}' is invalid.`);
    }
  }
  return input as Record<string, unknown>;
}

function sameAuthorityRegistration(
  actual: TrustedRemoteActionRegistration,
  expected: TrustedRemoteActionRegistration,
): boolean {
  return actual.actionName === expected.actionName &&
    actual.toolName === expected.toolName &&
    sameServer(actual.server, expected.server);
}

function samePayloadRegistration(
  payload: PreparedRemoteActionInvocationPayload,
  registration: TrustedRemoteActionRegistration,
): boolean {
  return payload.actionName === registration.actionName &&
    payload.serverId === registration.server.serverId &&
    payload.registrationFingerprint === registration.server.registrationFingerprint &&
    payload.transport === registration.server.transport &&
    sameEndpoint(payload.endpoint, registration.server.endpoint) &&
    payload.toolName === registration.toolName &&
    payload.timeoutMs === registration.timeoutMs;
}

function sameServer(
  left: TrustedRemoteActionRegistration["server"],
  right: TrustedRemoteActionRegistration["server"],
): boolean {
  return left.serverId === right.serverId &&
    left.registrationFingerprint === right.registrationFingerprint &&
    left.transport === right.transport &&
    sameEndpoint(left.endpoint, right.endpoint);
}

function sameEndpoint(
  left: TrustedRemoteActionRegistration["server"]["endpoint"],
  right: TrustedRemoteActionRegistration["server"]["endpoint"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.transport === right.transport && left.host === right.host &&
    left.port === right.port && left.applicationProtocol === right.applicationProtocol;
}

function failedResult(
  payload: PreparedRemoteActionInvocationPayload | null,
  context: ActionExecutorContext,
  startedAt: string,
  finishedAt: string,
  error: unknown,
): ToolResult {
  const code = error instanceof RemoteActionError
    ? error.code
    : error !== null && typeof error === "object" && "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "tool_remote_execution_failed";
  return {
    toolCallId: context.attempt.actionId,
    toolName: payload?.actionName ?? "remote.action",
    status: code === "tool_timeout" ? "timeout" : "failed",
    output: null,
    error: {
      code,
      message: error instanceof Error ? error.message : "Remote Action execution failed.",
    },
    startedAt,
    finishedAt,
    metadata: payload === null ? {} : {
      remoteServerId: payload.serverId,
      remoteToolName: payload.toolName,
    },
  };
}

function interruptionResult(
  payload: PreparedRemoteActionInvocationPayload | null,
  context: ActionExecutorContext,
  startedAt: string,
  finishedAt: string,
): ToolResult | null {
  if (!context.interruption.signal.aborted) return null;
  const interruption = context.interruption.interruption;
  const base = {
    toolCallId: context.attempt.actionId,
    toolName: payload?.actionName ?? "remote.action",
    output: null,
    startedAt,
    finishedAt,
    metadata: {},
  };
  if (interruption?.kind === "run_cancellation") {
    return {
      ...base,
      status: "cancelled",
      error: {
        code: "tool_cancelled",
        message: "Remote Action was cancelled before dispatch.",
        metadata: {
          runId: interruption.cancellation.runId,
          requestId: interruption.cancellation.requestId,
        },
      },
    };
  }
  if (interruption?.kind === "operation_deadline") {
    return {
      ...base,
      status: "timeout",
      error: { code: "tool_timeout", message: "Remote Action exceeded its invocation deadline." },
    };
  }
  return {
    ...base,
    status: "interrupted",
    error: {
      code: "tool_cancellation_unconfirmed",
      message: "Remote Action was interrupted without trusted attribution.",
    },
  };
}

function observeInterruption(input: {
  readonly signal: AbortSignal;
  readonly interruption: InvocationInterruptionRef | null;
}) {
  if (!input.signal.aborted) return null;
  if (input.interruption === null) {
    return {
      status: "failed" as const,
      code: "tool_interruption_unattributed",
      message: "Remote Action interruption is not attributed.",
      retryable: false,
    };
  }
  return { status: "interrupted" as const, interruption: input.interruption };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Prepared remote field '${field}' must be non-empty text.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`Prepared remote field '${field}' must be a positive safe integer.`);
  }
  return value as number;
}

function rejected(message: string) {
  return { status: "rejected" as const, code: "action_invalid" as const, message };
}

function invalidated(code: string, message: string) {
  return { status: "invalidated" as const, code, message };
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof TypeError || error instanceof RemoteActionError ? error.message : fallback;
}

class RemoteActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteActionError";
  }
}
