import { createHash } from "node:crypto";
import { providerResponseUsage } from "@agent-anything/model-interaction";
import { modelInputSectionLocations } from "@agent-anything/model-interaction/input";
import type { ProviderObservation, ProviderObserver } from "@agent-anything/model-interaction/transport";
import type { InspectionJson, InspectionLink, InspectionRecordInput, InspectionSubjectRef } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";

type Link = NonNullable<InspectionRecordInput["links"]>[number];
export function inspectionLink(kind: InspectionLink["kind"], from: InspectionSubjectRef, to: InspectionSubjectRef, details: Partial<Omit<Link, "from" | "to" | "kind">> = {}): Link {
  return { kind, from, to, condition: null, operation: null, sourceLocation: null, targetLocation: null, ...details };
}
export function inspectionContentId(recordId: string, index = 0): string { return createHash("sha256").update(`${recordId}:content:${index}`).digest("hex"); }

export class ProviderInspectionAdapter implements ProviderObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(value: ProviderObservation): void {
    const recorder = this.recorder;
    const run = value.runId ? recorder.ref("runtime", "run", value.runId, value.runId) : null;
    const request = recorder.ref("model-interaction", "request", value.requestId, value.runId);
    const attempt = recorder.ref("provider", "provider-attempt", value.attemptId, value.runId);
    const id = `provider:${value.attemptId}:${value.stage}`;
    const requestLinks = [inspectionLink("contains", request, attempt)];
    if (value.stage === "request" && value.request) {
      const semantic = value.request;
      const links: Link[] = run ? [inspectionLink("contains", run, request)] : [];
      if (value.controllerRequestId) links.push(inspectionLink("materializes", recorder.ref("runtime", "request", value.controllerRequestId, value.runId), request));
      recorder.offer({ id, subject: request, occurredAt: value.occurredAt,
        payload: { kind: "request", purpose: semantic.purpose, providerId: value.providerId, model: value.model, compositionId: semantic.composition.id, messageCount: semantic.messages.length, toolCount: semantic.interaction.kind === "native_tool_turn" ? semantic.interaction.callables.length : 0 },
        links, contents: [{ name: "Semantic request", stage: "semantic", class: "provider", mediaType: "application/json", value: semantic as unknown as InspectionJson }],
      });
      const locations = modelInputSectionLocations(semantic.composition.sections);
      for (const [index, section] of semantic.composition.sections.entries()) {
        const source = recorder.ref(section.source.owner, "contribution", section.source.id, value.runId, section.source.revision);
        const paths = locations.find((location) => location.sectionId === section.id)?.jsonPointers ?? [];
        recorder.offer({ id: `${id}:section:${index}`, subject: source, occurredAt: value.occurredAt,
          payload: { kind: "transfer", stage: "included", producerId: section.source.id, consumerId: semantic.requestId, operation: section.content.kind },
          links: paths.map((jsonPointer) => inspectionLink("includes", source, request, { operation: section.content.kind,
            sourceLocation: { contentId: inspectionContentId(id), partId: section.id, jsonPointer: `/composition/sections/${index}/content`, stage: "composition" },
            targetLocation: { contentId: inspectionContentId(id), partId: section.id, jsonPointer, stage: "semantic" } })),
        });
      }
      for (const [name, lineage] of Object.entries(semantic.composition.lineage)) {
        if (!lineage || typeof lineage !== "object" || Array.isArray(lineage) || !("owner" in lineage) || !("id" in lineage)) continue;
        const contextState = name === "activeContext" || name === "projectionManifest";
        const contribution = name === "contextProjection" || name === "interactionHistory" || name === "toolExposureContent" || name === "toolExposureProof" || name === "toolExposureBasis";
        const ref = recorder.ref(lineage.owner as string, contextState ? "context" : contribution ? "contribution" : "definition", lineage.id as string, contextState || contribution ? value.runId : null, "revision" in lineage ? lineage.revision as string | null : null);
        recorder.offer({ subject: ref, occurredAt: value.occurredAt, payload: { kind: "event", name: `request_binding.${name}`, code: null, sequence: null }, links: [inspectionLink("binding", ref, request)] });
      }
      if (semantic.interaction.kind === "native_tool_turn") {
        for (const callable of semantic.interaction.callables) {
          const revision = createHash("sha256").update(JSON.stringify(callable)).digest("hex");
          const definition = recorder.ref("model-interaction", "definition", callable.name, null, revision);
          recorder.offer({ id: `callable:${revision}:${recorder.capturePolicyRevision}`, subject: definition, occurredAt: null, payload: { kind: "definition", definitionKind: "tool", name: callable.name, revision, enabled: true }, contents: [{ name: "Model callable schema", stage: "callable", class: "definition", mediaType: "application/json", value: callable as unknown as InspectionJson }] });
          recorder.offer({ subject: request, occurredAt: value.occurredAt, payload: { kind: "event", name: "callable.exposed", sequence: null, code: null }, links: [inspectionLink("binding", definition, request)] });
        }
      }
    } else if (value.stage === "dispatch") {
      recorder.offer({ id, subject: attempt, occurredAt: value.occurredAt, payload: { kind: "transport", phase: "started", requestId: value.requestId, providerId: value.providerId, method: "POST", endpoint: value.endpoint ?? "unknown", httpStatus: null, status: value.status, code: value.code, encodedBytes: value.encodedBytes }, links: requestLinks,
        contents: [{ name: "Encoded request body", stage: "encoded_json", class: "provider", mediaType: "text/plain", value: value.body, ...(value.contentUnavailable ? { unavailableReason: "provider_diagnostic_limit" } : {}) }] });
      this.interval(value, "started", attempt);
    } else if (value.stage === "settled") {
      recorder.offer({ id, subject: attempt, occurredAt: value.occurredAt, payload: { kind: "transport", phase: value.endpoint ? "settled" : "rejected", requestId: value.requestId, providerId: value.providerId, method: "POST", endpoint: value.endpoint ?? "not_dispatched", httpStatus: value.httpStatus, status: value.status, code: value.code, encodedBytes: value.encodedBytes }, links: requestLinks,
        contents: [{ name: "Normalized Provider result", stage: "normalized", class: "provider", mediaType: "application/json", value: value.result as unknown as InspectionJson, ...(value.contentUnavailable ? { unavailableReason: "provider_diagnostic_limit" } : {}) }] });
      if (value.endpoint) this.interval(value, "settled", attempt);
      if (value.result?.kind === "succeeded") {
        const response = value.result.response;
        const usage = providerResponseUsage(response);
        const turn = response.kind === "native_tool_turn" ? response.turn : null;
        recorder.offer({ id: `${id}:response`, subject: request, occurredAt: value.occurredAt, payload: { kind: "response", status: "succeeded", finishReason: turn?.finish.kind ?? null, callCount: turn?.assistant.content.filter((block) => block.kind === "model_tool_call").length ?? 0, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null }, links: [inspectionLink("produces", attempt, request)] });
        if (turn) for (const block of turn.assistant.content) {
          if (block.kind !== "model_tool_call") continue;
          const call = recorder.ref("runtime", "call", block.call.modelCallRef.id, value.runId);
          recorder.offer({ subject: call, occurredAt: value.occurredAt, payload: { kind: "event", name: "model.call", sequence: null, code: null }, links: [inspectionLink("produces", request, call)], contents: [{ name: "Model call", stage: "decoded", class: "provider", mediaType: "application/json", value: block.call as unknown as InspectionJson }] });
        }
      }
    } else {
      recorder.offer({ id, subject: attempt, occurredAt: value.occurredAt, payload: { kind: "event", name: `provider.${value.stage}`, sequence: null, code: value.contentUnavailable ? "diagnostic_content_unavailable" : null }, links: requestLinks,
        contents: value.stage === "response_body" ? [{ name: "Consumed response", stage: value.representation ?? "unknown", class: "provider", mediaType: "application/json", value: value.body, ...(value.contentUnavailable ? { unavailableReason: "provider_diagnostic_limit" } : {}) }] : [] });
    }
  }
  private interval(value: ProviderObservation, phase: "started" | "settled", subject: InspectionSubjectRef): void {
    this.recorder.offer({ id: `${value.attemptId}:interval:${phase}`, subject, occurredAt: value.occurredAt, payload: { kind: "interval", phase, activity: "provider", status: phase === "settled" ? value.status : null, clock: this.recorder.manifest.producerInstanceId } });
  }
}
