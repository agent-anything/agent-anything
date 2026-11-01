import {snapshotProviderRequest, snapshotProviderResponse, snapshotModelMessage, type ProviderRequest, type ProviderResponse} from "@agent-anything/model-interaction";
import {createExactModelWorkingView, declareModelResultTextSlot, fillModelResultTextSlot, readModelResultTextSlot,
  modelInputValueDigest, modelInputSectionLocations, type ModelInputResultTextBinding, type ModelInputSectionCandidate,
  type ModelToolMessage} from "@agent-anything/model-interaction/input";
import type {ContextSelectionSnapshot} from "@agent-anything/context/selection";
import {validatePreparedContextInput, type PreparedContextInput} from "../context-representation/ContextInputPreparation.js";
import {createControllerModelItems} from "./TaskDecisionModelItems.js";
import type {TaskDecisionModelItem} from "./TaskDecisionActivity.js";
import {snapshotTaskModelResponseRejection, validateTaskModelResponseRejectionRaw, type TaskModelResponseRejection} from "./TaskModelResponseRejection.js";

export interface SelectedResultPresentationReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly recipient: string;
  readonly purpose: string;
  readonly target: string;
  readonly controllerRequestId: string;
  readonly originalRequestId: string;
  readonly originalRequestDigest: string;
  readonly requestId: string;
  readonly compositionId: string;
  readonly workingViewId: string;
  readonly encodedInputId: string;
  readonly inputId: string;
  readonly selectionId: string;
  readonly inputAcceptanceId: string;
  readonly combinationJudgmentId: string;
  readonly responseAcceptanceId: string;
  readonly rawResultId: string;
  readonly responseDigest: string;
  readonly responseItemsDigest: string | null;
  readonly responseRejectionDigest: string | null;
  readonly groups: readonly {readonly turnId: string; readonly sections: readonly {readonly sectionId: string; readonly messageDigest: string}[]}[];
  readonly presentations: readonly {readonly sectionId: string; readonly bindings: readonly ModelInputResultTextBinding[]; readonly message: ModelToolMessage}[];
  readonly digest: string;
}

