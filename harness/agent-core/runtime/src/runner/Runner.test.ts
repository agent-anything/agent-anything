import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import {
  createInteractionProtocolRegistrySnapshot,
} from "@agent-anything/interaction/coordination";
import {
  snapshotInteractionRequest,
  type InteractionProtocolRef,
} from "@agent-anything/interaction/protocol";
import {
  createOperationBindingResolverSnapshot,
  snapshotResolvedOperationBinding,
  type OperationBindingKind,
} from "@agent-anything/operation-catalog/binding";
import {
  createOperationCatalogSnapshot,
  type OperationRequestOrigin,
} from "@agent-anything/operation-catalog/catalog";
import type {
  OperationBindingResolutionInput,
  ResolvedOperationBinding,
} from "@agent-anything/operation-catalog/binding";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import {
  createOperationResult,
  type OperationResult,
} from "@agent-anything/operation-catalog/result";
import {
  snapshotCompositeDefinition,
} from "@agent-anything/operation-composition/definition";
import {
  createFixedLocalToolSelection,
} from "@agent-anything/tools/selection";
import {
  createToolRegistrationSnapshot,
  type ToolRegistrationInput,
} from "@agent-anything/tools/registration";
import {
  resolvePermissionProfile,
  type ResolvedRunPermissionConfig,
} from "@agent-anything/permission";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import { createCanonicalWorkspaceIdentity } from "@agent-anything/canonical-action/subject";
import { createTestContextProjection } from "@agent-anything/test-support";
import type {
  Controller,
  ControllerCallContext,
  ControllerDecision,
  ControllerInput,
} from "../controller/index.js";
import type { RunConfig } from "./RunConfig.js";
import type {
  InternalOperationHandler,
  RunnerDependencies,
  RunnerOperationComposition,
} from "./RunnerDependencies.js";
import { Runner } from "./Runner.js";

interface TestOutput {
  readonly summary: string;
}

type ControllerStep =
  | ControllerDecision<TestOutput>
  | ((
      input: ControllerInput<TestOutput>,
      context: ControllerCallContext,
    ) => ControllerDecision<TestOutput> | Promise<ControllerDecision<TestOutput>>);

class ScriptedController implements Controller<TestOutput> {
  readonly calls: ControllerInput<TestOutput>[] = [];

  constructor(private readonly steps: ControllerStep[]) {}

  async next(
    input: ControllerInput<TestOutput>,
    context: ControllerCallContext,
  ): Promise<ControllerDecision<TestOutput>> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (step === undefined) throw new Error("ScriptedController has no remaining decision.");
    return typeof step === "function" ? step(input, context) : step;
  }
}

