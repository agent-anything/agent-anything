import type { OperationBindingKind } from "@agent-anything/operation-catalog/binding";

export type Phase27CatalogRecordId = `P24-CAP-${string}`;
export type Phase27RealizationPhase =
  | "Phase26"
  | "Phase27"
  | "Phase28"
  | "Phase29"
  | "Phase30"
  | "Phase31"
  | "Phase32"
  | "Phase33";
export type Phase23ScenarioId = `P23-S-${string}`;
export type Phase27EffectFamily =
  | "effect_free"
  | "file_system.read"
  | "file_system.write"
  | "process.spawn"
  | "network.connect"
  | "remote_tool.invoke"
  | "child_owned";

export interface Phase27RegisteredDisposition {
  readonly status: "registered";
  readonly registrationRefs: readonly string[];
  readonly resolverRefs: readonly string[];
}

export interface Phase27UnavailableDisposition {
  readonly status: "unavailable";
  readonly intendedOwner: string;
  readonly assignedPhase: Phase27RealizationPhase;
  readonly reasonCode: string;
}

export type Phase27CatalogDisposition =
  | Phase27RegisteredDisposition
  | Phase27UnavailableDisposition;

export interface Phase27CatalogRealizationRecord {
  readonly recordId: Phase27CatalogRecordId;
  readonly semanticOwner: string;
  readonly intendedOperationRevision: string;
  readonly bindingFamily: OperationBindingKind;
  readonly requiredEffectFamily: Phase27EffectFamily;
  readonly assignedRealizationPhase: Phase27RealizationPhase;
  readonly scenarioIds: readonly Phase23ScenarioId[];
  readonly routeEvidence: readonly string[];
  readonly disposition: Phase27CatalogDisposition;
}

export interface Phase27BindingConformanceRecord {
  readonly bindingFamily: OperationBindingKind;
  readonly parentActionCount: 0 | 1;
  readonly childActionCardinality: "none" | "bounded";
  readonly childRunCardinality: "none" | "one";
  readonly evidence: readonly string[];
}

export interface Phase27ScenarioConformanceRecord {
  readonly scenarioId: Phase23ScenarioId;
  readonly title: string;
  readonly catalogRecordIds: readonly Phase27CatalogRecordId[];
  readonly evidence: readonly string[];
}

type RecordInput = Omit<Phase27CatalogRealizationRecord, "disposition">;

const runnerEvidence = [
  "harness/agent-core/runtime/src/runner/Runner.test.ts",
] as const;
const actionEvidence = [
  "harness/safety/action-execution/src/enforcement/ActionExecutionCoordinator.test.ts",
] as const;
const interactionEvidence = [
  "harness/interaction/src/InteractionContracts.test.ts",
  "harness/interaction/src/coordination/InteractionExecution.test.ts",
] as const;
const compositeEvidence = [
  "harness/operation-composition/src/execution/CompositeExecution.test.ts",
  ...runnerEvidence,
] as const;
const evaluationEvidence = [
  "tooling/test-support/src/evaluation-targets/helarc/HelarcEvaluationTarget.test.ts",
  "tooling/test-support/src/evaluation-targets/helarc/HelarcEvaluationRegression.test.ts",
] as const;
const validationEvidence = [
  "harness/validation/src/execution/ValidationExecution.test.ts",
  "harness/validation/src/completion/CurrentValidationCompletionGate.test.ts",
  "harness/agent-core/runtime/src/runner/Runner.test.ts",
  "products/helarc/core/src/validation/HelarcValidationComposition.test.ts",
] as const;

