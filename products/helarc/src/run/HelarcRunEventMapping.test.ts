import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import { mapRuntimeEventToHelarcRunEvent } from "./HelarcRunEventMapping.js";

describe("mapRuntimeEventToHelarcRunEvent", () => {
  it("maps planning events into renderer-safe run events", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "planner.finished",
      payload: {
        iteration: 1,
        status: "failed",
        errorCode: "provider_planner_failed",
        apiKey: "secret",
        rawProviderResponse: { choices: [] },
      },
    }));

    expect(event).toMatchObject({
      id: "event-1",
      sequence: 1,
      timestamp: "2026-07-04T00:00:00.000Z",
      kind: "provider.output",
      title: "Planning failed",
      detail: "provider_planner_failed",
      severity: "error",
      metadata: {
        runtimeEventName: "planner.finished",
        taskId: "task-1",
        iteration: 1,
        status: "failed",
        errorCode: "provider_planner_failed",
      },
    });
    expect(event.metadata).not.toHaveProperty("apiKey");
    expect(event.metadata).not.toHaveProperty("rawProviderResponse");
  });

  it("maps created call-tool plans as proposed tools", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "plan.created",
      payload: {
        iteration: 2,
        planStepId: "step-1",
        planStepKind: "callTool",
        plannerAction: "call_tool",
        promptArchitectureVersion: "helarc-prompt-v1",
        actionContractVersion: "helarc-action-v1",
        toolCatalogVersion: "helarc-tool-catalog-v1",
        exposedToolNames: [
          "codeAgent.listFiles",
          "codeAgent.readFile",
          "codeAgent.searchFiles",
        ],
        requestedToolName: "codeAgent.readFile",
        rawPrompt: "secret prompt",
        apiKey: "secret",
      },
    }));

    expect(event).toMatchObject({
      kind: "tool.proposed",
      title: "Tool call proposed",
      detail: "codeAgent.readFile",
      severity: "info",
      metadata: {
        iteration: 2,
        planStepId: "step-1",
        planStepKind: "callTool",
        plannerAction: "call_tool",
        promptArchitectureVersion: "helarc-prompt-v1",
        actionContractVersion: "helarc-action-v1",
        toolCatalogVersion: "helarc-tool-catalog-v1",
        exposedToolNames: [
          "codeAgent.listFiles",
          "codeAgent.readFile",
          "codeAgent.searchFiles",
        ],
        requestedToolName: "codeAgent.readFile",
      },
    });
    expect(event.metadata).not.toHaveProperty("rawPrompt");
    expect(event.metadata).not.toHaveProperty("apiKey");
  });

  it("maps proposed patch trace details without file content", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "plan.created",
      payload: {
        iteration: 1,
        planStepId: "step-1",
        planStepKind: "final",
        plannerAction: "propose",
        patchOperation: "create",
        patchPath: "empty.txt",
        proposedContent: "secret content",
      },
    }));

    expect(event).toMatchObject({
      kind: "runtime.output",
      title: "Final output proposed",
      detail: "create empty.txt",
      metadata: {
        plannerAction: "propose",
        patchOperation: "create",
        patchPath: "empty.txt",
      },
    });
    expect(event.metadata).not.toHaveProperty("proposedContent");
  });

  it("maps tool execution events without exposing raw tool inputs", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "tool.finished",
      payload: {
        iteration: 1,
        status: "succeeded",
        toolCallId: "tool-call-1",
        toolName: "codeAgent.readFile",
        toolResultStatus: "succeeded",
        command: "cat secret.txt",
        token: "secret-token",
      },
    }));

    expect(event).toMatchObject({
      kind: "tool.completed",
      title: "Tool succeeded: codeAgent.readFile",
      detail: "tool-call-1",
      severity: "info",
      metadata: {
        iteration: 1,
        status: "succeeded",
        toolCallId: "tool-call-1",
        toolName: "codeAgent.readFile",
        toolResultStatus: "succeeded",
      },
    });
    expect(event.metadata).not.toHaveProperty("command");
    expect(event.metadata).not.toHaveProperty("token");
  });

  it("maps permission decisions and denied results as errors", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "permission.resolved",
      payload: {
        requestId: "permission-1",
        toolName: "codeAgent.runCommand",
        decision: "denied",
        riskLevel: "high",
      },
    }));

    expect(event).toMatchObject({
      kind: "permission.resolved",
      title: "Permission denied",
      detail: "permission-1",
      severity: "error",
      metadata: {
        requestId: "permission-1",
        toolName: "codeAgent.runCommand",
        decision: "denied",
        riskLevel: "high",
      },
    });
  });

  it("maps task terminal events", () => {
    const completed = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "task.completed",
      payload: {
        status: "succeeded",
        durationMs: 1200,
        evidenceCount: 2,
        artifactCount: 1,
      },
    }));
    const failed = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      id: "event-2",
      sequence: 2,
      name: "task.failed",
      payload: {
        status: "failed",
        errorCode: "runtime_limit_exceeded",
        errorCodes: ["runtime_limit_exceeded"],
      },
    }));

    expect(completed).toMatchObject({
      kind: "run.completed",
      title: "Run completed",
      severity: "info",
      metadata: {
        durationMs: 1200,
        evidenceCount: 2,
        artifactCount: 1,
      },
    });
    expect(failed).toMatchObject({
      kind: "run.failed",
      title: "Run failed",
      detail: "runtime_limit_exceeded",
      severity: "error",
      metadata: {
        errorCode: "runtime_limit_exceeded",
        errorCodes: ["runtime_limit_exceeded"],
      },
    });
  });

  it("maps observation and context events with evidence references only", () => {
    const event = mapRuntimeEventToHelarcRunEvent(runtimeEvent({
      name: "observation.created",
      payload: {
        iteration: 1,
        observationId: "observation-1",
        evidenceRefs: ["evidence-1"],
        observation: { raw: "large payload" },
      },
    }));

    expect(event).toMatchObject({
      kind: "runtime.output",
      title: "Observation created",
      detail: "observation-1",
      metadata: {
        iteration: 1,
        observationId: "observation-1",
        evidenceRefs: ["evidence-1"],
      },
    });
    expect(event.metadata).not.toHaveProperty("observation");
  });

  it("maps committed Runner item notifications without exposing item content", () => {
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
      severity: "info",
      metadata: {
        runId: "run-1",
        itemId: "item-2",
        itemKind: "observation",
        itemSequence: 2,
      },
    });
    expect(event.metadata).not.toHaveProperty("observation");
  });
});

function runtimeEvent(input: {
  id?: string;
  sequence?: number;
  name: RuntimeEventName;
  payload: Metadata;
}): RuntimeEvent {
  return {
    id: input.id ?? "event-1",
    name: input.name,
    taskId: "task-1",
    sequence: input.sequence ?? 1,
    timestamp: "2026-07-04T00:00:00.000Z",
    payload: input.payload,
  };
}
