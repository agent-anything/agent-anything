import type { ModelInteractionProtocolRef } from "@agent-anything/model-interaction/protocol";
import { equal, key, requireText, snapshot } from "./AccountingValue.js";
import { addDecimal } from "./ExactDecimal.js";
import { applyNativeAccountingCommand, createNativeAccountingState, nativeWorkForSubmission,
  type NativeAccountingState, type NativeUsageContribution, type NativeWork, type NativeAccountingCommand } from "./NativeAccounting.js";
import type { NativeCostCalculation } from "./NativeCost.js";
import type { NativeQuantity } from "./NativeUsage.js";

/** Small read-model metadata suitable for an indexed projection slot. No bodies or
 * usage observations are required to aggregate it. Null is never an inferred zero. */
export interface NativeWorkIndexEntry {
  readonly workId: string;
  readonly revision: string;
  readonly usageRevision: string;
  readonly protocol: ModelInteractionProtocolRef;
  readonly runId: string;
  readonly purpose: string;
  readonly operation: string;
  readonly beneficiaries: readonly string[];
  readonly usageState: NativeUsageContribution["state"];
  readonly finality: NativeUsageContribution["finality"];
  readonly profileKey: string | null;
  readonly inputTokens: number | null;
  readonly inputState: NativeQuantity["state"];
  readonly outputTokens: number | null;
  readonly outputState: NativeQuantity["state"];
  readonly cacheReadTokens: number | null;
  readonly cacheReadState: NativeQuantity["state"];
  readonly cacheWriteTokens: number | null;
  readonly cacheWriteState: NativeQuantity["state"];
  readonly exposure: NativeWork["exposure"];
  readonly localReleased: boolean;
  readonly reconciliationOwner: string;
  readonly heldReservations: number;
  readonly costRevision: string | null;
  readonly costCoverage: NativeCostCalculation["coverage"] | "unknown";
  readonly pricedSubtotals: Readonly<Record<string, string>>;
}
export function nativeWorkIndexEntry(state: NativeAccountingState, submissionId: string, cost?: NativeCostCalculation | null): NativeWorkIndexEntry {
  const work = nativeWorkForSubmission(state, submissionId), usage = work.contribution;
  if (cost === undefined) cost = [...work.costCalculations].reverse().find(value => value.workId === work.id && value.usageRevision === usage.revision) ?? null;
  if (cost && (cost.workId !== work.id || cost.usageRevision !== usage.revision)) throw new TypeError("accounting_cost_revision_mismatch");
  const field = (path: string | null): NativeQuantity => path ? usage.fields[path] ?? { state: "missing", reason: "no_observation" } :
    { state: usage.state === "pending" ? "missing" : "not_applicable", reason: "native_field_not_exposed" };
  const input = field(usage.inputField), output = field(usage.outputField), read = field(usage.cacheReadField), write = field(usage.cacheWriteField);
  const n = (quantity: NativeQuantity): number | null => quantity.state === "known" ? quantity.value : null;
  const beneficiaries = [...new Set(work.submissionIds.flatMap(id => {
    const registration = state.commands[state.registrations[key(id)]!]!.command;
    return registration.kind === "register" ? registration.submission.beneficiaries : [];
  }))].sort();
  const value = { workId: work.id, usageRevision: usage.revision, protocol: work.origin.protocol, runId: work.origin.scope.runId,
    purpose: work.origin.scope.purpose.id, operation: work.origin.operation, beneficiaries,
    usageState: usage.state, finality: usage.finality, profileKey: usage.profileKey,
    inputTokens: n(input), inputState: input.state, outputTokens: n(output), outputState: output.state,
    cacheReadTokens: n(read), cacheReadState: read.state, cacheWriteTokens: n(write), cacheWriteState: write.state,
    exposure: work.exposure, localReleased: work.localReleased, reconciliationOwner: work.reconciliationOwner,
    heldReservations: Object.values(state.reservations).filter(reservation => reservation.status === "held" && work.submissionIds.includes(reservation.submissionId)).length,
    costRevision: cost?.revision ?? null, costCoverage: cost?.coverage ?? "unknown" as const, pricedSubtotals: cost?.subtotals ?? {} };
  return snapshot({ ...value, revision: key(value) });
}

/** Extract one physical work, including merged submission aliases and obligations.
 * The returned ordinary AccountingState is independently restorable and reducible. */
