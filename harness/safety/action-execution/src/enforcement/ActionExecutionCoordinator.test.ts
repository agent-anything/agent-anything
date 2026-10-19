import { describe, expect, it, vi } from "vitest";
import type { ExecutionFlowObservation } from "@agent-anything/observability/execution-flow";
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
  type ActionExecutionNotification,
  type ActionExecutionCoordinatorDependencies,
} from "./ActionExecutionCoordinator.js";
import { ActionRecordCommitError, ActionRecoveryError, type ActionRecordPort, type ActionRecoveryRecords,
  type ActionPreparationRecord, type ActionDispatchIntent, type ActionAttemptResultRecord,
  type ActionSettlementRecord, type ActionRetryRecord } from "./ActionRecordPort.js";

describe("ActionExecutionCoordinator", () => {
  it("restores preparation committed before assessment without preparing another subject", async () => {
    const fixture = createFixture();
    const retained = recoveryRecords();
    const first = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port,
      policy: {async evaluate() {throw new Error("owner exited before assessment");}}});
    await expect(first.execute(fixture.request)).rejects.toThrow("owner exited");
    const saved = await retained.reader.readAction();
    expect(saved.preparedAction).not.toBeNull();
    expect(saved.preparations).toEqual([]);
    expect(saved.attempts).toEqual([]);
    fixture.order.length = 0;
    const recovered = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    await expect(recovered.recover(fixture.request, {records: retained.reader, attempts: null})).resolves.toMatchObject({
      status: "settled", settlement: {status: "succeeded", subject: saved.preparedAction!.prepared.subject.ref},
    });
    expect(fixture.order).not.toContain("adapter.prepare");
    expect(fixture.order).toContain("policy.evaluate");
    expect(fixture.order).toContain("permission.assess");
    expect(fixture.order).toContain("adapter.revalidate");
    expect(fixture.order.filter(value => value === "executor.execute")).toHaveLength(1);
  });

  it("continues an acknowledged retry with remaining delay and original Attempt identities", async () => {
    const fixture = createFixture({retryOnce: true});
    const retained = recoveryRecords();
    const request = {...fixture.request, maxAttempts: 2};
    const decision = await fixture.retryDecide();
    fixture.retryDecide.mockResolvedValue({...decision, delayMs: 10_000});
    fixture.retryDecide.mockClear();
    const interrupted = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port,
      retry: {...fixture.dependencies.retry, wait: async () => {throw new Error("owner exited during wait");}}});
    await expect(interrupted.execute(request)).rejects.toThrow("owner exited");
    const before = await retained.reader.readAction();
    expect(before.attempts).toHaveLength(1);
    fixture.order.length = 0;
    const wait = vi.fn(async () => "elapsed" as const);
    const restored = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port,
      now: () => new Date(Date.parse(NOW) + 4_000).toISOString(),
      retry: {...fixture.dependencies.retry, wait}});
    const result = await restored.recover(request, {records: retained.reader, attempts: null});
    expect(result).toMatchObject({status: "settled", settlement: {status: "succeeded", attempts: [
      {id: before.attempts[0]!.intent.request.attempt.id, ordinal: 1}, {id: "action-1:attempt:2", ordinal: 2},
    ]}});
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({delayMs: 6_000}));
    expect(fixture.retryDecide).toHaveBeenCalledTimes(1);
    expect(fixture.order).not.toContain("adapter.prepare");
    expect(fixture.order).toContain("policy.evaluate");
    expect(fixture.order).toContain("permission.assess");
    expect(fixture.order).toContain("adapter.revalidate");
    expect(fixture.order.filter(value => value === "executor.execute")).toHaveLength(1);
  });

  it("reuses a stop decision after a failed settlement acknowledgement", async () => {
    const fixture = createFixture({retryOnce: true});
    const retained = recoveryRecords();
    const decide = vi.fn(async () => ({status: "stop" as const, code: "owner_policy_stop"}));
    const request = {...fixture.request, maxAttempts: 2};
    const interrupted = new ActionExecutionCoordinator({...fixture.dependencies,
      retry: {...fixture.dependencies.retry, decide}, records: {...retained.port,
        recordPostEffect: async () => {throw new Error("interrupted before settlement");}}});
    await expect(interrupted.execute(request)).rejects.toBeInstanceOf(ActionRecordCommitError);
    fixture.order.length = 0;
    const restored = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port,
      retry: {...fixture.dependencies.retry, decide}});
    expect(await restored.recover(request, {records: retained.reader, attempts: null})).toMatchObject({settlement: {status: "failed", attempts: [{ordinal: 1}]}});
    expect(decide).toHaveBeenCalledTimes(1);
    expect(fixture.order).toEqual(["adapter.settle"]);
  });

  it("does not dispatch before retry acknowledgement, then recovers a lost acknowledgement", async () => {
    const fixture = createFixture({retryOnce: true});
    const retained = recoveryRecords();
    const request = {...fixture.request, maxAttempts: 2};
    const interrupted = new ActionExecutionCoordinator({...fixture.dependencies, records: {...retained.port,
      async recordRetry(value) {await retained.port.recordRetry(value); throw new Error("acknowledgement lost");}}});
    await expect(interrupted.execute(request)).rejects.toMatchObject({stage: "retry"});
    expect(fixture.order.filter(value => value === "executor.execute")).toHaveLength(1);
    const restored = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    expect(await restored.recover(request, {records: retained.reader, attempts: null})).toMatchObject({settlement: {status: "succeeded", attempts: [{ordinal: 1}, {ordinal: 2}]}});
    expect(fixture.retryDecide).toHaveBeenCalledTimes(1);
  });

  it("decides a missing retry only after the retained physical result is known", async () => {
    const fixture = createFixture({retryOnce: true});
    const retained = recoveryRecords();
    const request = {...fixture.request, maxAttempts: 2};
    const interrupted = new ActionExecutionCoordinator({...fixture.dependencies, records: {...retained.port,
      async recordAttemptResult(value) {await retained.port.recordAttemptResult(value); throw new Error("owner exited");}}});
    await expect(interrupted.execute(request)).rejects.toMatchObject({stage: "attempt_result"});
    expect(fixture.retryDecide).not.toHaveBeenCalled();
    const restored = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    expect(await restored.recover(request, {records: retained.reader, attempts: null})).toMatchObject({settlement: {status: "succeeded", attempts: [{ordinal: 1}, {ordinal: 2}]}});
    expect(fixture.retryDecide).toHaveBeenCalledTimes(1);
  });

  it("does not renew limits or retry after the original deadline", async () => {
    const fixture = createFixture({retryOnce: true});
    const retained = recoveryRecords();
    const request = {...fixture.request, maxAttempts: 2};
    const interrupted = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port,
      retry: {...fixture.dependencies.retry, wait: async () => {throw new Error("owner exited");}}});
    await expect(interrupted.execute(request)).rejects.toThrow("owner exited");
    fixture.order.length = 0;
    const wait = vi.fn(async () => "elapsed" as const);
    const restored = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port,
      now: () => request.deadlineAt, retry: {...fixture.dependencies.retry, wait}});
    await expect(restored.recover({...request, maxAttempts: 3}, {records: retained.reader, attempts: null})).rejects.toBeInstanceOf(ActionRecoveryError);
    await expect(restored.recover({...request, deadlineAt: "2026-08-14T00:00:00.000Z"}, {records: retained.reader, attempts: null})).rejects.toBeInstanceOf(ActionRecoveryError);
    expect(await restored.recover(request, {records: retained.reader, attempts: null})).toMatchObject({settlement: {status: "failed", causeRef: "action_deadline_exceeded", attempts: [{ordinal: 1}]}});
    expect(fixture.order).toEqual(["adapter.settle"]);
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects altered retry timing and dispatch checkpoints without invoking effects", async () => {
    const fixture = createFixture({retryOnce: true});
    const retained = recoveryRecords();
    const request = {...fixture.request, maxAttempts: 2};
    const interrupted = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port,
      retry: {...fixture.dependencies.retry, wait: async () => {throw new Error("owner exited");}}});
    await expect(interrupted.execute(request)).rejects.toThrow("owner exited");
    fixture.order.length = 0;
    const saved = await retained.reader.readAction();
    const restored = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    const altered = {...saved, attempts: [{...saved.attempts[0]!, retry: {...saved.attempts[0]!.retry!, notBefore: "2026-08-13T00:00:03.000Z"}}]};
    await expect(restored.recover(request, {records: {readAction: async () => altered}, attempts: null})).rejects.toBeInstanceOf(ActionRecoveryError);
    expect(fixture.order).toEqual([]);
  });

  it.each(["physical", "settlement"] as const)("recovers %s without preparation, approval or effect replay", async stage => {
    const fixture = createFixture();
    const retained = recoveryRecords();
    const coordinator = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    const original = await coordinator.execute(fixture.request);
    if (stage === "physical") retained.setSettlement(null);
    fixture.order.length = 0;
    const result = await coordinator.recover(fixture.request, {records: retained.reader, attempts: null});
    expect(result).toMatchObject({status: "settled", settlement: {status: "succeeded", payload: {content: "hello"}, attempts: [{ordinal: 1}]}});
    expect(fixture.order).toEqual(["adapter.settle"]);
    if (stage === "settlement") expect(result).toEqual(original);
  });

  it("preserves preparation diagnostics without manufacturing new messages during recovery", async () => {
    const fixture = createFixture({invalidPreparation: true});
    const retained = recoveryRecords();
    const coordinator = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    const original = await coordinator.execute(fixture.request);
    fixture.order.length = 0;
    expect(await coordinator.recover(fixture.request, {records: retained.reader, attempts: null})).toEqual(original);
    expect(fixture.order).toEqual([]);
  });

  it("reports unresolved dispatch as unknown effects, not a fabricated physical outcome or retry", async () => {
    const fixture = createFixture();
    const retained = recoveryRecords();
    const coordinator = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    await coordinator.execute(fixture.request);
    retained.setSettlement(null);
    retained.setResults([]);
    fixture.order.length = 0;
    const result = await coordinator.recover(fixture.request, {records: retained.reader, attempts: null});
    expect(result).toMatchObject({status: "settled", settlement: {status: "unknown_effect", effectCertainty: "unknown",
      completionExtent: "unknown", reconciliationRequired: true}});
    expect(fixture.order).toEqual(["adapter.settle"]);
    const records = await retained.reader.readAction();
    expect(records.attempts[0]?.result).toBeNull();
    expect(records.settlement).toMatchObject({sandbox: null, reconciliation: {status: "unknown"}});
  });

  it("uses correlated external evidence and retains it before semantic reconstruction", async () => {
    const fixture = createFixture();
    const retained = recoveryRecords();
    const coordinator = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    await coordinator.execute(fixture.request);
    const physical = (await retained.reader.readAction()).attempts[0]!.result!.result;
    retained.setSettlement(null);
    retained.setResults([]);
    fixture.order.length = 0;
    const result = await coordinator.recover(fixture.request, {records: retained.reader, attempts: {
      reconcile: async () => ({status: "settled", result: physical, evidenceRefs: ["executor-receipt-1"]}),
    }});
    expect(result).toMatchObject({settlement: {status: "succeeded"}});
    expect((await retained.reader.readAction()).attempts[0]?.result?.reconciliation).toEqual({evidenceRefs: ["executor-receipt-1"]});
    expect(fixture.order).toEqual(["adapter.settle"]);
  });

  it("does not turn an empty record lookup into dispatch authority", async () => {
    const fixture = createFixture();
    const retained = recoveryRecords();
    const coordinator = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    expect(await coordinator.recover(fixture.request, {records: retained.reader, attempts: null})).toEqual({status: "no_dispatch_record", prepared: null});
    expect(fixture.order).toEqual([]);
  });

  it("refuses mismatched evidence and changed bound inputs before execution", async () => {
    const fixture = createFixture();
    const retained = recoveryRecords();
    const coordinator = new ActionExecutionCoordinator({...fixture.dependencies, records: retained.port});
    await coordinator.execute(fixture.request);
    const physical = (await retained.reader.readAction()).attempts[0]!.result!.result;
    retained.setSettlement(null);
    retained.setResults([]);
    fixture.order.length = 0;
    await expect(coordinator.recover(fixture.request, {records: retained.reader, attempts: {
      reconcile: async () => ({status: "settled", result: {...physical, attempt: {...physical.attempt, id: "another-attempt"}}, evidenceRefs: ["receipt"]}),
    }})).rejects.toBeInstanceOf(ActionRecoveryError);
    await expect(coordinator.recover({...fixture.request, binding: {...fixture.request.binding,
      request: {path: "D:/different"}}}, {records: retained.reader, attempts: null})).rejects.toBeInstanceOf(ActionRecoveryError);
    expect(fixture.order).toEqual([]);
  });
  it("awaits correlated intent and physical-result commits before dispatch and semantic settlement", async () => {
    const fixture = createFixture();
    const recorded: Record<string, unknown> = {};
    let releaseIntent!: () => void;
    let releaseResult!: () => void;
    let enteredIntent!: () => void;
    let enteredResult!: () => void;
    const intentEntered = new Promise<void>(resolve => { enteredIntent = resolve; });
    const resultEntered = new Promise<void>(resolve => { enteredResult = resolve; });
    const intentGate = new Promise<void>(resolve => { releaseIntent = resolve; });
    const resultGate = new Promise<void>(resolve => { releaseResult = resolve; });
    const coordinator = new ActionExecutionCoordinator({ ...fixture.dependencies, records: {
      async recordPreparedAction() {return {recordId: "prepared-action"};},
      async recordPreEffect(value) { recorded.preparation = value; return { recordId: "prepared" }; },
      async recordDispatchIntent(value) {
        recorded.intent = value; enteredIntent(); await intentGate; return { recordId: "intent" };
      },
      async recordAttemptResult(value) {
        recorded.result = value; enteredResult(); await resultGate; return { recordId: "result" };
      },
      async recordPostEffect(value) { recorded.settlement = value; return { recordId: "settlement" }; },
      async recordRetry() {throw new Error("Unexpected retry");},
    } });
    const result = coordinator.execute(fixture.request);
    await intentEntered;
    expect(fixture.order).not.toContain("executor.execute");
    expect(recorded.preparation).toMatchObject({ runId: "run-1", binding: fixture.request.binding,
      prepared: { invocation: { payload: { path: "D:/workspace/README.md" } }, semanticBasis: { operation: "read" } } });
    expect(recorded.intent).toMatchObject({ preparationRecordId: "prepared", request: { attempt: { ordinal: 1, runId: "run-1" } } });
    expect(Object.keys((recorded.intent as { request: object }).request)).not.toContain("interruption");
    releaseIntent();
    await resultEntered;
    expect(fixture.order).toContain("executor.execute");
    expect(fixture.order).not.toContain("adapter.settle");
    expect(recorded.result).toMatchObject({ intentRecordId: "intent", result: { status: "settled" } });
    releaseResult();
    await expect(result).resolves.toMatchObject({ status: "settled", settlement: { status: "succeeded" } });
  });

  it.each(["recordPreparedAction", "recordPreEffect", "recordDispatchIntent", "recordAttemptResult", "recordPostEffect"] as const)(
    "propagates %s failure without inventing an execution settlement or retry", async method => {
      const fixture = createFixture({ retryOnce: true });
      const failure = new Error("storage unavailable");
      const coordinator = new ActionExecutionCoordinator({ ...fixture.dependencies, records: {
        ...fixture.dependencies.records, [method]: async () => { throw failure; },
      } });
      const result = coordinator.execute({ ...fixture.request, maxAttempts: 2 });
      await expect(result).rejects.toBeInstanceOf(ActionRecordCommitError);
      await expect(result).rejects.toMatchObject({ cause: failure, actionId: "action-1" });
      expect(fixture.order.filter(value => value === "executor.execute")).toHaveLength(
        method === "recordPostEffect" ? 2 : method === "recordAttemptResult" ? 1 : 0);
      expect(fixture.order).not.toContain("adapter.settle");
      expect(fixture.notifications.some(value => value.kind === "settled")).toBe(false);
    },
  );

  it("does not dispatch when ownership or authority changed during the intent commit", async () => {
    let current = true;
    const fixture = createFixture({ authorityCurrent: () => current });
    const coordinator = new ActionExecutionCoordinator({ ...fixture.dependencies, records: {
      ...fixture.dependencies.records,
      async recordDispatchIntent() { current = false; return { recordId: "intent" }; },
    } });
    await expect(coordinator.execute(fixture.request)).resolves.toMatchObject({
      settlement: { status: "invalidated", causeRef: "action_dispatch_basis_stale", effectCertainty: "none" },
    });
    expect(fixture.order).not.toContain("executor.execute");
  });
  it("records authority revalidation once without extra authority checks or execution", async () => {
    for (const stale of [false, true]) {
      let checks = 0;
      const fixture = createFixture({authorityCurrent: () => ++checks === 1 || !stale});
      const facts: ExecutionFlowObservation[] = [];
      const result = await fixture.coordinator.execute({...fixture.request, executionFlow: {observer: {observe: fact => {facts.push(fact);}}}});
      expect(result).toMatchObject({status: "settled", settlement: {status: stale ? "invalidated" : "succeeded"}});
      const observed = facts.filter(fact => fact.kind === "constraint" && fact.stepId === "revalidate" && fact.checkId === "authority");
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({disposition: stale ? "not_satisfied" : "passed", basis: {authorityRevision: "authority-revision-1"}});
      expect(checks).toBe(stale ? 2 : 4);
      expect(facts.some(fact => fact.kind === "material" && fact.name === "Action execution result")).toBe(true);
      expect(fixture.order.includes("executor.execute")).toBe(!stale);
    }
  });
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
      "authority.capture",
      "adapter.revalidate",
      "records.pre-effect",
      "records.dispatch-intent",
      "executor.execute",
      "records.attempt-result",
      "records.post-effect",
      "adapter.settle",
    ]);
    expect(result.settlement.attempts).toHaveLength(1);
    expect(result.settlement.subject).not.toBeNull();
    expect(Object.isFrozen(result.settlement)).toBe(true);
    const assessments = fixture.notifications.filter(value => value.kind === "assessment");
    expect(assessments).toHaveLength(2);
    expect(assessments[0]).toMatchObject({occurredAt: NOW, policy: {status: "allowed", recordId: "policy-record-1", revision: "policy-1"}, permission: null});
    expect(assessments[1]).toMatchObject({occurredAt: NOW, permission: {status: "authorized", recordId: "permission-record-1", revision: "authority-1"}});
  });

  it("preserves an adapter preparation diagnostic without dispatch or effects", async () => {
    const fixture = createFixture({ invalidPreparation: true });
    const result = await fixture.coordinator.execute(fixture.request);
    expect(result).toMatchObject({
      status: "settled",
      settlement: { status: "invalid", attempts: [], effectCertainty: "none", completionExtent: "none" },
      semanticResult: { status: "invalid", output: null, failure: {
        owner: "test-adapter", code: "target_mismatch",
        message: "The target does not match. Inspect its current contents before retrying.",
      } },
    });
    expect(fixture.order).toEqual(["adapter.prepare", "records.post-effect"]);
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

  it("attributes tree Approval-capacity exhaustion to Runtime rather than Permission denial", async () => {
    const detail = {kind: "capacity", stage: "approval_admission", scope: {owner: "agent-runtime", kind: "run_tree"},
      limit: {name: "equivalent_operation_requests", count: 2, maximum: 2}, dispatch: "never_dispatched",
      description: "Equivalent-operation approval capacity reached; action was never dispatched."} as const;
    const privateDetail = {...detail, secret: "private-review-payload"};
    const fixture = createFixture({
      permissionStatus: "approval_required",
      approvalResult: {
        status: "limit_exceeded",
        code: "approval_tree_operation_limit_exceeded",
        detail: privateDetail,
      },
    });

    const result = await fixture.coordinator.execute(fixture.request);

    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        status: "failed",
        causeOwner: "agent-runtime",
        causeRef: "approval_tree_operation_limit_exceeded",
        attempts: [], effectCertainty: "none", completionExtent: "none", failureDetail: detail,
      },
      semanticResult: {status: "failed", output: null, failure: {
        owner: "agent-runtime", code: "approval_tree_operation_limit_exceeded", detail,
      }},
    });
    if (result.status !== "settled") throw new Error("Expected settlement.");
    expect(result.settlement.failureDetail).toEqual(detail);
    expect(Object.isFrozen(result.settlement.failureDetail)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-review-payload");
    expect(fixture.order).not.toContain("executor.execute");
    expect(fixture.order).not.toContain("adapter.revalidate");
    expect(fixture.order).not.toContain("records.pre-effect");
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

  it("invalidates a prepared Action when its Runner progression basis changes before dispatch", async () => {
    const fixture = createFixture();

    const result = await fixture.coordinator.execute({
      ...fixture.request,
      isProgressionBasisCurrent: () => false,
    });

    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        status: "invalidated",
        causeOwner: "agent-runtime",
        causeRef: "action_progression_basis_invalidated",
        attempts: [],
      },
    });
    expect(fixture.order).not.toContain("executor.execute");
  });

  it("reassesses instead of dispatching when the captured authority revision becomes stale", async () => {
    let checks = 0;
    const fixture = createFixture({
      authorityCurrent: () => ++checks === 1,
    });

    const result = await fixture.coordinator.execute(fixture.request);

    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        status: "invalidated",
        causeOwner: "agent-runtime",
        causeRef: "action_authority_basis_stale",
      },
    });
    expect(fixture.order).toContain("adapter.revalidate");
    expect(fixture.order).not.toContain("records.pre-effect");
    expect(fixture.order).not.toContain("executor.execute");
    expect(checks).toBe(2);
  });

  it("refreshes authority after consuming exact Action approval coverage", async () => {
    let authorityRevision = 1;
    const fixture = createFixture({
      actionCoverageId: "coverage-1",
      onCoverageConsumed: () => {
        authorityRevision += 1;
      },
      captureAuthorityBasis: () => ({
        authorityRevision: `authority-revision-${authorityRevision}`,
        resourceRevision: 1,
      }),
      authorityCurrent: (basis) =>
        basis.authorityRevision === `authority-revision-${authorityRevision}`,
    });

    const result = await fixture.coordinator.execute(fixture.request);

    expect(result).toMatchObject({
      status: "settled",
      settlement: { status: "succeeded" },
    });
    expect(fixture.order).toEqual([
      "adapter.prepare",
      "policy.evaluate",
      "permission.assess",
      "authority.capture",
      "adapter.revalidate",
      "permission.consume",
      "authority.capture",
      "records.pre-effect",
      "records.dispatch-intent",
      "executor.execute",
      "records.attempt-result",
      "records.post-effect",
      "adapter.settle",
    ]);
  });
});

