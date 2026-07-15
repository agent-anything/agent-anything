import { describe, expect, it, vi } from "vitest";
import type {
  AuditPort,
  ObservabilityRecordContext,
  TelemetryPort,
  TelemetryRecord,
} from "@agent-anything/observability";
import type { ToolDefinition } from "@agent-anything/tools";
import type { Agent } from "../agent/index.js";
import {
  ControllerError,
  type Controller,
  type ControllerCallContext,
  type ControllerDecision,
  type ControllerInput,
} from "../controller/index.js";
import { RuntimeEventEmitter, type RuntimeEvent } from "../events/index.js";
import { createRunCancellationController } from "./RunCancellation.js";
import type { RunConfig } from "./RunConfig.js";
import type { RunInput } from "./RunInput.js";
import { Runner } from "./Runner.js";
import type { ToolActionBridge } from "./ToolActionBridge.js";
import type { RetryEvent } from "../retry/index.js";
import { resolvePermissionProfile } from "@agent-anything/permission";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import type { ResolvedRunPermissionConfig } from "./RunPermissionConfig.js";
import { FakeApprovalReviewer } from "@agent-anything/testing";
import type {
  AdditionalPermissions,
  ApprovalReviewInput,
  ApprovalReviewOutcome,
} from "@agent-anything/permission";