export const PHASE27_CATALOG_REALIZATION_REGISTRY = deepFreeze([
  registered(record("P24-CAP-D001", "helarc.code-workspace", "code.workspace.list@1", "direct", "file_system.read", "Phase27", ["P23-S-001", "P23-S-007"], ["products/helarc/desktop/src/main/run/HelarcHostRunComposition.test.ts"]), ["helarc.code-agent/glob@2"], ["helarc.code-agent.file.direct@2"]),
  registered(record("P24-CAP-D002", "helarc.code-workspace", "code.workspace.read_file@1", "direct", "file_system.read", "Phase27", ["P23-S-001", "P23-S-002", "P23-S-011"], ["products/helarc/desktop/src/main/run/HelarcHostRunComposition.test.ts"]), ["helarc.code-agent/read@2"], ["helarc.code-agent.file.direct@2"]),
  registered(record("P24-CAP-D003", "helarc.code-workspace", "code.workspace.search_text@1", "direct", "file_system.read", "Phase27", ["P23-S-001", "P23-S-007"], ["products/helarc/desktop/src/main/run/HelarcHostRunComposition.test.ts"]), ["helarc.code-agent/grep@2"], ["helarc.code-agent.file.direct@2"]),
  registered(record("P24-CAP-D004", "helarc.code-workspace", "code.workspace.change_file@1", "direct", "file_system.write", "Phase27", ["P23-S-002", "P23-S-003", "P23-S-008", "P23-S-009"], ["products/helarc/desktop/src/main/run/HelarcHostRunComposition.test.ts", ...actionEvidence]), ["helarc.code-agent/edit@2", "helarc.code-agent/write@2"], ["helarc.code-agent.file.direct@2"]),
  registered(record("P24-CAP-D005", "helarc", "code.process.run@1", "direct", "process.spawn", "Phase27", ["P23-S-004", "P23-S-005", "P23-S-009"], ["products/helarc/local-environment/src/command/LocalCommandActionCapability.test.ts", "products/helarc/local-environment/src/command/ProcessExecutor.test.ts"]), ["helarc/run-command@1"], ["helarc.run-command.direct@1"]),
  unavailable(record("P24-CAP-D006", "requesting-semantic-owner", "code.network.request@1", "direct", "network.connect", "Phase33", ["P23-S-005", "P23-S-009"], actionEvidence), "network_operation_not_composed"),
  unavailable(record("P24-CAP-D007", "tool-owner", "code.remote.invoke_tool@1", "hosted", "remote_tool.invoke", "Phase33", ["P23-S-001", "P23-S-009"], ["harness/integrations/remote/src/operation/RemoteOperationContribution.test.ts", "harness/integrations/mcp/src/adapters/McpOperationContribution.test.ts"]), "remote_operation_not_composed"),
  unavailable(record("P24-CAP-D008", "helarc.code-workspace", "code.repository.inspect@1", "direct", "process.spawn", "Phase33", ["P23-S-001", "P23-S-008", "P23-S-011"], actionEvidence), "repository_inspection_not_composed"),
  unavailable(record("P24-CAP-D009", "helarc.code-workspace", "code.repository.change@1", "direct", "process.spawn", "Phase33", ["P23-S-003", "P23-S-005", "P23-S-009"], actionEvidence), "repository_change_not_composed"),
  unavailable(record("P24-CAP-D010", "helarc", "code.package.change@1", "direct", "process.spawn", "Phase33", ["P23-S-005", "P23-S-009"], actionEvidence), "package_change_not_composed"),
  unavailable(record("P24-CAP-D011", "host", "code.computer.observe@1", "direct", "effect_free", "Phase33", ["P23-S-001", "P23-S-009"], actionEvidence), "computer_observation_not_composed"),
  unavailable(record("P24-CAP-D012", "host", "code.computer.input@1", "direct", "child_owned", "Phase33", ["P23-S-002", "P23-S-009"], actionEvidence), "computer_input_not_composed"),
  unavailable(record("P24-CAP-D013", "helarc", "code.program.run_generated@1", "direct", "process.spawn", "Phase33", ["P23-S-003", "P23-S-005", "P23-S-009"], actionEvidence), "generated_program_not_composed"),

  unavailable(record("P24-CAP-C001", "operation-composition", "code.change.apply_set@1", "composite", "child_owned", "Phase27", ["P23-S-003", "P23-S-005", "P23-S-008", "P23-S-009"], compositeEvidence), "multi_resource_operation_not_composed"),
  unavailable(record("P24-CAP-C002", "operation-composition", "code.workflow.execute_admitted@1", "composite", "child_owned", "Phase27", ["P23-S-003", "P23-S-004", "P23-S-005"], compositeEvidence), "workflow_operation_not_composed"),
  unavailable(record("P24-CAP-C003", "operation-composition", "code.program.run_tool_workflow@1", "composite", "child_owned", "Phase33", ["P23-S-003", "P23-S-005"], compositeEvidence), "generated_tool_workflow_not_composed"),
  unavailable(record("P24-CAP-C004", "operation-composition", "code.investigation.collect_parallel@1", "composite", "child_owned", "Phase27", ["P23-S-001", "P23-S-003", "P23-S-012"], compositeEvidence), "parallel_investigation_not_composed"),
  unavailable(record("P24-CAP-A001", "agent-runtime", "agent.descendant.invoke@1", "descendant_agent", "child_owned", "Phase27", ["P23-S-003", "P23-S-010", "P23-S-012"], runnerEvidence), "descendant_agent_not_composed"),
  unavailable(record("P24-CAP-A002", "agent-runtime", "agent.handoff@1", "internal", "effect_free", "Phase27", ["P23-S-012"], runnerEvidence), "handoff_agent_resolver_not_composed"),

  unavailable(record("P24-CAP-I001", "helarc", "run.interaction.clarify@1", "internal", "effect_free", "Phase27", ["P23-S-006"], interactionEvidence), "clarification_protocol_not_composed"),
  registered(record("P24-CAP-I002", "permission", "run.authority.approval@1", "internal", "effect_free", "Phase27", ["P23-S-002", "P23-S-005", "P23-S-010"], ["harness/safety/action-execution/src/enforcement/ActionExecutionCoordinator.test.ts", "harness/host/src/composition/HostRunPermissionComposition.test.ts"]), ["agent-runtime/action-approval@1"], ["permission.approval-reviewer@1"]),
  unavailable(record("P24-CAP-I003", "helarc", "product.proposal.review@1", "internal", "effect_free", "Phase31", ["P23-S-002", "P23-S-003", "P23-S-008"], ["products/helarc/desktop/src/main/run/HelarcHostActionPolicy.test.ts", "products/helarc/desktop/src/main/run/HelarcHostRunComposition.test.ts"]), "superseded_by_canonical_action_approval"),
  registered(record("P24-CAP-I004", "agent-runtime", "run.control.steer@1", "internal", "effect_free", "Phase27", ["P23-S-003", "P23-S-006", "P23-S-010"], ["harness/host/src/transport/HostCommand.test.ts", ...runnerEvidence]), ["host/run.steer@1"], ["agent-runtime/run-steering@1"]),
  registered(record("P24-CAP-I005", "agent-runtime", "run.control.cancel@1", "internal", "effect_free", "Phase27", ["P23-S-010", "P23-S-012"], ["harness/host/src/run/RunnerHostConformance.test.ts", "products/helarc/local-environment/src/command/ProcessExecutor.test.ts"]), ["host/run.cancel@1"], ["agent-runtime/run-cancellation@1"]),
  registered(record("P24-CAP-I006", "host", "run.status.project@1", "internal", "effect_free", "Phase27", ["P23-S-006", "P23-S-010", "P23-S-012"], ["harness/host/src/transport/HostRunStatusQuery.test.ts", "harness/host/src/projection/HostRunProjectionReducer.test.ts"]), ["host/run.status@1"], ["host/run-status-query@1"]),

  unavailable(record("P24-CAP-U001", "code-understanding", "code.understanding.syntax.query@1", "internal", "effect_free", "Phase28", ["P23-S-001", "P23-S-007", "P23-S-011"], runnerEvidence), "code_understanding_not_realized"),
  unavailable(record("P24-CAP-U002", "code-understanding", "code.understanding.language.query@1", "internal", "effect_free", "Phase28", ["P23-S-001", "P23-S-002", "P23-S-007"], runnerEvidence), "code_understanding_not_realized"),
  unavailable(record("P24-CAP-U003", "code-understanding", "code.understanding.relationship.query@1", "internal", "effect_free", "Phase28", ["P23-S-001", "P23-S-003", "P23-S-007"], runnerEvidence), "code_understanding_not_realized"),
  unavailable(record("P24-CAP-U004", "code-understanding", "code.understanding.semantic.retrieve@1", "hosted", "network.connect", "Phase28", ["P23-S-001", "P23-S-007", "P23-S-011"], runnerEvidence), "code_understanding_not_realized"),
  unavailable(record("P24-CAP-U005", "code-understanding", "code.understanding.refresh@1", "composite", "child_owned", "Phase28", ["P23-S-001", "P23-S-007", "P23-S-011"], compositeEvidence), "code_understanding_not_realized"),
  unavailable(record("P24-CAP-X001", "context", "agent.context.candidate.admit@1", "internal", "effect_free", "Phase29", ["P23-S-006", "P23-S-007", "P23-S-011"], ["harness/context/src/context/ContextProjection.test.ts"]), "context_construction_not_realized"),
  unavailable(record("P24-CAP-X002", "context", "agent.context.project@1", "internal", "effect_free", "Phase29", ["P23-S-001", "P23-S-006", "P23-S-007"], ["harness/context/src/context/ContextProjection.test.ts"]), "context_construction_not_realized"),
  unavailable(record("P24-CAP-X003", "context", "agent.context.continuation.compact@1", "internal", "effect_free", "Phase29", ["P23-S-003", "P23-S-007", "P23-S-011"], ["harness/context/src/context/ContextProjection.test.ts"]), "context_continuation_not_realized"),
  registered(record("P24-CAP-V001", "validation", "code.validation.check.execute@1", "composite", "child_owned", "Phase30", ["P23-S-002", "P23-S-004", "P23-S-005"], validationEvidence), ["helarc/run-validation-check@1"], ["helarc.validation.command-check@1"]),
  registered(record("P24-CAP-V002", "validation", "code.validation.requirement.assess@1", "internal", "effect_free", "Phase30", ["P23-S-002", "P23-S-004", "P23-S-011"], validationEvidence), ["validation/finding-assessment@1"], ["validation/run-scoped-execution@1"]),
  registered(record("P24-CAP-V003", "validation", "agent.completion.validation-gate@1", "internal", "effect_free", "Phase30", ["P23-S-002", "P23-S-004", "P23-S-005"], validationEvidence), ["validation/current-completion-gate@1"], ["agent-runtime/runner-completion-gate@1"]),

  registered(record("P24-CAP-E001", "evaluation", "code.evaluation.trial.execute@1", "internal", "child_owned", "Phase26", ["P23-S-001", "P23-S-002", "P23-S-009"], evaluationEvidence), ["evaluation/helarc-trial@1"], ["evaluation/helarc-target@1"]),
  registered(record("P24-CAP-E002", "evaluation", "code.evaluation.capture.grade@1", "internal", "effect_free", "Phase26", ["P23-S-002", "P23-S-009", "P23-S-011"], evaluationEvidence), ["evaluation/helarc-grade@1"], ["evaluation/helarc-grader@1"]),
  registered(record("P24-CAP-E003", "evaluation", "code.evaluation.report.aggregate@1", "internal", "effect_free", "Phase26", ["P23-S-001", "P23-S-009", "P23-S-012"], evaluationEvidence), ["evaluation/helarc-report@1"], ["evaluation/report-reducer@1"]),

  unavailable(record("P24-CAP-S001", "capability-source", "agent.capability.inventory.discover@1", "internal", "effect_free", "Phase31", ["P23-S-001", "P23-S-007"], runnerEvidence), "capability_discovery_not_realized"),
  unavailable(record("P24-CAP-S002", "capability-selection", "agent.capability.catalog.admit@1", "internal", "effect_free", "Phase31", ["P23-S-001", "P23-S-007"], runnerEvidence), "capability_selection_not_realized"),
  unavailable(record("P24-CAP-S003", "capability-selection", "agent.capability.availability.observe@1", "internal", "effect_free", "Phase31", ["P23-S-001", "P23-S-007", "P23-S-009"], runnerEvidence), "capability_selection_not_realized"),
  unavailable(record("P24-CAP-S004", "capability-selection", "agent.tool.selection.produce@1", "internal", "effect_free", "Phase31", ["P23-S-001", "P23-S-007"], ["harness/tools/src/selection/ToolSelection.test.ts"]), "capability_selection_not_realized"),
  unavailable(record("P24-CAP-S005", "capability-selection", "agent.tool.definition.search-load@1", "internal", "effect_free", "Phase31", ["P23-S-001", "P23-S-007"], ["harness/tools/src/selection/ToolSelection.test.ts"]), "deferred_tool_loading_not_realized"),
  unavailable(record("P24-CAP-S006", "tools", "agent.tool.hosted.activate@1", "hosted", "remote_tool.invoke", "Phase31", ["P23-S-001", "P23-S-009"], ["harness/integrations/remote/src/operation/RemoteOperationContribution.test.ts"]), "hosted_tool_activation_not_realized"),
  unavailable(record("P24-CAP-S007", "capability-selection", "agent.capability.catalog.retire@1", "internal", "effect_free", "Phase31", ["P23-S-001", "P23-S-007"], ["harness/operation-catalog/src/OperationCatalog.test.ts"]), "capability_lifecycle_not_realized"),
  unavailable(record("P24-CAP-M001", "learning", "agent.memory.candidate.produce@1", "internal", "effect_free", "Phase32", ["P23-S-009", "P23-S-011"], runnerEvidence), "learning_memory_not_realized"),
  unavailable(record("P24-CAP-M002", "memory", "agent.memory.entry.admit-publish@1", "internal", "child_owned", "Phase32", ["P23-S-009", "P23-S-011"], actionEvidence), "learning_memory_not_realized"),
  unavailable(record("P24-CAP-M003", "memory", "agent.memory.retrieve-project@1", "internal", "effect_free", "Phase32", ["P23-S-001", "P23-S-007", "P23-S-011"], runnerEvidence), "learning_memory_not_realized"),
  unavailable(record("P24-CAP-M004", "memory", "agent.memory.claim.revalidate@1", "composite", "child_owned", "Phase32", ["P23-S-008", "P23-S-011"], compositeEvidence), "learning_memory_not_realized"),
  unavailable(record("P24-CAP-M005", "learning", "agent.memory.use.record@1", "internal", "effect_free", "Phase32", ["P23-S-009", "P23-S-011"], runnerEvidence), "learning_memory_not_realized"),
  unavailable(record("P24-CAP-M006", "memory", "agent.memory.lifecycle.apply@1", "internal", "child_owned", "Phase32", ["P23-S-009", "P23-S-011"], actionEvidence), "learning_memory_not_realized"),
] satisfies readonly Phase27CatalogRealizationRecord[]);