describe("Runner semantic integration", () => {
  it("completes one Run through the single Controller loop", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([complete("Done")]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      startingAgent: { id: "agent_001", revision: "1" },
      finalActiveAgent: { id: "agent_001", revision: "1" },
      status: "succeeded",
      finalOutput: { summary: "Done" },
    });
    expect(result.items.map(({ payload }) => payload.kind)).toEqual([
      "controller_turn",
      "terminal_transition",
    ]);
    expect(result.items.map(({ ref }) => ref.sequence)).toEqual([1, 2]);
    expect(controller.calls).toHaveLength(1);
  });

  it("executes one exposed Tool through its exact internal Operation binding", async () => {
    const operation = operationRef("read-file");
    const handler = internalHandler("handler.read-file", "code-workspace", {
      content: "hello",
    });
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["tool_request"],
        handlerId: handler.id,
      }),
    ], [handler]);
    const tools = createToolSelection(operations, operation, "codeAgent.readFile");
    const controller = new ScriptedController([
      (input) => advance([{
        kind: "operation_request",
        origin: "tool_request",
        tool: {
          name: "codeAgent.readFile",
          revision: "1",
          input: { path: "README.md" },
          origin: "model",
          controllerRequestId: input.toolExposure.controllerRequestId,
        },
        modelItemId: "model_tool_1",
      }], "model_tool_1"),
      complete("Read complete", "model_complete_2"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handler.execute).toHaveBeenCalledTimes(1);
    const observation = observations(result).find(
      ({ payload }) => payload.kind === "operation",
    );
    expect(observation?.payload).toMatchObject({
      kind: "operation",
      result: {
        status: "succeeded",
        semanticOwner: "code-workspace",
        output: { content: "hello" },
      },
      toolResult: {
        status: "succeeded",
        output: { content: "hello" },
      },
    });
    expect(observation?.lowerRefs.map(({ kind }) => kind)).toEqual([
      "operation_result",
      "tool_result",
    ]);
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toHaveLength(1);
  });

  it("maps a workflow Tool Call to a trusted-workflow Operation request", async () => {
    const operation = operationRef("create-file");
    const handler = internalHandler("handler.create-file", "code-workspace", {
      created: true,
    });
    const operations = createOperationFixture([
      operationSpec(operation, "internal", {
        requestOrigins: ["trusted_workflow"],
        handlerId: handler.id,
      }),
    ], [handler]);
    const tools = createToolSelection(
      operations,
      operation,
      "codeAgent.createFile",
      "workflow",
    );
    const controller = new ScriptedController([
      advance([{
        kind: "operation_request",
        origin: "tool_request",
        tool: {
          name: "codeAgent.createFile",
          revision: "1",
          input: { path: "created.txt", content: "" },
          origin: "workflow",
          controllerRequestId: null,
        },
        modelItemId: "workflow_tool_1",
      }], "workflow_tool_1"),
      complete("Create complete", "model_complete_2"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { tools }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "operation",
        result: expect.objectContaining({ status: "succeeded" }),
      }),
    }));
  });

  it("commits Plan state as an ordinary in-loop transition", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([
      advance([{
        kind: "state_transition",
        transition: "plan_update",
        input: {
          explanation: "Inspect before completing.",
          plan: [{ step: "Inspect state", status: "in_progress" }],
        },
        modelItemId: "model_plan_1",
      }], "model_plan_1"),
      (input) => {
        expect(input.plan).toMatchObject({
          version: 1,
          status: "active",
          steps: [{ step: "Inspect state", status: "in_progress" }],
        });
        return complete("Planned", "model_complete_2");
      },
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(result.items.some(({ payload }) =>
      payload.kind === "state_transition" && payload.transition === "plan"
    )).toBe(true);
    expect(observations(result)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ kind: "plan_update" }),
    }));
  });

  it("waits on a blocking generic Interaction and resumes the same Run", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const controller = new ScriptedController([
      advance([interactionCandidate("run")], "model_interaction_1"),
      (input) => {
        expect(input.pending).toEqual([]);
        expect(input.context.observations.at(-1)?.payload).toMatchObject({
          kind: "interaction",
          status: "resolved",
          value: { accepted: true },
        });
        return complete("Interaction resolved", "model_complete_2");
      },
    ]);
    const runner = createRunner(controller, operations, {
      interactions: interaction.registry,
    });
    const handle = runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );
    const pending = await waitForPendingInteraction(handle);

    expect(handle.getSnapshot().status).toBe("waiting");
    expect(handle.submitInteraction({
      request: pending.envelope.request,
      submissionId: "submission_1",
      contentDigest: "sha256:accepted",
      payload: { accepted: true },
      receivedAt: NOW,
    }).status).toBe("accepted_for_resolution");

    const result = await handle.wait();
    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(handle.getSnapshot().pendingInteractions).toEqual([]);
  });

  it("queues a non-blocking Interaction settlement and discards a stale Controller decision", async () => {
    const operations = createOperationFixture([]);
    const interaction = testInteractionProtocol();
    const staleDecision = deferred<ControllerDecision<TestOutput>>();
    const controller = new ScriptedController([
      advance([interactionCandidate("none")], "model_interaction_1"),
      () => staleDecision.promise,
      (input) => {
        expect(input.context.observations.at(-1)?.payload).toMatchObject({
          kind: "interaction",
          status: "resolved",
        });
        return complete("Fresh decision", "model_complete_3");
      },
    ]);
    const handle = createRunner(controller, operations, {
      interactions: interaction.registry,
    }).start(createAgent(), createRunInput(), createRunConfig(operations));
    const pending = await waitForPendingInteraction(handle);
    await waitUntil(() => controller.calls.length === 2);

    handle.submitInteraction({
      request: pending.envelope.request,
      submissionId: "submission_1",
      contentDigest: "sha256:accepted",
      payload: { accepted: true },
      receivedAt: NOW,
    });
    await Promise.resolve();
    staleDecision.resolve(complete("Stale decision", "model_stale_2"));

    const result = await handle.wait();
    expect(result).toMatchObject({
      status: "succeeded",
      finalOutput: { summary: "Fresh decision" },
    });
    expect(controller.calls).toHaveLength(3);
  });

  it("applies a same-Run handoff without replacing Run or Task identity", async () => {
    const operations = createOperationFixture([]);
    const specialist = createAgent("agent_specialist", "2", "Specialist");
    const resolver = {
      async resolve(ref: AgentRevisionRef) {
        return ref.id === specialist.id && ref.revision === specialist.revision
          ? {
              status: "admitted" as const,
              agent: specialist,
              admissionEvidenceRef: "agent-admission-1",
              code: null,
            }
          : {
              status: "unavailable" as const,
              agent: null,
              admissionEvidenceRef: null,
              code: "agent_unavailable",
            };
      },
    };
    const controller = new ScriptedController([
      advance([{
        kind: "state_transition",
        transition: "handoff",
        input: {
          expectedRunRevision: 1,
          currentAgent: { id: "agent_001", revision: "1" },
          targetAgent: { id: specialist.id, revision: specialist.revision },
          reason: "Use specialist instructions.",
          transferPolicy: "all_context",
          admissionEvidenceRef: "agent-admission-1",
        },
        modelItemId: "model_handoff_1",
      }], "model_handoff_1"),
      (input) => {
        expect(input.runId).toBe("run_001");
        expect(input.task.id).toBe("task_001");
        expect(input.agent).toMatchObject({ id: specialist.id, revision: specialist.revision });
        return complete("Specialist complete", "model_complete_2");
      },
    ]);

    const result = await createRunner(controller, operations, { agents: resolver }).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result).toMatchObject({
      runId: "run_001",
      taskId: "task_001",
      startingAgent: { id: "agent_001", revision: "1" },
      finalActiveAgent: { id: "agent_specialist", revision: "2" },
      status: "succeeded",
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        kind: "state_transition",
        transition: "active_agent",
      }),
    }));
  });

  it("executes a descendant Agent as a child Run with explicit result mapping", async () => {
    const delegate = operationRef("delegate-review");
    let operations!: OperationFixture;
    const controller = new ScriptedController([
      advance([operationCandidate(delegate, { topic: "contracts" })], "model_operation"),
      complete("Child complete", "model_child_complete"),
      complete("Parent complete", "model_parent_complete"),
    ]);
    const descendantAgent = createAgent("agent_child", "1", "Child Agent");
    operations = createOperationFixture([
      operationSpec(delegate, "descendant_agent", {
        requestOrigins: ["controller_protocol"],
        agentRef: { id: descendantAgent.id, revision: descendantAgent.revision },
      }),
    ], [], {
      descendants: {
        async prepare({ delegatedInput }) {
          return {
            agent: descendantAgent,
            input: createRunInput("task_child", delegatedInput),
            config: createRunConfig(operations),
            contextManifestRef: "context-manifest-1",
            visibility: "parent_and_host" as const,
            mapResult(result) {
              return result.status === "succeeded"
                ? { status: "succeeded" as const, output: result.finalOutput, failure: null }
                : {
                    status: "failed" as const,
                    output: null,
                    failure: operationFailure("agent-runtime", "descendant_failed"),
                  };
            },
          };
        },
      },
    });

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    const descendant = observations(result).find(({ payload }) =>
      payload.kind === "operation" && payload.result.semanticOwner === "code-agent"
    );
    expect(descendant?.payload).toMatchObject({
      kind: "operation",
      result: {
        status: "succeeded",
        output: { summary: "Child complete" },
        metadata: {
          contextManifestRef: "context-manifest-1",
          visibility: "parent_and_host",
        },
      },
    });
    expect(controller.calls.map(({ runId }) => runId)).toEqual([
      "run_001",
      expect.stringContaining("descendant_relation"),
      "run_001",
    ]);
  });

  it("executes a bounded Composite through trusted child Operation RunActions", async () => {
    const composite = operationRef("inspect-workspace");
    const child = operationRef("read-metadata");
    const childHandler = internalHandler("handler.read-metadata", "code-workspace", {
      files: 3,
    });
    const definition = snapshotCompositeDefinition({
      ref: { id: "composite.inspect-workspace", revision: "1" },
      inputSchemaRevision: "input-1",
      resultSchemaRevision: "result-1",
      graphRevision: "graph-1",
      nodes: [{
        id: "read-metadata",
        operation: child,
        allowedBindings: ["internal"],
        dependencies: [],
        transformId: "identity-transform",
        conditionId: null,
        resourceClaims: [],
        required: true,
      }],
      join: { kind: "all_required_succeeded" },
      reducerId: "collect-results",
      conflictPolicyRevision: "conflict-1",
      limits: { maxNodes: 4, maxParallel: 1 },
      cancellationPolicy: "cancel_unstarted_and_signal_active",
      sensitivity: "internal",
      retiredAt: null,
    });
    const operations = createOperationFixture([
      operationSpec(composite, "composite", {
        requestOrigins: ["controller_protocol"],
        compositeDefinitionRef: "composite.inspect-workspace.v1",
      }),
      operationSpec(child, "internal", {
        requestOrigins: ["trusted_workflow"],
        handlerId: childHandler.id,
      }),
    ], [childHandler], {
      composite: {
        resolve(ref) {
          if (ref !== "composite.inspect-workspace.v1") return null;
          return {
            definition,
            execution: {
              transforms: [{
                id: "identity-transform",
                transform({ compositeInput }) {
                  return compositeInput;
                },
              }],
              conditions: [],
              reducer: {
                id: "collect-results",
                reduce({ children }) {
                  return { childStatuses: children.map(({ status }) => status) };
                },
              },
              conflicts: null,
            },
          };
        },
      },
    });
    const controller = new ScriptedController([
      advance([operationCandidate(composite, { path: "." })], "model_operation"),
      complete("Composite complete", "model_complete_2"),
    ]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("succeeded");
    expect(childHandler.execute).toHaveBeenCalledTimes(1);
    expect(result.items.filter(({ payload }) => payload.kind === "run_action"))
      .toHaveLength(2);
    expect(observations(result).filter(({ payload }) => payload.kind === "operation"))
      .toHaveLength(2);
  });

  it("cancels an active Controller boundary and does not commit its late decision", async () => {
    const operations = createOperationFixture([]);
    const started = deferred<void>();
    const controller = new ScriptedController([
      (_input, context) => new Promise<ControllerDecision<TestOutput>>((resolve) => {
        started.resolve();
        context.cancellation.signal.addEventListener("abort", () => {
          resolve(complete("Too late", "model_late"));
        }, { once: true });
      }),
    ]);
    const handle = createRunner(controller, operations).start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );
    await started.promise;

    expect(handle.cancel({ origin: "user", reasonCode: "user_requested" }).status)
      .toBe("accepted");
    const result = await handle.wait();

    expect(result).toMatchObject({
      status: "cancelled",
      code: "runtime_cancelled",
      cancellation: { origin: "user", reasonCode: "user_requested" },
    });
    expect(result.items.some(({ payload }) =>
      payload.kind === "terminal_transition" && payload.status === "succeeded"
    )).toBe(false);
  });

  it("maps an explicit Controller stop to a blocked Run", async () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([{
      kind: "propose_stop",
      reason: "No safe path remains.",
      modelItems: [modelItem("model_stop_1")],
    }]);

    const result = await createRunner(controller, operations).run(
      createAgent(),
      createRunInput(),
      createRunConfig(operations),
    );

    expect(result).toMatchObject({
      status: "blocked",
      code: "runtime_no_safe_path",
    });
  });

  it("rejects invalid config and incomplete Action composition before creating a Run", () => {
    const operations = createOperationFixture([]);
    const controller = new ScriptedController([complete("unused")]);
    const runner = createRunner(controller, operations);
    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, { limits: { maxIterations: 0 } }),
    )).toThrow("RunLimits.maxIterations must be a positive safe integer");

    expect(() => runner.start(
      createAgent(),
      createRunInput(),
      createRunConfig(operations, {
        actionExecution: {
          policySnapshotId: "policy-1",
          securityContext: {
            workspace: canonicalWorkspace(),
            actor: { identityId: "user_001", kind: "user" },
            environment: canonicalEnvironment(),
          },
          enforcement: "disabled",
          metadata: {},
        },
      }),
    )).toThrow("must be configured together");
  });
});