interface TestOutput {
  readonly summary: string;
}

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
        plan: null,
        observations: [],
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
      },
    });
    expect(JSON.stringify(controller.calls[0]?.context.permission)).not.toContain(
      "C:/workspace",
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("commits safe Retry RunItems before their Runtime notifications", async () => {
    const runtimeEvents: RuntimeEvent[] = [];
    const eventEmitter = new RuntimeEventEmitter();
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

    const result = await createRunner(controller, { eventEmitter }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ retry }),
    );

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
  });

  it("commits update_plan, exposes it to the next turn, and abandons an active Plan on success", async () => {
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

    const result = await createRunner(controller).run(
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
    expect(controller.calls[1]?.context.plan).toMatchObject({
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
      createAgent([createAgentTool("workspace.readFile")]),
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
    const cancellation = createRunCancellationController({ runId: "run_001" });
    cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    const controller = new ScriptedController([finalDecision("Unused")]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ cancellation }),
    );

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
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const controller = new ScriptedController([
      () => {
        cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        return finalDecision("Discarded");
      },
    ]);

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ cancellation }),
    );

    expect(result.status).toBe("cancelled");
    expect(result.items.map((item) => item.kind)).toEqual([
      "run_cancellation_requested",
      "run_cancelled",
    ]);
  });

  it("commits cancellation immediately while the Controller boundary is still active", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const controllerStarted = createDeferred<void>();
    const controllerResult = createDeferred<ControllerDecision<unknown>>();
    const appendedKinds: string[] = [];
    const eventEmitter = new RuntimeEventEmitter();
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

    const run = createRunner(controller, { eventEmitter }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ cancellation }),
    );
    await controllerStarted.promise;

    cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });

    expect(appendedKinds).toEqual(["run_cancellation_requested"]);
    controllerResult.resolve(finalDecision("Discarded"));
    const result = await run;

    expect(result.status).toBe("cancelled");
    expect(result.items.map((item) => item.kind)).toEqual([
      "run_cancellation_requested",
      "run_cancelled",
    ]);
  });

  it("fails with cancellation attribution when Controller settlement times out", async () => {
    vi.useFakeTimers();
    try {
      const cancellation = createRunCancellationController({ runId: "run_001" });
      const controllerStarted = createDeferred<void>();
      const controller: Controller<unknown> = {
        async next() {
          controllerStarted.resolve();
          return new Promise<ControllerDecision<unknown>>(() => {});
        },
      };
      const run = createRunner(controller).run(
        createAgent(),
        createRunInput(),
        createRunConfig({
          cancellation,
          cancellationLimits: { boundarySettlementTimeoutMs: 25 },
        }),
      );
      await controllerStarted.promise;

      cancellation.requestCancellation({
        origin: "host",
        reasonCode: "host_requested",
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await run;

      expect(result).toMatchObject({
        status: "failed",
        code: "runtime_cancellation_settlement_timeout",
        cancellation: { reasonCode: "host_requested" },
        errors: [{
          owner: "runtime",
          code: "runtime_cancellation_settlement_timeout",
          metadata: { boundary: "controller", settlementTimeoutMs: 25 },
        }],
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
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const controller: Controller<unknown> = {
      async next() {
        cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        throw new ControllerError(
          {
            owner: "provider",
            code: "provider_cancellation_unconfirmed",
            message: "Provider settlement could not be confirmed.",
            retryable: false,
            metadata: {},
          },
          "settled_failure",
        );
      },
    };

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ cancellation }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "provider_cancellation_unconfirmed",
      cancellation: { reasonCode: "host_requested" },
      errors: [{
        owner: "provider",
        code: "provider_cancellation_unconfirmed",
      }],
    });
  });

  it("does not relabel a settled Provider timeout as Run cancellation", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const controller: Controller<unknown> = {
      async next() {
        cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        throw new ControllerError(
          {
            owner: "provider",
            code: "provider_timeout",
            message: "Provider request timed out.",
            retryable: false,
            metadata: {},
          },
          "settled_failure",
        );
      },
    };

    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ cancellation }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "provider_timeout",
      cancellation: { reasonCode: "host_requested" },
      errors: [{ owner: "provider", code: "provider_timeout" }],
    });
  });

  it("returns failed with cancellation attribution when required cancellation finalization fails", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const controller = new ScriptedController([
      () => {
        cancellation.requestCancellation({
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

    const result = await createRunner(controller, { telemetryPort }).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        cancellation,
        telemetry: "required",
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_telemetry_required_failed",
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
    ["telemetry", "runtime_telemetry_finalization_timeout"],
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
          errors: [{ owner, code: expectedCode }],
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
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const events: RuntimeEvent[] = [];
    const eventEmitter = new RuntimeEventEmitter();
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
    const run = createRunner(
      new ScriptedController([finalDecision("Must not commit")]),
      { eventEmitter, telemetryPort },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ cancellation, telemetry: "required" }),
    );
    await finalizationStarted.promise;

    cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    releaseFinalization.resolve();
    const result = await run;

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
    expect(finalizationSignals[0]).not.toBe(cancellation.context.signal);
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
      code: "runtime_telemetry_required_failed",
    });
    expect(result.items.find((item) => item.kind === "plan_abandoned")).toMatchObject({
      terminalStatus: "failed",
      reasonCode: "runtime_telemetry_required_failed",
    });
  });

  it("does not rewrite a terminal result when cancellation is requested later", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const events: RuntimeEvent[] = [];
    const eventEmitter = new RuntimeEventEmitter();
    eventEmitter.subscribe((event) => events.push(event));
    const result = await createRunner(
      new ScriptedController([finalDecision("Committed")]),
      { eventEmitter },
    ).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ cancellation }),
    );
    const eventCount = events.length;

    cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });

    expect(result.status).toBe("succeeded");
    expect(result.items.some((item) => item.kind === "run_cancellation_requested")).toBe(false);
    expect(events).toHaveLength(eventCount);
  });

  it("preserves typed Controller failure ownership", async () => {
    const controllerError = new ControllerError(Object.freeze({
      owner: "provider",
      code: "provider_request_failed",
      message: "Provider unavailable.",
      retryable: false,
      metadata: Object.freeze({ providerId: "test-provider" }),
    }));
    const result = await createRunner(new ScriptedController([controllerError])).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "provider_request_failed",
      errors: [{ owner: "provider", code: "provider_request_failed" }],
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
      errors: [{ owner: "audit" }],
    });
    expect(optionalResult.status).toBe("succeeded");
    expect(telemetryResult).toMatchObject({
      status: "failed",
      code: "runtime_telemetry_required_failed",
      errors: [{ owner: "telemetry" }],
    });
    expect(telemetryResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "run_failed",
    ]);
  });

  it("publishes committed item notifications and ignores subscriber failures", async () => {
    const events: RuntimeEvent[] = [];
    const emitter = new RuntimeEventEmitter();
    emitter.subscribe((event) => events.push(event));
    const result = await createRunner(
      new ScriptedController([finalDecision("Done")]),
      { eventEmitter: emitter },
    ).run(createAgent(), createRunInput(), createRunConfig());
    const itemEvents = events.filter((event) => event.name === "run.item.appended");

    expect(itemEvents.map((event) => event.payload)).toEqual(
      result.items.map((item) => ({
        runId: item.runId,
        itemId: item.id,
        itemKind: item.kind,
        itemSequence: item.sequence,
      })),
    );

    const throwingEmitter = new RuntimeEventEmitter();
    throwingEmitter.subscribe(() => {
      throw new Error("Renderer listener failed.");
    });
    const unaffected = await createRunner(
      new ScriptedController([finalDecision("Still done")]),
      { eventEmitter: throwingEmitter },
    ).run(createAgent(), createRunInput(), createRunConfig());
    expect(unaffected.status).toBe("succeeded");
  });

  it("maps invalid RunConfig to runtime_invalid_options without invoking Controller", async () => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ limits: { maxIterations: 0 } }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_invalid_options",
      errors: [{ owner: "runtime", code: "runtime_invalid_options" }],
    });
    expect(result.items.map((item) => item.kind)).toEqual(["run_failed"]);
    expect(controller.calls).toHaveLength(0);
  });

  it("rejects malformed resolved Retry policy before invoking Controller", async () => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const baseRetry = createTestRetryConfiguration();
    const retry = {
      ...baseRetry,
      providerRequest: {
        ...baseRetry.providerRequest,
        maxRetries: -1,
      },
    };
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({ retry }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_invalid_options",
      errors: [{ message: expect.stringContaining("maxRetries") }],
    });
    expect(controller.calls).toHaveLength(0);
  });

  it.each([
    "boundarySettlementTimeoutMs",
    "processGracePeriodMs",
    "processForceKillTimeoutMs",
    "finalizationTimeoutMs",
  ] as const)("rejects non-positive cancellation limit %s", async (field) => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        cancellationLimits: { [field]: 0 },
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_invalid_options",
      errors: [{
        code: "runtime_invalid_options",
        message: expect.stringContaining(field),
      }],
    });
    expect(controller.calls).toHaveLength(0);
  });

  it("rejects cancellation limits above the platform timer range", async () => {
    const controller = new ScriptedController([finalDecision("Unused")]);
    const result = await createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        cancellationLimits: { boundarySettlementTimeoutMs: 2_147_483_648 },
      }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_invalid_options",
      errors: [{ message: expect.stringContaining("2147483647") }],
    });
    expect(controller.calls).toHaveLength(0);
  });

  it("keeps concurrent Run state invocation-local", async () => {
    const controller: Controller<unknown> = {
      async next(input) {
        return finalDecision(input.runId);
      },
    };
    const runner = createRunner(controller);

    const [first, second] = await Promise.all([
      runner.run(createAgent(), createRunInput("run_a"), createRunConfig({ runId: "run_a" })),
      runner.run(createAgent(), createRunInput("run_b"), createRunConfig({ runId: "run_b" })),
    ]);

    expect(first.status === "succeeded" && first.finalOutput.summary).toBe("run_a");
    expect(second.status === "succeeded" && second.finalOutput.summary).toBe("run_b");
    expect(first.items.every((item) => item.runId === "run_a")).toBe(true);
    expect(second.items.every((item) => item.runId === "run_b")).toBe(true);
  });

  it("snapshots multi-root Task workspace scope before asynchronous execution", async () => {
    const input = createRunInput();
    input.task.workspaceScope = {
      roots: {
        code: {
          id: "workspace_code",
          name: "Code",
          rootRef: "workspace://code",
          trustState: "trusted",
          source: "test",
          policyRefs: [],
          metadata: {},
        },
        docs: {
          id: "workspace_docs",
          name: "Docs",
          rootRef: "workspace://docs",
          trustState: "restricted",
          source: "test",
          policyRefs: [],
          metadata: {},
        },
      },
      defaultRootName: "code",
    };
    const controller = new ScriptedController([finalDecision("Done")]);
    const running = createRunner(controller).run(
      createAgent(),
      input,
      createRunConfig(),
    );

    input.task.workspaceScope.roots.code.id = "mutated_after_start";
    await running;

    expect(controller.calls[0]?.task.workspaceScope?.roots.code.id).toBe("workspace_code");
    expect(Object.isFrozen(controller.calls[0]?.task.workspaceScope?.roots)).toBe(true);
    expect(Object.keys(controller.calls[0]?.task.workspaceScope?.roots ?? {})).toEqual([
      "code",
      "docs",
    ]);
  });

  it("commits a tool outcome with references and returns to a fresh Controller turn", async () => {
    const controller = new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.read",
        input: { path: "README.md" },
        modelItemId: "model_1",
      }]),
      (input) => {
        expect(input.context).toMatchObject({
          observations: [{ kind: "tool_result", result: { output: "contents" } }],
          evidenceRefs: ["evidence_001"],
        });
        return finalDecision("Tool completed");
      },
    ]);
    const bridge: ToolActionBridge = {
      async execute(input) {
        expect(input.toolRisk).toBe("safe");
        return {
          status: "observed",
          outcome: "succeeded",
          observation: {
            kind: "tool_result",
            result: createToolResult(input.action.id, "contents"),
            metadata: { bridge: "temporary" },
          },
          evidenceRefs: ["evidence_001"],
          artifactRefs: ["artifact_001"],
        };
      },
    };

    const result = await createRunner(controller, { toolActionBridge: bridge }).run(
      createAgent([createAgentTool("test.read")]),
      createRunInput(),
      createRunConfig(),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      evidenceRefs: ["evidence_001"],
      artifactRefs: ["artifact_001"],
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "observation",
      "model_output",
      "final_output",
    ]);
  });

  it("rejects tools outside the Agent catalog without invoking the bridge", async () => {
    let bridgeCalls = 0;
    const bridge: ToolActionBridge = {
      async execute() {
        bridgeCalls += 1;
        throw new Error("Bridge must not be invoked.");
      },
    };
    const controller = new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.undeclared",
        input: {},
        modelItemId: "model_1",
      }]),
      finalDecision("Recovered"),
    ]);

    const result = await createRunner(controller, { toolActionBridge: bridge }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(),
    );

    expect(result.status).toBe("succeeded");
    expect(bridgeCalls).toBe(0);
    expect(controller.calls[1]?.context.observations).toMatchObject([
      { kind: "action_rejected", code: "tool_not_found" },
    ]);
  });

  it.each([
    [
      "denial",
      {
        kind: "action_denied" as const,
        owner: "permission" as const,
        code: "permission_denied",
        message: "Permission denied.",
        metadata: {},
      },
    ],
    [
      "failure",
      {
        kind: "action_failure" as const,
        error: {
          owner: "tool" as const,
          code: "tool_execution_failed",
          message: "Tool failed.",
          retryable: false,
          metadata: {},
        },
        metadata: {},
      },
    ],
  ])("returns to Controller after recoverable tool %s", async (_name, observation) => {
    const controller = new ScriptedController([
      actionsDecision([{
        kind: "tool",
        name: "test.read",
        input: {},
        modelItemId: "model_1",
      }]),
      finalDecision("Recovered"),
    ]);
    const bridge: ToolActionBridge = {
      async execute() {
        return {
          status: "observed",
          outcome: observation.kind === "action_denied" ? "denied" : "failed",
          observation,
          evidenceRefs: [],
          artifactRefs: [],
        };
      },
    };

    const result = await createRunner(controller, { toolActionBridge: bridge }).run(
      createAgent([createAgentTool("test.read")]),
      createRunInput(),
      createRunConfig(),
    );

    expect(result.status).toBe("succeeded");
    expect(controller.calls).toHaveLength(2);
    expect(controller.calls[1]?.context.observations.at(-1)?.kind).toBe(observation.kind);
  });

  it("invalidates the remaining Action batch after a settled external tool", async () => {
    let bridgeCalls = 0;
    const bridge: ToolActionBridge = {
      async execute(input) {
        bridgeCalls += 1;
        return {
          status: "observed",
          outcome: "succeeded",
          observation: {
            kind: "tool_result",
            result: createToolResult(input.action.id, input.action.name),
            metadata: {},
          },
          evidenceRefs: [],
          artifactRefs: [],
        };
      },
    };
    const controller = new ScriptedController([
      actionsDecision([
        { kind: "tool", name: "test.first", input: {}, modelItemId: "model_1" },
        { kind: "tool", name: "test.second", input: {}, modelItemId: "model_1" },
      ]),
      finalDecision("Replanned"),
    ]);

    const result = await createRunner(controller, { toolActionBridge: bridge }).run(
      createAgent([createAgentTool("test.first"), createAgentTool("test.second")]),
      createRunInput(),
      createRunConfig(),
    );

    expect(result.status).toBe("succeeded");
    expect(bridgeCalls).toBe(1);
  });

  it("commits a settled tool fact before terminalizing cancellation", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const bridge: ToolActionBridge = {
      async execute(input) {
        cancellation.requestCancellation({
          origin: "user",
          reasonCode: "user_requested",
        });
        return {
          status: "observed",
          outcome: "succeeded",
          observation: {
            kind: "tool_result",
            result: createToolResult(input.action.id, "side effect settled"),
            metadata: {},
          },
          evidenceRefs: ["evidence_after_cancel"],
          artifactRefs: [],
        };
      },
    };

    const result = await createRunner(
      new ScriptedController([actionsDecision([{
        kind: "tool",
        name: "test.write",
        input: {},
        modelItemId: "model_1",
      }])]),
      { toolActionBridge: bridge },
    ).run(
      createAgent([createAgentTool("test.write", "risky")]),
      createRunInput(),
      createRunConfig({ cancellation }),
    );

    expect(result).toMatchObject({
      status: "cancelled",
      evidenceRefs: ["evidence_after_cancel"],
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "run_cancellation_requested",
      "observation",
      "run_cancelled",
    ]);
  });

  it("fails when an active Tool boundary does not settle after cancellation", async () => {
    vi.useFakeTimers();
    try {
      const cancellation = createRunCancellationController({ runId: "run_001" });
      const toolStarted = createDeferred<void>();
      const bridge: ToolActionBridge = {
        async execute() {
          toolStarted.resolve();
          return new Promise(() => {});
        },
      };
      const run = createRunner(
        new ScriptedController([actionsDecision([{
          kind: "tool",
          name: "test.write",
          input: {},
          modelItemId: "model_1",
        }])]),
        { toolActionBridge: bridge },
      ).run(
        createAgent([createAgentTool("test.write", "risky")]),
        createRunInput(),
        createRunConfig({
          cancellation,
          cancellationLimits: { boundarySettlementTimeoutMs: 30 },
        }),
      );
      await toolStarted.promise;

      cancellation.requestCancellation({
        origin: "user",
        reasonCode: "user_requested",
      });
      await vi.advanceTimersByTimeAsync(30);
      const result = await run;

      expect(result).toMatchObject({
        status: "failed",
        code: "runtime_cancellation_settlement_timeout",
        cancellation: { reasonCode: "user_requested" },
        errors: [{ metadata: { boundary: "tool", settlementTimeoutMs: 30 } }],
      });
      expect(result.items.map((item) => item.kind)).toEqual([
        "model_output",
        "action",
        "run_cancellation_requested",
        "run_failed",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cancellation attribution when a settled bridge reports terminal failure", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const bridge: ToolActionBridge = {
      async execute() {
        cancellation.requestCancellation({
          origin: "user",
          reasonCode: "user_requested",
        });
        return {
          status: "terminal_failure",
          code: "storage_write_failed",
          errors: [{
            owner: "storage",
            code: "storage_write_failed",
            message: "Storage failed after tool settlement.",
            retryable: false,
            metadata: {},
          }],
          evidenceRefs: ["evidence_settled"],
          artifactRefs: [],
        };
      },
    };

    const result = await createRunner(
      new ScriptedController([actionsDecision([{
        kind: "tool",
        name: "test.write",
        input: {},
        modelItemId: "model_1",
      }])]),
      { toolActionBridge: bridge },
    ).run(
      createAgent([createAgentTool("test.write", "risky")]),
      createRunInput(),
      createRunConfig({ cancellation }),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "storage_write_failed",
      cancellation: { reasonCode: "user_requested" },
      evidenceRefs: ["evidence_settled"],
      errors: [{ owner: "storage" }],
    });
    expect(result.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "run_cancellation_requested",
      "run_failed",
    ]);
  });
});

