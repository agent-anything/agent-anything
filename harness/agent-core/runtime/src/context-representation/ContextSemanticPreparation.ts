import type {ContextPreparationStore} from "@agent-anything/context/preparation";
import {snapshotProviderRequest, type ProviderRequest, type ProviderResponse} from "@agent-anything/model-interaction";
import {createContextTransformationBasis, createContextTransformationRequest, parseContextGeneratedAccount,
  parseContextAccountAssessment, contextAssessmentAllowsAccount, renderContextAccount, CONTEXT_ACCOUNT_METHOD,
  planContextTransformationStages, contextTransformationNodeBasis, contextTransformationPrefixLimit, type ContextTransformationBasis,
  type ContextGeneratedAccount} from "@agent-anything/model-interaction/context";
import {applyModelInputAccounts, createOwnerModelWorkingView, modelInputFromSections,
  modelInputValueDigest, type ModelInputAccount} from "@agent-anything/model-interaction/input";
import {ExecutionFlowPath, createExecutionFlowDefinition, type ExecutionFlowContext} from "@agent-anything/observability/execution-flow";
import {TaskDecisionActivityError} from "../decision/TaskDecisionActivityError.js";
import {contextSemanticScopes} from "./ContextSemanticScopePlan.js";

export interface ContextSemanticPreparationSupport {
  readonly revision: string;
  readonly work?: {readonly maximumSourceBytes: number; readonly maximumNodes: number};
  readonly prefix?: {readonly enabled: true; readonly revision: string};
  readonly background?: {readonly enabled: true; readonly revision: string};
}
export type PreparedContextGeneration = {readonly sourceKey: string; readonly status: "unavailable"} |
  {readonly sourceKey: string; readonly status: "ready"; readonly request: ProviderRequest; readonly response: ProviderResponse};
export interface ContextSemanticOutcome {
  readonly request: ProviderRequest;
  readonly accounts: readonly ModelInputAccount[];
  readonly limitations: readonly string[];
}
const FLOW = createExecutionFlowDefinition({owner: "agent-runtime", id: "context-semantic-transformation", revision: "1",
  label: "Context Semantic Transformation", description: "Source-grounded generation and separate full-proposal assessment. Not a working Agent Turn.",
  steps: [{id: "basis", label: "Freeze source and work background", kind: "entry", checks: ["eligible_scope"]},
    {id: "generation", label: "Generate candidate account", kind: "call", checks: ["complete_structured_output"]},
    {id: "assessment", label: "Assess complete proposed input", kind: "call", checks: ["semantic_findings"]},
    {id: "outcome", label: "Return candidate or limitation", kind: "exit", checks: ["comparable_relief"]}],
  transitions: [["basis", "generation"], ["generation", "assessment"], ["assessment", "outcome"], ["generation", "outcome"], ["basis", "outcome"]]
    .map(([from, to]) => ({id: `${from}:${to}`, from: from!, to: to!, label: `${from} to ${to}`})),
  entryStepIds: ["basis"], exitStepIds: ["outcome"]});

export function contextSemanticTargetDigest(provider: {readonly descriptor: {readonly id: string; readonly metadata: Readonly<Record<string, unknown>>};
  readonly modelContext: {readonly target: unknown}}): string {
  return modelInputValueDigest({providerId: provider.descriptor.id, target: provider.modelContext.target,
    generationConfiguration: provider.descriptor.metadata.generationConfiguration ?? null});
}

export function requestWithContextAccounts(request: ProviderRequest, accounts: readonly ModelInputAccount[], runId: string): ProviderRequest {
  if (!accounts.length) return request;
  const sections = applyModelInputAccounts(request.composition.sections, accounts, runId);
  const forms = request.composition.workingView.forms ?? [];
  const history = [...(request.composition.workingView.accounts ?? []), ...accounts];
  const projected = modelInputFromSections(sections);
  return snapshotProviderRequest({...request, ...projected, modelContext: {...request.modelContext, assessment: null},
    composition: {...request.composition, ...projected, sections,
      workingView: createOwnerModelWorkingView({sections, recipientRunId: runId, boundary: "request", forms, accounts: history})}});
}

