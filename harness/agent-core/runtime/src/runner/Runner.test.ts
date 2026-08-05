import { describe, expect, it, vi } from "vitest";
import type {
  AuditPort,
  AuditRecord,
  ObservabilityRecordContext,
  RunTrace,
  RunTraceObserver,
  RuntimeEvent,
  TelemetryPort,
  TelemetryRecord,
} from "@agent-anything/observability";
import {
  createToolRegistrationSnapshot,
  createToolSelectionSnapshot,
  type ToolResult,
} from "@agent-anything/tools";
import { EvidenceBuilder } from "@agent-anything/context/evidence";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { ActionCandidate } from "@agent-anything/agent-core/action";
import type { RunInput } from "@agent-anything/agent-core/input";
import {
  ControllerError,
  type Controller,
  type ControllerCallContext,
  type ControllerDecision,
  type ControllerInput,
} from "../controller/index.js";
import type { RunConfig } from "./RunConfig.js";
import { Runner } from "./Runner.js";
import type { RetryEvent } from "../retry/index.js";
import {
  resolvePermissionProfile,
  type SessionAuthorityCommit,
  type SessionAuthorityCommitResult,
  type SessionAuthorityLookup,
  type SessionAuthorityPort,
  type SessionAuthorityRecord,
} from "@agent-anything/permission";
import type {
  ActionPolicyPort,
  ManagedPermissionConstraints,
} from "@agent-anything/governance";
import type {
  ActionAdapterPreparedData,
  ActionRegistrationSnapshot,
} from "@agent-anything/action-execution";
import { ActionEnforcementPipeline } from "@agent-anything/action-execution";
import {
  createActionRegistrationSnapshot,
  createEmptyToolActionBindingSnapshot,
  createToolActionBindingSnapshot,
} from "@agent-anything/action-execution";
import {
  assertActionExecutorDispatchContext,
  createActionEffectSet,
  createSandboxExecutionGateway,
  type SandboxProvider,
} from "@agent-anything/action-execution";
import type { ResolvedRunPermissionConfig } from "../run/index.js";
import {
  FakeApprovalReviewer,
  FakeEvidencePersistencePort,
  FakeRuntimeEventPublisher,
  createTestContextProjection,
} from "@agent-anything/test-support";
import type {
  AdditionalPermissions,
  ApprovalReviewInput,
  ApprovalReviewOutcome,
} from "@agent-anything/permission";

interface TestOutput {
  readonly summary: string;
}

const TEST_SHA_A = `sha256:${"a".repeat(64)}`;
const TEST_SHA_B = `sha256:${"b".repeat(64)}`;

type ControllerStep =
  | ControllerDecision<unknown>
  | Error
  | ((
      input: ControllerInput<unknown>,
      context: ControllerCallContext,
    ) => ControllerDecision<unknown> | Promise<ControllerDecision<unknown>>);

class ScriptedController implements Controller<unknown> {
  readonly calls: ControllerInput<unknown>[] = [];

  constructor(private readonly steps: ControllerStep[]) {}

  async next(
    input: ControllerInput<unknown>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<unknown>> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("ScriptedController has no remaining decision.");
    }
    if (step instanceof Error) {
      throw step;
    }
    return typeof step === "function" ? step(input, context) : step;
  }
}

