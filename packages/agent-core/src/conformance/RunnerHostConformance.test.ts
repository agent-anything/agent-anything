import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolResult } from "@agent-anything/tools";
import type { Agent } from "../agent/index.js";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "../controller/index.js";
import {
  createHostRuntimeAdapter,
  type HostRunInput,
  type HostRunResult,
  type HostRuntimeAdapter,
  type HostSessionState,
} from "../host/index.js";
import {
  Runner,
  createRunCancellationController,
  type ActionCandidate,
  type RunConfig,
  type ToolActionBridge,
  type ToolActionBridgeInput,
  type ToolActionBridgeResult,
} from "../runner/index.js";

interface ConformanceOutput {
  readonly summary: string;
}

type ControllerStep = (
  input: ControllerInput,
  context: ControllerCallContext,
) => ControllerDecision | Promise<ControllerDecision>;

describe("Runner and generic Host conformance", () => {
  it("preserves direct completion through the generic Host adapter", async () => {
    const controller = new FakeController([
      (input) => finalDecision(input, "Direct completion"),
    ]);
    const harness = createHostHarness(controller);

    const result = await harness.run(createHostInput());

    expect(result).toMatchObject({
      state: { status: "completed" },
      runResult: {
        status: "succeeded",
        finalOutput: { summary: "Direct completion" },
      },
    });
    expect(result.state.runResult).toBe(result.runResult);
    expect(harness.states.map((state) => state.status)).toEqual([
      "running",
      "completed",
    ]);
  });

  it("supports optional Plan and multi-iteration Tool execution in one Runner loop", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "Track the work.",
          plan: [{ step: "Inspect resource", status: "in_progress" }],
        },
      }]),
      (input) => actionsDecision(input, [{
        kind: "tool",
        name: "conformance.inspect",
        input: { resource: "workspace://fixture" },
      }]),
      (input) => finalDecision(input, "Inspection complete"),
    ]);
    const bridge = new FakeToolActionBridge(() => succeededToolResult());
    const harness = createHostHarness(controller, bridge);

    const result = await harness.run(createHostInput({
      tools: [conformanceTool()],
    }));

    expect(result.runResult.status).toBe("succeeded");
    expect(controller.calls).toHaveLength(3);
    expect(controller.calls[1]?.context.plan).toMatchObject({
      version: 1,
      status: "active",
      steps: [{ step: "Inspect resource", status: "in_progress" }],
    });
    expect(controller.calls[2]?.context.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "plan_update" }),
        expect.objectContaining({ kind: "tool_result" }),
      ]),
    );
    expect(bridge.calls).toHaveLength(1);
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "plan_created",
      "observation",
      "model_output",
      "action",
      "observation",
      "model_output",
      "plan_abandoned",
      "final_output",
    ]);
  });

  it("carries one Plan through creation, completion, reactivation, and terminal abandonment", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "Start with inspection.",
          plan: [{ step: "Inspect resource", status: "in_progress" }],
        },
      }]),
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "Inspection is complete.",
          plan: [{ step: "Inspect resource", status: "completed" }],
        },
      }]),
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          explanation: "New work was discovered.",
          plan: [
            { step: "Inspect resource", status: "completed" },
            { step: "Verify discovery", status: "in_progress" },
          ],
        },
      }]),
      (input) => finalDecision(input, "Plan lifecycle complete"),
    ]);

    const result = await createHostHarness(controller).run(createHostInput());

    expect(result.runResult.status).toBe("succeeded");
    expect(controller.calls.map((call) => call.context.plan?.status ?? null)).toEqual([
      null,
      "active",
      "completed",
      "active",
    ]);
    expect(controller.calls.map((call) => call.context.plan?.version ?? null)).toEqual([
      null,
      1,
      2,
      3,
    ]);
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "plan_created",
      "observation",
      "model_output",
      "action",
      "plan_updated",
      "plan_completed",
      "observation",
      "model_output",
      "action",
      "plan_updated",
      "observation",
      "model_output",
      "plan_abandoned",
      "final_output",
    ]);
  });

  it("returns an invalid Plan update as a recoverable Observation", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "internal",
        name: "update_plan",
        input: {
          plan: [
            { step: "First concurrent step", status: "in_progress" },
            { step: "Second concurrent step", status: "in_progress" },
          ],
        },
      }]),
      (input) => {
        expect(input.context.plan).toBeNull();
        expect(input.context.observations.at(-1)).toMatchObject({
          kind: "plan_update",
          result: {
            status: "rejected",
            code: "plan_invalid",
          },
        });
        return finalDecision(input, "Recovered after invalid Plan");
      },
    ]);

    const result = await createHostHarness(controller).run(createHostInput());

    expect(result).toMatchObject({
      state: { status: "completed" },
      runResult: {
        status: "succeeded",
        finalOutput: { summary: "Recovered after invalid Plan" },
      },
    });
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "action",
      "observation",
      "model_output",
      "final_output",
    ]);
  });

  it("returns a recoverable Tool failure to Controller as an Observation", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "tool",
        name: "conformance.inspect",
        input: {},
      }]),
      (input) => {
        expect(input.context.observations.at(-1)).toMatchObject({
          kind: "action_failure",
          error: { owner: "tool", code: "fixture_unavailable" },
        });
        return finalDecision(input, "Recovered after observation");
      },
    ]);
    const bridge = new FakeToolActionBridge(() => ({
      status: "observed",
      outcome: "failed",
      observation: {
        kind: "action_failure",
        error: {
          owner: "tool",
          code: "fixture_unavailable",
          message: "Fixture is temporarily unavailable.",
          retryable: true,
          metadata: {},
        },
        metadata: {},
      },
      evidenceRefs: [],
      artifactRefs: [],
    }));

    const result = await createHostHarness(controller, bridge).run(
      createHostInput({ tools: [conformanceTool()] }),
    );

    expect(result.runResult).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Recovered after observation" },
    });
  });

  it("returns a recoverable permission denial to the same Controller loop", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "tool",
        name: "conformance.inspect",
        input: {},
      }]),
      (input) => {
        expect(input.context.observations.at(-1)).toMatchObject({
          kind: "action_denied",
          owner: "permission",
          code: "permission_denied",
        });
        return finalDecision(input, "Recovered after denial");
      },
    ]);
    const bridge = new FakeToolActionBridge(() => ({
      status: "observed",
      outcome: "denied",
      observation: {
        kind: "action_denied",
        owner: "permission",
        code: "permission_denied",
        message: "Permission denied by conformance fixture.",
        metadata: {},
      },
      evidenceRefs: [],
      artifactRefs: [],
    }));

    const result = await createHostHarness(controller, bridge).run(
      createHostInput({ tools: [conformanceTool()] }),
    );

    expect(result).toMatchObject({
      state: { status: "completed" },
      runResult: {
        status: "succeeded",
        finalOutput: { summary: "Recovered after denial" },
      },
    });
    expect(result.state.runResult).toBe(result.runResult);
  });

  it("projects Controller stop as blocked while preserving the exact RunResult", async () => {
    const controller = new FakeController([
      (input) => ({
        kind: "stop",
        reason: "No safe path remains.",
        modelItems: [modelItem(input, { action: "stop" })],
      }),
    ]);

    const result = await createHostHarness(controller).run(createHostInput());

    expect(result).toMatchObject({
      state: { status: "blocked" },
      runResult: {
        status: "blocked",
        code: "runtime_no_safe_path",
      },
    });
    expect(result.state.runResult).toBe(result.runResult);
    expect(result.runResult.items.map((item) => item.kind)).toEqual([
      "model_output",
      "stop",
      "run_blocked",
    ]);
  });

  it("projects a Runner iteration limit as failed without reconstructing it in Host", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "tool",
        name: "conformance.inspect",
        input: {},
      }]),
    ]);
    const bridge = new FakeToolActionBridge(() => succeededToolResult());

    const result = await createHostHarness(controller, bridge).run(createHostInput({
      tools: [conformanceTool()],
      limits: { maxIterations: 1 },
    }));

    expect(result).toMatchObject({
      state: { status: "failed" },
      runResult: {
        status: "failed",
        code: "runtime_limit_exceeded",
        errors: [{ owner: "runtime", code: "runtime_limit_exceeded" }],
      },
    });
    expect(result.state.runResult).toBe(result.runResult);
  });

  it("preserves a terminal Tool boundary failure through the generic Host", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "tool",
        name: "conformance.inspect",
        input: {},
      }]),
    ]);
    const bridge = new FakeToolActionBridge(() => ({
      status: "terminal_failure",
      code: "storage_write_failed",
      errors: [{
        owner: "storage",
        code: "storage_write_failed",
        message: "Conformance storage failed.",
        retryable: false,
        metadata: {},
      }],
      evidenceRefs: [],
      artifactRefs: [],
    }));

    const result = await createHostHarness(controller, bridge).run(
      createHostInput({ tools: [conformanceTool()] }),
    );

    expect(result).toMatchObject({
      state: {
        status: "failed",
        errors: [{ owner: "storage", code: "storage_write_failed" }],
      },
      runResult: {
        status: "failed",
        code: "storage_write_failed",
      },
    });
    expect(result.state.runResult).toBe(result.runResult);
    expect(result.state.status === "failed" && result.state.errors).toBe(result.runResult.errors);
  });

  it("keeps Host cancelling non-terminal until Runner settles the active boundary", async () => {
    const controller = new FakeController([
      (input) => actionsDecision(input, [{
        kind: "tool",
        name: "conformance.inspect",
        input: {},
      }]),
    ]);
    const bridge = new DeferredToolActionBridge();
    const harness = createHostHarness(controller, bridge);
    const input = createHostInput({ tools: [conformanceTool()] });

    const pendingResult = harness.run(input);
    await bridge.started;
    const receipt = harness.cancel(input);

    expect(receipt.accepted).toBe(true);
    expect(harness.states.at(-1)).toMatchObject({
      status: "cancelling",
      cancellationRequest: {
        id: "run-conformance:cancellation",
        reasonCode: "host_requested",
      },
    });

    bridge.release();
    const result = await pendingResult;

    expect(result.state.status).toBe("cancelled");
    expect(result.runResult).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      cancellation: {
        requestId: "run-conformance:cancellation",
        origin: "host",
        reasonCode: "host_requested",
      },
    });
    expect(result.state.runResult).toBe(result.runResult);
    expect(harness.states.map((state) => state.status)).toEqual([
      "running",
      "cancelling",
      "cancelled",
    ]);
  });
});