/** Bounded semantic work. Every retained complete response is parsed again, never regenerated for repair. */
export async function prepareContextSemanticAccount(input: {
  readonly store: ContextPreparationStore; readonly request: ProviderRequest; readonly runId: string;
  readonly preparationId: string; readonly deadlineAt: string; readonly support: ContextSemanticPreparationSupport;
  readonly targetDigest: string;
  readonly preparedGeneration?: PreparedContextGeneration;
  readonly capacityRejected?: boolean;
  readonly send: (request: ProviderRequest) => Promise<ProviderResponse>;
  readonly measure: (request: ProviderRequest) => Promise<ProviderRequest>;
  readonly guard: () => Promise<void>; readonly executionFlow?: ExecutionFlowContext;
}): Promise<ContextSemanticOutcome> {
  const unchanged = (limitation: string): ContextSemanticOutcome => ({request: input.request, accounts: [], limitations: [limitation]});
  const planning = input.request.modelContext.assessment?.planning;
  if (!planning || !input.capacityRejected && (planning.measurement.status !== "measured" ||
      planning.workingTarget === null || planning.measurement.amount <= planning.workingTarget)) return unchanged("semantic_preparation_not_needed");
  const originalAmount = planning.measurement.status === "measured" ? planning.measurement.amount : null;
  const limits = input.support.work ?? {maximumSourceBytes: 64 * 1024, maximumNodes: 1};
  let attemptedNodes = 0;
  const limitations: string[] = [];
  let best: ContextSemanticOutcome | null = null;
  for (const scope of contextSemanticScopes(input.request, input.runId, limits.maximumNodes)) {
    if (attemptedNodes >= limits.maximumNodes) {limitations.push("semantic_staging_node_limit"); break;}
    const sourceBytes = input.request.composition.sections.filter(section => scope.includes(section.id))
      .reduce((sum, section) => sum + Buffer.byteLength(JSON.stringify(section.content)), 0);
    const room = input.capacityRejected || originalAmount === null || planning.releaseTarget === null ? null : Math.max(0, planning.releaseTarget -
      (originalAmount - sourceBytes * originalAmount / Math.max(1, planning.footprint.bytes)));
    const basis = createContextTransformationBasis(input.request, scope, input.runId, room);
    await input.guard();
    const claimBasis = contextSemanticSourceKey(input.request, basis, input.support, input.targetDigest);
    if (input.preparedGeneration?.sourceKey === claimBasis && input.preparedGeneration.status === "unavailable") {
      limitations.push("background_generation_unavailable"); continue;
    }
    const claimId = `context-semantic-claim:${claimBasis}`;
    await input.store.open({id: claimId, runId: input.runId, basis: claimBasis, predecessor: null,
      deadlineAt: input.deadlineAt, stages: ["claim", "plan", "outcome"]});
    const claimed = await input.store.read(claimId, "claim") as {preparationId: string} | null;
    if (claimed && claimed.preparationId !== input.preparationId) {limitations.push("semantic_basis_already_attempted"); continue;}
    await input.store.write(claimId, "claim", {preparationId: input.preparationId});
    await input.store.write(claimId, "plan", {basisId: basis.id, limits, policy: "capacity-refinement.v1"});
    let maximumSourceBytes = limits.maximumSourceBytes, finalAccount: string | null = null;
    const evaluated = new Set<string>();
    while (attemptedNodes < limits.maximumNodes) {
      const stagePlan = planContextTransformationStages(basis, {maximumSourceBytes, maximumNodes: limits.maximumNodes - attemptedNodes});
      if (stagePlan.kind === "unavailable") {limitations.push(`semantic_staging_${stagePlan.reason}`); break;}
      const planId = `${claimId}:plan:${maximumSourceBytes}`;
      await input.store.open({id: planId, runId: input.runId, basis: modelInputValueDigest({basis: basis.id, stagePlan}),
        predecessor: claimId, deadlineAt: input.deadlineAt, stages: ["plan", "outcome"]});
      await input.store.write(planId, "plan", {maximumSourceBytes, stagePlan, attemptedNodesBefore: attemptedNodes});
      const nodes = new Map<string, ModelInputAccount>();
      let refine = false;
      for (const node of stagePlan.nodes) {
        const nodeBasis = contextTransformationNodeBasis(basis, node, node.inputs.map(id => nodes.get(id)!));
        if (!evaluated.has(nodeBasis.id)) {attemptedNodes++; evaluated.add(nodeBasis.id);}
        const result = await executeSemanticNode({...input, basis: nodeBasis, nodeId: node.id, originalAmount, originalBasis: planning.basisKey,
          stagePlan: {id: planId, plan: stagePlan, maximumSourceBytes, attemptedNodes, maximumNodes: limits.maximumNodes}});
        if (!result.accounts.length) {
          limitations.push(...result.limitations);
          refine = !node.inputs.length && result.limitations.some(reason =>
            ["generation_capacity_unavailable", "assessment_capacity_unavailable", "auxiliary_provider_context_window_exceeded"].includes(reason));
          break;
        }
        nodes.set(node.id, result.accounts[0]!);
        if (node.level === "final_adoption") {
          finalAccount = result.accounts[0]!.id;
          const amount = result.request.modelContext.assessment?.planning?.measurement;
          const prior = best?.request.modelContext.assessment?.planning?.measurement;
          if (!best || (amount?.status === "measured" && prior?.status === "measured" ? amount.amount < prior.amount :
              result.request.modelContext.assessment!.planning!.footprint.bytes < best.request.modelContext.assessment!.planning!.footprint.bytes)) best = result;
        }
      }
      await input.store.write(planId, "outcome", {finalAccount, refine, attemptedNodes});
      await input.store.retire(planId, "attempted");
      if (!refine || maximumSourceBytes === 1) break;
      maximumSourceBytes = Math.max(1, Math.floor(maximumSourceBytes / 2));
    }
    await input.store.write(claimId, "outcome", {finalAccount, attemptedNodes});
    await input.store.retire(claimId, "attempted");
    const measured = best?.request.modelContext.assessment?.planning?.measurement;
    if ((best && input.capacityRejected) || (measured?.status === "measured" && measured.amount <= (planning.releaseTarget ?? planning.workingTarget ?? Infinity))) break;
  }
  return best ? {...best, limitations: [...best.limitations, ...limitations]} :
    {request: input.request, accounts: [], limitations: limitations.length ? limitations : ["no_eligible_semantic_scope"]};
}

