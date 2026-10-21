import { createHash } from "node:crypto";
import { snapshotModelMessage, type ModelMessage, type ProviderRequest } from "@agent-anything/model-interaction";
import { modelInputSectionLocations, type ModelInputSectionCandidate } from "@agent-anything/model-interaction/input";
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
        readonly sectionIds: readonly string[] };
}

export function inputNotificationDigest(entry: RunInputNotification): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`;
}

export function inputNotificationMessage(entry: RunInputNotification): ModelMessage {
  if (entry.interpretation !== undefined) {
    const feedback = entry.interpretation.kind === "controller_feedback";
    return snapshotModelMessage({role: "user", content: [{kind: "text", text:
      `${feedback ? "Host Controller feedback" : "Applied steering instruction"}:\n${JSON.stringify({
        kind: entry.interpretation.kind, source: entry.source,
        interaction: entry.interpretation, payload: entry.data,
      })}`,
    }]});
  }
  return snapshotModelMessage({role: "user", content: [{kind: "text", text: JSON.stringify({
    kind: "host_notification", instructionRole: "data", notification: entry,
  })}]});
}

export function createInputDeliverySections(batch: ControllerInputDeliveryBatch | null | undefined): readonly ModelInputSectionCandidate[] {
  if (batch == null) return Object.freeze([]);
  return Object.freeze(batch.entries.map(entry => Object.freeze({
    id: `${batch.id}:entry:${entry.sequence}`,
    source: Object.freeze({owner: "agent-runtime", kind: "input_delivery", id: batch.id, revision: batch.revision}),
    kind: "input_notification", role: "user", necessity: "mandatory",
    content: Object.freeze({kind: "model_message", message: inputNotificationMessage(entry)}),
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
    if (index <= previous || JSON.stringify(request.composition.sections[index]) !== JSON.stringify(section)) {
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
  return receipt(batch, Object.freeze({kind: "provider", requestId: request.requestId,
    compositionId: request.composition.id, sectionIds: Object.freeze(sections.map(section => section.id))}));
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
      JSON.stringify(createInputDeliverySections(batch).map(section => section.id))) {
    throw new TypeError("Invalid input-delivery receipt provenance.");
  }
  requireToken(value.via.requestId);
  requireToken(value.via.compositionId);
  return receipt(batch, Object.freeze({...value.via, sectionIds: Object.freeze([...value.via.sectionIds])}));
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