class FakeController implements Controller {
  readonly calls: ControllerInput[] = [];

  constructor(private readonly steps: ControllerStep[]) {}

  async next(
    input: ControllerInput,
    context: ControllerCallContext,
  ): Promise<ControllerDecision> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (!step) {
      throw new Error("FakeController has no remaining decision.");
    }
    return step(input, context);
  }
}

class FakeToolActionBridge implements ToolActionBridge {
  readonly calls: ToolActionBridgeInput[] = [];

  constructor(
    private readonly resolve: (
      input: ToolActionBridgeInput,
    ) => ToolActionBridgeResult | Promise<ToolActionBridgeResult>,
  ) {}

  async execute(input: ToolActionBridgeInput): Promise<ToolActionBridgeResult> {
    this.calls.push(input);
    return this.resolve(input);
  }
}

class DeferredToolActionBridge implements ToolActionBridge {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private settle!: () => void;
  private readonly settled: Promise<void>;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  release(): void {
    this.settle();
  }

  async execute(): Promise<ToolActionBridgeResult> {
    this.markStarted();
    await this.settled;
    return succeededToolResult();
  }
}

class InMemoryHostHarness {
  readonly states: HostSessionState<ConformanceOutput>[] = [];

  constructor(private readonly adapter: HostRuntimeAdapter) {}