describe("Runner", () => {
  it("completes a direct-output Run through one Controller iteration", async () => {
    const controller = new ScriptedController([finalDecision("Done")]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result.status).toBe("succeeded");
    expect(result.finalOutput).toEqual({ summary: "Done" });
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "final_output",
    ]);
    expect(result.items.map((item) => item.sequence)).toEqual([1, 2]);
    expect(controller.calls).toHaveLength(1);
    expect(controller.calls[0]).toMatchObject({
      runId: "run_001",
      iteration: 1,
      task: { id: "task_001" },
      context: {
        observations: [],
      },
      plan: null,
      permission: {
        profile: {
          profileId: ":read-only",
          canRequestAdditionalPermissions: false,
        },
        approval: {
          canRequest: false,
          reviewer: null,
          pending: false,
        },
      },
    });
    expect(JSON.stringify(controller.calls[0]?.permission)).not.toContain(
      "C:/workspace",
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fails the Run when a Context projector fabricates correlation", async () => {
    const testProjection = createTestContextProjection();
    const result = await createRunner(
      new ScriptedController([finalDecision("must not run")]),
      {
        contextProjection: {
          ...testProjection,
          projector: {
            project({ context }) {
              return {
                messages: context.messages,
                observations: [{
                  id: "fabricated-observation",
                  runId: "run_001",
                  actionId: "fabricated-action",
                  kind: "action_rejected",
                  code: "action_invalid",
                  message: "Fabricated.",
                  createdAt: "2026-07-13T00:00:00.000Z",
                  metadata: {},
                }],
                evidenceRefs: context.evidenceRefs,
                metadata: {},
              };
            },
          },
        },
      },
    ).run(createAgent(), createRunInput(), createRunConfig());

    expect(result).toMatchObject({
      status: "failed",
      code: "context_projection_failed",
      failure: {
        kind: "context",
        failure: { code: "context_projection_not_derived" },
      },
    });
  });

  it("commits safe Retry RunItems before their Runtime notifications", async () => {
    const runtimeEvents: RuntimeEvent[] = [];
    const traces: RunTrace[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => runtimeEvents.push(event));
    const controller = new ScriptedController([
      async (_input, context) => {
        expect(context.retry.providerRequest.retryableCategories).toEqual([
          "transport",
          "timeout",
        ]);
        expect(Object.isFrozen(context.retry.providerRequest)).toBe(true);
        await context.retry.events.emit({
          type: "retry_attempt_started",
          runId: "run_001",
          operationId: "retry_001",
          owner: "provider_request",
          occurredAt: "2026-07-13T00:00:00.000Z",
          attemptId: "attempt_001",
          budgetId: "budget_001",
          attemptNumber: 1,
          budgetAttemptNumber: 1,
          maxBudgetAttempts: 2,
          secret: "must not survive",
        } as RetryEvent);
        await context.retry.events.emit({
          type: "retry_attempt_finished",
          runId: "run_001",
          operationId: "retry_001",
          owner: "provider_request",
          occurredAt: "2026-07-13T00:00:00.010Z",
          attemptId: "attempt_001",
          budgetId: "budget_001",
          attemptNumber: 1,
          budgetAttemptNumber: 1,
          durationMs: 10,
          outcome: "succeeded",
          next: "return_to_owner",
        });
        return finalDecision("Done");
      },
    ]);
    const baseRetry = createTestRetryConfiguration();
    const retry: RunConfig["retry"] = {
      ...baseRetry,
      providerRequest: {
        ...baseRetry.providerRequest,
        maxRetries: 1,
        retryableCategories: ["transport", "transport", "timeout"],
      },
    };

    const result = await createRunner(
      controller,
      {
        runtimeEventPublisher: eventEmitter,
        runTraceObserver: {
          observe(trace) {
            traces.push(trace);
          },
        },
      },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ retry }),
    );
    await Promise.resolve();

    expect(result.items.map((item) => item.kind)).toEqual([
      "retry_attempt_started",
      "retry_attempt_finished",
      "model_output",
      "final_output",
    ]);
    const startedItem = result.items[0];
    expect(startedItem).toHaveProperty("retry.type", "retry_attempt_started");
    expect(startedItem).not.toHaveProperty("retry.secret");
    for (const [itemKind, eventName] of [
      ["retry_attempt_started", "retry.attempt.started"],
      ["retry_attempt_finished", "retry.attempt.finished"],
    ] as const) {
      const itemEventIndex = runtimeEvents.findIndex((event) =>
        event.name === "run.item.appended" && event.payload.itemKind === itemKind);
      const retryEventIndex = runtimeEvents.findIndex((event) => event.name === eventName);
      expect(itemEventIndex).toBeGreaterThanOrEqual(0);
      expect(retryEventIndex).toBeGreaterThan(itemEventIndex);
    }
    expect(traces.at(-1)).toMatchObject({
      status: "complete",
      issues: [],
    });
    expect(traces.at(-1)?.spans).toContainEqual(expect.objectContaining({
      owner: "retry",
      operation: "attempt",
      operationId: "attempt_001",
      status: "succeeded",
      attributes: expect.objectContaining({
        retryOperationId: "retry_001",
        retryOwner: "provider_request",
        attemptNumber: 1,
        outcome: "succeeded",
        reportedDurationMs: 10,
      }),
    }));
  });

  it("commits update_plan, exposes it to the next turn, and abandons an active Plan on success", async () => {
    const runtimeEvents: RuntimeEvent[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => runtimeEvents.push(event));
    const controller = new ScriptedController([
      actionsDecision([
        {
          kind: "internal",
          name: "update_plan",
          input: {
            explanation: "Track the work.",
            plan: [{ step: "Inspect files", status: "in_progress" }],
          },
          modelItemId: "model_1",
        },
      ]),
      finalDecision("Finished"),
    ]);

    const result = await createRunner(
      controller,
      { runtimeEventPublisher: eventEmitter },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result.status).toBe("succeeded");
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "plan_created",
      "observation",
      "model_output",
      "plan_abandoned",
      "final_output",
    ]);
    expect(controller.calls[1]?.plan).toMatchObject({
      id: "run_001:plan:1",
      version: 1,
      status: "active",
    });
    expect(controller.calls[1]?.context.observations).toHaveLength(1);
    expect(controller.calls[1]?.context.observations[0]).toMatchObject({
      kind: "plan_update",
      result: { status: "applied", transition: "created" },
    });
    expect(result.items.find((item) => item.kind === "plan_abandoned")).toMatchObject({
      terminalStatus: "succeeded",
      reasonCode: null,
    });
    expect(runtimeEvents.filter((event) => event.name.startsWith("plan."))).toMatchObject([
      {
        name: "plan.created",
        payload: {
          plan: { id: "run_001:plan:1", version: 1, status: "active" },
        },
      },
      {
        name: "plan.abandoned",
        payload: {
          plan: { id: "run_001:plan:1", version: 2, status: "abandoned" },
          terminalStatus: "succeeded",
          reasonCode: null,
        },
      },
    ]);
    for (const planEvent of runtimeEvents.filter((event) => event.name.startsWith("plan."))) {
      const itemEventIndex = runtimeEvents.findIndex((event) =>
        event.name === "run.item.appended" &&
        event.payload.itemKind === planEvent.name.replace(".", "_"));
      expect(itemEventIndex).toBeGreaterThanOrEqual(0);
      expect(runtimeEvents.indexOf(planEvent)).toBeGreaterThan(itemEventIndex);
      expect(JSON.stringify(planEvent)).not.toContain("Track the work.");
    }
  });

  it("maps Controller stop to blocked with an ordered stop lifecycle", async () => {
    const result = await createRunner(new ScriptedController([
      {
        kind: "stop",
        reason: "No safe path remains.",
        modelItems: [modelItem("model_1", { action: "stop" })],
      },
    ])).run(createAgent(), createRunInput(), createRunConfig());

    expect(result).toMatchObject({
      status: "blocked",
      code: "runtime_no_safe_path",
      finalOutput: null,
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "stop",
      "run_blocked",
    ]);
  });

  it("returns unsupported Actions as Observations and continues in the same loop", async () => {
    const controller = new ScriptedController([
      actionsDecision([
        {
          kind: "tool",
          name: "workspace.readFile",
          input: { path: "README.md" },
          modelItemId: "model_1",
        },
      ]),
      finalDecision("Recovered"),
    ]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result.status).toBe("succeeded");
    expect(controller.calls[1]?.context.observations[0]).toMatchObject({
      kind: "action_rejected",
      code: "action_unsupported",
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "observation",
      "model_output",
      "final_output",
    ]);
  });

  it("materializes a complete Action batch but stops processing its stale remainder", async () => {
    const controller = new ScriptedController([
      actionsDecision([
        {
          kind: "tool",
          name: "first.unsupported",
          input: {},
          modelItemId: "model_1",
        },
        {
          kind: "permission_request",
          name: "second.unsupported",
          input: {},
          modelItemId: "model_1",
        },
      ]),
      finalDecision("Replanned"),
    ]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result.items.filter((item) => item.kind === "action")).toHaveLength(2);
    expect(result.items.filter((item) => item.kind === "observation")).toHaveLength(1);
    expect(controller.calls[1]?.context.observations).toHaveLength(1);
  });

  it("enforces iteration, Action, failure, and duration limits", async () => {
    const iterationResult = await createRunner(new ScriptedController([
      actionsDecision([
        {
          kind: "internal",
          name: "update_plan",
          input: { plan: [{ step: "Wait", status: "pending" }] },
          modelItemId: "model_1",
        },
      ]),
    ])).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ limits: { maxIterations: 1 } }),
    );
    const actionResult = await createRunner(new ScriptedController([
      actionsDecision([
        {
          kind: "tool",
          name: "not-enabled",
          input: {},
          modelItemId: "model_1",
        },
      ]),
    ])).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ limits: { maxActions: 0 } }),
    );
    const failureResult = await createRunner(new ScriptedController([
      actionsDecision([
        {
          kind: "tool",
          name: "not-enabled",
          input: {},
          modelItemId: "model_1",
        },
      ]),
    ])).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ limits: { maxConsecutiveActionFailures: 0 } }),
    );

    let currentTime = "2026-07-13T00:00:00.000Z";
    const durationController = new ScriptedController([
      () => {
        currentTime = "2026-07-13T00:00:02.000Z";
        return finalDecision("Too late");
      },
    ]);
    const durationResult = await createRunner(durationController, {
      now: () => currentTime,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ limits: { maxDurationMs: 1_000 } }),
    );

    for (const result of [iterationResult, actionResult, failureResult, durationResult]) {
      expect(result).toMatchObject({
        status: "failed",
        code: "runtime_limit_exceeded",
      });
      expect(result.items.at(-1)?.kind).toBe("run_failed");
    }
    expect(actionResult.items.some((item) => item.kind === "action")).toBe(false);
    expect(failureResult.items.some((item) => item.kind === "observation")).toBe(true);
    expect(durationResult.items.some((item) => item.kind === "model_output")).toBe(false);
  });

  it("cancels before Controller work begins", async () => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const handle = createRunner(controller).start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );
    const receipt = handle.cancel({
      origin: "user",
      reasonCode: "user_requested",
    });
    const result = await handle.wait();

    expect(receipt.status).toBe("accepted");
    expect(result).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      cancellation: { origin: "user", reasonCode: "user_requested" },
    });
    expect(controller.calls).toHaveLength(0);
    expect(result.items.map((item) => item.kind)).toEqual([
      "run_cancellation_requested",
      "run_cancelled",
    ]);
  });

  it("waits for an active Controller boundary and discards its decision when cancellation wins", async () => {
    let handle!: ReturnType<Runner["start"]>;
    const controller = new ScriptedController([
      () => {
        handle.cancel({
          origin: "host",
          reasonCode: "host_requested",
        });
        return finalDecision("Discarded");
      },
    ]);

    handle = createRunner(controller).start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(result.items.map((item) => item.kind)).toEqual([
      "run_cancellation_requested",
      "run_cancelled",
    ]);
  });

  it("commits cancellation immediately while the Controller boundary is still active", async () => {
    const controllerStarted = createDeferred<void>();
    const controllerResult = createDeferred<ControllerDecision<unknown>>();
    const appendedKinds: string[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => {
      if (event.name === "run.item.appended" && typeof event.payload.itemKind === "string") {
        appendedKinds.push(event.payload.itemKind);
      }
    });
    const controller: Controller<unknown> = {
      async next() {
        controllerStarted.resolve();
        return controllerResult.promise;
      },
    };

    const handle = createRunner(
      controller,
      { runtimeEventPublisher: eventEmitter },
    ).start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );
    await controllerStarted.promise;

    handle.cancel({
      origin: "user",
      reasonCode: "user_requested",
    });

    expect(appendedKinds).toEqual(["run_cancellation_requested"]);
    controllerResult.resolve(finalDecision("Discarded"));
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(result.items.map((item) => item.kind)).toEqual([
      "run_cancellation_requested",
      "run_cancelled",
    ]);
  });

  it("fails with cancellation attribution when Controller settlement times out", async () => {
    vi.useFakeTimers();
    try {
      const controllerStarted = createDeferred<void>();
      const controller: Controller<unknown> = {
        async next() {
          controllerStarted.resolve();
          return new Promise<ControllerDecision<unknown>>(() => {});
        },
      };
      const handle = createRunner(controller).start(
        createAgent(),
        createRunInput(),
        createRunConfig({
          cancellationLimits: { operationSettlementTimeoutMs: 25 },
        }),
      );
      await controllerStarted.promise;

      handle.cancel({
        origin: "host",
        reasonCode: "host_requested",
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await handle.wait();

      expect(result).toMatchObject({
        status: "failed",
        code: "runtime_cancellation_settlement_timeout",
        cancellation: { reasonCode: "host_requested" },
        failure: {
          kind: "runtime",
          failure: {
            code: "runtime_cancellation_settlement_timeout",
            metadata: { operation: "controller", settlementTimeoutMs: 25 },
          },
        },
        relatedFailures: [],
      });
      expect(result.items.map((item) => item.kind)).toEqual([
        "run_cancellation_requested",
        "run_failed",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves Provider cancellation-unconfirmed failure with cancellation summary", async () => {
    let handle!: ReturnType<Runner["start"]>;
    const controller: Controller<unknown> = {
      async next() {
        handle.cancel({
          origin: "host",
          reasonCode: "host_requested",
        });
        throw new ControllerError(
          {
            kind: "provider",
            failure: {
              category: "cancellation",
              code: "provider_cancellation_unconfirmed",
              message: "Provider settlement could not be confirmed.",
              metadata: {},
            },
          },
          "settled_failure",
        );
      },
    };

    handle = createRunner(controller).start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "failed",
      code: "provider_cancellation_unconfirmed",
      cancellation: { reasonCode: "host_requested" },
      failure: {
        kind: "provider",
        failure: { code: "provider_cancellation_unconfirmed" },
      },
      relatedFailures: [],
    });
  });

  it("does not relabel a settled Provider timeout as Run cancellation", async () => {
    let handle!: ReturnType<Runner["start"]>;
    const controller: Controller<unknown> = {
      async next() {
        handle.cancel({
          origin: "host",
          reasonCode: "host_requested",
        });
        throw new ControllerError(
          {
            kind: "provider",
            failure: {
              category: "timeout",
              code: "provider_timeout",
              message: "Provider request timed out.",
              metadata: {},
            },
          },
          "settled_failure",
        );
      },
    };

    handle = createRunner(controller).start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "failed",
      code: "provider_timeout",
      cancellation: { reasonCode: "host_requested" },
      failure: {
        kind: "provider",
        failure: { code: "provider_timeout" },
      },
      relatedFailures: [],
    });
  });

  it("returns failed with cancellation attribution when required cancellation finalization fails", async () => {
    let handle!: ReturnType<Runner["start"]>;
    const controller = new ScriptedController([
      () => {
        handle.cancel({
          origin: "host",
          reasonCode: "host_requested",
        });
        return finalDecision("Discarded");
      },
    ]);
    let telemetryCalls = 0;
    const telemetryPort: TelemetryPort = {
      async record() {
        telemetryCalls += 1;
        if (telemetryCalls === 2) {
          throw new Error("Cancellation finalization telemetry failed.");
        }
      },
    };

    handle = createRunner(controller, { telemetryPort }).start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        telemetry: "required",
      }),
    );
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "failed",
      code: "telemetry_required_failed",
      cancellation: {
        origin: "host",
        reasonCode: "host_requested",
      },
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "run_cancellation_requested",
      "run_failed",
    ]);
  });

  it.each([
    ["audit", "audit_finalization_timeout"],
    ["telemetry", "telemetry_finalization_timeout"],
  ] as const)(
    "bounds an unresponsive required %s finalization recorder",
    async (owner, expectedCode) => {
      vi.useFakeTimers();
      try {
        const finalizationStarted = createDeferred<void>();
        const hangingPort = {
          async record(_record: unknown, context: ObservabilityRecordContext) {
            if (context.purpose !== "finalization") {
              return;
            }
            finalizationStarted.resolve();
            await new Promise<void>(() => {});
          },
        };
        const run = createRunner(
          new ScriptedController([finalDecision("Candidate")]),
          owner === "audit"
            ? { auditPort: hangingPort as AuditPort }
            : { telemetryPort: hangingPort as TelemetryPort },
        ).run(
          createAgent(),
          createRunInput(),
          createRunConfig({
            audit: owner === "audit" ? "required" : "optional",
            telemetry: owner === "telemetry" ? "required" : "optional",
            cancellationLimits: { finalizationTimeoutMs: 25 },
          }),
        );
        await finalizationStarted.promise;

        await vi.advanceTimersByTimeAsync(25);
        const result = await run;

        expect(result).toMatchObject({
          status: "failed",
          code: expectedCode,
          failure: { kind: owner, failure: { code: expectedCode } },
          relatedFailures: [],
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("records required finalization before optional work consumes the deadline", async () => {
    vi.useFakeTimers();
    try {
      const optionalFinalizationStarted = createDeferred<void>();
      const finalizationOrder: string[] = [];
      const auditPort: AuditPort = {
        async record(_record, context) {
          if (context.purpose !== "finalization") {
            return;
          }
          finalizationOrder.push("audit");
          optionalFinalizationStarted.resolve();
          await new Promise<void>(() => {});
        },
      };
      const telemetryPort: TelemetryPort = {
        async record(_record, context) {
          if (context.purpose === "finalization") {
            finalizationOrder.push("telemetry");
          }
        },
      };
      const run = createRunner(
        new ScriptedController([finalDecision("Done")]),
        { auditPort, telemetryPort },
      ).run(
        createAgent(),
        createRunInput(),
        createRunConfig({
          audit: "optional",
          telemetry: "required",
          cancellationLimits: { finalizationTimeoutMs: 25 },
        }),
      );
      await optionalFinalizationStarted.promise;

      await vi.advanceTimersByTimeAsync(25);
      const result = await run;

      expect(result.status).toBe("succeeded");
      expect(finalizationOrder).toEqual(["telemetry", "audit"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets accepted cancellation win before terminal commit", async () => {
    const events: RuntimeEvent[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => events.push(event));
    const finalizationStarted = createDeferred<void>();
    const releaseFinalization = createDeferred<void>();
    const finalizationRecords: string[] = [];
    const finalizationSignals: AbortSignal[] = [];
    const telemetryPort: TelemetryPort = {
      async record(record: TelemetryRecord, context) {
        if (context.purpose === "finalization") {
          finalizationRecords.push(record.eventName);
          finalizationSignals.push(context.signal);
        }
        if (record.eventName === "runner.run.succeeded") {
          finalizationStarted.resolve();
          await releaseFinalization.promise;
        }
      },
    };
    const handle = createRunner(
      new ScriptedController([finalDecision("Must not commit")]),
      { runtimeEventPublisher: eventEmitter, telemetryPort },
    ).start(
      createAgent(),
      createRunInput(),
      createRunConfig({ telemetry: "required" }),
    );
    await finalizationStarted.promise;

    handle.cancel({
      origin: "user",
      reasonCode: "user_requested",
    });
    releaseFinalization.resolve();
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "run_cancellation_requested",
      "run_cancelled",
    ]);
    expect(finalizationRecords).toEqual([
      "runner.run.succeeded",
      "runner.run.cancelled",
    ]);
    expect(finalizationSignals).toHaveLength(2);
    expect(finalizationSignals[0]?.aborted).toBe(false);
    expect(finalizationSignals[1]).not.toBe(finalizationSignals[0]);
    expect(events.filter((event) => [
      "run.completed",
      "run.blocked",
      "run.failed",
      "run.cancelled",
    ].includes(event.name))).toMatchObject([{ name: "run.cancelled" }]);
  });

  it("abandons an active Plan with the authoritative finalization failure", async () => {
    const telemetryPort: TelemetryPort = {
      async record(_record, context) {
        if (context.purpose === "finalization") {
          throw new Error("Terminal telemetry failed.");
        }
      },
    };
    const controller = new ScriptedController([
      actionsDecision([{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "Track finalization.",
          plan: [{ step: "Finish", status: "in_progress" }],
        },
        modelItemId: "model_1",
      }]),
      finalDecision("Candidate"),
    ]);

    const result = await createRunner(controller, { telemetryPort }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ telemetry: "required" }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "telemetry_required_failed",
    });
    expect(result.items.find((item) => item.kind === "plan_abandoned")).toMatchObject({
      terminalStatus: "failed",
      reasonCode: "telemetry_required_failed",
    });
  });

  it("does not rewrite a terminal result when cancellation is requested later", async () => {
    const events: RuntimeEvent[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => events.push(event));
    const handle = createRunner(
      new ScriptedController([finalDecision("Committed")]),
      { runtimeEventPublisher: eventEmitter },
    ).start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );
    const result = await handle.wait();
    const eventCount = events.length;

    const receipt = handle.cancel({
      origin: "user",
      reasonCode: "user_requested",
    });

    expect(receipt.status).toBe("run_settled");
    expect(result.status).toBe("succeeded");
    expect(result.items.some((item) => item.kind === "run_cancellation_requested")).toBe(false);
    expect(events).toHaveLength(eventCount);
  });

  it("preserves typed Controller failure ownership", async () => {
    const controllerError = new ControllerError(Object.freeze({
      kind: "provider",
      failure: Object.freeze({
        category: "transport",
        code: "provider_request_failed",
        message: "Provider unavailable.",
        metadata: Object.freeze({ providerId: "test-provider" }),
      }),
    }));
    const result = await createRunner(new ScriptedController([controllerError])).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "provider_request_failed",
      failure: {
        kind: "provider",
        failure: { code: "provider_request_failed" },
      },
      relatedFailures: [],
    });
  });

  it("rejects malformed Controller decisions before committing model history", async () => {
    const malformed = {
      kind: "actions",
      actions: [],
      modelItems: [],
    } as unknown as ControllerDecision<unknown>;
    const result = await createRunner(new ScriptedController([malformed])).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "model_output_invalid",
    });
    expect(result.items.map((item) => item.kind)).toEqual(["run_failed"]);
  });

  it("maps required Audit and Telemetry failures without making optional ports authoritative", async () => {
    const missingAudit = await createRunner(new ScriptedController([finalDecision("Unused")])).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ audit: "required" }),
    );

    const optionalAudit: AuditPort = {
      async record() {
        throw new Error("Optional audit unavailable.");
      },
    };
    const optionalResult = await createRunner(
      new ScriptedController([finalDecision("Done")]),
      { auditPort: optionalAudit },
    ).run(createAgent(), createRunInput(), createRunConfig());

    let telemetryCalls = 0;
    const requiredTelemetry: TelemetryPort = {
      async record() {
        telemetryCalls += 1;
        if (telemetryCalls === 2) {
          throw new Error("Terminal telemetry failed.");
        }
      },
    };
    const telemetryResult = await createRunner(
      new ScriptedController([finalDecision("Candidate")]),
      { telemetryPort: requiredTelemetry },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ telemetry: "required" }),
    );

    expect(missingAudit).toMatchObject({
      status: "failed",
      code: "audit_required_failed",
      failure: { kind: "audit" },
      relatedFailures: [],
    });
    expect(optionalResult.status).toBe("succeeded");
    expect(telemetryResult).toMatchObject({
      status: "failed",
      code: "telemetry_required_failed",
      failure: { kind: "telemetry" },
      relatedFailures: [],
    });
    expect(telemetryResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "run_failed",
    ]);
  });

  it("records immutable top-level Run and Task correlation without metadata bags", async () => {
    const auditRecords: AuditRecord[] = [];
    const telemetryRecords: TelemetryRecord[] = [];
    const auditPort: AuditPort = {
      async record(record) {
        auditRecords.push(record);
      },
    };
    const telemetryPort: TelemetryPort = {
      async record(record) {
        telemetryRecords.push(record);
      },
    };

    const result = await createRunner(
      new ScriptedController([finalDecision("Recorded")]),
      { auditPort, telemetryPort },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ audit: "required", telemetry: "required" }),
    );

    expect(result.status).toBe("succeeded");
    expect(auditRecords.map(({ eventName }) => eventName)).toEqual([
      "run.started",
      "run.succeeded",
    ]);
    expect(telemetryRecords.map(({ eventName }) => eventName)).toEqual([
      "runner.run.started",
      "runner.run.succeeded",
    ]);
    for (const record of auditRecords) {
      expect(record).toMatchObject({
        schemaVersion: 1,
        runId: result.runId,
        taskId: result.taskId,
      });
      expect(Object.hasOwn(record, "metadata")).toBe(false);
      expect(Object.hasOwn(record.target, "metadata")).toBe(false);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.payload)).toBe(true);
    }
    for (const record of telemetryRecords) {
      expect(record).toMatchObject({
        schemaVersion: 1,
        runId: result.runId,
        taskId: result.taskId,
      });
      expect(Object.hasOwn(record, "metadata")).toBe(false);
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.counters)).toBe(true);
      expect(Object.isFrozen(record.dimensions)).toBe(true);
    }
  });

  it("publishes committed item notifications and ignores subscriber failures", async () => {
    const events: RuntimeEvent[] = [];
    const emitter = new FakeRuntimeEventPublisher();
    emitter.subscribe((event) => events.push(event));
    const result = await createRunner(
      new ScriptedController([finalDecision("Done")]),
      { runtimeEventPublisher: emitter },
    ).run(createAgent(), createRunInput(), createRunConfig());
    const itemEvents = events.filter((event) => event.name === "run.item.appended");

    expect(itemEvents.map((event) => event.payload)).toEqual(
      result.items.map((item) => ({
        itemId: item.id,
        itemKind: item.kind,
        itemSequence: item.sequence,
      })),
    );
    expect(itemEvents.every((event) => event.runId === result.runId)).toBe(true);

    const throwingEmitter = new FakeRuntimeEventPublisher();
    throwingEmitter.subscribe(() => {
      throw new Error("Renderer listener failed.");
    });
    const unaffected = await createRunner(
      new ScriptedController([finalDecision("Still done")]),
      { runtimeEventPublisher: throwingEmitter },
    ).run(createAgent(), createRunInput(), createRunConfig());
    expect(unaffected.status).toBe("succeeded");
  });

  it("fans the same Run-local event snapshots to invocation and configured publishers", async () => {
    const configured = new FakeRuntimeEventPublisher();
    const invocation = new FakeRuntimeEventPublisher();
    const result = await createRunner(
      new ScriptedController([finalDecision("Done")]),
      { runtimeEventPublisher: configured },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
      { runtimeEventPublisher: invocation },
    );
    const configuredEvents = configured.events();
    const invocationEvents = invocation.events();

    expect(result.status).toBe("succeeded");
    expect(configuredEvents).toHaveLength(invocationEvents.length);
    expect(configuredEvents.length).toBeGreaterThan(0);
    for (let index = 0; index < configuredEvents.length; index += 1) {
      expect(configuredEvents[index]).toBe(invocationEvents[index]);
      expect(configuredEvents[index]?.sequence).toBe(index + 1);
      expect(configuredEvents[index]?.runId).toBe(result.runId);
      expect(configuredEvents[index]?.taskId).toBe(result.taskId);
    }
  });

  it("assembles an optional complete RunTrace from the exact RunResult", async () => {
    const traces: RunTrace[] = [];
    const observer: RunTraceObserver = {
      observe(trace) {
        traces.push(trace);
      },
    };
    const result = await createRunner(
      new ScriptedController([finalDecision("Done")]),
      { runTraceObserver: observer },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
      { runTraceObserver: observer },
    );
    await Promise.resolve();

    const trace = traces.at(-1);
    expect(result.status).toBe("succeeded");
    expect(trace).toMatchObject({
      runId: result.runId,
      taskId: result.taskId,
      status: "complete",
      completedAt: "2026-07-13T00:00:00.000Z",
      issues: [],
    });
    expect(trace?.spans[0]).toMatchObject({
      owner: "runtime",
      operation: "run",
      status: "succeeded",
      attributes: {
        itemCount: result.items.length,
        evidenceCount: result.evidenceRefs.length,
        artifactCount: result.artifactRefs.length,
      },
    });
    expect(trace?.spans).toContainEqual(expect.objectContaining({
      owner: "controller",
      operation: "turn",
      operationId: "controller-turn:1",
      status: "succeeded",
    }));
    expect(trace?.spans[0]?.links.filter((link) => link.kind === "run_item"))
      .toHaveLength(result.items.length);
    expect(Object.isFrozen(trace)).toBe(true);
  });

  it("isolates RunTrace construction and observer failures from execution", async () => {
    const asyncObserver: RunTraceObserver = {
      observe() {
        return Promise.reject(new Error("Trace export failed."));
      },
    };
    const syncObserver: RunTraceObserver = {
      observe() {
        throw new Error("Trace subscriber failed.");
      },
    };
    const result = await createRunner(
      new ScriptedController([finalDecision("Done")]),
      {
        runTraceObserver: syncObserver,
        createId(input) {
          if (input.kind === "run_trace") {
            throw new Error("Trace identity unavailable.");
          }
          return `${input.runId}:${input.kind}:${input.sequence}`;
        },
      },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
      { runTraceObserver: asyncObserver },
    );
    await Promise.resolve();

    expect(result.status).toBe("succeeded");

    const observerFailureResult = await createRunner(
      new ScriptedController([finalDecision("Still done")]),
      {
        runTraceObserver: syncObserver,
        createRunId: () => "run_trace_observer_failure",
      },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
      { runTraceObserver: asyncObserver },
    );
    await Promise.resolve();
    expect(observerFailureResult.status).toBe("succeeded");
  });

  it("rejects invalid RunConfig before creating a Run", () => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const runner = createRunner(controller);

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig({ limits: { maxIterations: 0 } }),
    )).toThrow("RunLimits.maxIterations must be a positive integer.");
    expect(controller.calls).toHaveLength(0);
  });

  it("rejects malformed resolved Retry policy before creating a Run", () => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const baseRetry = createTestRetryConfiguration();
    const retry = {
      ...baseRetry,
      providerRequest: {
        ...baseRetry.providerRequest,
        maxRetries: -1,
      },
    };
    const runner = createRunner(controller);

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig({ retry }),
    )).toThrow("maxRetries");
    expect(controller.calls).toHaveLength(0);
  });

  it.each([
    "operationSettlementTimeoutMs",
    "processGracePeriodMs",
    "processForceKillTimeoutMs",
    "finalizationTimeoutMs",
  ] as const)("rejects non-positive cancellation limit %s", (field) => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const runner = createRunner(controller);

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        cancellationLimits: { [field]: 0 },
      }),
    )).toThrow(field);
    expect(controller.calls).toHaveLength(0);
  });

  it("rejects cancellation limits above the timer range before creating a Run", () => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const runner = createRunner(controller);

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        cancellationLimits: { operationSettlementTimeoutMs: 2_147_483_648 },
      }),
    )).toThrow("2147483647");
    expect(controller.calls).toHaveLength(0);
  });

  it("keeps concurrent Run state invocation-local", async () => {
    const controller: Controller<unknown> = {
      async next(input) {
        return finalDecision(input.runId);
      },
    };
    const runIds = ["run_a", "run_b"];
    const runner = createRunner(controller, {
      createRunId: () => runIds.shift()!,
    });

    const [first, second] = await Promise.all([
      runner.run(createAgent(), createRunInput(), createRunConfig()),
      runner.run(createAgent(), createRunInput(), createRunConfig()),
    ]);

    expect(first.status === "succeeded" && first.finalOutput.summary).toBe("run_a");
    expect(second.status === "succeeded" && second.finalOutput.summary).toBe("run_b");
    expect(first.items.every((item) => item.runId === "run_a")).toBe(true);
    expect(second.items.every((item) => item.runId === "run_b")).toBe(true);
  });

  it("rejects duplicate active Run identities and permits reuse after settlement", async () => {
    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<ControllerDecision>();
    let calls = 0;
    const controller: Controller = {
      async next() {
        calls += 1;
        if (calls === 1) {
          firstEntered.resolve();
          return releaseFirst.promise;
        }
        return finalDecision("Reused after settlement");
      },
    };
    const runner = createRunner(controller, {
      createRunId: () => "run_reused",
    });

    const first = runner.start(createAgent(), createRunInput(), createRunConfig());
    await firstEntered.promise;

    expect(() =>
      runner.start(createAgent(), createRunInput(), createRunConfig())
    ).toThrow("Runner-created runId 'run_reused' is already active.");

    releaseFirst.resolve(finalDecision("First settled"));
    await first.wait();

    const second = runner.start(createAgent(), createRunInput(), createRunConfig());
    const secondResult = await second.wait();

    expect(second.runId).toBe("run_reused");
    expect(secondResult).toMatchObject({
      runId: "run_reused",
      status: "succeeded",
      finalOutput: { summary: "Reused after settlement" },
    });
  });

  it("settles an accepted handle if unexpected-failure materialization rejects", async () => {
    const runner = createRunner(
      new ScriptedController([finalDecision("Must not escape")]),
      {
        now: () => {
          throw new Error("broken Runner clock");
        },
        createRunId: () => "run_emergency",
      },
    );

    const handle = runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );
    const result = await handle.wait();

    expect(result).toMatchObject({
      runId: "run_emergency",
      status: "failed",
      code: "runtime_execution_failed",
      failure: {
        kind: "runtime",
        failure: {
          code: "runtime_execution_failed",
          message: "Agent Core execution could not settle its failure path.",
        },
      },
      metadata: { emergencySettlement: true },
    });
    expect(handle.getResult()).toBe(result);
    expect(JSON.stringify(result)).not.toContain("broken Runner clock");
  });

  it("snapshots the Run Workspace before asynchronous execution", async () => {
    const workspace = {
      primary: {
          id: "workspace_code",
          name: "Code",
          rootRef: "workspace://code",
          trustState: "trusted",
          source: "test",
          policyRefs: [],
          metadata: {},
        },
      additional: [{
          id: "workspace_docs",
          name: "Docs",
          rootRef: "workspace://docs",
          trustState: "restricted",
          source: "test",
          policyRefs: [],
          metadata: {},
        }],
    };
    const controller = new ScriptedController([finalDecision("Done")]);
    const config = createRunConfig({ workspace });
    const running = createRunner(controller).run(
      createAgent(),
      createRunInput(),
      config,
    );

    workspace.primary.id = "mutated_after_start";
    await running;

    expect(controller.calls[0]?.workspace.primary.id).toBe("workspace_code");
    expect(controller.calls[0]?.workspace.additional[0]?.id).toBe("workspace_docs");
    expect(Object.isFrozen(controller.calls[0]?.workspace)).toBe(true);
    expect(Object.isFrozen(controller.calls[0]?.workspace.additional)).toBe(true);
  });

  it("runs without a Workspace when the selected capabilities require no roots", async () => {
    const controller = new ScriptedController([finalDecision("No Workspace required")]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        workspace: null,
        permissions: createTestPermissionConfig([]),
      }),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "No Workspace required" },
    });
    expect(controller.calls[0]?.workspace).toBeNull();
  });

});

