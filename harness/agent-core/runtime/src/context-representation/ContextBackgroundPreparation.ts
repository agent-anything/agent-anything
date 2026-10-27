import type {ContextPreparationStore} from "@agent-anything/context/preparation";
import {snapshotProviderRequest, type ProviderRequest, type ProviderResponse} from "@agent-anything/model-interaction";
import {createContextTransformationBasis, createContextTransformationRequest, parseContextGeneratedAccount,
  planContextTransformationStages, type ContextTransformationBasis} from "@agent-anything/model-interaction/context";
import {validateModelAccountScope} from "@agent-anything/model-interaction/input";
import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {AgentActivityExecutionContext} from "../decision/TaskDecisionActivity.js";
import {contextSemanticScopes} from "./ContextSemanticScopePlan.js";
import {contextSemanticSourceKey, type ContextSemanticPreparationSupport, type PreparedContextGeneration} from "./ContextSemanticPreparation.js";

interface BackgroundInput {
  readonly request: ProviderRequest; readonly basis: ContextTransformationBasis; readonly sourceKey: string;
  readonly targetDigest: string; readonly support: ContextSemanticPreparationSupport;
}

interface BackgroundExecution {
  readonly store: ContextPreparationStore;
  readonly context: AgentActivityExecutionContext;
  readonly measure: (request: ProviderRequest, context: AgentActivityExecutionContext) => Promise<ProviderRequest>;
  readonly send: (request: ProviderRequest, context: AgentActivityExecutionContext) => Promise<ProviderResponse>;
}

export async function resumeContextBackground(input: BackgroundExecution & {
  readonly runId: string; readonly targetDigest: string; readonly support: ContextSemanticPreparationSupport;
}): Promise<void> {
  const registration = input.context.auxiliaryWork?.current();
  if (!registration || registration.status !== "registered") return;
  const retained = await input.store.read(registration.id, "input") as {value: BackgroundInput} | null;
  if (!retained || retained.value.request.composition.workingView.recipientRunId !== input.runId ||
      retained.value.targetDigest !== input.targetDigest || registration.binding !== retained.value.sourceKey ||
      modelInputValueDigest(retained.value.support) !== modelInputValueDigest(input.support)) {
    throw new TypeError("Background preparation recovery requires its original scope and method binding.");
  }
  await launchBackground(input, registration.id, retained.value, registration.deadlineAt);
}

async function launchBackground(input: BackgroundExecution, id: string, value: BackgroundInput, deadlineAt: string): Promise<void> {
  await input.context.auxiliaryWork!.start({id, binding: value.sourceKey, deadlineAt}, async context => {
    const once = async <T>(stage: string, create: () => Promise<T>): Promise<T> => {
      const old = await input.store.read(id, stage) as {value: T} | null;
      if (old) return old.value;
      context.cancellation.signal.throwIfAborted();
      const result = await create(); context.cancellation.signal.throwIfAborted();
      await input.store.write(id, stage, {value: result}); return result;
    };
    const request = snapshotProviderRequest(await once("generation-request", async () => {
      const generated = createContextTransformationRequest(value.request, value.basis, "generation");
      return input.measure(snapshotProviderRequest({...generated,
        metadata: {...generated.metadata, contextPreparationPriority: "background"}}), context);
    }));
    if (request.modelContext.assessment?.disposition === "proven_overflow") throw new Error("background_generation_capacity_unavailable");
    const response = await once("generation-response", () => input.send(request, context));
    parseContextGeneratedAccount(response, value.basis, request);
    await input.store.retire(id, "generation_returned");
  });
}