interface FixtureOptions {
  readonly invalidPreparation?: boolean;
  readonly policyStatus?: "allowed" | "denied";
  readonly permissionStatus?: "authorized" | "approval_required";
  readonly approvalResult?: Awaited<ReturnType<
    NonNullable<ActionExecutionCoordinatorDependencies["approval"]>["resolve"]
  >>;
  readonly sandboxEffectState?: "none" | "unknown";
  readonly retryOnce?: boolean;
  readonly actionCoverageId?: string;
  readonly onCoverageConsumed?: () => void;
  readonly captureAuthorityBasis?: () => {
    readonly authorityRevision: string;
    readonly resourceRevision: number;
  };
  readonly authorityCurrent?: (basis: {
    readonly authorityRevision: string;
    readonly resourceRevision: number;
  }) => boolean;
}

function createFixture(options: FixtureOptions = {}) {
  const order: string[] = [];
  const notifications: ActionExecutionNotification[] = [];
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
    executionLifetime: "invocation",
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
      if (options.invalidPreparation) return {
        status: "invalid" as const, owner: "test-adapter", code: "target_mismatch",
        message: "The target does not match. Inspect its current contents before retrying.",
      };
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
        actionCoverageId: options.actionCoverageId ?? null,
        assessedAt: NOW,
      };
    },
    async consumeActionCoverage() {
      order.push("permission.consume");
      options.onCoverageConsumed?.();
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
    observer: {observe: value => {notifications.push(value);}},
    registrations,
    adapters: [{ adapter }],
    policy,
    permission,
    approval: options.approvalResult === undefined
      ? null
      : Object.freeze({
          async resolve() {
            order.push("approval.resolve");
            return options.approvalResult!;
          },
        }),
    sandbox,
    records: {
      async recordPreparedAction() {return {recordId: "prepared-action"};},
      async recordPreEffect() {
        order.push("records.pre-effect");
        return { recordId: "pre-effect-1" };
      },
      async recordDispatchIntent() {
        order.push("records.dispatch-intent");
        return { recordId: "dispatch-intent-1" };
      },
      async recordAttemptResult() {
        order.push("records.attempt-result");
        return { recordId: "attempt-result-1" };
      },
      async recordRetry() {return {recordId: "retry-1"};},
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
    dependencies,
    notifications,
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
      isProgressionBasisCurrent: () => true,
      authority: {
        captureBasis() {
          order.push("authority.capture");
          return options.captureAuthorityBasis?.() ?? {
            authorityRevision: "authority-revision-1",
            resourceRevision: 1,
          };
        },
        isBasisCurrent: options.authorityCurrent ?? (() => true),
      },
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
          ...(settlement.failureDetail === undefined ? {} : {detail: settlement.failureDetail}),
        },
  };
}