interface OperationSpec {
  readonly ref: OperationRevisionRef;
  readonly kind: OperationBindingKind;
  readonly requestOrigins: readonly OperationRequestOrigin[];
  readonly handlerId?: string;
  readonly actionAdapterId?: string;
  readonly hostedEndpointRef?: string;
  readonly compositeDefinitionRef?: string;
  readonly agentRef?: AgentRevisionRef;
}

interface OperationFixture extends RunnerOperationComposition {
  readonly specs: readonly OperationSpec[];
}

function operationSpec(
  ref: OperationRevisionRef,
  kind: OperationBindingKind,
  options: Omit<OperationSpec, "ref" | "kind">,
): OperationSpec {
  return { ref, kind, ...options };
}

function createOperationFixture(
  specs: readonly OperationSpec[],
  internalHandlers: readonly InternalOperationHandler[] = [],
  extensions: Partial<Pick<RunnerOperationComposition, "composite" | "descendants" | "actionExecution">> = {},
): OperationFixture {
  const catalog = createOperationCatalogSnapshot({
    id: "operation-catalog-1",
    revision: "1",
    entries: specs.map((spec) => ({
      admissionId: `operation-admission-${spec.ref.operation.name}`,
      operation: {
        ref: spec.ref,
        semanticOwner: spec.kind === "descendant_agent" ? "code-agent" : "code-workspace",
        requestSchemaRevision: "request-1",
        resultSchemaRevision: "result-1",
        roles: {
          requestOrigins: spec.requestOrigins,
          exposure: spec.requestOrigins.includes("tool_request") ? "eager_tool" : "non_tool",
          runControl: spec.kind,
          trust: spec.kind === "direct" || spec.kind === "hosted"
            ? "canonical_external_effect"
            : "effect_free",
          participation: spec.kind === "composite"
            ? "composite_coordinator"
            : spec.kind === "descendant_agent"
              ? "descendant_adapter"
              : "semantic_owner",
          domainPurpose: `test.${spec.ref.operation.name}`,
        },
      },
      binding: {
        ref: { operation: spec.ref, revision: "binding-1" },
        kind: spec.kind,
        resolverId: `resolver.${spec.ref.operation.name}`,
        resolverRevision: "1",
      },
      sourceRevision: "source-1",
      allowedRequestOrigins: spec.requestOrigins,
      admittedAt: NOW,
      retirement: null,
    })),
  });
  const bindings = createOperationBindingResolverSnapshot(
    "bindings-1",
    specs.map((spec) => ({
      resolver: {
        id: `resolver.${spec.ref.operation.name}`,
        revision: "1",
        async resolve(input: OperationBindingResolutionInput<unknown, unknown>) {
          return {
            status: "resolved" as const,
            binding: snapshotResolvedOperationBinding(
              resolvedBinding(spec, input),
              snapshotUnknown,
            ),
          };
        },
      },
    })),
  );
  return Object.freeze({
    specs: Object.freeze([...specs]),
    catalog,
    bindings,
    validateToolInput: () => true,
    internalHandlers: Object.freeze([...internalHandlers]),
    ...extensions,
  });
}