describe("Runner external Action approval attachment", () => {
  it("reassesses the exact prepared Action after applied authority without preparing it twice", async () => {
    const reviewer = createApprovalReviewer((input) => {
      expect(input.context).toMatchObject({
        workspaceTrustState: "trusted",
        ruleOutcome: "none",
        currentAuthority: {
          fileSystemRead: false,
          fileSystemWrite: false,
          network: false,
        },
        annotations: { source: "external_action" },
      });
      const option = input.request.decisionOptions.find(({ kind }) => kind === "accept");
      if (option === undefined) throw new Error("Action approval option was not offered.");
      return {
        status: "decided",
        submission: {
          submissionId: "submission_action_accept",
          runId: input.request.runId,
          requestId: input.request.id,
          pendingVersion: input.pendingVersion,
          optionId: option.id,
          grantedPermissions: null,
          reason: null,
        },
        rationale: null,
      };
    });
    const fixture = createExternalActionPipeline("requires_review");
    const auditRecords: { readonly eventName: string; readonly payload: Record<string, unknown> }[] = [];
    const auditPort: AuditPort = {
      async record(record) {
        auditRecords.push(record);
      },
    };
    const controller = new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.external",
        input: {},
        modelItemId: "model_1",
      }]),
      finalDecision("Done"),
    ]);
    const result = await createRunner(controller, {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      auditPort,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createDisabledReviewPermissionConfig(reviewer),
        audit: "required",
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.prepareCalls()).toBe(1);
    expect(fixture.policyCalls()).toBe(3);
    expect(fixture.revalidationCalls()).toBe(1);
    expect(result.items.filter(({ kind }) => kind === "approval_requested")).toHaveLength(1);
    expect(result.items.filter(({ kind }) => kind === "approval_resolved")).toHaveLength(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "tool_result",
        result: expect.objectContaining({ status: "succeeded", output: { ok: true } }),
      }),
    }));
    expect(fixture.executionCalls()).toBe(1);
    expect(auditRecords.find(({ eventName }) => eventName === "action.dispatch_authorized"))
      .toEqual(expect.objectContaining({
        payload: expect.objectContaining({ actionCoverageId: expect.any(String) }),
      }));
  });

  it("settles an external Action decline without reassessment", async () => {
    const reviewer = createApprovalReviewer((input) => {
      const option = input.request.decisionOptions.find(({ kind }) => kind === "decline");
      if (option === undefined) throw new Error("Decline option was not offered.");
      return {
        status: "decided",
        submission: {
          submissionId: "submission_action_decline",
          runId: input.request.runId,
          requestId: input.request.id,
          pendingVersion: input.pendingVersion,
          optionId: option.id,
          grantedPermissions: null,
          reason: "Not now",
        },
        rationale: null,
      };
    });
    const fixture = createExternalActionPipeline("requires_review");
    const controller = new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.external",
        input: {},
        modelItemId: "model_1",
      }]),
      finalDecision("Continued"),
    ]);
    const result = await createRunner(controller, {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.prepareCalls()).toBe(1);
    expect(fixture.policyCalls()).toBe(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "approval_declined",
        reason: "Not now",
        metadata: expect.objectContaining({
          actionKind: "tool",
          actionName: "test.external",
        }),
      }),
    }));
  });

  it("rejects a partial external Action composition before starting the Run", () => {
    const fixture = createExternalActionPipeline("allowed");
    const runner = createRunner(new ScriptedController([finalDecision("unused")]), {
      actionEnforcementPipeline: fixture.pipeline,
    });

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    )).toThrow("must be configured together");
    expect(fixture.prepareCalls()).toBe(0);
  });

  it("fails closed when required authorization Audit fails after revalidation", async () => {
    const fixture = createExternalActionPipeline("allowed");
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "action.dispatch_authorized") {
          throw new Error("Authorization Audit unavailable.");
        }
      },
    };
    const result = await createRunner(new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.external",
        input: {},
        modelItemId: "model_1",
      }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      auditPort,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "required",
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "audit_required_failed",
      failure: {
        kind: "audit",
        failure: { code: "audit_required_failed" },
      },
      relatedFailures: [],
    });
    expect(fixture.policyCalls()).toBe(2);
    expect(fixture.revalidationCalls()).toBe(1);
    expect(result.items).not.toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({ kind: "action_failure" }),
    }));
  });

  it("honors cancellation accepted after authorization Audit and before dispatch", async () => {
    let handle!: ReturnType<Runner["start"]>;
    const fixture = createExternalActionPipeline("allowed");
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "action.dispatch_authorized") {
          handle.cancel({
            origin: "user",
            reasonCode: "user_requested",
          });
        }
      },
    };
    handle = createRunner(new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.external",
        input: {},
        modelItemId: "model_1",
      }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      auditPort,
      sandboxExecutionGateway: fixture.gateway,
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "required",
      }),
    );
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      cancellation: { reasonCode: "user_requested" },
    });
    expect(result.items).not.toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({ kind: "action_failure" }),
    }));
  });
});

