import { snapshotModelInteractionProtocol } from "@agent-anything/model-interaction/protocol";
import { key, record, requireSequence, requireText, snapshot } from "./AccountingValue.js";
import { nonnegativeDecimal } from "./ExactDecimal.js";
import type { NativeWorkIndexEntry } from "./NativeWorkIndex.js";

export type NativeWorkIndexMetadata = Readonly<Record<string, string | number | boolean | null>>;
const fields = ["workId", "revision", "usageRevision", "protocolProviderId", "protocolId", "protocolRevision", "runId", "purpose", "operation",
  "usageState", "finality", "profileKey", "inputTokens", "inputState", "outputTokens", "outputState", "cacheReadTokens", "cacheReadState",
  "cacheWriteTokens", "cacheWriteState", "exposure", "localReleased", "reconciliationOwner", "heldReservations", "costRevision", "costCoverage", "pricedSubtotalsJson"] as const;
const quantityStates = ["known", "missing", "unavailable", "not_applicable", "invalid", "conflicting"];
function validateMetadata(metadata: NativeWorkIndexMetadata): void {
  if (!record(metadata) || Object.keys(metadata).length !== fields.length || Object.keys(metadata).some(field => !fields.includes(field as typeof fields[number])) ||
      Object.values(metadata).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value)) ||
      Object.values(metadata).some(value => typeof value === "string" && Buffer.byteLength(value, "utf8") > 1024) ||
      Buffer.byteLength(JSON.stringify(metadata), "utf8") > 4096) throw new TypeError("accounting_index_metadata_invalid");
}

/** 27 scalar fields; beneficiaries are stored in the caller's membership index. */
export function encodeNativeWorkIndexEntryMetadata(entry: NativeWorkIndexEntry): NativeWorkIndexMetadata {
  const { protocol, beneficiaries: _beneficiaries, pricedSubtotals, ...scalars } = entry;
  const metadata = snapshot({ ...scalars, protocolProviderId: protocol.providerId, protocolId: protocol.id, protocolRevision: protocol.revision,
    pricedSubtotalsJson: JSON.stringify(pricedSubtotals) });
  decodeNativeWorkIndexEntryMetadata(metadata, entry.beneficiaries);
  return metadata;
}

export function decodeNativeWorkIndexEntryMetadata(metadata: NativeWorkIndexMetadata, beneficiaries: readonly string[]): NativeWorkIndexEntry {
  validateMetadata(metadata);
  for (const field of ["workId", "revision", "usageRevision", "runId", "purpose", "operation", "reconciliationOwner"] as const) requireText(metadata[field]);
  for (const id of beneficiaries) requireText(id);
  if (new Set(beneficiaries).size !== beneficiaries.length) throw new TypeError("accounting_index_membership_duplicate");
  const protocol = snapshotModelInteractionProtocol({ providerId: metadata.protocolProviderId, id: metadata.protocolId, revision: metadata.protocolRevision });
  for (const [valueField, stateField] of [["inputTokens", "inputState"], ["outputTokens", "outputState"], ["cacheReadTokens", "cacheReadState"], ["cacheWriteTokens", "cacheWriteState"]] as const) {
    if (!quantityStates.includes(metadata[stateField] as string)) throw new TypeError("accounting_index_quantity_state_invalid");
    if (metadata[stateField] === "known") requireSequence(metadata[valueField]);
    else if (metadata[valueField] !== null) throw new TypeError("accounting_index_quantity_invalid");
  }
  if (!["generation", "compact", "count", "read", "cancel", "file", "storage"].includes(metadata.operation as string) ||
      !["pending", "observed", "missing", "conflicting"].includes(metadata.usageState as string) ||
      !["unresolved", "reconciled", "owner_disposed"].includes(metadata.exposure as string) || typeof metadata.localReleased !== "boolean" ||
      !["complete", "partial", "conflicting", "unknown"].includes(metadata.costCoverage as string)) throw new TypeError("accounting_index_state_invalid");
  requireSequence(metadata.heldReservations);
  if (metadata.usageState === "pending") {
    if (metadata.finality !== null || metadata.profileKey !== null || metadata.inputTokens !== null || metadata.outputTokens !== null)
      throw new TypeError("accounting_index_pending_invalid");
  } else {
    if (!["partial", "terminal"].includes(metadata.finality as string)) throw new TypeError("accounting_index_finality_invalid");
    requireText(metadata.profileKey);
  }
  if (metadata.usageState === "observed" && (metadata.inputState !== "known" || metadata.outputState !== "known"))
    throw new TypeError("accounting_index_observed_invalid");
  if (metadata.inputState === "known" && metadata.cacheReadState === "known" && (metadata.cacheReadTokens as number) > (metadata.inputTokens as number))
    throw new TypeError("accounting_index_cache_subset_invalid");
  if (typeof metadata.pricedSubtotalsJson !== "string" || Buffer.byteLength(metadata.pricedSubtotalsJson, "utf8") > 1024)
    throw new TypeError("accounting_index_subtotals_invalid");
  let subtotals: unknown;
  try { subtotals = JSON.parse(metadata.pricedSubtotalsJson); } catch { throw new TypeError("accounting_index_subtotals_invalid"); }
  const totals = record(subtotals);
  if (!totals || Object.keys(totals).length > 8) throw new TypeError("accounting_index_subtotals_invalid");
  for (const [currency, amount] of Object.entries(totals)) {
    if (!/^[A-Z]{3}$/.test(currency) || typeof amount !== "string") throw new TypeError("accounting_index_subtotals_invalid");
    nonnegativeDecimal(amount);
  }
  if (metadata.costRevision === null) {
    if (metadata.costCoverage !== "unknown" || Object.keys(totals).length) throw new TypeError("accounting_index_cost_invalid");
  } else {
    requireText(metadata.costRevision);
    if (metadata.costCoverage === "unknown") throw new TypeError("accounting_index_cost_invalid");
  }
  const { protocolProviderId: _provider, protocolId: _protocol, protocolRevision: _revision, pricedSubtotalsJson: _totals, ...scalars } = metadata;
  const value = { ...scalars, protocol, beneficiaries: [...beneficiaries].sort(), pricedSubtotals: totals } as unknown as NativeWorkIndexEntry;
  const { revision, ...basis } = value;
  if (revision !== key(basis)) throw new TypeError("accounting_index_revision_mismatch");
  return snapshot(value);
}