export const PHASE27_BINDING_CONFORMANCE = deepFreeze([
  binding("internal", 1, "none", "none", ["harness/agent-core/runtime/src/runner/Runner.test.ts#internal-operation"]),
  binding("direct", 1, "none", "none", ["harness/safety/action-execution/src/enforcement/ActionExecutionCoordinator.test.ts"]),
  binding("hosted", 1, "none", "none", ["harness/integrations/remote/src/operation/RemoteOperationContribution.test.ts"]),
  binding("composite", 0, "bounded", "none", compositeEvidence),
  binding("descendant_agent", 0, "none", "one", ["harness/agent-core/runtime/src/runner/Runner.test.ts#descendant-agent"]),
] satisfies readonly Phase27BindingConformanceRecord[]);

export const PHASE27_SCENARIO_CONFORMANCE = deepFreeze([
  scenario("P23-S-001", "Unfamiliar repository", ["P24-CAP-D001", "P24-CAP-D002", "P24-CAP-D003", "P24-CAP-U001", "P24-CAP-X002"], ["tooling/test-support/src/evaluation-targets/helarc/HelarcEvaluationTarget.test.ts#inspect-and-complete"]),
  scenario("P23-S-002", "Localized defect", ["P24-CAP-D002", "P24-CAP-D004", "P24-CAP-I002", "P24-CAP-V003"], ["tooling/test-support/src/evaluation-targets/helarc/HelarcEvaluationTarget.test.ts#controlled-file-write"]),
  scenario("P23-S-003", "Multi-file feature", ["P24-CAP-D004", "P24-CAP-C001", "P24-CAP-C002", "P24-CAP-A001"], compositeEvidence),
  scenario("P23-S-004", "Tests and revision", ["P24-CAP-D005", "P24-CAP-V001", "P24-CAP-V002", "P24-CAP-V003"], ["products/helarc/local-environment/src/command/ProcessExecutor.test.ts"]),
  scenario("P23-S-005", "Dependency change", ["P24-CAP-D005", "P24-CAP-D010", "P24-CAP-C002", "P24-CAP-I002"], actionEvidence),
  scenario("P23-S-006", "Ambiguity", ["P24-CAP-I001", "P24-CAP-I004", "P24-CAP-X001"], interactionEvidence),
  scenario("P23-S-007", "Context limits", ["P24-CAP-D001", "P24-CAP-D003", "P24-CAP-X001", "P24-CAP-X002", "P24-CAP-X003"], ["harness/context/src/context/ContextProjection.test.ts"]),
  scenario("P23-S-008", "Stale conflict", ["P24-CAP-D004", "P24-CAP-D008", "P24-CAP-M004"], ["products/helarc/desktop/src/main/run/HelarcHostRunComposition.test.ts"]),
  scenario("P23-S-009", "Partial or unknown effect", ["P24-CAP-D004", "P24-CAP-D005", "P24-CAP-C001", "P24-CAP-E003"], ["harness/safety/action-execution/src/enforcement/ActionExecutionCoordinator.test.ts", "products/helarc/core/src/composition/HelarcProductResult.test.ts"]),
  scenario("P23-S-010", "Cancellation", ["P24-CAP-I002", "P24-CAP-I005", "P24-CAP-A001"], ["harness/host/src/run/RunnerHostConformance.test.ts", "products/helarc/local-environment/src/command/ProcessExecutor.test.ts"]),
  scenario("P23-S-011", "Conventions and prior decisions", ["P24-CAP-D002", "P24-CAP-U001", "P24-CAP-M003", "P24-CAP-M004"], ["harness/context/src/context/ContextProjection.test.ts"]),
  scenario("P23-S-012", "Specialist work", ["P24-CAP-A001", "P24-CAP-A002", "P24-CAP-C004", "P24-CAP-I006"], runnerEvidence),
] satisfies readonly Phase27ScenarioConformanceRecord[]);