function resolvedBinding(
  spec: OperationSpec,
  input: OperationBindingResolutionInput<unknown, unknown>,
): ResolvedOperationBinding {
  const base = {
    invocation: input.context.invocation,
    correlation: input.context.correlation,
    parentInvocation: input.context.parentInvocation,
    binding: input.registration.binding.ref,
    request: input.request,
    resolverRevision: "1",
    resolutionFingerprint: `resolution-${spec.ref.operation.name}`,
  };
  switch (spec.kind) {
    case "internal":
      return { ...base, kind: "internal", handlerId: spec.handlerId! };
    case "direct":
      return { ...base, kind: "direct", actionAdapterId: spec.actionAdapterId! };
    case "hosted":
      return {
        ...base,
        kind: "hosted",
        actionAdapterId: spec.actionAdapterId!,
        hostedEndpointRef: spec.hostedEndpointRef!,
      };
    case "composite":
      return {
        ...base,
        kind: "composite",
        compositeDefinitionRef: spec.compositeDefinitionRef!,
      };
    case "descendant_agent":
      return { ...base, kind: "descendant_agent", agentRef: spec.agentRef! };
  }
}

function internalHandler(
  id: string,
  semanticOwner: string,
  output: unknown,
): InternalOperationHandler & { readonly execute: ReturnType<typeof vi.fn> } {
  return {
    id,
    execute: vi.fn(async (context) => createOperationResult({
      ref: {
        invocation: context.binding.invocation,
        id: `${context.binding.invocation.id}:result`,
      },
      binding: context.binding.binding,
      semanticOwner,
      status: "succeeded",
      output,
      failure: null,
      startedAt: NOW,
      finishedAt: NOW,
      lowerRefs: [],
      metadata: {},
    })),
  };
}

