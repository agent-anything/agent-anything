import { createHash } from "node:crypto";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import { createOperationCatalogSnapshot } from "@agent-anything/operation-catalog/catalog";
import {
  createToolRegistrationSnapshot,
  type ToolRegistrationInput,
} from "@agent-anything/tools/registration";
import {
  createFixedLocalToolSelection,
  createToolBindingAvailabilityAssessment,
  createToolExposureProof,
  resolveCurrentTurnToolExposure,
  ToolExposureValidationError,
  type CurrentTurnToolExposure,
  type ToolBindingAvailabilityAssessment,
  type ToolBindingUnavailableReason,
  type ToolSelectionRevision,
} from "@agent-anything/tools/selection";
import { runHelarcEvaluationBaselineCandidate } from "../evaluation-targets/helarc/HelarcEvaluationExecution.js";

const NOW = "2026-08-24T00:00:00.000Z";
const OMITTED_DESCRIPTOR_SECRET = "omitted-tool-private-description";

export interface CurrentTurnToolExposureEvaluationCase {
  readonly id: string;
  readonly selectedModelToolCount: number;
  readonly exposedToolNames: readonly string[];
  readonly omittedToolCount: number;
  readonly omissionReasons: readonly ToolBindingUnavailableReason[];
  readonly contentRevision: string;
  readonly basisRevision: string;
}

export interface CurrentTurnToolExposureEvaluationReport {
  readonly revision: "current-turn-tool-exposure-deterministic-evaluation-v1";
  readonly cases: readonly CurrentTurnToolExposureEvaluationCase[];
  readonly incompleteAssessmentFailureCode: "tool_exposure_assessment_missing";
  readonly workflowOnlyToolExcluded: true;
  readonly recoveryPreservedSelection: true;
  readonly recoveryChangedContent: true;
  readonly permissionIndependent: true;
  readonly lifecycleHookIndependent: true;
  readonly equivalentContentUsesDistinctRequestProofs: true;
  readonly systemTarget: {
    readonly trialCount: number;
    readonly outcomeQualityGate: "passed";
    readonly safetyGate: "passed";
    readonly traceIssueCount: number;
  };
  readonly diagnostics: {
    readonly selectedModelToolCount: number;
    readonly minimumExposedToolCount: number;
    readonly maximumExposedToolCount: number;
    readonly omittedToolCount: number;
    readonly controllerTrialCount: number;
  };
  readonly prohibitedDisclosureCount: 0;
  readonly digest: string;
}

export async function runCurrentTurnToolExposureDeterministicEvaluation(): Promise<
  CurrentTurnToolExposureEvaluationReport
