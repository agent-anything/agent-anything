import type { Planner, PlannerInput, PlanStep, RuntimeEvent } from "@agent-anything/agent-core";
import type { Metadata } from "@agent-anything/shared";
import { describe, expect, it } from "vitest";
import {
  enrichRuntimeEventWithPlannerTrace,
  HelarcTracingPlanner,
} from "./HelarcPlannerTraceProjection.js";

describe("Helarc planner trace projection", () => {
  it("records allowlisted planner trace metadata by plan step id", async () => {
    const traceByPlanStepId = new Map<string, Metadata>();
    const planner = new HelarcTracingPlanner(new FakePlanner({
      id: "step-1",
      kind: "final",
      reason: "Create a file.",
      finalOutput: { kind: "propose", summary: "Create file." },
      metadata: {
        source: "helarc-planner",
        plannerAction: "propose",
        promptArchitectureVersion: "helarc-prompt-v1",
        actionContractVersion: "helarc-action-v1",
        toolCatalogVersion: "helarc-tool-catalog-v1",
        exposedToolNames: ["codeAgent.readFile"],
        patchOperation: "create",
        patchPath: "empty.txt",
        rawPrompt: "secret",
      },
    }), traceByPlanStepId);

    await planner.plan(createPlannerInput());

    expect(traceByPlanStepId.get("step-1")).toEqual({
      source: "helarc-planner",
      plannerAction: "propose",
      promptArchitectureVersion: "helarc-prompt-v1",
      actionContractVersion: "helarc-action-v1",
      toolCatalogVersion: "helarc-tool-catalog-v1",
      exposedToolNames: ["codeAgent.readFile"],
      patchOperation: "create",
      patchPath: "empty.txt",
    });
  });

  it("enriches only matching plan.created events", () => {
    const traceByPlanStepId = new Map<string, Metadata>([
      ["step-1", {
        plannerAction: "call_tool",
        requestedToolName: "codeAgent.readFile",
      }],
    ]);

    expect(enrichRuntimeEventWithPlannerTrace(runtimeEvent("plan.created", {
      planStepId: "step-1",
      planStepKind: "callTool",
    }), traceByPlanStepId).payload).toMatchObject({
      planStepId: "step-1",
      planStepKind: "callTool",
      plannerAction: "call_tool",
      requestedToolName: "codeAgent.readFile",
    });

    expect(enrichRuntimeEventWithPlannerTrace(runtimeEvent("planner.finished", {
      planStepId: "step-1",
    }), traceByPlanStepId).payload).toEqual({
      planStepId: "step-1",
    });
  });
});

class FakePlanner implements Planner {
  constructor(private readonly step: PlanStep) {}

  async plan(): Promise<PlanStep> {
    return this.step;
  }
}

function createPlannerInput(): PlannerInput {
  return {
    task: {
      id: "task-1",
      kind: "helarc.code-task",
      input: { prompt: "Create file." },
      createdAt: "2026-07-08T00:00:00.000Z",
      metadata: {},
    },
    context: {
      taskId: "task-1",
      messages: [],
      observations: [],
      evidenceRefs: [],
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
