import { snapshotModelInteractionProtocol, snapshotProtocolRevisionRef, sameProtocolRef,
  type ModelInteractionProtocolRef, type ProtocolRevisionRef } from "@agent-anything/model-interaction/protocol";
import { key, requireText, requireTime, snapshot } from "./AccountingValue.js";
import { addDecimal, compareDecimal, divideDecimal, multiplyDecimal, nonnegativeDecimal } from "./ExactDecimal.js";
import type { NativeWork } from "./NativeAccounting.js";

export type NativePriceSelector = { readonly match: "exact"; readonly value: string } | { readonly match: "any" };
export interface NativePriceContext {
  readonly protocol: ModelInteractionProtocolRef;
  readonly endpoint: string;
  readonly account: string;
  readonly operation: string;
  readonly occurredAt: string;
  readonly model: string | null;
  readonly reportedTier: string | null;
  readonly region: string | null;
  readonly modality: string | null;
  /** Evidence for reported conditions, separate from the originally requested tier. */
  readonly basis: ProtocolRevisionRef;
}
export interface NativeRateBasis {
  readonly ref: ProtocolRevisionRef;
  readonly source: string;
  readonly kind: "public_rate" | "account_rate" | "synthetic";
  readonly protocol: ModelInteractionProtocolRef;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly endpoint: NativePriceSelector;
  readonly account: NativePriceSelector;
  readonly model: NativePriceSelector;
  readonly reportedTier: NativePriceSelector;
  readonly region: NativePriceSelector;
  readonly modality: NativePriceSelector;
  readonly operation: string;
  /** Full native input count; never subtract cache reads when selecting a band. */
  readonly inputBand: { readonly minimum: string; readonly maximumExclusive: string | null } | null;
  readonly currency: string;
  readonly rates: readonly { readonly component: string; readonly unit: string; readonly amount: string; readonly perUnits: string }[];
}
export type NativeAdditionalCharge =
  | { readonly id: string; readonly state: "not_applicable" | "unknown" | "unpriced"; readonly basis: ProtocolRevisionRef }
  | { readonly id: string; readonly state: "measured"; readonly unit: string; readonly quantity: string; readonly basis: ProtocolRevisionRef };
export interface NativeCostComponent {
  readonly id: string;
  readonly unit: string;
  readonly quantity: string | null;
  readonly state: "priced" | "not_applicable" | "unknown" | "unpriced" | "conflicting";
  readonly amount: string | null;
  readonly currency: string | null;
  readonly rate: ProtocolRevisionRef | null;
  readonly candidates: readonly ProtocolRevisionRef[];
  readonly formula: string | null;
}
export interface NativeCostCalculation {
  readonly revision: string;
  readonly workId: string;
  readonly usageRevision: string;
  readonly calculation: ProtocolRevisionRef;
  readonly decisionAt: string;
  readonly context: NativePriceContext;
  readonly requestedTier: string | null;
  readonly rateBases: readonly NativeRateBasis[];
  readonly components: readonly NativeCostComponent[];
  readonly subtotals: Readonly<Record<string, string>>;
  readonly coverage: "complete" | "partial" | "conflicting";
  readonly exclusions: readonly string[];
  readonly chargeCoverage: { readonly state: "complete" | "unknown"; readonly basis: ProtocolRevisionRef };
  readonly additional: readonly NativeAdditionalCharge[];
}
function validateRate(rate: NativeRateBasis): void {
  snapshotProtocolRevisionRef(rate.ref); snapshotModelInteractionProtocol(rate.protocol); requireText(rate.source);
  requireTime(rate.effectiveFrom); if (rate.effectiveUntil !== null) {
    requireTime(rate.effectiveUntil);
    if (Date.parse(rate.effectiveUntil) <= Date.parse(rate.effectiveFrom)) throw new TypeError("accounting_rate_interval_invalid");
  }
  if (!["public_rate", "account_rate", "synthetic"].includes(rate.kind) || !/^[A-Z]{3}$/.test(rate.currency)) throw new TypeError("accounting_rate_invalid");
  requireText(rate.operation);
  for (const selector of [rate.endpoint, rate.account, rate.model, rate.reportedTier, rate.region, rate.modality]) {
    if (selector.match === "exact") requireText(selector.value);
    else if (selector.match !== "any") throw new TypeError("accounting_rate_selector_invalid");
  }
  if (rate.inputBand) {
    nonnegativeDecimal(rate.inputBand.minimum);
    if (rate.inputBand.maximumExclusive !== null && compareDecimal(rate.inputBand.minimum, nonnegativeDecimal(rate.inputBand.maximumExclusive)) >= 0)
      throw new TypeError("accounting_rate_band_invalid");
  }
  if (new Set(rate.rates.map(entry => entry.component)).size !== rate.rates.length) throw new TypeError("accounting_rate_component_duplicate");
  for (const entry of rate.rates) {
    requireText(entry.component); requireText(entry.unit); nonnegativeDecimal(entry.amount);
    if (compareDecimal(nonnegativeDecimal(entry.perUnits), "0") <= 0) throw new TypeError("accounting_price_unit_invalid");
  }
}
function matches(rate: NativeRateBasis, context: NativePriceContext, work: NativeWork): boolean {
  if (!sameProtocolRef(rate.protocol, context.protocol) || rate.operation !== context.operation ||
      Date.parse(context.occurredAt) < Date.parse(rate.effectiveFrom) ||
      (rate.effectiveUntil !== null && Date.parse(context.occurredAt) >= Date.parse(rate.effectiveUntil))) return false;
  for (const field of ["endpoint", "account", "model", "reportedTier", "region", "modality"] as const) {
    const selector = rate[field];
    if (selector.match === "exact" && context[field] !== selector.value) return false;
  }
  if (rate.inputBand) {
    const quantity = work.contribution.inputField ? work.contribution.fields[work.contribution.inputField] : null;
    if (quantity?.state !== "known" || compareDecimal(String(quantity.value), rate.inputBand.minimum) < 0 ||
        (rate.inputBand.maximumExclusive !== null && compareDecimal(String(quantity.value), rate.inputBand.maximumExclusive) >= 0)) return false;
  }
  return true;
}

