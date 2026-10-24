import {describe, expect, it} from "vitest";
import {snapshotProviderRequest, type ProviderRequest} from "../ProviderRequest.js";
import type {ProviderResponse} from "../ProviderResponse.js";
import {applyModelInputAccounts, validateModelAccountScope} from "../input/ModelInputAccounts.js";
import {createExactModelWorkingView, createOwnerModelWorkingView, modelInputValueDigest} from "../input/ModelWorkingView.js";
import {modelInputFromSections, type ModelInputSection} from "../input/ModelInput.js";
import {CONTEXT_ASSESSMENT_CRITERIA, createContextTransformationBasis, createContextTransformationRequest,
  parseContextGeneratedAccount, parseContextAccountAssessment, contextAssessmentAllowsAccount, renderContextAccount,
  contextTransformationPrefixLimit} from "./ModelContextTransformation.js";
import {planContextTransformationStages, contextTransformationNodeBasis} from "./ContextTransformationStages.js";

const ref = {owner: "fixture", kind: "source", id: "binding", revision: "1"};
function source(id: string, text: string, role: "user" | "assistant" = "user"): ModelInputSection {
  const source = {...ref, id, runId: "root"};
  return {id, source, role, kind: "history", necessity: "mandatory", content: {kind: "text", text},
    provenance: {purpose: "history", recipientRunId: "root", author: role, presenter: ref, retainedPresentation: source,
      sources: [source], coverage: [id], limitations: []},
    preservation: {obligations: [{id: "account", requirement: "account", basis: "Preserve delivered meaning."}], relationships: []}};
}
function request(): ProviderRequest {
  const sections = [source("options", "Option 1 keeps exact edges. Option 2 blurs them. Option 3 crops them.", "assistant"),
    source("choice", "Use option 3 for now."), source("amendment", "Actually use option 1 for the remaining images.")];
  const projected = modelInputFromSections(sections), interaction = {kind: "text_generation" as const};
  return snapshotProviderRequest({requestId: "r", purpose: "working", correlation: {controllerRequestId: "c", branchId: "main"},
    ...projected, interaction, continuation: null, metadata: {}, modelContext: {
      requestedOutput: {unit: "tokens", maximum: null, source: "unspecified", revision: "1"},
      headroom: {unit: "tokens", amount: 0, policy: {id: "none", revision: "1"}}, assessment: null},
    composition: {id: "r", providerId: "p", model: "m", ...projected, interaction, sections,
      workingView: createExactModelWorkingView({sections, recipientRunId: "root", boundary: "request"}),
      composedAt: "2026-10-23T00:00:00.000Z", lineage: {instructionBinding: ref, agent: ref, instructions: ref, instructionRelease: ref,
        instructionResolver: ref, instructionContent: ref, instructionModel: {providerId: "p", model: "m"}, instructionBlocks: [],
        activeContext: null, contextProjection: null, projectionManifest: null, toolSelection: null, toolExposureContent: null,
        toolExposureBasis: null, toolExposureProof: null, toolGuidance: null, controllerControlGuidance: null, callableDefinitions: null,
        modelQualification: null, interactionHistory: ref, protocol: ref, policy: ref}}});
}
const response = (output: unknown): ProviderResponse => ({kind: "structured_generation", output: output as never,
  responseId: "response", usage: null, continuation: null, metadata: {}});
const accountOutput = {entries: [{text: "The assistant proposed exact edges (1), blur (2) and crop (3). The user initially chose crop.",
  sources: ["options", "choice"]}], limitations: [], omittedDetails: []};