describe("Runner sandbox denial escalation", () => {
  it("rebuilds, approves, revalidates, and executes one changed-fingerprint second attempt", async () => {
    const reviewer = createApprovalReviewer((input) => {
      const option = input.request.decisionOptions.find(({ kind }) => kind === "accept");
      if (option === undefined) throw new Error("Escalated Action accept option was not offered.");
      return {
        status: "decided",
        submission: {
          submissionId: "submission_escalation_accept",
          runId: input.request.runId,
          requestId: input.request.id,
          pendingVersion: input.pendingVersion,
          optionId: option.id,
          grantedPermissions: null,
          reason: null,
        },
        rationale: null,
      };
    });
    const fixture = createEscalatingExternalActionFixture();
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
      finalDecision("Escalated"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(2);
    expect(fixture.reconciliationCalls()).toBe(1);
    expect(result.items.filter(({ kind }) => kind === "sandbox_attempt_started"))
      .toEqual([
        expect.objectContaining({ attempt: expect.objectContaining({ ordinal: 1 }) }),
        expect.objectContaining({ attempt: expect.objectContaining({ ordinal: 2 }) }),
      ]);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "sandbox_escalation_proposed",
      previousActionFingerprint: expect.any(String),
      nextActionFingerprint: expect.any(String),
    }));
    const escalation = result.items.find(({ kind }) => kind === "sandbox_escalation_proposed");
    if (escalation?.kind !== "sandbox_escalation_proposed") {
      throw new Error("Escalation history is missing.");
    }
    expect(escalation.nextActionFingerprint).not.toBe(escalation.previousActionFingerprint);
    expect(result.items.filter(({ kind }) => kind === "approval_requested")).toHaveLength(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "tool_result",
        result: expect.objectContaining({ status: "succeeded" }),
      }),
    }));
  });

  it("does not replay when the provider cannot prove the first attempt had no effect", async () => {
    const fixture = createEscalatingExternalActionFixture({ effectState: "unknown" });
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
      finalDecision("Continued"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(1);
    expect(fixture.reconciliationCalls()).toBe(0);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "action_denied",
        code: "sandbox_escalation_effect_state_unknown",
      }),
    }));
  });

  it("stops after an escalation approval decline without creating attempt two", async () => {
    const reviewer = createApprovalReviewer((input) => {
      const option = input.request.decisionOptions.find(({ kind }) => kind === "decline");
      if (option === undefined) throw new Error("Decline option was not offered.");
      return {
        status: "decided",
        submission: {
          submissionId: "submission_escalation_decline",
          runId: input.request.runId,
          requestId: input.request.id,
          pendingVersion: input.pendingVersion,
          optionId: option.id,
          grantedPermissions: null,
          reason: "Keep network disabled",
        },
        rationale: null,
      };
    });
    const fixture = createEscalatingExternalActionFixture();
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
      finalDecision("Declined"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(1);
    expect(result.items.filter(({ kind }) => kind === "sandbox_attempt_started")).toHaveLength(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "approval_declined",
        reason: "Keep network disabled",
      }),
    }));
  });

  it("makes attempt two final when the provider denies again", async () => {
    const reviewer = createApprovalReviewer((input) => {
      const option = input.request.decisionOptions.find(({ kind }) => kind === "accept");
      if (option === undefined) throw new Error("Accept option was not offered.");
      return {
        status: "decided",
        submission: {
          submissionId: "submission_second_denial_accept",
          runId: input.request.runId,
          requestId: input.request.id,
          pendingVersion: input.pendingVersion,
          optionId: option.id,
          grantedPermissions: null,
          reason: null,
        },
        rationale: null,
      };
    });
    const fixture = createEscalatingExternalActionFixture({ secondDenial: true });
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
      finalDecision("Stopped"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(2);
    expect(fixture.reconciliationCalls()).toBe(1);
    expect(result.items.filter(({ kind }) => kind === "sandbox_attempt_started")).toHaveLength(2);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "action_denied",
        code: "sandbox_network_denied_again",
      }),
    }));
  });

  it.each(["failed", "timeout", "partial"] as const)(
    "does not treat an ordinary %s ToolResult as sandbox escalation",
    async (toolResultStatus) => {
      const traces: RunTrace[] = [];
      const traceEvents = new FakeRuntimeEventPublisher();
      const fixture = createEscalatingExternalActionFixture({
        ordinaryToolResultStatus: toolResultStatus,
      });
      const result = await createRunner(new ScriptedController([
        actionsDecision([{
          kind: "tool",
          name: "test.external",
          input: {},
          modelItemId: "model_1",
        }]),
        finalDecision("Observed failure"),
      ]), {
        actionEnforcementPipeline: fixture.pipeline,
        sandboxExecutionGateway: fixture.gateway,
        runtimeEventPublisher: traceEvents,
        runTraceObserver: {
          observe(trace) {
            traces.push(trace);
          },
        },
      }).run(
        createAgent(),
        createRunInput(),
        createRunConfig({
          actionContext: externalActionContext(),
          toolBindings: fixture.toolBindings,
        }),
      );
      await Promise.resolve();

      expect(result.status).toBe("succeeded");
      expect(fixture.providerCalls()).toBe(1);
      expect(fixture.reconciliationCalls()).toBe(0);
      expect(result.items.some(({ kind }) => kind === "sandbox_escalation_proposed")).toBe(false);
      expect(result.items).toContainEqual(expect.objectContaining({
        kind: "observation",
        observation: expect.objectContaining({
          kind: "tool_result",
          result: expect.objectContaining({ status: toolResultStatus }),
        }),
      }));
      expect(traces.at(-1)).toMatchObject({
        status: "complete",
        issues: [],
      });
      expect(traces.at(-1)?.spans).toContainEqual(expect.objectContaining({
        owner: "action",
        operation: "processing",
        status: toolResultStatus === "partial" ? "succeeded" : "failed",
        attributes: expect.objectContaining({
          outcomeStatus: toolResultStatus,
        }),
      }));
    },
  );

  it("invalidates escalation when target state changes after attempt one", async () => {
    const fixture = createEscalatingExternalActionFixture({
      targetChangesBeforeEscalation: true,
    });
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
      finalDecision("Invalidated"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(1);
    expect(fixture.reconciliationCalls()).toBe(0);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "action_denied",
        code: "tool_target_changed",
      }),
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "action_invalidated",
      invalidation: expect.objectContaining({
        phase: "revalidation",
        owner: "tool",
        code: "tool_target_changed",
      }),
    }));
  });

  it("runs the changed subject through Governance again and honors a deny", async () => {
    const fixture = createEscalatingExternalActionFixture({
      denyEscalatedPolicy: true,
    });
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
      finalDecision("Policy denied"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(1);
    expect(result.items.filter(({ kind }) => kind === "sandbox_attempt_started")).toHaveLength(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "action_denied",
        owner: "policy",
      }),
    }));
  });

  it("honors cancellation during adapter reconciliation and creates no second attempt", async () => {
    let handle!: ReturnType<Runner["start"]>;
    const fixture = createEscalatingExternalActionFixture({
      onReconcile: () => {
        handle.cancel({
          origin: "user",
          reasonCode: "user_requested",
        });
      },
    });
    handle = createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
      }),
    );
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      cancellation: { reasonCode: "user_requested" },
    });
    expect(fixture.providerCalls()).toBe(1);
    expect(fixture.reconciliationCalls()).toBe(1);
    expect(result.items.filter(({ kind }) => kind === "sandbox_attempt_started")).toHaveLength(1);
  });

  it("prevents execution when required attempt-start Audit fails", async () => {
    const fixture = createEscalatingExternalActionFixture();
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "sandbox.attempt.started") {
          throw new Error("Attempt-start Audit unavailable.");
        }
      },
    };
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      auditPort,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "required",
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "audit_required_failed",
      failure: {
        kind: "audit",
        failure: { code: "audit_required_failed" },
      },
      relatedFailures: [],
    });
    expect(fixture.providerCalls()).toBe(0);
    expect(result.items.some(({ kind }) => kind === "sandbox_attempt_started")).toBe(false);
  });

  it("prevents execution when required attempt-start Telemetry is unavailable", async () => {
    const fixture = createEscalatingExternalActionFixture();
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        telemetry: "required",
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "telemetry_required_failed",
      failure: {
        kind: "telemetry",
        failure: { code: "telemetry_required_failed" },
      },
      relatedFailures: [],
    });
    expect(fixture.providerCalls()).toBe(0);
    expect(result.items.some(({ kind }) => kind === "sandbox_attempt_started")).toBe(false);
  });

  it("does not start an external effect until required attempt-start records settle", async () => {
    const fixture = createEscalatingExternalActionFixture({
      ordinaryToolResultStatus: "partial",
    });
    const recordingStarted = createDeferred<void>();
    const releaseRecording = createDeferred<void>();
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "sandbox.attempt.started") {
          recordingStarted.resolve();
          await releaseRecording.promise;
        }
      },
    };
    const run = createRunner(new ScriptedController([
      actionsDecision([
        { kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" },
      ]),
      finalDecision("Recorded"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      auditPort,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "required",
      }),
    );

    await recordingStarted.promise;
    expect(fixture.providerCalls()).toBe(0);

    releaseRecording.resolve();
    const result = await run;

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(1);
  });

  it("publishes settled effect history only after the required result gate", async () => {
    const fixture = createEscalatingExternalActionFixture({
      ordinaryToolResultStatus: "partial",
    });
    const order: string[] = [];
    const recordingStarted = createDeferred<void>();
    const releaseRecording = createDeferred<void>();
    const publisher = new FakeRuntimeEventPublisher();
    publisher.subscribe((event) => {
      if (
        event.name === "run.item.appended" &&
        event.payload.itemKind === "sandbox_attempt_resolved"
      ) {
        order.push("event:item:attempt-resolved");
      }
      if (event.name === "sandbox.attempt.resolved") {
        order.push("event:attempt-resolved");
      }
      if (event.name === "tool.finished") {
        order.push("event:tool-finished");
      }
    });
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "sandbox.attempt.resolved") {
          order.push("audit:result-started");
          recordingStarted.resolve();
          await releaseRecording.promise;
          order.push("audit:result-settled");
        }
      },
    };
    const controller = new ScriptedController([
      actionsDecision([
        { kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" },
      ]),
      () => {
        order.push("controller:continued");
        return finalDecision("Recorded");
      },
    ]);
    const run = createRunner(controller, {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      auditPort,
      runtimeEventPublisher: publisher,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "required",
      }),
    );

    await recordingStarted.promise;
    expect(controller.calls).toHaveLength(1);
    expect(order).not.toContain("event:item:attempt-resolved");
    expect(order).not.toContain("event:attempt-resolved");
    expect(order).not.toContain("event:tool-finished");

    releaseRecording.resolve();
    const result = await run;

    expect(result.status).toBe("succeeded");
    expect(order.indexOf("audit:result-settled"))
      .toBeLessThan(order.indexOf("event:item:attempt-resolved"));
    expect(order.indexOf("event:item:attempt-resolved"))
      .toBeLessThan(order.indexOf("event:attempt-resolved"));
    expect(order.indexOf("event:attempt-resolved"))
      .toBeLessThan(order.indexOf("event:tool-finished"));
    expect(order.indexOf("event:tool-finished"))
      .toBeLessThan(order.indexOf("controller:continued"));
  });

  it("does not let optional result recording become an execution gate", async () => {
    const fixture = createEscalatingExternalActionFixture({
      ordinaryToolResultStatus: "partial",
    });
    const optionalRecordingStarted = createDeferred<void>();
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "sandbox.attempt.resolved") {
          optionalRecordingStarted.resolve();
          await new Promise<void>(() => {});
        }
      },
    };
    const run = createRunner(new ScriptedController([
      actionsDecision([
        { kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" },
      ]),
      finalDecision("Optional recording did not block"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      auditPort,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "optional",
      }),
    );

    await optionalRecordingStarted.promise;
    const result = await run;

    expect(result.status).toBe("succeeded");
    expect(fixture.providerCalls()).toBe(1);
  });

  it("settles required result recording before accepted cancellation terminalizes", async () => {
    const fixture = createEscalatingExternalActionFixture({
      ordinaryToolResultStatus: "partial",
    });
    const recordingStarted = createDeferred<void>();
    const releaseRecording = createDeferred<void>();
    const eventNames: string[] = [];
    const publisher = new FakeRuntimeEventPublisher();
    publisher.subscribe((event) => eventNames.push(event.name));
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "sandbox.attempt.resolved") {
          recordingStarted.resolve();
          await releaseRecording.promise;
        }
      },
    };
    const controller = new ScriptedController([
      actionsDecision([
        { kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" },
      ]),
      finalDecision("Must not continue"),
    ]);
    const handle = createRunner(controller, {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      auditPort,
      runtimeEventPublisher: publisher,
    }).start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "required",
      }),
    );

    await recordingStarted.promise;
    handle.cancel({
      origin: "user",
      reasonCode: "user_requested",
    });
    expect(eventNames).not.toContain("sandbox.attempt.resolved");

    releaseRecording.resolve();
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(fixture.providerCalls()).toBe(1);
    expect(controller.calls).toHaveLength(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "sandbox_attempt_resolved",
      resolution: expect.objectContaining({ outcome: "executed" }),
    }));
    expect(eventNames.indexOf("sandbox.attempt.resolved"))
      .toBeLessThan(eventNames.indexOf("run.cancelled"));
  });

  it("retains settled attempt history when required result Audit fails", async () => {
    const fixture = createEscalatingExternalActionFixture({ ordinaryToolResultStatus: "failed" });
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "sandbox.attempt.resolved") {
          throw new Error("Attempt-result Audit unavailable.");
        }
      },
    };
    const result = await createRunner(new ScriptedController([
      actionsDecision([{ kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      auditPort,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        audit: "required",
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "audit_required_failed",
      failure: {
        kind: "audit",
        failure: { code: "audit_required_failed" },
      },
      relatedFailures: [],
    });
    expect(fixture.providerCalls()).toBe(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "sandbox_attempt_started",
      attempt: expect.objectContaining({ ordinal: 1 }),
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "sandbox_attempt_resolved",
      resolution: expect.objectContaining({ outcome: "executed" }),
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "tool_result",
        result: expect.objectContaining({ status: "failed" }),
      }),
    }));
  });

  it("retains settled attempt history when required result Telemetry fails", async () => {
    const fixture = createEscalatingExternalActionFixture({
      ordinaryToolResultStatus: "partial",
    });
    const publisher = new FakeRuntimeEventPublisher();
    const events: RuntimeEvent[] = [];
    publisher.subscribe((event) => events.push(event));
    const telemetryPort: TelemetryPort = {
      async record(record) {
        if (record.eventName === "runner.sandbox.attempt.resolved") {
          throw new Error("Attempt-result Telemetry unavailable.");
        }
      },
    };
    const result = await createRunner(new ScriptedController([
      actionsDecision([
        { kind: "tool", name: "test.external", input: {}, modelItemId: "model_1" },
      ]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      telemetryPort,
      runtimeEventPublisher: publisher,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        telemetry: "required",
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "telemetry_required_failed",
      failure: {
        kind: "telemetry",
        failure: { code: "telemetry_required_failed" },
      },
      relatedFailures: [],
    });
    expect(fixture.providerCalls()).toBe(1);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "sandbox_attempt_resolved",
      resolution: expect.objectContaining({ outcome: "executed" }),
    }));
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "observation",
      observation: expect.objectContaining({
        kind: "tool_result",
        result: expect.objectContaining({ status: "partial" }),
      }),
    }));
    expect(events.filter(({ name }) => name === "sandbox.attempt.resolved"))
      .toHaveLength(1);
    expect(events.filter(({ name }) => name === "tool.finished")).toHaveLength(1);
  });
});

