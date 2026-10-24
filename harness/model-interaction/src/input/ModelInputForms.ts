import {snapshotModelInputSection, type ModelInputContent, type ModelInputSection, type ModelInputSourceRef} from "./ModelInput.js";
import {createExactModelWorkingView, modelInputValueDigest} from "./ModelWorkingView.js";

/** A source-owner assertion, not a permission inferred from content size or age. */
export interface ModelInputOwnerForm {
  readonly id: string;
  readonly sectionId: string;
  readonly sourceDigest: string;
  readonly owner: ModelInputSourceRef;
  readonly method: "owner_presentation" | "exact_extract" | "externalization";
  readonly content: ModelInputContent;
  readonly satisfies: readonly string[];
  /** These occurrences must remain exact with this form. */
  readonly companions: readonly string[];
  readonly dependencies: readonly ModelInputSourceRef[];
  readonly limitations: readonly string[];
  readonly extract?: {readonly start: number; readonly end: number};
}

/** Ignores presentation wrappers that change when an accepted exchange becomes history. */
export function modelInputOccurrenceDigest(section: ModelInputSection): string {
  return modelInputValueDigest({id: section.id, source: section.source, role: section.role, content: section.content,
    preservation: section.preservation ?? null});
}

export function applyModelInputOwnerForms(sections: readonly ModelInputSection[], forms: readonly ModelInputOwnerForm[],
  recipientRunId: string, boundary: "request" | "history" = "request"): readonly ModelInputSection[] {
  const view = createExactModelWorkingView({sections, recipientRunId, boundary});
  const byId = new Map(forms.map(form => [form.sectionId, form]));
  const identities = new Set(sections.map(section => section.id));
  if (byId.size !== forms.length || forms.some(form => !identities.has(form.sectionId))) throw new TypeError("Owner form occurrence is missing or repeated.");
  const selected = sections.map((section, index) => {
    const form = byId.get(section.id);
    if (!form) return section;
    const entry = view.entries[index]!;
    if (!form.id || form.id === "exact" || !form.owner.id || !form.owner.revision || form.owner.owner !== section.source.owner ||
        modelInputOccurrenceDigest(section) !== form.sourceDigest || entry.protection.length ||
        entry.preservation.obligations.some(obligation => obligation.requirement === "exact") ||
        new Set(form.satisfies).size !== form.satisfies.length ||
        modelInputValueDigest([...form.satisfies].sort()) !== modelInputValueDigest(entry.preservation.obligations.map(value => value.id).sort()) ||
        form.companions.some(id => !identities.has(id) || byId.has(id)) ||
        entry.preservation.relationships.some(relation => !sections.some(other => modelInputValueDigest(other.source) === modelInputValueDigest(relation.source)))) {
      throw new TypeError("Owner form violates source, protection, obligation or companion binding.");
    }
    if (!["owner_presentation", "exact_extract", "externalization"].includes(form.method) ||
        (form.method === "externalization" && !form.dependencies.length)) throw new TypeError("Owner form method lacks its required access dependencies.");
    if (form.method === "exact_extract") {
      const range = form.extract;
      if (!range || section.content.kind !== "text" || form.content.kind !== "text" || !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > section.content.text.length ||
          form.content.text !== section.content.text.slice(range.start, range.end)) throw new TypeError("Extraction must match the exact admitted source range.");
    }
    // Closed native result bodies can change, never the Call identity, name or settlement.
    if (section.content.kind === "model_message") {
      if (section.role === "assistant" || form.content.kind !== "model_message" || form.content.message.role !== section.content.message.role) {
        throw new TypeError("Owner forms cannot rewrite native assistant messages or change message roles.");
      }
      const signature = (content: typeof section.content) => content.message.role === "tool" ? content.message.content.map(({result}) => {
        const {content: _content, presentation: _presentation, ...binding} = result;
        return binding;
      }) : null;
      if (section.role === "tool" && modelInputValueDigest(signature(section.content)) !== modelInputValueDigest(signature(form.content))) {
        throw new TypeError("Owner form changes native result correlation or settlement.");
      }
    }
    return snapshotModelInputSection({...section, content: form.content, ...(section.provenance ? {
      provenance: {...section.provenance, presenter: form.owner, limitations: [...section.provenance.limitations, ...form.limitations]},
    } : {})});
  });
  createExactModelWorkingView({sections: selected, recipientRunId, boundary});
  return Object.freeze(selected);
}