function createToolSelection(
  operations: OperationFixture,
  operation: OperationRevisionRef,
  name: string,
  origin: "model" | "workflow" = "model",
) {
  const keyName = operation.operation.name;
  const registration: ToolRegistrationInput = {
    admissionId: `tool-admission-${keyName}`,
    descriptor: {
      ref: { tool: { namespace: "code-agent", name: keyName }, revision: "1" },
      name,
      description: `Test Tool ${name}.`,
      inputSchema: { type: "object" },
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "input-1",
        output: null,
        translation: "native-1",
      },
      source: {
        kind: "product",
        sourceId: "helarc-code-agent",
        sourceRevision: "1",
        activationEpoch: null,
      },
      operationBinding: { operation, revision: "binding-1" },
    },
    allowedOrigins: [origin],
    admittedAt: NOW,
  };
  const registrations = createToolRegistrationSnapshot(operations.catalog, [registration]);
  return createFixedLocalToolSelection(registrations, operations.catalog, [{
    tool: registration.descriptor.ref,
    origins: [origin],
  }]);
}

function emptyToolSelection(operations: OperationFixture) {
  const registrations = createToolRegistrationSnapshot(operations.catalog, []);
  return createFixedLocalToolSelection(registrations, operations.catalog, []);
}

function createRunner(
  controller: Controller<TestOutput>,
  operations: OperationFixture,
  overrides: Partial<RunnerDependencies> = {},
): Runner {
  let runSequence = 0;
  return new Runner({
    controller,
    contextProjection: createTestContextProjection(),
    operations,
    interactions: createInteractionProtocolRegistrySnapshot("interaction-registry-1", []),
    now: () => NOW,
    createRunId: () => `run_${String(++runSequence).padStart(3, "0")}`,
    ...overrides,
  });
}

