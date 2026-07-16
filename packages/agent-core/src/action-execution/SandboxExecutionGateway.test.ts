import { describe, expect, it, vi } from "vitest";
import type { InvocationInterruptionRef } from "@agent-anything/shared";
import {
  assertActionExecutorDispatchContext,
  type ActionExecutor,
} from "./ActionExecutor.js";
import { createActionDispatchAuthorization } from "./ActionAssessment.js";
import { createPreparedInvocationDigest } from "./ActionFingerprint.js";
import { createActionEffectSet } from "./CapabilityEffect.js";
import { createCanonicalEffectivePermissions } from "./CanonicalEffectivePermissions.js";
import type { CanonicalActionSubject } from "./CanonicalActionSubject.js";
import { createPreparedExternalAction } from "./PreparedExternalAction.js";
import { createPreparedActionInvocation } from "./PreparedActionInvocation.js";
import { createActionDispatchPlan } from "./ActionRevalidation.js";
import { createActionRegistrationSnapshot } from "./ActionRegistration.js";
import {
  createSandboxExecutionGateway,
  type CreateSandboxExecutionGatewayInput,
} from "./SandboxExecutionGateway.js";
import type {
  SandboxExecutionGateway,
  SandboxProvider,
} from "./SandboxContracts.js";

const NOW = "2026-07-16T00:00:00.000Z";
const DEADLINE = "2026-07-16T00:01:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const executorDescriptor = Object.freeze({
  id: "test.executor",
  version: "1",
  invocationContractVersion: "1",
});
const adapterDescriptor = Object.freeze({
  id: "test.adapter",
  version: "1",
  inputSchemaVersion: "1",
});

