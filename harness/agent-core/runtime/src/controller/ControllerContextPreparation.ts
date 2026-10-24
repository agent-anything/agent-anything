import type {ContextPreparationStore, ContextPreparationIntent} from "@agent-anything/context/preparation";
import {ExecutionFlowPath} from "@agent-anything/observability/execution-flow";
import {snapshotProviderRequest, type ProviderRequest} from "@agent-anything/model-interaction";
import {allocateModelInput, type ModelInputAllocationUnit, type ModelInputPlanning} from "@agent-anything/model-interaction/context";
import {applyModelInputOwnerForms, createOwnerModelWorkingView, modelInputValueDigest, modelInputFromSections,
  type ModelInputOwnerForm, type ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import type {ControllerCallContext, ControllerInput} from "./Controller.js";
import {ControllerCheckpointError} from "./ControllerCheckpoint.js";
import {ControllerError, type ControllerFailure, type ControllerOperationDeadline} from "./ControllerError.js";
import {RetryCheckpointError} from "../retry/RetryCheckpoint.js";
import {RetryInvocationInvalidatedError} from "../retry/RetryWaitControl.js";
import {createProviderInputDeliveryReceipt} from "./ControllerInputDelivery.js";
import {CONTEXT_PREPARATION_FLOW, CONTEXT_DISPATCH_FLOW} from "./ContextPreparationFlow.js";
import {prepareContextSemanticAccount, requestWithContextAccounts, type ControllerContextSemanticSupport} from "./ControllerContextTransformation.js";
import type {ModelInputAccount} from "@agent-anything/model-interaction/input";
import type {ProviderResponse} from "@agent-anything/model-interaction";
import {prepareContextBackground} from "./ControllerContextBackground.js";

export interface ControllerContextPreparation {
  readonly store: ContextPreparationStore;
  readonly semantic?: ControllerContextSemanticSupport;
  /** Trusted source adapters only. Absence supplies no replacement permission. */
  readonly forms?: {
    readonly revision: string;
    resolve(input: {readonly runId: string; readonly request: ProviderRequest; readonly retained: readonly ModelInputOwnerForm[];
      readonly signal: AbortSignal}): Promise<{readonly offered: readonly ModelInputOwnerForm[]; readonly expand: readonly string[]}>;
  };
  readonly materials?: {
    validate(runId: string, dependencies: readonly ModelInputSourceRef[]): Promise<void>;
    hold(runId: string, consumerId: string, dependencies: readonly ModelInputSourceRef[], purpose: "working_view" | "frozen_request"): Promise<void>;
    release(consumerId: string): Promise<void>;
  };
}
interface Selection {readonly id: string; readonly epoch: number; readonly viewId: string;}
interface Registration {readonly id: string; readonly epoch: number; readonly basis: string; readonly predecessor: Selection | null;}
interface Candidate {readonly request: ProviderRequest; readonly forms: readonly ModelInputOwnerForm[];
  readonly accounts?: readonly ModelInputAccount[]; readonly limitations: readonly string[];}
type PreparationFailure =
  | {readonly kind: "controller"; readonly failure: ControllerFailure; readonly operationSettlement: "unsettled" | "settled_failure"; readonly deadline: ControllerOperationDeadline | null}
  | {readonly kind: "checkpoint"; readonly key: string}
  | {readonly kind: "retry_checkpoint"; readonly operationId: string}
  | {readonly kind: "invalidated"}
  | {readonly kind: "error"; readonly name: string; readonly message: string};
const SELECTED = "context-preparation:selected.v1";
const ACTIVE = "context-preparation:registration.v1";
const POLICY = "controller-context-preparation.v1";
const STAGES = Object.freeze(["forms", "measured", "candidate", "admitted", "frozen"]);

/** Every candidate is non-authoritative until the conditional selection below. */
export async function prepareControllerContext(input: {
  readonly support: ControllerContextPreparation;
  readonly request: ProviderRequest;
  readonly controller: ControllerInput;
  readonly context: ControllerCallContext;
  readonly measure: (request: ProviderRequest, signal?: AbortSignal) => Promise<ProviderRequest>;
  readonly admit: (request: ProviderRequest, signal?: AbortSignal) => Promise<ProviderRequest>;
  readonly now: () => number;
  readonly auxiliary?: (request: ProviderRequest, signal?: AbortSignal) => Promise<ProviderResponse>;
  readonly background?: {
    measure(request: ProviderRequest, context: ControllerCallContext): Promise<ProviderRequest>;
    send(request: ProviderRequest, context: ControllerCallContext): Promise<ProviderResponse>;
  };
  readonly semanticTarget?: string;
  readonly rejectedInput?: {readonly digest: string; readonly code: "provider_context_window_exceeded"};
}): Promise<ProviderRequest> {
  const {support, context, controller} = input;
  const run = context.runCheckpoints;
  if (!run?.compareAndCommit) throw new ControllerCheckpointError("context_preparation_requires_conditional_run_commits");
  const key = `context-preparation:request:${input.request.requestId}`;
  const basis = modelInputValueDigest({request: input.request, batch: controller.inputDelivery ?? null,
    permission: controller.permission, forms: support.forms?.revision ?? null, semantic: support.semantic ?? null,
    semanticTarget: input.semanticTarget ?? null, rejectedInput: input.rejectedInput ?? null, policy: POLICY});
  let registration = run.read(key) as Registration | null;
  const predecessor = registration?.predecessor ?? run.read(SELECTED) as Selection | null;
  const previousRegistration = run.read(ACTIVE) as Registration | null;
  if (!registration) registration = {id: `context-preparation:${modelInputValueDigest({runId: controller.runId, requestId: input.request.requestId, basis})}`,
    epoch: (previousRegistration?.epoch ?? 0) + 1, basis, predecessor};
  if (registration.basis !== basis) throw new ControllerCheckpointError("context_preparation_basis_changed");
  const intent: ContextPreparationIntent = {id: registration.id, runId: controller.runId, basis, predecessor: registration.predecessor?.id ?? null,
    deadlineAt: context.retry.deadlineAt, stages: STAGES};
  const head = await support.store.open(intent);
  const flow = new ExecutionFlowPath(CONTEXT_PREPARATION_FLOW, context.executionFlow ?? {}, controller.runId,
    [{owner: "context", kind: "preparation", id: intent.id, revision: String(head.revision)},
      {owner: "model-interaction", kind: "request", id: input.request.requestId, revision: null}]);
  let selectionAttempted = false;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([context.cancellation.signal, cancellation.signal]);
  const deadline = setTimeout(() => cancellation.abort(new Error("context_preparation_deadline_exceeded")),
    Math.min(Math.max(0, Date.parse(intent.deadlineAt) - input.now()), 2_147_483_647));
  const check = () => {signal.throwIfAborted(); if (input.now() >= Date.parse(intent.deadlineAt)) throw new Error("context_preparation_deadline_exceeded");};
  const once = async <T>(stage: string, create: () => Promise<T>): Promise<T> => {
    const retained = await support.store.read(intent.id, stage) as {status: "ready"; value: T} | {status: "failed"; failure: PreparationFailure} | null;
    if (retained?.status === "failed") throw restorePreparationFailure(retained.failure);
    if (retained?.status === "ready") return retained.value;
    if (head.state !== "open") throw new ControllerCheckpointError("context_preparation_retired");
    check();
    let value: T;
    try {value = await boundedPreparation(create, signal, Date.parse(intent.deadlineAt) - input.now()); check();}
    catch (error) {
      const failure = snapshotPreparationFailure(error);
      await support.store.write(intent.id, stage, {status: "failed", failure});
      flow.current?.output(flow.material("Failed preparation stage", "failed", {preparationId: intent.id, stage, failure}, "provider"));
      throw error;
    }
    await support.store.write(intent.id, stage, {status: "ready", value});
    return value;
  };
  const dependencies = (forms: readonly ModelInputOwnerForm[]) => [...new Map(forms.flatMap(form => form.dependencies)
    .map(ref => [modelInputValueDigest(ref), ref])).values()];
  const retain = async (forms: readonly ModelInputOwnerForm[], purpose: "working_view" | "frozen_request") => {
    const refs = dependencies(forms);
    if (!refs.length) return;
    if (!support.materials) throw new TypeError("Owner form requires unavailable material retention and access.");
    await support.materials.validate(controller.runId, refs);
    await support.materials.hold(controller.runId, `${intent.id}:${purpose}`, refs, purpose);
  };
  try {
    const step = flow.advance("register", {preparationId: intent.id, epoch: registration.epoch, policy: POLICY,
      maximumStages: STAGES.length, maximumForms: input.request.composition.sections.length, deadlineAt: intent.deadlineAt},
      [flow.material("Preparation intent", "registered", intent, "provider")]);
    if (!run.read(key)) await run.compareAndCommit([{key: SELECTED, value: registration.predecessor}, {key: ACTIVE, value: previousRegistration}, {key, value: null}],
      [{key: ACTIVE, value: registration}, {key, value: registration}]);
    else await run.compareAndCommit([{key: ACTIVE, value: registration}], []);
    step.check("current_basis", "passed");
    check();
    const prepared = flow.advance("prepare", {preparationId: intent.id});
    const forms = await once("forms", async () => {
      const old = registration!.predecessor ? await support.store.read(registration!.predecessor.id, "candidate") as {status: string; value: Candidate} | null : null;
      if (registration!.predecessor && old?.status !== "ready") throw new ControllerCheckpointError("selected_context_missing");
      const retained = old?.value.forms ?? [];
      const accounts = old?.value.accounts ?? [];
      // Optional proposals are not authoritative state. A rejected proposal may leave
      // the unchanged, independently admitted view usable; retained access never is optional.
      let available: {offered: readonly ModelInputOwnerForm[]; expand: readonly string[]} = {offered: [], expand: []};
      const limitations: string[] = [];
      if (support.forms) {
        try {
          available = await boundedPreparation(() => support.forms!.resolve({runId: controller.runId, request: input.request, retained,
            signal}), signal, Date.parse(intent.deadlineAt) - input.now());
          check();
          if (available.offered.length > input.request.composition.sections.length || available.expand.length > retained.length) {
            throw new TypeError("Source-form proposal exceeds its admitted occurrence count.");
          }
        } catch (error) {check(); available = {offered: [], expand: []}; limitations.push(`optional_form_proposal_failed:${error instanceof Error ? error.name : "unknown"}`);}
      }
      const expanded = new Set(available.expand);
      if (available.expand.some(id => !input.request.composition.sections.some(section => section.id === id))) throw new TypeError("Expansion source is unavailable.");
      const kept = retained.filter(form => !expanded.has(form.sectionId));
      applyModelInputOwnerForms(input.request.composition.sections, kept, controller.runId);
      const offered: ModelInputOwnerForm[] = [];
      for (const form of available.offered) {
        if (expanded.has(form.sectionId)) continue;
        try {
          if (offered.some(other => other.sectionId === form.sectionId)) throw new TypeError("Repeated owner-form proposal.");
          applyModelInputOwnerForms(input.request.composition.sections, [form], controller.runId);
          if (form.dependencies.length) {
            if (!support.materials) throw new TypeError("No material access owner.");
            await support.materials.validate(controller.runId, form.dependencies);
          }
          offered.push(form);
        } catch (error) {check(); limitations.push(`optional_form_rejected:${form.id}:${error instanceof Error ? error.name : "unknown"}`);}
      }
      return {retained: kept, offered, accounts, limitations};
    });
    if (dependencies(forms.retained).length) {
      if (!support.materials) throw new TypeError("Retained form material access is unavailable.");
      await support.materials.validate(controller.runId, dependencies(forms.retained));
    }
    const base = requestWithContextAccounts(withForms(input.request, forms.retained, controller.runId), forms.accounts, controller.runId);
    const measured = snapshotProviderRequest(await once("measured", () => input.measure(base, signal)));
    const candidate = await once("candidate", async (): Promise<Candidate> => {
      const planning = measured.modelContext.assessment?.planning;
      const selected = chooseForms(input.request, measured, forms.retained, forms.offered,
        planning ?? null, controller.runId, forms.accounts, !!input.rejectedInput);
      await retain(selected.forms, "working_view");
      if (support.semantic && input.auxiliary && input.semanticTarget) {
        const current = await input.measure(selected.request, signal);
        const preparedGeneration = input.background ? await prepareContextBackground({store: support.store, request: current,
          runId: controller.runId, support: support.semantic, targetDigest: input.semanticTarget, context,
          capacityRejected: !!input.rejectedInput,
          measure: input.background.measure, send: input.background.send}) : undefined;
        const semantic = await prepareContextSemanticAccount({store: support.store, request: current, runId: controller.runId,
          preparationId: intent.id, deadlineAt: intent.deadlineAt, support: support.semantic, targetDigest: input.semanticTarget,
          ...(preparedGeneration ? {preparedGeneration} : {}),
          capacityRejected: !!input.rejectedInput,
          send: request => input.auxiliary!(request, signal), measure: request => input.measure(request, signal),
          guard: async () => {check(); await run.compareAndCommit!([{key: ACTIVE, value: registration}], []);},
          ...(context.executionFlow ? {executionFlow: context.executionFlow} : {})});
        return {...selected, request: semantic.request, accounts: [...forms.accounts, ...semantic.accounts],
          limitations: [...forms.limitations, ...selected.limitations, ...semantic.limitations]};
      }
      return {...selected, accounts: forms.accounts, limitations: [...forms.limitations, ...selected.limitations,
        ...(support.semantic && !input.auxiliary ? ["semantic_target_unsupported"] : [])]};
    });
    // Recheck bytes, access and authority even when all expensive stages were retained.
    const reconstructed = requestWithContextAccounts(withForms(input.request, candidate.forms, controller.runId), candidate.accounts ?? [], controller.runId);
    if (modelInputValueDigest(reconstructed.composition) !== modelInputValueDigest(candidate.request.composition)) throw new TypeError("Prepared owner form composition changed.");
    await retain(candidate.forms, "working_view");
    const admitted = snapshotProviderRequest(await once("admitted", () => input.admit(candidate.request, signal)));
    if (input.rejectedInput && modelInputValueDigest({instructions: admitted.instructions, messages: admitted.messages, interaction: admitted.interaction}) === input.rejectedInput.digest) {
      throw new ControllerError({kind: "model", failure: {code: "model_context_capacity_exceeded", message: "No admissible changed input is available after Provider context rejection.",
        retryable: false, metadata: {cause: input.rejectedInput.code}}}, "settled_failure");
    }
    if (admitted.requestId !== candidate.request.requestId ||
        modelInputValueDigest(admitted.composition) !== modelInputValueDigest(candidate.request.composition)) {
      throw new TypeError("Context admission cannot replace the prepared input; changed representations require a new preparation.");
    }
    createProviderInputDeliveryReceipt(controller.inputDelivery, admitted);
    prepared.output(flow.material("Prepared working input", "candidate", {preparationId: intent.id,
      view: admitted.composition.workingView, forms: candidate.forms, accounts: candidate.accounts ?? [], limitations: candidate.limitations}, "provider"));
    prepared.check("preservation", "passed");
    check();
    const selected: Selection = {id: intent.id, epoch: registration.epoch, viewId: admitted.composition.workingView.id};
    const selectionStep = flow.advance("select", {preparationId: intent.id, predecessorId: registration.predecessor?.id ?? null, viewId: selected.viewId});
    const current = run.read(SELECTED);
    selectionAttempted = true;
    if (modelInputValueDigest(current) === modelInputValueDigest(selected)) await run.compareAndCommit([{key: ACTIVE, value: registration}, {key: SELECTED, value: selected}], []);
    else await run.compareAndCommit([{key: ACTIVE, value: registration}, {key: SELECTED, value: registration.predecessor}], [{key: SELECTED, value: selected}]);
    selectionStep.check("predecessor_and_authority", "passed");
    await retain(candidate.forms, "frozen_request");
    const frozen = snapshotProviderRequest(await once("frozen", async () => admitted));
    const frozenKey = `${key}:frozen`;
    const frozenRef = {id: intent.id, requestId: frozen.requestId, digest: modelInputValueDigest(frozen),
      batch: controller.inputDelivery ? {id: controller.inputDelivery.id, revision: controller.inputDelivery.revision} : null};
    if (run.read(frozenKey) !== null && modelInputValueDigest(run.read(frozenKey)) !== modelInputValueDigest(frozenRef)) {
      throw new ControllerCheckpointError("frozen_context_changed");
    }
    await run.compareAndCommit([{key: ACTIVE, value: registration}, {key: SELECTED, value: selected}, {key: frozenKey, value: run.read(frozenKey)}],
      [{key: frozenKey, value: frozenRef}]);
    flow.advance("freeze", {preparationId: intent.id, requestId: frozenRef.requestId, requestDigest: frozenRef.digest},
      [flow.material("Frozen working request", "frozen", frozen, "provider")]).check("unchanged_pending_batch", "passed");
    await support.store.retire(intent.id, "request_frozen");
    flow.advance("retire", {preparationId: intent.id, reason: "request_frozen", holds: "retained_until_execution_release"})
      .check("durable_retirement", "passed");
    flow.close("returned");
    return frozen;
  } catch (error) {
    // Preserve immutable evidence and holds on uncertain Run commits. Dataset recovery
    // owns their eventual release; a failed optimization never proves abandonment.
    const reason = context.cancellation.signal.aborted ? "cancelled" : "failed";
    let retirement: "recorded" | "unconfirmed" = "unconfirmed";
    let holds: "retained" | "released" = "retained";
    try {
      await support.store.retire(intent.id, reason);
      retirement = "recorded";
      if (!selectionAttempted && (run.read(SELECTED) as Selection | null)?.id !== intent.id) {
        // Source-owner tombstones reject a late acquire, even if an adapter ignored cancellation.
        await support.materials?.release(`${intent.id}:working_view`);
        await support.materials?.release(`${intent.id}:frozen_request`);
        holds = "released";
      }
    } catch { /* Keep uncertain holds; execution storage diagnostics retain owner failures. */ }
    flow.current?.output(flow.material("Preparation retirement", retirement, {preparationId: intent.id, requestedReason: reason, retirement, holds}, "provider"));
    flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed");
    throw error;
  } finally {clearTimeout(deadline); cancellation.abort(new Error("context_preparation_retired"));}
}

/** R2 binds the final dispatch envelope, including continuation, to the selected
 * input. Continuation reset is a separate bounded dispatch with its own identity. */
export async function freezePreparedProviderRequest(request: ProviderRequest, context: ControllerCallContext, dispatchKey: string): Promise<void> {
  const run = context.runCheckpoints;
  if (!run?.compareAndCommit) throw new ControllerCheckpointError("context_preparation_requires_conditional_run_commits");
  const registration = run.read(`context-preparation:request:${request.requestId}`) as Registration | null;
  const selected = run.read(SELECTED) as Selection | null;
  if (!registration || selected?.id !== registration.id || selected.viewId !== request.composition.workingView.id) {
    throw new ControllerCheckpointError("dispatch_context_not_selected");
  }
  const key = `context-preparation:dispatch:${dispatchKey}`;
  const value = {preparationId: registration.id, requestId: request.requestId, digest: modelInputValueDigest(request)};
  const old = run.read(key);
  if (old !== null && modelInputValueDigest(old) !== modelInputValueDigest(value)) throw new ControllerCheckpointError("frozen_dispatch_changed");
  const flow = new ExecutionFlowPath(CONTEXT_DISPATCH_FLOW, context.executionFlow ?? {}, request.composition.workingView.recipientRunId!,
    [{owner: "context", kind: "preparation", id: registration.id, revision: String(registration.epoch)},
      {owner: "model-interaction", kind: "request", id: request.requestId, revision: null}]);
  const step = flow.advance("bind", {preparationId: registration.id, requestDigest: value.digest},
    [flow.material("Final Provider envelope", "frozen", request, "provider")]);
  try {
    await run.compareAndCommit([{key: ACTIVE, value: registration}, {key: SELECTED, value: selected}, {key, value: old}], old === null ? [{key, value}] : []);
    step.check("selected_view_and_authority", "passed"); flow.advance("ready"); flow.close("returned");
  } catch (error) {flow.close(context.cancellation.signal.aborted ? "cancelled" : "failed"); throw error;}
}

function snapshotPreparationFailure(error: unknown): PreparationFailure {
  if (error instanceof ControllerError) return {kind: "controller", failure: error.failure,
    operationSettlement: error.operationSettlement, deadline: error.deadline};
  if (error instanceof ControllerCheckpointError) return {kind: "checkpoint", key: error.key};
  if (error instanceof RetryCheckpointError) return {kind: "retry_checkpoint", operationId: error.operationId};
  if (error instanceof RetryInvocationInvalidatedError) return {kind: "invalidated"};
  return {kind: "error", name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message.slice(0, 2048) : "Unknown preparation failure"};
}

function restorePreparationFailure(failure: PreparationFailure): Error {
  switch (failure.kind) {
    case "controller": return new ControllerError(failure.failure, failure.operationSettlement, failure.deadline);
    case "checkpoint": return new ControllerCheckpointError(failure.key);
    case "retry_checkpoint": return new RetryCheckpointError(failure.operationId);
    case "invalidated": return new RetryInvocationInvalidatedError();
    case "error": return Object.assign(new Error(failure.message), {name: failure.name});
  }
}

async function boundedPreparation<T>(create: () => Promise<T>, signal: AbortSignal, remaining: number): Promise<T> {
  signal.throwIfAborted();
  if (remaining <= 0) throw new Error("context_preparation_deadline_exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(create), new Promise<T>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, {once: true});
      timer = setTimeout(() => reject(new Error("context_preparation_deadline_exceeded")), Math.min(remaining, 2_147_483_647));
    })]);
  } finally {if (timer) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort);}
}