export function nativeAccountingWorkSnapshot(state: NativeAccountingState, submissionId: string): NativeAccountingState {
  const work = nativeWorkForSubmission(state, submissionId), ids = new Set(work.submissionIds);
  function belongs(command: NativeAccountingCommand): boolean {
    if (command.kind === "register") return ids.has(command.submission.id);
    if (command.kind === "observe") return ids.has(command.observation.submissionId);
    if (command.kind === "reserve") return ids.has(command.reservation.submissionId);
    return ids.has(command.submissionId);
  }
  let result = createNativeAccountingState();
  for (const receipt of Object.values(state.commands).filter(receipt => belongs(receipt.command)).sort((a, b) => a.sequence - b.sequence))
    result = applyNativeAccountingCommand(result, receipt.command);
  return result;
}

export interface NativeWorkAggregateScope {
  readonly id: string;
  readonly kind: "run_only" | "selected_descendants" | "selected_work";
  readonly runIds: readonly string[];
  readonly expectedWorkIds: readonly string[];
  readonly evidenceBoundary: string;
  readonly scanComplete: boolean;
}
export function uniqueNativeWorkEntries(entries: readonly NativeWorkIndexEntry[]): {
  readonly entries: readonly NativeWorkIndexEntry[]; readonly conflictingWorkIds: readonly string[];
} {
  const byId = new Map<string, NativeWorkIndexEntry>(), conflict = new Set<string>();
  for (const entry of entries) {
    const prior = byId.get(entry.workId);
    if (prior && !equal(prior, entry)) conflict.add(entry.workId);
    else byId.set(entry.workId, entry);
  }
  return { entries: [...byId.values()].filter(entry => !conflict.has(entry.workId)), conflictingWorkIds: [...conflict].sort() };
}
export function aggregateNativeWork(entries: readonly NativeWorkIndexEntry[], scope: NativeWorkAggregateScope) {
  requireText(scope.id); requireText(scope.evidenceBoundary);
  if (new Set(scope.expectedWorkIds).size !== scope.expectedWorkIds.length || new Set(scope.runIds).size !== scope.runIds.length ||
      !["run_only", "selected_descendants", "selected_work"].includes(scope.kind) || (scope.kind === "run_only" && scope.runIds.length !== 1))
    throw new TypeError("accounting_aggregate_scope_invalid");
  const expected = new Set(scope.expectedWorkIds), unique = uniqueNativeWorkEntries(entries.filter(entry => expected.has(entry.workId)));
  if (scope.kind !== "selected_work" && unique.entries.some(entry => !scope.runIds.includes(entry.runId)))
    throw new TypeError("accounting_aggregate_membership_mismatch");
  const seen = new Set([...unique.entries.map(entry => entry.workId), ...unique.conflictingWorkIds]);
  const missingWorkIds = scope.expectedWorkIds.filter(id => !seen.has(id));
  const counts = { observed: 0, pending: 0, missing: missingWorkIds.length, conflicting: unique.conflictingWorkIds.length, unresolved: 0 };
  const protocolTotals: Record<string, { inputTokens: string; outputTokens: string; knownInput: number; knownOutput: number }> = {};
  const pricedSubtotals: Record<string, string> = {};
  for (const entry of unique.entries) {
    counts[entry.usageState]++; if (entry.exposure === "unresolved") counts.unresolved++;
    const group = key([entry.protocol, entry.profileKey]);
    const totals = protocolTotals[group] ??= { inputTokens: "0", outputTokens: "0", knownInput: 0, knownOutput: 0 };
    if (entry.inputTokens !== null) { totals.inputTokens = addDecimal(totals.inputTokens, String(entry.inputTokens)); totals.knownInput++; }
    if (entry.outputTokens !== null) { totals.outputTokens = addDecimal(totals.outputTokens, String(entry.outputTokens)); totals.knownOutput++; }
    for (const [currency, subtotal] of Object.entries(entry.pricedSubtotals)) pricedSubtotals[currency] = addDecimal(pricedSubtotals[currency] ?? "0", subtotal);
  }
  const value = { ruleRevision: "native-work-aggregate/1", scope, workIds: unique.entries.map(entry => entry.workId).sort(),
    contributionRevisions: unique.entries.map(entry => ({ workId: entry.workId, revision: entry.revision })).sort((a, b) => a.workId.localeCompare(b.workId)),
    missingWorkIds, conflictingWorkIds: unique.conflictingWorkIds, counts, protocolTotals, pricedSubtotals,
    monetaryCoverage: scope.scanComplete && !missingWorkIds.length && !unique.conflictingWorkIds.length && unique.entries.every(entry => entry.costCoverage === "complete") ? "complete" : "partial" };
  return snapshot({ ...value, revision: key(value) });
}
