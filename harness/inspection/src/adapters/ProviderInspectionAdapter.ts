import { createHash } from "node:crypto";
import { providerResponseUsage } from "@agent-anything/model-interaction";
import { retainInputPresentation } from "@agent-anything/agent-runtime/controller";
import type { ModelInputSourceRef } from "@agent-anything/model-interaction/input";
import { modelInputSectionLocations } from "@agent-anything/model-interaction/input";
import type { ProviderObservation, ProviderObserver } from "@agent-anything/model-interaction/transport";
import type { InspectionJson, InspectionLink, InspectionRecordInput, InspectionSubjectRef } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";

type Link = NonNullable<InspectionRecordInput["links"]>[number];
export function inspectionLink(kind: InspectionLink["kind"], from: InspectionSubjectRef, to: InspectionSubjectRef, details: Partial<Omit<Link, "from" | "to" | "kind">> = {}): Link {
  return { kind, from, to, condition: null, operation: null, sourceLocation: null, targetLocation: null, ...details };
}
export function inspectionContentId(recordId: string, index = 0): string { return createHash("sha256").update(`${recordId}:content:${index}`).digest("hex"); }
export function inspectionModelSource(recorder: InspectionRecorder, source: ModelInputSourceRef, runId: string | null): InspectionSubjectRef {
  return source.owner === "model-interaction" && source.kind === "request" ? recorder.ref("model-interaction", "request", source.id, source.runId ?? runId)
    : source.kind === "run_item" ? recorder.ref("runtime", "event", source.id, source.runId ?? runId)
    : recorder.ref(source.owner, "contribution", source.kind === "presentation" ? `presentation:${source.id}` : source.id,
      source.runId ?? runId, source.revision);
}

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
      const auxiliary = semantic.composition.lineage.auxiliary;
      if (auxiliary) {
        const method = recorder.ref(auxiliary.method.owner, "definition", auxiliary.method.id, null, auxiliary.method.revision);
        const basis = inspectionModelSource(recorder, auxiliary.basis, value.runId);
        recorder.offer({id: `${id}:auxiliary-method`, subject: method, occurredAt: value.occurredAt,
          payload: {kind: "definition", definitionKind: "instructions", name: `Context ${auxiliary.purpose === "context_generation" ? "generation" : "assessment"} method`,
            revision: auxiliary.method.revision ?? "unknown", enabled: true},
          links: [inspectionLink("binding", method, request, {operation: auxiliary.purpose})],
          contents: [{name: "Transformation method and output schema", stage: "auxiliary_method", class: "definition", mediaType: "application/json",
            value: semantic.metadata.transformationMethod ?? null,
            ...(semantic.metadata.transformationMethod === undefined ? {unavailableReason: "method_body_not_recorded"} : {})}]});
        recorder.offer({id: `${id}:auxiliary-basis`, subject: basis, occurredAt: value.occurredAt,
          payload: {kind: "event", name: `${auxiliary.purpose}.basis_bound`, sequence: null, code: null},
          links: [inspectionLink("binding", basis, request, {targetLocation: {contentId: inspectionContentId(id), partId: null,
            jsonPointer: "/messages", stage: "source_and_background"}})]});
        const generation = semantic.metadata.contextGeneration;
        if (generation && typeof generation === "object" && "requestId" in generation && typeof generation.requestId === "string") {
          recorder.offer({id: `${id}:generation-source`, subject: request, occurredAt: value.occurredAt,
            payload: {kind: "event", name: "context_assessment.generation_bound", sequence: null, code: null},
            links: [inspectionLink("observes", recorder.ref("model-interaction", "request", generation.requestId, value.runId), request,
              {operation: "assessed_generation"})]});
        }
      }
      const assessment = semantic.modelContext?.assessment;
      const planning = assessment?.planning;
      if (planning && assessment) {
        const planned = recorder.ref("model-interaction", "context", planning.id, value.runId, planning.revision);
        recorder.offer({id: `${id}:planning`, subject: planned, occurredAt: value.occurredAt,
          payload: {kind: "context_planning", requestId: semantic.requestId, planningId: planning.id,
            disposition: assessment.disposition, measurement: assessment.measurement.status === "measured"
              ? assessment.measurement.estimator.accuracy : "unknown",
            inputTokens: assessment.measurement.status === "measured" ? assessment.measurement.amount : null,
            proxyBytes: planning.footprint.bytes, workingTarget: planning.workingTarget,
            anchorRequestId: planning.anchor?.requestId ?? null, limitationCount: planning.limitations.length},
          links: [inspectionLink("binding", planned, request, {targetLocation: {contentId: inspectionContentId(id),
            partId: null, jsonPointer: "/modelContext/assessment/planning", stage: "planning"}}),
            ...(planning.anchor ? [inspectionLink("observes", planned,
              recorder.ref("model-interaction", "request", planning.anchor.requestId, planning.runId), {operation: "accepted_usage_anchor"})] : [])]});
      }
      const view = semantic.composition.workingView;
      const viewRef = recorder.ref("model-interaction", "context", view.id, value.runId, String(view.version));
      recorder.offer({id: `${id}:working-view`, subject: viewRef, occurredAt: value.occurredAt,
        payload: {kind: "working_view", stage: "included", requestId: semantic.requestId, recipientRunId: view.recipientRunId,
          version: view.version, selectionCount: view.entries.length, groupCount: view.nativeGroups.length},
        links: [inspectionLink("binding", viewRef, request, {targetLocation: {contentId: inspectionContentId(id),
          partId: null, jsonPointer: "/composition/workingView", stage: "composition"}})]});
      for (const [index, entry] of view.entries.entries()) {
        const selection = recorder.ref("model-interaction", "contribution", `${view.id}:selection:${index}`, value.runId, entry.digest);
        const form = view.forms?.find(form => form.sectionId === entry.sectionId);
        const account = view.accounts?.find(account => account.section.id === entry.sectionId);
        recorder.offer({id: `${id}:selection:${index}`, subject: selection, occurredAt: value.occurredAt,
          payload: {kind: "working_selection", requestId: semantic.requestId, sectionId: entry.sectionId, position: index,
            digest: entry.digest, representation: entry.representation, obligationCount: entry.preservation.obligations.length,
            relationshipCount: entry.preservation.relationships.length, protection: entry.protection},
          links: [inspectionLink("contains", viewRef, selection), ...entry.sources.map(source =>
            inspectionLink("binding", inspectionModelSource(recorder, source, value.runId), selection)),
            ...(account ? [inspectionLink("observes", inspectionModelSource(recorder, account.assessment, value.runId), selection,
              {operation: "scope_bound_semantic_assessment"}), ...account.sources.map(source => inspectionLink("transforms",
                inspectionModelSource(recorder, source.source, value.runId), selection, {operation: "semantic_account"}))] : []),
            ...(form ? [inspectionLink("transforms", inspectionModelSource(recorder, entry.source, value.runId), selection, {operation: form.method}),
              ...form.dependencies.map(source => inspectionLink("binding", inspectionModelSource(recorder, source, value.runId), selection,
                {operation: "retained_material_access"}))] : []),
            inspectionLink("includes", selection, request, {sourceLocation: {contentId: inspectionContentId(id), partId: entry.sectionId,
              jsonPointer: `/composition/workingView/entries/${index}`, stage: "selection"},
              targetLocation: {contentId: inspectionContentId(id), partId: entry.sectionId,
                jsonPointer: `/composition/sections/${index}`, stage: "composition"}})],
          ...(form || account ? {contents: [{name: account ? "Assessed historical account" : "Source-owned representation", stage: "selection", class: "provider" as const,
            mediaType: "application/json", value: (account ?? form) as unknown as InspectionJson}]} : {})});
      }
      for (const [index, group] of view.nativeGroups.entries()) {
        const groupRef = recorder.ref("model-interaction", "context", `${view.id}:group:${index}`, value.runId, "1");
        recorder.offer({id: `${id}:native-group:${index}`, subject: groupRef, occurredAt: value.occurredAt,
          payload: {kind: "native_group", requestId: semantic.requestId, turnId: group.turnId, callCount: group.callIds.length,
            settledCallCount: group.settledCallIds.length, status: group.status, protection: group.protection},
          links: [inspectionLink("contains", viewRef, groupRef), ...group.callIds.map(callId =>
            inspectionLink("binding", recorder.ref("runtime", "call", callId, group.originRunId), groupRef)),
            inspectionLink("binding", groupRef, request, {targetLocation: {contentId: inspectionContentId(id), partId: null,
              jsonPointer: `/composition/workingView/nativeGroups/${index}`, stage: "composition"}})]});
      }
      for (const [messageIndex, message] of semantic.messages.entries()) {
        for (const [blockIndex, block] of message.content.entries()) {
          if (block.kind !== "model_tool_result") continue;
          const origin = block.result.sourceRefs.find(source => source.owner === "agent-runtime" &&
            source.kind === "model_call" && source.id === block.result.modelCallRef.id && source.runId !== undefined);
          if (origin === undefined) continue;
          const sectionIndex = semantic.composition.sections.findIndex(section => section.content.kind === "model_message" && section.content.message.role === "tool" &&
            section.content.message.content.some(item => item.result.modelCallRef.id === block.result.modelCallRef.id));
          const form = view.forms?.find(form => form.sectionId === semantic.composition.sections[sectionIndex]?.id);
          const entry = view.entries[sectionIndex];
          const presentation = form && entry ? recorder.ref("model-interaction", "contribution", `${view.id}:selection:${sectionIndex}`, value.runId, entry.digest)
            : recorder.ref("runtime", "contribution", `${origin.id}:presentation`, origin.runId!, "1");
          const operation = form ? "owner_form_result_history" : "model_result_history";
          recorder.offer({id: `${id}:result:${messageIndex}:${blockIndex}`, subject: presentation, occurredAt: value.occurredAt,
            payload: {kind: "transfer", stage: "included", producerId: origin.id, consumerId: semantic.requestId, operation},
            links: [inspectionLink("includes", presentation, request, {operation,
              targetLocation: {contentId: inspectionContentId(id), partId: null,
                jsonPointer: `/messages/${messageIndex}/content/${blockIndex}/result`, stage: "semantic"}})]});
        }
      }
      for (const [index, section] of semantic.composition.sections.entries()) {
        const provenance = section.provenance;
        const retained = provenance ? retainInputPresentation(section) : null;
        const form = view.forms?.find(form => form.sectionId === section.id);
        const source = retained ? recorder.ref("agent-runtime", "contribution", `presentation:${section.id}`, value.runId, retained.digest)
          : form ? recorder.ref("model-interaction", "contribution", `${view.id}:selection:${index}`, value.runId, view.entries[index]!.digest)
          : inspectionModelSource(recorder, section.source, value.runId);
        const paths = locations.find((location) => location.sectionId === section.id)?.jsonPointers ?? [];
        recorder.offer({ id: `${id}:section:${index}`, subject: source, occurredAt: value.occurredAt,
          payload: provenance && retained ? {kind: "conversation", stage: "included", purpose: provenance.purpose, author: provenance.author,
            role: section.role, recipientRunId: provenance.recipientRunId, originRunId: provenance.originRunId ?? null,
            requestId: semantic.requestId, attemptId: value.attemptId, position: index, presenter: `${provenance.presenter.id}@${provenance.presenter.revision}`,
            digest: retained.digest, delivery: provenance.purpose === "imported_history" ? "import" : provenance.retainedPresentation ? "replay" : "new",
            sourceCount: provenance.sources.length}
            : { kind: "transfer", stage: "included", producerId: section.source.id, consumerId: semantic.requestId, operation: section.kind },
          links: [...paths.map((jsonPointer) => inspectionLink("includes", source, request, { operation: section.kind,
            sourceLocation: { contentId: inspectionContentId(id), partId: section.id, jsonPointer: `/composition/sections/${index}/content`, stage: "composition" },
            targetLocation: { contentId: inspectionContentId(id), partId: section.id, jsonPointer, stage: "semantic" } })),
            ...(provenance?.sources ?? []).map(origin => inspectionLink("transforms",
              inspectionModelSource(recorder, origin, value.runId), source, {operation: provenance!.purpose})),
            ...(provenance?.retainedPresentation ? [inspectionLink("transforms",
              inspectionModelSource(recorder, provenance.retainedPresentation, value.runId), source,
              {operation: provenance.purpose === "imported_history" ? "scoped_history_import" : "retained_history_replay"})] : [])],
          ...(section.provenance === undefined ? {} : {contents: [{name: "Presentation provenance", stage: "composition",
            class: "provider" as const, mediaType: "application/json", value: section.provenance as unknown as InspectionJson}]}),
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
        if (usage) recorder.offer({id: `${id}:usage`, subject: request, occurredAt: value.occurredAt,
          payload: {kind: "event", name: "provider.usage_observed", sequence: null,
            code: usage.metadata.accountingConsistent === false ? "usage_accounting_inconsistent" : null},
          links: [inspectionLink("produces", attempt, request)],
          contents: [{name: "Reported usage and cache accounting", stage: "usage", class: "provider", mediaType: "application/json", value: usage as unknown as InspectionJson}]});
        const turn = response.kind === "native_tool_turn" ? response.turn : null;
        recorder.offer({ id: `${id}:response`, subject: request, occurredAt: value.occurredAt, payload: { kind: "response", status: "succeeded", finishReason: turn?.finish.kind ?? null, callCount: turn?.assistant.content.filter((block) => block.kind === "model_tool_call").length ?? 0, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null }, links: [inspectionLink("produces", attempt, request)] });
        if (turn) {
          const modelTurn = recorder.ref("runtime", "turn", turn.turnId, value.runId);
          recorder.offer({ subject: modelTurn, occurredAt: value.occurredAt,
            payload: { kind: "event", name: "model_turn.decoded", sequence: null, code: null },
            links: [inspectionLink("produces", request, modelTurn), inspectionLink("produces", attempt, modelTurn, {
              targetLocation: {contentId: inspectionContentId(id), partId: null, jsonPointer: "/response/turn", stage: "normalized"},
            }), ...(run ? [inspectionLink("contains", run, modelTurn)] : []),
            ...(value.controllerRequestId ? [inspectionLink("materializes", recorder.ref("runtime", "request", value.controllerRequestId, value.runId), modelTurn)] : [])],
          });
          for (const block of turn.assistant.content) {
            if (block.kind !== "model_tool_call") continue;
            const call = recorder.ref("runtime", "call", block.call.modelCallRef.id, value.runId);
            recorder.offer({ subject: call, occurredAt: value.occurredAt, payload: { kind: "event", name: "model.call", sequence: null, code: null }, links: [inspectionLink("produces", request, call), inspectionLink("contains", modelTurn, call)], contents: [{ name: "Model call", stage: "decoded", class: "provider", mediaType: "application/json", value: block.call as unknown as InspectionJson }] });
          }
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