async function executeSemanticNode(input: Parameters<typeof prepareContextSemanticAccount>[0] & {
  readonly basis: ContextTransformationBasis; readonly nodeId: string; readonly originalAmount: number | null; readonly originalBasis: string;
  readonly stagePlan: {readonly id: string; readonly plan: unknown; readonly maximumSourceBytes: number;
    readonly attemptedNodes: number; readonly maximumNodes: number};
}): Promise<ContextSemanticOutcome> {
  const {basis} = input;
  const unchanged = (limitation: string): ContextSemanticOutcome => ({request: input.request, accounts: [], limitations: [limitation]});
  const intent = {id: `${input.preparationId}:${basis.id}`, runId: input.runId,
    basis: modelInputValueDigest({basis, support: input.support, targetDigest: input.targetDigest}), predecessor: input.preparationId, deadlineAt: input.deadlineAt,
    stages: ["generation-request", "generation-response", "generated", "assessment-request", "assessment-response", "outcome", "rejected"]};
  const head = await input.store.open(intent);
  const rejection = await input.store.read(intent.id, "rejected") as {reason: string} | null;
  if (rejection) return unchanged(rejection.reason);
  const once = async <T>(stage: string, create: () => Promise<T>): Promise<T> => {
    const old = await input.store.read(intent.id, stage) as {value: T} | null;
    if (old) return old.value;
    if (head.state !== "open") throw new TypeError("Semantic preparation is retired.");
    await input.guard();
    const value = await create();
    await input.guard();
    await input.store.write(intent.id, stage, {value});
    return value;
  };
  const flow = new ExecutionFlowPath(FLOW, input.executionFlow ?? {}, input.runId,
    [{owner: "context", kind: "preparation", id: intent.id, revision: "1"}]);
  try {
    flow.advance("basis", {basisId: basis.id, targetDigest: input.targetDigest, nodeId: input.nodeId, assessmentLevel: basis.assessmentLevel},
      [flow.material("Replacement sources and read-only background", "frozen", basis, "provider"),
        flow.material("Transformation stage plan", "planned", input.stagePlan, "provider")]).check("eligible_scope", "passed");
    const generation = flow.advance("generation");
    const prepared = input.preparedGeneration;
    const reusable = basis.assessmentLevel === "final_adoption" && prepared?.status === "ready" &&
      prepared.sourceKey === contextSemanticSourceKey(input.request, basis, input.support, input.targetDigest) ? prepared : null;
    const generatedRequest = snapshotProviderRequest(await once("generation-request", async () =>
      reusable?.request ?? selectAuxiliaryRequest(input, "generation")));
    if (generatedRequest.modelContext.assessment?.disposition === "proven_overflow") throw new SemanticRejection("generation_capacity_unavailable");
    const response = await once("generation-response", () => reusable ? Promise.resolve(reusable.response) : input.send(generatedRequest));
    const generated = await once("generated", async () => {
      try {return parseContextGeneratedAccount(response, basis, generatedRequest);} catch {throw new SemanticRejection("generation_shape_invalid");}
    });
    generation.output(flow.material("Generated account", "generated", {request: generatedRequest, response, generated}, "provider"));
    generation.check("complete_structured_output", "passed");
    await input.guard();
    const draft = renderContextAccount(basis, generated, {owner: "model-interaction", kind: "assessment", id: `${intent.id}:assessment`, revision: "1"},
      modelInputValueDigest({basis: basis.id, generated}));
    const proposal = basis.assessmentLevel === "final_adoption" ? requestWithContextAccounts(input.request, [draft], input.runId) : null;
    const proposalSections = proposal?.composition.sections ?? basis.sourceOrder.flatMap(id => id === basis.sources[0]!.id ? [draft.section] :
      basis.background.filter(section => section.id === id));
    const assessment = flow.advance("assessment", {basisId: basis.id, proposedView: proposal?.composition.workingView.id ?? "internal_scoped_proposal"});
    const assessmentRequest = snapshotProviderRequest(await once("assessment-request", async () => {
      const request = await selectAuxiliaryRequest(input, "assessment", generated, proposalSections);
      return snapshotProviderRequest({...request, metadata: {...request.metadata,
        contextGeneration: {requestId: generatedRequest.requestId, basisId: generatedRequest.metadata.transformationBasis ?? null,
          sourceKey: contextSemanticSourceKey(input.request, basis, input.support, input.targetDigest)}}});
    }));
    if (assessmentRequest.modelContext.assessment?.disposition === "proven_overflow") throw new SemanticRejection("assessment_capacity_unavailable");
    const assessmentResponse = await once("assessment-response", () => input.send(assessmentRequest));
    const findings = (() => {try {return parseContextAccountAssessment(assessmentResponse, basis, assessmentRequest);} catch {throw new SemanticRejection("assessment_shape_invalid");}})();
    assessment.output(flow.material("Whole-input semantic assessment", "assessed", {request: assessmentRequest, response: assessmentResponse, findings}, "provider"));
    const allowed = contextAssessmentAllowsAccount(findings);
    assessment.check("semantic_findings", allowed ? "passed" : "not_satisfied");
    const outcome = await once("outcome", async (): Promise<ContextSemanticOutcome> => {
      if (!allowed) return unchanged("semantic_assessment_not_adequate");
      const account = {...draft, assessmentBasis: modelInputValueDigest(assessmentRequest),
        limitations: [...new Set([...draft.limitations, ...findings.limitations,
          ...findings.inheritedDefects.map(value => `inherited_source_defect:${value}`)])],
        assessment: {owner: "model-interaction", kind: "request", id: assessmentRequest.requestId, revision: null}};
      if (basis.assessmentLevel === "internal_node") return {request: input.request, accounts: [account], limitations: [...findings.limitations, "intermediate_not_adoptable"]};
      const request = await input.measure(requestWithContextAccounts(input.request, [account], input.runId));
      const proposed = request.modelContext.assessment?.planning;
      const tokenRelief = proposed?.measurement.status === "measured" && proposed.basisKey === input.originalBasis &&
        input.originalAmount !== null && proposed.measurement.amount < input.originalAmount;
      const unknownTokenRelief = input.capacityRejected && proposed && proposed.basisKey === input.originalBasis &&
        (input.originalAmount === null || proposed.measurement.status !== "measured") &&
        proposed.footprint.bytes < input.request.modelContext.assessment!.planning!.footprint.bytes;
      if (!tokenRelief && !unknownTokenRelief) return unchanged("no_comparable_whole_input_relief");
      return {request, accounts: [account], limitations: [...findings.limitations, "semantic_assessment_is_scope_bound",
        ...(tokenRelief ? [] : ["smaller_input_footprint_token_relief_unproven"])]};
    });
    flow.advance("outcome", {selectedCandidate: outcome.accounts.length > 0, limitationCount: outcome.limitations.length},
      [flow.material("Transformation outcome", outcome.accounts.length ? "candidate" : "rejected", outcome, "provider")])
      .check("comparable_relief", outcome.accounts.length ? "passed" : "not_satisfied");
    await input.store.retire(intent.id, "settled"); flow.close("returned");
    return outcome;
  } catch (error) {flow.current?.output(flow.material("Transformation failure", "failed",
    {name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "Unknown failure"}, "provider"));
    flow.close("failed");
    if (error instanceof SemanticRejection || error instanceof TaskDecisionActivityError && error.operationSettlement === "settled_failure" && !error.deadline &&
        error.failure.kind === "provider" && error.failure.failure.code !== "provider_cancellation_unconfirmed") {
      await input.guard();
      const reason = error instanceof SemanticRejection ? error.message : `auxiliary_${error.failure.failure.code}`;
      await input.store.write(intent.id, "rejected", {reason,
        ...(error instanceof TaskDecisionActivityError && error.failure.kind === "provider" ? {providerFailure: error.failure.failure} : {})});
      await input.store.retire(intent.id, "rejected");
      return unchanged(reason);
    }
    throw error;}
}

