import { describe, expect, it } from "vitest";
import type { AuditPort, TelemetryPort } from "@agent-anything/observability";
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
      context: { plan: null, observations: [] },
    });
    expect(Object.isFrozen(result)).toBe(true);
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
});

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

function createAgent(): Agent<TestOutput> {
  return {
    id: "agent_001",
    name: "Test Agent",
    instructions: "Complete the task.",
    tools: [],
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
    readonly limits?: Partial<Omit<RunConfig["limits"], "plan">>;
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
    metadata: {},
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