/** The task response owner records actual presentation, not a new settlement or a delivery command. */
export function createSelectedResultPresentationReceipt(input: {
  readonly originalRequest: ProviderRequest;
  readonly binding: ContextSelectionSnapshot;
  readonly response: ProviderResponse;
  readonly rawResultId: string;
  readonly responseAcceptanceId: string;
  readonly responseRejection?: TaskModelResponseRejection | null;
}): SelectedResultPresentationReceipt | null {
  const {binding} = input, prepared = binding.input.exactInput as PreparedContextInput;
  validatePreparedContextInput(prepared);
  const original = snapshotProviderRequest(input.originalRequest), actual = prepared.request;
  const declarations = prepared.demand.contributions.flatMap(contribution =>
    contribution.options.find(option => option.id === prepared.choice[contribution.id])!.resultTextBindings ?? []);
  // A changed native result cannot silently bypass the typed receipt by omitting its declaration.
  for (const section of actual.composition.sections) {
    const prior = original.composition.sections.find(value => value.id === section.id);
    if (section.role === "tool" && prior?.role === "tool" && !same(section.content, prior.content) &&
        !declarations.some(value => value.sectionId === section.id)) fail("undeclared_change");
  }
  if (!declarations.length) return null;
  const rejected = input.responseRejection ? snapshotTaskModelResponseRejection(input.responseRejection) : null;
  if (rejected) {
    validateTaskModelResponseRejectionRaw(rejected, input.response, actual);
    if (rejected.runId !== binding.scope.runId || rejected.requestId !== actual.requestId || rejected.controllerRequestId !== actual.correlation.controllerRequestId ||
        rejected.rawResultId !== input.rawResultId || rejected.responseAcceptanceId !== input.responseAcceptanceId) fail("binding_invalid");
  }
  if ((!rejected && (input.response.kind !== "native_tool_turn" || input.response.turn.finish.kind === "output_limit" ||
      input.response.turn.responseRef.providerId !== actual.composition.providerId || input.response.turn.responseRef.requestId !== actual.requestId)) ||
      original.interaction.kind !== "native_tool_turn" || actual.interaction.kind !== "native_tool_turn" ||
      original.composition.workingView.recipientRunId !== binding.scope.runId ||
      actual.composition.workingView.recipientRunId !== binding.scope.runId || prepared.demand.runId !== binding.scope.runId ||
      prepared.demand.recipient !== binding.scope.recipient || prepared.demand.purpose !== binding.scope.purpose ||
      original.purpose !== binding.scope.purpose || actual.purpose !== binding.scope.purpose ||
      prepared.demand.targetRevision !== binding.scope.target || binding.input.target !== binding.scope.target ||
      binding.input.scopeId !== binding.scope.id || binding.input.selectionId !== binding.selection.id ||
      !binding.selection.judgmentIds.includes(binding.input.combinationJudgmentId) ||
      !original.correlation?.controllerRequestId || original.correlation.controllerRequestId !== actual.correlation?.controllerRequestId)
    fail("binding_invalid");
  for (const declaration of declarations) {
    if (declaration.representation.kind !== "representation" ||
        !binding.selection.representations.some(ref => ref.id === declaration.representation.id && ref.revision === declaration.representation.revision))
      fail("representation_not_selected");
  }
  const ids = new Set(declarations.map(value => value.sectionId));
  const groups = original.composition.workingView.nativeGroups.filter(group => group.sectionIds.some(id => ids.has(id)));
  if ([...ids].some(id => !groups.some(group => group.sectionIds.includes(id)))) fail("native_group_missing");
  for (const group of groups) {
    if (group.originRunId !== binding.scope.runId) fail("native_group_recipient_invalid");
    const selected = actual.composition.workingView.nativeGroups.find(value => value.turnId === group.turnId);
    if (!selected || !same(selected.sectionIds, group.sectionIds) || !same(selected.callIds, group.callIds) ||
        !same(selected.settledCallIds, group.settledCallIds) || selected.originRunId !== group.originRunId) fail("native_group_changed");
    for (const id of group.sectionIds) {
      const prior = original.composition.sections.find(value => value.id === id)!;
      const next = actual.composition.sections.find(value => value.id === id)!;
      if (!ids.has(id) && !same(prior.content, next.content)) fail("native_group_changed");
    }
  }
  const locations = modelInputSectionLocations(actual.composition.sections);
  const presentations = actual.composition.sections.filter(section => ids.has(section.id)).map(section => {
    if (!locations.some(location => location.sectionId === section.id && location.jsonPointers.length)) fail("location_missing");
    return {sectionId: section.id, bindings: declarations.filter(value => value.sectionId === section.id), message: toolMessage(section)};
  });
  const value = {version: 1 as const, runId: binding.scope.runId, recipient: binding.scope.recipient, purpose: binding.scope.purpose,
    target: binding.scope.target, controllerRequestId: original.correlation!.controllerRequestId,
    originalRequestId: original.requestId, originalRequestDigest: modelInputValueDigest(original), requestId: actual.requestId,
    compositionId: actual.composition.id, workingViewId: actual.composition.workingView.id, encodedInputId: prepared.encoded.id,
    inputId: binding.input.id, selectionId: binding.selection.id, inputAcceptanceId: binding.acceptanceId,
    combinationJudgmentId: binding.input.combinationJudgmentId, responseAcceptanceId: input.responseAcceptanceId, rawResultId: input.rawResultId,
    responseDigest: rejected?.responseDigest ?? modelInputValueDigest(snapshotProviderResponse(input.response)),
    responseItemsDigest: rejected ? null : responseItemsDigest(createControllerModelItems((input.response as Extract<ProviderResponse, {kind: "native_tool_turn"}>).turn)),
    responseRejectionDigest: rejected?.digest ?? null,
    groups: groups.map(group => ({turnId: group.turnId, sections: group.sectionIds.map(sectionId => ({sectionId,
      messageDigest: messageDigest(original.composition.sections.find(section => section.id === sectionId)!)}))})), presentations};
  const receipt = snapshotSelectedResultPresentationReceipt({...value, digest: modelInputValueDigest(value)});
  validateSelectedResultPresentationInput(receipt, original, prepared, input.rawResultId, input.responseAcceptanceId);
  return receipt;
}

/** Local item identities and host metadata do not alter the native response that was actually accepted. */
export function validateSelectedResultPresentationResponse(receipt: SelectedResultPresentationReceipt, items: readonly TaskDecisionModelItem[],
  rejection?: TaskModelResponseRejection | null): void {
  if (rejection) {
    const rejected = snapshotTaskModelResponseRejection(rejection);
    if (items.length || receipt.responseItemsDigest !== null || receipt.responseRejectionDigest !== rejected.digest || receipt.responseDigest !== rejected.responseDigest ||
        receipt.runId !== rejected.runId || receipt.requestId !== rejected.requestId || receipt.controllerRequestId !== rejected.controllerRequestId ||
        receipt.rawResultId !== rejected.rawResultId || receipt.responseAcceptanceId !== rejected.responseAcceptanceId) fail("response_changed");
  } else if (receipt.responseRejectionDigest !== null || receipt.responseItemsDigest !== responseItemsDigest(items)) fail("response_changed");
}
function responseItemsDigest(items: readonly TaskDecisionModelItem[]): string {
  return modelInputValueDigest(items.map(({id: _, metadata: __, ...value}) => value));
}