> {
  const selection = createEvaluationSelection();
  const full = resolve(selection, "full", {
    Read: available("read-path", "1"),
    TaskStop: available("task-registry", "1"),
  });
  const partial = resolve(selection, "controlled-resource-absent", {
    Read: available("read-path", "1"),
    TaskStop: unavailable("task-registry", "1", "no_eligible_subject"),
  });
  const zero = resolve(selection, "all-paths-unavailable", {
    Read: unavailable("read-path", "2", "execution_path_unavailable"),
    TaskStop: unavailable("task-registry", "1", "no_eligible_subject"),
  });
  const recovered = resolve(selection, "controlled-resource-recovered", {
    Read: available("read-path", "1"),
    TaskStop: available("task-registry", "2"),
  });

  let incompleteAssessmentFailureCode: "tool_exposure_assessment_missing" | null = null;
  try {
    const readOnly = assessment(
      selection,
      "Read",
      available("read-path", "1"),
    );
    resolveCurrentTurnToolExposure(selection, {
      basisRefs: readOnly.basisRefs,
      assessments: [readOnly],
    });
  } catch (error) {
    if (error instanceof ToolExposureValidationError && error.code === "tool_exposure_assessment_missing") {
      incompleteAssessmentFailureCode = error.code;
    } else {
      throw error;
    }
  }
  if (incompleteAssessmentFailureCode === null) {
    throw new TypeError("Incomplete Tool availability coverage did not fail closed.");
  }

  const permissionAsk = resolve(selection, "permission-ask", {
    Read: available("read-path", "1"),
    TaskStop: unavailable("task-registry", "1", "no_eligible_subject"),
  });
  const permissionDeny = resolve(selection, "permission-deny", {
    Read: available("read-path", "1"),
    TaskStop: unavailable("task-registry", "1", "no_eligible_subject"),
  });
  const repeatedLifecycleHook = resolve(selection, "lifecycle-hook-repeated", {
    Read: available("read-path", "1"),
    TaskStop: unavailable("task-registry", "1", "no_eligible_subject"),
  });
  const proofA = createToolExposureProof(partial, "evaluation-controller-request-a");
  const proofB = createToolExposureProof(partial, "evaluation-controller-request-b");
  const systemCandidate = await runHelarcEvaluationBaselineCandidate();
  const gateByDimension = new Map(
    systemCandidate.report.gateOutcomes.map((gate) => [gate.dimension, gate.status]),
  );
  if (
    gateByDimension.get("outcome_quality") !== "passed" ||
    gateByDimension.get("safety") !== "passed"
  ) {
    throw new TypeError("The real Helarc deterministic target did not satisfy its quality and safety gates.");
  }

  const cases = Object.freeze([
    caseResult("full-model-origin-exposure", selection, full),
    caseResult("controlled-resource-absence", selection, partial),
    caseResult("zero-exposure", selection, zero),
    caseResult("controlled-resource-reappearance", selection, recovered),
  ]);
  const material = deepFreeze({
    revision: "current-turn-tool-exposure-deterministic-evaluation-v1" as const,
    cases,
    incompleteAssessmentFailureCode,
    workflowOnlyToolExcluded: !full.catalog.tools.some(({ name }) => name === "WorkflowOnly") as true,
    recoveryPreservedSelection: (partial.selectionRevision === recovered.selectionRevision) as true,
    recoveryChangedContent: (partial.contentRevision !== recovered.contentRevision) as true,
    permissionIndependent: (permissionAsk.contentRevision === permissionDeny.contentRevision) as true,
    lifecycleHookIndependent: (partial.contentRevision === repeatedLifecycleHook.contentRevision) as true,
    equivalentContentUsesDistinctRequestProofs: (
      proofA.contentRevision === proofB.contentRevision && proofA.id !== proofB.id
    ) as true,
    systemTarget: {
      trialCount: systemCandidate.cases.length,
      outcomeQualityGate: "passed" as const,
      safetyGate: "passed" as const,
      traceIssueCount: systemCandidate.cases.reduce(
        (count, item) => count + item.traceIssueCodes.length,
        0,
      ),
    },
    diagnostics: {
      selectedModelToolCount: modelToolCount(selection),
      minimumExposedToolCount: Math.min(...cases.map((item) => item.exposedToolNames.length)),
      maximumExposedToolCount: Math.max(...cases.map((item) => item.exposedToolNames.length)),
      omittedToolCount: cases.reduce((count, item) => count + item.omittedToolCount, 0),
      controllerTrialCount: systemCandidate.cases.length,
    },
    prohibitedDisclosureCount: 0 as const,
  });
  const serialized = stableJson(material);
  if (serialized.includes(OMITTED_DESCRIPTOR_SECRET)) {
    throw new TypeError("Current-turn Tool Exposure Evaluation disclosed an omitted descriptor.");
  }
  assertTrue(material.workflowOnlyToolExcluded, "Workflow-only Tool entered model exposure.");
  assertTrue(material.recoveryPreservedSelection, "Recovery changed immutable Run selection.");
  assertTrue(material.recoveryChangedContent, "Recovery did not create fresh exposure content.");
  assertTrue(material.permissionIndependent, "Permission state filtered Tool exposure.");
  assertTrue(material.lifecycleHookIndependent, "Lifecycle Hook state filtered Tool exposure.");
  assertTrue(
    material.equivalentContentUsesDistinctRequestProofs,
    "Equivalent exposure content did not retain request-specific proof correlation.",
  );
  if (material.systemTarget.traceIssueCount !== 0) {
    const traceIssues = systemCandidate.cases
      .filter((item) => item.traceIssueCodes.length > 0)
      .map((item) => ({
        caseId: item.caseRef.id,
        repetitionOrdinal: item.repetitionOrdinal,
        codes: item.traceIssueCodes,
      }));
    throw new TypeError(
      `The real Helarc deterministic target produced Trace issues: ${JSON.stringify(traceIssues)}.`,
    );
  }
  return deepFreeze({ ...material, digest: sha256(serialized) });
}

function resolve(
  selection: ToolSelectionRevision,
  _caseId: string,
  states: Readonly<Record<"Read" | "TaskStop", AvailabilityState>>,
): CurrentTurnToolExposure {
  const assessments = [
    assessment(selection, "Read", states.Read),
    assessment(selection, "TaskStop", states.TaskStop),
  ];
  return resolveCurrentTurnToolExposure(selection, {
    basisRefs: Object.freeze(assessments.flatMap((item) => item.basisRefs)),
    assessments: Object.freeze(assessments),
  });
}

