import { describe, expect, it } from "vitest";
import { FakeProvider } from "@agent-anything/testing";
import type { Provider, ProviderResponse } from "@agent-anything/providers";
import type { AgentTask } from "../task/index.js";
import { ProviderBackedPlanner } from "./ProviderBackedPlanner.js";
import type { PlannerInput } from "./PlannerInput.js";
import type { PlanStep } from "./PlanStep.js";

describe("ProviderBackedPlanner", () => {
  it("builds provider requests and parses successful responses into plan steps", async () => {
    const provider = new FakeProvider({
      responses: [
        createProviderResponse({
          action: "final",
          finalOutput: {
            conclusion: "Done",
          },
        }),
      ],
    });
    const planner = new ProviderBackedPlanner({
      provider,
      buildRequest(input) {
        return {
          messages: [
            {
              role: "user",
              content: `Plan task ${input.task.id}.`,
              metadata: {
                taskId: input.task.id,
              },
            },
          ],
          capability: "tool-planning",
          metadata: {
            taskKind: input.task.kind,
          },
        };
      },
      parseResponse(response, input) {
        return {
          id: `plan_step_${input.task.id}`,
          kind: "final",
          finalOutput: response.output,
          reason: "Provider selected final answer.",
          metadata: {
            providerStatus: response.status,
          },
        };
      },
    });

    const result = await planner.plan(createPlannerInput());

    expect(result).toEqual({
      id: "plan_step_task_001",
      kind: "final",
      finalOutput: {
        action: "final",
        finalOutput: {
          conclusion: "Done",
        },
      },
      reason: "Provider selected final answer.",
      metadata: {
        providerStatus: "succeeded",
      },
    });
    expect(provider.requests()).toEqual([
      {
        messages: [
          {
            role: "user",
            content: "Plan task task_001.",
            metadata: {
              taskId: "task_001",
            },
          },
        ],
        capability: "tool-planning",
        metadata: {
          taskKind: "net-doctor.diagnose",
        },
      },
    ]);
  });

  it("maps provider failed responses to planner errors", async () => {
    const planner = new ProviderBackedPlanner({
      provider: new FakeProvider({
        responses: [
          {
            status: "failed",
            output: null,
            usage: null,
            error: {
              code: "provider_unavailable",
              message: "Provider unavailable.",
            },
            metadata: {},
          },
        ],
      }),
      buildRequest: createProviderRequest,
      parseResponse: createFinalPlanStep,
    });

    await expect(planner.plan(createPlannerInput())).rejects.toThrow(
      "Provider unavailable.",
    );
  });

  it("maps provider exceptions to planner errors", async () => {
    const planner = new ProviderBackedPlanner({
      provider: createThrowingProvider(),
      buildRequest: createProviderRequest,
      parseResponse: createFinalPlanStep,
    });

    await expect(planner.plan(createPlannerInput())).rejects.toThrow(
      "Provider exploded.",
    );
  });
});

function createPlannerInput(): PlannerInput {
  return {
    task: createTask(),
    context: {
      taskId: "task_001",
      messages: [],
      observations: [],
      evidenceRefs: [],
      metadata: {},
    },
    metadata: {},
  };
}

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input: {},
    createdAt: "2026-06-07T00:00:00.000Z",
    metadata: {},
  };
}

function createProviderRequest() {
  return {
    messages: [
      {
        role: "user" as const,
        content: "Plan next step.",
        metadata: {},
      },
    ],
    capability: "tool-planning",
    metadata: {},
  };
}

function createProviderResponse(output: unknown): ProviderResponse {
  return {
    status: "succeeded",
    output,
    usage: null,
    error: null,
    metadata: {},
  };
}

function createFinalPlanStep(): PlanStep {
  return {
    id: "plan_step_final",
    kind: "final",
    finalOutput: {
      conclusion: "Done",
    },
    reason: "Enough information.",
    metadata: {},
  };
}

function createThrowingProvider(): Provider {
  return {
    capabilities: {
      id: "throwing-provider",
      name: "Throwing Provider",
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
      metadata: {},
    },
    async send() {
      throw new Error("Provider exploded.");
    },
  };
}