function createAgent(
  id = "agent_001",
  revision = "1",
  name = "Test Agent",
): Agent<TestOutput> {
  return {
    id,
    revision,
    name,
    instructions: "Complete the task.",
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
        return { valid: false, message: "Output requires a summary." };
      },
    },
    metadata: {},
  };
}

function createRunInput(
  taskId = "task_001",
  taskInput: unknown = {},
): RunInput {
  return {
    task: {
      id: taskId,
      kind: "test.runner",
      input: taskInput,
      createdAt: NOW,
      metadata: {},
    },
    items: [{
      id: `${taskId}:message`,
      kind: "message",
      role: "user",
      content: "Complete the task.",
      createdAt: NOW,
      metadata: {},
    }],
    metadata: {},
  };
}

function createRunConfig(
  operations: OperationFixture,
  overrides: {
    readonly tools?: RunConfig["tools"];
    readonly actionExecution?: RunConfig["actionExecution"];
    readonly limits?: Partial<Omit<RunConfig["limits"], "plan">>;
    readonly descendantDepth?: number;
  } = {},
): RunConfig {
  return {
    workspace: {
      primary: {
        id: "workspace_001",
        name: "Test workspace",
        rootRef: "workspace://root",
        trustState: "trusted",
        source: "test",
        policyRefs: [],
        metadata: {},
      },
      additional: [],
    },
    identity: {
      id: "user_001",
      kind: "user",
      displayName: "Test User",
      metadata: {},
    },
    permissions: createTestPermissionConfig(),
    tools: overrides.tools ?? emptyToolSelection(operations),
    actionExecution: overrides.actionExecution ?? null,
    limits: {
      maxIterations: 12,
      maxActions: 24,
      maxConsecutiveActionFailures: 4,
      maxDurationMs: 10_000,
      maxPendingInteractions: 4,
      maxDescendantRuns: 4,
      maxDescendantDepth: 2,
      plan: {
        maxSteps: 8,
        maxStepLength: 200,
        maxExplanationLength: 500,
      },
      ...overrides.limits,
    },
    audit: "optional",
    telemetry: "optional",
    cancellationLimits: {
      operationSettlementTimeoutMs: 1_000,
      processGracePeriodMs: 100,
      processForceKillTimeoutMs: 500,
      finalizationTimeoutMs: 1_000,
    },
    retry: {
      providerRequest: disabledRetryPolicy(),
      structuredOutput: disabledRetryPolicy(),
      action: { maxAttempts: 1 },
    },
    metadata: {},
    ...(overrides.descendantDepth === undefined
      ? {}
      : { descendantDepth: overrides.descendantDepth }),
  };
}

