import { createHash } from "node:crypto";
import type { Agent } from "@agent-anything/agent-core/agent";
import type { ToolSelectionRevision } from "@agent-anything/tools/selection";
import type { ProviderDescriptor } from "@agent-anything/model-interaction";
import type { AgentHookRegistration } from "@agent-anything/agent-hooks/composition";
import type { AgentHookProjection } from "@agent-anything/agent-hooks/execution";
import type { InspectionJson } from "../records/index.js";
import type { InspectionRecorder } from "../recording/index.js";
import { inspectionLink } from "./ProviderInspectionAdapter.js";

export class DefinitionInspectionAdapter {
  constructor(private readonly recorder: InspectionRecorder) {}
  agent(agent: Agent): void {
    const subject = this.recorder.ref("agent-core", "definition", agent.id, null, agent.revision);
    this.recorder.offer({ id: `agent:${agent.id}:${agent.revision}:${this.recorder.capturePolicyRevision}`, subject, occurredAt: null, payload: { kind: "definition", definitionKind: "agent", name: agent.name, revision: agent.revision, enabled: true }, contents: [{ name: "Agent definition", stage: "bound", class: "agent", mediaType: "application/json", value: { id: agent.id, name: agent.name, revision: agent.revision, instructions: agent.instructions, metadata: agent.metadata } as unknown as InspectionJson }] });
    const instructions = agent.instructions;
    this.recorder.offer({ id: `instructions:${instructions.ref.id}:${instructions.ref.revision}:${this.recorder.capturePolicyRevision}`, subject: this.recorder.ref("agent-core", "definition", instructions.ref.id, null, instructions.ref.revision), occurredAt: null, payload: { kind: "definition", definitionKind: "instructions", name: instructions.ref.id, revision: instructions.ref.revision, enabled: instructions.blocks.length > 0 }, contents: [{ name: "Resolved Agent Instructions", stage: "resolved", class: "agent", mediaType: "application/json", value: instructions as unknown as InspectionJson }] });
  }
  tools(selection: ToolSelectionRevision, validators: readonly import("@agent-anything/tools/validation").ToolInputSemanticValidator[] = []): void {
    const selected = this.recorder.ref("tools", "definition", selection.selectionId, null, selection.revision);
    for (const { registration } of selection.tools) {
      const tool = registration.descriptor;
      const subject = this.recorder.ref("tools", "definition", `${tool.ref.tool.namespace}.${tool.ref.tool.name}`, null, tool.ref.revision);
      this.recorder.offer({ id: `tool:${tool.fingerprint}:${this.recorder.capturePolicyRevision}`, subject, occurredAt: null, payload: { kind: "definition", definitionKind: "tool", name: tool.name, revision: tool.ref.revision, enabled: tool.retirement === null }, contents: [{ name: "Tool Contract", stage: "registered", class: "definition", mediaType: "application/json", value: tool as unknown as InspectionJson }] });
      const validation = validators.find(candidate => candidate.tool.tool.namespace === tool.ref.tool.namespace && candidate.tool.tool.name === tool.ref.tool.name && candidate.tool.revision === tool.ref.revision);
      if (validation?.configuration) {
        const {ref, value} = validation.configuration;
        const configuration = this.recorder.ref(ref.owner, "contribution", ref.id, null, ref.revision);
        this.recorder.offer({id: `tool-input-constraints:${ref.owner}:${ref.id}:${ref.revision}:${this.recorder.capturePolicyRevision}`, subject: configuration,
          occurredAt: null, payload: {kind: "event", name: "tool.input_constraints", sequence: null, code: null},
          contents: [{name: "Effective input constraints", stage: "bound", class: "definition", mediaType: "application/json", value}]});
        this.recorder.offer({subject, occurredAt: null, payload: {kind: "event", name: "tool.input_constraints.bound", sequence: null, code: null},
          links: [inspectionLink("binding", configuration, subject)], contents: [{name: "Constraint binding", stage: "bound", class: "definition", mediaType: "application/json", value: {toolFingerprint: tool.fingerprint, configuration: ref}}]});
        if (validation.scope) {
          const scope = this.recorder.ref(validation.scope.owner, "contribution", validation.scope.id, null, validation.scope.revision);
          this.recorder.offer({subject: scope, occurredAt: null, payload: {kind: "event", name: "tool.input_constraints.scope", sequence: null, code: null},
            links: [inspectionLink("binding", configuration, scope), inspectionLink("binding", scope, subject)],
            contents: [{name: "Constraint scope binding", stage: "bound", class: "definition", mediaType: "application/json", value: {scope: validation.scope, configuration: ref, toolFingerprint: tool.fingerprint}}]});
        }
      }
      this.recorder.offer({ subject: selected, occurredAt: null, payload: { kind: "event", name: "tool.selected", sequence: null, code: null }, links: [inspectionLink("binding", subject, selected)] });
    }
  }
  provider(descriptor: ProviderDescriptor, revision: string): void {
    revision = `sha256:${createHash("sha256").update(JSON.stringify({ targetRevision: revision, descriptor })).digest("hex")}`;
    this.recorder.offer({ id: `provider:${descriptor.id}:${revision}:${this.recorder.capturePolicyRevision}`, subject: this.recorder.ref("provider", "definition", descriptor.id, null, revision), occurredAt: null, payload: { kind: "definition", definitionKind: "provider", name: descriptor.name, revision, enabled: true }, contents: [{ name: "Provider descriptor", stage: "configured", class: "definition", mediaType: "application/json", value: descriptor as unknown as InspectionJson }] });
  }
  hooks(registrations: readonly AgentHookRegistration[]): void {
    for (const registration of registrations) this.recorder.offer({ id: `hook:${registration.ref.owner}:${registration.ref.id}:${registration.ref.revision}:${this.recorder.capturePolicyRevision}`, subject: this.recorder.ref(registration.ref.owner, "definition", registration.ref.id, null, registration.ref.revision), occurredAt: null, payload: { kind: "definition", definitionKind: "hook", name: `${registration.point}: ${registration.ref.id}`, revision: registration.ref.revision, enabled: true }, contents: [{ name: "Hook registration", stage: "registered", class: "agent", mediaType: "application/json", value: registration as unknown as InspectionJson }] });
  }
  hookInvocations(projection: AgentHookProjection): void {
    for (const invocation of projection.recentInvocations) {
      const subject = this.recorder.ref("agent-hooks", "hook", invocation.id, invocation.runId);
      this.recorder.offer({ id: `hook-invocation:${invocation.id}:${this.recorder.capturePolicyRevision}`, subject, occurredAt: invocation.completedAt, payload: { kind: "execution", phase: "settled", executionKind: invocation.point, status: invocation.status, code: invocation.code, effectCertainty: null }, links: [inspectionLink("contains", this.recorder.ref("runtime", "run", invocation.runId, invocation.runId), subject), inspectionLink("binding", this.recorder.ref(invocation.hook.owner, "definition", invocation.hook.id, null, invocation.hook.revision), subject)], contents: [{ name: "Hook invocation", stage: "settled", class: "agent", mediaType: "application/json", value: invocation as unknown as InspectionJson }] });
    }
  }
  recoveredHook(record: import("@agent-anything/agent-hooks/execution").AgentHookInvocationCheckpoint): void {
    const runId = record.event.run.id;
    const subject = this.recorder.ref("agent-hooks", "hook", record.id, runId);
    this.recorder.offer({id: `hook-recovery:${record.id}:${this.recorder.capturePolicyRevision}`, subject,
      occurredAt: record.outcome?.completedAt ?? null,
      payload: {kind: "execution", phase: "settled", executionKind: record.event.point,
        status: "failed", code: "hook_interrupted", effectCertainty: "unknown"},
      links: [inspectionLink("contains", this.recorder.ref("runtime", "run", runId, runId), subject)],
      contents: [{name: "Recovered Hook outcome", stage: "reconciled", class: "agent", mediaType: "application/json",
        value: record as unknown as InspectionJson}]});
  }
}