function createSequentialId() {
  let sequence = 0;
  return (kind: string) => `${kind}-${++sequence}`;
}

function recoveryRecords() {
  let preparedAction: ActionRecoveryRecords["preparedAction"] = null;
  const preparations: {recordId: string; value: ActionPreparationRecord}[] = [];
  const intents: {recordId: string; intent: ActionDispatchIntent}[] = [];
  let results: ActionAttemptResultRecord[] = [];
  let settlement: ActionSettlementRecord | null = null;
  const retries: ActionRetryRecord[] = [];
  const port: ActionRecordPort = {
    async recordPreparedAction(value) {preparedAction = structuredClone(value); return {recordId: "prepared-action"};},
    async recordPreEffect(value) {const recordId = `preparation-${preparations.length}`; preparations.push({recordId, value: structuredClone(value)}); return {recordId};},
    async recordDispatchIntent(intent) {const recordId = `intent-${intents.length}`; intents.push({recordId, intent: structuredClone(intent)}); return {recordId};},
    async recordAttemptResult(value) {results.push(structuredClone(value)); return {recordId: `result-${results.length}`};},
    async recordRetry(value) {retries.push(structuredClone(value)); return {recordId: `retry-${retries.length}`};},
    async recordPostEffect(value) {settlement = structuredClone(value); return {recordId: "settlement"};},
  };
  const reader = {async readAction(): Promise<ActionRecoveryRecords> {return structuredClone({preparedAction, preparations,
    attempts: intents.map(intent => ({...intent, result: results.find(result => result.intentRecordId === intent.recordId) ?? null,
      retry: retries.find(retry => retry.intentRecordId === intent.recordId) ?? null})), settlement});}};
  return {port, reader, setResults: (value: ActionAttemptResultRecord[]) => {results = value;},
    setSettlement: (value: ActionSettlementRecord | null) => {settlement = value;}};
}

function createInterruption(): InvocationInterruptionContext {
  return Object.freeze({ signal: new AbortController().signal, interruption: null });
}

const NOW = "2026-08-13T00:00:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;