function disabledRetryPolicy() {
  return {
    maxRetries: 0,
    delay: {
      kind: "exponential_jitter" as const,
      baseDelayMs: 0,
      maxDelayMs: 0,
      multiplier: 2,
      jitterRatio: 0.1,
    },
    retryableCategories: [] as string[],
    serverDelay: { mode: "ignore" as const },
  };
}

function createTestPermissionConfig(): ResolvedRunPermissionConfig {
  const managedConstraints: ManagedPermissionConstraints = {
    constraintSetId: "test-managed",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: true,
  };
  return {
    permissionProfile: resolvePermissionProfile({
      profileId: ":read-only",
      profiles: [],
      environment: {
        environmentId: "test-local",
        platform: "win32",
        workspaceRoots: [{ rootId: "workspace_001", path: "D:/workspace" }],
      },
      managedConstraints,
    }),
    approvalPolicy: "never",
    reviewer: null,
    rules: [],
    networkRules: [],
    managedConstraints,
    sessionAuthority: null,
    persistentPolicyAmendments: null,
    approvalLimits: {
      maxRequestsPerRun: 8,
      maxRequestsPerActionFingerprint: 2,
      maxConsecutiveDeclines: 3,
      maxConsecutiveReviewFailures: 3,
    },
    authorityApplicationLimits: { commitTimeoutMs: 1_000 },
  };
}

