import type { RunExecutionObserver, RunExecutionObservation } from "@agent-anything/agent-runtime/runner";
import type { InspectionContentInput, InspectionJson, InspectionRecordInput } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";
import { inspectionContentId, inspectionLink } from "./ProviderInspectionAdapter.js";

export class RunExecutionInspectionAdapter implements RunExecutionObserver {
  constructor(private readonly recorder: InspectionRecorder) {}
  observe(value: RunExecutionObservation): void {
    const r = this.recorder;
    const ref = (owner: string, kind: Parameters<InspectionRecorder["ref"]>[1], id: string, revision: string | null = null) => r.ref(owner, kind, id, value.runId, revision);
    const run = ref("runtime", "run", value.runId);
    const content = (name: string, data: unknown, stage: string): InspectionContentInput[] => [{ name, class: "agent", stage, mediaType: "application/json", value: data as InspectionJson }];
    if (value.kind === "run_input") {
      const input = ref("runtime", "contribution", `${value.runId}:input`, "1");
      const configuration = ref("runtime", "contribution", `${value.runId}:configuration`, "1");
      const task = ref("agent-core", "contribution", value.input.task.id, "1");
      for (const [subject, name, data] of [[input, "Run input", value.input], [configuration, "Run configuration", value.configuration], [task, "Task", value.input.task]] as const) {
        r.offer({subject, occurredAt: value.occurredAt, payload: {kind: "event", name, sequence: null, code: null},
          links: [inspectionLink("binding", subject, run)], contents: content(name, data, "bound")});
      }
    } else if (value.kind === "operation_request") {
      const request = ref("operations", "contribution", `${value.invocationId}:request`, "1");
      const operation = ref("operations", "operation", value.invocationId);
      r.offer({subject: request, occurredAt: value.occurredAt,
        payload: {kind: "event", name: "operation.request", sequence: null, code: null},
        links: [inspectionLink("produces", ref("runtime", "action", value.parentRunActionId), request), inspectionLink("includes", request, operation)],
        contents: content("Operation request", {operation: value.operation, requestOrigin: value.requestOrigin, request: value.request}, "received")});
    } else if (value.kind === "operation_binding") {
      const binding = ref("operations", "contribution", `${value.invocationId}:binding`, "1");
      r.offer({subject: binding, occurredAt: value.occurredAt,
        payload: {kind: "event", name: "operation.binding", sequence: null, code: value.resolution.status === "resolved" ? null : value.resolution.code},
        links: [inspectionLink("transforms", ref("operations", "contribution", `${value.invocationId}:request`, "1"), binding), inspectionLink("binding", binding, ref("operations", "operation", value.invocationId))],
        contents: content("Operation binding resolution", value.resolution, "resolved")});
    } else if (value.kind === "operation_result") {
      const result = ref("operations", "contribution", value.result.ref.id);
      r.offer({subject: result, occurredAt: value.occurredAt, payload: {kind: "event", name: "operation.result", sequence: null, code: value.result.failure?.code ?? null},
        links: [inspectionLink("produces", ref("operations", "operation", value.invocationId), result)],
        contents: content("Operation result", value.result, "settled")});
    } else if (value.kind === "scheduling") {
      const call = ref("runtime", "call", value.call.id);
      const turn = ref("runtime", "turn", value.call.turnId);
      r.offer({ subject: turn, occurredAt: value.occurredAt,
        payload: { kind: "event", name: "model_turn.observed", sequence: null, code: null },
        links: [inspectionLink("contains", run, turn),
          inspectionLink("materializes", ref("runtime", "request", value.call.controllerRequestId), turn),
          inspectionLink("produces", ref("model-interaction", "request", value.call.providerRequestId), turn)],
      });
      r.offer({ subject: call, occurredAt: value.occurredAt,
        payload: { kind: "scheduling", position: value.position, disposition: value.disposition, rule: value.rule, groupId: value.groupId, reason: value.reason },
        links: [inspectionLink("contains", turn, call)],
        contents: content("Candidate admission", value, "admission"),
      });
    } else if (value.kind === "retry_event") {
      const event = value.event;
      const operation = ref("retry", "operation", event.operationId);
      const attemptId = "attemptId" in event ? event.attemptId : "afterAttemptId" in event ? event.afterAttemptId : null;
      const subject = attemptId ? ref("retry", "attempt", attemptId) : operation;
      if (attemptId) r.offer({subject: operation, occurredAt: value.occurredAt,
        payload: {kind: "event", name: "retry.operation.observed", sequence: null, code: null},
        links: [inspectionLink("contains", run, operation)],
        contents: content("Retry operation identity", {runId: event.runId, operationId: event.operationId, owner: event.owner}, "published")});
      r.offer({subject, occurredAt: value.occurredAt,
        payload: {kind: "event", name: event.type, sequence: null, code: "failureCode" in event ? event.failureCode ?? null : null},
        links: [inspectionLink("contains", run, operation), ...(attemptId ? [inspectionLink("contains", operation, subject)] : [])],
        contents: content("Retry event", event, "published"),
      });
    } else if (value.kind === "controller_decision") {
      const turn = ref("runtime", "turn", value.turnId);
      const decision = ref("runtime", "contribution", `${value.turnId}:decision`, String(value.basisRevision));
      r.offer({subject: decision, occurredAt: value.occurredAt,
        payload: {kind: "event", name: "controller.decision", sequence: null, code: null},
        links: [inspectionLink("produces", turn, decision)],
        contents: content("Typed Controller decision", value.decision, "validated"),
      });
    } else if (value.kind === "context_source") {
      r.offer({subject: ref(value.source.owner, "contribution", contextSourceId(value.source), value.source.revision), occurredAt: value.occurredAt,
        payload: {kind: "event", name: `context.source.${value.source.kind}`, sequence: null, code: null},
        links: [inspectionLink("contains", run, ref(value.source.owner, "contribution", contextSourceId(value.source), value.source.revision))],
        contents: content("Context source material", {source: value.source, value: value.value}, "source")});
    } else if (value.kind === "context_committed") {
      const context = ref("context", "context", value.context.ref.id, String(value.context.ref.version));
      r.offer({ subject: context, occurredAt: value.occurredAt, payload: { kind: "event", name: "context.committed", sequence: value.context.ref.version, code: null }, links: [inspectionLink("contains", run, context)], contents: content("Active Context", value.context, "committed") });
      for (const item of value.context.items) {
        const contributionRef = "contribution" in item ? item.contribution.ref : item.contributionRef;
        const source = "contribution" in item ? item.contribution.source : item.source;
        const contribution = ref("context", "contribution", contributionRef.id, contributionRef.revision);
        const sourceRef = ref(source.owner, "contribution", contextSourceId(source), source.revision);
        const included = item.lifecycle.kind === "active";
        r.offer({ subject: contribution, occurredAt: value.occurredAt,
          payload: { kind: "transfer", stage: included ? "included" : "omitted", producerId: source.id, consumerId: context.id, operation: item.lifecycle.kind },
          links: [inspectionLink("produces", sourceRef, contribution, { operation: source.kind }), inspectionLink(included ? "includes" : "omits", contribution, context)],
          contents: content("Context item", item, "admitted"),
        });
      }
    } else if (value.kind === "context_projection") {
      const manifest = value.manifest;
      const context = ref("context", "context", manifest.activeContext.id, String(manifest.activeContext.version));
      const projected = ref("context", "contribution", manifest.projectionId, String(manifest.activeContext.version));
      const manifestRef = ref("context", "context", manifest.id);
      const recordId = `${value.runId}:projection:${manifest.id}`;
      r.offer({ id: recordId, subject: projected, occurredAt: value.occurredAt, payload: { kind: "event", name: "context.projected", sequence: null, code: value.projection ? null : "projection_blocked" },
        links: [inspectionLink("transforms", context, projected), inspectionLink("binding", manifestRef, projected)],
        contents: [...content("Context projection", value.projection, "projected"), ...content("Projection Manifest", manifest, "manifest")],
      });
      r.offer({ id: `${recordId}:manifest`, subject: manifestRef, occurredAt: value.occurredAt,
        payload: { kind: "event", name: "projection_manifest.recorded", sequence: null, code: null },
        links: [inspectionLink("binding", manifestRef, projected, {
          sourceLocation: { contentId: inspectionContentId(recordId, 1), partId: null, jsonPointer: "", stage: "manifest" },
        })],
      });
      for (const [index, item] of manifest.records.entries()) {
        const contribution = ref("context", "contribution", item.contribution.id, item.contribution.revision);
        const included = ["included", "transformed", "referenced"].includes(item.disposition);
        const blockIndex = value.projection?.blocks.findIndex((block) => block.item.id === item.item.id) ?? -1;
        r.offer({ subject: contribution, occurredAt: value.occurredAt,
          payload: { kind: "transfer", stage: included ? item.disposition === "included" ? "included" : "transformed" : "omitted", producerId: contribution.id, consumerId: projected.id, operation: item.reason },
          links: [inspectionLink(included ? item.transformation ? "transforms" : "includes" : "omits", contribution, projected, {
            operation: item.reason,
            sourceLocation: { contentId: inspectionContentId(recordId, 1), partId: item.item.id, jsonPointer: `/records/${index}`, stage: "manifest" },
            targetLocation: blockIndex < 0 ? null : { contentId: inspectionContentId(recordId), partId: item.item.id, jsonPointer: `/blocks/${blockIndex}`, stage: "projected" },
          })],
        });
      }
    } else if (value.kind === "descendant_result") {
      const raw = r.ref("runtime", "run", value.raw.runId, value.raw.runId);
      const result = ref("agent-runtime", "contribution", value.projected.ref.id, value.projected.ref.revision);
      const relation = value.projected.correlation.relation;
      r.offer({subject: ref("runtime", "contribution", relation.ref.id), occurredAt: value.occurredAt,
        payload: {kind: "event", name: "descendant.relation", sequence: null, code: null},
        links: [inspectionLink("binding", ref("runtime", "contribution", relation.ref.id), raw)],
        contents: content("Descendant relation", relation, "recorded")});
      const id = `${value.runId}:descendant-result:${value.projected.ref.id}`;
      r.offer({ id, subject: result, occurredAt: value.occurredAt,
        payload: { kind: "transfer", stage: "transformed", producerId: value.raw.runId, consumerId: value.runId, operation: "delegation_result_projection" },
        links: [inspectionLink("transforms", raw, result, {
          operation: "delegation_result_projection",
          sourceLocation: { contentId: inspectionContentId(id), partId: null, jsonPointer: "", stage: "raw_result" },
          targetLocation: { contentId: inspectionContentId(id, 1), partId: null, jsonPointer: "", stage: "delegation_result" },
        }), inspectionLink("produces", ref("runtime", "action", value.parentRunActionId), result)],
        contents: [...content("Child RunResult", value.raw, "raw_result"), ...content("Delegation Result", value.projected, "delegation_result")],
      });
    } else if (value.kind === "tool_exposure") {
      const name = (tool: typeof value.selected[number]) => `${tool.tool.namespace}.${tool.tool.name}`;
      const turn = ref("runtime", "turn", value.turnId);
      const request = ref("runtime", "request", value.proof.controllerRequestId);
      r.offer({ subject: request, occurredAt: value.occurredAt,
        payload: { kind: "event", name: "controller_request.exposure_resolved", sequence: null, code: null },
        links: [inspectionLink("materializes", turn, request)],
      });
      r.offer({ subject: turn, occurredAt: value.occurredAt, payload: { kind: "exposure", requestId: value.proof.controllerRequestId,
        selected: value.selected.map(name), exposed: value.exposure.exposedTools.map(name),
        omitted: value.exposure.omissions.map((omission) => ({ id: name(omission.tool), reason: omission.reason })) },
        links: [inspectionLink("materializes", turn, ref("runtime", "request", value.proof.controllerRequestId)), ...value.exposure.exposedTools.map((tool) => inspectionLink("binding", r.ref("tools", "definition", name(tool), null, tool.revision), turn))],
        contents: [{ name: "Exposure proof and Catalog", class: "definition", stage: "exposed", mediaType: "application/json", value: { exposure: value.exposure, proof: value.proof } as unknown as InspectionJson }],
      });
    } else if (value.kind === "composite") {
      const composite = ref("operation-composition", "operation", value.snapshot.compositeId);
      r.offer({ subject: composite, occurredAt: value.occurredAt, payload: { kind: "event", name: "composite.snapshot", sequence: value.snapshot.revision, code: null },
        links: [inspectionLink("contains", ref("runtime", "action", value.parentRunActionId), composite)],
        contents: [...content("Composite definition", value.definition, "definition"), ...content("Composite snapshot", value.snapshot, "committed")],
      });
      for (const node of value.definition.nodes) {
        const state = value.snapshot.nodes.find((candidate) => candidate.nodeId === node.id)!;
        const nodeRef = ref("operation-composition", "operation", `${composite.id}:${node.id}`);
        const links: NonNullable<InspectionRecordInput["links"]>[number][] = [inspectionLink("contains", composite, nodeRef)];
        if (state.runAction) links.push(inspectionLink("materializes", nodeRef, ref("runtime", "action", state.runAction.id)));
        r.offer({ subject: nodeRef, occurredAt: value.occurredAt, payload: { kind: "event", name: `composite.node.${state.lifecycle}`, sequence: value.snapshot.revision, code: state.settlement?.failure?.code ?? null }, links, contents: content("Composite node", { definition: node, state }, "committed") });
        if (value.snapshot.revision === 0) for (const dependency of node.dependencies) {
          const prerequisite = ref("operation-composition", "operation", `${composite.id}:${dependency.nodeId}`);
          r.offer({ subject: nodeRef, occurredAt: null, payload: { kind: "dependency", condition: dependency.requirement, status: "registered", prerequisiteId: prerequisite.id, dependentId: nodeRef.id }, links: [inspectionLink("prerequisite", prerequisite, nodeRef, { condition: dependency.requirement })] });
        }
      }
    }
  }
}

function contextSourceId(source: {readonly kind: string; readonly id: string}): string {
  return ["run_state", "run_plan", "controller_feedback"].includes(source.kind) ? `${source.kind}:${source.id}` : source.id;
}