export function calculateNativeCost(input: {
  readonly work: NativeWork;
  readonly calculation: ProtocolRevisionRef;
  readonly decisionAt: string;
  readonly context: NativePriceContext;
  readonly rates: readonly NativeRateBasis[];
  readonly additional: readonly NativeAdditionalCharge[];
  /** Explicit owner-reviewed inventory of all enabled charge families. */
  readonly chargeCoverage: { readonly state: "complete" | "unknown"; readonly basis: ProtocolRevisionRef };
}): NativeCostCalculation {
  const work = input.work, context = snapshot(input.context), rates = snapshot(input.rates);
  snapshotProtocolRevisionRef(input.calculation); snapshotProtocolRevisionRef(input.chargeCoverage.basis);
  snapshotProtocolRevisionRef(context.basis); snapshotModelInteractionProtocol(context.protocol);
  requireTime(input.decisionAt); requireTime(context.occurredAt);
  if (!["complete", "unknown"].includes(input.chargeCoverage.state)) throw new TypeError("accounting_charge_coverage_invalid");
  if (!sameProtocolRef(work.origin.protocol, context.protocol) || context.endpoint !== work.origin.endpoint ||
      context.account !== work.origin.account || context.operation !== work.origin.operation || context.occurredAt !== work.origin.submittedAt)
    throw new TypeError("accounting_price_context_mismatch");
  for (const value of [context.model, context.reportedTier, context.region, context.modality]) if (value !== null) requireText(value);
  for (const rate of rates) validateRate(rate);
  if (new Set(rates.map(rate => key(rate.ref))).size !== rates.length) throw new TypeError("accounting_rate_revision_conflict");
  const applicable = rates.filter(rate => matches(rate, context, work));
  const components: NativeCostComponent[] = [];
  const unpriced = (id: string, unit: string, state: NativeCostComponent["state"], quantity: string | null = null): NativeCostComponent =>
    ({ id, unit, state, quantity, amount: null, currency: null, rate: null, candidates: [], formula: null });
  function price(id: string, unit: string, quantity: string): NativeCostComponent {
    const choices = applicable.flatMap(basis => basis.rates.filter(rate => rate.component === id && rate.unit === unit).map(rate => ({ basis, rate })));
    if (!choices.length) return unpriced(id, unit, "unpriced", quantity);
    if (choices.length > 1) return { ...unpriced(id, unit, "conflicting", quantity), candidates: choices.map(choice => choice.basis.ref) };
    const choice = choices[0]!;
    return { id, unit, quantity, state: "priced", amount: divideDecimal(multiplyDecimal(quantity, choice.rate.amount), choice.rate.perUnits),
      currency: choice.basis.currency, rate: choice.basis.ref, candidates: [choice.basis.ref], formula: `(${quantity} * ${choice.rate.amount}) / ${choice.rate.perUnits}` };
  }
  for (const component of work.contribution.components) {
    const quantity = component.quantity;
    if (work.contribution.issues.includes("interpretation_profile_conflict")) components.push(unpriced(component.id, component.unit, "conflicting"));
    else if (quantity.state === "known") components.push(price(component.id, component.unit, String(quantity.value)));
    else components.push(unpriced(component.id, component.unit, quantity.state === "not_applicable" ? "not_applicable" :
      quantity.state === "conflicting" || quantity.state === "invalid" ? "conflicting" : "unknown"));
  }
  if (!work.contribution.components.length) components.push(unpriced("native_usage", "unknown", "unknown"));
  for (const extra of input.additional) {
    requireText(extra.id); snapshotProtocolRevisionRef(extra.basis);
    if (components.some(component => component.id === extra.id)) throw new TypeError("accounting_charge_component_duplicate");
    if (extra.state === "measured") { requireText(extra.unit); components.push(price(extra.id, extra.unit, nonnegativeDecimal(extra.quantity))); }
    else if (["not_applicable", "unknown", "unpriced"].includes(extra.state)) components.push(unpriced(extra.id, "unknown", extra.state));
    else throw new TypeError("accounting_additional_charge_invalid");
  }
  if (input.chargeCoverage.state === "unknown") components.push(unpriced("unestablished_charge_coverage", "unknown", "unknown"));
  const subtotals: Record<string, string> = {};
  for (const component of components) if (component.state === "priced")
    subtotals[component.currency!] = addDecimal(subtotals[component.currency!] ?? "0", component.amount!);
  const coverage = work.contribution.state === "conflicting" || components.some(component => component.state === "conflicting") ? "conflicting" as const :
    components.every(component => component.state === "priced" || component.state === "not_applicable") && work.contribution.finality === "terminal" ? "complete" as const : "partial" as const;
  const value = { workId: work.id, usageRevision: work.contribution.revision, calculation: input.calculation, decisionAt: input.decisionAt,
    context, requestedTier: work.origin.requestedTier, rateBases: rates, components, subtotals, coverage,
    exclusions: ["not_an_invoice", "no_inferred_discounts_credits_taxes", "no_currency_conversion"],
    chargeCoverage: input.chargeCoverage, additional: input.additional };
  return snapshot({ ...value, revision: key(value) });
}