function complete(summary: string, id = "model_complete_1"): ControllerDecision<TestOutput> {
  return {
    kind: "propose_completion",
    output: { summary },
    modelItems: [modelItem(id, { summary })],
  };
}

function advance(
  candidates: Extract<ControllerDecision<TestOutput>, { readonly kind: "advance" }>["candidates"],
  modelItemId: string,
): ControllerDecision<TestOutput> {
  return {
    kind: "advance",
    candidates,
    modelItems: [modelItem(modelItemId)],
  };
}

function operationCandidate(operation: OperationRevisionRef, request: unknown) {
  return {
    kind: "operation_request" as const,
    origin: "controller_protocol" as const,
    operation,
    request,
    modelItemId: "model_operation",
  };
}

function modelItem(id: string, content: unknown = {}) {
  return {
    id,
    kind: "assistant_message",
    content,
    metadata: {},
  };
}

function operationRef(name: string): OperationRevisionRef {
  return { operation: { namespace: "test", name }, revision: "1" };
}

function testInteractionProtocol() {
  const ref: InteractionProtocolRef<"confirmation"> = Object.freeze({
    owner: "test-owner",
    kind: "confirmation",
    revision: "1",
  });
  const protocol = {
    ref,
    createRequest(input: any) {
      return snapshotInteractionRequest({
        ref: {
          id: input.requestId,
          protocol: ref,
          requestVersion: input.requestVersion,
          subject: input.subjectRef,
        },
        subject: input.subject,
        correlation: input.correlation,
        parentRunAction: input.parentRunAction,
        presentation: input.presentation,
        expiresAt: input.expiresAt,
        createdAt: input.createdAt,
      }, snapshotUnknown, snapshotUnknown);
    },
    validateSubmission(_request: unknown, candidate: unknown) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("accepted" in candidate) ||
        typeof candidate.accepted !== "boolean"
      ) throw new TypeError("Interaction submission requires accepted.");
      return Object.freeze({ accepted: candidate.accepted });
    },
    resolve({ submission }: any) {
      return submission;
    },
    apply({ resolution }: any) {
      return Object.freeze({ accepted: resolution.accepted });
    },
  };
  return {
    ref,
    registry: createInteractionProtocolRegistrySnapshot("test-interactions-1", [{
      ref,
      protocol,
    }]),
  };
}

function interactionCandidate(blockingScope: "none" | "branch" | "run") {
  return {
    kind: "interaction_request" as const,
    protocol: {
      owner: "test-owner",
      kind: "confirmation",
      revision: "1",
    },
    subject: { question: "Continue?" },
    subjectRef: {
      owner: "test-owner",
      kind: "confirmation-subject",
      id: "subject-1",
      revision: "1",
    },
    presentation: { title: "Continue" },
    requestVersion: 1,
    expiresAt: null,
    blockingScope,
    modelItemId: "model_interaction_1",
  };
}

async function waitForPendingInteraction(handle: ReturnType<Runner["start"]>) {
  await waitUntil(() => handle.getSnapshot().pendingInteractions.length === 1);
  return handle.getSnapshot().pendingInteractions[0]!;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test state.");
}

function observations(result: Awaited<ReturnType<Runner["run"]>>) {
  return result.items.flatMap(({ payload }) =>
    payload.kind === "observation" ? [payload.observation] : []
  );
}

function operationFailure(owner: string, code: string) {
  return {
    owner,
    code,
    message: code,
    retryable: false,
    metadata: {},
  };
}

function snapshotUnknown<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function canonicalWorkspace() {
  return createCanonicalWorkspaceIdentity({
    workspaceId: "workspace_001",
    trustState: "trusted" as const,
    roots: [{
      rootId: "workspace_001",
      platform: "win32" as const,
      path: "D:/workspace",
      resolvedPath: "D:/workspace",
      resolutionFingerprint: SHA_A,
    }],
  });
}

function canonicalEnvironment() {
  return {
    environmentId: "test-local",
    platform: "win32" as const,
    configurationFingerprint: SHA_B,
  };
}

const NOW = "2026-08-13T00:00:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