describe("Source-grounded context transformations", () => {
  it("preserves an eligible text prefix exactly and refuses inherited instructions", () => {
    const original = request(), basis = createContextTransformationBasis(original, ["options", "choice"], "root");
    const prefix = createContextTransformationRequest(original, basis, "generation", undefined, undefined, "prefix");
    expect(prefix.messages.slice(0, original.messages.length - 1)).toEqual(original.messages.slice(0, -1));
    expect(prefix.composition.sections.slice(0, original.composition.sections.length)).toEqual(original.composition.sections);
    expect(prefix.instructions.content).toEqual([]);
    expect(prefix.messages.at(-1)?.role).toBe("user");
    expect(prefix.metadata.requestForm).toBe("prefix");
    const instruction = {...source("system", "Existing user configured behavior."), role: "instruction" as const};
    const sections = [instruction, ...original.composition.sections], projected = modelInputFromSections(sections);
    const withInstructions = {...original, ...projected, composition: {...original.composition, ...projected, sections}};
    const bound = createContextTransformationBasis(withInstructions, ["options"], "root");
    expect(contextTransformationPrefixLimit(withInstructions, bound)).toBe("inherited_instructions_not_qualified");
    expect(() => createContextTransformationRequest(withInstructions, bound, "generation", undefined, undefined, "prefix")).toThrow("prefix");
  });
  it("bounds legal leaves and carries derived evidence and loss into a separately assessed merge", () => {
    const original = request(), basis = createContextTransformationBasis(original, ["options", "choice"], "root");
    const maximumSourceBytes = Math.max(...basis.sources.map(section => Buffer.byteLength(JSON.stringify([section]))));
    const plan = planContextTransformationStages(basis, {maximumSourceBytes, maximumNodes: 3});
    expect(plan.kind).toBe("planned");
    if (plan.kind !== "planned") throw new Error("Expected legal source partitions");
    expect(plan.nodes.map(node => node.level)).toEqual(["internal_node", "internal_node", "final_adoption"]);
    expect(plan.maximumCompletedRequests).toBe(6);
    const leaves = plan.nodes.slice(0, -1).map(node => {
      const leaf = contextTransformationNodeBasis(basis, node, []);
      return renderContextAccount(leaf, {entries: [{text: "Scoped account", sources: node.sourceIds}],
        limitations: ["Original wording not retained"], omittedDetails: ["Formatting"]}, ref, "assessed");
    });
    expect(() => applyModelInputAccounts(original.composition.sections, [leaves[0]!], "root")).toThrow("final-adoption");
    const merge = contextTransformationNodeBasis(basis, plan.nodes.at(-1)!, leaves);
    expect(merge.sources).toEqual(basis.sources);
    expect(merge.evidence.map(section => section.id)).toEqual(leaves.map(account => account.id));
    expect(merge.inheritedLimitations).toEqual(expect.arrayContaining(["Original wording not retained", "omitted_detail:Formatting",
      "assessment_uses_derived_accounts_not_original_reread"]));
    const wire = createContextTransformationRequest(original, merge, "generation");
    expect(JSON.stringify(wire.messages)).not.toContain("Option 2 blurs them");
    expect(JSON.stringify(wire.messages)).toContain("Actually use option 1");
    expect(() => contextTransformationNodeBasis(basis, plan.nodes.at(-1)!, [...leaves].reverse())).toThrow("coverage");
    expect(planContextTransformationStages(basis, {maximumSourceBytes, maximumNodes: 2})).toMatchObject({kind: "unavailable", reason: "node_limit"});
    expect(planContextTransformationStages(basis, {maximumSourceBytes: 1, maximumNodes: 3})).toMatchObject({kind: "unavailable", reason: "indivisible_scope"});
  });
  it("keeps a repeated account's chain replayable without pretending to reread originals", () => {
    const original = request(), basis = createContextTransformationBasis(original, ["options", "choice"], "root");
    const first = renderContextAccount(basis, {...accountOutput, omittedDetails: ["Exact wording"]}, ref, "assessed-first");
    const selected = applyModelInputAccounts(original.composition.sections, [first], "root");
    const projected = modelInputFromSections(selected);
    const next = snapshotProviderRequest({...original, ...projected, composition: {...original.composition, ...projected, sections: selected,
      workingView: createOwnerModelWorkingView({sections: selected, recipientRunId: "root", boundary: "request", forms: [], accounts: [first]})}});
    const nextBasis = createContextTransformationBasis(next, [first.id], "root");
    const second = renderContextAccount(nextBasis, {entries: [{text: "Earlier alternatives and initial choice, with exact wording unavailable.", sources: [first.id]}],
      limitations: [], omittedDetails: []}, ref, "assessed-second");
    expect(second.limitations).toContain("omitted_detail:Exact wording");
    expect(second.derivation.evidence).toEqual([first.section.source]);
    const replayed = applyModelInputAccounts(original.composition.sections, [first, second], "root");
    expect(replayed.map(section => section.id)).toEqual([second.id, "amendment"]);
    expect(createOwnerModelWorkingView({sections: replayed, recipientRunId: "root", boundary: "request", forms: [], accounts: [first, second]}).accounts).toHaveLength(2);
    const assessment = createContextTransformationRequest(next, nextBasis, "assessment", accountOutput, replayed);
    const packed = JSON.parse((assessment.messages[0]!.content[0] as {text: string}).text);
    expect(packed.proposedCompleteInput.sectionOrder).toEqual([second.id, "amendment"]);
    expect(packed.proposedCompleteInput.additionalSections.map((section: ModelInputSection) => section.id)).toEqual([second.id]);
  });
  it("quotes background separately, preserves chronology and does not bind a fabricated Agent", () => {
    const original = request(), basis = createContextTransformationBasis(original, ["options", "choice"], "root");
    const generation = createContextTransformationRequest(original, basis, "generation");
    expect(generation.composition.lineage.agent).toBeNull();
    expect(generation.composition.lineage.auxiliary?.purpose).toBe("context_generation");
    expect(generation.interaction.kind).toBe("structured_generation");
    expect(generation.continuation).toBeNull();
    expect(original.instructions.content).toEqual([]);
    const data = JSON.parse((generation.messages[0]!.content[0] as {text: string}).text);
    expect(data.replacementSources.map((value: ModelInputSection) => value.id)).toEqual(["options", "choice"]);
    expect(data.readOnlyBackground.map((value: ModelInputSection) => value.id)).toEqual(["amendment"]);
    expect(data.sourceOrder).toEqual(["options", "choice", "amendment"]);
    expect(() => snapshotProviderRequest({...generation, composition: {...generation.composition,
      lineage: {...generation.composition.lineage, agent: ref}}})).toThrow("impersonate");
  });
  it("replaces only the eligible interval, retaining later amendments and source-bound obligations", () => {
    const original = request(), basis = createContextTransformationBasis(original, ["options", "choice"], "root");
    const generated = parseContextGeneratedAccount(response(accountOutput), basis);
    const account = renderContextAccount(basis, generated, {...ref, kind: "assessment"}, "assessed-proposal");
    const sections = applyModelInputAccounts(original.composition.sections, [account], "root");
    expect(sections).toHaveLength(2);
    expect(sections[0]!.role).toBe("user");
    expect(sections[1]).toEqual(original.composition.sections[2]);
    const projected = modelInputFromSections(sections);
    const selected = snapshotProviderRequest({...original, ...projected, composition: {...original.composition, ...projected, sections,
      workingView: createOwnerModelWorkingView({sections, recipientRunId: "root", boundary: "request", forms: [], accounts: [account]})}});
    expect(selected.composition.workingView.entries[0]?.representation).toBe("semantic_account");
    expect(() => applyModelInputAccounts(original.composition.sections, [account], "child")).toThrow();
    expect(() => applyModelInputAccounts(original.composition.sections, [{...account,
      section: {...account.section, preservation: {...account.section.preservation!, obligations: []}}}], "root")).toThrow();
    expect(() => applyModelInputAccounts(original.composition.sections.map((section, i) => i ? section : {...section,
      content: {kind: "text", text: "changed"}}), [account], "root")).toThrow("binding");
  });
  it("does not treat valid source selectors as adequate semantics", () => {
    const original = request(), basis = createContextTransformationBasis(original, ["options", "choice"], "root");
    const findings = CONTEXT_ASSESSMENT_CRITERIA.map(criterion => ({criterion, verdict: "adequate", reason: "Comparison with supplied sources.", sources: ["options"]}));
    const assessment = parseContextAccountAssessment(response({findings, inheritedDefects: [], introducedLoss: [], limitations: []}), basis);
    expect(contextAssessmentAllowsAccount(assessment)).toBe(true);
    expect(contextAssessmentAllowsAccount({...assessment, introducedLoss: ["Lost the meaning of option 1"]})).toBe(false);
    expect(contextAssessmentAllowsAccount({...assessment, findings: assessment.findings.map((value, i) => i ? value : {...value, verdict: "unknown"})})).toBe(false);
    expect(() => parseContextAccountAssessment(response({...assessment, findings: Array(6).fill(findings[0])}), basis)).toThrow("repeats");
    expect(() => parseContextGeneratedAccount(response({...accountOutput, entries: [{text: "All succeeded", sources: ["invented"]}]}), basis)).toThrow("unavailable");
    expect(() => parseContextGeneratedAccount({...response(null), kind: "text_generation", output: "summary"}, basis)).toThrow("structured");
  });
  it("rejects first deliveries, exact requirements, non-contiguous and changed generation bases", () => {
    const original = request(), sections = original.composition.sections;
    expect(() => validateModelAccountScope(sections, ["options", "amendment"], "root")).toThrow("contiguous");
    expect(() => validateModelAccountScope(sections.map(section => ({...section, provenance: {...section.provenance!, retainedPresentation: undefined}})), ["options"], "root")).toThrow();
    expect(() => validateModelAccountScope(sections.map(section => ({...section, preservation: {obligations: [{id: "exact", requirement: "exact", basis: "Required bytes"}], relationships: []}})), ["options"], "root")).toThrow("protected");
    const basis = createContextTransformationBasis(original, ["options"], "root");
    expect(() => createContextTransformationRequest({...original, requestId: "changed"}, basis, "generation")).toThrow("basis");
    const generated = parseContextGeneratedAccount(response({entries: [{text: "Three distinct options.", sources: ["options"]}], limitations: [], omittedDetails: []}), basis);
    const account = renderContextAccount(basis, generated, ref, "assessment");
    const proposed = applyModelInputAccounts(sections, [account], "root");
    const assessmentRequest = createContextTransformationRequest(original, basis, "assessment", generated, proposed);
    expect(JSON.stringify(assessmentRequest.messages)).toContain("proposedCompleteInput");
    expect(modelInputValueDigest(assessmentRequest)).not.toBe(modelInputValueDigest(createContextTransformationRequest(original, basis, "generation")));
  });
});