describe("Runner approval lifecycle", () => {
  it("publishes approval history only after required audit and telemetry gates", async () => {
    const order: string[] = [];
    const safeOutputs: unknown[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => {
      if (event.name === "approval.requested" || event.name === "approval.resolved") {
        order.push(`event:${event.name}`);
        safeOutputs.push(event);
      }
      if (
        event.name === "run.item.appended" &&
        (event.payload.itemKind === "approval_requested" ||
          event.payload.itemKind === "approval_resolved")
      ) {
        order.push(`event:item:${event.payload.itemKind}`);
      }
    });
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName.startsWith("approval.")) {
          order.push(`audit:${record.eventName}`);
          safeOutputs.push(record);
        }
      },
    };
    const telemetryPort: TelemetryPort = {
      async record(record) {
        if (record.eventName === "runner.approval.resolved") {
          order.push(`telemetry:${record.eventName}`);
          safeOutputs.push(record);
        }
      },
    };
    const reviewer = createApprovalReviewer((input) => ({
      ...decidedReview(input, null, "decline"),
      rationale: "private-review-rationale",
    }));

    const result = await createRunner(
      new ScriptedController([
        permissionRequestDecision(),
        finalDecision("Declined safely"),
      ]),
      { runtimeEventPublisher: eventEmitter, auditPort, telemetryPort },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        audit: "required",
        telemetry: "required",
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(order).toEqual([
      "audit:approval.requested",
      "event:item:approval_requested",
      "event:approval.requested",
      "audit:approval.decision_validated",
      "audit:approval.resolved",
      "telemetry:runner.approval.resolved",
      "event:item:approval_resolved",
      "event:approval.resolved",
    ]);
    expect(JSON.stringify(safeOutputs)).not.toContain("private-review-rationale");
  });

  it("waits, applies a Run permission grant, and continues the same invocation", async () => {
    const reviewer = createApprovalReviewer((input) => decidedReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      (input) => {
        expect(input.permission.authority).toMatchObject({
          hasAdditionalFileSystemWrite: true,
          runGrantCount: 1,
        });
        return finalDecision("Granted");
      },
    ]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ permissions: createReviewPermissionConfig(reviewer) }),
    );

    expect(result.status).toBe("succeeded");
    expect(controller.calls).toHaveLength(2);
    expect(result.items.map((item) => item.kind)).toContain("approval_requested");
    expect(result.items.map((item) => item.kind)).toContain("approval_resolved");
    expect(result.items.find(
      (item) => item.kind === "observation" &&
        item.observation.kind === "permissions_granted",
    )).toBeDefined();
  });

  it("returns decline to Controller without granting authority", async () => {
    const reviewer = createApprovalReviewer((input) => decidedReview(input, null, "decline"));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      (input) => {
        expect(input.permission.authority.runGrantCount).toBe(0);
        expect(input.context.observations.at(-1)).toMatchObject({
          kind: "approval_declined",
        });
        return finalDecision("Declined safely");
      },
    ]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ permissions: createReviewPermissionConfig(reviewer) }),
    );

    expect(result.status).toBe("succeeded");
    expect(controller.calls).toHaveLength(2);
  });

  it("routes approval cancel through RunCancellationController", async () => {
    const reviewer = createApprovalReviewer((input) => decidedReview(input, null, "cancel"));
    const controller = new ScriptedController([permissionRequestDecision()]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ permissions: createReviewPermissionConfig(reviewer) }),
    );

    expect(result.status).toBe("cancelled");
    expect(result.cancellation).toMatchObject({
      origin: "approval",
      reasonCode: "approval_cancelled",
    });
    expect(controller.calls).toHaveLength(1);
  });

  it("retries automatic reviewer failure without replacing the request", async () => {
    const seen: ApprovalReviewInput[] = [];
    const reviewer = createApprovalReviewer((input) => {
      seen.push(input);
      return seen.length === 1
        ? {
            status: "failed",
            failure: {
              code: "approval_review_failed",
              message: "Temporary reviewer failure.",
              retryable: true,
              metadata: {},
            },
          }
        : decidedReview(input, null, "decline");
    });
    const retry = createTestRetryConfiguration();
    const controller = new ScriptedController([
      permissionRequestDecision(),
      finalDecision("Recovered"),
    ]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: createReviewPermissionConfig(reviewer),
        retry: {
          ...retry,
          approvalsReviewer: {
            ...retry.approvalsReviewer,
            maxRetries: 1,
            retryableCategories: ["reviewer_failure"],
          },
        },
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.request.id).toBe(seen[0]?.request.id);
    expect(seen[1]?.pendingVersion).toBe(seen[0]?.pendingVersion);
    expect(result.items.filter((item) => item.kind === "approval_requested")).toHaveLength(1);
  });

  it("does not call Controller again while review is pending and honours external cancellation", async () => {
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    const reviewer = new FakeApprovalReviewer({
      descriptor: {
        id: "reviewer_001",
        kind: "auto_review",
        displayName: "Test automatic reviewer",
        source: "runner-test",
        metadata: {},
      },
      handler: (_input, context) => new Promise((resolve) => {
        reviewStarted();
        const settle = () => {
          if (context.interruption === null) {
            throw new Error("Cancellation must carry exact interruption correlation.");
          }
          resolve({ status: "interrupted", interruption: context.interruption });
        };
        context.signal.addEventListener("abort", settle, { once: true });
        if (context.signal.aborted) settle();
      }),
    });
    const controller = new ScriptedController([
      permissionRequestDecision(),
      finalDecision("Must not run"),
    ]);
    const handle = createRunner(controller).start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    await started;
    expect(controller.calls).toHaveLength(1);
    handle.cancel({
      origin: "user",
      reasonCode: "user_requested",
    });
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(result.cancellation?.origin).toBe("user");
    expect(controller.calls).toHaveLength(1);
    expect(result.items.filter((item) => item.kind === "approval_resolved")).toHaveLength(1);
  });

  it("settles request_failure and never calls reviewer when required request audit fails", async () => {
    const reviewerHandler = vi.fn<(input: ApprovalReviewInput) => ApprovalReviewOutcome>();
    const reviewer = createApprovalReviewer(reviewerHandler);
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "approval.requested") {
          throw new Error("audit unavailable");
        }
      },
    };
    const controller = new ScriptedController([permissionRequestDecision()]);
    const result = await createRunner(controller, { auditPort }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        audit: "required",
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.code).toBe("audit_required_failed");
    expect(reviewerHandler).not.toHaveBeenCalled();
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: { resolutionKind: "request_failure", code: "audit_required_failed" },
    });
  });

  it("counts one failed logical review after Retry exhaustion and opens the circuit", async () => {
    const handler = vi.fn((): ApprovalReviewOutcome => ({
      status: "failed",
      failure: {
        code: "approval_review_failed",
        message: "Reviewer unavailable.",
        retryable: true,
        metadata: {},
      },
    }));
    const reviewer = createApprovalReviewer(handler);
    const retry = createTestRetryConfiguration();
    const permissions = createReviewPermissionConfig(reviewer);
    const result = await createRunner(
      new ScriptedController([permissionRequestDecision()]),
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: {
          ...permissions,
          approvalLimits: {
            ...permissions.approvalLimits,
            maxConsecutiveReviewFailures: 1,
          },
        },
        retry: {
          ...retry,
          approvalsReviewer: {
            ...retry.approvalsReviewer,
            maxRetries: 1,
            retryableCategories: ["reviewer_failure"],
          },
        },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "failed",
      code: "approval_review_failure_limit_exceeded",
    });
    expect(result.items.filter((item) => item.kind === "approval_requested")).toHaveLength(1);
    expect(result.items.filter((item) => item.kind === "approval_resolved")).toHaveLength(1);
  });

  it("bounds a reviewer that ignores cancellation and rejects its late result", async () => {
    vi.useFakeTimers();
    try {
        const reviewStarted = createDeferred<void>();
        const lateReview = createDeferred<ApprovalReviewOutcome>();
        let reviewInput: ApprovalReviewInput | null = null;
        const reviewer = createApprovalReviewer((input) => {
          reviewInput = input;
          reviewStarted.resolve();
          return lateReview.promise;
        });
        const events: RuntimeEvent[] = [];
        const eventEmitter = new FakeRuntimeEventPublisher();
        eventEmitter.subscribe((event) => events.push(event));
        const handle = createRunner(
          new ScriptedController([permissionRequestDecision()]),
          { runtimeEventPublisher: eventEmitter },
        ).start(
          createAgent(),
          createRunInput(),
          createRunConfig({
            cancellationLimits: { operationSettlementTimeoutMs: 20 },
            permissions: createReviewPermissionConfig(reviewer),
          }),
        );

        await reviewStarted.promise;
        handle.cancel({ origin: "user", reasonCode: "user_requested" });
        await vi.advanceTimersByTimeAsync(20);
        const result = await handle.wait();
        const eventCount = events.length;

        expect(result).toMatchObject({
          status: "failed",
          code: "approval_cancellation_unconfirmed",
          cancellation: { reasonCode: "user_requested" },
          failure: {
            kind: "approval",
            failure: { code: "approval_cancellation_unconfirmed" },
          },
          relatedFailures: [],
        });
        expect(result.items.filter((item) => item.kind === "approval_resolved")).toHaveLength(1);
        lateReview.resolve(decidedReview(reviewInput!, null, "decline"));
        await Promise.resolve();
        await Promise.resolve();
        expect(events).toHaveLength(eventCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a valid decision without authority when required decision audit fails", async () => {
    const reviewer = createApprovalReviewer((input) => decidedReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "approval.decision_validated") {
          throw new Error("decision audit unavailable");
        }
      },
    };
    const result = await createRunner(
      new ScriptedController([permissionRequestDecision()]),
      { auditPort },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        audit: "required",
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.code).toBe("audit_required_failed");
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        resolutionKind: "decision",
        decisionKind: "grantPermissions",
        applicationKind: "not_applied",
        code: "audit_required_failed",
        authorityRecordIds: [],
      },
    });
    expect(result.items.some(
      (item) => item.kind === "observation" &&
        item.observation.kind === "permissions_granted",
    )).toBe(false);
  });

  it("enforces the per-fingerprint request limit before a second reviewer call", async () => {
    const handler = vi.fn((input: ApprovalReviewInput) => decidedReview(input, null, "decline"));
    const reviewer = createApprovalReviewer(handler);
    const permissions = createReviewPermissionConfig(reviewer);
    const controller = new ScriptedController([
      permissionRequestDecision(),
      permissionRequestDecision(),
      finalDecision("Limit observed"),
    ]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: {
          ...permissions,
          approvalLimits: {
            ...permissions.approvalLimits,
            maxRequestsPerActionFingerprint: 1,
          },
        },
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.items.find(
      (item) => item.kind === "observation" &&
        item.observation.kind === "approval_limit_reached",
    )).toMatchObject({
      observation: { limit: "requests_per_action_fingerprint" },
    });
  });

  it("commits a Session permission grant before exposing it to Controller", async () => {
    const commits: SessionAuthorityCommit[] = [];
    const port = createSessionAuthorityPort(async (input) => {
      commits.push(input);
      return { kind: "applied", record: input.record };
    });
    const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      (input) => {
        expect(input.permission.authority).toMatchObject({
          hasAdditionalFileSystemWrite: true,
          sessionAuthorityCount: 1,
        });
        return finalDecision("Session grant committed");
      },
    ]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: createSessionReviewPermissionConfig(reviewer, port),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(commits).toHaveLength(1);
    expect(commits[0]?.commitId).toBe(
      "run_001:authority_operation:1:commit",
    );
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        resolutionKind: "decision",
        applicationKind: "applied",
        authorityRecordIds: ["run_001:session_authority_record:1"],
      },
    });
  });

  it("preserves applied Session authority when required resolution audit fails", async () => {
    const events: RuntimeEvent[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => events.push(event));
    const auditPort: AuditPort = {
      async record(record) {
        if (record.eventName === "approval.resolved") {
          throw new Error("resolution audit unavailable");
        }
      },
    };
    const port = createSessionAuthorityPort(async (input) => ({
      kind: "applied",
      record: input.record,
    }));
    const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      finalDecision("Must not run"),
    ]);

    const result = await createRunner(
      controller,
      { runtimeEventPublisher: eventEmitter, auditPort },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        audit: "required",
        permissions: createSessionReviewPermissionConfig(reviewer, port),
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "audit_required_failed",
      failure: { kind: "audit" },
      relatedFailures: [],
    });
    expect(controller.calls).toHaveLength(1);
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        applicationKind: "applied",
        authorityRecordIds: ["run_001:session_authority_record:1"],
      },
    });
    expect(events.some((event) => event.name === "approval.resolved")).toBe(false);
  });

  it("preserves applied Session authority when required resolution telemetry fails", async () => {
    const events: RuntimeEvent[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => events.push(event));
    const telemetryPort: TelemetryPort = {
      async record(record) {
        if (record.eventName === "runner.approval.resolved") {
          throw new Error("resolution telemetry unavailable");
        }
      },
    };
    const port = createSessionAuthorityPort(async (input) => ({
      kind: "applied",
      record: input.record,
    }));
    const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));

    const result = await createRunner(
      new ScriptedController([permissionRequestDecision()]),
      { runtimeEventPublisher: eventEmitter, telemetryPort },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        telemetry: "required",
        permissions: createSessionReviewPermissionConfig(reviewer, port),
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "telemetry_required_failed",
      failure: { kind: "telemetry" },
      relatedFailures: [],
    });
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        applicationKind: "applied",
        authorityRecordIds: ["run_001:session_authority_record:1"],
      },
    });
    expect(events.some((event) => event.name === "approval.resolved")).toBe(false);
  });

  it("fails with the Session owner when a commit ignores its deadline", async () => {
    vi.useFakeTimers();
    try {
        const commitStarted = createDeferred<void>();
        const port: SessionAuthorityPort = {
          async listApplicable() {
            return [];
          },
          commit: () => new Promise(() => {
            commitStarted.resolve();
          }),
        };
        const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
          fileSystem: { write: ["C:/workspace/output.txt"] },
        }));
        const permissions = createSessionReviewPermissionConfig(reviewer, port);
        const running = createRunner(
          new ScriptedController([permissionRequestDecision()]),
        ).run(
          createAgent(),
          createRunInput(),
          createRunConfig({
            cancellationLimits: { operationSettlementTimeoutMs: 20 },
            permissions: {
              ...permissions,
              authorityApplicationLimits: { commitTimeoutMs: 20 },
            },
          }),
        );

        await commitStarted.promise;
        await vi.advanceTimersByTimeAsync(40);
        const result = await running;

        expect(result).toMatchObject({
          status: "failed",
          code: "session_authority_commit_unconfirmed",
          cancellation: null,
          failure: {
            kind: "permission",
            failure: { code: "session_authority_commit_outcome_unknown" },
          },
          relatedFailures: [],
        });
        expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
          record: {
            applicationKind: "outcome_unknown",
            authorityRecordIds: [],
          },
        });
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues without Session authority after confirmed commit rejection", async () => {
    const port = createSessionAuthorityPort(async () => ({
      kind: "not_applied",
      code: "session_authority_conflict",
      message: "The idempotency key conflicts with another record.",
    }));
    const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      (input) => {
        expect(input.permission.authority.sessionAuthorityCount).toBe(0);
        expect(input.context.observations.at(-1)).toMatchObject({
          kind: "approval_application_failed",
          scope: "session",
          code: "session_authority_conflict",
        });
        return finalDecision("Commit rejected safely");
      },
    ]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: createSessionReviewPermissionConfig(reviewer, port),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        resolutionKind: "decision",
        applicationKind: "not_applied",
        code: "session_authority_conflict",
      },
    });
  });

  it("fails closed when Session commit reports a mismatched applied record", async () => {
    const port = createSessionAuthorityPort(async (input) => ({
      kind: "applied",
      record: { ...input.record, id: "session_authority_other" },
    }));
    const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const result = await createRunner(
      new ScriptedController([permissionRequestDecision()]),
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: createSessionReviewPermissionConfig(reviewer, port),
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "session_authority_commit_unconfirmed",
      failure: {
        kind: "permission",
        failure: { code: "session_authority_commit_outcome_unknown" },
      },
      relatedFailures: [],
    });
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        resolutionKind: "decision",
        applicationKind: "outcome_unknown",
        authorityRecordIds: [],
      },
    });
  });

  it("preserves an applied Session record when cancellation wins after durable commit", async () => {
    let handle!: ReturnType<Runner["start"]>;
    const port = createSessionAuthorityPort(async (input) => {
      handle.cancel({
        origin: "user",
        reasonCode: "user_requested",
      });
      return { kind: "applied", record: input.record };
    });
    const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      finalDecision("Must not run"),
    ]);
    handle = createRunner(controller).start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: createSessionReviewPermissionConfig(reviewer, port),
      }),
    );
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(controller.calls).toHaveLength(1);
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        resolutionKind: "decision",
        applicationKind: "applied",
        authorityRecordIds: ["run_001:session_authority_record:1"],
      },
    });
  });

  it("records interrupted non-application when cancellation wins before durable commit", async () => {
    const commitStarted = createDeferred<void>();
    const port: SessionAuthorityPort = {
      async listApplicable() {
        return [];
      },
      commit: (_input, context) => new Promise((resolve) => {
        commitStarted.resolve();
        const settle = () => {
          if (context.interruption === null) {
            throw new Error("Authority interruption must be attributed.");
          }
          resolve({ kind: "interrupted", interruption: context.interruption });
        };
        context.signal.addEventListener("abort", settle, { once: true });
        if (context.signal.aborted) settle();
      }),
    };
    const reviewer = createApprovalReviewer((input) => decidedSessionReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      finalDecision("Must not run"),
    ]);
    const handle = createRunner(controller).start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        permissions: createSessionReviewPermissionConfig(reviewer, port),
      }),
    );

    await commitStarted.promise;
    handle.cancel({
      origin: "user",
      reasonCode: "user_requested",
    });
    const result = await handle.wait();

    expect(result.status).toBe("cancelled");
    expect(controller.calls).toHaveLength(1);
    expect(result.items.find((item) => item.kind === "approval_resolved")).toMatchObject({
      record: {
        resolutionKind: "decision",
        applicationKind: "interrupted",
        authorityRecordIds: [],
      },
    });
  });
});