describe("SandboxExecutionGateway", () => {
  it("executes explicit disabled enforcement through the private permit and reports unisolated", async () => {
    const fixture = await createFixture("disabled");
    let observedPolicyId = "";
    const executor = createExecutor((context) => {
      assertActionExecutorDispatchContext(context);
      observedPolicyId = context.attempt.policyId;
    });
    const gateway = createGateway(fixture, { executors: [executor] });

    const result = await prepareAndExecute(gateway, dispatchInput(fixture));

    expect(result).toMatchObject({
      status: "executed",
      isolation: "unisolated",
      enforcementEvidence: null,
      attempt: {
        enforcement: "disabled",
        ordinal: 1,
        authoritySnapshotId: "authority-1",
      },
      toolResult: { status: "succeeded", output: { ok: true } },
    });
    expect(observedPolicyId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("prepares without executing and consumes the prepared dispatch exactly once", async () => {
    const fixture = await createFixture("disabled");
    const execute = vi.fn();
    const gateway = createGateway(fixture, {
      executors: [createExecutor(execute)],
    });

    const preparation = await gateway.prepare(dispatchInput(fixture));
    expect(preparation.status).toBe("ready");
    expect(execute).not.toHaveBeenCalled();
    if (preparation.status !== "ready") throw new Error("Sandbox preparation failed.");

    await expect(gateway.execute(Object.freeze({ ...preparation.prepared }))).resolves
      .toMatchObject({
        status: "failed",
        error: { code: "sandbox_prepared_dispatch_invalid" },
      });
    expect(execute).not.toHaveBeenCalled();

    await expect(gateway.execute(preparation.prepared)).resolves.toMatchObject({
      status: "executed",
    });
    await expect(gateway.execute(preparation.prepared)).resolves.toMatchObject({
      status: "failed",
      error: { code: "sandbox_prepared_dispatch_consumed" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a copied dispatch plan and never reaches the executor", async () => {
    const fixture = await createFixture("disabled");
    const execute = vi.fn();
    const gateway = createGateway(fixture, {
      executors: [createExecutor(execute)],
    });

    const result = await prepareAndExecute(gateway, {
      ...dispatchInput(fixture),
      plan: Object.freeze({ ...fixture.plan }),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "sandbox_dispatch_invalid" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an invocation whose payload no longer matches the plan digest", async () => {
    const fixture = await createFixture("disabled");
    const execute = vi.fn();
    const gateway = createGateway(fixture, {
      executors: [createExecutor(execute)],
    });
    const changed = createPreparedActionInvocation({
      contractVersion: "1",
      executorId: executorDescriptor.id,
      executorVersion: executorDescriptor.version,
      payload: { changed: true },
    });

    const result = await prepareAndExecute(gateway, {
      ...dispatchInput(fixture),
      preparedInvocation: changed,
    });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "sandbox_dispatch_invalid" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not downgrade managed enforcement when no provider is configured", async () => {
    const fixture = await createFixture("managed");
    const execute = vi.fn();
    const gateway = createGateway(fixture, {
      executors: [createExecutor(execute)],
    });

    const result = await prepareAndExecute(gateway, dispatchInput(fixture));

    expect(result).toMatchObject({
      status: "sandbox_unavailable",
      code: "sandbox_provider_unavailable",
      stage: "setup",
      effectState: "none",
      attempt: { enforcement: "managed" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unsupported provider capabilities before provider execution", async () => {
    const fixture = await createFixture("managed", true);
    const execute = vi.fn();
    const provider = createProvider({
      supportedPolicyVersions: [1],
      supportedEffectKinds: [],
      execute,
    });
    const gateway = createGateway(fixture, {
      executors: [],
      providers: [provider],
    });

    const result = await prepareAndExecute(gateway, dispatchInput(fixture));

    expect(result).toMatchObject({
      status: "sandbox_unavailable",
      code: "sandbox_effect_kind_unsupported",
      stage: "capability_check",
      effectState: "none",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses a data-only provider request and validates correlated enforcement evidence", async () => {
    const fixture = await createFixture("external", true);
    let serialized = "";
    const provider = createProvider({
      kind: "external",
      supportedPolicyVersions: [1],
      supportedEffectKinds: ["network"],
      async execute(request) {
        serialized = JSON.stringify(request);
        return {
          status: "executed",
          toolResult: toolResult(request.attempt.actionId),
          enforcementEvidence: {
            providerId: "test.provider",
            providerVersion: "1",
            policyId: request.policy.policyId,
            enforcement: "external",
            enforcedEffectKinds: ["network"],
            settledAt: NOW,
          },
        };
      },
    });
    const gateway = createGateway(fixture, {
      executors: [],
      providers: [provider],
    });

    const result = await prepareAndExecute(gateway, dispatchInput(fixture));

    expect(result).toMatchObject({
      status: "executed",
      isolation: "enforced",
      enforcementEvidence: {
        providerId: "test.provider",
        enforcement: "external",
      },
    });
    expect(JSON.parse(serialized)).toMatchObject({
      attempt: { enforcement: "external" },
      policy: {
        schemaVersion: 1,
        defaultDisposition: "deny",
        enforcement: "external",
        authorizedEffects: { kind: "effects" },
      },
      executor: executorDescriptor,
      invocation: { payload: { value: 1 } },
    });
    expect(serialized).not.toContain("AbortSignal");
  });

  it("sends one explicit correlated cancellation message to an active provider", async () => {
    const fixture = await createFixture("managed");
    const controller = new AbortController();
    let settle!: (value: ReturnType<typeof interruptedProviderResult>) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execution = new Promise<ReturnType<typeof interruptedProviderResult>>((resolve) => {
      settle = resolve;
    });
    const cancellations: unknown[] = [];
    const provider = createProvider({
      supportedPolicyVersions: [1],
      supportedEffectKinds: [],
      execute: async () => {
        markStarted();
        return execution;
      },
      async cancel(request) {
        cancellations.push(request);
        settle(interruptedProviderResult(request.interruption));
        return { status: "accepted" };
      },
    });
    const gateway = createGateway(fixture, {
      executors: [],
      providers: [provider],
    });
    const resultPromise = prepareAndExecute(gateway, {
      ...dispatchInput(fixture),
      interruption: Object.freeze({ signal: controller.signal, interruption: null }),
    });
    await started;
    controller.abort(Object.freeze({ id: "cancel-1", runId: "run-1" }));

    const result = await resultPromise;

    expect(result).toMatchObject({
      status: "interrupted",
      interruption: {
        kind: "run_cancellation",
        cancellation: { runId: "run-1", requestId: "cancel-1" },
      },
    });
    expect(cancellations).toEqual([expect.objectContaining({
      attemptId: expect.any(String),
      runId: "run-1",
      actionId: "action-1",
    })]);
  });

  it("requires a local executor only when the selected disabled endpoint dispatches", async () => {
    const fixture = await createFixture("disabled");
    const gateway = createGateway(fixture, { executors: [] });
    await expect(prepareAndExecute(gateway, dispatchInput(fixture))).resolves.toMatchObject({
      status: "sandbox_unavailable",
      code: "sandbox_executor_unavailable",
      stage: "setup",
      effectState: "none",
    });
    const executor = createExecutor();
    expect(() => createGateway(fixture, { executors: [executor, executor] })).toThrow(
      /Duplicate ActionExecutor implementation/,
    );
  });
});

async function createFixture(
  enforcement: "managed" | "external" | "disabled",
  networkEffect = false,
) {
  const registrations = createActionRegistrationSnapshot([{
    actionName: "test.action",
    adapter: adapterDescriptor,
    executor: executorDescriptor,
  }]);
  const invocation = createPreparedActionInvocation({
    contractVersion: "1",
    executorId: executorDescriptor.id,
    executorVersion: executorDescriptor.version,
    payload: { value: 1 },
  });
  const effectSet = networkEffect
    ? createActionEffectSet({
        kind: "effects",
        values: [{
          kind: "network",
          operation: "connect",
          endpoints: [{
            transport: "tcp",
            host: "api.example.com",
            port: 443,
            applicationProtocol: "https",
          }],
        }],
      })
    : createActionEffectSet({ kind: "effect_free" });
  const effectivePermissions = createCanonicalEffectivePermissions({
    enforcement,
    fileSystem: { read: { kind: "none" }, write: { kind: "none" } },
    process: { spawn: { kind: "none" } },
    network: {
      connect: networkEffect
        ? {
            kind: "restricted",
            values: [{
              transport: "tcp",
              host: "api.example.com",
              port: 443,
              applicationProtocol: "https",
            }],
          }
        : { kind: "none" },
    },
    remoteTool: { invoke: { kind: "none" } },
  });
  const subject = deepFreeze({
    schemaVersion: 1 as const,
    action: { runId: "run-1", actionId: "action-1", actionName: "test.action" },
    adapter: {
      ...adapterDescriptor,
      registrationFingerprint: registrations.registrations[0]!.registrationFingerprint,
    },
    executor: {
      id: executorDescriptor.id,
      version: executorDescriptor.version,
      invocationContractVersion: executorDescriptor.invocationContractVersion,
      registrationFingerprint: registrations.registrations[0]!.registrationFingerprint,
    },
    workspace: { workspaceId: "workspace-1", trustState: "trusted", roots: [] },
    identity: { identityId: "user-1", kind: "user" },
    environment: {
      environmentId: "local-test",
      platform: "win32",
      configurationFingerprint: SHA_B,
    },
    operation: {
      kind: "skill",
      operation: "invoke",
      skillId: "test.skill",
      skillVersion: "1",
      sourceFingerprint: SHA_A,
      action: "test",
      argumentsDigest: SHA_B,
    },
    effectSet,
    requestedPermissions: null,
    approvalContext: null,
    preparedInvocationDigest: await createPreparedInvocationDigest(invocation),
    targetAssertions: [],
  }) as unknown as CanonicalActionSubject;
  const prepared = createPreparedExternalAction({
    action: Object.freeze({
      id: "action-1",
      runId: "run-1",
      sequence: 1,
      kind: "tool",
      name: "test.action",
      provenance: Object.freeze({ modelItemId: "model-1", controllerIteration: 1 }),
    }),
    subject,
    actionFingerprint: SHA_A,
    safeSummary: Object.freeze({ kind: "computation", headline: "Test Action" }),
    approvalPayload: null,
    preparedInvocation: invocation,
    preparedAt: NOW,
  });
  const authorization = createActionDispatchAuthorization({
    prepared,
    authoritySnapshotId: "authority-1",
    policyDecision: { checkId: "policy-1", status: "allowed", decidedAt: NOW },
    ruleOutcome: "none",
    authoritySources: [],
    actionCoverageIdToConsume: null,
    effectivePermissions,
    authorizedAt: NOW,
  });
  const plan = await createActionDispatchPlan({
    prepared,
    authorization,
    registration: registrations.registrations[0]!,
    attemptOrdinal: 1,
    revalidatedAt: NOW,
  });
  return { registrations, invocation, plan };
}

function createGateway(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Partial<CreateSandboxExecutionGatewayInput>,
): SandboxExecutionGateway {
  return createSandboxExecutionGateway({
    registrations: fixture.registrations,
    executors: overrides.executors ?? [createExecutor()],
    providers: overrides.providers ?? [],
    limits: { maxResultBytes: 64 * 1024 },
    now: () => NOW,
  });
}

function createExecutor(
  beforeReturn: (context: Parameters<ActionExecutor["execute"]>[1]) => void = () => {},
): ActionExecutor {
  return {
    descriptor: executorDescriptor,
    async execute(_invocation, context) {
      beforeReturn(context);
      return toolResult(context.attempt.actionId);
    },
  };
}

function createProvider(input: {
  readonly kind?: "managed" | "external";
  readonly supportedPolicyVersions: readonly number[];
  readonly supportedEffectKinds: readonly ("file_system" | "process" | "network" | "remote_tool")[];
  readonly execute?: SandboxProvider["execute"];
  readonly cancel?: SandboxProvider["cancel"];
}): SandboxProvider {
  const kind = input.kind ?? "managed";
  return {
    kind,
    descriptor: {
      id: "test.provider",
      version: "1",
      kind,
      supportedPolicyVersions: input.supportedPolicyVersions,
      supportedEffectKinds: input.supportedEffectKinds,
    },
    execute: input.execute ?? (async () => {
      throw new Error("Provider execute was not expected.");
    }),
    cancel: input.cancel ?? (async () => ({ status: "already_settled" })),
  };
}

function dispatchInput(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    plan: fixture.plan,
    preparedInvocation: fixture.invocation,
    deadlineAt: DEADLINE,
    interruption: Object.freeze({
      signal: new AbortController().signal,
      interruption: null,
    }),
  };
}

async function prepareAndExecute(
  gateway: SandboxExecutionGateway,
  input: ReturnType<typeof dispatchInput>,
) {
  const preparation = await gateway.prepare(input);
  if (preparation.status !== "ready") return preparation;
  return gateway.execute(preparation.prepared);
}

function toolResult(actionId: string) {
  return {
    toolCallId: actionId,
    toolName: "test.action",
    status: "succeeded" as const,
    output: { ok: true },
    error: null,
    startedAt: NOW,
    finishedAt: NOW,
    metadata: {},
  };
}

function interruptedProviderResult(interruption: InvocationInterruptionRef) {
  return { status: "interrupted" as const, interruption };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
