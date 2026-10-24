import { createHash } from "node:crypto";
import { snapshotModelMessage, type ModelMessage, type ProviderRequest } from "@agent-anything/model-interaction";
import { modelInputSectionLocations, snapshotModelInputSection, selectModelWorkingView, type ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
import type { RunInputNotification } from "../runner/RunInputNotifications.js";

export interface ControllerInputDeliveryBatch {
  readonly id: string;
  readonly revision: string;
  readonly runId: string;
  readonly entries: readonly RunInputNotification[];
}

export interface ControllerInputDeliveryReceipt {
  readonly batch: { readonly id: string; readonly revision: string; readonly runId: string };
  readonly entries: readonly { readonly sequence: number; readonly digest: string }[];
  readonly via:
    | { readonly kind: "controller"; readonly controllerRequestId: string }
    | { readonly kind: "provider"; readonly requestId: string; readonly compositionId: string;
        readonly workingViewId: string;
        readonly sectionIds: readonly string[]; readonly presentations: readonly RetainedInputPresentation[] };
}

export interface RetainedInputPresentation {
  readonly digest: string;
  readonly section: ModelInputSectionCandidate;
}

export function retainInputPresentation(section: ModelInputSectionCandidate): RetainedInputPresentation {
  const retained = snapshotModelInputSection(section);
  return Object.freeze({digest: `sha256:${createHash("sha256").update(JSON.stringify(retained)).digest("hex")}`, section: retained});
}

export function snapshotInputPresentation(value: RetainedInputPresentation): RetainedInputPresentation {
  const retained = retainInputPresentation(value.section);
  if (value.digest !== retained.digest) throw new TypeError("Input presentation content digest mismatch.");
  return retained;
}

export function inputNotificationDigest(entry: RunInputNotification): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`;
}

export function inputNotificationMessage(entry: RunInputNotification): ModelMessage {
  if (entry.interpretation !== undefined && entry.interpretation.kind !== "notification") {
    const feedback = entry.interpretation.kind === "controller_feedback";
    return snapshotModelMessage({role: "user", content: [{kind: "text", text:
      `${feedback ? "Host Controller feedback" : "Applied steering instruction"}:\n${JSON.stringify({
        kind: entry.interpretation.kind, source: entry.source,
        interaction: entry.interpretation, payload: entry.data,
      })}`,
    }]});
  }
  return snapshotModelMessage({role: "user", content: [{kind: "text", text: JSON.stringify({
    kind: "host_notification", instructionRole: "data", source: entry.source,
    ...(entry.interpretation?.kind === "notification" ? {purpose: entry.interpretation.purpose,
      author: entry.interpretation.author, originRunId: entry.interpretation.originRunId} : {}),
    occurredAt: entry.occurredAt, payload: entry.data,
  })}]});
}

export function createInputDeliverySections(batch: ControllerInputDeliveryBatch | null | undefined): readonly ModelInputSectionCandidate[] {
  if (batch == null) return Object.freeze([]);
  return Object.freeze(batch.entries.map(entry => Object.freeze({
    id: `${batch.id}:entry:${entry.sequence}`,
    source: Object.freeze({owner: "agent-runtime", kind: "input_delivery", id: batch.id, revision: batch.revision}),
    kind: "input_notification", role: "user", necessity: "mandatory",
    content: Object.freeze({kind: "model_message", message: inputNotificationMessage(entry)}),
    preservation: {obligations: [{id: "addressed-input", requirement: "account" as const,
      basis: "Retain the addressed input, its author and its correction or outcome role."}], relationships: []},
    provenance: Object.freeze({purpose: entry.interpretation?.kind === "notification" ? entry.interpretation.purpose :
      entry.interpretation?.kind === "steering" ? "intervention" :
      entry.interpretation?.kind === "controller_feedback" ? "correction" : "later_outcome", recipientRunId: batch.runId,
      author: entry.interpretation?.kind === "notification" ? entry.interpretation.author :
        entry.interpretation?.kind === "steering" ? "accepted_intervention" : "host", sources: Object.freeze([entry.source]),
      originRunId: entry.interpretation?.kind === "notification" ? entry.interpretation.originRunId : entry.runId,
      presenter: Object.freeze({owner: "agent-runtime", kind: "presenter", id: "input-notification", revision: "2"}),
      coverage: Object.freeze([`${entry.source.id}@${entry.source.revision}`]), limitations: Object.freeze([])}),
  })));
}

export function createControllerInputDeliveryReceipt(
  batch: ControllerInputDeliveryBatch, controllerRequestId: string,
): ControllerInputDeliveryReceipt {
  requireToken(controllerRequestId);
  return receipt(batch, Object.freeze({kind: "controller", controllerRequestId}));
}

/** Validate the actual admitted composition, not the pre-projection estimate. */
export function createProviderInputDeliveryReceipt(
  batch: ControllerInputDeliveryBatch | null | undefined, request: ProviderRequest,
): ControllerInputDeliveryReceipt | null {
  if (batch == null) return null;
  const sections = createInputDeliverySections(batch);
  let previous = -1;
  for (const section of sections) {
    const index = request.composition.sections.findIndex(candidate => candidate.id === section.id);
    if (index <= previous || retainInputPresentation(request.composition.sections[index]!).digest !== retainInputPresentation(section).digest) {
      throw new TypeError("The admitted request must include the complete, unchanged input-delivery batch.");
    }
    if (request.composition.sections.slice(index + 1).some(candidate => candidate.role === "tool" || candidate.role === "assistant")) {
      throw new TypeError("Pending input delivery must follow the complete interaction history.");
    }
    // Composition snapshots guarantee sections and messages agree; also require a concrete location.
    if (modelInputSectionLocations(request.composition.sections).filter(location => location.sectionId === section.id).length !== 1) {
      throw new TypeError("Input delivery has no unambiguous request location.");
    }
    previous = index;
  }
  if (request.composition.workingView?.recipientRunId !== batch.runId) throw new TypeError("Input-delivery working-view recipient mismatch.");
  selectModelWorkingView(request.composition.workingView, request.composition.sections);
  return receipt(batch, Object.freeze({kind: "provider", requestId: request.requestId,
    workingViewId: request.composition.workingView.id,
    compositionId: request.composition.id, sectionIds: Object.freeze(sections.map(section => section.id)),
    presentations: Object.freeze(sections.map(section => retainInputPresentation(request.composition.sections.find(value => value.id === section.id)!)))}));
}

export function snapshotInputDeliveryReceipt(
  value: ControllerInputDeliveryReceipt | null | undefined,
  batch: ControllerInputDeliveryBatch | null | undefined,
): ControllerInputDeliveryReceipt | null {
  if (value == null) return null;
  if (batch == null || value.batch?.id !== batch.id || value.batch.revision !== batch.revision || value.batch.runId !== batch.runId ||
      !Array.isArray(value.entries) || JSON.stringify(value.entries) !== JSON.stringify(members(batch))) {
    throw new TypeError("Input-delivery receipt does not match the prepared batch.");
  }
  if (value.via?.kind === "controller") {
    return createControllerInputDeliveryReceipt(batch, value.via.controllerRequestId);
  }
  if (value.via?.kind !== "provider" || JSON.stringify(value.via.sectionIds) !==
      JSON.stringify(batch.entries.map(entry => `${batch.id}:entry:${entry.sequence}`)) ||
      !Array.isArray(value.via.presentations) || value.via.presentations.length !== batch.entries.length) {
    throw new TypeError("Invalid input-delivery receipt provenance.");
  }
  requireToken(value.via.requestId);
  requireToken(value.via.compositionId);
  requireToken(value.via.workingViewId);
  const via = value.via;
  const presentations = via.presentations.map((presentation, index) => {
    const retained = snapshotInputPresentation(presentation);
    const section = retained.section;
    const entry = batch.entries[index]!;
    if (section.id !== via.sectionIds[index] || section.kind !== "input_notification" || section.role !== "user" ||
        section.necessity !== "mandatory" || section.content.kind !== "model_message" || section.content.message.role !== "user" ||
        section.source.id !== batch.id || section.source.revision !== batch.revision || section.provenance?.recipientRunId !== batch.runId ||
        JSON.stringify(section.provenance.sources) !== JSON.stringify([entry.source])) {
      throw new TypeError("Retained input presentation source or recipient mismatch.");
    }
    return retained;
  });
  return receipt(batch, Object.freeze({...value.via, sectionIds: Object.freeze([...value.via.sectionIds]), presentations: Object.freeze(presentations)}));
}

function receipt(batch: ControllerInputDeliveryBatch, via: ControllerInputDeliveryReceipt["via"]): ControllerInputDeliveryReceipt {
  return Object.freeze({batch: Object.freeze({id: batch.id, revision: batch.revision, runId: batch.runId}),
    entries: members(batch), via});
}

function members(batch: ControllerInputDeliveryBatch): ControllerInputDeliveryReceipt["entries"] {
  return Object.freeze(batch.entries.map(entry => Object.freeze({sequence: entry.sequence, digest: inputNotificationDigest(entry)})));
}

function requireToken(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Input-delivery identity must be non-empty.");
}
