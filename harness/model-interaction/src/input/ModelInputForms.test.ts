import {describe, expect, it} from "vitest";
import {applyModelInputOwnerForms, modelInputOccurrenceDigest, type ModelInputOwnerForm} from "./ModelInputForms.js";
import {createOwnerModelWorkingView, selectModelWorkingView} from "./ModelWorkingView.js";
import type {ModelInputSection} from "./ModelInput.js";

const original: ModelInputSection = {id: "material", kind: "history", role: "user", necessity: "mandatory",
  source: {owner: "material-owner", kind: "source", id: "body", revision: "1"}, content: {kind: "text", text: "account\nlong source detail"},
  preservation: {obligations: [{id: "account", requirement: "account", basis: "Owner-authored retained account"}], relationships: []}};
const form: ModelInputOwnerForm = {id: "owner-account-v1", sectionId: original.id, sourceDigest: modelInputOccurrenceDigest(original),
  owner: {owner: "material-owner", kind: "presenter", id: "material-forms", revision: "1"}, method: "exact_extract",
  content: {kind: "text", text: "account"}, satisfies: ["account"], companions: [], dependencies: [], limitations: ["Detail omitted by explicit owner contract"],
  extract: {start: 0, end: 7}};

describe("source-owner input forms", () => {
  it("preserves originals and binds the selected actual representation and source version", () => {
    const selected = applyModelInputOwnerForms([original], [form], "root");
    expect(original.content).toEqual({kind: "text", text: "account\nlong source detail"});
    const view = createOwnerModelWorkingView({sections: selected, recipientRunId: "root", boundary: "request", forms: [form]});
    expect(view.entries[0]?.representation).toBe("owner_form");
    expect(view.forms?.[0]?.sourceDigest).toBe(modelInputOccurrenceDigest(original));
    expect(selectModelWorkingView(view, selected)).toEqual(selected);
    expect(() => selectModelWorkingView(view, [original])).toThrow();
  });
  it("rejects changed source, undeclared obligations, wrong owner, missing companions and non-exact extraction", () => {
    for (const changed of [{sourceDigest: "changed"}, {satisfies: []}, {owner: {...form.owner, owner: "other"}},
      {companions: ["absent"]}, {content: {kind: "text" as const, text: "invented"}}, {extract: {start: 2, end: 8}}]) {
      expect(() => applyModelInputOwnerForms([original], [{...form, ...changed}], "root")).toThrow();
    }
  });
  it("does not reduce exact obligations, Instructions or a frozen first delivery", () => {
    for (const section of [{...original, role: "instruction" as const}, {...original, preservation: undefined},
      {...original, provenance: {purpose: "later_outcome", recipientRunId: "root", author: "host", sources: [original.source],
        presenter: form.owner, coverage: ["outcome"], limitations: []}}]) {
      expect(() => applyModelInputOwnerForms([section], [{...form, sourceDigest: modelInputOccurrenceDigest(section)}], "root")).toThrow();
    }
    expect(() => applyModelInputOwnerForms([original], [{...form, method: "externalization", dependencies: []}], "root")).toThrow();
  });
});
