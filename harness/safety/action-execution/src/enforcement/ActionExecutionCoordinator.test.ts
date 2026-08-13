import { describe, expect, it, vi } from "vitest";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import {
  createActionRegistrationSnapshot,
  type ActionAdapterDescriptor,
  type ActionExecutorDescriptor,
} from "@agent-anything/canonical-action/registration";
import {
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalWorkspaceIdentity,
} from "@agent-anything/canonical-action/subject";
import type { CanonicalActionSettlement } from "@agent-anything/canonical-action/settlement";
import type { ActionPolicyPort } from "@agent-anything/governance/policy";
import type { ActionPermissionAssessmentPort } from "@agent-anything/permission/authority";
import type { ResolvedOperationBinding } from "@agent-anything/operation-catalog/binding";
import type { SandboxExecutionGateway } from "../sandbox/SandboxContracts.js";
import { createSandboxExecutionGateway } from "../sandbox/SandboxExecutionGateway.js";
import { assertActionExecutorDispatchContext } from "../execution/ActionExecutor.js";
import {
  createPreparedAction,
  type OperationActionAdapter,
} from "../registration/ActionAdapter.js";
import {
  ActionExecutionCoordinator,
  type ActionExecutionCoordinatorDependencies,
} from "./ActionExecutionCoordinator.js";

describe("ActionExecutionCoordinator", () => {
  it("owns the canonical prepare-assess-revalidate-dispatch-settle sequence", async () => {
    const fixture = createFixture();

    const result = await fixture.coordinator.execute(fixture.request);

    expect(result.status).toBe("settled");
    if (result.status !== "settled") return;
    expect(result.settlement).toMatchObject({
      status: "succeeded",
      effectCertainty: "confirmed",
      completionExtent: "complete",
      payload: { content: "hello" },
      causeOwner: null,
      causeRef: null,
    });
    expect(result.semanticResult).toMatchObject({
      status: "succeeded",
      output: { content: "hello" },
      failure: null,
    });
    expect(fixture.order).toEqual([
      "adapter.prepare",
      "policy.evaluate",
      "permission.assess",
      "adapter.revalidate",
      "records.pre-effect",
      "executor.execute",
      "records.post-effect",
      "adapter.settle",
    ]);
    expect(result.settlement.attempts).toHaveLength(1);
    expect(result.settlement.subject).not.toBeNull();
    expect(Object.isFrozen(result.settlement)).toBe(true);
  });

  it("stops at Governance denial before Permission, revalidation, and dispatch", async () => {
    const fixture = createFixture({ policyStatus: "denied" });

    const result = await fixture.coordinator.execute(fixture.request);

    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        status: "denied",
        attempts: [],
        causeOwner: "governance",
        causeRef: "policy_denied",
      },
      semanticResult: {
        status: "denied",
        output: null,
      },
    });
    expect(fixture.order).toEqual([
      "adapter.prepare",
      "policy.evaluate",
      "records.post-effect",
      "adapter.settle",
    ]);
  });

  it("returns an Interaction requirement without dispatch when approval has no coordinator", async () => {
    const fixture = createFixture({ permissionStatus: "approval_required" });

    const result = await fixture.coordinator.execute(fixture.request);

    expect(result).toMatchObject({
      status: "pending_interaction",
      action: { id: "action-1" },
      subject: { ref: { revision: 1 } },
      assessment: { status: "approval_required" },
    });
    expect(fixture.order).toEqual([
      "adapter.prepare",
      "policy.evaluate",
      "permission.assess",
    ]);
  });

  it("settles an unknown physical effect without semantic success", async () => {
    const fixture = createFixture({ sandboxEffectState: "unknown" });

    const result = await fixture.coordinator.execute(fixture.request);

    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        status: "unknown_effect",
        effectCertainty: "unknown",
        completionExtent: "unknown",
        reconciliationRequired: true,
        causeOwner: "sandbox",
        causeRef: "sandbox_settlement_unknown",
      },
      semanticResult: {
        status: "unknown_effect",
        output: null,
      },
    });
  });

  it("retries only from an explicit compatible replay basis", async () => {
    const fixture = createFixture({ retryOnce: true });

    const result = await fixture.coordinator.execute({
      ...fixture.request,
      maxAttempts: 2,
    });

    expect(result).toMatchObject({
      status: "settled",
      settlement: { status: "succeeded" },
    });
    if (result.status !== "settled") return;
    expect(result.settlement.attempts).toHaveLength(2);
    expect(fixture.retryDecide).toHaveBeenCalledTimes(1);
    expect(fixture.order.filter((value) => value === "adapter.revalidate"))
      .toHaveLength(2);
    expect(fixture.order.filter((value) => value === "records.pre-effect"))
      .toHaveLength(2);
  });
});

