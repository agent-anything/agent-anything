import { createHash } from "node:crypto";
import { modelCallRefKey, type ModelCallableRequest } from "../ModelCall.js";
import { snapshotJsonValue, strictRecord, token } from "../ModelInteractionContractValidation.js";
import { snapshotModelInputSection, snapshotModelInputSourceRef, type ModelInputSection, type ModelInputSourceRef } from "./ModelInput.js";
import type {ModelInputOwnerForm} from "./ModelInputForms.js";
import type {ModelInputAccount} from "./ModelInputAccounts.js";

export interface ModelInputPreservation {
  readonly obligations: readonly {
    readonly id: string;
    readonly requirement: "exact" | "account";
    readonly basis: string;
  }[];
  readonly relationships: readonly {
    readonly kind: "requires" | "qualifies" | "supersedes";
    readonly source: ModelInputSourceRef;
  }[];
}

export interface ModelWorkingViewEntry {
  readonly sectionId: string;
  readonly digest: string;
  readonly source: ModelInputSourceRef;
  readonly sources: readonly ModelInputSourceRef[];
  readonly coverage: readonly string[];
  readonly representation: "exact" | "owner_form" | "semantic_account";
  readonly permittedForms: readonly string[];
  readonly protection: readonly ("instruction" | "first_delivery" | "active_exchange")[];
  readonly preservation: ModelInputPreservation;
}

export interface ModelNativeExchangeGroup {
  readonly turnId: string;
  readonly originRunId: string | null;
  readonly sectionIds: readonly string[];
  readonly callIds: readonly string[];
  readonly settledCallIds: readonly string[];
  readonly status: "settled" | "unsettled";
  readonly protection: "active_exchange" | "required_account";
}

/** A selection manifest, not another copy of the conversation or execution state. */
export interface ModelWorkingView {
  readonly version: 1;
  readonly id: string;
  readonly recipientRunId: string | null;
  readonly boundary: "history" | "request";
  readonly entries: readonly ModelWorkingViewEntry[];
  readonly nativeGroups: readonly ModelNativeExchangeGroup[];
  readonly forms?: readonly ModelInputOwnerForm[];
  readonly accounts?: readonly ModelInputAccount[];
}

