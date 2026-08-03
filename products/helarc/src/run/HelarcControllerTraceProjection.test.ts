import type { Controller } from "@agent-anything/runtime/controller";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  snapshotRuntimeEventPayload,
  type RuntimeEvent,
  type RuntimeEventName,
  type RuntimeEventPayloadMap,
} from "@agent-anything/observability/events";
import type {
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "@agent-anything/runtime/controller";
import { createRunCancellationController } from "@agent-anything/runtime/run";
import { describe, expect, it } from "vitest";
import {
  HelarcTracingController,
  projectHelarcControllerTraceForEvent,
  type HelarcControllerTraceProjection,
} from "./HelarcControllerTraceProjection.js";

describe("Helarc controller trace projection", () => {
  it("records allowlisted controller trace metadata by iteration", async () => {
    const traceByIteration = new Map<number, HelarcControllerTraceProjection>();
    const controller = new HelarcTracingController(new FakeController({
      kind: "final_output",
      output: { kind: "propose", summary: "Create file." },
      modelItems: [{
        id: "run-1:model:1",
        kind: "assistant_action",
        content: { action: "propose" },
        metadata: {
          source: "helarc-controller",
          controllerAction: "propose",
          promptArchitectureVersion: "helarc-prompt-v1",
          actionContractVersion: "helarc-action-v1",
          toolCatalogVersion: "helarc-tool-catalog-v1",
          exposedToolNames: ["codeAgent.readFile"],
          patchOperation: "create",
          patchPath: "empty.txt",
          rawPrompt: "secret",
        },
      }],
    }), traceByIteration);

    await controller.next(createControllerInput(), controllerCallContext());

    expect(traceByIteration.get(1)).toEqual({
      iteration: 1,
      source: "helarc-controller",
      controllerAction: "propose",
      promptArchitectureVersion: "helarc-prompt-v1",
      actionContractVersion: "helarc-action-v1",
      toolCatalogVersion: "helarc-tool-catalog-v1",
      exposedToolNames: ["codeAgent.readFile"],
      requestedToolName: null,
      patchOperation: "create",
      patchPath: "empty.txt",
    });
  });

  it("correlates Product trace without decorating the RuntimeEvent", () => {
    const trace = Object.freeze({
      iteration: 1,
      source: null,
      controllerAction: "call_tool",
      promptArchitectureVersion: null,
      actionContractVersion: null,
      toolCatalogVersion: null,
      exposedToolNames: Object.freeze([]),
      requestedToolName: "codeAgent.readFile",
      patchOperation: null,
      patchPath: null,
    });
    const traceByIteration = new Map<number, HelarcControllerTraceProjection>([
      [1, trace],
    ]);
    const event = runtimeEvent(
      "controller.finished",
      {
        iteration: 1,
        status: "succeeded",
        code: null,
        decisionKind: "actions",
      },
    );

    expect(projectHelarcControllerTraceForEvent(event, traceByIteration)).toBe(trace);
    expect(event.payload).toEqual({
      iteration: 1,
      status: "succeeded",
      code: null,
      decisionKind: "actions",
    });
    expect(Object.isFrozen(event.payload)).toBe(true);

    expect(projectHelarcControllerTraceForEvent(runtimeEvent(
      "run.item.appended",
      { itemId: "item-1", itemKind: "model_output", itemSequence: 1 },
    ), traceByIteration)).toBeNull();
    expect(projectHelarcControllerTraceForEvent(runtimeEvent(
      "controller.finished",
      {
        iteration: 2,
        status: "succeeded",
        code: null,
        decisionKind: "final_output",
      },
    ), traceByIteration)).toBeNull();
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
    conversationItems: [],
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
): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    id: "event-1",
    runId: "run-1",
    name,
    taskId: "task-1",
    sequence: 1,
    occurredAt: "2026-07-08T00:00:00.000Z",
    payload: snapshotRuntimeEventPayload(name, payload),
  } as unknown as RuntimeEvent;
}