/** Prepares only a directly generatable account. Staged leaf/merge work stays in the foreground envelope. */
export async function prepareContextBackground(input: {
  readonly store: ContextPreparationStore; readonly request: ProviderRequest; readonly runId: string;
  readonly support: ContextSemanticPreparationSupport; readonly targetDigest: string; readonly context: AgentActivityExecutionContext;
  readonly capacityRejected?: boolean;
  readonly measure: (request: ProviderRequest, context: AgentActivityExecutionContext) => Promise<ProviderRequest>;
  readonly send: (request: ProviderRequest, context: AgentActivityExecutionContext) => Promise<ProviderResponse>;
}): Promise<PreparedContextGeneration | undefined> {
  const port = input.context.auxiliaryWork, planning = input.request.modelContext.assessment?.planning;
  if (!port || !input.support.background?.enabled || !planning) return;
  const measured = planning.measurement.status === "measured" ? planning.measurement.amount : null;
  const needed = !!input.capacityRejected || measured !== null && planning.workingTarget !== null && measured > planning.workingTarget;
  const limits = input.support.work ?? {maximumSourceBytes: 64 * 1024, maximumNodes: 1};
  const scopes = contextSemanticScopes(input.request, input.runId, limits.maximumNodes);
  const current = port.current();
  const registrations = new Map(current ? [[current.id, current]] : []);
  for (const scope of scopes) {
    const basis = createContextTransformationBasis(input.request, scope, input.runId, null);
    const key = contextSemanticSourceKey(input.request, basis, input.support, input.targetDigest);
    const saved = port.read(`context-background:${key}`);
    if (saved) registrations.set(saved.id, saved);
  }
  for (const previous of registrations.values()) {
    const retained = await input.store.read(previous.id, "input") as {value: BackgroundInput} | null;
    if (!retained) throw new TypeError("Registered background preparation has no retained basis.");
    const value = retained.value;
    let compatible = false;
    try {
      const ids = value.basis.sources.map(section => section.id);
      validateModelAccountScope(input.request.composition.sections, ids, input.runId);
      const current = createContextTransformationBasis(input.request, ids, input.runId, null);
      compatible = value.sourceKey === contextSemanticSourceKey(input.request, current, input.support, input.targetDigest);
    } catch { /* Current scope no longer supports this optional proposal. */ }
    if (compatible) {
      if (previous.status === "registered") await launchBackground(input, previous.id, value, previous.deadlineAt);
      if (!needed) return;
      await port.wait(previous.id);
      const status = port.read(previous.id)?.status;
      if (status !== "completed") return {sourceKey: value.sourceKey, status: "unavailable"};
      const request = await input.store.read(previous.id, "generation-request") as {value: ProviderRequest} | null;
      const response = await input.store.read(previous.id, "generation-response") as {value: ProviderResponse} | null;
      if (!request || !response) throw new TypeError("Completed background generation is missing its durable response.");
      return {sourceKey: value.sourceKey, status: "ready", request: snapshotProviderRequest(request.value), response: response.value};
    }
  }
  if (needed || measured === null || planning.workingTarget === null || planning.growthAllowance === null ||
      measured + planning.growthAllowance <= planning.workingTarget) return;
  for (const scope of scopes) {
    const basis = createContextTransformationBasis(input.request, scope, input.runId, null);
    const plan = planContextTransformationStages(basis, limits);
    if (plan.kind !== "planned" || plan.nodes.length !== 1) continue;
    const sourceKey = contextSemanticSourceKey(input.request, basis, input.support, input.targetDigest);
    const id = `context-background:${sourceKey}`, deadlineAt = input.context.retry.deadlineAt;
    // Foreground and background share the spent source basis, not a Turn counter.
    const claimId = `context-semantic-claim:${sourceKey}`;
    await input.store.open({id: claimId, runId: input.runId, basis: sourceKey, predecessor: null,
      deadlineAt, stages: ["claim", "plan", "outcome"]});
    if (await input.store.read(claimId, "claim")) continue;
    await input.store.open({id, runId: input.runId, basis: sourceKey, predecessor: null, deadlineAt,
      stages: ["input", "generation-request", "generation-response"]});
    const retained = await input.store.read(id, "input") as {value: BackgroundInput} | null;
    const value = retained?.value ?? {request: input.request, basis, sourceKey, targetDigest: input.targetDigest, support: input.support};
    if (!retained) await input.store.write(id, "input", {value});
    await launchBackground(input, id, value, deadlineAt); return;
  }
}
