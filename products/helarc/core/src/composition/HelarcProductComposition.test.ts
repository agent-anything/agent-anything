import type {
  Provider,
  ProviderCallResult,
  ProviderRequest,
} from "@agent-anything/model-interaction";
import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import { createUtf8ModelInputAccounting } from "@agent-anything/model-interaction/input";
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
import {
  createStaticAvailableToolBindingAssessment,
  createToolExposureProof,
  resolveCurrentTurnToolExposure,
} from "@agent-anything/tools/selection";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "@agent-anything/observability/events";
import { describe, expect, it } from "vitest";
import { createHelarcTask } from "../task/index.js";
import { createHelarcProviderProfile } from "../configuration/index.js";
import {
  createHelarcProductComposition as createProductComposition,
  type CreateHelarcProductCompositionInput,
} from "./HelarcProductComposition.js";
import { createHelarcBaselineToolGuidance } from "../tools/guidance/index.js";
import {
  HELARC_SHELL_BINDING,
  HELARC_SHELL_OPERATION,
  HELARC_TASK_STOP_BINDING,
  HELARC_TASK_STOP_OPERATION,
} from "../tools/HelarcCommandOperation.js";
import {
  createHelarcModelQualificationCatalog,
  createHelarcModelQualificationDecision,
} from "../model-qualification/index.js";

async function createHelarcProductComposition(
  input: Omit<CreateHelarcProductCompositionInput, "providerProfile"> & {
    readonly providerProfile?: CreateHelarcProductCompositionInput["providerProfile"];
  },
) {
  const profile = input.providerProfile ?? createTestProviderProfile(input.provider);
  return createProductComposition({ ...input, providerProfile: profile });
}

function createTestProviderProfile(
  provider: Provider,
  qualificationPolicy: "require_qualified" | "allow_experimental" = "allow_experimental",
): CreateHelarcProductCompositionInput["providerProfile"] {
  const result = createHelarcProviderProfile({
    id: "test-provider",
    displayName: "Test Provider",
    baseUrl: "https://provider.local/v1",
    model: provider.inputAccounting.model,
    timeoutMs: 30_000,
    credentialStatus: "empty_allowed",
    qualificationPolicy,
    isActive: true,
  });
  if (!result.ok) throw new TypeError("Test Provider profile is invalid.");
  return result.profile;
}

