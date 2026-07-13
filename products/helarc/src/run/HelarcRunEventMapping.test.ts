import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import { mapRuntimeEventToHelarcRunEvent } from "./HelarcRunEventMapping.js";

describe("mapRuntimeEventToHelarcRunEvent", () => {
  it("maps failed Controller turns without exposing provider payloads", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "controller.finished",
      payload: {
        runId: "run-1",
        iteration: 1,
        status: "failed",
        code: "model_output_invalid",
        apiKey: "secret",
        rawProviderResponse: { choices: [] },
      },
    }));

    expect(event).toMatchObject({
      kind: "provider.output",
      title: "Controller failed",
      detail: "model_output_invalid",
      severity: "error",
      metadata: {
        runtimeEventName: "controller.finished",
        taskId: "task-1",
        runId: "run-1",
        iteration: 1,
        status: "failed",
        code: "model_output_invalid",
      },
    });
    expect(event.metadata).not.toHaveProperty("apiKey");
    expect(event.metadata).not.toHaveProperty("rawProviderResponse");
  });

  it("maps allowlisted call-tool Controller trace", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "controller.finished",
      payload: {
        runId: "run-1",
        iteration: 2,
        status: "succeeded",
        decisionKind: "actions",
        controllerAction: "call_tool",
        promptArchitectureVersion: "helarc-prompt-v1",
        actionContractVersion: "helarc-action-v1",
        toolCatalogVersion: "helarc-tool-catalog-v1",
        exposedToolNames: ["codeAgent.readFile"],
        requestedToolName: "codeAgent.readFile",
        rawPrompt: "secret prompt",
      },
    }));

    expect(event).toMatchObject({
      kind: "provider.output",
      title: "Controller succeeded",
      detail: "codeAgent.readFile",
      metadata: {
        controllerAction: "call_tool",
        requestedToolName: "codeAgent.readFile",
        exposedToolNames: ["codeAgent.readFile"],
      },
    });
    expect(event.metadata).not.toHaveProperty("rawPrompt");
  });

  it("maps proposed patch trace without file content", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "controller.finished",
      payload: {
        iteration: 1,
        status: "succeeded",
        controllerAction: "propose",
        patchOperation: "create",
        patchPath: "empty.txt",
        proposedContent: "secret content",
      },
    }));

    expect(event).toMatchObject({
      detail: "create empty.txt",
      metadata: {
        controllerAction: "propose",
        patchOperation: "create",
        patchPath: "empty.txt",
      },
    });
    expect(event.metadata).not.toHaveProperty("proposedContent");
  });

  it("maps tool execution by Runner-owned action id", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "tool.finished",
      payload: {
        runId: "run-1",
        actionId: "action-1",
        toolName: "codeAgent.readFile",
        status: "succeeded",
        command: "cat secret.txt",
      },
    }));

    expect(event).toMatchObject({
      kind: "tool.completed",
      title: "Tool succeeded: codeAgent.readFile",
      detail: "action-1",
      metadata: {
        runId: "run-1",
        actionId: "action-1",
        toolName: "codeAgent.readFile",
        status: "succeeded",
      },
    });
    expect(event.metadata).not.toHaveProperty("command");
  });

  it("maps committed Run items without exposing item content", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "run.item.appended",
      payload: {
        runId: "run-1",
        itemId: "item-2",
        itemKind: "observation",
        itemSequence: 2,
        observation: { raw: "private model-visible content" },
      },
    }));

    expect(event).toMatchObject({
      kind: "runtime.output",
      title: "Run item appended: observation",
      detail: "item-2",
      metadata: {
        runId: "run-1",
        itemId: "item-2",
        itemKind: "observation",
        itemSequence: 2,
      },
    });
    expect(event.metadata).not.toHaveProperty("observation");
  });

  it("maps permission decisions and terminal Run events", () => {
    const denied = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "permission.resolved",
      payload: {
        requestId: "permission-1",
        toolName: "codeAgent.runCommand",
        decision: "denied",
        riskLevel: "high",
      },
    }));
    const completed = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "run.completed",
      payload: { runId: "run-1", status: "succeeded" },
    }));

    expect(denied).toMatchObject({
      kind: "permission.resolved",
      title: "Permission denied",
      detail: "permission-1",
      severity: "error",
    });
    expect(completed).toMatchObject({
      kind: "run.completed",
      title: "Run completed",
      severity: "info",
    });
  });
});

function runtimeEvent(input: {
  name: RuntimeEventName;
  payload: Metadata;
}): RuntimeEvent {
  return {
    id: "event-1",
    name: input.name,
    taskId: "task-1",
    sequence: 1,
    timestamp: "2026-07-04T00:00:00.000Z",
    payload: input.payload,
  };
}