interface FixtureOptions {
  readonly policyStatus?: "allowed" | "denied";
  readonly permissionStatus?: "authorized" | "approval_required";
  readonly sandboxEffectState?: "none" | "unknown";
  readonly retryOnce?: boolean;
}

function createFixture(options: FixtureOptions = {}) {
  const order: string[] = [];
  const operation = {
    operation: { namespace: "code", name: "read-file" },
    revision: "1",
  } as const;
  const bindingRef = { operation, revision: "binding-1" } as const;
  const adapterDescriptor: ActionAdapterDescriptor = {
    id: "code.read-file.adapter",
    version: "1",
    requestSchemaRevision: "request-1",
  };
  const executorDescriptor: ActionExecutorDescriptor = {
    id: "code.read-file.executor",
    version: "1",
    invocationContractVersion: "1",
    physicalPayloadSchemaRevision: "payload-1",
  };
  const registrations = createActionRegistrationSnapshot([{
    registrationId: "action-registration.read-file",
    revision: "1",
    operation,
    binding: bindingRef,
    adapter: adapterDescriptor,
    executor: executorDescriptor,
    effectFamilies: ["filesystem"],
    sandboxRequirementRevision: "sandbox-requirement-1",
    maxInvocationBytes: 64 * 1024,
    maxPhysicalResultBytes: 64 * 1024,
  }]);
  const parentRunAction: RunActionRef = {
    run: { id: "run-1" },
    id: "run-action-1",
    sequence: 1,
  };
  const binding: Extract<ResolvedOperationBinding<{ path: string }>, { kind: "direct" }> = {
    kind: "direct",
    invocation: { id: "operation-invocation-1", operation },
    correlation: {
      kind: "run_action",
      run: { id: "run-1" },
      runAction: parentRunAction,
      provenance: {
        kind: "automatic",
        trigger: { owner: "test", operationId: "trigger-1" },
      },
      materializationRevision: 1,
    },
    parentInvocation: null,
    binding: bindingRef,
    request: { path: "D:/workspace/README.md" },
    resolverRevision: "1",
    resolutionFingerprint: "binding-resolution-1",
    actionAdapterId: adapterDescriptor.id,
  };
  const workspace = createCanonicalWorkspaceIdentity({
    workspaceId: "workspace-1",
    trustState: "trusted",
    roots: [{
      rootId: "workspace-1",
      platform: "win32",
      path: "D:/workspace",
      resolvedPath: "D:/workspace",
      resolutionFingerprint: SHA_A,
    }],
  });
  const actor = createCanonicalActorIdentity({ identityId: "user-1", kind: "user" });
  const environment = createCanonicalEnvironmentIdentity({
    environmentId: "local",
    platform: "win32",
    configurationFingerprint: SHA_B,
  });
  const adapter: OperationActionAdapter = {
    descriptor: adapterDescriptor,
    async prepare(resolved, context) {
      order.push("adapter.prepare");
      return {
        status: "prepared" as const,
        prepared: await createPreparedAction(resolved, context, {
          effectSet: {
            kind: "effects",
            values: [{
              kind: "file_system",
              operation: "read",
              targets: [{
                platform: "win32",
                path: "D:/workspace/README.md",
                resolvedPath: "D:/workspace/README.md",
                workspaceRootId: "workspace-1",
                resolutionFingerprint: SHA_C,
              }],
            }],
          },
          requestedAuthority: null,
          targetAssertions: [],
          approval: null,
          safeSummary: {
            kind: "file_system",
            headline: "Read README",
            operations: [{
              operation: "read",
              sourceLabel: "README.md",
              destinationLabel: null,
            }],
          },
          preparedInvocation: {
            contractVersion: "1",
            executorId: executorDescriptor.id,
            executorVersion: executorDescriptor.version,
            payload: { path: "D:/workspace/README.md" },
          },
          replayBasis: options.retryOnce ? "confirmed_no_effect" : "none",
          semanticBasis: { operation: "read" },
        }),
      };
    },
    async revalidate() {
      order.push("adapter.revalidate");
      return { status: "valid" as const, recordId: "revalidation-1" };
    },
    async settle(_prepared, settlement) {
      order.push("adapter.settle");
      return semanticResult(settlement);
    },
  };
  const policy: ActionPolicyPort = {
    async evaluate(input) {
      order.push("policy.evaluate");
      if (options.policyStatus === "denied") {
        return {
          status: "denied",
          owner: "governance",
          subject: input.subject.ref,
          checkId: input.checkId,
          recordId: "policy-record-1",
          revision: "policy-1",
          code: "policy_denied",
          reason: "Denied by test policy.",
          decidedAt: NOW,
        };
      }
      return {
        status: "allowed",
        owner: "governance",
        subject: input.subject.ref,
        checkId: input.checkId,
        recordId: "policy-record-1",
        revision: "policy-1",
        code: null,
        reason: null,
        decidedAt: NOW,
      };
    },
  };
  const permission: ActionPermissionAssessmentPort = {
    async assess(input) {
      order.push("permission.assess");
      if (options.permissionStatus === "approval_required") {
        return {
          status: "approval_required",
          owner: "permission",
          subject: input.subject.ref,
          recordId: "permission-record-1",
          revision: "authority-1",
          requirement: { category: "test" } as never,
          assessedAt: NOW,
        };
      }
      return {
        status: "authorized",
        owner: "permission",
        subject: input.subject.ref,
        recordId: "permission-record-1",
        revision: "authority-1",
        authorityCoverageDigest: "coverage-1",
        actionCoverageId: null,
        assessedAt: NOW,
      };
    },
    async consumeActionCoverage() {
      return { status: "consumed", recordId: "coverage-consumption-1" };
    },
  };
  let sandboxCalls = 0;
  const sandbox: SandboxExecutionGateway = options.sandboxEffectState === "unknown"
    ? {
        async execute(request) {
          return {
            status: "sandbox_unavailable",
            attempt: request.attempt,
            code: "sandbox_settlement_unknown",
            stage: "settlement",
            effectState: "unknown",
          };
        },
        async cancel() {
          return { status: "already_settled" };
        },
      }
    : createSandboxExecutionGateway({
        executors: [{
          descriptor: executorDescriptor,
          validatePayload(candidate): candidate is { content: string } {
            return typeof candidate === "object" && candidate !== null &&
              "content" in candidate && typeof candidate.content === "string";
          },
          async execute(_invocation, context) {
            assertActionExecutorDispatchContext(context);
            order.push("executor.execute");
            sandboxCalls += 1;
            if (options.retryOnce && sandboxCalls === 1) {
              return {
                status: "failed",
                effectState: "none",
                failure: {
                  code: "executor_transient_failure",
                  message: "Retryable transient failure.",
                  retryable: true,
                  metadata: {},
                },
              };
            }
            return {
              status: "completed",
              effectState: "settled",
              payload: { content: "hello" },
            };
          },
        }],
      });
  const retryDecide = vi.fn(async () => ({
    status: "retry" as const,
    replayBasis: {
      kind: "confirmed_no_effect" as const,
      evidenceRef: "evidence-no-effect-1",
    },
    delayMs: 0,
    decisionRecordId: "retry-decision-1",
  }));
  const dependencies: ActionExecutionCoordinatorDependencies = {
    registrations,
    adapters: [{ adapter }],
    policy,
    permission,
    approval: null,
    sandbox,
    records: {
      async recordPreEffect() {
        order.push("records.pre-effect");
        return { recordId: "pre-effect-1" };
      },
      async recordPostEffect() {
        order.push("records.post-effect");
        return { recordId: "post-effect-1" };
      },
    },
    retry: {
      decide: retryDecide,
      async wait() {
        return "elapsed";
      },
    },
    now: () => NOW,
    createId: createSequentialId(),
  };
  const interruption = createInterruption();
  return {
    order,
    retryDecide,
    coordinator: new ActionExecutionCoordinator(dependencies),
    request: {
      action: { id: "action-1" },
      parentRunAction,
      runId: "run-1",
      binding,
      securityContext: { workspace, actor, environment },
      policyContext: {
        policySnapshotId: "policy-1",
        workspaceTrustState: "trusted" as const,
        identityId: "user-1",
        environmentId: "local",
        metadata: {},
      },
      permissionContext: () => ({ authoritySnapshotId: "authority-1" } as never),
      enforcement: "disabled" as const,
      interruption,
      deadlineAt: "2026-08-13T01:00:00.000Z",
      maxAttempts: 1,
    },
  };
}

function semanticResult(settlement: CanonicalActionSettlement) {
  const succeeded = settlement.status === "succeeded";
  return {
    operationInvocationId: settlement.operationInvocation.id,
    settlement,
    status: succeeded
      ? "succeeded" as const
      : settlement.status === "unknown_effect"
        ? "unknown_effect" as const
        : settlement.status === "denied"
          ? "denied" as const
          : "failed" as const,
    output: succeeded ? settlement.payload : null,
    failure: succeeded
      ? null
      : {
          owner: settlement.causeOwner ?? "action-execution",
          code: settlement.causeRef ?? settlement.status,
          message: settlement.causeRef ?? settlement.status,
        },
  };
}

function createSequentialId() {
  let sequence = 0;
  return (kind: string) => `${kind}-${++sequence}`;
}

function createInterruption(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}

const NOW = "2026-08-13T00:00:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;
