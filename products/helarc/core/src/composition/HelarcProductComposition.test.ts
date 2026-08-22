import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createFailedRunResult } from "@agent-anything/agent-runtime/run";
import { createActionRegistrationSnapshot } from "@agent-anything/canonical-action/registration";
import {
  bindingRefForCodeFileTool,
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_WRITE_TOOL,
  operationRefForCodeFileTool,
  type CodeFileActionAdapterIds,
  type CodeFileToolName,
} from "@agent-anything/helarc-code-agent/file-operation";
import type { CodeSourcePort } from "@agent-anything/helarc-code-agent/source";
import { createControllerToolExposureProof } from "@agent-anything/tools/selection";
import { describe, expect, it } from "vitest";
import { createHelarcTask } from "../task/index.js";
import { createHelarcProductComposition } from "./HelarcProductComposition.js";
import {
  HELARC_SHELL_BINDING,
  HELARC_SHELL_OPERATION,
  HELARC_TASK_STOP_BINDING,
  HELARC_TASK_STOP_OPERATION,
} from "../tools/HelarcCommandOperation.js";

describe("HelarcProductComposition", () => {
  it("defines one invocation's product behavior without exposing an execution entry point", async () => {
    const composition = await createHelarcProductComposition({
      runId: "run-1",
      ...createTask("D:/workspace"),
      provider: new UnusedProvider(),
      ...createLocalContributions(),
    });

    expect(composition.agent).toMatchObject({
      id: "helarc-code-agent",
      name: "Helarc",
    });
    expect(composition.runMetadata).toMatchObject({
      product: "helarc",
    });
    expect("run" in composition).toBe(false);
    expect("start" in composition).toBe(false);
    expect("runner" in composition).toBe(false);
  });

  it("exposes the admitted Code Agent Tool surface through its exact semantic bindings", async () => {
    const composition = await createHelarcProductComposition({
      runId: "run-1",
      ...createTask("D:/workspace"),
      provider: new UnusedProvider(),
      ...createLocalContributions(),
    });

    const exposure = createControllerToolExposureProof(
      composition.actions.toolSelection,
      "controller-request-1",
    );
    expect(exposure.catalog.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "Edit", "Glob", "Grep", "Read", "Write", "PowerShell", "TaskStop",
      "AskUserQuestion", "Agent",
    ]));
    expect(exposure.catalog.tools.find(({ name }) => name === "AskUserQuestion")?.binding.kind)
      .toBe("interaction");
    expect(exposure.catalog.tools.find(({ name }) => name === "Agent")?.binding.kind)
      .toBe("descendant_agent");
    expect(composition.interactions.protocols).toContainEqual({
      owner: "helarc",
      kind: "clarification",
      revision: "1",
    });
    expect(composition.actions.registrations.registrations.map(({ operation }) => operation.operation.name))
      .toEqual(expect.arrayContaining(["edit", "glob", "grep", "read", "write", "shell-execute", "task-stop"]));
  });

  it("projects trusted failures into bounded product messages without leaking raw data", async () => {
    const secret = "sentinel-provider-secret";
    const composition = await createHelarcProductComposition({
      runId: "run-1",
      ...createTask("D:/workspace"),
      provider: new UnusedProvider(),
      ...createLocalContributions(),
    });

    const result = composition.projectResult(createFailedRunResult({
      runId: "run-1",
      taskId: "helarc-composition-test-task",
      startingAgent: { id: "helarc-code-agent", revision: "1" },
      finalActiveAgent: { id: "helarc-code-agent", revision: "1" },
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:00:01.000Z",
      metadata: { rawProvider: secret },
    }, "controller_failed", {
      kind: "provider",
      failure: {
        category: "transport",
        code: "provider_request_failed",
        message: `Provider failed with ${secret}.`,
        metadata: { apiKey: secret },
      },
    }), "disabled", null);

    expect(result.output.safeErrors).toEqual([{
      code: "provider_request_failed",
      message: "The model request could not be completed.",
    }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("rawProvider");
    expect(JSON.stringify(result)).not.toContain("apiKey");
  });
});