function withForms(request: ProviderRequest, forms: readonly ModelInputOwnerForm[], runId: string): ProviderRequest {
  if (!forms.length) return request;
  const sections = applyModelInputOwnerForms(request.composition.sections, forms, runId);
  const projected = modelInputFromSections(sections);
  const workingView = createOwnerModelWorkingView({sections, recipientRunId: runId, boundary: "request", forms});
  return snapshotProviderRequest({...request, ...projected, modelContext: {...request.modelContext, assessment: null},
    composition: {...request.composition, ...projected, sections, workingView}});
}

function chooseForms(original: ProviderRequest, measured: ProviderRequest, retained: readonly ModelInputOwnerForm[],
  offered: readonly ModelInputOwnerForm[], planning: ModelInputPlanning | null, runId: string,
  accounts: readonly ModelInputAccount[], capacityRejected = false): Candidate {
  if (!planning || planning.measurement.status !== "measured" || planning.releaseTarget === null ||
      !capacityRejected && planning.measurement.amount <= (planning.workingTarget ?? Infinity) || !offered.length) {
    return {request: measured, forms: retained, limitations: planning ? [] : ["planning_target_unknown"]};
  }
  const retainedIds = new Set(retained.map(form => form.sectionId));
  const covered = new Set(accounts.flatMap(account => account.sources.map(source => source.sectionId)));
  const visible = new Set(measured.composition.sections.map(section => section.id));
  const all = new Map(offered.filter(form => visible.has(form.sectionId) && !covered.has(form.sectionId) && !retainedIds.has(form.sectionId) &&
    form.companions.every(id => visible.has(id) && !covered.has(id) && !retainedIds.has(id)))
    .map(form => [form.sectionId, form]));
  const ratio = planning.measurement.amount / Math.max(1, planning.footprint.bytes);
  const costs = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) * ratio;
  const units: ModelInputAllocationUnit[] = measured.composition.sections.map(section => {
    const form = all.get(section.id);
    const exact = {id: "exact", cost: costs(section.content), requires: []};
    const alternative = form ? {id: form.id, cost: costs(form.content), requires: form.companions.map(id => ({unitId: id, formId: "exact"}))} : null;
    return {id: section.id, group: section.role === "instruction" ? "request_bindings" : section.provenance?.purpose === "selected_material" ? "selected_material" : "working_conversation",
      forms: alternative && alternative.cost < exact.cost ? [alternative, exact] : [exact]};
  });
  const overhead = Math.max(0, planning.measurement.amount - measured.composition.sections.reduce((sum, section) => sum + costs(section.content), 0));
  units.unshift({id: "request-framing-and-definitions", group: "request_bindings", forms: [{id: "exact", cost: overhead, requires: []}]});
  const allocation = allocateModelInput(units, {target: capacityRejected ? 0 : planning.releaseTarget});
  const selected = [...retained, ...allocation.selected.flatMap(value => value.formId === "exact" ? [] : [all.get(value.unitId)!])];
  return {request: requestWithContextAccounts(withForms(original, selected, runId), accounts, runId), forms: selected,
    limitations: ["component_cost_is_planning_proxy", ...allocation.limitations]};
}