class SemanticRejection extends Error {}

export function contextSemanticSourceKey(request: ProviderRequest, basis: ContextTransformationBasis,
  support: ContextSemanticPreparationSupport, targetDigest: string): string {
  return modelInputValueDigest({run: basis.recipientRunId, target: targetDigest, method: support,
    sources: basis.sources.map(section => ({id: section.id, source: section.source, content: section.content, preservation: section.preservation})),
    bindings: {instructions: request.instructions, definitions: request.interaction}});
}

async function selectAuxiliaryRequest(input: Parameters<typeof executeSemanticNode>[0], stage: "generation" | "assessment",
  generated?: ContextGeneratedAccount, proposal?: ProviderRequest["composition"]["sections"]): Promise<ProviderRequest> {
  const isolated = await input.measure(createContextTransformationRequest(input.request, input.basis, stage, generated, proposal));
  if (!input.support.prefix?.enabled || contextTransformationPrefixLimit(input.request, input.basis) !== null) return isolated;
  const prefix = await input.measure(createContextTransformationRequest(input.request, input.basis, stage, generated, proposal, "prefix"));
  const first = isolated.modelContext.assessment?.measurement, second = prefix.modelContext.assessment?.measurement;
  // Same native estimator only. A local reduction does not establish token equivalence across formats.
  const comparable = first?.status === "measured" && second?.status === "measured" &&
    modelInputValueDigest(first.estimator) === modelInputValueDigest(second.estimator);
  const selected = comparable && second.amount <= first.amount && prefix.modelContext.assessment?.disposition !== "proven_overflow" ? prefix : isolated;
  return snapshotProviderRequest({...selected, metadata: {...selected.metadata, auxiliaryFormSelection: {
    policy: input.support.prefix.revision, comparison: comparable ? "same_estimator" : "incomparable",
    isolatedMeasurement: first ? JSON.parse(JSON.stringify(first)) : null,
    prefixMeasurement: second ? JSON.parse(JSON.stringify(second)) : null, cacheHit: "unknown"}}});
}