/** Recovery checks the retained declaration and presentation against the original accepted input, not current selection. */
export function validateSelectedResultPresentationInput(value: SelectedResultPresentationReceipt, originalRequest: ProviderRequest,
  prepared: PreparedContextInput, rawResultId: string, responseAcceptanceId: string): void {
  const receipt = snapshotSelectedResultPresentationReceipt(value), original = snapshotProviderRequest(originalRequest);
  validatePreparedContextInput(prepared);
  if (receipt.originalRequestId !== original.requestId || receipt.originalRequestDigest !== modelInputValueDigest(original) ||
      receipt.requestId !== prepared.request.requestId || receipt.compositionId !== prepared.request.composition.id ||
      receipt.workingViewId !== prepared.request.composition.workingView.id || receipt.encodedInputId !== prepared.encoded.id ||
      receipt.runId !== prepared.demand.runId || receipt.recipient !== prepared.demand.recipient || receipt.purpose !== prepared.demand.purpose ||
      receipt.target !== prepared.demand.targetRevision || receipt.rawResultId !== rawResultId || receipt.responseAcceptanceId !== responseAcceptanceId ||
      receipt.controllerRequestId !== original.correlation?.controllerRequestId || receipt.controllerRequestId !== prepared.request.correlation?.controllerRequestId)
    fail("accepted_input_changed");
  const declarations = prepared.demand.contributions.flatMap(contribution =>
    contribution.options.find(option => option.id === prepared.choice[contribution.id])!.resultTextBindings ?? []);
  const canonical = (values: readonly ModelInputResultTextBinding[]) => values.map(modelInputValueDigest).sort();
  if (!same(canonical(declarations), canonical(receipt.presentations.flatMap(value => value.bindings)))) fail("accepted_declaration_changed");
  const rebuilt = applySelectedResultPresentations(receipt, original.composition.sections, receipt.runId, receipt.requestId, receipt.controllerRequestId);
  for (const group of receipt.groups) for (const member of group.sections) {
    const actual = prepared.request.composition.sections.find(section => section.id === member.sectionId);
    const expected = rebuilt.find(section => section.id === member.sectionId)!;
    if (!actual || !same(actual.content, expected.content)) fail("accepted_presentation_changed");
  }
}

/** Integrity is not authority: callers must still bind this receipt to its accepted response. */
export function snapshotSelectedResultPresentationReceipt(value: SelectedResultPresentationReceipt): SelectedResultPresentationReceipt {
  const {digest, ...body} = value;
  if (value.version !== 1 || digest !== modelInputValueDigest(body)) fail("receipt_changed");
  for (const key of ["runId", "recipient", "purpose", "target", "controllerRequestId", "originalRequestId", "originalRequestDigest", "requestId",
    "compositionId", "workingViewId", "encodedInputId", "inputId", "selectionId", "inputAcceptanceId", "combinationJudgmentId", "responseAcceptanceId", "rawResultId",
    "responseDigest"] as const)
    token(value[key]);
  if (value.responseItemsDigest === null) token(value.responseRejectionDigest);
  else {token(value.responseItemsDigest); if (value.responseRejectionDigest !== null) fail("receipt_invalid");}
  if (!Array.isArray(value.groups) || !value.groups.length || !Array.isArray(value.presentations) || !value.presentations.length) fail("receipt_invalid");
  const groups: SelectedResultPresentationReceipt["groups"] = value.groups;
  const presentations: SelectedResultPresentationReceipt["presentations"] = value.presentations;
  const turns = new Set<string>(), members = new Set<string>(), presented = new Set<string>();
  for (const group of groups) {
    token(group.turnId);
    if (turns.has(group.turnId) || !Array.isArray(group.sections) || group.sections.length < 2) fail("native_group_invalid");
    turns.add(group.turnId);
    for (const section of group.sections) {
      token(section.sectionId); token(section.messageDigest);
      if (members.has(section.sectionId)) fail("native_group_invalid");
      members.add(section.sectionId);
    }
  }
  for (const presentation of presentations) {
    if (!members.has(presentation.sectionId) || presented.has(presentation.sectionId) || !Array.isArray(presentation.bindings) || !presentation.bindings.length)
      fail("presentation_invalid");
    presented.add(presentation.sectionId);
    if (snapshotModelMessage(presentation.message).role !== "tool") fail("presentation_invalid");
    for (const declaration of presentation.bindings) {
      if (declaration.sectionId !== presentation.sectionId) fail("declaration_invalid");
      token(declaration.slot.callId); token(declaration.slot.resultDigest); token(declaration.slot.textDigest);
      for (const ref of [declaration.source, declaration.representation]) {
        token(ref.owner); token(ref.kind); token(ref.id); if (ref.revision !== null) token(ref.revision);
      }
      // Reading the actual leaf also validates the path without mistaking its digest for the original.
      declareModelResultTextSlot(presentation.message, declaration.slot.callId, declaration.slot.contentPath);
    }
    for (let i = 0; i < presentation.bindings.length; i++) for (let j = 0; j < i; j++) {
      const a = presentation.bindings[i]!.slot, b = presentation.bindings[j]!.slot;
      if (a.callId === b.callId && (prefix(a.contentPath, b.contentPath) || prefix(b.contentPath, a.contentPath))) fail("overlapping_declarations");
    }
  }
  if (groups.some(group => !group.sections.some(section => presented.has(section.sectionId)))) fail("unrelated_group");
  return structuredClone(value);
}