describe("HelarcProductComposition", () => {
  it("fails closed before Run composition when exact qualification is absent", async () => {
    const provider = new UnusedProvider();

    await expect(createProductComposition({
      runId: "strict-run",
      ...createTask("D:/workspace"),
      provider,
      providerProfile: createTestProviderProfile(provider, "require_qualified"),
      ...createLocalContributions(),
      now: fixedNow,
    })).rejects.toMatchObject({
      code: "model_qualification_required",
      qualification: {
        status: "blocked",
        policy: "require_qualified",
      },
    });
  });

  it("admits explicit experimental use without granting execution authority", async () => {
    const composition = await createHelarcProductComposition({
      runId: "experimental-run",
      ...createTask("D:/workspace"),
      provider: new UnusedProvider(),
      ...createLocalContributions(),
      now: fixedNow,
    });

    expect(composition.qualification.safeProjection).toMatchObject({
      status: "experimental",
      policy: "allow_experimental",
      experimentalUseSelected: true,
    });
    expect(composition.qualification.requiredScopes).toEqual([
      "agent_loop",
      "workspace_observation",
      "workspace_mutation",
      "process_execution",
      "user_interaction",
      "delegation",
    ]);
    expect(composition.qualification.disposition).not.toHaveProperty("permission");
    expect(composition.qualification.disposition).not.toHaveProperty("execute");
    expect(composition.actions.toolSelection).toBeDefined();
  });

  it("blocks a Provider without native Tool interaction before policy admission", async () => {
    const provider = new UnusedProvider(false);

    await expect(createProductComposition({
      runId: "unsupported-run",
      ...createTask("D:/workspace"),
      provider,
      providerProfile: createTestProviderProfile(provider, "allow_experimental"),
      ...createLocalContributions(),
      now: fixedNow,
    })).rejects.toMatchObject({
      code: "model_native_tool_interaction_unsupported",
      qualification: {
        status: "blocked",
        policy: "allow_experimental",
      },
    });
  });

  it("admits exact qualified evidence and blocks a current not-qualified scope", async () => {
    const provider = new UnusedProvider();
    const seed = await createHelarcProductComposition({
      runId: "qualification-seed",
      ...createTask("D:/workspace"),
      provider,
      ...createLocalContributions(),
      now: fixedNow,
    });
    const qualifiedCatalog = qualificationCatalog(seed, () => "qualified");
    const qualified = await createProductComposition({
      runId: "qualified-run",
      ...createTask("D:/workspace"),
      provider,
      providerProfile: createTestProviderProfile(provider, "require_qualified"),
      qualificationCatalog: qualifiedCatalog,
      ...createLocalContributions(),
      now: fixedNow,
    });

    expect(qualified.qualification.target.id).toBe(seed.qualification.target.id);
    expect(qualified.qualification.safeProjection.status).toBe("qualified");

    const notQualifiedCatalog = qualificationCatalog(seed, (scope) =>
      scope === "workspace_mutation" ? "not_qualified" : "qualified"
    );
    await expect(createProductComposition({
      runId: "not-qualified-run",
      ...createTask("D:/workspace"),
      provider,
      providerProfile: createTestProviderProfile(provider, "allow_experimental"),
      qualificationCatalog: notQualifiedCatalog,
      ...createLocalContributions(),
      now: fixedNow,
    })).rejects.toMatchObject({
      code: "model_qualification_not_qualified",
      qualification: { status: "blocked" },
    });
  });

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
    expect(composition.delegatedAgent).toMatchObject({
      id: "helarc-delegated-worker",
      name: "Helarc Delegated Worker",
    });
    expect(composition.delegatedAgent.revision).not.toBe(composition.agent.revision);
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

    const assessments = composition.actions.toolSelection.tools
      .filter((selected) => selected.origins.includes("model"))
      .map((selected) => createStaticAvailableToolBindingAssessment(
        composition.actions.toolSelection,
        selected.registration.descriptor.ref,
      ));
    const exposure = createToolExposureProof(resolveCurrentTurnToolExposure(
      composition.actions.toolSelection,
      {
        basisRefs: assessments.flatMap((assessment) => assessment.basisRefs),
        assessments,
      },
    ), "controller-request-1");
    expect(exposure.catalog.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "Edit", "Glob", "Grep", "Read", "Write", "PowerShell", "TaskStop",
      "AskUserQuestion", "Agent", "SendMessage",
    ]));
    expect(exposure.catalog.tools.find(({ name }) => name === "AskUserQuestion")?.binding.kind)
      .toBe("interaction");
    expect(exposure.catalog.tools.find(({ name }) => name === "Agent")?.binding.kind)
      .toBe("descendant_agent");
    expect(exposure.catalog.tools.find(({ name }) => name === "SendMessage")?.binding.kind)
      .toBe("descendant_message");
    expect(composition.interactions.protocols).toContainEqual({
      owner: "helarc",
      kind: "clarification",
      revision: "1",
    });
    expect(composition.actions.registrations.registrations.map(({ operation }) => operation.operation.name))
      .toEqual(expect.arrayContaining(["edit", "glob", "grep", "read", "write", "shell-execute", "task-stop"]));
    const selectedRegistrations = composition.actions.toolSelection.tools.map(
      ({ registration }) => registration,
    );
    const baselineGuidance = createHelarcBaselineToolGuidance(selectedRegistrations);
    expect(baselineGuidance.release.tools).toHaveLength(11);
    expect(baselineGuidance.release.sources).toHaveLength(11);
    expect(composition.controllerProtocol.toolGuidance.entries).toHaveLength(10);
    expect(composition.controllerProtocol.toolGuidance.entries.map(({ name }) => name))
      .toEqual(expect.arrayContaining([
        "Edit", "Glob", "Grep", "Read", "Write", "PowerShell", "TaskStop",
        "AskUserQuestion", "Agent", "SendMessage",
      ]));
    expect(composition.runMetadata).toMatchObject({
      controllerProtocolRevision: composition.controllerProtocol.revision,
      toolGuidanceReleaseId: baselineGuidance.release.ref.id,
      toolGuidanceProfileRevision: baselineGuidance.release.guidanceProfileRevision,
      controllerControlGuidanceRevision:
        composition.controllerProtocol.controlGuidance.revision,
    });
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
      startingInstructionBinding: testInstructionBinding("run-1"),
      finalInstructionBinding: testInstructionBinding("run-1"),
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:00:01.000Z",
      metadata: { rawProvider: secret },
    }, "controller_failed", {
      kind: "provider",
      failure: {
        category: "transport",
        code: "provider_request_failed",
        message: `Provider failed with ${secret}.`,
        metadata: {
          apiKey: secret,
          providerErrorCode: "provider_response_empty",
        },
      },
    }), "disabled", null);

    expect(result.output.safeErrors).toEqual([
      {
        code: "provider_response_empty",
        message: "The model returned no usable response.",
      },
      {
        code: "provider_request_failed",
        message: "The model request could not be completed.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("rawProvider");
    expect(JSON.stringify(result)).not.toContain("apiKey");
  });

  it("orders root and descendant activity independently from Run-local Event sequence", async () => {
    const composition = await createHelarcProductComposition({
      runId: "run-1",
      ...createTask("D:/workspace"),
      provider: new UnusedProvider(),
      ...createLocalContributions(),
    });

    composition.recordRuntimeEvent(runtimeEvent("root-event-1", "run-1", {
      kind: "root",
      root: { id: "run-1" },
      depth: 0,
    }));
    composition.recordRuntimeEvent(runtimeEvent("child-event-1", "run-2", {
      kind: "descendant",
      root: { id: "run-1" },
      parent: { id: "run-1" },
      parentRunAction: { run: { id: "run-1" }, id: "action-1", sequence: 1 },
      relation: { id: "relation-1" },
      depth: 1,
    }));

    const activity = composition.getProductProjection().activity;
    expect(activity.map((item) => item.sequence)).toEqual([1, 2]);
    expect(activity.map((item) => item.source.eventSequence)).toEqual([1, 1]);
    expect(activity[1]?.source).toMatchObject({
      runId: "run-2",
      lineage: {
        kind: "descendant",
        root: { id: "run-1" },
        parent: { id: "run-1" },
        relation: { id: "relation-1" },
        depth: 1,
      },
    });
    expect(Object.isFrozen(activity[1]?.source.lineage)).toBe(true);

    expect(() => composition.recordRuntimeEvent(runtimeEvent("other-root-event", "run-other", {
      kind: "root",
      root: { id: "run-other" },
      depth: 0,
    }))).toThrow("cannot combine different Run Tree roots");
    expect(composition.getProductProjection().activity).toHaveLength(2);
  });

  it("requires the first Product activity Event to establish root lineage", async () => {
    const composition = await createHelarcProductComposition({
      runId: "run-1",
      ...createTask("D:/workspace"),
      provider: new UnusedProvider(),
      ...createLocalContributions(),
    });

    expect(() => composition.recordRuntimeEvent(runtimeEvent("child-event-1", "run-2", {
      kind: "descendant",
      root: { id: "run-1" },
      parent: { id: "run-1" },
      parentRunAction: { run: { id: "run-1" }, id: "action-1", sequence: 1 },
      relation: { id: "relation-1" },
      depth: 1,
    }))).toThrow("must establish root Run lineage");
    expect(composition.getProductProjection().activity).toEqual([]);
  });
});