function createApprovalReviewer(
  handler: (input: ApprovalReviewInput) => ApprovalReviewOutcome | Promise<ApprovalReviewOutcome>,
): FakeApprovalReviewer {
  return new FakeApprovalReviewer({
    descriptor: {
      id: "reviewer_001",
      kind: "auto_review",
      displayName: "Test automatic reviewer",
      source: "runner-test",
      metadata: {},
    },
    handler,
  });
}

function createReviewPermissionConfig(
  reviewer: FakeApprovalReviewer,
): ResolvedRunPermissionConfig {
  return {
    ...createTestPermissionConfig(),
    approvalPolicy: "on-request",
    reviewer: {
      bindingId: "reviewer_binding_001",
      kind: "auto_review",
      reviewer,
      descriptor: reviewer.descriptor,
      reviewTimeoutMs: 60_000,
    },
  };
}

function createDisabledReviewPermissionConfig(
  reviewer: FakeApprovalReviewer,
): ResolvedRunPermissionConfig {
  const base = createReviewPermissionConfig(reviewer);
  const managedConstraints: ManagedPermissionConstraints = {
    ...base.managedConstraints,
    allowUnenforcedExecution: true,
  };
  return {
    ...base,
    permissionProfile: resolvePermissionProfile({
      profileId: "test-disabled",
      profiles: [{
        id: "test-disabled",
        extends: ":read-only",
        enforcement: "disabled",
        unrestrictedFileSystem: false,
        fileSystem: [],
        process: { unrestricted: false },
        network: { enabled: false, allowedDomains: [], deniedDomains: [] },
        metadata: {},
      }],
      environment: {
        environmentId: "test-local",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace_001", path: "C:/workspace" }],
      },
      managedConstraints,
    }),
    managedConstraints,
  };
}

