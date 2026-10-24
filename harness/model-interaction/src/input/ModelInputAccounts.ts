import {snapshotModelInputSection, type ModelInputSection, type ModelInputSourceRef} from "./ModelInput.js";
import {createExactModelWorkingView, modelInputValueDigest} from "./ModelWorkingView.js";
import {modelInputOccurrenceDigest} from "./ModelInputForms.js";

export interface ModelInputAccount {
  readonly id: string;
  readonly recipientRunId: string;
  readonly method: ModelInputSourceRef;
  readonly sources: readonly {readonly sectionId: string; readonly digest: string; readonly source: ModelInputSourceRef}[];
  readonly section: ModelInputSection;
  readonly assessment: ModelInputSourceRef;
  readonly assessmentBasis: string;
  readonly dependencies: readonly ModelInputSourceRef[];
  readonly limitations: readonly string[];
  readonly derivation: {readonly evidence: readonly ModelInputSourceRef[]; readonly assessmentLevel: "internal_node" | "final_adoption"};
}

/** Only declared preservation and native closure establish eligibility, never prose or age. */
export function validateModelAccountScope(sections: readonly ModelInputSection[], sectionIds: readonly string[],
  recipientRunId: string, boundary: "request" | "history" = "request"): readonly ModelInputSection[] {
  const view = createExactModelWorkingView({sections, recipientRunId, boundary});
  const first = sections.findIndex(section => section.id === sectionIds[0]);
  if (!sectionIds.length || first < 0 || new Set(sectionIds).size !== sectionIds.length ||
      sectionIds.some((id, index) => sections[first + index]?.id !== id)) throw new TypeError("Account scope must be one ordered contiguous interval.");
  const ids = new Set(sectionIds);
  for (const entry of view.entries.filter(entry => ids.has(entry.sectionId))) {
    if (entry.protection.length || entry.preservation.obligations.some(value => value.requirement === "exact")) {
      throw new TypeError("Account scope contains protected input.");
    }
    if (entry.preservation.relationships.some(relation => !sections.some(section =>
      [section.source, ...(section.provenance?.sources ?? [])].some(source => modelInputValueDigest(source) === modelInputValueDigest(relation.source))))) {
      throw new TypeError("Account scope has an unavailable declared companion.");
    }
  }
  for (const group of view.nativeGroups) {
    if (group.sectionIds.some(id => ids.has(id)) && group.sectionIds.some(id => !ids.has(id))) {
      throw new TypeError("Account scope splits a native exchange.");
    }
  }
  return Object.freeze(sections.slice(first, first + sectionIds.length));
}

export function applyModelInputAccounts(sections: readonly ModelInputSection[], accounts: readonly ModelInputAccount[],
  recipientRunId: string, boundary: "request" | "history" = "request"): readonly ModelInputSection[] {
  let selected = [...sections];
  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id) || account.derivation.assessmentLevel !== "final_adoption") throw new TypeError("Only distinct final-adoption accounts can enter working input.");
    ids.add(account.id);
    const sources = validateModelAccountScope(selected, account.sources.map(value => value.sectionId), recipientRunId, boundary);
    if (account.recipientRunId !== recipientRunId || !account.id || !account.assessment.id ||
        account.assessment.revision === null && account.assessment.kind !== "request" ||
        !account.assessmentBasis || sources.some((section, index) => modelInputOccurrenceDigest(section) !== account.sources[index]!.digest ||
          modelInputValueDigest(section.source) !== modelInputValueDigest(account.sources[index]!.source))) {
      throw new TypeError("Account source or recipient binding changed.");
    }
    const section = snapshotModelInputSection(account.section);
    if (section.role !== "user" || section.kind !== "historical_account" || section.content.kind !== "text" ||
        section.source.owner !== "model-interaction" || section.source.id !== account.id ||
        section.provenance?.recipientRunId !== recipientRunId || !section.provenance.retainedPresentation ||
        modelInputValueDigest(section.provenance.sources) !== modelInputValueDigest(account.sources.map(value => value.source)) ||
        modelInputValueDigest(section.preservation?.obligations) !== modelInputValueDigest(accountObligations(sources)) ||
        modelInputValueDigest(section.preservation?.relationships) !== modelInputValueDigest(accountRelationships(sources))) {
      throw new TypeError("Account presentation changes authority, source coverage or preservation.");
    }
    const first = selected.findIndex(value => value.id === sources[0]!.id);
    selected = [...selected.slice(0, first), account.section, ...selected.slice(first + sources.length)];
  }
  createExactModelWorkingView({sections: selected, recipientRunId, boundary});
  return Object.freeze(selected);
}

export function accountObligations(sources: readonly ModelInputSection[]) {
  return sources.flatMap(section => section.preservation!.obligations.map(obligation => ({...obligation,
    id: `${section.id}:${obligation.id}`})));
}

export function accountRelationships(sources: readonly ModelInputSection[]) {
  return sources.flatMap(section => section.preservation!.relationships);
}