function testInstructionBinding(runId: string) {
  return Object.freeze({
    id: `${runId}:agent-instruction-binding:0`,
    revision: `sha256:${"0".repeat(64)}`,
  });
}

function runtimeEvent(
  id: string,
  runId: string,
  lineage: RuntimeEvent["lineage"],
): RuntimeEvent<"run.started"> {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    id,
    runId,
    taskId: `${runId}-task`,
    lineage,
    sequence: 1,
    name: "run.started",
    occurredAt: "2026-07-17T00:00:00.000Z",
    payload: { status: "running", activeAgentId: "helarc-code-agent" },
  };
}

function createTask(workspaceRoot: string) {
  const result = createHelarcTask({
    taskId: "helarc-composition-test-task",
    prompt: "Inspect the workspace.",
  });
  if (!result.ok) throw new Error(result.error.message);
  return {
    instructionTarget: "production" as const,
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
      taskStopBinding: HELARC_TASK_STOP_BINDING,
      taskAvailability: {
        getRunAvailability() {
          return { revision: 0, activeTaskCount: 0 };
        },
      },
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
  readonly inputAccounting = createUtf8ModelInputAccounting({
    providerId: "unused-provider",
    model: "unused-model",
    maximumInputBytes: 4 * 1_024 * 1_024,
    limitSource: "host_configured",
    estimator: { id: "unused-provider.utf8-content", revision: "1" },
    framing: { id: "unused-provider.test-framing", revision: "1" },
    renderRequest(messages, interaction) {
      return JSON.stringify({
        messages,
        interaction,
      });
    },
  });

  readonly descriptor: Provider["descriptor"];

  constructor(nativeToolInteractionSupported = true) {
    this.descriptor = {
      id: "unused-provider",
      name: "Unused provider",
      capabilities: {
        nativeToolInteraction: nativeToolInteractionSupported
          ? { supported: true as const }
          : { supported: false as const },
        structuredGeneration: { supported: true as const },
        streaming: { supported: false as const },
        modelInput: this.inputAccounting.capability,
        continuation: { supported: false as const },
        compaction: { supported: false as const },
      },
      requestRetryScheduler: { kind: "harness" as const },
      metadata: {},
    };
  }

  async send(
    _request: ProviderRequest,
    _context: InvocationInterruptionContext,
  ): Promise<ProviderCallResult> {
    throw new Error("Provider must not be called while composing Helarc product behavior.");
  }
}

function fixedNow(): string {
  return "2026-08-28T00:00:00.000Z";
}

function qualificationCatalog(
  composition: Awaited<ReturnType<typeof createHelarcProductComposition>>,
  outcomeFor: (
    scope: typeof composition.qualification.requiredScopes[number],
  ) => "qualified" | "not_qualified" | "inconclusive",
) {
  return createHelarcModelQualificationCatalog({
    decisions: composition.qualification.requiredScopes.map((scope) =>
      createHelarcModelQualificationDecision({
        id: `decision-${scope}`,
        target: composition.qualification.target,
        scope,
        outcome: outcomeFor(scope),
        evidenceRefs: [{
          owner: "helarc.manual-qualification",
          kind: "bounded-exercise",
          id: `evidence-${scope}`,
          revision: "1",
        }],
        limitations: ["Exact target and scope only."],
        decidedAt: fixedNow(),
        decidedBy: "helarc-reviewer",
      })
    ),
  });
}
