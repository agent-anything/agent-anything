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
    if (value.kind === "scheduling") {
      const call = ref("runtime", "call", value.call.id);
      r.offer({ subject: call, occurredAt: value.occurredAt,
        payload: { kind: "scheduling", position: value.position, disposition: value.disposition, rule: value.rule, groupId: value.groupId, reason: value.reason },
        links: [inspectionLink("contains", ref("runtime", "turn", value.call.turnId), call)],
        contents: content("Candidate admission", value, "admission"),
      });
    } else if (value.kind === "context_committed") {
      const context = ref("context", "context", value.context.ref.id, String(value.context.ref.version));
      r.offer({ subject: context, occurredAt: value.occurredAt, payload: { kind: "event", name: "context.committed", sequence: value.context.ref.version, code: null }, links: [inspectionLink("contains", run, context)], contents: content("Active Context", value.context, "committed") });
      for (const item of value.context.items) {
        const contributionRef = "contribution" in item ? item.contribution.ref : item.contributionRef;
        const source = "contribution" in item ? item.contribution.source : item.source;
        const contribution = ref("context", "contribution", contributionRef.id, contributionRef.revision);
        const sourceRef = ref(source.owner, "contribution", source.id, source.revision);
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
      r.offer({ subject: turn, occurredAt: null, payload: { kind: "exposure", requestId: value.proof.controllerRequestId,
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