export function findPhase27CatalogRecord(
  recordId: Phase27CatalogRecordId,
): Phase27CatalogRealizationRecord | undefined {
  return PHASE27_CATALOG_REALIZATION_REGISTRY.find((recordValue) =>
    recordValue.recordId === recordId
  );
}

function record(
  recordId: Phase27CatalogRecordId,
  semanticOwner: string,
  intendedOperationRevision: string,
  bindingFamily: OperationBindingKind,
  requiredEffectFamily: Phase27EffectFamily,
  assignedRealizationPhase: Phase27RealizationPhase,
  scenarioIds: readonly Phase23ScenarioId[],
  routeEvidence: readonly string[],
): RecordInput {
  return {
    recordId,
    semanticOwner,
    intendedOperationRevision,
    bindingFamily,
    requiredEffectFamily,
    assignedRealizationPhase,
    scenarioIds,
    routeEvidence,
  };
}

function registered(
  input: RecordInput,
  registrationRefs: readonly string[],
  resolverRefs: readonly string[],
): Phase27CatalogRealizationRecord {
  return {
    ...input,
    disposition: { status: "registered", registrationRefs, resolverRefs },
  };
}

function unavailable(
  input: RecordInput,
  reasonCode: string,
): Phase27CatalogRealizationRecord {
  return {
    ...input,
    disposition: {
      status: "unavailable",
      intendedOwner: input.semanticOwner,
      assignedPhase: input.assignedRealizationPhase,
      reasonCode,
    },
  };
}

function binding(
  bindingFamily: OperationBindingKind,
  parentActionCount: 0 | 1,
  childActionCardinality: "none" | "bounded",
  childRunCardinality: "none" | "one",
  evidence: readonly string[],
): Phase27BindingConformanceRecord {
  return {
    bindingFamily,
    parentActionCount,
    childActionCardinality,
    childRunCardinality,
    evidence,
  };
}

function scenario(
  scenarioId: Phase23ScenarioId,
  title: string,
  catalogRecordIds: readonly Phase27CatalogRecordId[],
  evidence: readonly string[],
): Phase27ScenarioConformanceRecord {
  return { scenarioId, title, catalogRecordIds, evidence };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