function createSessionReviewPermissionConfig(
  reviewer: FakeApprovalReviewer,
  port: SessionAuthorityPort,
): ResolvedRunPermissionConfig {
  return {
    ...createReviewPermissionConfig(reviewer),
    sessionAuthority: {
      context: {
        hostSessionId: "host_session_001",
        authorityContextKey: "authority_context_001",
        workspaceId: "workspace_001",
        identityId: "user_001",
        environmentId: "test-local",
      },
      initialRecords: [],
      port,
    },
  };
}

function createSessionAuthorityPort(
  commit: (
    input: SessionAuthorityCommit,
  ) => SessionAuthorityCommitResult | Promise<SessionAuthorityCommitResult>,
): SessionAuthorityPort {
  return {
    async listApplicable(
      _input: SessionAuthorityLookup,
    ): Promise<readonly SessionAuthorityRecord[]> {
      return [];
    },
    commit: async (input) => commit(input),
  };
}

function permissionRequestDecision(): ControllerDecision<unknown> {
  return actionsDecision([{
    kind: "permission_request",
    name: "request_permissions",
    input: {
      rootId: "workspace_001",
      permissions: { fileSystem: { write: ["output.txt"] } },
      reason: "Create the requested output file.",
    },
    modelItemId: "model_1",
  }]);
}

function decidedReview(
  input: ApprovalReviewInput,
  grantedPermissions: AdditionalPermissions | null,
  kind: "grantPermissions" | "decline" | "cancel" = "grantPermissions",
): ApprovalReviewOutcome {
  const option = input.request.decisionOptions.find(
    (candidate) => candidate.kind === kind,
  );
  if (option === undefined) throw new Error(`Approval option ${kind} was not offered.`);
  return {
    status: "decided",
    submission: {
      submissionId: `submission_${kind}`,
      runId: input.request.runId,
      requestId: input.request.id,
      pendingVersion: input.pendingVersion,
      optionId: option.id,
      grantedPermissions,
      reason: kind === "decline" ? "Not needed." : null,
    },
    rationale: null,
  };
}

function decidedSessionReview(
  input: ApprovalReviewInput,
  grantedPermissions: AdditionalPermissions,
): ApprovalReviewOutcome {
  const option = input.request.decisionOptions.find(
    (candidate) => candidate.kind === "grantPermissions" && candidate.scope === "session",
  );
  if (option === undefined) throw new Error("Session permission option was not offered.");
  return {
    status: "decided",
    submission: {
      submissionId: "submission_grant_session",
      runId: input.request.runId,
      requestId: input.request.id,
      pendingVersion: input.pendingVersion,
      optionId: option.id,
      grantedPermissions,
      reason: null,
    },
    rationale: null,
  };
}

describe("Runner external Action result settlement", () => {
  it("uses trusted registrations as the canonical allowlist and publishes settlement", async () => {
    const fixture = createExternalActionPipeline("allowed");
    const events: RuntimeEvent[] = [];
    const eventEmitter = new FakeRuntimeEventPublisher();
    eventEmitter.subscribe((event) => events.push(event));
    const result = await createRunner(new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.external",
        input: {},
        modelItemId: "model_1",
      }]),
      finalDecision("Settled"),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      runtimeEventPublisher: eventEmitter,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createDisabledReviewPermissionConfig(createApprovalReviewer(() => {
          throw new Error("Allowed Action must not request review.");
        })),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(result.evidenceRefs).toHaveLength(1);
    expect(result.artifactRefs).toHaveLength(1);
    expect(result.items.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
      "action_prepared",
      "action_assessed",
      "sandbox_attempt_started",
      "sandbox_attempt_resolved",
      "observation",
    ]));
    expect(events.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "action.prepared",
      "action.assessed",
      "sandbox.attempt.started",
      "sandbox.attempt.resolved",
      "observation.created",
      "context.updated",
      "evidence.created",
      "tool.finished",
    ]));
  });

  it("preserves the settled ToolResult without publishing unconfirmed Evidence refs", async () => {
    const fixture = createExternalActionPipeline("allowed");
    const result = await createRunner(new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.external",
        input: {},
        modelItemId: "model_1",
      }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      evidencePersistence: new FakeEvidencePersistencePort(() => ({
        status: "failed",
        error: {
          code: "evidence_store_unavailable",
          message: "Evidence persistence is unavailable.",
          retryable: true,
          metadata: {},
        },
      })),
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createDisabledReviewPermissionConfig(createApprovalReviewer(() => {
          throw new Error("Allowed Action must not request review.");
        })),
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "storage_write_failed",
      failure: {
        kind: "context",
        failure: { code: "context_evidence_persistence_failed" },
      },
      relatedFailures: [],
    });
    expect(result.evidenceRefs).toEqual([]);
    expect(result.artifactRefs).toEqual([]);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "sandbox_attempt_resolved" }),
      expect.objectContaining({
        kind: "observation",
        observation: expect.objectContaining({
          kind: "tool_result",
          result: expect.objectContaining({ status: "succeeded", output: { ok: true } }),
        }),
      }),
    ]));
  });

  it("rejects incomplete result-settlement composition before execution", () => {
    const fixture = createExternalActionPipeline("allowed");
    const runner = new Runner({
      controller: new ScriptedController([finalDecision("unused")]),
      contextProjection: createTestContextProjection(),
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
      evidencePersistence: new FakeEvidencePersistencePort(),
      now: () => "2026-07-13T00:00:00.000Z",
    });
    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createDisabledReviewPermissionConfig(createApprovalReviewer(() => {
          throw new Error("Review must not start.");
        })),
      }),
    )).toThrow("must be configured together");
    expect(fixture.executionCalls()).toBe(0);
  });

  it("terminalizes a contradictory ToolResult while retaining attempt history", async () => {
    const fixture = createExternalActionPipeline("allowed", {
      status: "succeeded",
      output: null,
      error: null,
    });
    const result = await createRunner(new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.external",
        input: {},
        modelItemId: "model_1",
      }]),
    ]), {
      actionEnforcementPipeline: fixture.pipeline,
      sandboxExecutionGateway: fixture.gateway,
    }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        actionContext: externalActionContext(),
        toolBindings: fixture.toolBindings,
        permissions: createDisabledReviewPermissionConfig(createApprovalReviewer(() => {
          throw new Error("Allowed Action must not request review.");
        })),
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "tool_execution_failed",
      failure: {
        kind: "tool",
        failure: { code: "tool_result_invalid" },
      },
      relatedFailures: [],
    });
    expect(result.evidenceRefs).toEqual([]);
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: "sandbox_attempt_resolved",
      resolution: expect.objectContaining({ outcome: "failed", code: "tool_result_invalid" }),
    }));
  });
});

function createRunner(
  controller: Controller<unknown>,
  dependencies: Partial<ConstructorParameters<typeof Runner>[0]> = {},
): Runner {
  let runSequence = 0;
  const actionSettlement = dependencies.actionEnforcementPipeline === undefined
    ? {}
    : {
        evidenceBuilder: new EvidenceBuilder(),
        evidencePersistence: new FakeEvidencePersistencePort(),
      };
  return new Runner({
    controller,
    contextProjection: createTestContextProjection(),
    now: () => "2026-07-13T00:00:00.000Z",
    createRunId: () => {
      runSequence += 1;
      return `run_${String(runSequence).padStart(3, "0")}`;
    },
    ...actionSettlement,
    ...dependencies,
  });
}

function createAgent(): Agent<TestOutput> {
  return {
    id: "agent_001",
    name: "Test Agent",
    instructions: "Complete the task.",
    output: {
      validate(candidate) {
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "summary" in candidate &&
          typeof candidate.summary === "string"
        ) {
          return { valid: true, output: { summary: candidate.summary } };
        }
        return { valid: false, message: "Output requires a summary." };
      },
    },
    metadata: {},
  };
}

function createRunInput(): RunInput {
  return {
    task: {
      id: "task_001",
      kind: "test.runner",
      input: {},
      createdAt: "2026-07-13T00:00:00.000Z",
      metadata: {},
    },
    items: [
      {
        id: "message_001",
        kind: "message",
        role: "user",
        content: "Complete the task.",
        createdAt: "2026-07-13T00:00:00.000Z",
        metadata: {},
      },
    ],
    metadata: {},
  };
}

function createRunConfig(
  overrides: {
    readonly audit?: RunConfig["audit"];
    readonly telemetry?: RunConfig["telemetry"];
    readonly cancellationLimits?: Partial<RunConfig["cancellationLimits"]>;
    readonly retry?: RunConfig["retry"];
    readonly limits?: Partial<Omit<RunConfig["limits"], "plan">>;
    readonly permissions?: ResolvedRunPermissionConfig;
    readonly actionContext?: RunConfig["actionContext"];
    readonly workspace?: RunConfig["workspace"];
    readonly toolBindings?: RunConfig["toolBindings"];
  } = {},
): RunConfig {
  return {
    workspace: overrides.workspace === undefined
      ? {
          primary: {
            id: "workspace_001",
            name: "Test workspace",
            rootRef: "workspace://root",
            trustState: "trusted",
            source: "test",
            policyRefs: [],
            metadata: {},
          },
          additional: [],
        }
      : overrides.workspace,
    identity: {
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    actionContext: overrides.actionContext ?? null,
    permissions: overrides.permissions ?? createTestPermissionConfig(),
    toolBindings:
      overrides.toolBindings ?? createEmptyToolActionBindingSnapshot(),
    limits: {
      maxIterations: 4,
      maxActions: 8,
      maxConsecutiveActionFailures: 2,
      maxDurationMs: 10_000,
      plan: {
        maxSteps: 8,
        maxStepLength: 200,
        maxExplanationLength: 500,
      },
      ...overrides.limits,
    },
    audit: overrides.audit ?? "optional",
    telemetry: overrides.telemetry ?? "optional",
    cancellationLimits: {
      operationSettlementTimeoutMs: 1_000,
      processGracePeriodMs: 100,
      processForceKillTimeoutMs: 500,
      finalizationTimeoutMs: 1_000,
      ...overrides.cancellationLimits,
    },
    retry: overrides.retry ?? createTestRetryConfiguration(),
    metadata: {},
  };
}

function createTestRetryConfiguration(): RunConfig["retry"] {
  const disabledPolicy = {
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2 as const,
      jitterRatio: 0.1 as const,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
  return {
    providerRequest: disabledPolicy,
    structuredOutput: disabledPolicy,
    approvalsReviewer: disabledPolicy,
  };
}

function createTestPermissionConfig(
  workspaceRoots: readonly { rootId: string; path: string }[] = [
    { rootId: "workspace_001", path: "C:/workspace" },
  ],
): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "test-managed",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
  return {
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "test-local",
        platform: "win32",
        workspaceRoots,
      },
      managedConstraints,
    }),
    approvalPolicy: "never",
    reviewer: null,
    rules: [],
    networkRules: [],
    managedConstraints,
    sessionAuthority: null,
    persistentPolicyAmendments: null,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