/** Rebuilds the accepted presentation from the original message; no execution fact is mutated. */
export function applySelectedResultPresentations(value: SelectedResultPresentationReceipt, sections: readonly ModelInputSectionCandidate[],
  runId: string, requestId: string, controllerRequestId: string): readonly ModelInputSectionCandidate[] {
  const receipt = snapshotSelectedResultPresentationReceipt(value);
  if (receipt.runId !== runId || receipt.requestId !== requestId || receipt.controllerRequestId !== controllerRequestId) fail("response_mismatch");
  const view = createExactModelWorkingView({sections, recipientRunId: runId, boundary: "history"});
  let lastGroup = -1;
  for (const group of receipt.groups) {
    const index = view.nativeGroups.findIndex(value => value.turnId === group.turnId), original = view.nativeGroups[index];
    if (index <= lastGroup || !original || original.originRunId !== runId || original.status !== "settled" || !same(original.sectionIds, group.sections.map(value => value.sectionId)))
      fail("native_group_changed");
    lastGroup = index;
    for (const member of group.sections) {
      const section = sections.find(value => value.id === member.sectionId);
      if (!section || messageDigest(section) !== member.messageDigest) fail("original_message_changed");
    }
  }
  let lastPresentation = -1;
  const replacements = new Map<string, ModelToolMessage>();
  for (const presentation of receipt.presentations) {
    const index = sections.findIndex(value => value.id === presentation.sectionId);
    if (index <= lastPresentation) fail("presentation_order_invalid");
    lastPresentation = index;
    const original = toolMessage(sections[index]!);
    let rebuilt = original;
    for (const {slot} of presentation.bindings) {
      readModelResultTextSlot(original, slot);
      const selected = declareModelResultTextSlot(presentation.message, slot.callId, slot.contentPath);
      const text = readModelResultTextSlot(presentation.message, selected);
      // All declarations bind the same original; non-overlapping replacements compose locally.
      rebuilt = fillModelResultTextSlot(rebuilt, declareModelResultTextSlot(rebuilt, slot.callId, slot.contentPath), text);
    }
    if (!same(rebuilt, presentation.message)) fail("undeclared_change");
    replacements.set(presentation.sectionId, rebuilt);
  }
  return sections.map(section => {
    const message = replacements.get(section.id);
    if (!message) return section;
    const bindings = receipt.presentations.find(value => value.sectionId === section.id)!.bindings;
    const sources = [...new Map([...(section.provenance?.sources ?? [section.source]),
      ...bindings.flatMap(value => [value.source, value.representation])].map(ref => [modelInputValueDigest(ref), ref])).values()];
    return {...section, content: {kind: "model_message" as const, message}, ...(section.provenance ? {provenance: {...section.provenance,
      sources, presenter: {owner: "agent-runtime", kind: "result_presentation_receipt", id: receipt.digest, revision: "1", runId},
      limitations: [...section.provenance.limitations, "Native result body uses an accepted derived presentation; original execution facts are retained."]}} : {})};
  });
}

function messageDigest(section: ModelInputSectionCandidate): string {
  if (section.content.kind !== "model_message") fail("native_message_required");
  return modelInputValueDigest(section.content.message);
}
function toolMessage(section: ModelInputSectionCandidate): ModelToolMessage {
  if (section.role !== "tool" || section.content.kind !== "model_message" || section.content.message.role !== "tool") fail("native_result_required");
  return section.content.message;
}
function prefix(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length <= b.length && a.every((value, index) => value === b[index]);
}
function token(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail("identity_invalid");
}
function same(a: unknown, b: unknown): boolean {return modelInputValueDigest(a) === modelInputValueDigest(b);}
function fail(code: string): never {throw new TypeError(`selected_result_presentation_${code}`);}