describe("Runner approval lifecycle", () => {
  it("waits, applies a Run permission grant, and continues the same invocation", async () => {
    const reviewer = createApprovalReviewer((input) => decidedReview(input, {
      fileSystem: { write: ["C:/workspace/output.txt"] },
    }));
    const controller = new ScriptedController([
      permissionRequestDecision(),
      (input) => {
        expect(input.context.permission.authority).toMatchObject({
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
        expect(input.context.permission.authority.runGrantCount).toBe(0);
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
    const cancellation = createRunCancellationController({ runId: "run_001" });
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
    const running = createRunner(controller).run(
      createAgent(),
      createRunInput(),
      createRunConfig({
        cancellation,
        permissions: createReviewPermissionConfig(reviewer),
      }),
    );

    await started;
    expect(controller.calls).toHaveLength(1);
    cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    const result = await running;

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

function createRunner(
  controller: Controller<unknown>,
  dependencies: Partial<ConstructorParameters<typeof Runner>[0]> = {},
): Runner {
  return new Runner({
    controller,
    now: () => "2026-07-13T00:00:00.000Z",
    ...dependencies,
  });
}

function createAgent(tools: readonly ToolDefinition[] = []): Agent<TestOutput> {
  return {
    id: "agent_001",
    name: "Test Agent",
    instructions: "Complete the task.",
    tools,
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

function createAgentTool(
  name: string,
  risk: ToolDefinition["risk"] = "safe",
): ToolDefinition {
  return {
    name,
    risk,
    async execute() {
      throw new Error("Runner must execute tools through ToolActionBridge.");
    },
  };
}

function createToolResult(toolCallId: string, output: unknown) {
  return {
    toolCallId,
    toolName: "test.read",
    status: "succeeded" as const,
    output,
    error: null,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}

function createRunInput(runId = "run_001"): RunInput {
  return {
    runId,
    task: {
      id: "task_001",
      kind: "test.runner",
      input: {},
      createdAt: "2026-07-13T00:00:00.000Z",
      metadata: {},
    },
    conversationItems: [
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
    readonly runId?: string;
    readonly audit?: RunConfig["audit"];
    readonly telemetry?: RunConfig["telemetry"];
    readonly cancellation?: RunConfig["cancellation"];
    readonly cancellationLimits?: Partial<RunConfig["cancellationLimits"]>;
    readonly retry?: RunConfig["retry"];
    readonly limits?: Partial<Omit<RunConfig["limits"], "plan">>;
    readonly permissions?: ResolvedRunPermissionConfig;
  } = {},
): RunConfig {
  const runId = overrides.runId ?? "run_001";
  return {
    workspace: {
      id: "workspace_001",
      name: "Test workspace",
      rootRef: "workspace://root",
      trustState: "trusted",
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    identity: {
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    permissions: overrides.permissions ?? createTestPermissionConfig(),
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
    cancellation:
      overrides.cancellation ?? createRunCancellationController({ runId }),
    cancellationLimits: {
      boundarySettlementTimeoutMs: 1_000,
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

function createTestPermissionConfig(): ResolvedRunPermissionConfig {
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
        workspaceRoots: [{ rootId: "workspace_001", path: "C:/workspace" }],
      },
      managedConstraints,
    }),
    approvalPolicy: "never",
    reviewer: null,
    rules: [],
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
    actions,
    modelItems: [modelItem("model_1", { actions: actions.map((action) => action.name) })],
  };
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