function createExternalActionPipeline(
  policyStatus: "allowed" | "requires_review",
  toolResultOverride: Readonly<Record<string, unknown>> = {},
) {
  let prepareCallCount = 0;
  let policyCallCount = 0;
  let revalidationCallCount = 0;
  let executionCallCount = 0;
  const adapterDescriptor = {
    id: "test.external.adapter",
    version: "1",
    inputSchemaVersion: "1",
  };
  const executorDescriptor = {
    id: "test.external.executor",
    version: "1",
    invocationContractVersion: "1",
  };
  const data: ActionAdapterPreparedData = {
    operation: {
      kind: "skill",
      operation: "invoke",
      skillId: "test.external.skill",
      skillVersion: "1",
      sourceFingerprint: TEST_SHA_A,
      action: "review workspace",
      argumentsDigest: TEST_SHA_B,
    },
    effectSet: { kind: "effect_free" },
    requestedPermissions: null,
    targetAssertions: [],
    approvalCategory: "skill",
    approvalPayload: {
      skillId: "test.external.skill",
      skillDisplayName: "External test Skill",
      action: "review workspace",
      requiredPermissions: null,
    },
    applicabilityKeys: [{ category: "skill", value: "test.external.skill:1" }],
    safeSummary: { kind: "computation", headline: "Review workspace" },
    preparedInvocation: {
      contractVersion: "1",
      executorId: executorDescriptor.id,
      executorVersion: executorDescriptor.version,
      payload: {},
    },
  };
  const policyPort: ActionPolicyPort = {
    async evaluate(input) {
      policyCallCount += 1;
      return {
        checkId: input.checkId,
        status: policyStatus,
        decidedAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const registrations = createActionRegistrationSnapshot([{
    actionName: "test.external",
    adapter: adapterDescriptor,
    executor: executorDescriptor,
  }]);
  const toolBindings = createExternalToolBindings(registrations);
  const pipeline = new ActionEnforcementPipeline({
    registrations,
    toolBindings,
    adapters: [{
      actionName: "test.external",
      adapter: {
        descriptor: adapterDescriptor,
        async prepare() {
          prepareCallCount += 1;
          return { status: "prepared" as const, data };
        },
        async revalidate() {
          revalidationCallCount += 1;
          return { status: "valid" as const };
        },
      },
    }],
    policyPort,
    now: () => "2026-07-13T00:00:00.000Z",
  });
  const gateway = createSandboxExecutionGateway({
    registrations,
    executors: [{
      descriptor: executorDescriptor,
      async execute(invocation, context) {
        assertActionExecutorDispatchContext(context);
        executionCallCount += 1;
        return {
          status: "executed" as const,
          toolResult: {
            toolCallId: context.attempt.actionId,
            toolName: "test.external",
            status: "succeeded" as const,
            output: { ok: true },
            startedAt: "2026-07-13T00:00:00.000Z",
            finishedAt: "2026-07-13T00:00:01.000Z",
            metadata: { invocationContractVersion: invocation.contractVersion },
            ...toolResultOverride,
          } as ToolResult,
        };
      },
    }],
    limits: { maxResultBytes: 64 * 1024 },
    now: () => "2026-07-13T00:00:00.000Z",
  });
  return {
    pipeline,
    gateway,
    toolBindings,
    prepareCalls: () => prepareCallCount,
    policyCalls: () => policyCallCount,
    revalidationCalls: () => revalidationCallCount,
    executionCalls: () => executionCallCount,
  };
}

function createEscalatingExternalActionFixture(
  options: {
    readonly effectState?: "none" | "unknown";
    readonly secondDenial?: boolean;
    readonly ordinaryToolResultStatus?: "failed" | "timeout" | "partial";
    readonly targetChangesBeforeEscalation?: boolean;
    readonly denyEscalatedPolicy?: boolean;
    readonly onReconcile?: () => void;
  } = {},
) {
  let providerCallCount = 0;
  let reconciliationCallCount = 0;
  let revalidationCallCount = 0;
  const adapterDescriptor = {
    id: "test.external.adapter",
    version: "1",
    inputSchemaVersion: "1",
  };
  const executorDescriptor = {
    id: "test.external.executor",
    version: "1",
    invocationContractVersion: "1",
  };
  const registrations = createActionRegistrationSnapshot([{
    actionName: "test.external",
    adapter: adapterDescriptor,
    executor: executorDescriptor,
  }]);
  const toolBindings = createExternalToolBindings(registrations);
  const data: ActionAdapterPreparedData = {
    operation: {
      kind: "skill",
      operation: "invoke",
      skillId: "test.external.skill",
      skillVersion: "1",
      sourceFingerprint: TEST_SHA_A,
      action: "inspect remote metadata",
      argumentsDigest: TEST_SHA_B,
    },
    effectSet: { kind: "effect_free" },
    requestedPermissions: null,
    targetAssertions: [],
    approvalCategory: "skill",
    approvalPayload: {
      skillId: "test.external.skill",
      skillDisplayName: "External test Skill",
      action: "inspect remote metadata",
      requiredPermissions: null,
    },
    applicabilityKeys: [{ category: "skill", value: "test.external.skill:1" }],
    safeSummary: { kind: "computation", headline: "Inspect remote metadata" },
    preparedInvocation: {
      contractVersion: "1",
      executorId: executorDescriptor.id,
      executorVersion: executorDescriptor.version,
      payload: {},
    },
  };
  const policyPort: ActionPolicyPort = {
    async evaluate(input) {
      return {
        checkId: input.checkId,
        status: options.denyEscalatedPolicy && input.requestsAdditionalPermissions
          ? "denied" as const
          : "allowed" as const,
        decidedAt: "2026-07-13T00:00:00.000Z",
      };
    },
  };
  const pipeline = new ActionEnforcementPipeline({
    registrations,
    toolBindings,
    adapters: [{
      actionName: "test.external",
      adapter: {
        descriptor: adapterDescriptor,
        async prepare() {
          return { status: "prepared" as const, data };
        },
        async revalidate() {
          revalidationCallCount += 1;
          if (options.targetChangesBeforeEscalation && revalidationCallCount === 2) {
            return {
              status: "invalidated" as const,
              code: "tool_target_changed",
              message: "The target changed after attempt one.",
            };
          }
          return { status: "valid" as const };
        },
        async reconcileSandboxDenial() {
          reconciliationCallCount += 1;
          options.onReconcile?.();
          return { status: "supported" as const, targetAssertions: [] };
        },
      },
    }],
    policyPort,
    now: () => "2026-07-13T00:00:00.000Z",
  });
  const networkEffectSet = createActionEffectSet({
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
  });
  if (networkEffectSet.kind !== "effects") {
    throw new Error("Network test effect was not created.");
  }
  const deniedEffect = networkEffectSet.values[0];
  const provider: SandboxProvider = {
    kind: "managed",
    descriptor: {
      id: "test.sandbox.provider",
      version: "1",
      kind: "managed",
      supportedPolicyVersions: [1],
      supportedEffectKinds: ["network"],
    },
    async execute(request) {
      providerCallCount += 1;
      if (options.ordinaryToolResultStatus !== undefined) {
        const status = options.ordinaryToolResultStatus;
        return {
          status: "executed",
          toolResult: ordinaryToolResult(request.attempt.actionId, status),
          enforcementEvidence: {
            providerId: "test.sandbox.provider",
            providerVersion: "1",
            policyId: request.policy.policyId,
            enforcement: "managed",
            enforcedEffectKinds: request.policy.authorizedEffects.kind === "effects"
              ? [...new Set(request.policy.authorizedEffects.values.map((effect) => effect.kind))]
              : [],
            settledAt: "2026-07-13T00:00:01.000Z",
          },
        };
      }
      if (providerCallCount === 1 || options.secondDenial) {
        return {
          status: "denied",
          denial: {
            attemptId: request.attempt.id,
            runId: request.attempt.runId,
            actionId: request.attempt.actionId,
            actionFingerprint: request.attempt.actionFingerprint,
            ordinal: request.attempt.ordinal,
            code: providerCallCount === 1
              ? "sandbox_network_denied"
              : "sandbox_network_denied_again",
            deniedEffect,
            effectState: options.effectState ?? "none",
            message: "The managed sandbox prevented network access.",
          },
        };
      }
      return {
        status: "executed",
        toolResult: {
          toolCallId: request.attempt.actionId,
          toolName: "test.external",
          status: "succeeded",
          output: { connected: true },
          startedAt: "2026-07-13T00:00:00.000Z",
          finishedAt: "2026-07-13T00:00:01.000Z",
          metadata: {},
        },
        enforcementEvidence: {
          providerId: "test.sandbox.provider",
          providerVersion: "1",
          policyId: request.policy.policyId,
          enforcement: "managed",
          enforcedEffectKinds: ["network"],
          settledAt: "2026-07-13T00:00:01.000Z",
        },
      };
    },
    async cancel() {
      return { status: "already_settled" };
    },
  };
  const gateway = createSandboxExecutionGateway({
    registrations,
    executors: [],
    providers: [provider],
    limits: { maxResultBytes: 64 * 1024 },
    now: () => "2026-07-13T00:00:00.000Z",
  });
  return {
    pipeline,
    gateway,
    toolBindings,
    providerCalls: () => providerCallCount,
    reconciliationCalls: () => reconciliationCallCount,
    revalidationCalls: () => revalidationCallCount,
  };
}

function ordinaryToolResult(
  actionId: string,
  status: "failed" | "timeout" | "partial",
): ToolResult {
  const base = {
    toolCallId: actionId,
    toolName: "test.external",
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
  const error = {
    code: `tool_test_${status}`,
    message: `Expected test ${status}.`,
  };
  return status === "partial"
    ? {
        ...base,
        status,
        output: { usable: true },
        outputUsability: "validated",
        error,
      }
    : { ...base, status, error };
}

function externalActionContext(): NonNullable<RunConfig["actionContext"]> {
  return {
    workspace: {
      workspaceId: "workspace_001",
      trustState: "trusted",
      roots: [{
        rootId: "workspace_001",
        platform: "win32",
        path: "C:/workspace",
        resolvedPath: "C:/workspace",
        resolutionFingerprint: TEST_SHA_A,
      }],
    },
    actor: { identityId: "user_001", kind: "user" },
    environment: {
      environmentId: "test-local",
      platform: "win32",
      configurationFingerprint: TEST_SHA_B,
    },
  };
}

function finalDecision(summary: string): ControllerDecision<unknown> {
  const output = { summary };
  return {
    kind: "final_output",
    output,
    modelItems: [modelItem("model_1", output)],
  };
}

function actionsDecision(
  actions: readonly [
    {
      readonly kind: "internal" | "tool" | "permission_request";
      readonly name: string;
      readonly input: unknown;
      readonly modelItemId: string;
    },
    ...{
      readonly kind: "internal" | "tool" | "permission_request";
      readonly name: string;
      readonly input: unknown;
      readonly modelItemId: string;
    }[],
  ],
): ControllerDecision<unknown> {
  return {
    kind: "actions",
    actions: actions.map((action) => ({
      ...action,
      origin: "model" as const,
    })) as [ActionCandidate, ...ActionCandidate[]],
    modelItems: [modelItem("model_1", { actions: actions.map((action) => action.name) })],
  };
}

function createExternalToolBindings(
  registrations: ActionRegistrationSnapshot,
): RunConfig["toolBindings"] {
  const toolRegistrations = createToolRegistrationSnapshot([{
    descriptor: {
      name: "test.external",
      inputSchema: {},
      annotations: {},
      metadata: {},
    },
    source: {
      kind: "harness",
      sourceId: "runtime-tests",
      sourceRevision: "1",
      activationEpoch: 1,
      capabilityId: "test.external",
    },
    schema: {
      dialect: "test",
      translationVersion: "1",
    },
    boundActionName: "test.external",
    registrationVersion: "1",
  }]);
  const selection = createToolSelectionSnapshot(toolRegistrations, [{
    toolName: "test.external",
    origins: ["model"],
  }]);
  return createToolActionBindingSnapshot(selection, registrations);
}

function modelItem(id: string, content: unknown) {
  return {
    id,
    kind: "assistant_message",
    content,
    metadata: {},
  };
}

function createDeferred<TValue>() {
  let resolve!: (value: TValue | PromiseLike<TValue>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
