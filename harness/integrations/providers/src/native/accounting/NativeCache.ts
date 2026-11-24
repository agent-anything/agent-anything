import { snapshotModelInteractionProtocol, snapshotProtocolRevisionRef,
  type ModelInteractionProtocolRef, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import { key, record, requireText, snapshot } from "./AccountingValue.js";
import { addDecimal } from "./ExactDecimal.js";
import { uniqueNativeWorkEntries, type NativeWorkIndexEntry } from "./NativeWorkIndex.js";

export interface ResponsesCacheSettingsSupport {
  readonly basis: ProtocolRevisionRef;
  readonly fields: readonly ("prompt_cache_key" | "prompt_cache_retention" | "prompt_cache_options")[];
  readonly modes: readonly string[];
  readonly retentions: readonly string[];
  readonly optionFields?: readonly string[];
}

/** Checks only admitted native controls. Mapping/encoding owns native item boundaries;
 * no role/history rewriting or silent omission is performed here. */
export function validateResponsesCacheSettings(input: {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly support: ResponsesCacheSettingsSupport;
  readonly disclosure: { readonly basis: ProtocolRevisionRef; readonly permittedRetentions: readonly string[] };
}): Readonly<Record<string, unknown>> {
  const settings = snapshot(input.settings);
  snapshotProtocolRevisionRef(input.support.basis); snapshotProtocolRevisionRef(input.disclosure.basis);
  if (!record(settings)) throw new TypeError("accounting_cache_settings_invalid");
  const allowedFields = ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"];
  for (const field of Object.keys(settings)) if (!allowedFields.includes(field) ||
      !input.support.fields.includes(field as ResponsesCacheSettingsSupport["fields"][number]))
    throw new TypeError("accounting_cache_control_unsupported");
  if (Object.hasOwn(settings, "prompt_cache_retention") && Object.hasOwn(settings, "prompt_cache_options"))
    throw new TypeError("accounting_cache_controls_incompatible");
  if (Object.hasOwn(settings, "prompt_cache_key")) requireText(settings.prompt_cache_key);
  const options = settings.prompt_cache_options === undefined ? null : record(settings.prompt_cache_options);
  if (settings.prompt_cache_options !== undefined && !options) throw new TypeError("accounting_cache_options_invalid");
  if (options && Object.keys(options).some(field => !["ttl", "mode", "comparison_response_id"].includes(field) ||
      !(input.support.optionFields ?? ["ttl", "mode"]).includes(field)))
    throw new TypeError("accounting_cache_option_unsupported");
  if (options?.mode !== undefined) {
    requireText(options.mode);
    if (!input.support.modes.includes(options.mode)) throw new TypeError("accounting_cache_mode_unsupported");
  }
  if (options && Object.hasOwn(options, "comparison_response_id")) requireText(options.comparison_response_id);
  const retention = options && Object.hasOwn(options, "ttl") ? options.ttl : settings.prompt_cache_retention;
  if (retention !== undefined) {
    requireText(retention);
    if (!input.support.retentions.includes(retention)) throw new TypeError("accounting_cache_retention_unsupported");
    if (!input.disclosure.permittedRetentions.includes(retention)) throw new TypeError("accounting_cache_retention_unauthorized");
  }
  return settings;
}

export function projectNativeCacheEvidence(input: {
  readonly protocol: ModelInteractionProtocolRef;
  readonly requested: Readonly<Record<string, unknown>>;
  readonly reported: Readonly<Record<string, unknown>> | null;
  readonly settingsBasis: ProtocolRevisionRef;
  readonly opportunity: readonly { readonly kind: "stable_prefix" | "local_reuse" | "remote_continuation"; readonly basis: ProtocolRevisionRef }[];
  readonly latency: { readonly milliseconds: number; readonly clockDomain: string; readonly basis: ProtocolRevisionRef } | null;
}) {
  snapshotModelInteractionProtocol(input.protocol); snapshotProtocolRevisionRef(input.settingsBasis);
  if (!record(input.requested) || (input.reported !== null && !record(input.reported))) throw new TypeError("accounting_cache_evidence_invalid");
  for (const opportunity of input.opportunity) {
    if (!["stable_prefix", "local_reuse", "remote_continuation"].includes(opportunity.kind)) throw new TypeError("accounting_cache_opportunity_invalid");
    snapshotProtocolRevisionRef(opportunity.basis);
  }
  if (input.latency) {
    if (!Number.isFinite(input.latency.milliseconds) || input.latency.milliseconds < 0) throw new TypeError("accounting_latency_invalid");
    requireText(input.latency.clockDomain); snapshotProtocolRevisionRef(input.latency.basis);
  }
  return snapshot({ ...input, revision: key(input), appliedPolicy: input.reported === null ? "unknown" : "provider_reported",
    conclusions: { guaranteedHit: false, exactMatchedPrefix: "unestablished", avoidedCost: "unestablished", sourceCustody: "not_established_by_cache" } });
}

/** Comparable terminal reports only. The exact fraction avoids rounding a ratio
 * into apparent precision; zero input has no defined cache-read ratio. */
export function summarizeNativeCache(entries: readonly NativeWorkIndexEntry[]) {
  const unique = uniqueNativeWorkEntries(entries);
  const groups: Record<string, { protocol: ModelInteractionProtocolRef; profileKey: string; inputTokens: string; readTokens: string;
    includedWorkIds: string[]; ratio: { numerator: string; denominator: string } | null }> = {};
  const excluded: { workId: string; reason: string }[] = unique.conflictingWorkIds.map(workId => ({ workId, reason: "index_revision_conflict" }));
  for (const entry of unique.entries) {
    if (entry.finality !== "terminal" || entry.usageState !== "observed" || entry.inputTokens === null || entry.cacheReadTokens === null || entry.profileKey === null) {
      excluded.push({ workId: entry.workId, reason: entry.cacheReadState === "not_applicable" ? "native_cache_reads_not_exposed" : "incomplete_or_conflicting_observation" }); continue;
    }
    const group = groups[key([entry.protocol, entry.profileKey])] ??= { protocol: entry.protocol, profileKey: entry.profileKey,
      inputTokens: "0", readTokens: "0", includedWorkIds: [], ratio: null };
    group.inputTokens = addDecimal(group.inputTokens, String(entry.inputTokens));
    group.readTokens = addDecimal(group.readTokens, String(entry.cacheReadTokens)); group.includedWorkIds.push(entry.workId);
  }
  for (const group of Object.values(groups)) {
    group.includedWorkIds.sort();
    group.ratio = group.inputTokens === "0" ? null : { numerator: group.readTokens, denominator: group.inputTokens };
  }
  const value = { ruleRevision: "native-cache-read-ratio/1", groups, excluded: excluded.sort((a, b) => a.workId.localeCompare(b.workId)),
    coverage: excluded.length ? "partial" : "complete", writeShare: "separate_from_read_ratio", counterfactualSavings: "unestablished" };
  return snapshot({ ...value, revision: key(value) });
}