  async run(
    input: HostRunInput<ConformanceOutput>,
  ): Promise<HostRunResult<ConformanceOutput>> {
    this.states.push({
      sessionId: input.sessionId,
      status: "running",
      taskId: input.runInput.task.id,
      runId: input.runInput.runId,
      timestamp: "2026-07-14T00:00:00.000Z",
      metadata: {},
    });
    const result = await this.adapter.run(input);
    this.states.push(result.state);
    return result;
  }

  cancel(input: HostRunInput<ConformanceOutput>) {
    const receipt = input.runConfig.cancellation.requestCancellation({
      origin: "host",
      reasonCode: "host_requested",
      reason: "Cancelled by conformance Host.",
    });
    if (receipt.accepted) {
      this.states.push({
        sessionId: input.sessionId,
        status: "cancelling",
        taskId: input.runInput.task.id,
        runId: input.runInput.runId,
        timestamp: receipt.request.requestedAt,
        cancellationRequest: receipt.request,
        metadata: {},
      });
    }
    return receipt;
  }
}

function createHostHarness(
  controller: Controller,
  toolActionBridge?: ToolActionBridge,
): InMemoryHostHarness {
  const runner = new Runner({
    controller,
    ...(toolActionBridge ? { toolActionBridge } : {}),
    now: () => "2026-07-14T00:00:00.000Z",
  });
  return new InMemoryHostHarness(createHostRuntimeAdapter({
    runner,
    now: () => "2026-07-14T00:00:00.000Z",
  }));
}

