import { createHash } from "node:crypto";
import { snapshotProviderRequest, modelCallRefKey, type ModelCallableRequest, type ProviderRequest } from "@agent-anything/model-interaction";
import { modelInputFromSections, modelInputSectionLocations, createExactModelWorkingView, selectModelWorkingView, applyModelInputOwnerForms, type ModelWorkingView } from "@agent-anything/model-interaction/input";
import {applyModelInputAccounts} from "@agent-anything/model-interaction/input";
import type { ModelInteractionProjection } from "./TaskDecisionActivity.js";
import type { ActivityCheckpointPort } from "../activity/ActivityCheckpoint.js";
import { retainInputPresentation, snapshotInputPresentation, type RetainedInputPresentation } from "./DecisionInputDelivery.js";

export interface ConversationOpeningReceipt {
  readonly runId: string;
  readonly requestId: string;
  readonly compositionId: string;
  readonly workingViewId: string;
  readonly presentations: readonly RetainedInputPresentation[];
  readonly digest: string;
}

export interface ModelConversationSeed {
  readonly sourceRunId: string;
  readonly sourceRevision: string;
  readonly presentations: readonly RetainedInputPresentation[];
  readonly workingView: ModelWorkingView;
  readonly digest: string;
}

export async function freezeConversationOpening(request: ProviderRequest, runId: string,
  checkpoints?: ActivityCheckpointPort): Promise<ProviderRequest> {
  const proposed = createConversationOpeningReceipt(runId, request);
  if (!proposed || !checkpoints) return request;
  const key = "working-conversation-opening.v1";
  const saved = checkpoints.read(key);
  if (saved === null) {
    await checkpoints.commit(key, proposed);
    return request;
  }
  const opening = snapshotConversationOpeningReceipt(saved as ConversationOpeningReceipt, runId);
  const firstIndex = request.composition.sections.findIndex(section => section.kind === "conversation_opening");
  const rest = request.composition.sections.filter(section => section.kind !== "conversation_opening");
  const sections = [...rest.slice(0, firstIndex), ...opening.presentations.map(value => value.section), ...rest.slice(firstIndex)];
  const modelInput = modelInputFromSections(sections);
  const workingView = createExactModelWorkingView({sections, recipientRunId: runId, boundary: "request"});
  return snapshotProviderRequest({...request, ...modelInput, composition: {...request.composition, sections, workingView, ...modelInput}});
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function createConversationOpeningReceipt(runId: string, request: ProviderRequest): ConversationOpeningReceipt | null {
  const sections = request.composition.sections.filter(section => section.kind === "conversation_opening");
  if (sections.length === 0) return null;
  if (request.composition.workingView?.recipientRunId !== runId) throw new TypeError("Conversation opening working-view recipient mismatch.");
  selectModelWorkingView(request.composition.workingView, request.composition.sections);
  const first = request.composition.sections.indexOf(sections[0]!);
  if (request.composition.sections.slice(first, first + sections.length).some(section => section.kind !== "conversation_opening")) {
    throw new TypeError("Conversation opening must occupy a contiguous ordered request prefix after Instructions.");
  }
  if (request.composition.sections.slice(0, first).some(section => section.role !== "instruction")) {
    throw new TypeError("Conversation opening cannot be placed after accepted exchanges or later input.");
  }
  const locations = modelInputSectionLocations(request.composition.sections);
  if (sections.some(section => !locations.some(location => location.sectionId === section.id && location.jsonPointers.length > 0))) {
    throw new TypeError("Conversation opening is missing from the actual request.");
  }
  const value = {runId, requestId: request.requestId, compositionId: request.composition.id,
    workingViewId: request.composition.workingView.id,
    presentations: Object.freeze(sections.map(retainInputPresentation))};
  return snapshotConversationOpeningReceipt({...value, digest: digest(value)}, runId);
}

export function snapshotConversationOpeningReceipt(value: ConversationOpeningReceipt, runId: string): ConversationOpeningReceipt {
  if (value.runId !== runId || !value.requestId || !value.compositionId || !value.workingViewId || !Array.isArray(value.presentations) || !value.presentations.length) {
    throw new TypeError("Conversation opening binding is invalid.");
  }
  const presentations = snapshotPresentations(value.presentations);
  if (presentations.some(({section}) => section.kind !== "conversation_opening" || section.provenance?.recipientRunId !== runId)) {
    throw new TypeError("Conversation opening recipient is invalid.");
  }
  const retained = {runId, requestId: value.requestId, compositionId: value.compositionId, workingViewId: value.workingViewId, presentations};
  if (value.digest !== digest(retained)) throw new TypeError("Conversation opening digest mismatch.");
  validateSettledConversation(presentations);
  return Object.freeze({...retained, digest: value.digest});
}

export function createModelConversationSeed(sourceRunId: string, sourceRevision: string,
  presentations: readonly RetainedInputPresentation[]): ModelConversationSeed {
  const value = {sourceRunId, sourceRevision, presentations: snapshotPresentations(presentations),
    workingView: createExactModelWorkingView({sections: presentations.map(value => value.section), recipientRunId: sourceRunId, boundary: "request"})};
  return snapshotModelConversationSeed({...value, digest: digest(value)});
}

export function snapshotModelConversationSeed(value: ModelConversationSeed): ModelConversationSeed {
  if (!value.sourceRunId || !value.sourceRevision || !Array.isArray(value.presentations)) throw new TypeError("Conversation seed binding is invalid.");
  const retained = {sourceRunId: value.sourceRunId, sourceRevision: value.sourceRevision, presentations: snapshotPresentations(value.presentations), workingView: value.workingView};
  if (retained.presentations.some(item => item.section.provenance?.recipientRunId !== value.sourceRunId)) {
    throw new TypeError("Conversation seed contains another recipient's exchanges.");
  }
  if (value.digest !== digest(retained)) throw new TypeError("Conversation seed digest mismatch.");
  validateSettledConversation(retained.presentations);
  if (value.workingView?.recipientRunId !== value.sourceRunId || value.workingView.boundary !== "request") throw new TypeError("Conversation seed view binding is invalid.");
  selectModelWorkingView(value.workingView, retained.presentations.map(item => item.section));
  return Object.freeze({...retained, workingView: createExactModelWorkingView({sections: retained.presentations.map(item => item.section),
    recipientRunId: value.sourceRunId, boundary: "request"}), digest: value.digest});
}

/** Only selected coverage can suppress a source or become a continuation seed. */
export function selectConversationPresentations(interaction: ModelInteractionProjection): readonly RetainedInputPresentation[] {
  const available = canonicalConversationPresentations(interaction);
  const forms = applyModelInputOwnerForms(available.map(value => value.section), interaction.workingForms ?? [],
    interaction.workingView.recipientRunId!, "history");
  return Object.freeze(applyModelInputAccounts(forms, interaction.workingAccounts ?? [],
    interaction.workingView.recipientRunId!, "history").map(retainInputPresentation));
}

/** Immutable sources for preparation; this is not the selected working request. */
export function canonicalConversationPresentations(interaction: ModelInteractionProjection): readonly RetainedInputPresentation[] {
  const available = [...(interaction.opening?.presentations ?? []), ...(interaction.historyPresentations ?? [])];
  const byId = new Map(available.map(value => [value.section.id, value]));
  return Object.freeze(selectModelWorkingView(interaction.workingView, available.map(value => value.section))
    .map(section => byId.get(section.id)!));
}

export function importModelConversationSeed(value: ModelConversationSeed, recipientRunId: string): readonly RetainedInputPresentation[] {
  const seed = snapshotModelConversationSeed(value);
  return Object.freeze(seed.presentations.map((retained, index) => retainInputPresentation({...retained.section,
    id: `${recipientRunId}:opening:import:${index}`, kind: "conversation_opening",
    provenance: {...retained.section.provenance!, recipientRunId, purpose: "imported_history", originRunId: seed.sourceRunId,
      retainedPresentation: {owner: "agent-runtime", kind: "presentation", id: retained.section.id,
        revision: retained.digest, runId: seed.sourceRunId}, coverage: [...retained.section.provenance!.coverage, retained.digest]},
  })));
}

function snapshotPresentations(values: readonly RetainedInputPresentation[]): readonly RetainedInputPresentation[] {
  const presentations = values.map(snapshotInputPresentation);
  const identities = new Set<string>();
  for (const {section} of presentations) {
    if (section.role === "instruction" || identities.has(section.id) || !section.provenance) {
      throw new TypeError("Conversation data cannot contain Instructions, unbound sources, or duplicate occurrences.");
    }
    identities.add(section.id);
  }
  return Object.freeze(presentations);
}

function validateSettledConversation(presentations: readonly RetainedInputPresentation[]): void {
  if (!presentations.length) return;
  const pending = new Map<string, ModelCallableRequest>(), seen = new Set<string>();
  for (const message of modelInputFromSections(presentations.map(value => value.section)).messages) {
    if (message.role !== "tool" && pending.size) throw new TypeError("Conversation seed interrupts an unsettled Call/result group.");
    if (message.role === "assistant") for (const block of message.content) {
      if (block.kind !== "model_tool_call") continue;
      const key = modelCallRefKey(block.call.modelCallRef);
      if (seen.has(key)) throw new TypeError("Conversation seed repeats a model Call.");
      seen.add(key); pending.set(key, block.call);
    }
    if (message.role === "tool") for (const {result} of message.content) {
      const key = modelCallRefKey(result.modelCallRef), call = pending.get(key);
      if (!call || call.name !== result.name || JSON.stringify(call.providerCallRef) !== JSON.stringify(result.providerCallRef)) {
        throw new TypeError("Conversation seed result has no matching Call.");
      }
      pending.delete(key);
    }
  }
  if (pending.size) throw new TypeError("Conversation seed contains unsettled Calls.");
}
