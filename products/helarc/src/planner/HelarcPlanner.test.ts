import { ProviderBackedPlanner, type PlannerInput } from "@agent-anything/agent-core";
import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import { describe, expect, it } from "vitest";
import {
  buildHelarcProviderRequest,
  HelarcPlannerParseError,
  parseHelarcProviderResponse,
  parseStructuredOutput,
} from "./index.js";

describe("Helarc planner", () => {
  it("builds a Helarc provider request without workspace authority", () => {
    const request = buildHelarcProviderRequest(createPlannerInput());

    expect(request.capability).toBe("helarc.code-agent.plan");
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.content).toContain("Return only JSON");
    expect(request.messages[1]?.content).toContain("Update docs");
    expect(request.messages.map((message) => message.content).join("\n"))
      .not.toContain("D:/projects/agent-anything");
  });

  it("parses call_tool output into a tool plan step", () => {
    const step = parseHelarcProviderResponse(response({
      action: "call_tool",
      reason: "Need to inspect files.",
      toolName: "codeAgent.listFiles",
      input: { path: "." },
      toolCallId: "tool-1",
    }), createPlannerInput());

    expect(step).toMatchObject({
      kind: "callTool",
      reason: "Need to inspect files.",
      toolCall: {
        id: "tool-1",
        toolName: "codeAgent.listFiles",
        input: { path: "." },
        risk: "safe",
      },
    });
  });

  it("parses complete output into a final plan step", () => {
    const step = parseHelarcProviderResponse(response({
      action: "complete",
      summary: "No changes needed.",
    }), createPlannerInput());

    expect(step).toMatchObject({
      kind: "final",
      reason: "No changes needed.",
      finalOutput: {
        kind: "complete",
        summary: "No changes needed.",
      },
    });
  });

  it("parses proposed change output into a final plan step", () => {
    const step = parseHelarcProviderResponse(response(JSON.stringify({
      action: "propose",
      summary: "Update README.",
      change: {
        operation: "update",
        path: "README.md",
        content: "# Updated\n",
      },
    })), createPlannerInput());

    expect(step).toMatchObject({
      kind: "final",
      finalOutput: {
        kind: "propose",
        summary: "Update README.",
        change: {
          operation: "update",
          path: "README.md",
          content: "# Updated\n",
        },
      },
    });
  });

  it("parses stop output into a stop plan step", () => {
    const step = parseHelarcProviderResponse(response({
      action: "stop",
      reason: "Task is unsafe.",
    }), createPlannerInput());

    expect(step).toMatchObject({
      kind: "stop",
      stopReason: "Task is unsafe.",
    });
  });

  it("rejects malformed structured output", () => {
    expect(() => parseStructuredOutput({ action: "propose", summary: "Missing change" }))
      .toThrowError(new HelarcPlannerParseError(
        "planner_change_required",
        "Proposed output requires a change object.",
      ));
  });

  it("can drive ProviderBackedPlanner with an injected fake provider", async () => {
    const provider = new FakeProvider(response({
      action: "complete",
      summary: "Finished.",
    }));
    const planner = new ProviderBackedPlanner({
      provider,
      buildRequest: buildHelarcProviderRequest,
      parseResponse: parseHelarcProviderResponse,
    });

    const step = await planner.plan(createPlannerInput());

    expect(provider.lastRequest?.capability).toBe("helarc.code-agent.plan");
    expect(step).toMatchObject({
      kind: "final",
      finalOutput: { kind: "complete", summary: "Finished." },
    });
  });
});

class FakeProvider implements Provider {
  readonly capabilities = {
    id: "fake-helarc-provider",
    name: "Fake Helarc Provider",
    supportsToolPlanning: true,
    supportsStructuredOutput: true,
    supportsStreaming: false,
    metadata: {},
  };
  lastRequest: ProviderRequest | null = null;

  constructor(private readonly providerResponse: ProviderResponse) {}

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return this.providerResponse;
  }
}

function response(output: unknown): ProviderResponse {
  return {
    status: "succeeded",
    output,
    usage: null,
    error: null,
    metadata: {},
  };
}

function createPlannerInput(): PlannerInput {
  return {
    task: {
      id: "task-1",
      kind: "helarc.code-task",
      input: { prompt: "Update docs" },
      createdAt: "2026-06-27T00:00:00.000Z",
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
