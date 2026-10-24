import type {ContextPreparationStore} from "@agent-anything/context/preparation";
import {snapshotProviderRequest, type ProviderRequest, type ProviderResponse} from "@agent-anything/model-interaction";
import {createContextTransformationBasis, createContextTransformationRequest, parseContextGeneratedAccount,
  planContextTransformationStages, type ContextTransformationBasis} from "@agent-anything/model-interaction/context";
import {validateModelAccountScope} from "@agent-anything/model-interaction/input";
import type {ControllerCallContext} from "./Controller.js";
import {contextSemanticScopes} from "./ContextSemanticScopePlan.js";
import {contextSemanticSourceKey, type ControllerContextSemanticSupport, type PreparedContextGeneration} from "./ControllerContextTransformation.js";

interface BackgroundInput {
  readonly request: ProviderRequest; readonly basis: ContextTransformationBasis; readonly sourceKey: string;
  readonly targetDigest: string; readonly support: ControllerContextSemanticSupport;
}

/** Prepares only a directly generatable account. Staged leaf/merge work stays in the foreground envelope. */
export async function prepareContextBackground(input: {
  readonly store: ContextPreparationStore; readonly request: ProviderRequest; readonly runId: string;
  readonly support: ControllerContextSemanticSupport; readonly targetDigest: string; readonly context: ControllerCallContext;
  readonly capacityRejected?: boolean;
  readonly measure: (request: ProviderRequest, context: ControllerCallContext) => Promise<ProviderRequest>;
  readonly send: (request: ProviderRequest, context: ControllerCallContext) => Promise<ProviderResponse>;
}): Promise<PreparedContextGeneration | undefined> {
  const port = input.context.auxiliaryWork, planning = input.request.modelContext.assessment?.planning;
  if (!port || !input.support.background?.enabled || !planning || planning.measurement.status !== "measured" || planning.workingTarget === null) return;
  const needed = !!input.capacityRejected || planning.measurement.amount > planning.workingTarget;
  const once = async <T>(id: string, stage: string, create: () => Promise<T>, context: ControllerCallContext): Promise<T> => {
    const old = await input.store.read(id, stage) as {value: T} | null;
    if (old) return old.value;
    context.cancellation.signal.throwIfAborted();
    const value = await create(); context.cancellation.signal.throwIfAborted();
    await input.store.write(id, stage, {value}); return value;
  };
  const launch = async (id: string, value: BackgroundInput, deadlineAt: string) => port.start({id, binding: value.sourceKey, deadlineAt}, async context => {
    const request = snapshotProviderRequest(await once(id, "generation-request", async () => {
      const generated = createContextTransformationRequest(value.request, value.basis, "generation");
      return input.measure(snapshotProviderRequest({...generated,
        metadata: {...generated.metadata, contextPreparationPriority: "background"}}), context);
    }, context));
    if (request.modelContext.assessment?.disposition === "proven_overflow") throw new Error("background_generation_capacity_unavailable");
    const response = await once(id, "generation-response", () => input.send(request, context), context);
    parseContextGeneratedAccount(response, value.basis);
    await input.store.retire(id, "generation_returned");
  });
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
      if (previous.status === "registered") await launch(previous.id, value, previous.deadlineAt);
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
  if (needed || planning.growthAllowance === null || planning.measurement.amount + planning.growthAllowance <= planning.workingTarget) return;
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
    await launch(id, value, deadlineAt); return;
  }
}
