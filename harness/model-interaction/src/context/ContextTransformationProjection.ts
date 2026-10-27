import {modelCallRefKey} from "../ModelCall.js";
import type {ModelInputSection} from "../input/ModelInput.js";
import {modelInputValueDigest} from "../input/ModelWorkingView.js";
import type {ContextTransformationBasis} from "./ModelContextTransformation.js";
import type {ProviderRequest} from "../ProviderRequest.js";

export const CONTEXT_EVIDENCE_PROJECTION = "context-evidence.v2";

/** Labels are local presentation references. The complete basis remains the authority. */
export function contextEvidenceLabels(basis: ContextTransformationBasis, proposal: readonly ModelInputSection[] = []) {
  const ids = [...new Set([...basis.sourceOrder, ...basis.evidence.map(s => s.id),
    ...basis.background.map(s => s.id), ...proposal.map(s => s.id)])];
  return new Map(ids.map((id, index) => [id, `s${index + 1}`]));
}

export function projectContextTransformationEvidence(basis: ContextTransformationBasis,
  proposal: readonly ModelInputSection[] | undefined, prefix: boolean) {
  const labels = contextEvidenceLabels(basis, proposal);
  const supplied = [...basis.evidence, ...basis.background, ...(proposal ?? [])];
  const calls = new Map<string, string>();
  const labelCall = (key: string) => {
    if (!calls.has(key)) calls.set(key, `c${calls.size + 1}`);
    return calls.get(key)!;
  };
  const body = (section: ModelInputSection) => {
    const content = section.content;
    if (content.kind !== "model_message") return content;
    const message = content.message;
    return {kind: "model_message", message: {role: message.role,
      ...(message.role === "assistant" && message.reasoning ? {reasoning: message.reasoning} : {}),
      content: message.content.map(block => {
        if (block.kind === "text") return block;
        if (block.kind === "model_tool_call") return {kind: "model_tool_call",
          call: {id: labelCall(modelCallRefKey(block.call.modelCallRef)), name: block.call.name, input: block.call.input}};
        return {kind: "model_tool_result", result: {callId: labelCall(modelCallRefKey(block.result.modelCallRef)),
          name: block.result.name, settlement: block.result.settlement,
          presentation: {disposition: block.result.presentation.disposition, failureCode: block.result.presentation.failureCode},
          content: block.result.content}};
      })}};
  };
  const section = (s: ModelInputSection, referenceOnly = false) => ({id: labels.get(s.id)!, kind: s.kind, role: s.role,
    attribution: {owner: s.source.owner, sourceKind: s.source.kind, sourceRun: s.source.runId ?? null,
      ...(s.provenance ? {author: s.provenance.author, purpose: s.provenance.purpose,
        recipient: s.provenance.recipientRunId, origin: s.provenance.originRunId ?? null,
        limitations: s.provenance.limitations} : {})},
    preservation: s.preservation ? {obligations: s.preservation.obligations.map(o => ({requirement: o.requirement, basis: o.basis})),
      relationships: s.preservation.relationships.map(r => {
        const matches = supplied.filter(other => modelInputValueDigest(other.source) === modelInputValueDigest(r.source));
        return {kind: r.kind, ...(matches.length ? {occurrences: [...new Set(matches.map(other => labels.get(other.id)!))]} : {unresolvedSource: r.source})};
      })} : {obligations: [{requirement: "exact", basis: "No source-owned replacement permission was supplied."}], relationships: []},
    ...(referenceOnly ? {} : {content: body(s)})});
  const payload = {projection: CONTEXT_EVIDENCE_PROJECTION,
    replacementSources: basis.evidence.map(s => section(s, prefix)),
    replacementCoverage: basis.sources.map(s => labels.get(s.id)!),
    assessmentLevel: basis.assessmentLevel, readOnlyBackground: basis.background.map(s => section(s, prefix)),
    sourceOrder: basis.sourceOrder.map(id => labels.get(id)!), definitionsAsData: basis.definitions,
    unsuppliedSourcePositions: basis.sourceOrder.filter(id => ![...basis.evidence, ...basis.background].some(s => s.id === id)).map(id => labels.get(id)!),
    replacementRoom: basis.replacementRoom, inheritedLimitations: basis.inheritedLimitations,
    proposedCompleteInput: proposal ? {sectionOrder: proposal.map(s => labels.get(s.id)!),
      additionalSections: proposal.filter(s => ![...basis.evidence, ...basis.background].some(known =>
        known.id === s.id && modelInputValueDigest(known) === modelInputValueDigest(s))).map(s => section(s))} : null};
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  return {payload, mapping: [...labels].map(([id, label]) => ({label, sectionId: id})),
    sections: supplied.filter((s, index) => supplied.findIndex(other => other.id === s.id) === index)
      .map(s => ({sectionId: s.id, digest: modelInputValueDigest(s)})),
    callMapping: [...calls].map(([key, label]) => ({label, callKey: key})),
    componentBytes: {sources: bytes(payload.replacementSources), background: bytes(payload.readOnlyBackground),
      definitions: bytes(payload.definitionsAsData), candidate: bytes(payload.proposedCompleteInput), total: bytes(payload)}};
}

export function resolveContextEvidenceCitations(ids: readonly string[], basis: ContextTransformationBasis, request?: ProviderRequest): readonly string[] {
  const projection = request?.metadata.evidenceProjection as {revision: string; mapping: readonly {label: string; sectionId: string}[]} | undefined;
  if (request && (!projection || projection.revision !== CONTEXT_EVIDENCE_PROJECTION || !Array.isArray(projection.mapping))) {
    throw new TypeError("The frozen evidence label mapping is unavailable.");
  }
  const entries = projection ? projection.mapping.map(value => [value.label, value.sectionId] as const) :
    [...contextEvidenceLabels(basis)].map(([id, label]) => [label, id] as const);
  if (new Set(entries.map(([label]) => label)).size !== entries.length ||
      new Set(entries.map(([, id]) => id)).size !== entries.length) throw new TypeError("Evidence labels must be one-to-one.");
  const byLabel = new Map(entries);
  return ids.map(label => {
    const id = byLabel.get(label);
    if (!id) throw new TypeError("Account cites an unavailable evidence label.");
    return id;
  });
}
