import { describe, expect, it, vi } from "vitest";
import type { Provider, ProviderRequest, ProviderResponse } from "@agent-anything/providers";
import { FakeProvider } from "@agent-anything/testing";
import type { Agent } from "../agent/index.js";
import { projectContext, createInitialContext } from "../context/index.js";
import { createRunCancellationController } from "../runner/index.js";
import type { AgentTask } from "../task/index.js";
import type {
  ControllerDecision,
  ControllerInput,
} from "./Controller.js";
import {
  ControllerError,
  ProviderBackedController,
} from "./ProviderBackedController.js";

interface TestOutput {
  readonly summary: string;
}

describe("ProviderBackedController", () => {
  it("builds a request and returns Agent-validated final output with model provenance", async () => {
    const provider = new FakeProvider({
      responses: [succeededResponse({ summary: "Done" })],
    });
    const controller = createController(provider, {
      buildRequest(input) {
        return request(`Run ${input.runId} for task ${input.task.id}.`);
      },
      parseResponse(response) {
        return finalDecision(response.output);
      },
    });

    const result = await controller.next(createControllerInput(), callContext());

    expect(result).toEqual({
      kind: "final_output",
      output: { summary: "Done" },
      modelItems: [modelItem("model_item_1", { summary: "Done" })],
    });
    expect(provider.requests()).toEqual([
      request("Run run_001 for task task_001."),
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.modelItems)).toBe(true);
  });

  it("preserves ordered actions and validates their model-item references", async () => {
    const provider = new FakeProvider({
      responses: [succeededResponse({ action: "tools" })],
    });
    const controller = createController(provider, {
      parseResponse() {
        return {
          kind: "actions",
          actions: [
            {
              kind: "tool",
              name: "workspace.readFile",
              input: { path: "README.md" },
              modelItemId: "model_item_1",
            },
            {
              kind: "internal",
              name: "plan.update",
              input: { step: "Inspect README" },
              modelItemId: "model_item_2",
            },
          ],
          modelItems: [
            modelItem("model_item_1", { tool: "workspace.readFile" }),
            modelItem("model_item_2", { action: "plan.update" }),
          ],
        };
      },
    });

    const result = await controller.next(createControllerInput(), callContext());

    expect(result.kind).toBe("actions");
    if (result.kind !== "actions") {
      throw new Error("Expected actions decision.");
    }
    expect(result.actions.map((action) => action.name)).toEqual([
      "workspace.readFile",
      "plan.update",
    ]);
    expect(result.actions.map((action) => action.modelItemId)).toEqual([
      "model_item_1",
      "model_item_2",
    ]);
  });

  it("normalizes stop decisions", async () => {
    const controller = createController(
      new FakeProvider({ responses: [succeededResponse({ action: "stop" })] }),
      {
        parseResponse() {
          return {
            kind: "stop",
            reason: "  No safe next action.  ",
            modelItems: [modelItem("model_item_1", { action: "stop" })],
          };
        },
      },
    );

    await expect(
      controller.next(createControllerInput(), callContext()),
    ).resolves.toMatchObject({
      kind: "stop",
      reason: "No safe next action.",
    });
  });

  it("maps failed provider responses to attributed ControllerError values", async () => {
    const controller = createController(
      new FakeProvider({
        responses: [
          {
            status: "failed",
            output: null,
            usage: null,
            error: {
              code: "upstream_unavailable",
              message: "Provider unavailable.",
            },
            metadata: {},
          },
        ],
      }),
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).runtimeError).toEqual({
      owner: "provider",
      code: "provider_request_failed",
      message: "Provider unavailable.",
      retryable: false,
      metadata: {
        providerId: "fake-provider",
        providerErrorCode: "upstream_unavailable",
      },
    });
  });

  it("does not expose thrown provider messages as runtime error messages", async () => {
    const controller = createController(throwingProvider());

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "provider",
      code: "provider_request_failed",
      message: "Provider request failed.",
      metadata: {
        providerId: "throwing-provider",
        causeName: "Error",
      },
    });
  });

  it("attributes request construction failures to the model request boundary", async () => {
    const controller = createController(new FakeProvider(), {
      buildRequest() {
        throw new TypeError("Prompt assembly failed.");
      },
    });

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "model",
      code: "model_request_failed",
      message: "Prompt assembly failed.",
    });
  });

  it("rejects oversized provider output before product parsing", async () => {
    const parseResponse = vi.fn(() => finalDecision({ summary: "unused" }));
    const controller = createController(
      new FakeProvider({ responses: [succeededResponse("123456")] }),
      { parseResponse, maxProviderOutputLength: 5 },
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(parseResponse).not.toHaveBeenCalled();
    expect((error as ControllerError).runtimeError).toMatchObject({
      owner: "model",
      code: "model_output_invalid",
      message: "Provider output exceeds the configured limit.",
      metadata: {
        maxProviderOutputLength: 5,
        actualProviderOutputLength: 6,
      },
    });
  });

  it("rejects parser failures and Agent output contract failures", async () => {
    const parseFailure = createController(
      new FakeProvider({ responses: [succeededResponse({ malformed: true })] }),
      {
        parseResponse() {
          throw new SyntaxError("Expected action kind.");
        },
      },
    );
    const outputFailure = createController(
      new FakeProvider({ responses: [succeededResponse({ summary: 42 })] }),
      {
        parseResponse(response) {
          return finalDecision(response.output);
        },
      },
    );

    const parseError = await captureError(
      parseFailure.next(createControllerInput(), callContext()),
    );
    const outputError = await captureError(
      outputFailure.next(createControllerInput(), callContext()),
    );

    expect((parseError as ControllerError).runtimeError).toMatchObject({
      code: "model_output_invalid",
      message: "Expected action kind.",
    });
    expect((outputError as ControllerError).runtimeError).toMatchObject({
      code: "model_output_invalid",
      message: "Final output must contain a summary string.",
    });
  });

  it.each([
    ["empty model items", { ...finalDecision({ summary: "Done" }), modelItems: [] }],
    [
      "duplicate model item ids",
      {
        ...finalDecision({ summary: "Done" }),
        modelItems: [modelItem("duplicate", {}), modelItem("duplicate", {})],
      },
    ],
    [
      "unknown action provenance",
      {
        kind: "actions",
        actions: [
          {
            kind: "tool",
            name: "workspace.readFile",
            input: {},
            modelItemId: "missing",
          },
        ],
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
    [
      "empty actions",
      {
        kind: "actions",
        actions: [],
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
    [
      "empty stop reason",
      {
        kind: "stop",
        reason: " ",
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
    [
      "unsupported decision kind",
      {
        kind: "handoff",
        modelItems: [modelItem("model_item_1", {})],
      },
    ],
  ])("rejects malformed decision: %s", async (_name, malformedDecision) => {
    const controller = createController(
      new FakeProvider({ responses: [succeededResponse({})] }),
      {
        parseResponse() {
          return malformedDecision as unknown as ControllerDecision<TestOutput>;
        },
      },
    );

    const error = await captureError(
      controller.next(createControllerInput(), callContext()),
    );

    expect(error).toBeInstanceOf(ControllerError);
    expect((error as ControllerError).runtimeError.code).toBe("model_output_invalid");
  });

  it("does not start provider work after cancellation", async () => {
    const provider = new FakeProvider({ responses: [succeededResponse({})] });
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const receipt = cancellation.requestCancellation({
      origin: "user",
      reasonCode: "user_requested",
    });
    const controller = createController(provider);

    const error = await captureError(
      controller.next(createControllerInput(), {
        cancellation: cancellation.context,
      }),
    );

    expect(error).toBe(receipt.request);
    expect(provider.requests()).toEqual([]);
  });

  it("discards a provider response when cancellation wins during the active call", async () => {
    const cancellation = createRunCancellationController({ runId: "run_001" });
    const parseResponse = vi.fn(() => finalDecision({ summary: "unused" }));
    const provider: Provider = {
      descriptor: providerDescriptor("cancelling-provider"),
      async send() {
        cancellation.requestCancellation({
          origin: "host",
          reasonCode: "host_requested",
        });
        return succeededResponse({ summary: "Too late" });
      },
    };
    const controller = createController(provider, { parseResponse });

    const error = await captureError(
      controller.next(createControllerInput(), {
        cancellation: cancellation.context,
      }),
    );

    expect(error).toBe(cancellation.context.request);
    expect(parseResponse).not.toHaveBeenCalled();
  });

  it("requires a positive integer provider output limit", () => {
    expect(
      () =>
        createController(new FakeProvider(), {
          maxProviderOutputLength: 0,
        }),
    ).toThrow("maxProviderOutputLength must be a positive integer.");
  });
});

function createController(
  provider: Provider,
  overrides: Partial<{
    buildRequest: (input: ControllerInput<TestOutput>) => ProviderRequest;
    parseResponse: (
      response: ProviderResponse,
      input: ControllerInput<TestOutput>,
    ) => ControllerDecision<TestOutput>;
    maxProviderOutputLength: number;
  }> = {},
): ProviderBackedController<TestOutput> {
  return new ProviderBackedController({
    provider,
    buildRequest: overrides.buildRequest ?? (() => request("Choose the next action.")),
    parseResponse:
      overrides.parseResponse ?? (() => finalDecision({ summary: "Done" })),
    maxProviderOutputLength: overrides.maxProviderOutputLength ?? 10_000,
  });
}

function createControllerInput(): ControllerInput<TestOutput> {
  const task = createTask();
  return {
    runId: "run_001",
    iteration: 1,
    agent: createAgent(),
    task,
    conversationItems: [],
    context: projectContext(createInitialContext(task), null),
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
    metadata: {},
  };
}

function createAgent(): Agent<TestOutput> {
  return {
    id: "agent_001",
    name: "Test Agent",
    instructions: "Complete the test task.",
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

        return {
          valid: false,
          message: "Final output must contain a summary string.",
        };
      },
    },
    metadata: {},
  };
}

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "test.agent.run",
    input: {},
    createdAt: "2026-07-13T00:00:00.000Z",
    metadata: {},
  };
}

function request(content: string): ProviderRequest {
  return {
    messages: [{ role: "user", content, metadata: {} }],
    capability: "agent-control",
    metadata: {},
  };
}

function succeededResponse(output: unknown): ProviderResponse {
  return {
    status: "succeeded",
    output,
    usage: null,
    error: null,
    metadata: {},
  };
}

function finalDecision(output: unknown): ControllerDecision<TestOutput> {
  return {
    kind: "final_output",
    output: output as TestOutput,
    modelItems: [modelItem("model_item_1", output)],
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

function callContext() {
  return {
    cancellation: createRunCancellationController({ runId: "run_001" }).context,
  };
}

function throwingProvider(): Provider {
  return {
    descriptor: providerDescriptor("throwing-provider"),
    async send() {
      throw new Error("secret upstream details");
    },
  };
}

function providerDescriptor(id: string) {
  return {
    id,
    name: id,
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
    },
    metadata: {},
  };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject.");
}