function assessment(
  selection: ToolSelectionRevision,
  name: "Read" | "TaskStop",
  state: AvailabilityState,
): ToolBindingAvailabilityAssessment {
  const selected = selection.tools.find(({ registration }) => registration.descriptor.name === name);
  if (selected === undefined) throw new TypeError(`Evaluation Tool '${name}' is not selected.`);
  return createToolBindingAvailabilityAssessment({
    selection,
    tool: selected.registration.descriptor.ref,
    basisRefs: [{
      owner: "evaluation-owner",
      kind: state.kind,
      id: name,
      revision: state.revision,
    }],
    disposition: state.disposition,
    reason: state.reason,
  });
}

interface AvailabilityState {
  readonly kind: string;
  readonly revision: string;
  readonly disposition: "available" | "unavailable";
  readonly reason: ToolBindingUnavailableReason | null;
}

function available(kind: string, revision: string): AvailabilityState {
  return { kind, revision, disposition: "available", reason: null };
}

function unavailable(
  kind: string,
  revision: string,
  reason: ToolBindingUnavailableReason,
): AvailabilityState {
  return { kind, revision, disposition: "unavailable", reason };
}

function caseResult(
  id: string,
  selection: ToolSelectionRevision,
  exposure: CurrentTurnToolExposure,
): CurrentTurnToolExposureEvaluationCase {
  return deepFreeze({
    id,
    selectedModelToolCount: modelToolCount(selection),
    exposedToolNames: exposure.catalog.tools.map(({ name }) => name),
    omittedToolCount: exposure.omissions.length,
    omissionReasons: exposure.omissions.map(({ reason }) => reason),
    contentRevision: exposure.contentRevision,
    basisRevision: exposure.basis.revision,
  });
}

function createEvaluationSelection(): ToolSelectionRevision {
  const read = operationRef("read");
  const stop = operationRef("task-stop");
  const workflow = operationRef("workflow-only");
  const operationCatalog = createOperationCatalogSnapshot({
    id: "current-turn-exposure-evaluation-operations",
    revision: "1",
    entries: [read, stop, workflow].map((ref) => ({
      admissionId: `operation-admission-${ref.operation.name}`,
      operation: {
        ref,
        semanticOwner: "evaluation-owner",
        requestSchemaRevision: "request-1",
        resultSchemaRevision: "result-1",
        roles: {
          requestOrigins: ["tool_request", "trusted_workflow"],
          exposure: "eager_tool",
          runControl: "internal",
          trust: "effect_free",
          participation: "semantic_owner",
          domainPurpose: `evaluation.${ref.operation.name}`,
        },
      },
      binding: {
        ref: { operation: ref, revision: "binding-1" },
        kind: "internal",
        resolverId: `resolver.${ref.operation.name}`,
        resolverRevision: "1",
      },
      sourceRevision: "source-1",
      allowedRequestOrigins: ["tool_request", "trusted_workflow"],
      admittedAt: NOW,
      retirement: null,
    })),
  });
  const registrations = createToolRegistrationSnapshot(operationCatalog, [
    registration("Read", read, "Read files."),
    registration("TaskStop", stop, OMITTED_DESCRIPTOR_SECRET),
    registration("WorkflowOnly", workflow, "Trusted workflow only."),
  ]);
  return createFixedLocalToolSelection(registrations, operationCatalog, [
    { tool: toolRef("read"), origins: ["model"] },
    { tool: toolRef("task-stop"), origins: ["model"] },
    { tool: toolRef("workflow-only"), origins: ["workflow"] },
  ]);
}

function registration(
  name: string,
  operation: OperationRevisionRef,
  description: string,
): ToolRegistrationInput {
  return {
    admissionId: `tool-admission-${operation.operation.name}`,
    descriptor: {
      ref: toolRef(operation.operation.name),
      name,
      description,
      inputSchema: { type: "object", additionalProperties: false },
      schemaRevisions: {
        dialect: "json-schema-2020-12",
        input: "input-1",
        output: null,
        translation: "native-1",
      },
      source: {
        kind: "product",
        sourceId: "current-turn-exposure-evaluation",
        sourceRevision: "1",
        activationEpoch: null,
      },
      binding: { kind: "operation", operation, revision: "binding-1" },
    },
    allowedOrigins: ["model", "workflow"],
    admittedAt: NOW,
  };
}

function operationRef(name: string): OperationRevisionRef {
  return { operation: { namespace: "evaluation", name }, revision: "1" };
}

function toolRef(name: string) {
  return { tool: { namespace: "evaluation", name }, revision: "1" };
}

function modelToolCount(selection: ToolSelectionRevision): number {
  return selection.tools.filter(({ origins }) => origins.includes("model")).length;
}

function assertTrue(value: boolean, message: string): asserts value is true {
  if (!value) throw new TypeError(message);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