export function modelInputValueDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshotJsonValue(value, "model input value"))).digest("hex")}`;
}

export function snapshotModelInputPreservation(input: ModelInputPreservation): ModelInputPreservation {
  strictRecord(input, "preservation", ["obligations", "relationships"]);
  if (!Array.isArray(input.obligations) || !input.obligations.length || !Array.isArray(input.relationships)) {
    throw new TypeError("Preservation requires explicit obligations and relationships.");
  }
  const ids = new Set<string>();
  const obligations = input.obligations.map(value => {
    strictRecord(value, "preservation obligation", ["id", "requirement", "basis"]);
    const id = token(value.id, "obligation.id");
    if (ids.has(id) || (value.requirement !== "exact" && value.requirement !== "account")) {
      throw new TypeError("Preservation obligation is duplicated or invalid.");
    }
    ids.add(id);
    return Object.freeze({id, requirement: value.requirement, basis: token(value.basis, "obligation.basis")});
  });
  const relationships = input.relationships.map((value: ModelInputPreservation["relationships"][number]) => {
    strictRecord(value, "preservation relationship", ["kind", "source"]);
    if (value.kind !== "requires" && value.kind !== "qualifies" && value.kind !== "supersedes") throw new TypeError("Invalid preservation relationship.");
    const source = snapshotModelInputSourceRef(value.source);
    return Object.freeze({kind: value.kind, source});
  });
  return Object.freeze({obligations: Object.freeze(obligations), relationships: Object.freeze(relationships)});
}

export function createExactModelWorkingView(input: {
  readonly sections: readonly ModelInputSection[];
  readonly recipientRunId: string | null;
  readonly boundary: ModelWorkingView["boundary"];
}): ModelWorkingView {
  if (input.boundary !== "history" && input.boundary !== "request") throw new TypeError("Invalid working-view boundary.");
  const recipientRunId = input.recipientRunId === null ? null : token(input.recipientRunId, "working-view recipient");
  const sections = input.sections.map(value => snapshotModelInputSection(value));
  const nativeGroups = nativeExchangeGroups(sections, input.boundary);
  const activeSections = new Set(nativeGroups.filter(group => group.protection === "active_exchange").flatMap(group => group.sectionIds));
  const ids = new Set<string>();
  const entries = sections.map(section => {
    if (ids.has(section.id)) throw new TypeError("Working view repeats a source occurrence.");
    ids.add(section.id);
    if (section.provenance && section.provenance.recipientRunId !== recipientRunId) {
      throw new TypeError("Working view contains another recipient's presentation.");
    }
    const preservation = section.preservation ?? snapshotModelInputPreservation({
      obligations: [{id: "exact-source", requirement: "exact", basis: "No source-owned replacement permission was supplied."}],
      relationships: [],
    });
    return Object.freeze({sectionId: section.id, digest: modelInputValueDigest(section), source: section.source,
      sources: section.provenance?.sources ?? Object.freeze([section.source]), coverage: section.provenance?.coverage ?? Object.freeze([]),
      representation: "exact" as const, permittedForms: Object.freeze(["exact"] as const), preservation,
      protection: Object.freeze([
        ...(section.role === "instruction" ? ["instruction" as const] : []),
        ...(input.boundary === "request" && section.provenance && !section.provenance.retainedPresentation ? ["first_delivery" as const] : []),
        ...(activeSections.has(section.id) ? ["active_exchange" as const] : []),
      ])});
  });
  const basis = {version: 1 as const, recipientRunId, boundary: input.boundary, entries: Object.freeze(entries), nativeGroups};
  return Object.freeze({...basis, id: `working-view:${modelInputValueDigest(basis)}`});
}

/** Resolving selection validates bytes, order and native closure; it grants no disclosure authority. */
export function selectModelWorkingView(view: ModelWorkingView, available: readonly ModelInputSection[]): readonly ModelInputSection[] {
  strictRecord(view, "working view", ["version", "id", "recipientRunId", "boundary", "entries", "nativeGroups", "forms", "accounts"]);
  if (view.version !== 1 || !Array.isArray(view.entries)) throw new TypeError("Unsupported working-view format.");
  const sources = new Map<string, {section: ModelInputSection; index: number}>();
  available.forEach((section, index) => {
    if (sources.has(section.id)) throw new TypeError("Available input repeats an occurrence.");
    sources.set(section.id, {section, index});
  });
  let previous = -1;
  const selected = view.entries.map(entry => {
    const found = sources.get(entry.sectionId);
    if (!found || found.index <= previous) throw new TypeError("Working-view selection is missing or reorders an occurrence.");
    previous = found.index;
    return found.section;
  });
  const expected = createOwnerModelWorkingView({sections: selected, recipientRunId: view.recipientRunId, boundary: view.boundary,
    forms: view.forms ?? [], accounts: view.accounts ?? []});
  if (modelInputValueDigest(view) !== modelInputValueDigest(expected)) throw new TypeError("Working-view content or preservation binding mismatch.");
  // This selection validates supplied forms; it grants no permission to omit occurrences.
  if (selected.length !== available.length) throw new TypeError("Working view cannot omit available source occurrences.");
  return Object.freeze(selected);
}

/** Bind already validated actual forms, without copying the original source into the request. */
export function createOwnerModelWorkingView(input: {readonly sections: readonly ModelInputSection[];
  readonly recipientRunId: string | null; readonly boundary: ModelWorkingView["boundary"]; readonly forms: readonly ModelInputOwnerForm[];
  readonly accounts?: readonly ModelInputAccount[]}): ModelWorkingView {
  const exact = createExactModelWorkingView(input);
  if (!input.forms.length && !input.accounts?.length) return exact;
  const accounts = snapshotJsonValue(input.accounts ?? [], "semantic accounts") as unknown as readonly ModelInputAccount[];
  if (new Set(accounts.map(value => value.id)).size !== accounts.length || accounts.some(account => account.recipientRunId !== input.recipientRunId ||
      !input.sections.some(section => modelInputValueDigest(section) === modelInputValueDigest(account.section)) &&
      !accounts.some(later => later.sources.some(source => source.sectionId === account.section.id)))) {
    throw new TypeError("Working-view accounts do not match actual presentations.");
  }
  const forms = snapshotJsonValue(input.forms, "owner forms") as unknown as readonly ModelInputOwnerForm[];
  if (new Set(forms.map(form => form.sectionId)).size !== forms.length || forms.some(form =>
    !input.sections.some(section => section.id === form.sectionId && modelInputValueDigest(section.content) === modelInputValueDigest(form.content)) &&
    !accounts.some(account => account.sources.some(source => source.sectionId === form.sectionId)))) {
    throw new TypeError("Working-view owner forms do not match actual content.");
  }
  const {id: _id, ...base} = exact;
  const value = {...base, ...(forms.length ? {forms} : {}), ...(accounts.length ? {accounts} : {}), entries: exact.entries.map(entry => {
    const form = forms.find(form => form.sectionId === entry.sectionId);
    const account = accounts.find(value => value.section.id === entry.sectionId);
    if (account) return {...entry, representation: "semantic_account" as const, permittedForms: [account.id]};
    return form ? {...entry, representation: "owner_form" as const, permittedForms: [form.id]} : entry;
  })};
  return Object.freeze({...value, id: `working-view:${modelInputValueDigest(value)}`});
}

function nativeExchangeGroups(sections: readonly ModelInputSection[], boundary: ModelWorkingView["boundary"]): readonly ModelNativeExchangeGroup[] {
  const groups: Array<{turnId: string; originRunId: string | null; sectionIds: string[]; callIds: string[]; settledCallIds: string[]; lastIndex: number}> = [];
  const pending = new Map<string, ModelCallableRequest>();
  const seen = new Set<string>(), turns = new Set<string>();
  let active: (typeof groups)[number] | undefined;
  let lastAssistant = -1;
  for (const [index, section] of sections.entries()) {
    if (pending.size && section.role !== "tool") throw new TypeError("Working view interrupts an unsettled Call/result group.");
    if (section.role === "assistant") lastAssistant = index;
    if (section.content.kind !== "model_message") continue;
    const message = section.content.message;
    if (message.role === "assistant") {
      const calls = message.content.flatMap(block => block.kind === "model_tool_call" ? [block.call] : []);
      if (!calls.length) continue;
      const turnId = calls[0]!.modelCallRef.turnId;
      if (turns.has(turnId) || calls.some(call => call.modelCallRef.turnId !== turnId)) {
        throw new TypeError("Working view has inconsistent native Turn identity.");
      }
      turns.add(turnId);
      active = {turnId, originRunId: section.source.runId ?? section.provenance?.originRunId ?? null,
        sectionIds: [section.id], callIds: [], settledCallIds: [], lastIndex: index};
      groups.push(active);
      for (const call of calls) {
        const key = modelCallRefKey(call.modelCallRef);
        if (seen.has(key)) throw new TypeError("Working view repeats a native Call.");
        seen.add(key); pending.set(key, call); active.callIds.push(call.modelCallRef.id);
      }
    } else if (message.role === "tool") {
      if (!active || !pending.size) throw new TypeError("Working-view result has no matching Call.");
      active.sectionIds.push(section.id); active.lastIndex = index;
      for (const {result} of message.content) {
        const key = modelCallRefKey(result.modelCallRef), call = pending.get(key);
        if (!call || call.name !== result.name || modelInputValueDigest(call.providerCallRef) !== modelInputValueDigest(result.providerCallRef)) {
          throw new TypeError("Working-view result has no matching Call or changes its correlation.");
        }
        pending.delete(key); active.settledCallIds.push(result.modelCallRef.id);
      }
    }
  }
  if (pending.size && boundary === "request") throw new TypeError("Working request contains unsettled Calls.");
  return Object.freeze(groups.map(group => Object.freeze({turnId: group.turnId, originRunId: group.originRunId,
    sectionIds: Object.freeze(group.sectionIds), callIds: Object.freeze(group.callIds), settledCallIds: Object.freeze(group.settledCallIds),
    status: group.callIds.length === group.settledCallIds.length ? "settled" as const : "unsettled" as const,
    protection: group.lastIndex >= lastAssistant ? "active_exchange" as const : "required_account" as const})));
}