function createHostInput(input: {
  tools?: readonly ToolDefinition[];
  limits?: Partial<Omit<RunConfig["limits"], "plan">>;
} = {}): HostRunInput<ConformanceOutput> {
  const cancellation = createRunCancellationController({
    runId: "run-conformance",
    now: () => "2026-07-14T00:00:00.000Z",
  });
  return {
    sessionId: "session-conformance",
    agent: createAgent(input.tools ?? []),
    runInput: {
      runId: "run-conformance",
      task: {
        id: "task-conformance",
        kind: "conformance.task",
        input: { prompt: "Exercise generic Runner behavior." },
        createdAt: "2026-07-14T00:00:00.000Z",
        metadata: {},
      },
      conversationItems: [],
      metadata: {},
    },
    runConfig: {
      workspace: {
        id: "workspace-conformance",
        name: "Conformance workspace",
        rootRef: "workspace://conformance",
        trustState: "trusted",
        source: "conformance",
        policyRefs: [],
        metadata: {},
      },
      identity: {
        id: "identity-conformance",
        kind: "anonymous",
        displayName: "Conformance identity",
        metadata: {},
      },
      limits: {
        maxIterations: 5,
        maxActions: 5,
        maxConsecutiveActionFailures: 1,
        maxDurationMs: 5_000,
        ...input.limits,
        plan: {
          maxSteps: 5,
          maxStepLength: 100,
          maxExplanationLength: 200,
        },
      },
      audit: "optional",
      telemetry: "optional",
      cancellation,
      cancellationLimits: {
        boundarySettlementTimeoutMs: 1_000,
        processGracePeriodMs: 100,
        processForceKillTimeoutMs: 500,
        finalizationTimeoutMs: 1_000,
      },
      retry: disabledRetryConfiguration(),
      metadata: {},
    },
    metadata: { fixture: "generic-host-conformance" },
  };
}

function disabledRetryConfiguration(): RunConfig["retry"] {
  const policy = {
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
  return { providerRequest: policy, structuredOutput: policy };
}

function createAgent(tools: readonly ToolDefinition[]): Agent<ConformanceOutput> {
  return {
    id: "agent-conformance",
    name: "Conformance Agent",
    instructions: "Complete the conformance task.",
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
        return { valid: false, message: "Conformance output requires summary." };
      },
    },
    metadata: {},
  };
}

function conformanceTool(): ToolDefinition {
  return {
    name: "conformance.inspect",
    description: "Inspect a conformance resource.",
    risk: "safe",
    async execute() {
      throw new Error("Conformance ToolDefinition is executed only through the bridge.");
    },
  };
}

function finalDecision(
  input: ControllerInput,
  summary: string,
): ControllerDecision {
  return {
    kind: "final_output",
    output: { summary },
    modelItems: [modelItem(input, { action: "complete", summary })],
  };
}

function actionsDecision(
  input: ControllerInput,
  candidates: readonly Omit<ActionCandidate, "modelItemId">[],
): ControllerDecision {
  const model = modelItem(input, { action: "actions" });
  const actions = candidates.map((candidate) => ({
    ...candidate,
    modelItemId: model.id,
  })) as [ActionCandidate, ...ActionCandidate[]];
  return {
    kind: "actions",
    actions,
    modelItems: [model],
  };
}

function modelItem(input: ControllerInput, content: unknown) {
  return {
    id: `${input.runId}:model:${input.iteration}`,
    kind: "assistant_action",
    content,
    metadata: {},
  };
}

function succeededToolResult(): ToolActionBridgeResult {
  const result: ToolResult = {
    toolCallId: "bridge-tool-call",
    toolName: "conformance.inspect",
    status: "succeeded",
    output: { inspected: true },
    error: null,
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:00.000Z",
    metadata: {},
  };
  return {
    status: "observed",
    outcome: "succeeded",
    observation: {
      kind: "tool_result",
      result,
      metadata: {},
    },
    evidenceRefs: [],
    artifactRefs: [],
  };
}
