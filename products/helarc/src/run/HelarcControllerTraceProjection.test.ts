import {
  createRunCancellationController,
  type Controller,
  type ControllerDecision,
  type ControllerInput,
  type RuntimeEvent,
} from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import {
  enrichRuntimeEventWithControllerTrace,
  HelarcTracingController,
} from "./HelarcControllerTraceProjection.js";

describe("Helarc controller trace projection", () => {
  it("records allowlisted controller trace metadata by iteration", async () => {
    const traceByIteration = new Map<number, Metadata>();
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

    await controller.next(createControllerInput(), {
      cancellation: createRunCancellationController({ runId: "run-1" }).context,
    });

    expect(traceByIteration.get(1)).toEqual({
      source: "helarc-controller",
      controllerAction: "propose",
      promptArchitectureVersion: "helarc-prompt-v1",
      actionContractVersion: "helarc-action-v1",
      toolCatalogVersion: "helarc-tool-catalog-v1",
      exposedToolNames: ["codeAgent.readFile"],
      patchOperation: "create",
      patchPath: "empty.txt",
    });
  });

  it("enriches only the matching controller.finished event", () => {
    const traceByIteration = new Map<number, Metadata>([[1, {
      controllerAction: "call_tool",
      requestedToolName: "codeAgent.readFile",
    }]]);

    expect(enrichRuntimeEventWithControllerTrace(runtimeEvent(
      "controller.finished",
      { iteration: 1, status: "succeeded" },
    ), traceByIteration).payload).toMatchObject({
      iteration: 1,
      status: "succeeded",
      controllerAction: "call_tool",
      requestedToolName: "codeAgent.readFile",
    });

    expect(enrichRuntimeEventWithControllerTrace(runtimeEvent(
      "run.item.appended",
      { iteration: 1 },
    ), traceByIteration).payload).toEqual({ iteration: 1 });
    expect(enrichRuntimeEventWithControllerTrace(runtimeEvent(
      "controller.finished",
      { iteration: 2 },
    ), traceByIteration).payload).toEqual({ iteration: 2 });
  });
});

class FakeController implements Controller {
  constructor(private readonly decision: ControllerDecision) {}

  async next(): Promise<ControllerDecision> {
    return this.decision;
  }
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

function runtimeEvent(name: RuntimeEvent["name"], payload: Metadata): RuntimeEvent {
  return {
    id: "event-1",
    name,
    taskId: "task-1",
    sequence: 1,
    timestamp: "2026-07-08T00:00:00.000Z",
    payload,
  };
}
