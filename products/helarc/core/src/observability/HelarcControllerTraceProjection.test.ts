import type { Controller } from "@agent-anything/agent-runtime/controller";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  snapshotRuntimeEventPayload,
  type RuntimeEvent,
  type RuntimeEventName,
  type RuntimeEventPayloadMap,
} from "@agent-anything/observability/events";
import { createControllerTurnTraceOperationId } from "@agent-anything/observability/tracing";
import type { ControllerCallContext, ControllerDecision, ControllerInput } from "@agent-anything/agent-runtime/controller";
import { createRunCancellationController } from "@agent-anything/agent-runtime/run";
import { describe, expect, it } from "vitest";
import {
  HelarcTracingController,
  projectHelarcControllerTraceForEvent,
  type HelarcControllerTraceProjection,
} from "./HelarcControllerTraceProjection.js";

describe("Helarc controller trace projection", () => {
  it("records allowlisted controller trace metadata by Run and operation", async () => {
    const traceByOperationId = new Map<string, HelarcControllerTraceProjection>();
    const controller = new HelarcTracingController(new FakeController({
      kind: "propose_completion",
      output: { kind: "complete", summary: "Inspection complete." },
      modelItems: [{
        id: "run-1:model:1",
        kind: "assistant_action",
        content: { kind: "completion", summary: "Inspection complete." },
        metadata: {
          source: "helarc-controller",
          controllerAction: "completion",
          promptArchitectureVersion: "helarc-prompt-v4",
          actionContractVersion: "helarc-model-decision-v1",
          toolExposureVersion: "trusted-tool-exposure-v1",
          exposedToolNames: ["Read"],
          rawPrompt: "secret",
        },
      }],
    }), traceByOperationId);

    await controller.next(createControllerInput(), controllerCallContext());

    expect(traceByOperationId.get("controller-turn:1")).toEqual({
      runId: "run-1",
      operationId: "controller-turn:1",
      iteration: 1,
      source: "helarc-controller",
      controllerAction: "completion",
      promptArchitectureVersion: "helarc-prompt-v4",
      actionContractVersion: "helarc-model-decision-v1",
      toolExposureVersion: "trusted-tool-exposure-v1",
      exposedToolNames: ["Read"],
      requestedToolName: null,
    });
  });

  it("correlates Product trace without decorating the RuntimeEvent", () => {
    const trace = Object.freeze({
      runId: "run-1",
      operationId: "controller-turn:1",
      iteration: 1,
      source: null,
      controllerAction: "tool_call",
      promptArchitectureVersion: null,
      actionContractVersion: null,
      toolExposureVersion: null,
      exposedToolNames: Object.freeze([]),
      requestedToolName: "Read",
    });
    const traceByOperationId = new Map<string, HelarcControllerTraceProjection>([
      [createControllerTurnTraceOperationId(1), trace],
    ]);
    const event = runtimeEvent(
      "controller.finished",
      {
        turnId: "controller-turn-1",
        iteration: 1,
        status: "decided",
        code: null,
        decisionKind: "advance",
      },
    );

    expect(projectHelarcControllerTraceForEvent(event, traceByOperationId)).toBe(trace);
    expect(event.payload).toEqual({
      turnId: "controller-turn-1",
      iteration: 1,
      status: "decided",
      code: null,
      decisionKind: "advance",
    });
    expect(Object.isFrozen(event.payload)).toBe(true);

    expect(projectHelarcControllerTraceForEvent(runtimeEvent(
      "run.item.appended",
      { itemId: "item-1", itemKind: "run_action", itemSequence: 1 },
    ), traceByOperationId)).toBeNull();
    expect(projectHelarcControllerTraceForEvent(runtimeEvent(
      "controller.finished",
      {
        turnId: "controller-turn-2",
        iteration: 2,
        status: "decided",
        code: null,
        decisionKind: "propose_completion",
      },
    ), traceByOperationId)).toBeNull();
    expect(projectHelarcControllerTraceForEvent(runtimeEvent(
      "controller.finished",
      {
        turnId: "controller-turn-1",
        iteration: 1,
        status: "decided",
        code: null,
        decisionKind: "advance",
      },
      "another-run",
    ), traceByOperationId)).toBeNull();
  });
});

class FakeController implements Controller {
  constructor(private readonly decision: ControllerDecision) {}

  async next(): Promise<ControllerDecision> {
    return this.decision;
  }
}

function controllerCallContext(): ControllerCallContext {
  const policy = disabledRetryPolicy();
  return {
    cancellation: createRunCancellationController({ runId: "run-1" }).context,
    retry: {
      providerRequest: policy,
      structuredOutput: policy,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      events: { emit() {} },
    },
  };
}

function disabledRetryPolicy() {
  return {
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
}

function createControllerInput(): ControllerInput {
  return {
    runId: "run-1",
    iteration: 1,
    agent: {
      id: "helarc",
      name: "Helarc",
      instructions: "Complete the task.",
      tools: [],
      output: {
        validate(candidate) {
          return { valid: true, output: candidate };
        },
      },
      metadata: {},
    },
    task: {
      id: "task-1",
      kind: "helarc.code-task",
      input: { prompt: "Create file." },
      createdAt: "2026-07-08T00:00:00.000Z",
      metadata: {},
    },
    inputItems: [],
    context: {
      messages: [],
      observations: [],
      evidenceRefs: [],
      plan: null,
      metadata: {},
    },
    workspace: {
      id: "workspace-1",
      name: "Workspace",
      rootRef: "workspace://root",
      trustState: "trusted",
      source: "test",
      policyRefs: [],
      metadata: {},
    },
    identity: {
      id: "identity-1",
      kind: "anonymous",
      displayName: "Test identity",
      metadata: {},
    },
    metadata: {},
  };
}

function runtimeEvent<TName extends RuntimeEventName>(
  name: TName,
  payload: RuntimeEventPayloadMap[TName],
  runId = "run-1",
): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    id: "event-1",
    runId,
    name,
    taskId: "task-1",
    sequence: 1,
    occurredAt: "2026-07-08T00:00:00.000Z",
    payload: snapshotRuntimeEventPayload(name, payload),
  } as unknown as RuntimeEvent;
}
