import { createHash } from "node:crypto";
import { snapshotProviderRequest, modelCallRefKey, type ModelToolCall, type ProviderRequest } from "@agent-anything/model-interaction";
import { modelInputFromSections, modelInputSectionLocations } from "@agent-anything/model-interaction/input";
import type { ControllerCheckpointPort } from "./ControllerCheckpoint.js";
import { retainInputPresentation, snapshotInputPresentation, type RetainedInputPresentation } from "./ControllerInputDelivery.js";

export interface ConversationOpeningReceipt {
  readonly runId: string;
  readonly requestId: string;
  readonly compositionId: string;
  readonly presentations: readonly RetainedInputPresentation[];
  readonly digest: string;
}

export interface ModelConversationSeed {
  readonly sourceRunId: string;
  readonly sourceRevision: string;
  readonly presentations: readonly RetainedInputPresentation[];
  readonly digest: string;
}

export async function freezeConversationOpening(request: ProviderRequest, runId: string,
  checkpoints?: ControllerCheckpointPort): Promise<ProviderRequest> {
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
  return snapshotProviderRequest({...request, ...modelInput, composition: {...request.composition, sections, ...modelInput}});
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function createConversationOpeningReceipt(runId: string, request: ProviderRequest): ConversationOpeningReceipt | null {
  const sections = request.composition.sections.filter(section => section.kind === "conversation_opening");
  if (sections.length === 0) return null;
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
    presentations: Object.freeze(sections.map(retainInputPresentation))};
  return snapshotConversationOpeningReceipt({...value, digest: digest(value)}, runId);
}

export function snapshotConversationOpeningReceipt(value: ConversationOpeningReceipt, runId: string): ConversationOpeningReceipt {
  if (value.runId !== runId || !value.requestId || !value.compositionId || !Array.isArray(value.presentations) || !value.presentations.length) {
    throw new TypeError("Conversation opening binding is invalid.");
  }
  const presentations = snapshotPresentations(value.presentations);
  if (presentations.some(({section}) => section.kind !== "conversation_opening" || section.provenance?.recipientRunId !== runId)) {
    throw new TypeError("Conversation opening recipient is invalid.");
  }
  const retained = {runId, requestId: value.requestId, compositionId: value.compositionId, presentations};
  if (value.digest !== digest(retained)) throw new TypeError("Conversation opening digest mismatch.");
  validateSettledConversation(presentations);
  return Object.freeze({...retained, digest: value.digest});
}

export function createModelConversationSeed(sourceRunId: string, sourceRevision: string,
  presentations: readonly RetainedInputPresentation[]): ModelConversationSeed {
  const value = {sourceRunId, sourceRevision, presentations: snapshotPresentations(presentations)};
  return snapshotModelConversationSeed({...value, digest: digest(value)});
}

export function snapshotModelConversationSeed(value: ModelConversationSeed): ModelConversationSeed {
  if (!value.sourceRunId || !value.sourceRevision || !Array.isArray(value.presentations)) throw new TypeError("Conversation seed binding is invalid.");
  const retained = {sourceRunId: value.sourceRunId, sourceRevision: value.sourceRevision, presentations: snapshotPresentations(value.presentations)};
  if (retained.presentations.some(item => item.section.provenance?.recipientRunId !== value.sourceRunId)) {
    throw new TypeError("Conversation seed contains another recipient's exchanges.");
  }
  if (value.digest !== digest(retained)) throw new TypeError("Conversation seed digest mismatch.");
  validateSettledConversation(retained.presentations);
  return Object.freeze({...retained, digest: value.digest});
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
  const pending = new Map<string, ModelToolCall>(), seen = new Set<string>();
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