function createTask(workspaceRoot: string) {
  const result = createHelarcTask({
    taskId: "helarc-composition-test-task",
    prompt: "Inspect the workspace.",
  });
  if (!result.ok) throw new Error(result.error.message);
  return {
    task: result.task,
    workspace: {
      primary: {
        id: "workspace-1",
        name: "Workspace",
        rootRef: workspaceRoot,
        trustState: "trusted" as const,
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
  };
}

const FILE_TOOLS = [
  CODE_AGENT_READ_TOOL,
  CODE_AGENT_GLOB_TOOL,
  CODE_AGENT_GREP_TOOL,
  CODE_AGENT_EDIT_TOOL,
  CODE_AGENT_WRITE_TOOL,
] as const;

function createLocalContributions() {
  const actionAdapterIds = Object.freeze(Object.fromEntries(
    FILE_TOOLS.map((name) => [requestOperation(name), `test.${requestOperation(name)}.adapter`]),
  ) as unknown as CodeFileActionAdapterIds);
  const executor = {
    id: "test.filesystem.executor",
    version: "1",
    invocationContractVersion: "1",
    physicalPayloadSchemaRevision: "1",
  };
  return {
    codeSource: unavailableCodeSource(),
    fileActions: {
      actionAdapterIds,
      registrations: createActionRegistrationSnapshot(FILE_TOOLS.map((name) => ({
        registrationId: `test.${requestOperation(name)}.registration`,
        revision: "1",
        operation: operationRefForCodeFileTool(name),
        binding: bindingRefForCodeFileTool(name),
        adapter: {
          id: actionAdapterIds[requestOperation(name)],
          version: "1",
          requestSchemaRevision: "1",
        },
        executor,
        effectFamilies: ["filesystem" as const],
        sandboxRequirementRevision: "test.filesystem.sandbox.v1",
        maxInvocationBytes: 1_000_000,
        maxPhysicalResultBytes: 1_000_000,
      }))),
      adapters: [],
      executors: [],
    },
    commandActions: {
      shellTool: "PowerShell" as const,
      shellActionAdapterId: "test.shell.adapter",
      taskStopActionAdapterId: "test.task-stop.adapter",
      environment: { id: "test-shell", revision: "sha256:test-shell" },
      registrations: createActionRegistrationSnapshot([
        {
          registrationId: "test.shell.registration", revision: "1",
          operation: HELARC_SHELL_OPERATION, binding: HELARC_SHELL_BINDING,
          adapter: { id: "test.shell.adapter", version: "1", requestSchemaRevision: "1" },
          executor: { ...executor, id: "test.shell.executor" },
          effectFamilies: ["process", "filesystem"], sandboxRequirementRevision: "test.shell.sandbox.v1",
          maxInvocationBytes: 1_000_000, maxPhysicalResultBytes: 1_000_000,
        },
        {
          registrationId: "test.task-stop.registration", revision: "1",
          operation: HELARC_TASK_STOP_OPERATION, binding: HELARC_TASK_STOP_BINDING,
          adapter: { id: "test.task-stop.adapter", version: "1", requestSchemaRevision: "1" },
          executor: { ...executor, id: "test.task-stop.executor" },
          effectFamilies: ["process"], sandboxRequirementRevision: "test.shell.sandbox.v1",
          maxInvocationBytes: 1_000_000, maxPhysicalResultBytes: 1_000_000,
        },
      ]),
      adapters: [], executors: [],
    },
  };
}

function requestOperation(
  name: CodeFileToolName,
): "read" | "glob" | "grep" | "edit" | "write" {
  return ({
    [CODE_AGENT_READ_TOOL]: "read",
    [CODE_AGENT_GLOB_TOOL]: "glob",
    [CODE_AGENT_GREP_TOOL]: "grep",
    [CODE_AGENT_EDIT_TOOL]: "edit",
    [CODE_AGENT_WRITE_TOOL]: "write",
  } as const)[name];
}

function unavailableCodeSource(): CodeSourcePort {
  return {
    async capture() {
      return {
        status: "unavailable" as const,
        owner: "helarc.code-workspace" as const,
        code: "test_source_unavailable",
        message: "This composition test does not access source state.",
      };
    },
    async rehydrate() {
      return {
        status: "unavailable" as const,
        owner: "helarc.code-workspace" as const,
        code: "test_source_unavailable",
        message: "This composition test does not access source state.",
      };
    },
  };
}

class UnusedProvider implements Provider {
  readonly descriptor = {
    id: "unused-provider",
    name: "Unused provider",
    capabilities: {
      supportsToolPlanning: true,
      supportsStructuredOutput: true,
      supportsStreaming: false,
      continuation: { supported: false as const },
    },
    requestRetryScheduler: { kind: "harness" as const },
    metadata: {},
  };

  async send(
    _request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    throw new Error("Provider must not be called while composing Helarc product behavior.");
  }
}
